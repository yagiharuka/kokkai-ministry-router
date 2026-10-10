import assert from 'node:assert/strict';
import {makePlan, diversifyCandidates} from '../worker/routing-core.mjs';
import {sourceParts, reviewCompactAssignments} from '../worker/semantic-review.mjs';
import worker from '../worker/model-api.js';

const row = (id, ministry='文部科学省', suffix='') => ({case_id:id,ministry,question:'教員の長時間労働を是正するにはどうしますか。',answer:'教員の長時間労働を減らすため支援員を配置します。',date:'2026-05-01',position:'文部科学大臣',url:`https://kokkai.ndl.go.jp/txt/fixture/${id}${suffix}`,retrieval_score:1});
const env = {CLOUDFLARE_WORKERS_PLAN:'free', AI:{run: async () => { throw new Error('override per case'); }}};
const reviews = input => input.candidates.map(c=>[c.id,'accept',Object.keys(c.source_question || input.candidates.find(other => other.id === c.source_question_ref).source_question)[0],Object.keys(c.source_answer)[0],'same']);
const result = rows => ({review_candidates:rows,recent_since:'2024-01-01',searched:[],requests_used:1,errors:[]});
const parts=sourceParts('原文の文章です。'+ '長い文章'.repeat(80)+'。','q');
assert.ok(Object.values(parts).every(p=>p.length<=160));
assert.ok(Object.values(parts).every(p=>('原文の文章です。'+'長い文章'.repeat(80)+'。').includes(p)));
assert.deepEqual(Object.values(sourceParts('教師の業務削減についてのお尋ねです。教員の負担軽減に取り組みます。','a')),['教員の負担軽減に取り組みます。']);

const clustered=[...Array.from({length:30},(_,i)=>row(`dense:q${i}`)),row('other:q1','財務省'),row('third:q1','経済産業省')];
const diverse=diversifyCandidates(clustered,24);
assert.equal(new Set(diverse.map(r=>r.case_id)).size,24);
assert.ok(diverse.some(r=>r.ministry==='財務省'));
assert.ok(diverse.some(r=>r.ministry==='経済産業省'));
const relevant = {...row('strong:q1','経済産業省'),retrieval_score:1};
const distractions=Array.from({length:30},(_,i)=>({...row(`weak${i}:q1`),retrieval_score:.5}));
assert.ok(diversifyCandidates([...distractions,relevant],24).some(r=>r.case_id==='strong:q1'),'Weak matches in many meetings must not crowd out stronger evidence');
const twentyfour=result(clustered);
let active=0,peak=0,calls=0;
const parallel=await reviewCompactAssignments('教員の長時間労働の是正について',twentyfour,{...env,AI:{run:async(model,payload)=>{
 calls++;active++;peak=Math.max(peak,active);
 assert.equal(model,'@cf/openai/gpt-oss-20b');assert.equal(payload.max_tokens,2560);
 const input=JSON.parse(payload.messages[1].content);
 assert.ok(input.candidates.length<=12);
 assert.equal(input.candidates[0].id,'c1');
 assert.equal(payload.response_format.json_schema.properties.reviews.minItems,input.candidates.length);
 await new Promise(resolve=>setTimeout(resolve,5));active--;
 return {response:{reviews:reviews(input)}};
}}});
assert.equal(calls,2);assert.equal(peak,2);
assert.equal(parallel.pairs,24);assert.equal(parallel.evidence.length,24);
assert.equal(parallel.unreviewed_candidates,8);
assert.ok(parallel.candidates.every(r=>clustered.some(s=>r.url===s.url&&r.ministry===s.ministry)));

const repeated=[row('same:q1','文部科学省','a'),{...row('same:q1','文部科学省','b'),answer:'教師の勤務負担を減らすため業務を削減します。'}];
let repeatedInput;
const selected=await reviewCompactAssignments('教員の負担を減らすべきではないか',result(repeated),{...env,AI:{run:async(_,p)=>{
 const input=JSON.parse(p.messages[1].content);repeatedInput=input;
 const rs=reviews(input);rs[0][3]=Object.keys(input.candidates[0].source_answer).find(k=>k.startsWith('v2'));
 return {response:{reviews:rs}};
}}});
assert.equal(repeatedInput.candidates.length,1,'Repeated replies share one review, without dropping the later answer');
assert.equal(selected.pairs,1);assert.equal(selected.evidence[0].url,repeated[1].url);
assert.equal(selected.evidence[0].answer,repeated[1].answer);
assert.ok(repeated[1].answer.includes(selected.evidence[0].answer_evidence));

const grounded=await reviewCompactAssignments('教員の長時間労働について',result([row('ground:q1'),row('ground:q2')]),{...env,AI:{run:async(_,p)=>{
 const rs=reviews(JSON.parse(p.messages[1].content));rs[0][3]='invented';return {response:{reviews:rs}};
}}});
assert.equal(grounded.pairs,1);assert.equal(grounded.uncertain_candidates,1);
let partialCalls=0;
const partial=await reviewCompactAssignments('教員の長時間労働について',twentyfour,{...env,AI:{run:async(_,p)=>{
 const input=JSON.parse(p.messages[1].content);if(partialCalls++===0)throw new Error('temporary transport failure');
 return {response:{reviews:reviews(input)}};
}}});
assert.equal(partial.assessment_status,'reviewed');assert.equal(partial.pairs,12);assert.equal(partial.assessment_partial,true);
let limitedCalls=0;
const limited=await reviewCompactAssignments('教員の長時間労働について',twentyfour,{...env,AI:{run:async(_,p)=>{
 if(limitedCalls++===0)return {choices:[{finish_reason:'length',message:{role:'assistant',content:'{"reviews":['}}]};
 return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};
}}});
assert.equal(limitedCalls,2,'Truncation must not create a retry tree');
assert.equal(limited.pairs,12);assert.equal(limited.assessment_partial,true);
assert.equal(limited.review_diagnostics[0].error,'model_output_limit');
assert.equal(limited.review_diagnostics.reduce((n,d)=>n+d.output_token_limit,0),5120);

for(const bad of [
 ['c1','accept','q1','v1a1','unknown'],
 ['c1','reject','q1','v1a1','scope'],
 ['c1','accept','q1','v1a1','context'],
 ['c1','accept','q1','v1a1'],
 ['c1','accept','q1','v1a1','same', 'extra'],
 ['c1','accept','q1',42,'same'],
 {id:'c1',decision:'accept',question_part:'q1',answer_part:'v1a1',reason:'old format'},
]) {
 const malformed=await reviewCompactAssignments('教員の長時間労働について',result([row('shape:q1')]),{...env,AI:{run:async()=>({response:{reviews:[bad]}})}});
 assert.equal(malformed.pairs,0,'Invalid compact output cannot create accepted evidence');
 assert.equal(malformed.uncertain_candidates,1);
}
const coded=await reviewCompactAssignments('教員の長時間労働について',result([row('code:q1'),row('code:q2')]),{...env,AI:{run:async()=>({response:{reviews:[['c1','reject','','','scope'],['c2','uncertain','','','context']]}})}});
assert.equal(coded.rejected_candidates,1);assert.equal(coded.uncertain_candidates,1);assert.equal(coded.pairs,0);
assert.ok(coded.review_candidates[0].review_reason.includes('文脈が不足'));
const forged=await reviewCompactAssignments('教員の長時間労働について',result([row('bad:q1')]),{...env,AI:{run:async(_,p)=>{
 const rs=reviews(JSON.parse(p.messages[1].content));rs[0][0]='unknown';return {response:{reviews:rs}};
}}});
assert.equal(forged.assessment_status,'failed');assert.equal(forged.pairs,0);

const incomplete=await reviewCompactAssignments('教員の長時間労働について',result([row('missing:q1'),row('missing:q2'),row('missing:q3')]),{...env,AI:{run:async(_,p)=>{const rs=reviews(JSON.parse(p.messages[1].content));return {response:{reviews:rs.slice(0,2)}};}}});
assert.equal(incomplete.pairs,2,'An omitted candidate must not discard other grounded reviews');
assert.equal(incomplete.uncertain_candidates,1);assert.equal(incomplete.reviewed_candidates,2);
const duplicated=await reviewCompactAssignments('教員の長時間労働について',result([row('duplicate:q1'),row('duplicate:q2')]),{...env,AI:{run:async(_,p)=>{const rs=reviews(JSON.parse(p.messages[1].content));return {response:{reviews:[...rs,rs[0]]}};}}});
assert.equal(duplicated.pairs,1,'Only the duplicate candidate must be withheld');
assert.equal(duplicated.uncertain_candidates,1);
const plenary = {...row('plenary:q1','内閣府・内閣官房等'),position:'内閣総理大臣',meeting:'本会議',answer_truncated:true};
let judgedPlenary=false;
const withoutPlenary=await reviewCompactAssignments('教員の長時間労働について',result([plenary,row('committee:q1')]),{...env,AI:{run:async(_,p)=>{
 const input=JSON.parse(p.messages[1].content);judgedPlenary ||= input.candidates.some(c=>c.meeting==='本会議');
 return {response:{reviews:reviews(input)}};
}}});
assert.equal(judgedPlenary,false);
assert.equal(withoutPlenary.pairs,1);
assert.equal(withoutPlenary.context_pending_candidates,1);
assert.equal(withoutPlenary.review_candidates.some(r=>r.case_id==='plenary:q1'),true);
assert.deepEqual(withoutPlenary.shares.map(r=>r.ministry),['文部科学省']);

// Public request path: source retrieval starts without an AI planning call,
// adjacent full source turns are reviewed, and the identical question is cached.
const previousFetch=globalThis.fetch,previousNow=Date.now;let clock=previousNow();Date.now=()=>clock+=3001;
const meeting={issueID:'public-fixture',date:'2026-05-01',nameOfMeeting:'文教委員会',speechRecord:[
 {speechID:'public-fixture_001',speechOrder:1,speakerGroup:'会派',speech:'教員の長時間労働を是正できるでしょうか。',speechURL:'https://kokkai.ndl.go.jp/txt/fixture/question'},
 {speechID:'public-fixture_002',speechOrder:2,speakerPosition:'文部科学大臣',speech:'教員の長時間労働を減らすため支援員を配置します。',speechURL:'https://kokkai.ndl.go.jp/txt/fixture/answer'},
]};
let ndl=0,model=0,startedWithSource=false;
const publicEnv={...env,AI:{run:async(_,p)=>{model++;const input=JSON.parse(p.messages[1].content);assert.ok(ndl>0);return {response:{reviews:reviews(input)}};}}};
globalThis.fetch=async url=>{ndl++;startedWithSource ||= model===0;const u=new URL(url);assert.equal(u.origin,'https://kokkai.ndl.go.jp');return Response.json(u.pathname.endsWith('meeting')?{meetingRecord:[meeting]}:{speechRecord:meeting.speechRecord.map(s=>({...s,issueID:meeting.issueID})),numberOfRecords:2});};
try {
 const req=new Request('https://example.invalid/api/cases?'+new URLSearchParams({question:'教員の長時間労働を是正すべきではないか'}));
 const data=await (await worker.fetch(req,publicEnv)).json();
 assert.equal(data.search_plan_status,'direct');assert.equal(data.pairs,1);assert.equal(model,1);assert.equal(ndl,3);assert.equal(startedWithSource,true);
 const repeatedResult=await (await worker.fetch(req,publicEnv)).json();assert.equal(model,1);assert.equal(ndl,3);assert.equal(repeatedResult.analysis_cache_hit,true);
 // Semantically rewrite colloquial wording only when direct recall has no Q/A.
 let planning=0;
 globalThis.fetch=async url=>{const u=new URL(url);const any=u.searchParams.get('any');return Response.json(any==='教師 勤務時間'? (u.pathname.endsWith('meeting')?{meetingRecord:[meeting]}:{speechRecord:meeting.speechRecord.map(s=>({...s,issueID:meeting.issueID}))}):{speechRecord:[]});};
 const fallbackEnv={...env,AI:{run:async(_,p)=>{
  if(p.response_format.json_schema.properties.queries){planning++;return {response:{queries:['教師 勤務時間','教員 負担']}};}
  return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};
 }}};
 const fallback=await (await worker.fetch(new Request('https://example.invalid/api/cases?'+new URLSearchParams({question:'教師の勤務改善を頑張るべきではないか'})),fallbackEnv)).json();
 assert.equal(planning,1);assert.equal(fallback.retrieval_rounds,2);assert.equal(fallback.pairs,1);
} finally {globalThis.fetch=previousFetch;Date.now=previousNow;}
console.log('Compact review: 24 distinct candidates, concurrent batches, exact source references, repeated-answer selection, partial failure, direct search and cache checks passed.');
