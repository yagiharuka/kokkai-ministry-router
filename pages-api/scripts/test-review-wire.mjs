// Offline protocol tests. AI generation and retrieval helpers are stubbed.
// This checks parsing, source ownership and call counts, NOT semantic accuracy
// or Cloudflare latency. Run: node pages-api/scripts/test-review-wire.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile } from 'node:fs/promises';

let checks = 0;
const check = (name, body) => { body(); checks++; console.log('PASS ' + name); };
const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
function loadReviewer(source) {
  const context = vm.createContext({
    console, setTimeout, clearTimeout, fetch: () => { throw Error('Network forbidden in offline tests'); },
    Response, AbortSignal, TextEncoder,
    normalize: norm,
    // The fixture fixes an already-selected, single-target 24-row shortlist.
    // Actual retrieval/ranking is deliberately outside this protocol test.
    makePlan: () => ({ groups: [{ text: '教員', role: 'subject' }] }),
    concepts: () => [],
    diversifyCandidates: (rows, limit) => rows.slice(0, limit),
    needsFullPlenaryContext: () => false,
    runCacheWrite: async () => false,
    summarize(rows) {
      const byCase = new Map();
      for (const row of rows) {
        if (!byCase.has(row.case_id)) byCase.set(row.case_id, new Set());
        byCase.get(row.case_id).add(row.ministry);
      }
      const weights = new Map();
      for (const ministries of byCase.values()) for (const ministry of ministries) {
        weights.set(ministry, (weights.get(ministry) || 0) + 1 / ministries.size);
      }
      return { pairs: byCase.size, shares: [...weights].map(([ministry, weight]) => ({
        ministry, percent: Math.round(weight / byCase.size * 100), count: weight,
      })) };
    },
  });
  const stripped = source.replace(/^import [^\n]+;\n/gm, '').replace(/^export /gm, '');
  new vm.Script(stripped + '\n;globalThis.testAPI={reviewCompactAssignments, completeUnusedReviewRefs:typeof completeUnusedReviewRefs===\'function\'?completeUnusedReviewRefs:null};', { filename: 'semantic-review.mjs' }).runInContext(context);
  return context.testAPI;
}
const source = await readFile(new URL('../worker/semantic-review.mjs', import.meta.url), 'utf8');
const api = loadReviewer(source);
const accept = () => ({ id: 'c1', beneficiary: '教員', activity: '学校の教育業務', relation: 'same', comparison: '教員の勤務時間を減らすため支援員を配置する答弁', decision: 'accept', q: 'q1', a: 'v1a1' });
const negative = decision => ({ ...accept(), relation: decision === 'uncertain' ? 'unclear' : 'different', decision, comparison: '原文の施策対象は別の活動分野であり、この問いとは異なる' });
const plain = value => JSON.parse(JSON.stringify(value));

for (const decision of ['reject', 'uncertain']) {
  for (const omissions of [['q'], ['a'], ['q', 'a']]) {
    const row = negative(decision); row.q = ''; row.a = '';
    for (const field of omissions) delete row[field];
    const before = JSON.stringify(row), result = api.completeUnusedReviewRefs(Object.freeze(row));
    check(`${decision}: missing ${omissions.join('/')} gains empty unused fields only`, () => {
      assert.deepEqual(plain(result), { ...row, q: '', a: '' });
      assert.equal(JSON.stringify(row), before);
    });
  }
}
for (const field of ['id', 'beneficiary', 'activity', 'relation', 'comparison', 'decision']) {
  const row = negative('reject'); delete row[field]; delete row.q; delete row.a;
  check('Never reconstruct missing semantic field ' + field, () => assert.equal(api.completeUnusedReviewRefs(row), row));
}
for (const field of ['q', 'a']) {
  const row = accept(); delete row[field];
  check('Never reconstruct an accepted reference ' + field, () => assert.equal(api.completeUnusedReviewRefs(row), row));
}
for (const bad of [null, [], 'reject', 1, true,
    { ...negative('reject'), q: 0 }, { ...negative('uncertain'), a: null },
    { ...negative('reject'), unexpected: 'x' }, { ...negative('reject'), comparison: {} },
    { ...negative('reject'), decision: 'REJECT' }]) {
  check('Malformed values are not repaired: ' + JSON.stringify(bad), () => assert.equal(api.completeUnusedReviewRefs(bad), bad));
}
const full = negative('reject'); full.q = ''; full.a = '';
check('Legacy full eight-field responses are unchanged', () => assert.equal(api.completeUnusedReviewRefs(full), full));

const rows = Array.from({ length: 24 }, (_, i) => ({
  case_id: 'fixture:' + i, ministry: '文部科学省', position: '文部科学大臣', meeting: '委員会',
  date: '2025-05-01', question: '教員の勤務時間をどう減らしますか。',
  answer: '教員の勤務時間を減らすため支援員を配置します。',
  url: 'https://kokkai.ndl.go.jp/txt/fixture/' + i, retrieval_score: 1,
}));
const input = selected => ({ review_candidates: selected, candidates: [], errors: [], searched: [], recent_since: '2024-01-01' });
async function run24(reviewer, omitUnused, alter) {
  let calls = 0, active = 0, peak = 0; const outputRows = [], payloads = [];
  const env = { CLOUDFLARE_WORKERS_PLAN: 'free', AI: { run: async (model, payload) => {
    const batch = calls++; active++; peak = Math.max(peak, active); payloads.push(payload);
    assert.equal(model, '@cf/openai/gpt-oss-20b');
    assert.equal(payload.reasoning_effort, undefined);
    const data = JSON.parse(payload.messages[1].content);
    assert.equal(data.candidates.length, 8);
    const reviews = data.candidates.map((c, i) => {
      const isAccept = i === 0 || (batch === 0 && i === 1);
      const row = isAccept ? accept() : negative('reject'); row.id = c.id;
      if (!isAccept) { row.q = ''; row.a = ''; }
      if (omitUnused && i >= 6) { delete row.q; delete row.a; }
      return row;
    });
    if (alter) alter(reviews, batch);
    outputRows.push(...reviews);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { response: { reviews } };
  } } };
  const result = await reviewer.reviewCompactAssignments('教員の勤務時間を減らすための対策', input(rows), env);
  return { result: plain(result), calls, peak, outputRows, payloads };
}
const legacy = await run24(api, false), compact = await run24(api, true);
check('Six omitted UNUSED citation pairs no longer lose six reviews', () => {
  assert.equal(compact.result.reviewed_candidates, 24);
  assert.equal(compact.result.uncertain_candidates, 0);
  assert.equal(compact.result.assessment_partial, undefined);
  assert.equal(compact.result.review_diagnostics.reduce((n, d) => n + d.omitted_unused_refs, 0), 6);
  assert.equal(compact.calls, 3); assert.equal(compact.peak, 3);
  assert.equal(compact.result.pairs, 4);
  assert.deepEqual(compact.result.shares, legacy.result.shares);
  assert.deepEqual(compact.result.evidence, legacy.result.evidence);
});
check('Fixture output is smaller without changing semantic fields', () => {
  assert.equal(JSON.stringify(legacy.outputRows).length - JSON.stringify(compact.outputRows).length, 84);
});
const missingAccepted = await run24(api, true, (reviews, batch) => { if (batch === 0) delete reviews[0].q; });
check('Missing accepted evidence remains incomplete, without a retry', () => {
  assert.equal(missingAccepted.result.reviewed_candidates, 23);
  assert.equal(missingAccepted.result.pairs, 3);
  assert.equal(missingAccepted.result.assessment_partial, true);
  assert.equal(missingAccepted.calls, 3);
});
const unknownRef = await run24(api, true, (reviews, batch) => { if (batch === 0) reviews[0].a = 'v1a999'; });
check('Invented accepted source reference still cannot enter shares', () => {
  assert.equal(unknownRef.result.pairs, 3);
  assert.equal(unknownRef.result.uncertain_candidates, 1);
});
const duplicate = await run24(api, true, (reviews, batch) => { if (batch === 0) reviews.push({ ...reviews[0] }); });
check('Duplicate accepted candidate still cannot enter shares', () => {
  assert.equal(duplicate.result.pairs, 3);
  assert.equal(duplicate.result.uncertain_candidates, 1);
  assert.equal(duplicate.calls, 3);
});
const contradictory = await run24(api, true, (reviews, batch) => { if (batch === 0) reviews[0].relation = 'provider_only'; });
check('Contradictory acceptance remains held', () => {
  assert.equal(contradictory.result.pairs, 3);
  assert.equal(contradictory.result.uncertain_candidates, 1);
});
const omitted = await run24(api, true, (reviews, batch) => { if (batch === 0) reviews.pop(); });
check('A missing candidate is not synthesized to inflate completion', () => {
  assert.equal(omitted.result.reviewed_candidates, 23);
  assert.equal(omitted.result.assessment_partial, true);
});
const blank = await run24(api, true, (reviews, batch) => { if (batch === 0) reviews[7].comparison = ''; });
check('A missing comparison remains incomplete', () => {
  assert.equal(blank.result.reviewed_candidates, 23);
  assert.equal(blank.result.assessment_partial, true);
});
let baseline = null;
const i = process.argv.indexOf('--baseline');
if (i >= 0) {
  if (!process.argv[i + 1]) throw Error('--baseline requires a source path');
  baseline = await run24(loadReviewer(await readFile(process.argv[i + 1], 'utf8')), true);
  check('Actual v79 source reproduces 18/24 on the constructed omission fixture', () => {
    assert.equal(baseline.result.reviewed_candidates, 18);
    assert.equal(baseline.result.uncertain_candidates, 6);
    assert.equal(baseline.result.pairs, 4);
    assert.deepEqual(baseline.result.evidence, compact.result.evidence);
  });
}
const report = {
  checked: checks,
  test_kind: 'offline protocol/integration fixture; retrieval helpers and AI are stubbed',
  baseline_reviewed: baseline?.result.reviewed_candidates ?? null,
  patched_reviewed: compact.result.reviewed_candidates,
  accepted_cases: compact.result.pairs,
  model_calls: compact.calls,
  initial_peak_concurrency: compact.peak,
  output_chars_saved_in_six_omissions: 84,
  external_requests: 0,
  caveats: [
    'This fixture is NOT the recorded six live failures; their detailed reasons were not saved.',
    'No Cloudflare latency, neuron savings, or semantic recall improvement is established.',
    'The rest of the existing project suite must run before merging this change.'
  ],
};
console.log('REVIEW_WIRE_REPORT ' + JSON.stringify(report));
const j = process.argv.indexOf('--report');
if (j >= 0) await writeFile(process.argv[j + 1], JSON.stringify(report, null, 2) + '\n');
