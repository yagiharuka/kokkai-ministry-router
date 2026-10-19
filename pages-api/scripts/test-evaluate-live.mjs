// Exercise the actual evaluation script with HTTP and AI responses mocked.
// No credentials or external requests are used. Timings are intentionally fake.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const partial = process.argv.includes('--partial');
const recorderFaults = process.argv.includes('--recorder-faults');
const directory = await mkdtemp(join(tmpdir(), 'kokkai-evaluation-'));
const output = join(directory, 'report.json');
const saved = { fetch: globalThis.fetch, now: Date.now, argv: process.argv, log: console.log,
  plan: process.env.CLOUDFLARE_WORKERS_PLAN, token: process.env.CLOUDFLARE_API_TOKEN,
  account: process.env.CLOUDFLARE_ACCOUNT_ID };
let now = Date.now(), aiCalls = 0, sourceCalls = 0, consumedResponses = 0;
Date.now = () => (now += 3100);
const issueID = 'offline-evaluation-fixture';
const meeting = { issueID, date: '2026-05-01', nameOfMeeting: '文教委員会', speechRecord: [
  { issueID, speechID: issueID + '_001', speechOrder: 1, speakerGroup: '会派',
    speech: '学校の先生の長時間労働を是正するため、勤務負担を軽減するには。',
    speechURL: 'https://kokkai.ndl.go.jp/txt/offline-evaluation-fixture/1' },
  { issueID, speechID: issueID + '_002', speechOrder: 2, speaker: '答弁者', speakerPosition: '文部科学大臣',
    speech: '学校の先生の長時間労働を減らすため支援員を配置します。',
    speechURL: 'https://kokkai.ndl.go.jp/txt/offline-evaluation-fixture/2' },
] };
meeting.speechRecord.push(...meeting.speechRecord.map(row => ({ ...row, speechOrder: row.speechOrder + 2,
  speechID: row.speechID + '-second', speechURL: row.speechURL + '-second' })));
process.env.CLOUDFLARE_WORKERS_PLAN = 'free';
process.env.CLOUDFLARE_API_TOKEN = 'offline-test-not-a-real-credential';
process.env.CLOUDFLARE_ACCOUNT_ID = '0'.repeat(32);
process.argv = ['node', 'evaluate-live.mjs', output, '教員', ...(partial ? ['医療機器'] : [])];
// Do not print the deliberately fake stopwatch values as performance evidence.
console.log = () => {};
const privateDetail = 'provider-private-detail-must-not-be-recorded';
function providerResponse(body) {
  body.errors = [{ code: 9999, message: privateDetail }, { code: { privateDetail } }];
  body.privateDetail = privateDetail;
  if (body.result.usage) body.result.usage.privateDetail = privateDetail;
  const response = Response.json(body);
  const read = response.json;
  response.json = function () {
    assert.equal(this, response, 'The worker must receive the original response');
    consumedResponses++;
    return read.call(this);
  };
  if (recorderFaults) {
    // These faults affect only the recorder's clone. The actual model response
    // remains valid and must be returned, without a retry or missing evidence.
    if (aiCalls === 1) response.clone = () => { throw new Error(privateDetail); };
    else if (aiCalls === 2) response.clone = () => new Response(privateDetail);
    else response.clone = () => Response.json({ ...body, errors: { privateDetail } });
  }
  return response;
}
globalThis.fetch = async (url, init) => {
  const address = new URL(url);
  if (address.hostname === 'kokkai.ndl.go.jp') {
    sourceCalls++;
    const rewritten = ['教師 勤務負担', '教員 勤務時間'].includes(address.searchParams.get('any'));
    return Response.json(rewritten ? (address.pathname.endsWith('/meeting') ?
      { meetingRecord: [meeting] } : { speechRecord: meeting.speechRecord, numberOfRecords: meeting.speechRecord.length }) :
      { speechRecord: [], meetingRecord: [], numberOfRecords: 0 });
  }
  assert.equal(address.hostname, 'api.cloudflare.com', 'Unexpected outgoing host');
  aiCalls++;
  const payload = JSON.parse(init.body);
  if (payload.response_format.json_schema?.properties?.queries) {
    return providerResponse({ success: true, result: { response: { queries: ['教師 勤務負担', '教員 勤務時間'] } } });
  }
  assert.equal(payload.response_format.type, 'json_object');
  const input = JSON.parse(payload.messages[1].content);
  const reviews = input.candidates.map(candidate => ({
    id: candidate.id, beneficiary: '学校の先生', activity: '学校の教育業務', relation: 'same',
    comparison: '学校の先生の長時間労働に対して支援員の配置を示す答弁', decision: 'accept',
    q: Object.keys(candidate.source_question || input.candidates.find(row => row.id === candidate.source_question_ref).source_question)[0],
    a: Object.keys(candidate.source_answer)[0],
  }));
  const selected = partial && !payload.messages[0].content.includes('この判定は、') ? reviews.slice(0, 1) : reviews;
  return providerResponse({ success: true, result: { response: { reviews: selected }, usage: { prompt_tokens: 1000, completion_tokens: 200 } } });
};
const mockedFetch = globalThis.fetch;
try {
  await import('./evaluate-live.mjs');
  const serialized = await readFile(output, 'utf8');
  const report = JSON.parse(serialized);
  assert.equal(report.results.length, 1);
  const result = report.results[0];
  assert.equal(result.result.assessment_status, 'reviewed');
  assert.equal(result.result.assessment_error, partial ? 'model_unavailable' : undefined, 'Record only real mocked review failures, not instrumentation failures');
  assert.equal(result.result.pairs, partial ? 1 : 2);
  if (partial) {
    assert.equal(result.result.assessment_partial, true);
    assert.match(report.stopped_reason, /remaining cases were not attempted/);
  } else {
    assert.equal(result.result.assessment_partial, undefined);
    assert.equal(report.stopped_reason, undefined);
  }
  assert.equal(aiCalls, 3, 'One plan, one initial review, one scope review; no retries');
  assert.equal(consumedResponses, aiCalls, 'All original response bodies remain readable by the worker');
  assert.deepEqual(result.model_calls.map(call => call.operation), ['search_plan', 'compact_review', 'scope_check']);
  assert.equal(result.model_calls.filter(call => call.usage).length, recorderFaults ? 1 : 2);
  for (const call of result.model_calls.filter(call => call.usage)) {
    assert.deepEqual(call.usage, { prompt_tokens: 1000, completion_tokens: 200 });
  }
  if (recorderFaults) {
    assert.deepEqual(result.model_calls.map(call => call.recording_error), ['metadata_unavailable', 'metadata_unavailable', undefined]);
    assert.deepEqual(result.model_calls[2].error_codes, [], 'Non-array provider errors cannot break recording');
  } else {
    assert.ok(result.model_calls.every(call => call.recording_error === undefined));
    assert.ok(result.model_calls.every(call => JSON.stringify(call.error_codes) === '[9999]'));
  }
  assert.ok(result.model_calls.every(call => call.http_status === 200));
  assert.ok(!serialized.includes(privateDetail), 'Never record raw provider or recorder error messages');
  assert.ok(!serialized.includes('offline-test-not-a-real-credential'), 'Never record authorization headers');
  assert.ok(!serialized.includes('0'.repeat(32)), 'Redact the account ID from request paths');
  assert.equal(globalThis.fetch, mockedFetch, 'The evaluator restores the fetch it wrapped');
  assert.ok(sourceCalls > 0);
  saved.log('Live evaluation recorder: ' + (partial ? 'partial-review stop' : recorderFaults ? 'metadata-fault isolation and allowlisted diagnostics' : 'successful three-stage recording') + ' passed. Mocked upstream and clock only; no live performance measured.');
} finally {
  console.log = saved.log;
  globalThis.fetch = saved.fetch;
  Date.now = saved.now;
  process.argv = saved.argv;
  for (const [key, value] of [['CLOUDFLARE_WORKERS_PLAN', saved.plan], ['CLOUDFLARE_API_TOKEN', saved.token], ['CLOUDFLARE_ACCOUNT_ID', saved.account]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
}
