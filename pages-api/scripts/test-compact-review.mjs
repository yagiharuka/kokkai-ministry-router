import assert from 'node:assert/strict';
import {makePlan, diversifyCandidates} from '../worker/routing-core.mjs';
import {sourceParts, reviewCompactAssignments} from '../worker/semantic-review.mjs';
import worker from '../worker/model-api.js';

const row = (id, ministry='文部科学省', suffix='') => ({case_id:id,ministry,question:'教員の長時間労働を是正するにはどうしますか。',answer:'教員の長時間労働を減らすため支援員を配置します。',date:'2026-05-01',position:'文部科学大臣',url:`https://kokkai.ndl.go.jp/txt/fixture/${id}${suffix}`,retrieval_score:1});
const env = {CLOUDFLARE_WORKERS_PLAN:'free', AI:{run: async () => { throw new Error('override per case'); }}};
const reviews = input => input.candidates.map(c=>[c.id,'教員の長時間労働に対して支援員を配置する答弁', 'accept',Object.keys(c.source_question || input.candidates.find(other => other.id === c.source_question_ref).source_question)[0],Object.keys(c.source_answer)[0],'same'].slice(0,5)).map(([id,comparison,decision,q,a])=>({id,beneficiary:'学校の教員',activity:'学校での教育業務',relation:'same',comparison,decision,q,a}));
const result = rows => ({review_candidates:rows,recent_since:'2024-01-01',searched:[],requests_used:1,errors:[]});
assert.deepEqual(Object.values(sourceParts('委員にお答えします。教員の負担軽減に取り組みます。','a')),['教員の負担軽減に取り組みます。']);
const parts=sourceParts('原文の文章です。'+ '長い文章'.repeat(80)+'。','q');
assert.equal(Object.values(parts).length,2,'Keep whole sentences rather than splitting words at a fixed character count');
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
 assert.equal(model,'@cf/openai/gpt-oss-20b');assert.equal(payload.max_tokens,3072);
 const input=JSON.parse(payload.messages[1].content);
 assert.ok(input.candidates.length<=8);
 assert.equal(input.candidates[0].id,'c1');
 assert.equal(payload.response_format.type,'json_schema');
 assert.equal(payload.response_format.json_schema.properties.reviews.minItems,input.candidates.length);
 assert.equal(payload.response_format.json_schema.properties.reviews.maxItems,input.candidates.length);
 await new Promise(resolve=>setTimeout(resolve,5));active--;
 return {response:{reviews:reviews(input)}};
}}});
assert.equal(calls,3);assert.equal(peak,3);
assert.equal(parallel.pairs,24);assert.equal(parallel.evidence.length,24);
assert.equal(parallel.unreviewed_candidates,8);
assert.ok(parallel.candidates.every(r=>clustered.some(s=>r.url===s.url&&r.ministry===s.ministry)));

let smallActive=0,smallPeak=0,smallCalls=0;
const small=await reviewCompactAssignments('教員の長時間労働の是正について',twentyfour,{...env,REVIEW_BATCH_SIZE:'4',AI:{run:async(_,payload)=>{
 smallCalls++;smallActive++;smallPeak=Math.max(smallPeak,smallActive);
 const input=JSON.parse(payload.messages[1].content);
 assert.equal(input.candidates.length,4);assert.equal(payload.max_tokens,2048);
 await new Promise(resolve=>setTimeout(resolve,5));smallActive--;
 return {response:{reviews:reviews(input)}};
}}});
assert.equal(smallCalls,6);assert.equal(smallPeak,6);assert.equal(small.reviewed_candidates,24);
assert.deepEqual(small.evidence.map(e=>e.case_id),parallel.evidence.map(e=>e.case_id),'Smaller parallel batches preserve every selected source');

const repeated=[row('same:q1','文部科学省','a'),{...row('same:q1','文部科学省','b'),answer:'教師の勤務負担を減らすため業務を削減します。'}];
let repeatedInput;
const selected=await reviewCompactAssignments('教員の負担を減らすべきではないか',result(repeated),{...env,AI:{run:async(_,p)=>{
 const input=JSON.parse(p.messages[1].content);repeatedInput=input;
 const rs=reviews(input);rs[0].a=Object.keys(input.candidates[0].source_answer).find(k=>k.startsWith('v2'));
 return {response:{reviews:rs}};
}}});
assert.equal(repeatedInput.candidates.length,1,'Repeated replies share one review, without dropping the later answer');
assert.equal(selected.pairs,1);assert.equal(selected.evidence[0].url,repeated[1].url);
assert.equal(selected.evidence[0].answer,repeated[1].answer);
assert.ok(repeated[1].answer.includes(selected.evidence[0].answer_evidence));

const grounded=await reviewCompactAssignments('教員の長時間労働について',result([row('ground:q1'),row('ground:q2')]),{...env,AI:{run:async(_,p)=>{
 const rs=reviews(JSON.parse(p.messages[1].content));rs[0].a='invented';return {response:{reviews:rs}};
}}});
assert.equal(grounded.pairs,1);assert.equal(grounded.uncertain_candidates,1);
let partialCalls=0;
const partial=await reviewCompactAssignments('教員の長時間労働について',twentyfour,{...env,AI:{run:async(_,p)=>{
 const input=JSON.parse(p.messages[1].content);if(partialCalls++===0)throw new Error('temporary transport failure');
 return {response:{reviews:reviews(input)}};
}}});
assert.equal(partial.assessment_status,'reviewed');assert.equal(partial.pairs,16);assert.equal(partial.assessment_partial,true);
let limitedCalls=0;
const limited=await reviewCompactAssignments('教員の長時間労働について',twentyfour,{...env,AI:{run:async(_,p)=>{
 if(limitedCalls++===0)return {choices:[{finish_reason:'length',message:{role:'assistant',content:'{"reviews":['}}]};
 return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};
}}});
assert.equal(limitedCalls,3,'Truncation must not create a retry tree');
assert.equal(limited.pairs,16);assert.equal(limited.assessment_partial,true);
assert.equal(limited.review_diagnostics[0].error,'model_output_limit');
assert.equal(limited.review_diagnostics.reduce((n,d)=>n+d.output_token_limit,0),9216);

for(const bad of [
 {id:'c1',comparison:'',decision:'accept',q:'q1',a:'v1a1'},
 {id:'c1',comparison:'長'.repeat(121),decision:'accept',q:'q1',a:'v1a1'},
 {id:'c1',comparison:'対象が異なるため採用しない',decision:'reject',q:'q1',a:'v1a1'},
 {id:'c1',comparison:'教員の長時間労働に対して支援員を配置する答弁',decision:'bogus',q:'q1',a:'v1a1'},
 {id:'c1',comparison:'教員の長時間労働に対して支援員を配置する答弁',decision:'accept',q:'q1',a:42},
 {id:'c1',comparison:'教員の長時間労働に対して支援員を配置する答弁',decision:'accept',q:'q1',a:'v1a1',extra:'x'},
 ['c1','accept','q1','v1a1','same'],
 {id:'c1',decision:'accept',question_part:'q1',answer_part:'v1a1',reason:'old format'},
]) {
 const malformed=await reviewCompactAssignments('教員の長時間労働について',result([row('shape:q1')]),{...env,AI:{run:async()=>({response:{reviews:[bad]}})}});
 assert.equal(malformed.pairs,0,'Invalid compact output cannot create accepted evidence');
 assert.equal(malformed.uncertain_candidates,1);
}
const coded=await reviewCompactAssignments('教員の長時間労働について',result([row('code:q1'),row('code:q2')]),{...env,AI:{run:async()=>({response:{reviews:[{id:'c1',beneficiary:'一般労働者',activity:'一般就労',relation:'different',comparison:'対象とする政策活動の範囲が異なる',decision:'reject',q:'',a:''},{id:'c2',beneficiary:'不明',activity:'不明',relation:'unclear',comparison:'原文の文脈が不足し対応を判断できない',decision:'uncertain',q:'',a:''}]}})}});
assert.equal(coded.rejected_candidates,1);assert.equal(coded.uncertain_candidates,1);assert.equal(coded.pairs,0);
assert.equal(coded.review_candidates[0].review_reason,'原文の文脈が不足し対応を判断できない');
const forged=await reviewCompactAssignments('教員の長時間労働について',result([row('bad:q1')]),{...env,AI:{run:async(_,p)=>{
 const rs=reviews(JSON.parse(p.messages[1].content));rs[0].id='unknown';return {response:{reviews:rs}};
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

// Missing literal wording triggers a bounded semantic check, not rejection.
const synonym={...row('scope:synonym'),question:'教師の勤務負担を減らすには。',answer:'学校の先生の業務負担を軽減するため支援員を配置します。'};
const general={...row('scope:general','厚生労働省'),question:'働く人全般の長時間労働をどう減らすか。',answer:'労働者全般への監督指導を徹底します。'};
let scopeCalls=0;
const scopeEnv={...env,AI:{run:async(_,p)=>{
 scopeCalls++;const input=JSON.parse(p.messages[1].content),rs=reviews(input);
 if(p.messages[0].content.includes('この判定は')) {
  assert.ok(input.candidates.length<=8);
  for(const r of rs) if(JSON.stringify(input.candidates.find(c=>c.id===r.id)).includes('労働者全般')) Object.assign(r,{comparison:'労働者一般の施策で学校の勤務との対応が原文にない',decision:'reject',q:'',a:''});
 }
 return {response:{reviews:rs}};
}}};
const scoped=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result([synonym,general]),scopeEnv);
assert.equal(scopeCalls,2);assert.equal(scoped.pairs,1);assert.equal(scoped.rejected_candidates,1);
assert.equal(scoped.evidence[0].case_id,synonym.case_id,'Synonyms remain eligible despite missing literal wording');
assert.equal(scoped.reviewed_candidates,2,'Scope verification does not double-count candidates');
assert.equal(scoped.review_model_calls,2);assert.equal(scoped.review_diagnostics.at(-1).output_format,'scope_check_v2');
let boundedCalls=0;
const bounded=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result(Array.from({length:24},(_,i)=>({...synonym,case_id:'scope:'+i}))),{...env,AI:{run:async(_,p)=>{boundedCalls++;return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};}}});
assert.equal(boundedCalls,4);assert.equal(bounded.pairs,8);assert.equal(bounded.uncertain_candidates,16,'Beyond one extra scope batch stays pending');
let smallScopeCalls=0;
const smallScope=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result(Array.from({length:24},(_,i)=>({...synonym,case_id:'small-scope:'+i}))),{...env,REVIEW_BATCH_SIZE:'4',AI:{run:async(_,p)=>{
 smallScopeCalls++;return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};
}}});
assert.equal(smallScopeCalls,7);assert.equal(smallScope.review_diagnostics.at(-1).expected,8,'Scope still uses at most one request');
assert.equal(smallScope.pairs,8);assert.equal(smallScope.uncertain_candidates,16);
let failedScopeCalls=0;
const failedScope=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result([synonym]),{...env,AI:{run:async(_,p)=>{
 failedScopeCalls++;if(p.messages[0].content.includes('この判定は'))throw new Error('timeout');
 return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};
}}});
assert.equal(failedScopeCalls,2);assert.equal(failedScope.pairs,0);assert.equal(failedScope.uncertain_candidates,1);assert.equal(failedScope.assessment_partial,true);

let boundaryCalls=0;
const boundary=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result([row('boundary:q1')]),{...env,AI:{run:async(_,p)=>{
 boundaryCalls++;const rs=reviews(JSON.parse(p.messages[1].content));
 if(!p.messages[0].content.includes('この判定は'))Object.assign(rs[0],{comparison:'最初の判定では措置の対象が異なると判断',decision:'reject',q:'',a:''});
 return {response:{reviews:rs}};
}}});
assert.equal(boundaryCalls,1,'High lexical relevance does not trigger a second generation for a completed rejection');
assert.equal(boundary.pairs,0);assert.equal(boundary.rejected_candidates,1);
assert.equal(boundary.reviewed_candidates,1);assert.equal(boundary.uncertain_candidates,0);

// A target appearing as a provider in the source must not suppress the role
// check when the extracted beneficiary/activity describes another group.
let providerCalls=0;
const providerOnly={...row('provider:q1'),question:'研究者が作ったサービスで地域の子育てを支援するには。',answer:'一般住民の育児相談を支援します。'};
const providerChecked=await reviewCompactAssignments('研究者の育児と研究の両立支援について',result([providerOnly]),{...env,AI:{run:async(_,p)=>{
 providerCalls++;const rs=reviews(JSON.parse(p.messages[1].content));
 Object.assign(rs[0],{beneficiary:'一般住民',activity:'地域での子育て'});
 if(p.messages[0].content.includes('この判定は')) Object.assign(rs[0],{relation:'provider_only',decision:'reject',q:'',a:''});
 return {response:{reviews:rs}};
}}});
assert.equal(providerCalls,2);assert.equal(providerChecked.pairs,0);assert.equal(providerChecked.rejected_candidates,1);

// Even an incorrect generated role label cannot suppress verification when
// the selected original evidence does not establish the requested target.
let quoteCalls=0;
const quoteOnly={...row('quote:q1'),question:'一般住民への支援は。研究者のサービスも紹介してください。',answer:'一般住民の育児相談を支援します。研究者が提供するサービスです。'};
const quoteChecked=await reviewCompactAssignments('研究者の育児と研究の両立支援について',result([quoteOnly]),{...env,AI:{run:async(_,p)=>{
 quoteCalls++;const rs=reviews(JSON.parse(p.messages[1].content));
 Object.assign(rs[0],{beneficiary:'研究者',activity:'研究活動'});
 if(p.messages[0].content.includes('この判定は')) Object.assign(rs[0],{relation:'provider_only',decision:'reject',q:'',a:''});
 return {response:{reviews:rs}};
}}});
assert.equal(quoteCalls,2);assert.equal(quoteChecked.pairs,0,'Generated roles never replace original target evidence');

// A permissive decision cannot override an explicit mismatch in source roles.
for(const relation of ['broader','provider_only','different','unclear']) {
 const guarded=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result([row('role:'+relation)]),{...env,AI:{run:async(_,p)=>{
  const rs=reviews(JSON.parse(p.messages[1].content));rs[0].relation=relation;
  return {response:{reviews:rs}};
 }}});
 assert.equal(guarded.pairs,0,'Only the same beneficiary/activity relation may enter the shares');
 assert.equal(relation==='unclear'?guarded.uncertain_candidates:guarded.rejected_candidates,1);
}

const shortReject=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result([row('short:reject')]),{...env,AI:{run:async(_,p)=>{
 const rs=reviews(JSON.parse(p.messages[1].content));Object.assign(rs[0],{beneficiary:'',activity:'',comparison:'対象外',relation:'different',decision:'reject'});
 return {response:{reviews:rs}};
}}});
assert.equal(shortReject.pairs,0);assert.equal(shortReject.rejected_candidates,1);assert.equal(shortReject.uncertain_candidates,0,'Unused metadata and refs do not invalidate rejection');
for(const field of ['beneficiary','activity','comparison','q','a']) {
 const missingAccept=await reviewCompactAssignments('教員の長時間労働を是正するための対策',result([row('missing:'+field)]),{...env,AI:{run:async(_,p)=>{
  const rs=reviews(JSON.parse(p.messages[1].content));rs[0][field]='';return {response:{reviews:rs}};
 }}});
 assert.equal(missingAccept.pairs,0);assert.equal(missingAccept.uncertain_candidates,1,'Accepted evidence still requires '+field);
}

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
  if(p.response_format.json_schema?.properties.queries){planning++;return {response:{queries:['教師 勤務時間','教員 負担']}};}
  return {response:{reviews:reviews(JSON.parse(p.messages[1].content))}};
 }}};
 const fallback=await (await worker.fetch(new Request('https://example.invalid/api/cases?'+new URLSearchParams({question:'教師の勤務改善を頑張るべきではないか'})),fallbackEnv)).json();
 assert.equal(planning,1);assert.equal(fallback.retrieval_rounds,2);assert.equal(fallback.pairs,1);
} finally {globalThis.fetch=previousFetch;Date.now=previousNow;}
console.log('Compact review: 24 distinct candidates, concurrent batches, exact source references, repeated-answer selection, partial failure, direct search and cache checks passed.');
