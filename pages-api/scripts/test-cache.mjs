import assert from 'node:assert/strict';

const previousFetch = globalThis.fetch, previousCaches = globalThis.caches, previousNow = Date.now;
let clock = previousNow(), ndl = 0, models = 0;
Date.now = () => clock += 3001;
const stored = new Map();
globalThis.caches = { default: {
  async match(key) { return stored.get(key)?.clone(); },
  async put(key, response) { stored.set(key, response.clone()); },
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
  return { response: { reviews: input.candidates.map(row => ({ id: row.id, decision: 'accept', reason: '同じ教員の勤務負担への答弁。',
    question_part: Object.keys(row.source_question)[0], answer_part: Object.keys(row.source_answer)[0] })) } };
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

  const restarted = (await import('../worker/model-api.js?cache-restarted')).default;
  const hit = await (await restarted.fetch(request(question), env)).json();
  assert.equal(hit.analysis_cache_hit, true);
  assert.equal(hit.pairs, 1);
  assert.equal(models, 1, 'An isolate restart must not force a paid-in-neurons repeat review');
  assert.equal(ndl, 3);

  const different = await (await restarted.fetch(request('教員の長時間労働を減らすための支援員配置について伺います。'), env)).json();
  assert.equal(different.pairs, 1);
  assert.equal(different.analysis_cache_hit, undefined);
  assert.equal(models, 2, 'A different complete question needs its own assessment');

  const disabled = await (await restarted.fetch(request(question), {})).json();
  assert.equal(disabled.assessment_status, 'not_configured');
  assert.deepEqual(disabled.shares, []);
  assert.equal(models, 2);
} finally {
  globalThis.fetch = previousFetch;
  Date.now = previousNow;
  if (previousCaches === undefined) delete globalThis.caches; else globalThis.caches = previousCaches;
}
console.log('Exact-question edge cache, isolate restart, concurrent deduplication and question/configuration isolation checks passed.');
