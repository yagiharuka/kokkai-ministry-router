// Offline regression: the production reviewer and public route run against
// synthetic sources/decisions, a virtual clock, and in-memory caches only.
// The schedule follows a user-reported diagnostic, not a live reproduction.
// No real 45-second sleep, network request, credentials, or inference is used.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as routing from '../worker/routing-core.mjs';
import { runCacheWrite } from '../worker/background-cache.mjs';

const fixture = JSON.parse(await readFile(new URL('../evaluation/timeout-diagnostic-20261019.json', import.meta.url), 'utf8'));
const reviewerSource = await readFile(new URL('../worker/semantic-review.mjs', import.meta.url), 'utf8');
const routeSource = await readFile(new URL('../worker/model-api.js', import.meta.url), 'utf8');
const observed = fixture.observed, [b1, b2, b3, scope] = observed.review_diagnostics;
const question = fixture.offline_regression.question;
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
// All injected dependencies use promises/microtasks, including SHA-256 and
// cache reads. Drain them before moving time, so timing never depends on CPU.
const drain = async () => { for (let index = 0; index < 120; index++) await Promise.resolve(); };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }

class VirtualClock {
  now = Date.parse('2026-10-19T00:00:00.000Z');
  nextId = 0;
  timers = new Map();
  fired = [];
  setTimeout = (callback, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback, delay });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };
  delay(ms) { return new Promise(resolve => this.setTimeout(resolve, ms)); }
  async advance(to) {
    assert.ok(to >= this.now, 'Virtual time must not run backward');
    await drain();
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= to)
        .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      this.timers.delete(id);
      this.fired.push({ at: this.now, delay: timer.delay });
      timer.callback();
      await drain();
    }
    this.now = to;
    await drain();
  }
}

// These records are intentionally invented. NDL-shaped URLs satisfy the real
// source validator, but are never fetched and are not evidence of real records.
const sources = Array.from({ length: 17 }, (_, index) => ({
  case_id: `synthetic-underfilled:q${String(index).padStart(2, '0')}`,
  ministry: '文部科学省', position: '文部科学大臣', meeting: '合成テスト委員会', date: '2026-05-01',
  question: '教員の勤務時間をどう減らしますか。',
  answer: `教員の勤務時間を減らすため支援員を配置します。合成案件${index}です。`,
  url: `https://kokkai.ndl.go.jp/txt/synthetic-underfilled/${index}`, retrieval_score: 1,
}));

async function scenario({ timeout }) {
  const clock = new VirtualClock(), origin = clock.now;
  const store = new Map(), calls = [], events = [], held = [];
  let cacheReads = 0, retrievals = 0, active = 0, peak = 0, externalRequests = 0;
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const networkForbidden = () => { externalRequests++; throw Error('External requests forbidden in offline timeout regression'); };
  const context = vm.createContext({ ...routing, runCacheWrite, Date: TestDate,
    console, Response, Request, Headers, URL, TextEncoder,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    fetch: networkForbidden,
    // Real hashing with immediate deterministic completion; no native crypto
    // thread pool may change the order in which virtual-time batches start.
    crypto: { subtle: { async digest(algorithm, input) {
      assert.equal(algorithm, 'SHA-256');
      return Uint8Array.from(createHash('sha256').update(input).digest()).buffer;
    } } },
    caches: { default: {
      async match(key) {
        if (key.includes('/__review_cache/')) {
          const delay = [b1.cache_read_ms, b2.cache_read_ms, b3.cache_read_ms, scope.cache_read_ms][cacheReads++] || 0;
          if (delay) await clock.delay(delay);
        }
        const saved = store.get(key);
        return saved ? { json: async () => plain(saved.body) } : undefined;
      },
      async put(key, response) { store.set(key, { body: await response.json(), cacheControl: response.headers.get('cache-control') }); },
    } },
    async retrieveFastAssignments() {
      retrievals++;
      if (retrievals === 1) await clock.delay(observed.timing.retrieval_ms);
      return { review_candidates: sources, candidates: [], recent_since: '2024-01-01', searched: ['synthetic-only'],
        searched_queries: [], errors: [], requests_used: 0 };
    },
  });
  const strip = text => text.replace(/^import [^\n]+;\n/gm, '').replace(/^export /gm, '');
  new vm.Script(strip(reviewerSource), { filename: 'semantic-review.mjs' }).runInContext(context);
  new vm.Script(routeSource.replace(/^import [^\n]+;\n/gm, '').replace('export default {', 'globalThis.worker = {'),
    { filename: 'model-api.js' }).runInContext(context);
  const env = { CLOUDFLARE_WORKERS_PLAN: 'free', AI: { async run(model, payload) {
    const input = JSON.parse(payload.messages[1].content);
    const isScope = payload.messages[0].content.includes('この判定は、');
    const ordinals = input.candidates.map(candidate => Number(Object.values(candidate.source_answer).join('').match(/合成案件(\d+)/)[1]));
    const batch = isScope ? 3 : Math.floor(ordinals[0] / 8);
    const label = isScope ? 'scope3' : `initial${batch + 1}`;
    calls.push({ batch, ordinals, at: clock.now - origin, payload: plain(payload), model });
    events.push({ event: label + ':start', at: clock.now - origin });
    active++; peak = Math.max(peak, active);
    try {
      if (batch === 2 && timeout) {
        // A deliberately pending provider binding lets the production
        // Promise.race timeout fire. Do not throw a premanufactured timeout.
        const gate = deferred(); held.push(gate); await gate.promise;
      } else {
        await clock.delay(batch === 2 ? b3.model_ms - 1 : [b1.model_ms, b2.model_ms, 0, scope.model_ms][batch]);
      }
      events.push({ event: label + ':response', at: clock.now - origin });
      const reviews = input.candidates.map((candidate, index) => {
        const ordinal = ordinals[index];
        // Three synthetic B1 acceptances need scope checking. B2 has two
        // explicit rejections; scope changes one of its three rows to reject.
        const reject = ordinal === 14 || ordinal === 15 || (isScope && ordinal === 2);
        const q = candidate.source_question || input.candidates.find(row => row.id === candidate.source_question_ref).source_question;
        return { id: candidate.id, beneficiary: !isScope && ordinal < 3 ? '学校の先生' : '教員',
          activity: '学校業務', relation: reject ? 'different' : 'same',
          comparison: reject ? '合成テストで対象の異なる事例として不採用にする答弁' : '教員の勤務時間を支援員の配置で減らす合成テストの答弁',
          decision: reject ? 'reject' : 'accept', q: reject ? '' : Object.keys(q)[0],
          a: reject ? '' : Object.keys(candidate.source_answer)[0] };
      });
      return { response: { reviews }, usage: { input_tokens: 100 + reviews.length, output_tokens: 50 + reviews.length } };
    } finally { active--; }
  } } };
  const request = () => new Request('https://example.invalid/api/cases?' + new URLSearchParams({ question }));
  let settled = false;
  const pending = context.worker.fetch(request(), env).then(async response => {
    const result = await response.json(); settled = true;
    return { result, cacheControl: response.headers.get('cache-control'), status: response.status };
  });
  const reviewAt = origin + observed.timing.retrieval_ms;
  await clock.advance(reviewAt + b3.cache_read_ms);
  assert.equal(calls.length, 3, 'All three initial model calls start without a completed batch');
  assert.deepEqual(calls.map(call => call.ordinals.length), [8, 8, 1]);
  await clock.advance(reviewAt + b2.total_ms);
  assert.equal(calls.length, 3, 'B2 needs no scope call');
  await clock.advance(reviewAt + b1.total_ms + scope.cache_read_ms);
  assert.equal(calls.length, 4, 'The three-row scope call starts while B3 remains pending');
  assert.deepEqual(calls[3].ordinals, [0, 1, 2]);
  await clock.advance(reviewAt + scope.started_after_ms + scope.total_ms);
  assert.ok(events.some(event => event.event === 'scope3:response'));
  assert.ok(!events.some(event => event.event === 'initial3:response'));
  assert.equal(settled, false, 'Scope finishes before the underfilled batch, but the final response still waits');
  const end = reviewAt + b3.total_ms;
  await clock.advance(end - 1);
  assert.equal(settled, !timeout, 'A genuine timeout must not fire before the 45-second deadline');
  await clock.advance(end);
  assert.equal(settled, true, 'The production timeout releases the final response');
  const first = await pending;
  assert.equal(clock.timers.size, 0, 'Successful and timed-out model timers are cleared');
  const snapshot = JSON.stringify(first);
  let second;
  if (timeout) {
    // A late provider completion must not mutate returned results or populate
    // the failed model-batch / whole-analysis cache after the timeout.
    held.forEach(gate => gate.resolve());
    await drain();
    assert.equal(JSON.stringify(first), snapshot);
    assert.equal(calls.length, 4);
    assert.equal([...store.keys()].filter(key => key.includes('/__review_cache/')).length, 3);
    assert.equal([...store.keys()].filter(key => key.includes('/__analysis_cache/')).length, 0);
    // The existing 30-second in-memory pause is not a 24-hour complete-result
    // cache. After it expires, recheck only the failed batch, using valid cache.
    await clock.advance(clock.now + 31000);
    const next = context.worker.fetch(request(), env).then(async response => ({
      result: await response.json(), cacheControl: response.headers.get('cache-control'),
    }));
    await drain();
    assert.equal(calls.length, 5, 'Only a new user request repeats the failed batch; no automatic retry');
    await clock.advance(clock.now + b3.model_ms);
    second = await next;
    held.forEach(gate => gate.resolve());
    await drain();
    assert.equal(clock.timers.size, 0);
  }
  return { first, second, calls, events, store, peak, retrievals, externalRequests,
    timeoutCallbacks: clock.fired.filter(timer => timer.delay === b3.model_ms).length };
}

check('Reported diagnostic is separated from the synthetic input and unconfirmed query', () => {
  assert.equal(observed.question_status, 'unconfirmed'); assert.equal(observed.question, null);
  assert.deepEqual([b1, b2, b3].map(row => row.expected), [8, 8, 1]);
  assert.equal(b3.usage, null); assert.equal(b3.error, 'model_timeout');
  assert.equal(observed.timing.retrieval_ms + observed.timing.review_ms, observed.timing.total_ms);
  assert.equal(scope.started_after_ms + scope.total_ms, fixture.derived_from_reported_diagnostics.scope_finished_after_review_start_ms);
});

const failed = await scenario({ timeout: true });
const control = await scenario({ timeout: false });
const result = failed.first.result;
check('Actual timeout keeps 16 of 17 completed judgments and marks the response partial', () => {
  assert.equal(failed.first.status, 200); assert.equal(result.routing_version, routing.routingVersion);
  assert.equal(result.reviewed_candidates, 16); assert.equal(result.assessment_status, 'reviewed');
  assert.equal(result.assessment_partial, true); assert.equal(result.assessment_error, 'model_unavailable');
  assert.equal(result.accepted_candidates, 13); assert.equal(result.rejected_candidates, 3);
  assert.equal(result.uncertain_candidates, 1); assert.equal(result.pairs, 13);
  assert.equal(result.review_candidates[0].case_id, sources[16].case_id);
  assert.equal(result.review_candidates[0].question_evidence, '');
  assert.equal(result.review_candidates[0].answer_evidence, '');
});
check('Virtual timing follows the diagnostic and the scope call completes before the timeout', () => {
  assert.deepEqual(result.timing, observed.timing);
  assert.deepEqual(result.review_diagnostics.map(row => ({ expected: row.expected, completed: row.completed,
    output_token_limit: row.output_token_limit, started_after_ms: row.started_after_ms,
    model_ms: row.model_ms, cache_read_ms: row.cache_read_ms, total_ms: row.total_ms })),
  observed.review_diagnostics.map(row => ({ expected: row.expected, completed: row.completed,
    output_token_limit: row.output_token_limit, started_after_ms: row.started_after_ms,
    model_ms: row.model_ms, cache_read_ms: row.cache_read_ms, total_ms: row.total_ms })));
  const diagnostic = result.review_diagnostics[2];
  assert.equal(diagnostic.error, 'model_timeout'); assert.equal(diagnostic.provider_error_kind, 'timeout');
  assert.equal(diagnostic.usage, undefined); assert.equal(diagnostic.model_called, true);
  assert.equal(failed.timeoutCallbacks, 2, 'One real timeout callback per explicitly simulated request');
  assert.equal(control.timeoutCallbacks, 0);
  for (const row of result.review_diagnostics.filter(row => row.validation_failures)) {
    assert.ok(Object.values(row.validation_failures).every(count => count === 0));
  }
});
check('All other grounded evidence, rejections, source ownership and shares are preserved', () => {
  assert.equal(control.first.result.reviewed_candidates, 17);
  assert.equal(control.first.result.assessment_partial, undefined);
  const surviving = control.first.result.evidence.filter(row => row.case_id !== sources[16].case_id);
  assert.deepEqual(result.evidence, surviving);
  assert.deepEqual(result.rejected_evidence, control.first.result.rejected_evidence);
  assert.deepEqual(result.shares, routing.summarize(surviving).shares);
  for (const row of result.evidence) {
    const source = sources.find(candidate => candidate.case_id === row.case_id);
    assert.equal(row.url, source.url); assert.equal(row.ministry, source.ministry);
    assert.ok(source.question.includes(row.question_evidence));
    assert.ok(source.answer.includes(row.answer_evidence));
  }
  assert.deepEqual(failed.calls.slice(0, 4).map(call => call.payload), control.calls.map(call => call.payload),
    'Timeout and control use identical model payloads; this is not a batching experiment');
});
check('Partial results never enter public or 24-hour whole-analysis caches', () => {
  assert.equal(failed.first.cacheControl, 'no-store'); assert.equal(failed.second.cacheControl, 'no-store');
  assert.equal([...failed.store.keys()].filter(key => key.includes('/__analysis_cache/')).length, 0);
  assert.equal([...failed.store.keys()].filter(key => key.includes('/__review_cache/')).length, 3);
  assert.equal(failed.second.result.analysis_cache_hit, undefined);
  assert.equal(failed.second.result.review_cache_hits, 3);
  assert.equal(failed.second.result.review_model_calls, 1);
  assert.equal(failed.second.result.reviewed_candidates, 16);
  assert.deepEqual(failed.second.result.evidence, result.evidence);
  assert.equal(control.first.cacheControl, 'public, max-age=600');
  assert.equal([...control.store.keys()].filter(key => key.includes('/__analysis_cache/')).length, 1,
    'Positive control proves the cache instrumentation can detect a complete analysis write');
});
check('No added calls, automatic retries, concurrency, external requests or live latency claim', () => {
  assert.equal(result.review_model_calls, 4); assert.equal(result.review_cache_hits, 0);
  assert.equal(failed.calls.length, 5); assert.equal(control.calls.length, 4);
  assert.equal(failed.peak, 3); assert.equal(control.peak, 3);
  assert.equal(failed.retrievals, 2); assert.equal(control.retrievals, 1);
  assert.equal(failed.externalRequests + control.externalRequests, 0);
});
console.log('UNDERFILLED_TIMEOUT ' + JSON.stringify({ checks, external_requests: 0, live_latency_measured: false,
  synthetic_sources_and_decisions: true, schedule_inspired_by: observed.analyzed_at,
  completed_initial_candidates: '16/17', fresh_model_calls: 4, automatic_retries: 0,
  note: 'Offline behavior only; neither underfilled-batch causation nor a batching-change speedup is established.' }));
