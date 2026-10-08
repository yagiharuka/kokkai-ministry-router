#!/usr/bin/env bash
set -euo pipefail

python -m router.ministry_router collect \
  --keyword "半導体" \
  --keyword "医療機器" \
  --keyword "労働" \
  --keyword "教育" \
  --keyword "農業" \
  --keyword "防衛" \
  --keyword "デジタル" \
  --keyword "エネルギー" \
  --limit 20 \
  --out data/labeled_pairs.jsonl

