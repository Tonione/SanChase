# Mac + Cloudflare Tunnel (no Oracle VM)

Run SanChase on your Mac and share a **public HTTPS link** with phones (4G or any Wi‑Fi). Free, no Oracle VM needed.

## One-time setup

```bash
brew install cloudflared
npm install   # in repo root, if not done yet
```

### Optional: auto-send the link to your phone

Copy `.env.example` → `.env` and configure **one** channel:

| Channel | Setup (5 min) |
|---------|----------------|
| **ntfy** (recommended) | Install [ntfy app](https://ntfy.sh), subscribe to a secret topic, set `NTFY_TOPIC=your-topic` in `.env` |
| **Slack** | Slack → Apps → Incoming Webhooks → copy URL → `SLACK_WEBHOOK_URL=…` in `.env` |
| **Telegram** | Message [@BotFather](https://t.me/BotFather), get token + chat id → `.env` |
| **WhatsApp** | Set `WHATSAPP_PHONE=336…` — opens WhatsApp with the link pre-filled (tap Send) |

Every tunnel start also **copies the link to your clipboard** and shows a Mac notification.

## Start

| When | Command |
|------|---------|
| Testing / rehearsal | `npm run dev:tunnel` |
| Game day (D-day) | `npm run start:tunnel` |

Both print a public **HTTPS link** (~30 s after launch), for example:

```
https://sanchase-demo.trycloudflare.com
```

Send that link to players. No URL parameters needed — dev vs game mode is set by which command you run.

### What each mode does

| | `dev:tunnel` | `start:tunnel` |
|---|--------------|----------------|
| Dev flyout (top-right) | yes | no |
| GPS | manual via flyout | live from phone |
| Min players to start | 2 | 2 |
| Server dev tools (reset room, etc.) | yes | no |

## What runs

| Process | Role |
|---------|------|
| Game server | WebSocket + rules (internal port 8787) |
| Gateway | Web UI + `/ws` proxy (port 8080) |
| Cloudflare tunnel | Public HTTPS link → gateway |

One link serves both the app and the WebSocket.

## Game day checklist

1. Mac plugged in, sleep disabled (**System Settings → Battery → Prevent sleep** or `caffeinate`)
2. `npm run start:tunnel` in project folder
3. Link is copied / pushed automatically if `.env` is set; otherwise copy from terminal
4. Organizer creates room; others join with the same room code
5. Use `npm run dev:tunnel` only for rehearsals (desktop GPS sim via dev flyout)

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| “Connexion…” forever | Restart `npm run dev:tunnel` and use the new link |
| GPS blocked | URL must be `https://` (the tunnel provides this) |
| Link stopped working | Quick tunnel URLs expire when you close the terminal — restart and share the new link |
| `cloudflared not found` | `brew install cloudflared` |

## Optional: Cloudflare Pages frontend

If you deploy the UI to Cloudflare Pages, set `apps/web/static/config.js`:

```js
window.__SANCHASE_CONFIG__ = {
  wsUrl: "wss://YOUR-API-TUNNEL.trycloudflare.com/ws"
};
```

Rebuild and redeploy. The tunnel URL still changes each Mac restart unless you set up a named Cloudflare tunnel (advanced).

For rehearsals, the one-command `dev:tunnel` script is usually enough.
