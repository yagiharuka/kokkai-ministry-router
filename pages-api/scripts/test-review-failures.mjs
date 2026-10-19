// Offline regression tests: real reviewer/route code, mocked AI, retrieval and
// caches. No network, credentials, live latency, or semantic accuracy claims.
// Optional: --baseline /path/to/pre-fix-semantic-review.mjs for red/green proof.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as routing from '../worker/routing-core.mjs';
import { runCacheWrite } from '../worker/background-cache.mjs';

const source = await readFile(new URL('../worker/semantic-review.mjs', import.meta.url), 'utf8');
const routeSource = await readFile(new URL('../worker/model-api.js', import.meta.url), 'utf8');
const question = '教員の勤務時間を減らすための対策';
const rows = Array.from({ length: 24 }, (_, index) => ({
  case_id: `failure:${String(index).padStart(2, '0')}`, ministry: '文部科学省',
  position: '文部科学大臣', meeting: '委員会', date: '2025-05-01',
  question: '教員の勤務時間をどう減らしますか。',
  answer: `教員の勤務時間を減らすため支援員を配置します。案件${index}です。`,
  url: `https://kokkai.ndl.go.jp/txt/offline-failure/${index}`, retrieval_score: 1,
}));
const input = selected => ({ review_candidates: selected, candidates: [], errors: [], searched: ['offline'], searched_queries: [], requests_used: 0 });
const plain = value => JSON.parse(JSON.stringify(value));
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }

function load(text, { store = null, clock = null } = {}) {
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [TestDate.now()])); }
    static now() { return clock ? clock.value : Date.now(); }
  }
  const context = vm.createContext({ ...routing, runCacheWrite, console, setTimeout, clearTimeout,
    Response, Request, Headers, URL, AbortSignal, TextEncoder, crypto: webcrypto, Date: TestDate,
    fetch() { throw Error('External network forbidden in offline failure tests'); },
    ...(store ? { caches: { default: {
      async match(key) { return store.get(key)?.clone(); },
      async put(key, response) { store.set(key, response.clone()); },
    } } } : {}),
  });
  new vm.Script(text.replace(/^import [^\n]+;\n/gm, '').replace(/^export /gm, '') +
    '\n;globalThis.api={reviewCompactAssignments,semanticConfiguration,prepareSemanticPlan};').runInContext(context);
  return { context, api: context.api };
}

function binding(change = () => {}, { scope = false, mutateRows = () => {} } = {}) {
  const payloads = [];
  const env = { CLOUDFLARE_WORKERS_PLAN: 'free', AI: { async run(model, payload) {
    payloads.push(JSON.stringify([model, payload]));
    const value = JSON.parse(payload.messages[1].content);
    const isScope = payload.messages[0].content.includes('この判定は、');
    const reviews = value.candidates.map(candidate => {
      const index = Number(Object.values(candidate.source_answer).join('').match(/案件(\d+)/)[1]);
      const qParts = candidate.source_question || value.candidates.find(row => row.id === candidate.source_question_ref).source_question;
      const row = { id: candidate.id, beneficiary: scope ? '学校の先生' : '教員', activity: '学校業務', relation: 'same',
        comparison: '教員の勤務時間を減らすため支援員を配置する答弁', decision: 'accept',
        q: Object.keys(qParts)[0], a: Object.keys(candidate.source_answer)[0] };
      change(row, index, isScope); return row;
    });
    mutateRows(reviews);
    return { response: { reviews } };
  } } };
  return { env, payloads };
}

async function evaluate(text, change, options = {}) {
  const { api } = load(text);
  const mock = binding(change, options);
  const result = await api.reviewCompactAssignments(question, input(options.rows || rows), mock.env);
  return { result: plain(result), payloads: mock.payloads };
}

async function transport(text, name) {
  const { api } = load(text), payloads = [];
  const result = await api.reviewCompactAssignments(question, input(rows), {
    CLOUDFLARE_WORKERS_PLAN: 'free', CLOUDFLARE_API_TOKEN: 'offline-test-not-a-real-credential',
    CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
  }, async (_url, init) => {
    payloads.push(init.body);
    if (name === 'body-timeout') return { ok: true, status: 200, async json() {
      throw new DOMException('PRIVATE body detail', 'TimeoutError');
    } };
    if (name === 'invalid-body') return new Response('{invalid-json');
    if (name === 'invalid-model-json') return Response.json({ success: true, result: { response: '{invalid-json' } });
    if (name === 'timeout') throw new DOMException('PRIVATE transport detail', 'TimeoutError');
    throw new TypeError('fetch failed PRIVATE transport detail');
  });
  return { result: plain(result), payloads };
}

const timedOut = await transport(source, 'timeout'), disconnected = await transport(source, 'network');
const bodyTimeout = await transport(source, 'body-timeout');
for (const [name, value, error, kind] of [
  ['REST timeout', timedOut, 'model_timeout', 'timeout'],
  ['REST network failure', disconnected, 'model_request_failed', 'unclassified'],
  ['REST body timeout', bodyTimeout, 'model_timeout', 'timeout'],
]) check(name + ' is classified without leaking text or retrying', () => {
  assert.equal(value.payloads.length, 3);
  assert.equal(value.result.reviewed_candidates, 0);
  assert.equal(value.result.assessment_error, 'model_unavailable');
  assert.ok(value.result.review_diagnostics.every(d => d.error === error && d.provider_error_kind === kind && d.model_called));
  assert.ok(!JSON.stringify(value.result).includes('PRIVATE'));
});
for (const [name, error] of [['invalid-body', 'model_incomplete'], ['invalid-model-json', 'invalid_json']]) {
  const malformed = await transport(source, name);
  check(name + ' is not mistaken for a network failure', () => {
    assert.equal(malformed.payloads.length, 3);
    assert.ok(malformed.result.review_diagnostics.every(d => d.error === error));
  });
}

async function unreadableRateLimit(text, timeout) {
  const { api } = load(text); let calls = 0;
  const result = await api.prepareSemanticPlan(question, {
    CLOUDFLARE_WORKERS_PLAN: 'free', CLOUDFLARE_API_TOKEN: 'offline-test-not-a-real-credential',
    CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
  }, async () => {
    calls++;
    return { ok: false, status: 429, async json() {
      if (timeout) throw new DOMException('PRIVATE body detail', 'TimeoutError');
      throw new TypeError('PRIVATE body detail');
    } };
  });
  return { result: plain(result), calls };
}
for (const timeout of [false, true]) {
  const limited = await unreadableRateLimit(source, timeout);
  check('HTTP429 survives ' + (timeout ? 'timeout' : 'network failure') + ' while reading its body, without retry', () => {
    assert.equal(limited.calls, 1);
    assert.equal(limited.result.status, 'failed');
    assert.equal(limited.result.error_code, 'model_busy');
    assert.ok(!JSON.stringify(limited.result).includes('PRIVATE'));
  });
}

const invalidSix = (row, index) => { if (index >= 18) row.a = 'unknown-answer-reference'; };
const six = await evaluate(source, invalidSix);
check('Six invalid accepted refs stay uncertain and no longer count as completed', () => {
  assert.equal(six.payloads.length, 3); assert.equal(six.result.reviewed_candidates, 18);
  assert.equal(six.result.pairs, 18); assert.equal(six.result.uncertain_candidates, 6);
  assert.equal(six.result.assessment_partial, true);
  assert.equal(six.result.assessment_error, 'model_unavailable');
  assert.equal(six.result.review_diagnostics.reduce((sum, d) => sum + d.validation_failures.unknown_accepted_refs, 0), 6);
  assert.ok(!JSON.stringify(six.result.review_diagnostics).includes('unknown-answer-reference'));
  assert.ok(six.result.review_candidates.every(row => row.review_reason === '原文番号を確認できないため保留。'));
});
for (const field of ['q', 'a']) {
  const value = await evaluate(source, row => { row[field] = 'unknown-reference'; });
  check('Unknown accepted ' + field + ' cannot produce a completed result', () => {
    assert.equal(value.payloads.length, 3); assert.equal(value.result.reviewed_candidates, 0);
    assert.equal(value.result.assessment_status, 'failed'); assert.equal(value.result.assessment_partial, true);
    assert.equal(value.result.pairs, 0); assert.equal(value.result.uncertain_candidates, 24);
  });
}

const borrowedRows = rows.slice(0, 2).map((row, index) => ({ ...row,
  answer: index ? row.answer + '教員の業務をさらに減らします。' : row.answer,
}));
const borrowed = await evaluate(source, row => { row.a = 'v1a3'; }, { rows: borrowedRows });
check('Another candidate owning a reference never authorizes it for this candidate', () => {
  assert.equal(borrowed.result.reviewed_candidates, 1); assert.equal(borrowed.result.pairs, 1);
  assert.equal(borrowed.result.evidence[0].case_id, borrowedRows[1].case_id);
});

for (const firstInvalid of [true, false]) {
  const duplicate = await evaluate(source, (row, index) => { if (firstInvalid && index === 0) row.a = 'unknown-reference'; }, {
    rows: rows.slice(0, 2), mutateRows(reviews) { reviews.push({ ...reviews[0], a: firstInvalid ? 'v1a1' : 'unknown-reference' }); },
  });
  check('An invalid reference and duplicate stay held in either order: ' + firstInvalid, () => {
    assert.equal(duplicate.result.reviewed_candidates, 1); assert.equal(duplicate.result.pairs, 1);
    assert.equal(duplicate.result.uncertain_candidates, 1); assert.equal(duplicate.payloads.length, 1);
    assert.equal(duplicate.result.review_diagnostics[0].duplicate_id, 1);
  });
}

const validUncertain = row => Object.assign(row, { decision: 'uncertain', relation: 'unclear', q: '', a: '' });
const uncertain = await evaluate(source, validUncertain);
check('Valid semantic uncertainty still counts as a completed judgment', () => {
  assert.equal(uncertain.result.reviewed_candidates, 24); assert.equal(uncertain.result.uncertain_candidates, 24);
  assert.equal(uncertain.result.assessment_status, 'reviewed'); assert.equal(uncertain.result.assessment_partial, undefined);
  assert.equal(uncertain.result.assessment_error, undefined); assert.equal(uncertain.payloads.length, 3);
});

const scoped = await evaluate(source, (row, index, isScope) => { if (isScope && index === 0) row.a = 'unknown-reference'; }, { scope: true, rows: rows.slice(0, 4) });
check('A scope grounding failure subtracts only its incomplete candidate', () => {
  assert.equal(scoped.payloads.length, 2); assert.equal(scoped.result.reviewed_candidates, 3);
  assert.equal(scoped.result.pairs, 3); assert.equal(scoped.result.uncertain_candidates, 1);
  assert.equal(scoped.result.assessment_partial, true);
});

async function publicCache(text, { store = new Map(), clock = { value: Date.now() },
  version = routing.routingVersion, change = row => { row.a = 'unknown-reference'; } } = {}) {
  const loaded = load(text, { store, clock });
  // Evaluate the real route source with the real reviewer in the same context.
  // Retrieval is an already-selected fixture, never an NDL request.
  loaded.context.retrieveFastAssignments = async () => input(rows);
  loaded.context.routingVersion = version;
  new vm.Script(routeSource.replace(/^import [^\n]+;\n/gm, '').replace('export default {', 'globalThis.worker = {')).runInContext(loaded.context);
  const mock = binding(change);
  const request = () => new Request('https://example.invalid/api/cases?' + new URLSearchParams({ question }));
  const response = await loaded.context.worker.fetch(request(), mock.env), first = await response.json();
  const analysisEntries = [...store.entries()].filter(([key]) => key.includes('/__analysis_cache/'));
  clock.value += 31000;
  const second = await (await loaded.context.worker.fetch(request(), mock.env)).json();
  return { first, second, calls: mock.payloads.length, payloads: mock.payloads, analysisEntries, store, clock,
    responseCacheControl: response.headers.get('cache-control') };
}
const cache = await publicCache(source);
check('Invalid accepted refs cannot enter the 24-hour whole-analysis cache', () => {
  assert.equal(cache.analysisEntries.length, 0); assert.equal(cache.responseCacheControl, 'no-store');
  assert.equal(cache.second.analysis_cache_hit, undefined); assert.equal(cache.calls, 6);
  assert.equal(cache.second.reviewed_candidates, 0);
});
const full = await evaluate(source);
const oneMissing = await publicCache(source, { change: (row, index) => { if (index === 0) row.a = 'unknown-reference'; } });
check('One invalid reference preserves 23 grounded results without public or 24-hour caching', () => {
  const grounded = full.result.evidence.filter(row => row.case_id !== rows[0].case_id);
  assert.equal(oneMissing.first.reviewed_candidates, 23); assert.equal(oneMissing.first.pairs, 23);
  assert.equal(oneMissing.first.uncertain_candidates, 1); assert.equal(oneMissing.first.assessment_partial, true);
  assert.deepEqual(oneMissing.first.evidence, grounded);
  assert.deepEqual(oneMissing.first.shares, routing.summarize(grounded).shares);
  assert.equal(oneMissing.responseCacheControl, 'no-store'); assert.equal(oneMissing.analysisEntries.length, 0);
  assert.equal(oneMissing.second.analysis_cache_hit, undefined);
  assert.equal(oneMissing.calls, 4, 'After the existing 30-second failure pause, only the invalid batch needs a generation');
  assert.equal(oneMissing.second.review_cache_hits, 2);
});

const baselineIndex = process.argv.indexOf('--baseline');
let baselineVerified = false;
if (baselineIndex >= 0) {
  assert.ok(process.argv[baselineIndex + 1], '--baseline requires a source path');
  const oldSource = await readFile(process.argv[baselineIndex + 1], 'utf8');
  const oldTimeout = await transport(oldSource, 'timeout'), oldNetwork = await transport(oldSource, 'network');
  const oldBodyTimeout = await transport(oldSource, 'body-timeout');
  const oldSix = await evaluate(oldSource, invalidSix), oldUncertain = await evaluate(oldSource, validUncertain);
  const oldCache = await publicCache(oldSource, { version: '20261017-79' });
  check('Baseline reproduces both defects with byte-identical outgoing payloads', () => {
    for (const old of [oldTimeout, oldNetwork]) assert.ok(old.result.review_diagnostics.every(d => d.error === 'invalid_json'));
    assert.ok(oldBodyTimeout.result.review_diagnostics.every(d => d.error === 'model_incomplete'));
    assert.deepEqual(timedOut.payloads, oldTimeout.payloads); assert.deepEqual(disconnected.payloads, oldNetwork.payloads);
    assert.deepEqual(bodyTimeout.payloads, oldBodyTimeout.payloads);
    assert.equal(oldSix.result.reviewed_candidates, 24); assert.equal(oldSix.result.assessment_partial, undefined);
    assert.deepEqual(six.payloads, oldSix.payloads);
    for (const key of ['evidence', 'shares', 'review_candidates', 'rejected_evidence']) assert.deepEqual(six.result[key], oldSix.result[key]);
    assert.equal(oldCache.analysisEntries.length, 1);
    assert.equal(oldCache.analysisEntries[0][1].headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(oldCache.second.analysis_cache_hit, true); assert.equal(oldCache.calls, 3);
    // Cache-key hashing may finish in a different order for independent
    // parallel batches. Compare every byte/count without fixing launch order.
    assert.deepEqual([...cache.payloads.slice(0, 3)].sort(), [...oldCache.payloads].sort());
    assert.equal(oldUncertain.result.reviewed_candidates, uncertain.result.reviewed_candidates);
    assert.equal(oldUncertain.result.assessment_partial, uncertain.result.assessment_partial);
    assert.deepEqual(oldUncertain.payloads, uncertain.payloads);
  });
  const migrated = await publicCache(source, { store: oldCache.store, clock: oldCache.clock, version: '20261019-80', change: () => {} });
  check('A routing-version bump bypasses an existing incomplete 24-hour analysis', () => {
    assert.equal(migrated.first.analysis_cache_hit, undefined); assert.equal(migrated.first.routing_version, '20261019-80');
    assert.equal(migrated.first.reviewed_candidates, 24); assert.equal(migrated.first.pairs, 24);
    assert.equal(migrated.first.uncertain_candidates, 0); assert.equal(migrated.calls, 3);
  });
  const oldValidCache = await publicCache(oldSource, { version: '20261017-79', change: () => {} });
  const reused = await publicCache(source, { store: oldValidCache.store, clock: oldValidCache.clock, version: '20261019-80',
    change: () => { throw Error('Valid old compact cache must avoid new model calls'); } });
  check('The same version bump preserves validated old model-batch caches', () => {
    assert.equal(reused.first.analysis_cache_hit, undefined); assert.equal(reused.first.routing_version, '20261019-80');
    assert.equal(reused.first.reviewed_candidates, 24); assert.equal(reused.first.pairs, 24);
    assert.equal(reused.first.review_cache_hits, 3); assert.equal(reused.first.review_model_calls, 0);
    assert.equal(reused.calls, 0);
  });
  baselineVerified = true;
}
console.log('REVIEW_FAILURES ' + JSON.stringify({ checks, baseline_verified: baselineVerified, external_requests: 0,
  live_latency_measured: false, preserves_model_payloads: baselineVerified,
  note: 'Synthetic failure cases do not identify the cause of previously observed live failures.' }));
