import assert from 'node:assert/strict';
import { makePlan, reviewCandidates } from '../worker/routing-core.mjs';
import { contiguousMeetings, retrieveFastAssignments } from '../worker/fast-retrieval.mjs';

const speech = (order, question, text, issue = 'm1') => ({
  issueID: issue, speechID: `${issue}_${order}`, speechOrder: order, date: '2025-05-20', nameOfMeeting: '文教委員会',
  speakerGroup: question ? '会派' : '', speakerPosition: question ? '' : '文部科学大臣',
  speech: text, speechURL: `https://kokkai.ndl.go.jp/txt/${issue}/${order}`,
});
const q = speech(1, true, '教員の長時間労働を是正すべきではないか、伺います。');
const a = speech(2, false, '教員の長時間労働を減らすため支援員を配置します。');
const other = speech(4, false, '教員の研修内容についてお答えします。');
const plan = makePlan('教員の長時間労働を是正すべきではないか');
const split = contiguousMeetings([other, a, q, q]);
assert.deepEqual(split.map(m => m.speechRecord.map(s => s.speechOrder)), [[1, 2], [4]]);
const reviewed = reviewCandidates(split, plan);
assert.equal(reviewed.length, 1);
assert.equal(reviewed[0].url, a.speechURL, 'A missing question must never attach a later answer to an earlier question');
assert.equal(reviewCandidates(contiguousMeetings([q, other]), plan).length, 0);
assert.equal(reviewCandidates(contiguousMeetings([q, { ...a, issueID: 'm2' }]), plan).length, 0);
assert.equal(contiguousMeetings([{ ...q, speechOrder: null }]).length, 0);

const calls = [];
plan.queries = ['教員 長時間労働', '教師 勤務時間'];
const full = { issueID: 'm1', date: q.date, nameOfMeeting: q.nameOfMeeting, speechRecord: [q, a] };
const result = await retrieveFastAssignments(plan, async (path, params) => {
  calls.push({ path, ...params });
  if (path === 'speech') return { speechRecord: params.any === plan.queries[0] ? [q] : [a], nextRecordPosition: 101 };
  return { meetingRecord: [full] };
});
assert.equal(calls.length, 2, 'Reuse one speech search, then batch full meetings only for a thin sample');
assert.equal(calls.filter(c => c.path === 'speech').length, 1);
assert.ok(calls.filter(c => c.path === 'speech').every(c => c.from === '2001-01-01'));
assert.equal(result.review_candidates.length, 1);
assert.deepEqual(result.shares, [], 'Retrieval alone must not assign a ministry');
assert.equal(result.search_limited, true);
assert.equal(result.full_meetings, 1);
const excluded = await retrieveFastAssignments(plan, async () => ({ speechRecord: [q, a] }), '2020-01-01', { includeOlder: true, excludeMeetings: ['m1'], maxRequests: 2 });
assert.equal(excluded.review_candidates.length, 0);
assert.equal(excluded.requests_used, 2);
const failed = await retrieveFastAssignments(plan, async () => { throw new Error('source unavailable'); });
assert.equal(failed.partial, true);
assert.equal(failed.review_candidates.length, 0);

const broad = Array.from({length:18}, (_,i) => { const m='wide'+(i%3); return [speech(i*2+1,true,'教員の長時間労働の是正について伺います。',m),speech(i*2+2,false,'教員の長時間労働を改善します。',m)]; }).flat();
const wideCalls=[]; const wide=await retrieveFastAssignments(plan,async(path,p)=>{wideCalls.push(path);return {speechRecord:broad};});
assert.equal(wide.requests_used,1,'Enough adjacent turns in multiple meetings must not trigger full downloads');
assert.equal(wide.retrieved_cases,18);
assert.deepEqual(wideCalls,['speech']);
const multi=await retrieveFastAssignments(plan,async(path,p)=>path==='speech'?{speechRecord:[q]}:{meetingRecord:[full,{...full,issueID:'m2',speechRecord:[speech(1,true,q.speech,'m2'),speech(2,false,a.speech,'m2')]}]});
assert.equal(multi.full_meetings,2,'A single full-output request can add multiple meetings');
assert.equal(multi.retrieved_cases,2);
console.log('Contiguous-turn safety, consolidated retrieval, source deduplication and bounded expansion checks passed.');
