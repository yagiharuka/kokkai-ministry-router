// Explicit Workers Free integration evaluation. Never run live as part of npm test.
// test-evaluate-live.mjs exercises this file only with mocked HTTP and credentials.
// node --env-file=.env.local scripts/evaluate-live.mjs [output.json] [question filters...]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import worker from '../worker/model-api.js';
import { semanticConfiguration } from '../worker/semantic-review.mjs';

if (!semanticConfiguration(process.env).ready) throw new Error('Verified Workers Free account and server-side Cloudflare credentials are required');
const questions = [
  'スタートアップ界の女性活躍推進を進めるべきではないか',
  '半導体産業の国内生産を支援すべきではないか',
  '教員の長時間労働を是正すべきではないか',
  '医療機器の承認審査を迅速化すべきではないか',
  '農産物の輸出を拡大すべきではないか',
  'なでしこ銘柄の推進を進めるべきではないか',
];
const output = resolve(process.argv[2] || 'evaluation/cloudflare-live.json');
const selected = process.argv.length > 3 ? questions.filter(question => process.argv.slice(3).some(term => question.includes(term))) : questions;
const report = { evaluated_at: new Date().toISOString(), model: semanticConfiguration(process.env).model,
  note: 'Small integration sample, including development examples. Not an independent accuracy benchmark.', results: [] };
const originalFetch = globalThis.fetch;
let calls = [], network = [];
globalThis.fetch = async (url, init) => {
  const started = Date.now();
  const response = await originalFetch(url, init);
  let call;
  try {
    const target = new URL(url instanceof Request ? url.url : url);
    network.push({ service: target.hostname, path: target.pathname.replace(/\/accounts\/[^/]+/, '/accounts/[redacted]'), duration_ms: Date.now() - started,
      query: target.searchParams.get('any') || undefined, issue: target.searchParams.get('issueID') || undefined });
    if (target.hostname === 'api.cloudflare.com') {
      call = { operation: 'unknown', http_status: response.status, duration_ms: Date.now() - started };
      calls.push(call);
      const request = JSON.parse(init?.body);
      // Current reviews use JSON-object mode, without json_schema.
      const isPlan = Boolean(request.response_format?.json_schema?.properties?.queries);
      const isScope = String(request.messages?.[0]?.content || '').includes('この判定は、');
      call.operation = isPlan ? 'search_plan' : isScope ? 'scope_check' :
        request.response_format?.type === 'json_object' ? 'compact_review' : 'context_review';
      call.input = JSON.parse(request.messages?.[1]?.content);
      const body = await response.clone().json();
      // Keep only known numeric usage fields and provider codes. Never copy
      // arbitrary response fields, provider messages, or request headers.
      if (body?.result?.usage && typeof body.result.usage === 'object') {
        call.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']
          .filter(key => Number.isSafeInteger(body.result.usage[key]) && body.result.usage[key] >= 0)
          .map(key => [key, body.result.usage[key]]));
      }
      call.success = typeof body?.success === 'boolean' ? body.success : undefined;
      call.error_codes = (Array.isArray(body?.errors) ? body.errors : [])
        .map(error => error?.code).filter(code => Number.isSafeInteger(code));
      call.duration_ms = Date.now() - started;
    }
  } catch {
    // Recording is best-effort: a metadata fault must never replace the
    // upstream response with a model error. Only a fixed diagnostic is saved.
    if (call) call.recording_error = 'metadata_unavailable';
    else network.push({ recording_error: 'metadata_unavailable' });
  }
  return response;
};
try {
  for (const question of selected) {
    calls = []; network = [];
    const started = Date.now();
    console.log(JSON.stringify({ event: 'started', question }));
    const response = await worker.fetch(new Request('https://example.invalid/api/cases?' + new URLSearchParams({ question })), process.env);
    const result = await response.json();
    report.results.push({ question, http_status: response.status, duration_ms: Date.now() - started, model_calls: calls, network, result });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'completed', question, status: result.assessment_status,
      pairs: result.pairs, shares: result.shares, reviewed: result.reviewed_candidates,
      accepted: result.accepted_candidates, errors: result.errors, duration_ms: Date.now() - started }));
    if (result.assessment_status === 'failed' || result.assessment_error || result.assessment_partial) {
      report.stopped_reason = (result.assessment_error || 'partial_assessment') + '; remaining cases were not attempted.';
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      break;
    }
  }
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ report: output }));
