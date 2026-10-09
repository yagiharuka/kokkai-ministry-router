// Explicit, paid integration evaluation. Never run as part of npm test.
// node --env-file=.env.local scripts/evaluate-live.mjs [output.json] [question filters...]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import worker from '../worker/model-api.js';
import { semanticConfiguration } from '../worker/semantic-review.mjs';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const questions = [
  'スタートアップ界の女性活躍推進を進めるべきではないか',
  '半導体産業の国内生産を支援すべきではないか',
  '教員の長時間労働を是正すべきではないか',
  '医療機器の承認審査を迅速化すべきではないか',
  '農産物の輸出を拡大すべきではないか',
  'なでしこ銘柄の推進を進めるべきではないか',
];
const output = resolve(process.argv[2] || 'evaluation/semantic-live-20261009.json');
const selected = process.argv.length > 3 ? questions.filter(question => process.argv.slice(3).some(term => question.includes(term))) : questions;
const report = { evaluated_at: new Date().toISOString(), model: semanticConfiguration(process.env).model,
  note: 'Small integration sample, including development examples. Not an independent accuracy benchmark.', results: [] };
const originalFetch = globalThis.fetch;
let calls = [], network = [];
globalThis.fetch = async (url, init) => {
  const started = Date.now();
  const response = await originalFetch(url, init);
  const target = new URL(url);
  network.push({ service: target.hostname, path: target.pathname, duration_ms: Date.now() - started,
    query: target.searchParams.get('any') || undefined, issue: target.searchParams.get('issueID') || undefined });
  if (String(url) === 'https://api.openai.com/v1/responses') {
    const body = await response.clone().json().catch(() => ({}));
    const request = JSON.parse(init.body);
    const text = (body.output || []).flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text;
    calls.push({ operation: request.text.format.name, http_status: response.status, duration_ms: Date.now() - started,
      usage: body.usage, status: body.status, error_code: body.error?.code,
      input: JSON.parse(request.input[0].content),
      output: text ? JSON.parse(text) : undefined });
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
    if (calls.some(call => ['credit_balance_exhausted', 'insufficient_quota'].includes(call.error_code))) {
      report.stopped_reason = 'API credit exhaustion; remaining cases were not attempted.';
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      break;
    }
  }
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ report: output }));
