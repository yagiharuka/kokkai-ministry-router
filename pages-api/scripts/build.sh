#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$root/dist/server" "$root/dist/.openai"
node "$root/scripts/build-core.mjs" "$@"
if [[ -f "$root/.openai/hosting.json" ]]; then
  cp "$root/.openai/hosting.json" "$root/dist/.openai/hosting.json"
fi
