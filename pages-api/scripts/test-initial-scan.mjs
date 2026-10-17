// Differential tests against the exact retained v79 source. No network or AI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as before from './fixtures/routing-core-v79.mjs';
import * as after from '../worker/routing-core.mjs';
import { retrieveFastAssignments } from '../worker/fast-retrieval.mjs';

const baselineSource = await readFile(new URL('./fixtures/routing-core-v79.mjs', import.meta.url));
const gitHash = createHash('sha1').update(`blob ${baselineSource.length}\0`).update(baselineSource).digest('hex');
assert.equal(gitHash, '6fdc9bb961b7ed2dbe6baa049fd3f94affeb160d', 'Retained baseline must be exact v79 code');
let checks = 1;
const equal = (a,b,label) => { assert.deepEqual(a,b,label); checks++; };
const queries = ['スタートアップ分野の女性活躍を推進すべきではないか', '基礎の研究開発支援を強化すべきではないか',
 'ペットの生体販売のあり方を見直すべきではないか', '教員の長時間労働を是正すべきではないか',
 '医療機器の承認を迅速化するべきではないか', '農産物の輸出を拡大すべきではないか',
 'ガバメントクラウドの経費を抑制すべきではないか', 'なでしこ銘柄の推進を進めるべきではないか'];
const tokens = ['ペット','ペットボトル','カーペット','ペットショップ','ﾍﾟｯﾄ','医療機器','薬事承認','薬事承認審議会',
 'スタートアップ','女性起業家','女性','基礎研究','基礎研究支援','研究開発','教員','教師','長時間労働',
 '迅速化','迅速','高度化','高度','ガバメントクラウド','農産物','輸出','輸出入取引法','次に、','続いて、','それでは、','。','？',' ','\n'];
let seed = 0x71c042bd;
const random = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
for (let i=0; i<320; i++) {
 const text=Array.from({length:5+random(55)},()=>tokens[random(tokens.length)]).join('');
 const plan=after.makePlan(queries[i%queries.length]);
 equal(plan, before.makePlan(queries[i%queries.length]), 'Plans remain identical');
 equal(after.scorePassage(text,plan), before.scorePassage(text,plan), 'Scores and first-hit offsets remain identical');
 const speech={speechID:'q'+i,issueID:'m'+i,speechOrder:1,speakerGroup:'会派',speech:text};
 equal(after.matchQuestion(speech,plan), before.matchQuestion(speech,plan), 'Question excerpt winner remains identical');
}
for (const group of [
 {text:'迅速化支援',parts:['迅速化','支援']}, {text:'高度化制度',parts:['高度化','制度']},
 {text:'語',parts:['語','語']}, {text:'医療機器',parts:['医療','機器']}, {text:'',parts:[]}
]) for (const text of ['迅速。迅速化の支援。','高度。後から高度化制度を支援。','語 語 語','薬事医療機器法。医療機器の開発支援。','']) {
 const plan={groups:[group]};
 equal(after.scorePassage(text,plan), before.scorePassage(text,plan), 'Stem priority and empty-boundary compatibility');
}
for (const term of ['ペット','スタートアップ','医療機器','迅速化']) {
 for (const text of [term.repeat(1000),('薬事'+term+'法。').repeat(120)+term+'。', 'ペットボトル。'.repeat(1000)+'ペットを支援。']) {
  const plan={groups:[{text:term,parts:[term]}]};
  equal(after.scorePassage(text,plan), before.scorePassage(text,plan), 'Repeated excluded and valid matches');
 }
}
const fixtures=JSON.parse(await readFile(new URL('../evaluation/latency-regressions-20261014.json', import.meta.url),'utf8')).cases;
function makeMeetings(copies=1) {
 const meetings=[];
 for(let repeat=0;repeat<copies;repeat++) for(const [i,fixture] of fixtures.entries()) {
  const s=fixture.source, issueID=`scan-${repeat}-${i}`;
  meetings.push({issueID,date:s.date,nameOfMeeting:s.meeting,speechRecord:[
   {issueID,speechID:issueID+'_q',speechOrder:1,speakerGroup:'会派',speech:s.question,speechURL:s.question_url},
   {issueID,speechID:issueID+'_a',speechOrder:2,speakerGroup:'',speaker:s.speaker,speakerPosition:s.position,speech:s.answer,speechURL:s.url},
  ]});
 }
 return meetings;
}
const meetings=makeMeetings(), speeches=meetings.flatMap(m=>m.speechRecord);
for (const query of new Set([...queries,...fixtures.map(f=>f.proposed_question)])) {
 const plan=after.makePlan(query);
 equal(after.reviewCandidates(meetings,plan,96), before.reviewCandidates(meetings,plan,96), 'Candidates, order, score and complete original excerpts');
 equal(after.rankRecallQuestions(speeches,plan,20), before.rankRecallQuestions(speeches,plan,20), 'Meeting selection');
 equal(after.rankQuestions(speeches,plan,4), before.rankQuestions(speeches,plan,4), 'Legacy ranked questions');
 equal(after.pairAnswers(meetings,plan), before.pairAnswers(meetings,plan), 'Legacy turn alignment and agency attribution');
}
// Use the exact same retrieval controller with only its core import replaced.
const fastSource=await readFile(new URL('../worker/fast-retrieval.mjs',import.meta.url),'utf8');
const baselineURL=new URL('./fixtures/routing-core-v79.mjs',import.meta.url).href;
assert.ok(fastSource.includes("from './routing-core.mjs';"));
const oldFast=await import('data:text/javascript;base64,'+Buffer.from(fastSource.replace("from './routing-core.mjs';",`from '${baselineURL}';`)).toString('base64'));
for (const query of queries.slice(0,4)) {
 const plan=after.makePlan(query), traceA=[],traceB=[];
 const fake=trace=>async(resource,params)=>{trace.push({resource,params});return resource==='speech'?
   {speechRecord:speeches,numberOfRecords:speeches.length}:{meetingRecord:meetings};};
 const a=await retrieveFastAssignments(plan,fake(traceA));
 const b=await oldFast.retrieveFastAssignments(plan,fake(traceB));
 const strip=result=>{const {selection_ms,...rest}=result;return rest;};
 equal(strip(a),strip(b),'Complete first-request retrieval output except stopwatch');
 equal(traceA,traceB,'Same external request count and parameters');
}
const report={kind:'offline exact-output differential test; no AI or external requests',checks,baseline_blob:gitHash,external_requests:0};
if (process.argv.includes('--benchmark')) {
 const rows=makeMeetings(20),plan=after.makePlan(fixtures[0].proposed_question);
 const time=engine=>{const start=performance.now();const result=engine.reviewCandidates(rows,plan,96);return {ms:performance.now()-start,result};};
 for(let warm=0;warm<3;warm++){time(before);time(after);}
 const old=[],current=[];
 for(let i=0;i<11;i++) {
  let a,b;
  if(i%2){b=time(after);a=time(before);}else{a=time(before);b=time(after);}
  equal(b.result,a.result,'Every benchmark iteration retains exact output');
  old.push(a.ms);current.push(b.ms);
 }
 const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 report.benchmark={description:'12 saved excerpt pairs repeated 20 times (480 speeches), not 480 independently retrieved speeches',node:process.version,
   baseline_ms:old,optimized_ms:current,baseline_median_ms:median(old),optimized_median_ms:median(current),
   limitations:'In-process candidate extraction only. Does not include NDL networking, model generation, cold start or full site latency. No cache reused.'};
}
report.checks=checks;
const outputIndex=process.argv.indexOf('--report');
if(outputIndex>=0){assert.ok(process.argv[outputIndex+1]);await writeFile(process.argv[outputIndex+1],JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report));
