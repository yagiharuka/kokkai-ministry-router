import assert from 'node:assert/strict';
import { prepareSemanticPlan, reviewAssignments } from '../worker/semantic-review.mjs';
import { makePlan, reviewCandidates, retrieveAssignments, summarize } from '../worker/routing-core.mjs';
import worker from '../worker/model-api.js';

const env = { OPENAI_API_KEY: 'test-only-not-a-real-key', OPENAI_ROUTER_MODEL: 'test-model' };
const row = (caseId, ministry, suffix = '', question = '教員の負担を減らすにはどうしますか。', answer = '教師の時間外在校等時間を縮減します。') => ({ case_id: caseId, ministry, question, answer, position: ministry + '大臣', date: '2025-06-10', url: 'https://kokkai.ndl.go.jp/txt/fixture/' + caseId + suffix, screening: 'unverified' });
const rows = [row('q1','文部科学省','a'),row('q1','文部科学省','b'),row('q1','内閣府・内閣官房等'),row('q2','文部科学省'),row('q3','厚生労働省')];
const result = { shares: [{ ministry: '厚生労働省', percent: 100 }], pairs: 1, evidence: rows, candidates: [], review_candidates: rows, recent_since: '2024-01-01' };
const response = data => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] });
const accept = (id, r) => ({ id, decision: 'accept', reason: '教員の勤務負担を減らす方策に答えている。', question_evidence: r.question, answer_evidence: r.answer });
const decisions = rows.map((r, i) => i < 4 ? accept('c' + (i + 1), r) : { id: 'c5', decision: 'reject', reason: '別分野への答弁。', question_evidence: '', answer_evidence: '' });
let calls = 0;
const mock = async (url, init) => {
  calls++;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.headers.Authorization, 'Bearer ' + env.OPENAI_API_KEY);
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.ok(!JSON.stringify(body.input).includes('retrieval_score'));
  assert.ok(!('previous_response_id' in body));
  return response({ reviews: decisions });
};
const judged = await reviewAssignments('教員の長時間労働を是正すべきではないか', result, env, mock);
assert.equal(calls, 1);
assert.equal(judged.assessment_status, 'reviewed');
assert.equal(judged.pairs, 2);
assert.deepEqual(judged.shares.map(s => [s.ministry,s.percent,s.count]), [['文部科学省',75,2],['内閣府・内閣官房等',25,1]]);
assert.ok(judged.evidence.every(e => e.screening === 'accept' && e.review_reason && rows.some(r => r.url === e.url && r.ministry === e.ministry)));
assert.equal(judged.accepted_candidates,4);
assert.equal(judged.rejected_candidates,1);

const unavailable = await reviewAssignments('教員の負担を減らすべきではないか', result, {}, async () => { throw new Error('must not call provider'); });
assert.equal(unavailable.assessment_status,'not_configured');
assert.deepEqual(unavailable.shares,[]);
assert.equal(unavailable.pairs,0);
assert.equal(unavailable.evidence.length,0);
assert.equal(unavailable.review_candidates.length,5);

for (const invalid of [
  { reviews: [...decisions.slice(0,4), { ...decisions[4],id:'invented' }] },
  { reviews: [...decisions.slice(0,4), { ...decisions[4],id:'c1' }] },
  { reviews: decisions.slice(0,4) },
  { reviews: decisions.map((r,i)=>i ? r : { ...r, ministry:'厚生労働省' }) },
  { reviews: decisions.map((r,i)=>i ? r : { ...r, reason:'' }) },
]) {
  const bad = await reviewAssignments('教員の長時間労働を是正すべきではないか',result,env,async()=>response(invalid));
  assert.equal(bad.assessment_status,'failed');
  assert.deepEqual(bad.shares,[]);
  assert.equal(bad.evidence.length,0);
}
const ungrounded = await reviewAssignments('教員の長時間労働を是正すべきではないか',result,env,async()=>response({reviews:decisions.map((r,i)=>i?r:{...r,question_evidence:'利用者の質問案を誤って引用'})}));
assert.equal(ungrounded.assessment_status,'reviewed');
assert.equal(ungrounded.accepted_candidates,3);
assert.equal(ungrounded.uncertain_candidates,1);
assert.equal(ungrounded.review_candidates[0].candidate_id,'c1');
assert.ok(!ungrounded.candidates.some(r=>r.url===rows[0].url));
const wrapped = await reviewAssignments('教員の長時間労働を是正すべきではないか',result,env,async()=>response({reviews:decisions.map(r=>({...r,question_evidence:r.question_evidence?'「'+r.question_evidence+'」':'',answer_evidence:r.answer_evidence?'“'+r.answer_evidence+'”':''}))}));
assert.equal(wrapped.assessment_status,'reviewed');
assert.equal(wrapped.accepted_candidates,4);
assert.equal(wrapped.evidence[0].question_evidence,rows[0].question);
for (const provider of [
  async()=>new Response('secret provider detail',{status:429}),
  async()=>{throw new Error('sensitive network detail');},
  async()=>Response.json({status:'incomplete',output:[]}),
  async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'not processing'}]}]}),
  async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'not JSON'}]}]}),
]) {
  const failed = await reviewAssignments('教員の負担を減らすべきではないか',result,env,provider);
  assert.equal(failed.assessment_status,'failed');
  assert.deepEqual(failed.shares,[]);
  assert.ok(!JSON.stringify(failed).includes('secret provider detail'));
  assert.ok(!JSON.stringify(failed).includes('sensitive network detail'));
}
const uncertain = await reviewAssignments('教員の負担を減らすべきではないか',result,env,async()=>response({reviews:decisions.map(r=>({...r,decision:'uncertain',reason:'抜粋が不足している。',question_evidence:'',answer_evidence:''}))}));
assert.equal(uncertain.assessment_status,'reviewed');
assert.equal(uncertain.uncertain_candidates,5);
assert.deepEqual(uncertain.shares,[]);
const rejected = await reviewAssignments('教員の負担を減らすべきではないか',result,env,async()=>response({reviews:decisions.map(r=>({...r,decision:'reject',question_evidence:'',answer_evidence:''}))}));
assert.equal(rejected.rejected_candidates,5);
assert.equal(rejected.review_candidates.length,0);

const question = '教員の長時間労働を是正すべきではないか';
const prepared = await prepareSemanticPlan(question,env,async()=>response({queries:['教員 働き方改革','教師 勤務時間']}));
assert.equal(prepared.status,'ready');
assert.equal(prepared.plan.question,question);
assert.ok(prepared.plan.recall_groups.some(g=>g.text==='教師'));
for(const queries of [['教師'],['教師','教師'],['教師','https://example.com'],['教師',123]]) {
  assert.equal((await prepareSemanticPlan(question,env,async()=>response({queries}))).status,'failed');
}
const noPlan = await prepareSemanticPlan(question,{},async()=>{throw new Error('must not call');});
assert.equal(noPlan.status,'not_configured');
assert.equal((await reviewAssignments(question,result,env,async()=>{throw new Error('must not call');},'failed')).assessment_status,'failed');

const meeting = {issueID:'recalled',date:'2025-05-01',nameOfMeeting:'文教委員会',speechRecord:[
  {speechID:'q',speechOrder:1,speakerGroup:'会派',speech:'教師の働き方改革をどう進めますか。',speechURL:'https://kokkai.ndl.go.jp/txt/fixture/q'},
  {speechID:'a',speechOrder:2,speakerPosition:'文部科学大臣',speech:'支援員の配置によって勤務時間を減らします。',speechURL:'https://kokkai.ndl.go.jp/txt/fixture/a'},
]};
const requests = [];
const fetched = await retrieveAssignments(prepared.plan,async(path,p)=>{
  requests.push({path,...p});
  return path==='meeting'?{meetingRecord:[meeting]}:{speechRecord:p.from==='2025-01-01'?meeting.speechRecord.map(s=>({...s,issueID:meeting.issueID})):[]};
});
assert.ok(requests.length<=14);
assert.ok(requests.some(p=>p.path==='meeting'));
assert.equal(fetched.review_candidates[0].ministry,'文部科学省');
assert.equal(fetched.review_candidates[0].screening,'unverified');
const repeated = {...meeting,speechRecord:[...meeting.speechRecord,{...meeting.speechRecord[1],speechID:'b',speechOrder:3,speechURL:'https://kokkai.ndl.go.jp/txt/fixture/b'}]};
assert.equal(reviewCandidates([repeated],prepared.plan).length,2);
assert.equal(summarize(reviewCandidates([repeated],prepared.plan)).shares[0].count,1);
assert.equal((await reviewAssignments(question,{...result,candidates:[],review_candidates:[]},env,async()=>{throw new Error('must not call');})).assessment_status,'no_candidates');
const realFetch=globalThis.fetch,realNow=Date.now;let now=realNow(),modelCalls=0;
Date.now=()=>{now+=3001;return now;};
globalThis.fetch=async(url,init)=>{
  if(String(url)==='https://api.openai.com/v1/responses') {
    modelCalls++;
    const body=JSON.parse(init.body);
    if(body.text.format.name==='kokkai_search_plan')return response({queries:['教員 働き方改革','教師 勤務時間']});
    const input=JSON.parse(body.input[0].content);
    assert.equal(input.proposed_question,question);
    return response({reviews:input.candidates.map(c=>({id:c.id,decision:'accept',reason:'教員の勤務負担を減らす方策への答弁。',question_evidence:c.source_question,answer_evidence:c.source_answer}))});
  }
  const target=new URL(url);
  assert.equal(target.origin,'https://kokkai.ndl.go.jp');
  return Response.json(target.pathname.endsWith('/meeting')?{meetingRecord:[meeting]}:{speechRecord:target.searchParams.get('from')==='2025-01-01'?meeting.speechRecord.map(s=>({...s,issueID:meeting.issueID})):[]});
};
try {
  const request=new Request('https://example.invalid/api/cases?'+new URLSearchParams({question}));
  const live=await worker.fetch(request,env),data=await live.json();
  assert.equal(live.status,200);
  assert.equal(data.assessment_status,'reviewed');
  assert.equal(data.shares[0].ministry,'文部科学省');
  assert.equal(data.pairs,1);
  assert.equal(modelCalls,2);
  assert.ok(!JSON.stringify(data).includes(env.OPENAI_API_KEY));
  await worker.fetch(request,env);
  assert.equal(modelCalls,2,'Cached requests must not spend more model calls');
  const status=await (await worker.fetch(new Request('https://example.invalid/api/status'),{})).json();
  assert.equal(status.model_ready,false);
  const offTopic={...meeting,issueID:'off-topic',speechRecord:[
    {...meeting.speechRecord[0],speech:'医療機器の法制度に関連して、ワクチンの評価について伺います。'},
    {...meeting.speechRecord[1],speakerPosition:'厚生労働大臣',speech:'ワクチンの品質、安全性を確認します。'},
  ]};
  const onTopic={...meeting,issueID:'on-topic',speechRecord:[
    {...meeting.speechRecord[0],speech:'医療機器の審査期間を短縮できるでしょうか。'},
    {...meeting.speechRecord[1],speakerPosition:'厚生労働大臣',speech:'医療機器の承認審査に専門人材を増やし、審査期間を短縮します。'},
  ]};
  let retryModelCalls=0,ndlCalls=0;
  globalThis.fetch=async(url,init)=>{
    if(String(url)==='https://api.openai.com/v1/responses') {
      retryModelCalls++;
      const body=JSON.parse(init.body);
      if(body.text.format.name==='kokkai_search_plan') {
        const input=JSON.parse(body.input[0].content);
        if(retryModelCalls===1)return response({queries:['医療機器 薬事承認','医療機器 承認審査','医療機器 審査期間']});
        assert.ok(input.search_feedback.searched_queries.length);
        assert.ok(input.search_feedback.rejected_reasons.length);
        return response({queries:['医療機器 審査期間','医療機器']});
      }
      const input=JSON.parse(body.input[0].content);
      return response({reviews:input.candidates.map(c=>({id:c.id,decision:c.source_answer.includes('審査期間')?'accept':'reject',reason:'審査期間の短縮という問いに対応するかで確認。',question_evidence:c.source_question,answer_evidence:c.source_answer}))});
    }
    ndlCalls++;
    const target=new URL(url),query=target.searchParams.get('any')||'';
    const m=query.includes('審査期間')||query==='医療機器'?onTopic:offTopic;
    return Response.json(target.pathname.endsWith('/meeting')?{meetingRecord:[target.searchParams.get('issueID')==='on-topic'?onTopic:offTopic]}:{speechRecord:target.searchParams.get('from')==='2025-01-01'?m.speechRecord.map(s=>({...s,issueID:m.issueID})):[]});
  };
  const retried=await (await worker.fetch(new Request('https://example.invalid/api/cases?'+new URLSearchParams({question:'医療機器の承認審査を迅速化すべきではないか'})),env)).json();
  assert.equal(retried.retrieval_rounds,2);
  assert.equal(retried.assessment_status,'reviewed');
  assert.equal(retried.shares[0].ministry,'厚生労働省');
  assert.equal(retried.pairs,1);
  assert.equal(retryModelCalls,4);
  assert.ok(ndlCalls<=24);
  assert.equal(retried.requests_used,ndlCalls);
}finally{globalThis.fetch=realFetch;Date.now=realNow;}
console.log('Semantic adapter protocol, immutable evidence, deduplication, recall, public request path and failure handling checks passed. Mock responses do not measure model accuracy.');
