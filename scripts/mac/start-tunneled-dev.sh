#!/usr/bin/env bash
# Back-compat wrapper — use npm run dev:tunnel or start-tunnel.sh directly.
SANCHASE_DEV=1 exec "$(dirname "$0")/start-tunnel.sh"
