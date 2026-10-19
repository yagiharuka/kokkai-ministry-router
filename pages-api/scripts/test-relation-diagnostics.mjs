// Numeric-only diagnostics for invalid enum values. No model or network calls.
// Synthetic response mutations below are NOT the seven observed live values.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as routing from '../worker/routing-core.mjs';
import { runCacheWrite } from '../worker/background-cache.mjs';

const source = await readFile(new URL('../worker/semantic-review.mjs', import.meta.url), 'utf8');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
const keys = ['blank','surrounding_whitespace','letter_case','decision_code','other'];
const plain = value => JSON.parse(JSON.stringify(value));
const rows = Array.from({length:24}, (_,i) => ({
  case_id:'relation-fixture:'+i, ministry:'文部科学省', position:'文部科学大臣',
  meeting:'文教委員会', date:'2026-05-01', retrieval_score:1,
  question:'教員の勤務時間を減らすにはどうしますか。',
  answer:`教員の負担を減らすため支援員を配置します。合成事例${i}です。`,
  url:'https://kokkai.ndl.go.jp/txt/synthetic-relation/'+i,
}));
const base = {review_candidates:rows, recent_since:'2024-01-01', searched:[], errors:[]};
function runtime(sourceText=source) {
  const saved = new Map(), payloads = []; let active=0, peak=0;
  const context = vm.createContext({...routing, runCacheWrite, console, setTimeout, clearTimeout,
    Response, AbortSignal, TextEncoder, crypto:webcrypto,
    fetch() { throw Error('No real network allowed'); },
    caches:{default:{async match(key){return saved.get(key)?.clone();},async put(key,value){saved.set(key,value.clone());}}},
  });
  new vm.Script(sourceText.replace(/^import [^\n]+;\n/gm,'').replace(/^export /gm,'')+
    '\n;globalThis.review=reviewCompactAssignments;').runInContext(context);
  async function run(mutate=()=>{}, scope=false) {
    const expectedCalls=3-saved.size; let entered=0,release;
    const allEntered=new Promise(resolve=>{release=resolve;});
    const result = await context.review('教員の勤務時間を減らすための対策',base,{
      CLOUDFLARE_WORKERS_PLAN:'free',AI:{async run(model,payload){
        payloads.push(JSON.stringify([model,payload])); active++;peak=Math.max(peak,active);
        const input=JSON.parse(payload.messages[1].content);
        assert.equal(model,'@cf/openai/gpt-oss-20b');
        assert.equal(input.candidates.length,8);
        assert.equal(payload.max_tokens,3072);
        assert.equal(payload.reasoning_effort,scope?'low':undefined);
        assert.deepEqual(plain(payload.response_format),{type:'json_object'});
        const reviews=input.candidates.map(c=>{
          const index=Number(Object.values(c.source_answer).join('').match(/合成事例(\d+)/)[1]);
          const question=c.source_question||input.candidates.find(other=>other.id===c.source_question_ref).source_question;
          const review={id:c.id,beneficiary:'教員',activity:'学校の教育業務',relation:'same',
            comparison:'教員の勤務負担軽減について支援員配置を示す答弁',decision:'accept',
            q:Object.keys(question)[0],a:Object.keys(c.source_answer)[0]};
          if(index>=17)mutate(review,index); return review;
        });
        if(++entered===expectedCalls)release();
        await allEntered;active--;
        return {response:{reviews}};
      }},
    },undefined,scope?{scopeCheck:true}:{});
    return plain(result);
  }
  return {run,saved,payloads,get peak(){return peak;}};
}
const values=[
  ['', 'blank'], [' \n\t','blank'],
  ['same ','surrounding_whitespace'], ['\tbroader\n','surrounding_whitespace'],
  ['Same','letter_case'], [' PROVIDER_ONLY ','letter_case'],
  ['accept','decision_code'], ['reject','decision_code'], ['uncertain','decision_code'],
  [' reject ','decision_code'],
  ['unrelated','other'], ['同じ','other'], ['same/different','other'], ['ＳＡＭＥ','other'],
  ['<script>PRIVATE_SENTINEL</script>','other'], ['PRIVATE_SENTINEL_credentiallike12345','other'],
  ['X'.repeat(1000),'other'],
];
for(const [value,category] of values){
  const rt=runtime(),result=await rt.run(row=>{row.relation=value;});
  check('Invalid relation classified as '+category+' without repair ('+checks+')',()=>{
    assert.equal(rt.payloads.length,3);assert.equal(rt.peak,3);
    assert.equal(result.reviewed_candidates,17);assert.equal(result.assessment_partial,true);
    assert.equal(result.uncertain_candidates,7);assert.equal(result.pairs,17);
    assert.deepEqual(result.review_diagnostics.map(d=>d.completed),[8,8,1]);
    assert.equal(result.review_diagnostics[2].validation_failures.invalid_relation,7);
    assert.equal(result.review_diagnostics[2].invalid_fields,7);
    const detail=result.review_diagnostics[2].invalid_relation_details;
    assert.deepEqual(Object.keys(detail),keys);
    assert.equal(detail[category],7);assert.equal(Object.values(detail).reduce((a,b)=>a+b),7);
    assert.equal(result.review_diagnostics[0].invalid_relation_details,undefined);
    assert.equal(rt.saved.size,2,'Invalid third batch must never be cached');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SENTINEL'));
  });
  for(const response of rt.saved.values())assert.ok(!JSON.stringify(await response.clone().json()).includes('PRIVATE_SENTINEL'));
}
const rt=runtime();
const mixed=await rt.run((row,index)=>{row.relation=['','same ','Same','reject','uncertain','PRIVATE_SENTINEL','別対象'][index-17];});
check('Mixed seven failures have exclusive numeric categories',()=>{
  assert.deepEqual(mixed.review_diagnostics[2].invalid_relation_details,
    {blank:1,surrounding_whitespace:1,letter_case:1,decision_code:2,other:2});
});
const before=rt.payloads.length,recovered=await rt.run();
check('Next normal request reuses two valid batches; no automatic retry added',()=>{
  assert.equal(before,3);assert.equal(rt.payloads.length-before,1);
  assert.equal(recovered.reviewed_candidates,24);assert.equal(recovered.review_cache_hits,2);
  assert.equal(recovered.pairs,24);assert.equal(recovered.assessment_partial,undefined);
  assert.ok(recovered.review_diagnostics.every(d=>d.invalid_relation_details===undefined));
});
for(const invalid of [null,0,[],{}]){
  const result=await runtime().run(row=>{row.relation=invalid;});
  check('Non-string relations remain shape failures, not enum observations ('+checks+')',()=>{
    assert.equal(result.reviewed_candidates,17);
    assert.equal(result.review_diagnostics[2].invalid_shape,7);
    assert.equal(result.review_diagnostics[2].invalid_relation_details,undefined);
  });
}
const priority=await runtime().run(row=>{row.relation='invalid';row.comparison='';});
check('Existing validation priority is preserved',()=>{
  assert.equal(priority.review_diagnostics[2].validation_failures.blank_comparison,7);
  assert.equal(priority.review_diagnostics[2].validation_failures.invalid_relation,0);
  assert.equal(priority.review_diagnostics[2].invalid_relation_details,undefined);
});
const scoped=await runtime().run(row=>{row.relation='reject';},true);
check('Additional scope receiver reports the same safe categories',()=>{
  assert.equal(scoped.reviewed_candidates,17);
  assert.ok(scoped.review_diagnostics.every(d=>d.output_format==='scope_json_v3'));
  assert.equal(scoped.review_diagnostics[2].invalid_relation_details.decision_code,7);
});
const baselineIndex=process.argv.indexOf('--baseline');
if(baselineIndex>=0){
  const oldSource=await readFile(process.argv[baselineIndex+1],'utf8');
  const old=runtime(oldSource),next=runtime();
  const a=await old.run(row=>{row.relation='PRIVATE_SENTINEL';});
  const b=await next.run(row=>{row.relation='PRIVATE_SENTINEL';});
  const stable=value=>{value=plain(value);for(const d of value.review_diagnostics){for(const k of ['model_ms','total_ms','started_after_ms','cache_read_ms','invalid_relation_details'])delete d[k];}return value;};
  check('Exact v81 request bytes and all non-diagnostic outcomes are unchanged',()=>{
    assert.deepEqual(next.payloads,old.payloads);assert.deepEqual(stable(b),stable(a));
    assert.deepEqual([...next.saved.keys()],[...old.saved.keys()]);
  });
}
console.log('RELATION_DIAGNOSTICS '+JSON.stringify({checks,external_requests:0,synthetic_completed:17,total_candidates:24,
  live_values_known:false,latency_improvement_measured:false,prompt_changed:false}));
