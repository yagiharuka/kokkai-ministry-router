// Offline scheduling equivalence. Deferred promises represent model completion;
// no network requests, credentials, live inference, or wall-clock speed claims.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { finishReviewTail } from '../worker/semantic-review.mjs';
import { makePlan, concepts, normalize, summarize, diversifyCandidates,
  needsFullPlenaryContext } from '../worker/routing-core.mjs';

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const legacyTail = async ({outcomePromises, consumed, groundReviews, ambiguousRows, reviewedByBatch, verifyScope, capacity}) => {
  const outcomes = await Promise.all(outcomePromises);
  const rows = outcomes.flatMap((outcome, index) => {
    if (consumed.has(index)) return [];
    const result = groundReviews(outcome); reviewedByBatch.set(index, result); return result;
  });
  return { outcomes, tailScope: verifyScope(ambiguousRows(rows), capacity) };
};
let checks = 0;
async function runTail(coordinator, counts, first, capacity, order) {
  const batches = counts.map((count, index) => Array.from({length:8}, (_,i) => ({
    id: `${index}:${i}`, eligible: i < count, screening: i < count ? 'accept' : 'reject',
  })));
  const deferred = batches.map(defer), settledOutcomes = [], consumed = new Set([first]);
  const outcomePromises = deferred.map((d,index) => d.promise.then(outcome => { settledOutcomes[index] = outcome; return outcome; }));
  deferred[first].resolve({rows:batches[first]}); await drain();
  const calls = [], marks = [], reviewedByBatch = new Map([[first,batches[first].map(row=>({...row}))]]);
  const pending = coordinator({ outcomePromises, settledOutcomes, consumed, capacity, reviewedByBatch,
    groundReviews: outcome => outcome.rows.map(row=>({...row})),
    ambiguousRows: rows => rows.filter(row=>row.eligible),
    async verifyScope(rows, limit) {
      for (const row of rows.slice(limit)) row.screening = 'uncertain';
      const selected = rows.slice(0,limit);
      if (!selected.length) return null;
      calls.push(selected.map(row=>row.id));
      marks.push(settledOutcomes.filter(Boolean).length);
      // Simulate real verification changing a subset of accepted rows.
      selected.forEach((row,i)=> { row.screening = i % 3 ? 'accept' : 'reject'; });
      return { result:{reviewed_candidates:selected.length}, missing:0 };
    },
  });
  for (const index of order) { deferred[index].resolve({rows:batches[index]}); await drain(); }
  const result = await pending; await result.tailScope;
  return { calls, marks, rows:[...reviewedByBatch].sort(([a],[b])=>a-b).map(([,rows])=>rows), scope:await result.tailScope };
}
for (const first of [0,1,2]) {
  const rest = [0,1,2].filter(i=>i!==first);
  for (const a of [0,1,3,7,8]) for (const b of [0,1,3,7,8]) for (const c of [0,1,3,7,8]) {
    for (const capacity of [0,1,2,7,8]) for (const order of [rest,[...rest].reverse()]) {
      const old = await runTail(legacyTail,[a,b,c],first,capacity,order);
      const next = await runTail(finishReviewTail,[a,b,c],first,capacity,order);
      assert.deepEqual(next.calls,old.calls,'Original-ranked sources and scope batch grouping must be identical');
      assert.deepEqual(next.rows,old.rows,'Scope mutation and over-budget pending states must be identical');
      assert.deepEqual(next.scope,old.scope);
      assert.ok(next.calls.length<=1);
      checks++;
    }
  }
}
const advance = await runTail(finishReviewTail,[1,7,8],0,7,[1,2]);
assert.deepEqual(advance.marks,[2], 'A fixed full tail budget starts before the third initial batch finishes');
const blockedPrefix = await runTail(finishReviewTail,[7,7,1],2,7,[1,0]);
assert.deepEqual(blockedPrefix.marks,[3],'Do not borrow priority from an unfinished earlier batch');
const thin = await runTail(finishReviewTail,[1,1,1],0,7,[1,2]);
assert.deepEqual(thin.marks,[3], 'A not-yet-full tail waits, so later eligible rows are not lost');
checks += 3;

// Run the complete production reviewer against exact baseline source with
// identical mocked model responses, including negative and failed scope paths.
const baseSource = await readFile(new URL('./fixtures/semantic-review-v79.mjs',import.meta.url),'utf8');
const blob = createHash('sha1').update(`blob ${Buffer.byteLength(baseSource)}\0`).update(baseSource).digest('hex');
assert.equal(blob,'1fbd7485157e7a8ffae3b1ba856178f98bd6a0e9');
const newSource = await readFile(new URL('../worker/semantic-review.mjs',import.meta.url),'utf8');
function reviewer(source) {
  const context = vm.createContext({makePlan,concepts,normalize,summarize,diversifyCandidates,needsFullPlenaryContext,
    runCacheWrite:async()=>false, console,setTimeout,clearTimeout,Response,AbortSignal,TextEncoder,
    fetch:()=>{throw Error('External requests are forbidden in these tests');}});
  new vm.Script(source.replace(/^import [^\n]+;\n/gm,'').replace(/^export /gm,'') + '\n;globalThis.run=reviewCompactAssignments;').runInContext(context);
  return context.run;
}
const ask = '教員の勤務負担を減らすための対策について';
const candidates = Array.from({length:24},(_,i)=>({case_id:`same-meeting:q${String(i).padStart(2,'0')}`,
  ministry:'文部科学省', position:'文部科学大臣', date:'2026-05-01', meeting:'文教委員会',
  question:'教員の勤務負担を減らすにはどうしますか。',
  answer:`学校の先生の勤務負担を減らすため支援員を配置します。資料番号${i}です。`,
  url:`https://kokkai.ndl.go.jp/txt/test/${i}`,retrieval_score:1}));
async function fullRun(source, counts, order, scopeFailure=false, blockLast=false, initialFailure=-1) {
  const run = reviewer(source), gates = Array.from({length:3},defer), scopeObserved = defer();
  const received=[], scopePayloads=[], events=[]; let initial=0, active=0, peak=0;
  const env={CLOUDFLARE_WORKERS_PLAN:'free',AI:{async run(model,payload) {
    active++; peak=Math.max(peak,active);
    const input=JSON.parse(payload.messages[1].content), scoped=payload.messages[0].content.includes('この判定は、');
    let batch;
    try {
      if (!scoped) { batch=initial++;received[batch]=JSON.stringify(payload); await gates[batch].promise; events.push(`initial${batch}`); }
      else { scopePayloads.push(JSON.stringify(payload));events.push(`scope${scopePayloads.length}`);if(scopePayloads.length===2)scopeObserved.resolve(); }
      if(scoped&&scopeFailure || !scoped&&batch===initialFailure)throw Error('model_timeout');
      const reviews=input.candidates.map((c,i)=>({id:c.id,beneficiary:'学校の先生',activity:'学校での教育業務',
        relation: scoped||i<counts[batch]?'same':'different',
        comparison:scoped||i<counts[batch]?'学校の先生の勤務負担を支援員配置によって減らす答弁':'別の対象の活動を扱うため質問案とは異なる答弁',
        decision:scoped||i<counts[batch]?'accept':'reject',
        q:scoped||i<counts[batch]?Object.keys(c.source_question||input.candidates.find(x=>x.id===c.source_question_ref).source_question)[0]:'',
        a:scoped||i<counts[batch]?Object.keys(c.source_answer)[0]:''}));
      return {response:{reviews}};
    }finally{active--;}
  }}};
  const pending=run(ask,{review_candidates:candidates,recent_since:'2024-01-01',searched:[],errors:[]},env);
  await drain();
  for(const index of order) {
    if(blockLast&&index===2) {
      // New reviewer must reach the final scope call while the final initial
      // answer is still withheld. This demonstrates overlap, not speed.
      let watchdog;
      await Promise.race([scopeObserved.promise,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('Tail was blocked by final initial batch')),2000);})]).finally(()=>clearTimeout(watchdog));
    }
    gates[index].resolve(); await drain();
  }
  const result=JSON.parse(JSON.stringify(await pending));
  for(const d of result.review_diagnostics||[])for(const key of ['started_after_ms','model_ms','cache_read_ms','total_ms'])delete d[key];
  return {result,received,scopePayloads,events,peak};
}
for(const counts of [[1,7,8],[1,1,1],[8,8,8],[0,7,1]])for(const order of [[0,1,2],[2,1,0],[1,0,2]])for(const failed of [false,true]) {
  const old=await fullRun(baseSource,counts,order,failed);
  const next=await fullRun(newSource,counts,order,failed);
  assert.deepEqual(next.received,old.received,'All initial model payloads remain byte-for-byte equal');
  assert.deepEqual(next.scopePayloads,old.scopePayloads,'All scope model payloads remain byte-for-byte equal');
  assert.deepEqual(next.result,old.result,'Decisions, quotes, ownership, counts and errors must match, except clock diagnostics');
  assert.ok(next.peak<=3,'Maximum concurrent model requests must not grow');
  checks++;
}
for (const initialFailure of [0,1,2]) for (const order of [[0,1,2],[2,1,0],[1,0,2]]) {
  const old=await fullRun(baseSource,[1,7,8],order,false,false,initialFailure);
  const next=await fullRun(newSource,[1,7,8],order,false,false,initialFailure);
  assert.deepEqual(next.result,old.result,'Initial failure remains partial without changing successful scope payloads');
  assert.deepEqual(next.scopePayloads,old.scopePayloads);
  assert.ok(next.peak<=3);
  checks++;
}
const overlapped=await fullRun(newSource,[1,7,8],[0,1,2],false,true);
assert.ok(overlapped.events.indexOf('scope2')<overlapped.events.indexOf('initial2'));
assert.equal(overlapped.result.review_model_calls,5);
assert.equal(overlapped.result.reviewed_candidates,24);
assert.equal(overlapped.result.pairs,8);
checks++;
console.log(JSON.stringify({kind:'offline tail-scope equivalence and actual reviewer scheduling',checks,baseline_blob:blob,
  same_model_payloads:true,external_requests:0,live_latency_measured:false,overlap_events:overlapped.events}));
