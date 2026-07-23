#!/usr/bin/env bash
# Mac: game server + unified gateway + one Cloudflare quick tunnel.
# Usage: npm run dev:tunnel  |  npm run start:tunnel
# Requires: cloudflared (brew install cloudflared)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SANCHASE_DEV="${SANCHASE_DEV:-0}"
export SANCHASE_DEV

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

log_status() {
  printf '%s\n' "$*" >&2
}

stop_stale_sanchase() {
  pkill -f "cloudflared tunnel --url http://127.0.0.1:$GATEWAY_PORT" 2>/dev/null || true
  for port in "$API_PORT" "$GATEWAY_PORT"; do
    local pids
    pids=$(lsof -ti "tcp:$port" 2>/dev/null || true)
    for pid in $pids; do
      local cmd
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ "$cmd" == *"game-server"* || "$cmd" == *"gateway-server"* || "$cmd" == *"tsx services/game-server"* || "$cmd" == *"tsx apps/web"* ]]; then
        echo "Stopping stale SanChase process on port $port (pid $pid)..."
        kill "$pid" 2>/dev/null || true
      else
        echo "Port $port is already in use by another app (pid $pid). Stop it or set SANCHASE_GATEWAY_PORT / SANCHASE_API_PORT." >&2
        exit 1
      fi
    done
  done
  sleep 1
}

wait_for_tunnel_url() {
  local log_file="$1"
  local url=""
  log_status "  Waiting for Cloudflare URL (usually 5–15 s)..."
  local i=0
  while [[ $i -lt 90 ]]; do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log_file" 2>/dev/null | tail -1 || true)"
    if [[ -n "$url" ]]; then
      printf '%s\n' "$url"
      return 0
    fi
    if grep -qiE ' ERR ' "$log_file" 2>/dev/null; then
      log_status "Cloudflare tunnel failed. See $log_file"
      tail -25 "$log_file" >&2 || true
      return 1
    fi
    sleep 1
    i=$((i + 1))
    if (( i % 5 == 0 )); then
      log_status "  …still waiting ($i s)"
    fi
  done
  log_status "Timed out waiting for tunnel URL. Log: $log_file"
  tail -25 "$log_file" >&2 || true
  return 1
}

wait_for_tunnel_ready() {
  local url="$1"
  log_status "  Checking tunnel responds (up to 15 s)..."
  local i=0
  while [[ $i -lt 15 ]]; do
    if curl -sf --connect-timeout 3 --max-time 5 "$url/health" >/dev/null 2>&1; then
      log_status "  Tunnel is ready."
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  log_status "  Tunnel URL is live but still warming up — open it now if needed."
  return 0
}

if [[ "$SANCHASE_DEV" == "1" ]]; then
  MODE_LABEL="dev (flyout, manual GPS, 2 players min)"
else
  MODE_LABEL="game day (live GPS)"
fi

stop_stale_sanchase

echo "Starting game server (port $API_PORT, $MODE_LABEL)..."
if [[ "$SANCHASE_DEV" == "1" ]]; then
  npm run dev:server >"$LOG_DIR/server.log" 2>&1 &
else
  NODE_ENV=production npm run start:server >"$LOG_DIR/server.log" 2>&1 &
fi
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

if ! curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null 2>&1; then
  echo "Gateway did not start. See $LOG_DIR/gateway.log"
  tail -30 "$LOG_DIR/gateway.log" || true
  exit 1
fi

echo "Opening Cloudflare tunnel..."
log_status "  Logs: $LOG_DIR"
cloudflared tunnel --url "http://127.0.0.1:$GATEWAY_PORT" >"$LOG_DIR/tunnel.log" 2>&1 &
TUNNEL_PID=$!
GAME_URL="$(wait_for_tunnel_url "$LOG_DIR/tunnel.log")"
wait_for_tunnel_ready "$GAME_URL" || true
log_status "  Share link:"

bash "$ROOT/scripts/mac/notify-link.sh" "$GAME_URL" || true

echo ""
echo "=============================================="
echo "  SanChase — share this link with players"
echo "  Mode: $MODE_LABEL"
echo "=============================================="
echo ""
echo "  $GAME_URL"
echo ""
echo "  Keep this terminal open while playing."
echo "  Link changes each restart."
echo "=============================================="
echo ""

tail -f /dev/null
