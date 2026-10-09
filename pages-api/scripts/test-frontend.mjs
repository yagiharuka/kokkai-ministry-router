import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const nodes = new Map();
const getNode = id => {if(!nodes.has(id))nodes.set(id,{hidden:true,innerHTML:'',addEventListener(){}});return nodes.get(id);};
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
console.log('Frontend legacy-result guard, assessment states and evidence escaping checks passed.');
