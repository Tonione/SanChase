#!/usr/bin/env bash
# Send the SanChase tunnel link via configured channels (free options).
# Usage: notify-link.sh "https://….trycloudflare.com"
# Configure in .env (see .env.example).

set -euo pipefail

LINK="${1:?link required}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

MSG="SanChase est prêt — $LINK"
SENT=0

try_slack() {
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return 1
  MSG="$MSG" python3 -c '
import json, os, urllib.request
payload = json.dumps({"text": os.environ["MSG"]}).encode()
req = urllib.request.Request(os.environ["SLACK_WEBHOOK_URL"], data=payload, headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=15)
' 
}

try_ntfy() {
  [[ -z "${NTFY_TOPIC:-}" ]] && return 1
  local server="${NTFY_SERVER:-https://ntfy.sh}"
  curl -sf -X POST \
    -H "Title: SanChase" \
    -H "Tags: game_controller" \
    -H "Priority: high" \
    -d "$MSG" \
    "$server/$NTFY_TOPIC" >/dev/null
}

try_telegram() {
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]] && return 1
  curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=$MSG" >/dev/null
}

try_whatsapp() {
  [[ -z "${WHATSAPP_PHONE:-}" ]] && return 1
  local encoded
  encoded="$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$MSG'''))")"
  if [[ "$(uname)" == "Darwin" ]]; then
    open "https://wa.me/${WHATSAPP_PHONE}?text=${encoded}" 2>/dev/null
  else
    echo "  WhatsApp: https://wa.me/${WHATSAPP_PHONE}?text=${encoded}"
  fi
}

mac_clipboard() {
  [[ "$(uname)" != "Darwin" ]] && return 0
  printf '%s' "$LINK" | pbcopy
  osascript -e "display notification \"Lien copié dans le presse-papiers\" with title \"SanChase\" subtitle \"${LINK:0:60}…\"" 2>/dev/null || true
}

echo "Notifications:"

if try_slack 2>/dev/null; then
  echo "  ✓ Slack"
  SENT=1
fi

if try_ntfy 2>/dev/null; then
  echo "  ✓ ntfy (push mobile)"
  SENT=1
fi

if try_telegram 2>/dev/null; then
  echo "  ✓ Telegram"
  SENT=1
fi

if [[ -n "${WHATSAPP_PHONE:-}" ]]; then
  try_whatsapp 2>/dev/null || true
  echo "  ✓ WhatsApp ouvert (appuyez sur Envoyer)"
  SENT=1
fi

if [[ "${SANCHASE_NOTIFY_CLIPBOARD:-1}" == "1" ]]; then
  mac_clipboard
  echo "  ✓ Presse-papiers + notification Mac"
fi

if [[ $SENT -eq 0 && "${SANCHASE_NOTIFY_CLIPBOARD:-1}" != "1" ]]; then
  echo "  (aucun canal configuré — voir .env.example)"
fi
