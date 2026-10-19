# v81 invalid relation investigation / proposed v82 diagnostics

## What the supplied evidence establishes

The supplied live diagnostic (2026-10-19T11:43:26.216Z) reports 24 initial candidates in three parallel eight-row batches, with completed counts 8/8, 8/8, 1/8. Seven structurally valid rows in the third batch have an unknown `relation` string. The exact strings and the question were not supplied. This is not proof that those seven candidates should have been accepted or rejected.

The first batch determines AI waiting time (21.112 s), not the invalid third batch (14.428 s). The additional scope check ended at +16.359 s. Retrieval took 9.857 s; total was 30.969 s. Fixing output validity alone would not necessarily shorten this particular run.

The receiver's first-error order means zero accepted-reference/role counters do not prove those later checks would have passed for the seven invalid rows.

## Contract and persistence audit

Both initial and scope prompts already specify the same five relations as the schema and receiver: `same`, `broader`, `provider_only`, `different`, `unclear`. No spelling mismatch was found. The compact request sends `response_format: {type:'json_object'}`; its local enum schema is used in the cache identity but not transmitted as a constrained generation schema.

The source does not log raw responses. Invalid rows become generic pending records. Incomplete batches are excluded from the seven-day review cache, and partial analyses from the whole-analysis edge cache. The short in-process cache contains processed results, not the discarded field values. Thus the supplied diagnostic and repository cannot recover the previous seven strings. No private Cloudflare log access was assumed or attempted.

## Official provider documentation checked 2026-10-19

- https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/ lists the `response_format` parameter, but provides no strict enum guarantee in the readable model documentation.
- https://developers.cloudflare.com/workers-ai/features/json-mode/ describes `json_schema` and expressly warns that schema satisfaction is not guaranteed. Its current supported-model list does not name gpt-oss-20b. This discrepancy is insufficient to declare the model unsupported, and it is also insufficient to promise strict constrained decoding.
- The model's Markdown documentation could not be read: the web reader rejected its content type and an ordinary HTTP request returned 403. That URL was not retried or bypassed.

Historical v70–v72 records in this repository include schema-mode blank output and timeouts; those trials are not controlled evidence of a schema bug, but they do not justify an untested switch back. No live provider call was made.

## Proposed change: observations only

Keep requests, prompts, model, candidate ordering/maximum 24, source ownership, timeout, generation caps, failure semantics and cache identities unchanged. Add only five mutually exclusive integer counters for invalid relation strings:

- `blank`: empty or whitespace-only string
- `surrounding_whitespace`: trimming yields exactly one existing valid relation
- `letter_case`: after trimming, lowercasing yields a valid relation (the UI explicitly says surrounding whitespace may also be present)
- `decision_code`: trimming yields exactly `accept`, `reject` or `uncertain`
- `other`: every other invalid string

These are diagnostic categories, not repairs. None of the invalid values becomes a valid judgement. Arbitrary model text is never copied, persisted, hashed for display, or logged. Fixed-key nonnegative integer allowlists protect the phone-readable/copyable diagnostic. A valid run has no extra detail object. Older records without this object remain readable.

A separate experimental extra prompt sentence was considered and excluded from this patch. Wording changes would be an unverified intervention; strict-schema behaviour and the previous seven values are unknown. No causal speed or completeness improvement is claimed for the diagnostic change.

## Verification

`npm test` and `npm run build` run offline. The new test exercises blank, whitespace, casing, decision-code, unrelated, non-ASCII, oversized, markup and secret-like invalid strings, plus wrong types and existing validation precedence. A synthetic 8/8 + 8/8 + 1/8 response reproduces 17/24 without inventing the live values. Valid batches alone are cached; only the failed batch runs on a later normal request, with no automatic retry. Additional scope requests use the same diagnostic behaviour.

An optional `--baseline` source comparison against exact public v81 verifies byte-identical outgoing AI requests and review-cache keys, and identical non-diagnostic results. The existing receiver regression independently verifies unchanged requests. Frontend tests assert that only fixed numeric fields reach the DOM and diagnostic copy; arbitrary keys/values and malformed numbers are excluded.

The public version metadata is advanced to v82 so a future deployment can be identified. This invalidates whole-analysis versioned entries, while identical validated semantic batches retain their exact cache keys. A fresh real query can still consume the usual free-model budget; this patch adds no model call, retry or paid fallback. It does not retroactively reveal the seven missing values.

## Acceptance and stopping condition

Publication requires approval. After publication, use the next ordinary result's existing diagnostic, without asking for repeated experimental searches. If `invalid_relation` occurs again, its five counters must sum to that count. A formatting-only category could support a narrowly tested future repair; `decision_code` or `other` requires further evidence rather than guessing a semantic classification. A clean run alone does not prove the model's recurring output failure is fixed. If the failure does not recur, do not spend extra calls just to obtain it.
