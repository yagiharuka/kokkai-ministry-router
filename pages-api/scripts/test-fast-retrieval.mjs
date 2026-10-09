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
assert.equal(calls.length, 3, 'Two consolidated searches and one full meeting should suffice');
assert.equal(calls.filter(c => c.path === 'speech').length, 2);
assert.ok(calls.filter(c => c.path === 'speech').every(c => c.from.endsWith('-01-01') && Number(c.until.slice(0, 4)) - Number(c.from.slice(0, 4)) === 2));
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
console.log('Contiguous-turn safety, consolidated retrieval, source deduplication and bounded expansion checks passed.');
