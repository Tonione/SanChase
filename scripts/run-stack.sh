#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SANCHASE_DEV="${SANCHASE_DEV:-0}"
export SANCHASE_DEV

if [[ "$SANCHASE_DEV" == "1" ]]; then
  echo "SanChase stack (dev client: flyout + manual GPS)"
  npm run dev:server &
else
  echo "SanChase stack (production client: live GPS)"
  NODE_ENV=production npm run start:server &
fi

npm run dev:gateway &
wait
