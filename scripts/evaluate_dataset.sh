#!/usr/bin/env bash
set -euo pipefail

python -m router.ministry_router evaluate --data data/labeled_pairs.jsonl
