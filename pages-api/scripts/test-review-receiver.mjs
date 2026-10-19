// Exact input/output compatibility tests. All AI and caches are mocked.
// This is not a live speed or semantic-accuracy benchmark.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import * as routing from '../worker/routing-core.mjs';
import { runCacheWrite } from '../worker/background-cache.mjs';

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name); };
const baselineSource = await readFile(new URL('./fixtures/semantic-review-before-receiver.mjs', import.meta.url), 'utf8');
const currentSource = await readFile(new URL('../worker/semantic-review.mjs', import.meta.url), 'utf8');
const bytes = Buffer.from(baselineSource);
assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), '021c41a22906b3f16c2d695568e7f5ce52d137ef');
function load(source, store = null) {
  const context = vm.createContext({ ...routing, runCacheWrite, console, setTimeout, clearTimeout,
    Response, AbortSignal, TextEncoder, crypto: webcrypto,
    fetch() { throw Error('No real network in receiver tests'); },
    ...(store ? { caches: { default: {
      async match(key) { return store.get(key)?.clone(); },
      async put(key, value) { store.set(key, value.clone()); },
    } } } : {}),
  });
  new vm.Script(source.replace(/^import [^\n]+;\n/gm, '').replace(/^export /gm, '') +
    '\n;globalThis.review=reviewCompactAssignments;', { filename: 'receiver-under-test.mjs' }).runInContext(context);
  return context.review;
}
const question = '教員の長時間労働を是正するための対策';
const rows = Array.from({ length: 24 }, (_, i) => ({
  case_id: `receiver:${String(i).padStart(2,'0')}`, ministry: i % 2 ? '文部科学省' : '厚生労働省',
  question: '教員の長時間労働を是正するための対策を伺います。',
  answer: `教員の勤務負担を減らすため支援員を配置します。案件${i}です。`,
  position: i % 2 ? '文部科学大臣' : '厚生労働大臣', date: '2026-05-01', meeting: '委員会',
  url: `https://kokkai.ndl.go.jp/txt/receiver/${i}`, retrieval_score: 1,
}));
const plain = value => JSON.parse(JSON.stringify(value));
const stable = value => {
  const data = plain(value);
  for (const d of data.review_diagnostics || []) {
    for (const key of ['model_ms','total_ms','started_after_ms','cache_read_ms','omitted_unused_refs','validation_failures','invalid_relation_details']) delete d[key];
  }
  return data;
};
const sourceOf = candidate => Number(Object.values(candidate.source_answer).join('').match(/案件(\d+)/)[1]);
async function evaluate(source, change = () => {}, { store = null, scope = false } = {}) {
  const payloads = [], providerRows = []; let active = 0, peak = 0;
  const review = load(source, store);
  const result = await review(question, { review_candidates: rows, recent_since: '2024-01-01', searched: [], errors: [] }, {
    CLOUDFLARE_WORKERS_PLAN: 'free', AI: { async run(model, payload) {
      payloads.push(JSON.stringify([model, payload])); active++; peak = Math.max(peak,active);
      const input = JSON.parse(payload.messages[1].content);
      const isScope = payload.messages[0].content.includes('この判定は、');
      const reviews = input.candidates.map(candidate => {
        const index = sourceOf(candidate), accepted = index < 4;
        const qParts = candidate.source_question || input.candidates.find(c => c.id === candidate.source_question_ref).source_question;
        const row = { id: candidate.id, beneficiary: accepted ? (scope ? '学校の先生' : '教員') : '一般労働者',
          activity: accepted ? '学校の教育業務' : '一般就労', relation: accepted ? 'same' : 'different',
          comparison: accepted ? '教員の勤務負担軽減について支援員配置を示す答弁' : '労働者一般の支援であり学校業務の課題への答弁ではない',
          decision: accepted ? 'accept' : 'reject', q: accepted ? Object.keys(qParts)[0] : '',
          a: accepted ? Object.keys(candidate.source_answer)[0] : '' };
        change(row,index,isScope); return row;
      });
      for (const row of reviews) Object.freeze(row);
      providerRows.push(JSON.stringify(reviews));
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { response: { reviews } };
    } },
  });
  return { result: plain(result), payloads, providerRows, peak };
}
const fullOld = await evaluate(baselineSource), fullNew = await evaluate(currentSource);
check('Full well-formed replies and every outgoing model payload remain identical', () => {
  assert.deepEqual(fullNew.payloads, fullOld.payloads);
  assert.deepEqual(stable(fullNew.result),stable(fullOld.result));
  assert.equal(fullNew.payloads.length,3); assert.equal(fullNew.peak,3);
});
const omit = (row,index) => { if (index >= 18) { delete row.q; delete row.a; } };
const partialOld = await evaluate(baselineSource,omit), repaired = await evaluate(currentSource,omit);
check('Six unused field omissions are 24/24 in the SAME initial three calls', () => {
  assert.equal(partialOld.result.reviewed_candidates,18); assert.equal(repaired.result.reviewed_candidates,24);
  assert.equal(repaired.result.assessment_partial,undefined); assert.equal(repaired.result.pairs,4);
  assert.deepEqual(repaired.result.evidence,partialOld.result.evidence);
  assert.deepEqual(repaired.result.shares,partialOld.result.shares);
  assert.deepEqual(repaired.payloads,partialOld.payloads);
  assert.equal(repaired.payloads.length,3); assert.equal(repaired.peak,3);
  assert.equal(repaired.result.review_diagnostics.reduce((n,d)=>n+d.omitted_unused_refs,0),6);
});
for (const [name, field, change] of [
  ['missing reason','missing_semantic_fields',r=>delete r.comparison],
  ['missing accepted reference','missing_accepted_refs',r=>delete r.a],
  ['unexpected field','unknown_fields',r=>{r.extra='must not be copied to diagnostics'}],
  ['wrong type','non_string_fields',r=>{r.q=123}],
  ['blank reason','blank_comparison',r=>{r.comparison=' '}],
  ['long reason','long_comparison',r=>{r.comparison='長'.repeat(301)}],
  ['unknown decision','invalid_decision',r=>{r.decision='malformed'}],
  ['unknown relation','invalid_relation',r=>{r.relation='unrelated-enum'}],
  ['blank accepted role','blank_accepted_roles_or_refs',r=>{r.beneficiary=''}],
  ['blank accepted quote','blank_accepted_roles_or_refs',r=>{r.q=''}],
]) {
  const old = await evaluate(baselineSource,(r,i)=>{if(i===0)change(r)});
  const next = await evaluate(currentSource,(r,i)=>{if(i===0)change(r)});
  check(name+' stays failed, with a fixed numeric diagnostic instead of raw text',()=>{
    assert.deepEqual(stable(next.result),stable(old.result)); assert.deepEqual(next.payloads,old.payloads);
    assert.equal(next.result.reviewed_candidates,23); assert.equal(next.result.pairs,3);
    assert.equal(next.result.review_diagnostics.reduce((n,d)=>n+d.validation_failures[field],0),1);
    for (const d of next.result.review_diagnostics) assert.ok(Object.values(d.validation_failures).every(Number.isSafeInteger));
    assert.ok(!JSON.stringify(next.result.review_diagnostics).includes('must not be copied'));
  });
}
const scopedOld = await evaluate(baselineSource,()=>{},{scope:true});
const scopedNext = await evaluate(currentSource,()=>{},{scope:true});
check('Additional-scope inputs, outputs and budget are also unchanged',()=>{
  assert.deepEqual(scopedNext.payloads,scopedOld.payloads);
  assert.deepEqual(stable(scopedNext.result),stable(scopedOld.result));
  assert.ok(scopedNext.payloads.length>3 && scopedNext.payloads.length<=5);
});
const store = new Map();
const cached = await evaluate(currentSource,omit,{store});
check('Only fully validated canonical rows go into cache; raw provider rows stay untouched',()=>{
  assert.equal(store.size,3); assert.equal(cached.result.reviewed_candidates,24);
  assert.ok(cached.providerRows.some(text=>JSON.parse(text).some(row=>!Object.hasOwn(row,'q'))));
});
for (const response of store.values()) {
  const body = await response.clone().json();
  for (const r of body.data.reviews) assert.deepEqual(Object.keys(r).sort(),['a','activity','beneficiary','comparison','decision','id','q','relation']);
}
const rollback = await evaluate(baselineSource,()=>{},{store});
check('Rolling back to strict main can consume the SAME cache without a new generation',()=>{
  assert.equal(rollback.payloads.length,0); assert.equal(rollback.result.reviewed_candidates,24);
  assert.equal(rollback.result.review_cache_hits,3); assert.deepEqual(rollback.result.evidence,repaired.result.evidence);
});
const invalidStore = new Map();
await evaluate(currentSource,(r,i)=>{if(i===0)r.q='forged';},{store:invalidStore});
check('Forged accepted references never become reusable even after normalizing negatives',()=>assert.equal(invalidStore.size,2));
const report={checks,comparison:'unchanged outgoing model requests; receiver-only recovery',baseline_blob:'021c41a22906b3f16c2d695568e7f5ce52d137ef',
  synthetic_before:18,synthetic_after:24,accepted_unchanged:4,model_calls:3,external_requests:0,live_latency_measured:false};
console.log('RECEIVER_COMPATIBILITY '+JSON.stringify(report));
const out=process.argv.indexOf('--report');
if(out>=0)await writeFile(process.argv[out+1],JSON.stringify(report,null,2)+'\n');
