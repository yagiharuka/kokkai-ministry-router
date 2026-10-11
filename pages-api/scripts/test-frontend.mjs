import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const nodes = new Map();
const getNode = id => {if(!nodes.has(id))nodes.set(id,{hidden:true,innerHTML:'',attributes:{},listeners:{},setAttribute(name,value){this.attributes[name]=value},addEventListener(name,fn){this.listeners[name]=fn}});return nodes.get(id);};
const context = vm.createContext({document:{getElementById:getNode},Intl,AbortController,setTimeout,clearTimeout,URLSearchParams});
vm.runInContext(await readFile(new URL('../frontend/app.js',import.meta.url),'utf8'),context);
const item={ministry:'文部科学省',question:'教員の負担を減らすにはどうしますか。',answer:'支援員を配置します。',date:'2025-06-10',meeting:'委員会',speaker:'答弁者',position:'文部科学大臣',url:'https://kokkai.ndl.go.jp/txt/fixture/a',review_reason:'<script>alert(1)</script>'};
const base={shares:[{ministry:'文部科学省',percent:100,count:1}],pairs:1,evidence:[item],review_candidates:[item],laws:[]};
const render = result => {context.result=result;vm.runInContext('render(result)',context);return getNode('results').innerHTML;};
for(const status of [undefined,'not_configured','failed','no_candidates']) {
  const html=render({...base,assessment_status:status});
  assert.ok(!html.includes('100%'),'Unreviewed legacy or failed results must never appear as judged shares');
  assert.ok(!html.includes('採用した質疑'));
}
const accepted=render({...base,assessment_status:'reviewed',review_candidates:[]});
assert.ok(accepted.includes('100%'));
assert.ok(accepted.includes('採用した質疑'));
assert.ok(accepted.includes('&lt;script&gt;'));
assert.ok(!accepted.includes('<script>'));
const cached=render({...base,assessment_status:'reviewed',review_candidates:[],analysis_cache_hit:true,analyzed_at:'2026-10-10T04:00:00.000Z'});
assert.ok(cached.includes('保存済みの結果'));
assert.ok(cached.includes('13:00'));
assert.ok(cached.includes('最大24時間'));
assert.doesNotThrow(()=>render({...base,assessment_status:'reviewed',analysis_cache_hit:true,analyzed_at:'invalid'}));
const rejected=render({...base,assessment_status:'reviewed',shares:[],pairs:0,evidence:[],review_candidates:[],reviewed_candidates:12});
assert.ok(rejected.includes('12件の候補を確認'));
assert.ok(!rejected.includes('100%'));
assert.ok(!rejected.includes('会議録が存在しない'));
const quota=render({...base,assessment_status:'failed',assessment_error:'quota_exhausted',review_candidates:[]});
assert.ok(quota.includes('AI判定の本日の無料枠を使い切りました'));
assert.ok(!quota.includes('100%'));
assert.ok(quota.includes('国会図書館のAPIではなく'));
assert.ok(!quota.includes('候補 0件'));
const setup = render({...base,assessment_status:'not_configured',review_candidates:[]});
assert.ok(setup.includes('自動判定の接続を準備しています'));
assert.ok(!setup.includes('候補 0件'));
assert.ok(!setup.includes('ChatGPTに貼り付け'));
assert.ok(!setup.includes('100%'));
const timing={retrieval_ms:12345,review_ms:23456,total_ms:35801};
const timedBase={...base,assessment_status:'reviewed',review_candidates:[],elapsedSeconds:37,timing,original_timing:timing};
const occurrences=(html,text)=>html.split(text).length-1;
const freshTiming=render(timedBase);
assert.ok(freshTiming.includes('会議録検索 12.3秒 · AI判定 23.5秒 · 合計 35.8秒'));
assert.ok(freshTiming.includes(' · 37秒'));
assert.equal(occurrences(freshTiming,'data-stage-timing="current"'),1);
assert.ok(!freshTiming.includes('元の分析時間'));
assert.ok(!freshTiming.includes('retrieval_ms'));
assert.ok(!freshTiming.includes('review_ms'));
assert.ok(!freshTiming.includes('total_ms'));
assert.equal(render(timedBase),freshTiming,'Rendering the same result again must not append duplicate timings');
for(const status of ['failed','no_candidates']){
  const html=render({...timedBase,assessment_status:status});
  assert.ok(html.includes('会議録検索 12.3秒'));
  assert.ok(html.includes('AI判定 23.5秒'));
  assert.ok(!html.includes('100%'));
}
const cachedTiming=render({...timedBase,analysis_cache_hit:true,timing:{total_ms:125,cached:true},elapsedSeconds:2,analyzed_at:'2026-10-10T04:00:00.000Z'});
assert.ok(cachedTiming.includes('今回の表示待ち：2秒（保存済みの結果）'));
assert.ok(cachedTiming.includes('元の分析時間：会議録検索 12.3秒 · AI判定 23.5秒 · 合計 35.8秒'));
assert.equal(occurrences(cachedTiming,'2秒'),1,'Client wait should appear only once for a cache hit');
assert.equal(occurrences(cachedTiming,'会議録検索'),1);
assert.equal(occurrences(cachedTiming,'AI判定'),1);
assert.equal(occurrences(cachedTiming,'data-stage-timing="current"'),1);
assert.equal(occurrences(cachedTiming,'data-stage-timing="original"'),1);
assert.ok(cachedTiming.includes('13:00'));
assert.ok(cachedTiming.includes('最大24時間'));
const apiWait=render({...timedBase,analysis_cache_hit:true,elapsedSeconds:undefined,timing:{total_ms:125,cached:true}});
assert.ok(apiWait.includes('今回の処理時間：0.1秒（保存済みの結果）'));
const cachedFlagOnly=render({...timedBase,elapsedSeconds:undefined,timing:{...timing,total_ms:30,cached:true},original_timing:undefined});
assert.ok(cachedFlagOnly.includes('今回の処理時間：0.1秒未満（保存済みの結果）'));
assert.ok(!cachedFlagOnly.includes('会議録検索'),'Cache-stage numbers must never be presented as a new analysis');
assert.ok(!cachedFlagOnly.includes('AI判定'));
assert.ok(!cachedFlagOnly.includes('元の分析時間'));
const legacyFresh=render({...base,assessment_status:'reviewed',elapsedSeconds:37});
assert.ok(legacyFresh.includes(' · 37秒'));
assert.ok(!legacyFresh.includes('data-stage-timing'));
const legacyCached=render({...base,assessment_status:'reviewed',analysis_cache_hit:true,elapsedSeconds:2,analyzed_at:'invalid'});
assert.ok(legacyCached.includes('保存済みの結果を表示しています'));
assert.ok(legacyCached.includes('今回の表示待ち：2秒'));
assert.ok(!legacyCached.includes('元の分析時間'));
for(const malformed of [null,undefined,[],[timing],true,12,'<img src=x onerror=alert(1)>']){
  const html=render({...base,assessment_status:'reviewed',timing:malformed,original_timing:malformed});
  assert.ok(!html.includes('data-stage-timing'));
  assert.ok(!html.includes('<img'));
}
for(const invalid of [-1,NaN,Infinity,-Infinity,'12','<script>alert(2)</script>',null,undefined,{},[]]){
  const html=render({...base,assessment_status:'reviewed',elapsedSeconds:invalid,timing:{retrieval_ms:invalid,review_ms:invalid,total_ms:invalid}});
  assert.ok(!html.includes('data-stage-timing'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('Infinity'));
  assert.ok(!html.includes('<script>'));
  const invalidCache=render({...base,assessment_status:'reviewed',analysis_cache_hit:true,elapsedSeconds:invalid,timing:{cached:true,total_ms:invalid},original_timing:{retrieval_ms:invalid,review_ms:invalid,total_ms:invalid}});
  assert.ok(!invalidCache.includes('data-stage-timing'));
}
const partialTiming=render({...base,assessment_status:'no_candidates',timing:{retrieval_ms:1000,review_ms:'invalid',total_ms:1200}});
assert.ok(partialTiming.includes('会議録検索 1.0秒 · 合計 1.2秒'));
assert.ok(!partialTiming.includes('AI判定'));
const zeroTiming=render({...base,assessment_status:'failed',timing:{retrieval_ms:0,review_ms:0,total_ms:0}});
assert.ok(zeroTiming.includes('会議録検索 0.0秒 · AI判定 0.0秒 · 合計 0.0秒'));
const invalidOriginal=render({...timedBase,analysis_cache_hit:true,original_timing:{...timing,cached:true},timing:{total_ms:200,cached:true}});
assert.ok(!invalidOriginal.includes('元の分析時間'),'A cached response duration is not an original analysis');
// Slow supplementary law searches must not block the result, and an earlier
// question's delayed laws must never overwrite a later question's references.
const laws=[],caseRequests=[];
context.fetch=async url=>{
  if(String(url).includes('jurisdiction?'))return new Promise(resolve=>laws.push(resolve));
  caseRequests.push(new URL(url));
  return Response.json({...timedBase,timing:{...timing,total_ms:35801+caseRequests.length*1000}});
};
const submit=async question=>{
  getNode('question').value=question;
  await Promise.race([
    getNode('form').listeners.submit({preventDefault(){}}),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('Law request blocked the main result')),100)),
  ]);
};
await submit('教員の長時間労働を是正すべきではないか');
assert.equal(getNode('submit').disabled,false);
assert.ok(getNode('results').innerHTML.includes('100%'));
await submit('半導体産業の国内生産を支援すべきではないか');
assert.equal(caseRequests.length,2);
assert.ok(caseRequests.every(url=>url.searchParams.get('v')==='20261011-44'));
assert.equal(caseRequests[1].searchParams.get('question'),'半導体産業の国内生産を支援すべきではないか');
const latestHtml=getNode('results').innerHTML;
assert.ok(latestHtml.includes('合計 37.8秒'));
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
laws[0](Response.json({matches:[{ministry:'以前の検索',title:'旧法令',snippet:'old',url:'https://laws.e-gov.go.jp/law/old'}]}));
await flush();
assert.ok(!getNode('law-results').innerHTML.includes('以前の検索'));
assert.equal(getNode('results').innerHTML,latestHtml,'Stale laws must not replace or duplicate the latest result timings');
laws[1](Response.json({matches:[{ministry:'経済産業省',title:'経済産業省設置法',snippet:'新しい検索',url:'https://laws.e-gov.go.jp/law/new'}]}));
await flush();
assert.ok(getNode('law-results').innerHTML.includes('新しい検索'));
assert.equal(getNode('results').innerHTML,latestHtml,'Supplementary laws must not replace or duplicate main result timings');
// Browser HTTP caching must not reuse a fresh response as though its original
// analysis had just run again. The server still owns exact-question reuse.
const repeatedRequests=[],lawOptions=[];
context.fetch=async (url,options)=>{
  if(String(url).includes('jurisdiction?')){
    lawOptions.push(options);
    return Response.json({matches:[]});
  }
  repeatedRequests.push({url:String(url),options});
  return Response.json(repeatedRequests.length===1?timedBase:{...timedBase,analysis_cache_hit:true,timing:{total_ms:125,cached:true},original_timing:timing});
};
const repeatQuestion='教員の長時間労働を是正すべきではないか';
await submit(repeatQuestion);
assert.ok(getNode('results').innerHTML.includes('処理時間：会議録検索'));
assert.ok(!getNode('results').innerHTML.includes('元の分析時間'));
await submit(repeatQuestion);
assert.equal(repeatedRequests.length,2);
assert.equal(repeatedRequests[0].url,repeatedRequests[1].url);
assert.ok(repeatedRequests.every(({options})=>options.cache==='no-store'));
assert.ok(repeatedRequests.every(({options})=>options.signal instanceof AbortSignal&&!options.signal.aborted));
assert.notEqual(repeatedRequests[0].options.signal,repeatedRequests[1].options.signal);
assert.equal(lawOptions.length,2);
assert.ok(lawOptions.every(options=>options.cache===undefined&&options.signal instanceof AbortSignal),'Law requests must retain their existing fetch behavior');
const repeatedHtml=getNode('results').innerHTML;
assert.ok(repeatedHtml.includes('今回の表示待ち：'));
assert.ok(repeatedHtml.includes('元の分析時間：会議録検索 12.3秒 · AI判定 23.5秒 · 合計 35.8秒'));
assert.ok(!repeatedHtml.includes('処理時間：会議録検索'));
assert.equal(occurrences(repeatedHtml,'会議録検索'),1);
// Fetch options must not replace the timeout-controlled AbortSignal.
const suppliedSignal=new AbortController().signal;
context.suppliedSignal=suppliedSignal;
context.fetch=(_url,options)=>new Promise((_resolve,reject)=>{
  assert.equal(options.cache,'no-store');
  assert.notEqual(options.signal,suppliedSignal);
  options.signal.addEventListener('abort',()=>reject(new Error('fixture timeout')),{once:true});
});
await assert.rejects(vm.runInContext('getJson("fixture",1,{cache:"no-store",signal:suppliedSignal})',context),/fixture timeout/);
console.log('Frontend assessment states, fresh/cached/legacy timing, malformed timing validation, escaping, browser-cache bypass, request timeout, nonblocking law lookup and stale-result isolation checks passed.');

