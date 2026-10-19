// Offline retrieval regression. All new meetings and model replies are synthetic.
// This does not reproduce the user's four accepted debates or measure AI quality.
import assert from 'node:assert/strict';
import { makePlan, reviewCandidates, scorePassage } from '../worker/routing-core.mjs';
import { makePlan as previousPlan } from './fixtures/routing-core-v79.mjs';
import { retrieveFastAssignments } from '../worker/fast-retrieval.mjs';
import { reviewCompactAssignments } from '../worker/semantic-review.mjs';

globalThis.fetch = () => { throw Error('External requests forbidden in request-wrapper regression'); };
const question = '技術研究組合の特徴について教えてください';
const expected = ['技術研究組合', '特徴'];
for (const suffix of ['について教えてください', 'について教えてください。',
  'について詳しく教えてください？', 'に関して具体的に教えて下さい！']) {
  const prompt = '技術研究組合の特徴' + suffix;
  const plan = makePlan(prompt);
  assert.equal(plan.question, previousPlan(prompt).question,
    'The full question keeps its existing normalization and reaches semantic review');
  assert.deepEqual(plan.groups.map(g => g.text), expected);
  assert.deepEqual(plan.queries.slice(0, 2), ['技術研究組合 特徴', '技術研究組合']);
  assert.ok(plan.queries.every(query => !/教え|くだ|さい/.test(query)));
}
for (const topic of ['農業協同組合の役割', '共同利用施設の特徴', '説明義務の範囲']) {
  assert.deepEqual(makePlan(topic + 'について教えてください。').groups, makePlan(topic).groups,
    'No entity-specific or ministry-specific rewrite');
}
for (const substantive of ['子供に金融を教えてください', '伝統芸能の教えの継承を支援すべきではないか',
  '料金について利用者に説明してください', '学校で何を教えるべきか教えてください',
  '「制度について教えてください」という相談への対応',
  '技術研究組合について教えてください。組合員の責任も確認したい']) {
  assert.deepEqual(makePlan(substantive), previousPlan(substantive),
    'Do not delete substantive clauses or a request quoted within the question');
}
assert.deepEqual(makePlan(question, ['共同研究', '法人']).queries[0], '共同研究 法人');

function meeting(id, ask, answer) {
  return { issueID: id, date: '2021-01-01', nameOfMeeting: '合成回帰テスト', speechRecord: [
    { issueID: id, speechID: id + '_q', speechOrder: 1, speakerGroup: '合成会派',
      speech: ask, speechURL: 'https://kokkai.ndl.go.jp/txt/synthetic/' + id + '/q' },
    { issueID: id, speechID: id + '_a', speechOrder: 2, speakerPosition: '経済産業大臣',
      speech: answer, speechURL: 'https://kokkai.ndl.go.jp/txt/synthetic/' + id + '/a' },
  ] };
}
const target = meeting('synthetic-exact', '技術研究組合の特徴について伺います。',
  '技術研究組合は組合員が共同で技術に関する試験研究を行う法人です。');
const noise = Array.from({ length: 32 }, (_, i) => meeting('synthetic-noise-' + i,
  '地域振興の特徴について教えてください。',
  '地域振興の特徴について教えてくださいとの御質問にお答えします。'));
const meetings = [target, ...noise], plan = makePlan(question);
const old = reviewCandidates(meetings, previousPlan(question), 24);
const selected = reviewCandidates(meetings, plan, 24);
const exact = rows => rows.find(row => row.case_id.startsWith('synthetic-exact:'));
assert.equal(old.length, 24);
assert.equal(exact(old), undefined, 'Baseline reproduces the request-word distraction');
assert.equal(selected.length, 24, 'Keep the complete 24-slot shortlist budget');
assert.ok(exact(selected), 'The exact-target source survives the same distractors');
assert.equal(exact(selected).question, target.speechRecord[0].speech);
assert.equal(exact(selected).answer, target.speechRecord[1].speech);
assert.ok(selected.every(row => row.screening === 'unverified'));
assert.equal(scorePassage('技術研究組合の特徴は何でしょうか。', plan).supported, true);

// Partial compounds are still recall candidates, never automatically accepted.
// Do not impose an exact-word gate that loses aliases and contextual references.
const partial = reviewCandidates([meeting('synthetic-partial',
  '技術研究の特徴について伺います。', '技術研究の特徴を整理します。')], plan, 24);
assert.equal(partial.length, 1);
assert.equal(partial[0].screening, 'unverified');
assert.equal(scorePassage('技術研究の特徴について伺います。', plan).hits[0].coverage, 2 / 3);

const requests = [];
const retrieved = await retrieveFastAssignments(plan, async (resource, params) => {
  requests.push({ resource, ...params });
  return resource === 'speech' ? { speechRecord: [], numberOfRecords: 0 } : { meetingRecord: [] };
});
assert.ok(requests.length <= 3);
assert.deepEqual(requests.map(call => call.any), ['技術研究組合 特徴', '技術研究組合']);
assert.deepEqual(retrieved.shares, []);

let modelCalls = 0;
const reviewed = await reviewCompactAssignments(question,
  { review_candidates: selected, recent_since: '2024-01-01', errors: [], searched: [] },
  { CLOUDFLARE_WORKERS_PLAN: 'free', AI: { async run(model, payload) {
    modelCalls++;
    const input = JSON.parse(payload.messages[1].content);
    assert.equal(input.proposed_question, question);
    assert.equal(model, '@cf/openai/gpt-oss-20b');
    assert.equal(payload.reasoning_effort, undefined);
    assert.equal(payload.max_tokens, 3072);
    assert.equal(input.candidates.length, 8);
    return { response: { reviews: input.candidates.map(c => {
      const q = c.source_question || input.candidates.find(other => other.id === c.source_question_ref).source_question;
      const accept = Object.values(q).some(text => text.includes('技術研究組合'));
      return { id: c.id, beneficiary: accept ? '技術研究組合' : '地域の住民', activity: '共同で行う試験研究',
        relation: accept ? 'same' : 'different',
        comparison: accept ? '技術研究組合が共同で試験研究を行う仕組みを説明した答弁' : '地域住民への一般的な振興策であり質問の組合とは異なる',
        decision: accept ? 'accept' : 'reject', q: accept ? Object.keys(q)[0] : '',
        a: accept ? Object.keys(c.source_answer)[0] : '' };
    }) } };
  } } });
assert.equal(modelCalls, 3, 'The same initial 8-by-3 budget; no added verification/retries');
assert.equal(reviewed.reviewed_candidates, 24);
assert.equal(reviewed.pairs, 1);
assert.equal(reviewed.evidence[0].case_id, exact(selected).case_id);
assert.ok(reviewed.evidence[0].answer.includes(reviewed.evidence[0].answer_evidence));
console.log(JSON.stringify({ kind: 'offline terminal-request normalization regression',
  synthetic_meetings: 33, shortlist: 24, baseline_exact_retained: false, patched_exact_retained: true,
  model_calls_mocked: modelCalls, external_requests: 0, live_accuracy_or_latency_measured: false }));
