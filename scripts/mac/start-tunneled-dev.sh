#!/usr/bin/env bash
# Mac dev: game server + unified gateway + one Cloudflare quick tunnel.
# Usage: npm run dev:tunnel
# Requires: cloudflared (brew install cloudflared)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

API_PORT="${SANCHASE_API_PORT:-8787}"
GATEWAY_PORT="${SANCHASE_GATEWAY_PORT:-8080}"
LOG_DIR="${TMPDIR:-/tmp}/sanchase-tunnel-$$"
mkdir -p "$LOG_DIR"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it with:"
  echo "  brew install cloudflared"
  exit 1
fi

cleanup() {
  echo ""
  echo "Stopping SanChase..."
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${GATEWAY_PID:-}" ]] && kill "$GATEWAY_PID" 2>/dev/null || true
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT INT TERM

wait_for_tunnel_url() {
  local log_file="$1"
  local i=0
  while [[ $i -lt 90 ]]; do
    if grep -qE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_file" 2>/dev/null; then
      grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_file" | tail -1
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "Timed out waiting for tunnel URL. Log:" >&2
  tail -20 "$log_file" >&2 || true
  return 1
}

echo "Starting game server (port $API_PORT)..."
npm run dev:server >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
  echo "Game server did not start. See $LOG_DIR/server.log"
  tail -30 "$LOG_DIR/server.log" || true
  exit 1
fi

echo "Starting gateway (port $GATEWAY_PORT, web + /ws)..."
SANCHASE_API_PORT="$API_PORT" SANCHASE_GATEWAY_PORT="$GATEWAY_PORT" npm run dev:gateway >"$LOG_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!

for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Opening Cloudflare tunnel..."
cloudflared tunnel --url "http://127.0.0.1:$GATEWAY_PORT" >"$LOG_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!
GAME_URL="$(wait_for_tunnel_url "$LOG_DIR/tunnel.log")"

bash "$ROOT/scripts/mac/notify-link.sh" "$GAME_URL" || true

echo ""
echo "=============================================="
echo "  SanChase — share this link with players"
echo "=============================================="
echo ""
echo "  $GAME_URL"
echo ""
echo "  Keep this terminal open while playing."
echo "  Link changes each restart."
echo "=============================================="
echo ""

tail -f /dev/null
