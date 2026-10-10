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
// Slow supplementary law searches must not block the result, and an earlier
// question's delayed laws must never overwrite a later question's references.
const laws=[];
context.fetch=async url=>{
  if(String(url).includes('jurisdiction?'))return new Promise(resolve=>laws.push(resolve));
  return Response.json({...base,assessment_status:'reviewed',review_candidates:[]});
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
const flush=()=>new Promise(resolve=>setTimeout(resolve,10));
laws[0](Response.json({matches:[{ministry:'以前の検索',title:'旧法令',snippet:'old',url:'https://laws.e-gov.go.jp/law/old'}]}));
await flush();
assert.ok(!getNode('law-results').innerHTML.includes('以前の検索'));
laws[1](Response.json({matches:[{ministry:'経済産業省',title:'経済産業省設置法',snippet:'新しい検索',url:'https://laws.e-gov.go.jp/law/new'}]}));
await flush();
assert.ok(getNode('law-results').innerHTML.includes('新しい検索'));
console.log('Frontend assessment states, escaping, nonblocking law lookup and stale-result isolation checks passed.');
