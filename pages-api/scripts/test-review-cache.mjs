import assert from 'node:assert/strict';
import { reviewCompactAssignments } from '../worker/semantic-review.mjs';

const previousCaches = globalThis.caches, previousNow = Date.now;
let clock = previousNow(), calls = 0;
Date.now = () => clock;
const stored = new Map();
globalThis.caches = { default: {
  async match(key) { return stored.get(key)?.clone(); },
  async put(key, response) { stored.set(key, response.clone()); },
} };
const rows = Array.from({length:8},(_,i)=>({
  case_id:`cost:q${i}`,ministry:'文部科学省',position:'文部科学大臣',meeting:'文教委員会',date:'2026-05-01',
  question:'教員の勤務時間を減らすにはどうしますか。'+ '学校の負担について詳しく伺います。'.repeat(15),
  answer:`教員の勤務負担を軽減するため支援員を${i+1}人配置します。`,
  previous_context:i===1?'直前に学校の予算を質問しています。':'',
  question_truncated:i===2,answer_truncated:i===3,
  url:`https://kokkai.ndl.go.jp/txt/cost/${i}`,retrieval_score:1,
}));
const inputResult = selected => ({review_candidates:selected,recent_since:'2024-01-01',errors:[],searched:[]});
const question = '教員の勤務負担を減らすべきではないか';
let failAnswer = '', invalid = false;
const captured=[];
const env={CLOUDFLARE_WORKERS_PLAN:'free',AI:{run:async(_,payload)=>{
  calls++;
  const input=JSON.parse(payload.messages[1].content);captured.push(input);
  if(failAnswer && JSON.stringify(input).includes(failAnswer))throw new Error('temporary failure');
  return {usage:{prompt_tokens:1000,completion_tokens:200},response:{reviews:input.candidates.map(c=>({
    id:c.id,decision:'accept',reason:'同じ教員の負担への答弁。',
    question_part:Object.keys(c.source_question || input.candidates.find(other=>other.id===c.source_question_ref).source_question)[0],
    answer_part:invalid?'invented':Object.keys(c.source_answer)[0],
  }))}};
}}};
try {
  const first=await reviewCompactAssignments(question,inputResult(rows),env);
  assert.equal(first.pairs,8);assert.equal(calls,2);
  assert.equal(first.review_model_calls,2);assert.equal(first.review_cache_hits,0);
  assert.ok(first.review_diagnostics.every(d=>d.usage.input_tokens===1000&&d.usage.output_tokens===200));
  assert.equal(stored.size,2);
  assert.ok(captured.every(input=>input.candidates.filter(c=>c.source_question).length===1));
  assert.equal(captured[0].candidates[1].previous_context,rows[1].previous_context);
  assert.equal(captured[0].candidates[2].question_truncated,true);
  assert.equal(captured[0].candidates[3].answer_truncated,true);
  assert.ok(first.evidence.every(e=>rows.some(r=>e.url===r.url&&e.answer===r.answer&&e.question===r.question)));

  clock += 2 * 86400000;
  const repeat=await reviewCompactAssignments(question,inputResult(rows),env);
  assert.equal(calls,2);assert.equal(repeat.review_model_calls,0);assert.equal(repeat.review_cache_hits,2);
  assert.equal(repeat.pairs,8);assert.ok(repeat.review_diagnostics.every(d=>!d.usage));

  const changed=rows.map((r,i)=>i===7?{...r,answer:r.answer+'予算の見直しも行います。'}:r);
  const refreshed=await reviewCompactAssignments(question,inputResult(changed),env);
  assert.equal(calls,3);assert.equal(refreshed.review_cache_hits,1,'Changed source text must only rejudge its batch');
  assert.equal(refreshed.pairs,8);

  const scoped=await reviewCompactAssignments('海外の教員の勤務負担を減らすべきではないか',inputResult(rows),env);
  assert.equal(calls,5);assert.equal(scoped.review_cache_hits,0,'Question scope must not reuse another judgment');

  // Valid batches survive a partial failure. Only the missing batch is retried
  // on the next request; neither an invalid reference nor a failure is cached.
  stored.clear();failAnswer='支援員を5人';
  const partial=await reviewCompactAssignments(question,inputResult(rows),env);
  assert.equal(partial.assessment_partial,true);assert.equal(partial.pairs,4);assert.equal(stored.size,1);
  failAnswer='';const before=calls;
  const recovered=await reviewCompactAssignments(question,inputResult(rows),env);
  assert.equal(calls,before+1);assert.equal(recovered.pairs,8);assert.equal(recovered.review_cache_hits,1);

  stored.clear();invalid=true;
  const bad=await reviewCompactAssignments(question,inputResult(rows),env);
  assert.equal(bad.pairs,0);assert.equal(stored.size,0);
  invalid=false;
  await reviewCompactAssignments(question,inputResult(rows),env);
  clock += 8 * 86400000;
  const beforeExpiry=calls;
  await reviewCompactAssignments(question,inputResult(rows),env);
  assert.equal(calls,beforeExpiry+2,'Expired judgments must be recomputed');
} finally {
  Date.now=previousNow;
  if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
}
console.log('Lossless question sharing, source/scope isolation, partial recovery, exact judgment cache expiry and actual usage checks passed.');
