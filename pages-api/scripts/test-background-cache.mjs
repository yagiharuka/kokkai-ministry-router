import assert from 'node:assert/strict';
import { runCacheWrite } from '../worker/background-cache.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const soon = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Response waited for background cache writes')), 500);
  })]); } finally { clearTimeout(timer); }
};
const tick = () => new Promise(resolve => setImmediate(resolve));

// The exact promise must be attached to the request lifetime, and its failure
// must be consumed even after the response has been sent.
let registered;
const delayed = deferred();
assert.equal(await soon(runCacheWrite(() => delayed.promise, { waitUntil(p) { registered = p; } })), true);
let settled = false; registered.then(() => { settled = true; });
await tick(); assert.equal(settled, false);
delayed.resolve(); await registered; assert.equal(settled, true);
for (const write of [() => { throw new Error('sync cache fault'); }, () => Promise.reject(new Error('async cache fault'))]) {
  assert.equal(await runCacheWrite(write, { waitUntil(p) { registered = p; } }), true);
  await registered;
  assert.equal(await runCacheWrite(write), false);
}
for (const ctx of [undefined, {}, { waitUntil() { throw new Error('detached context'); } }]) {
  const slow = deferred(); let returned = false;
  const task = runCacheWrite(() => slow.promise, ctx).then(value => { returned = true; return value; });
  await tick(); assert.equal(returned, false, 'Without lifetime registration, the write must be awaited');
  slow.resolve(); assert.equal(await task, false);
}

const previousFetch = globalThis.fetch, previousCaches = globalThis.caches, previousNow = Date.now;
let clock = previousNow(), calls = 0, activeSources = 0, peakSources = 0;
Date.now = () => clock += 3001;
const stored = new Map(), writes = [], lifetimes = [];
globalThis.caches = { default: {
  async match(key) { return stored.get(key)?.clone(); },
  put(key, response) {
    const gate = deferred(); writes.push({ key, gate });
    return gate.promise.then(() => { stored.set(key, response.clone()); });
  },
} };
const speeches = Array.from({ length: 24 }, (_, i) => {
  const issueID = `background${i % 3}`, order = i * 2 + 1;
  return [
    { issueID, speechID: `${issueID}_${order}`, speechOrder: order, speakerGroup: '会派',
      speech: '教員の長時間労働を是正するにはどうしますか。', speechURL: `https://kokkai.ndl.go.jp/txt/${issueID}/${order}` },
    { issueID, speechID: `${issueID}_${order + 1}`, speechOrder: order + 1, speakerPosition: '文部科学大臣',
      speech: `教員の長時間労働を減らすため支援員を${i + 1}人配置します。`, speechURL: `https://kokkai.ndl.go.jp/txt/${issueID}/${order + 1}` },
  ];
}).flat();
globalThis.fetch = async () => {
  activeSources++; peakSources = Math.max(peakSources, activeSources);
  await tick(); activeSources--;
  return Response.json({ speechRecord: speeches });
};
const payloads = [];
const env = { CLOUDFLARE_WORKERS_PLAN: 'free', AI: { run: async (_, payload) => {
  calls++; payloads.push(payload);
  const input = JSON.parse(payload.messages[1].content);
  return { response: { reviews: input.candidates.map(row => [row.id, 'accept',
    Object.keys(row.source_question || input.candidates.find(other => other.id === row.source_question_ref).source_question)[0],
    Object.keys(row.source_answer)[0], 'same']) } };
} } };
const question = '教員の長時間労働を是正すべきではないか';
const request = () => new Request('https://example.invalid/api/cases?' + new URLSearchParams({ question }));
try {
  const worker = (await import('../worker/model-api.js?background-cache')).default;
  const result = await soon(worker.fetch(request(), env, { waitUntil(p) { lifetimes.push(p); } }).then(r => r.json()));
  assert.equal(result.reviewed_candidates, 24); assert.equal(result.pairs, 24);
  assert.equal(calls, 2); assert.equal(peakSources, 1);
  assert.ok(payloads.every(p => p.max_tokens === 2560 && JSON.parse(p.messages[1].content).candidates.length === 12));
  assert.equal(result.selection_runs, 1);
  assert.deepEqual(result.original_timing, result.timing);
  assert.ok(result.review_diagnostics.every(d => d.cache_write_deferred && Number.isFinite(d.model_ms)));
  assert.ok(result.source_diagnostics.every(d => d.cache_write_deferred && d.cache === 'miss'));
  assert.equal(stored.size, 0, 'The result must be available while every cache write is still blocked');
  assert.equal(writes.length, 4, 'One source, two reviews and one result cache write');
  assert.equal(lifetimes.length, writes.length, 'Every background write must be registered');
  assert.ok(!JSON.stringify(result.source_diagnostics).includes(question));
  for (const { gate } of writes) gate.resolve();
  await Promise.all(lifetimes);
  assert.equal(stored.size, 4);
  const restarted = (await import('../worker/model-api.js?background-restarted')).default;
  const hit = await (await restarted.fetch(request(), env)).json();
  assert.equal(calls, 2); assert.equal(hit.analysis_cache_hit, true);
  assert.deepEqual(hit.original_timing, result.timing);
  assert.equal(hit.timing.cached, true); assert.equal(hit.review_model_calls, 0);
} finally {
  for (const { gate } of writes) gate.resolve();
  await Promise.all(lifetimes);
  globalThis.fetch = previousFetch; Date.now = previousNow;
  if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches;
}
console.log('Background cache lifetime, delayed/sync/async failure handling, unchanged 24-candidate calls and original timing checks passed.');
