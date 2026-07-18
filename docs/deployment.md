# Deployment Guide

This setup keeps the game online without your laptop on D-day.

## 1) Deploy backend (Railway/Render/Fly)

- Deploy from this repository using the `Dockerfile`.
- Expose port `8787`.
- Set env vars:
  - `HOST=0.0.0.0`
  - `PORT=8787`
- Verify health endpoint:
  - `https://<backend-domain>/health`

The WebSocket endpoint will be:
- `wss://<backend-domain>/ws`

## 2) Deploy frontend (Cloudflare Pages/Vercel/Netlify)

- Publish directory: `dist/web`
- Build command:
  - `npm ci && npm run build:web`

Before deploy, set `apps/web/static/config.js`:

```js
window.__SANCHASE_CONFIG__ = {
  wsUrl: "wss://<backend-domain>/ws"
};
```

## 3) Smoke test checklist

- Open hosted frontend on two phones.
- Confirm both can create/join same room.
- Confirm location markers update.
- Confirm mission hold works.
- Confirm arrest works and debrief marker appears.

## 4) Optional URL override

For temporary tests, you can override websocket URL from the browser:

- `https://<frontend-domain>/?ws=wss://<another-backend>/ws`
