import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makePlan, normalize, scorePassage, reviewCandidates, diversifyCandidates, retrieveAssignments } from '../worker/routing-core.mjs';
import { retrieveFastAssignments } from '../worker/fast-retrieval.mjs';

const prompt = 'ペットの生体販売のあり方を見直すべきではないか';
const plan = makePlan(prompt);
assert.deepEqual(plan.groups.map(g => g.text), ['ペット', '生体販売', '見直']);
assert.equal(plan.groups.at(-1).role, 'requested_change');
assert.equal(plan.question, prompt, 'The complete proposal must still reach the semantic reviewer unchanged');
assert.deepEqual(makePlan(prompt.replace('あり方', '在り方')).groups, plan.groups);
assert.deepEqual(plan.queries.slice(0, 2), ['ペット 生体販売', '生体販売']);
assert.equal(new Set(plan.queries).size, plan.queries.length);
assert.equal(makePlan(prompt, ['犬猫', '販売']).queries[0], '犬猫 販売', 'Supplied hint precedence is unchanged');
assert.deepEqual(makePlan('教員の長時間労働を是正すべきではないか').queries.slice(0, 2), ['教員 長時間労働', '長時間労働']);
assert.deepEqual(makePlan('スタートアップ分野の女性活躍を推進するべきではないか').queries.slice(0, 2), ['スタートアップ 女性', 'スタートアップ']);
assert.ok(makePlan('研究開発税制の拡充を検討すべきではないか').queries.every(q => q.includes('研究開発税制')));

const coverage = (term, text) => scorePassage(normalize(text), { groups: [{ text: term, parts: [term] }] }).hits[0].coverage;
for (const text of ['ペットボトル', 'ペットボトル販売のあり方', 'カーペット']) assert.equal(coverage('ペット', text), 0, text);
assert.equal(coverage('ペット', 'ペットボトルの販売について。'.repeat(5000)), 0, 'Repeated rejected prefixes must remain safe in long speeches');
assert.equal(coverage('ペット', 'ペットボトルの販売について。'.repeat(100) + 'ペットを飼養します。'), 1, 'Rejected prefixes must not consume the 80 valid-occurrence allowance');
for (const text of ['ペット', 'ペットショップ', 'ペットフード', 'ペットの生体販売', 'ﾍﾟｯﾄｼｮｯﾌﾟ']) assert.equal(coverage('ペット', text), 1, text);
for (const term of ['スタートアップ', 'ガバメントクラウド', 'カスタマーハラスメント']) {
  assert.equal(coverage(term, term), 1, 'Multi-segment Katakana names must remain intact');
  assert.equal(coverage(term, term + 'の取組'), 1);
}
assert.equal(coverage('スタートアップ', 'スタートアップエコシステム'), 1);
assert.equal(coverage('AI', '生成AI'), 1, 'Mixed-script/Latin matching is outside this narrow change');

const excerpts = JSON.parse(await readFile(new URL('./pet-sales-excerpts.json', import.meta.url), 'utf8'));
const meeting = item => ({ issueID: item.id, date: item.date, nameOfMeeting: item.meeting, speechRecord: [
  { issueID: item.id, speechID: item.id + '_q', speechOrder: 1, speakerGroup: '会派', speech: item.question, speechURL: item.url },
  { issueID: item.id, speechID: item.id + '_a', speechOrder: 2, speaker: item.speaker, speakerPosition: item.position, speech: item.answer, speechURL: item.url },
] });
const real = reviewCandidates(excerpts.map(meeting), plan, 96);
assert.equal(real.length, 2, 'Both independently sourced debates must reach review');
for (const item of excerpts) {
  const candidate = real.find(row => row.case_id.startsWith(item.id + ':'));
  assert.equal(candidate.ministry, item.ministry);
  assert.equal(candidate.question, item.question);
  assert.equal(candidate.answer, item.answer);
  assert.equal(candidate.screening, 'unverified', 'Retrieval improvements never auto-accept a debate');
}
const noise = Array.from({ length: 40 }, (_, i) => meeting({
  id: 'synthetic-plastic-' + i, date: '2026-10-01', meeting: '人工的な回帰テスト',
  position: '環境大臣', url: 'https://example.invalid/synthetic/' + i,
  question: 'ペットボトル販売のあり方について伺います。', answer: 'ペットボトル販売のあり方を検討します。',
}));
const bottleRows = reviewCandidates(noise, plan, 96);
assert.ok(bottleRows.every(row => row.retrieval_score < Math.min(...real.map(row => row.retrieval_score))), 'Partial 販売 matches may remain but must not outrank direct policy evidence');
const selected = diversifyCandidates([...bottleRows, ...real], 24);
assert.equal(selected.length, 24);
assert.ok(real.every(row => selected.some(candidate => candidate.case_id === row.case_id)), 'The two real examples must survive a noisy 24-slot shortlist');

const fastCalls = [];
const fast = await retrieveFastAssignments(plan, async (resource, params) => {
  fastCalls.push({ resource, ...params });
  return resource === 'speech' ? { speechRecord: [] } : { meetingRecord: [] };
});
assert.deepEqual(fastCalls.map(call => call.any), ['ペット 生体販売', '生体販売']);
assert.ok(fast.requests_used <= 3, 'No increase in source-request budget');
assert.deepEqual(fast.shares, []);
const legacyCalls = [];
await retrieveAssignments(plan, async (resource, params) => { legacyCalls.push({ resource, ...params }); return { speechRecord: [], meetingRecord: [] }; });
const firstSearches = legacyCalls.filter(call => call.resource === 'speech').slice(0, 6);
assert.deepEqual([...new Set(firstSearches.map(call => call.any))], ['ペット 生体販売', '生体販売'], 'Legacy recall must not fall back to the broadened actor after query reordering');
console.log('Recall quality: generic phrasing, Katakana word spans, compound query priority, two sourced debates, 40 synthetic distractions and unchanged request/shortlist caps passed. No model calls or live searches.');


// Diagnostic-only stage boundary: sourced historical fixtures are not injected
// into production routing or semantic prompts, and this spends no AI quota.
const regression = JSON.parse(await readFile(new URL('../evaluation/latency-regressions-20261014.json', import.meta.url), 'utf8'));
const byQuestion = new Map();
for (const [i, entry] of regression.cases.entries()) {
  const source = entry.source, issue = 'offline-fixture-' + i;
  const row = {issueID:issue, date:source.date, nameOfMeeting:source.meeting, speechRecord:[
    {issueID:issue,speechID:issue+'_q',speechOrder:1,speakerGroup:'会派',speakerPosition:'',speech:source.question,speechURL:source.question_url},
    {issueID:issue,speechID:issue+'_a',speechOrder:2,speakerGroup:'',speaker:source.speaker,speakerPosition:source.position,speech:source.answer,speechURL:source.url},
  ]};
  if (!byQuestion.has(entry.proposed_question)) byQuestion.set(entry.proposed_question, []);
  byQuestion.get(entry.proposed_question).push({entry,row,index:i});
}
for (const [question, entries] of byQuestion) {
  const results=reviewCandidates(entries.map(x=>x.row),makePlan(question),96);
  const shortlisted=diversifyCandidates(results,24);
  const omitted=entries.filter(x=>!results.some(r=>r.case_id.startsWith(x.row.issueID+':')));
  assert.deepEqual(omitted,[],'Every sourced fixture must survive the model-independent recall stage');
  console.log('OFFLINE REGRESSION RECALL',JSON.stringify({question,cases:entries.length,found:results.length,shortlisted:shortlisted.length,omitted:omitted.map(x=>({case_id:x.entry.source.case_id,expected:x.entry.expected,position:x.entry.source.position}))}));
}
