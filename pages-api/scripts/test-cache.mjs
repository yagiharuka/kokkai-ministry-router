import assert from 'node:assert/strict';

const previousFetch = globalThis.fetch, previousCaches = globalThis.caches, previousNow = Date.now;
let clock = previousNow(), ndl = 0, models = 0;
Date.now = () => clock += 3001;
const stored = new Map();
const expiries = new Map();
globalThis.caches = { default: {
  async match(key) { return expiries.get(key) > Date.now() ? stored.get(key)?.clone() : undefined; },
  async put(key, response) {
    stored.set(key, response.clone());
    expiries.set(key, Date.now() + Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 0) * 1000);
  },
} };
const speeches = [
  { issueID: 'cache-fixture', speechID: 'cache-fixture_1', speechOrder: 1, speakerGroup: '会派', speech: '教員の長時間労働を是正するにはどうしますか。', speechURL: 'https://kokkai.ndl.go.jp/txt/cache/question' },
  { issueID: 'cache-fixture', speechID: 'cache-fixture_2', speechOrder: 2, speakerPosition: '文部科学大臣', speech: '教員の長時間労働を減らすため支援員を配置します。', speechURL: 'https://kokkai.ndl.go.jp/txt/cache/answer' },
];
const meeting = { issueID: 'cache-fixture', date: '2026-05-01', nameOfMeeting: '文教委員会', speechRecord: speeches };
globalThis.fetch = async url => {
  ndl++;
  return Response.json(new URL(url).pathname.endsWith('meeting') ? { meetingRecord: [meeting] } : { speechRecord: speeches });
};
const env = { CLOUDFLARE_WORKERS_PLAN: 'free', AI: { run: async (_, payload) => {
  models++;
  const input = JSON.parse(payload.messages[1].content);
  return { response: { reviews: input.candidates.map(row => [row.id, 'accept', Object.keys(row.source_question || input.candidates.find(other => other.id === row.source_question_ref).source_question)[0], Object.keys(row.source_answer)[0], 'same']) } };
} } };
const request = question => new Request('https://example.invalid/api/cases?' + new URLSearchParams({ question }));
const question = '教員の長時間労働を是正すべきではないか';
try {
  const first = (await import('../worker/model-api.js?cache-first')).default;
  const replies = await Promise.all([first.fetch(request(question), env), first.fetch(request(question), env)]);
  const results = await Promise.all(replies.map(reply => reply.json()));
  assert.ok(results.every(result => result.pairs === 1));
  assert.equal(models, 1, 'Concurrent identical requests must share one model review even while edge lookup yields');
  assert.equal(ndl, 3);
  assert.equal([...stored.keys()].filter(key => key.includes('__analysis_cache/')).length, 1);
  const analysisEntry = [...stored.entries()].find(([key]) => key.includes('__analysis_cache/'))[1];
  assert.equal(analysisEntry.headers.get('cache-control'), 'public, max-age=86400');
  assert.ok(results[0].analyzed_at);

  clock += 12 * 3600000;
  const restarted = (await import('../worker/model-api.js?cache-restarted')).default;
  const hit = await (await restarted.fetch(request(question), env)).json();
  assert.equal(hit.analysis_cache_hit, true);
  assert.equal(hit.pairs, 1);
  assert.equal(models, 1, 'An isolate restart must not force a paid-in-neurons repeat review');
  assert.equal(ndl, 3);
  assert.equal(hit.review_model_calls, 0);
  assert.ok(hit.review_diagnostics.every(d => !d.model_called && !d.usage));

  const different = await (await restarted.fetch(request('教員の長時間労働を減らすための支援員配置について伺います。'), env)).json();
  assert.equal(different.pairs, 1);
  assert.equal(different.analysis_cache_hit, undefined);
  assert.equal(models, 2, 'A different complete question needs its own assessment');

  const disabled = await (await restarted.fetch(request(question), {})).json();
  assert.equal(disabled.assessment_status, 'not_configured');
  assert.deepEqual(disabled.shares, []);
  assert.equal(models, 2);

  // The source search refreshes after 24 hours, but unchanged exact source
  // batches can reuse their validated judgments without another AI call.
  clock += 13 * 3600000;
  const refreshed = await (await restarted.fetch(request(question), env)).json();
  assert.equal(refreshed.analysis_cache_hit, undefined);
  assert.equal(refreshed.review_model_calls, 0);
  assert.equal(refreshed.review_cache_hits, 1);
  assert.equal(models, 2);
  assert.ok(ndl > 3);
  assert.ok(Date.parse(refreshed.analyzed_at) > Date.parse(hit.analyzed_at));
} finally {
  globalThis.fetch = previousFetch;
  Date.now = previousNow;
  if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches;
}
console.log('Exact-question edge cache, isolate restart, concurrent deduplication and question/configuration isolation checks passed.');
