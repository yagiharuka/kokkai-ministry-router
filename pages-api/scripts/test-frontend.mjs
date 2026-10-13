import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const nodes = new Map();
const getNode = id => {if(!nodes.has(id))nodes.set(id,{hidden:true,innerHTML:'',value:'',attributes:{},listeners:{},setAttribute(name,value){this.attributes[name]=value},addEventListener(name,fn){this.listeners[name]=fn},focus(){this.focused=true},select(){this.selected=true},setSelectionRange(start,end){this.selection=[start,end]}});return nodes.get(id);};
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
assert.ok(caseRequests.every(url=>url.searchParams.get('v')==='20261014-64'));
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
// Diagnostics use only the already received response. No new network, source
// selection, inference or clipboard reads are allowed for this display.
context.fetch=()=>{throw new Error('Diagnostics must not make network requests');};
const diagnostics=[
 {expected:12,completed:12,input_chars:18123,output_token_limit:2560,model_ms:17900,cache_read_ms:8,total_ms:17930,cache_hit:false,model_called:true,usage:{input_tokens:12345,output_tokens:600}},
 {expected:12,completed:12,input_chars:17901,output_token_limit:2560,model_ms:14500,cache_read_ms:5,total_ms:14520,cache_hit:false,model_called:true},
];
const diagnosticBase={...timedBase,routing_version:'20261014-64',analyzed_at:'2026-10-11T13:30:00.000Z',review_diagnostics:diagnostics};
const textFor=result=>{context.result=result;return vm.runInContext('diagnosticText(result,diagnosticRows(result.review_diagnostics))',context)};
assert.ok(textFor({...diagnosticBase,review_diagnostics:[...diagnostics,diagnostics[0]]}).includes('バッチ 3'));
const sevenBatchText=textFor({...diagnosticBase,review_diagnostics:Array(8).fill(diagnostics[0])});
assert.ok(sevenBatchText.includes('バッチ 7'),'Show all six initial calls and one scope call');
assert.ok(!sevenBatchText.includes('バッチ 8'),'Diagnostics remain bounded');
const text=textFor(diagnosticBase),html=render(diagnosticBase);
assert.ok(html.includes('<details class="diagnostics"><summary>詳しい処理時間</summary>'));
assert.ok(html.includes('readonly rows="12"'));
assert.ok(html.includes('type="button" id="diagnostic-copy"'));
assert.ok(text.includes('入力サイズ：18123文字'));
assert.ok(text.includes('入力トークン：12345'));
assert.ok(text.includes('出力トークン：600'));
assert.ok(text.includes('入力トークン：未提供'));
assert.ok(text.includes('AI待ち時間：17900ms'));
assert.ok(text.includes('候補判定は並列'));
assert.ok(text.includes('公開版：20261014-64'));
assert.ok(text.includes('元の分析日時：2026-10-11T13:30:00.000Z'));
assert.ok(html.includes('100%')&&html.includes(item.answer),'Diagnostics must not replace the existing judgment or evidence');
assert.equal(render(diagnosticBase),html,'Repeated render must not duplicate the disclosure');
const poisoned={...diagnosticBase,question:'PRIVATE QUESTION',answer:'PRIVATE ANSWER',api_key:'PRIVATE KEY',routing_version:'PRIVATE VERSION',analyzed_at:'PRIVATE DATE',review_diagnostics:diagnostics.map(row=>({...row,question:'PRIVATE QUESTION',answer:'PRIVATE ANSWER',reason:'PRIVATE REASON',model_output:'PRIVATE OUTPUT',api_key:'PRIVATE KEY',error:'PRIVATE ERROR',usage:{...row.usage,secret:'PRIVATE USAGE'}}))};
const safeText=textFor(poisoned);render(poisoned);
assert.ok(!safeText.includes('PRIVATE'));
assert.ok(!getNode('results').attributes['data-review-diagnostics'].includes('PRIVATE'),'The diagnostic DOM attribute is also allowlisted');
for(const invalid of [-1,NaN,Infinity,-Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'12','</textarea><script>alert(1)</script>',null,undefined,{},[]]){
 const result={...diagnosticBase,review_diagnostics:[{expected:invalid,completed:invalid,input_chars:invalid,model_ms:invalid,total_ms:invalid,output_token_limit:invalid,cache_read_ms:invalid,cache_hit:invalid,model_called:invalid,usage:{input_tokens:invalid,output_tokens:invalid}}]};
 const text=textFor(result),html=render(result);
 assert.ok(text.includes('候補：未提供 / 完了：未提供'));
 assert.ok(text.includes('AI待ち時間：未提供'));
 assert.ok(!text.includes('NaN')&&!text.includes('Infinity'));
 assert.ok(!html.includes('<script>')&&!text.includes('<script>'));
}
const cachedDiagnostics={...diagnosticBase,analysis_cache_hit:true,timing:{total_ms:5,cached:true},review_diagnostics:diagnostics.map(row=>({...row,model_ms:0,total_ms:0,cache_hit:true,model_called:false}))};
const cachedText=textFor(cachedDiagnostics);
assert.ok(cachedText.includes('保存済みの結果を表示'));
assert.ok(cachedText.includes('元の時間は取得できません'));
assert.ok(!cachedText.includes('AI待ち時間：0ms'));
assert.ok(!cachedText.includes('入力トークン：12345'),'Do not present past usage as current usage on cache hits');
assert.ok(!cachedText.includes('キャッシュ読出：0ms'),'Whole-result cache diagnostics do not retain original batch timing');
for(const status of ['failed','reviewed']){
 const cachedFailure={...cachedDiagnostics,assessment_status:status,assessment_partial:true,review_diagnostics:[{expected:12,completed:0,cache_hit:false,model_called:false,model_ms:0,error:'model_timeout'}]};
 const text=textFor(cachedFailure);
 assert.ok(text.includes('保存した診断を表示（今回はAI未実行）'));
 assert.ok(text.includes('完了：0件')&&text.includes('エラー分類：model_timeout'));
 assert.ok(!text.includes('保存した判定を再利用'),'Cached failure diagnostics are not successful reusable judgments');
}
const mixed={...diagnosticBase,review_diagnostics:[{...diagnostics[0],cache_hit:true,model_called:false,model_ms:0},{...diagnostics[1],error:'model_timeout',completed:0}]};
const mixedText=textFor(mixed);
assert.ok(mixedText.includes('バッチ 1：保存した判定を再利用'));
assert.ok(mixedText.includes('バッチ 2：今回AIを実行'));
assert.ok(mixedText.includes('エラー分類：model_timeout'));
assert.ok(!mixedText.includes('入力トークン：12345'));
assert.ok(textFor({...diagnosticBase,review_diagnostics:[{...diagnostics[0],model_ms:0,usage:{input_tokens:0,output_tokens:0}}]}).includes('出力トークン：0'),'A measured zero is not missing data');
assert.ok(textFor({...diagnosticBase,review_diagnostics:[{},{}]}).includes('実行状態は未提供'));
for(const invalid of [null,undefined,{},true,'PRIVATE'])assert.ok(!render({...diagnosticBase,review_diagnostics:invalid}).includes('diagnostic-copy'));
assert.equal(textFor({...diagnosticBase,review_diagnostics:[]}), '');

// Model a newly rendered DOM for each copy test, as innerHTML does in a browser.
const mountDiagnostics=result=>{
 for(const id of ['diagnostic-copy','diagnostic-text','diagnostic-copy-status'])nodes.delete(id);
 render(result);getNode('diagnostic-text').value=textFor(result);
 return getNode('diagnostic-copy');
};
let copied=[];
context.navigator={clipboard:{writeText:async value=>{copied.push(value)}}};
let button=mountDiagnostics(poisoned);
await button.listeners.click();
assert.deepEqual(copied,[safeText]);
assert.equal(getNode('diagnostic-copy-status').textContent,'コピーしました');
assert.equal(button.disabled,false);
for(const navigator of [undefined,{}, {clipboard:{writeText:async()=>{throw new Error('permission denied')}}}]){
 context.navigator=navigator;button=mountDiagnostics(diagnosticBase);
 await button.listeners.click();
 assert.ok(getNode('diagnostic-copy-status').textContent.includes('長押し'));
 assert.equal(getNode('diagnostic-text').value,text);
 assert.equal(getNode('diagnostic-text').focused,true);
 assert.equal(getNode('diagnostic-text').selected,true);
 assert.deepEqual(getNode('diagnostic-text').selection,[0,text.length]);
 assert.equal(button.disabled,false);
}
let settle,copyCalls=0;
context.navigator={clipboard:{writeText:()=>{copyCalls++;return new Promise(resolve=>{settle=resolve})}}};
button=mountDiagnostics(diagnosticBase);
const firstCopy=button.listeners.click();
await button.listeners.click();
assert.equal(copyCalls,1,'Repeated taps while copying must not create duplicate clipboard operations');
const newer=mountDiagnostics(cachedDiagnostics);
settle();await firstCopy;
assert.notEqual(button,newer);
assert.notEqual(getNode('diagnostic-copy-status').textContent,'コピーしました','Late copy completion must not update the next search result');
let rejectOld;
context.navigator={clipboard:{writeText:()=>new Promise((_,reject)=>{rejectOld=reject})}};
button=mountDiagnostics(diagnosticBase);const oldCopy=button.listeners.click();
mountDiagnostics(cachedDiagnostics);rejectOld(new Error('late denial'));await oldCopy;
assert.notEqual(getNode('diagnostic-text').selected,true,'Late copy failure must not focus or select a different result');
const source=await readFile(new URL('../frontend/app.js',import.meta.url),'utf8');
assert.equal(await readFile(new URL('../../dist/app.js',import.meta.url),'utf8'),source,'Published and source frontend files must match');
const page=await readFile(new URL('../../dist/index.html',import.meta.url),'utf8');
assert.ok(page.includes('app.js?v=20261014-64'),'Only the frontend asset cache key changes');
assert.ok(source.includes('question:input,v:"20261014-64"'),'The analysis/cache version remains unchanged');
console.log('Frontend states, timings, safe numeric diagnostics, cache labels, absent usage, clipboard success/fallback/repeated taps, stale-copy isolation, escaping, unchanged source requests and nonblocking law lookup passed. No network or model calls.');

