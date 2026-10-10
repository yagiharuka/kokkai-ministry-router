import assert from 'node:assert/strict';

const previousFetch = globalThis.fetch, previousCaches = globalThis.caches, previousNow = Date.now;
let clock = previousNow(), sources = 0, models = 0;
Date.now = () => clock += 3001;
const nextReset = (Math.floor(clock / 86400000) + 1) * 86400000;
const stored = new Map();
globalThis.caches = { default: {
  async match(key) { return stored.get(key)?.clone(); },
  async put(key, response) { stored.set(key, response.clone()); },
} };
const speeches = [
  { issueID:'quota-fixture', speechID:'quota_1', speechOrder:1, speakerGroup:'会派', speech:'教員の長時間労働を是正するにはどうしますか。', speechURL:'https://kokkai.ndl.go.jp/txt/quota/question' },
  { issueID:'quota-fixture', speechID:'quota_2', speechOrder:2, speakerPosition:'文部科学大臣', speech:'教員の長時間労働を減らすため支援員を配置します。', speechURL:'https://kokkai.ndl.go.jp/txt/quota/answer' },
];
globalThis.fetch = async url => {
  sources++;
  return Response.json(new URL(url).pathname.endsWith('meeting') ? { meetingRecord:[{issueID:'quota-fixture',date:'2026-05-01',nameOfMeeting:'文教委員会',speechRecord:speeches}] } : { speechRecord:speeches });
};
let exhaust = false;
const env = { CLOUDFLARE_WORKERS_PLAN:'free', CLOUDFLARE_AI_QUOTA_PAUSED_UNTIL:new Date(nextReset).toISOString(), AI:{run:async (_, payload) => {
  models++;
  if (exhaust) throw new Error('daily neuron quota exceeded');
  const input = JSON.parse(payload.messages[1].content);
  return {response:{reviews:input.candidates.map(row=>[row.id,'accept',Object.keys(row.source_question || input.candidates.find(other => other.id === row.source_question_ref).source_question)[0],Object.keys(row.source_answer)[0],'same'])}};
}}};
const request = question => new Request('https://example.invalid/api/cases?' + new URLSearchParams({question}));
try {
  const worker = (await import('../worker/model-api.js?quota-first')).default;
  const paused = await (await worker.fetch(request('教員の長時間労働を是正すべきではないか'),env)).json();
  assert.equal(paused.assessment_error,'quota_exhausted');
  assert.equal(paused.requests_used,0);
  assert.equal(sources,0); assert.equal(models,0);
  const status = await (await worker.fetch(new Request('https://example.invalid/api/status'),env)).json();
  assert.equal(status.model_ready,true); assert.equal(status.can_analyze,false);
  assert.equal(status.quota_reset_at,new Date(nextReset).toISOString());

  clock = nextReset + 1;
  const restored = await (await worker.fetch(request('教員の長時間労働を是正すべきではないか'),env)).json();
  assert.equal(restored.assessment_status,'reviewed'); assert.equal(restored.pairs,1); assert.equal(models,1);

  exhaust = true;
  const exhausted = await (await worker.fetch(request('教員の長時間労働を是正する制度について伺います。'),env)).json();
  assert.equal(exhausted.assessment_error,'quota_exhausted');
  const before = {sources,models};
  const restarted = (await import('../worker/model-api.js?quota-restarted')).default;
  const again = await (await restarted.fetch(request('教員の長時間労働を減らす支援について伺います。'),env)).json();
  assert.equal(again.assessment_error,'quota_exhausted'); assert.equal(again.requests_used,0);
  assert.equal(sources,before.sources); assert.equal(models,before.models);
} finally {
  globalThis.fetch=previousFetch; Date.now=previousNow;
  if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
}
console.log('Known quota stop, no source/model requests, UTC reset and persisted quota state checks passed.');
