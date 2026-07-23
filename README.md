# SanChase

Web-first, real-world city chase game inspired by Scotland Yard.

## Quick start

- `npm install`
- **Rehearsal / testing:** `npm run dev:tunnel` — Cloudflare link, dev flyout, manual GPS, 2-player min
- **Game day:** `npm run start:tunnel` — Cloudflare link, live GPS
- See `docs/mac-cloudflare-tunnel.md` for setup (cloudflared, optional link notifications)
- `npm test`

## Build for hosting

- `npm run build:web` (outputs static site to `dist/web`)
- Backend runs with `npm run start:server`
- Deployment instructions: `docs/deployment-oracle.md` (free Oracle VM + Cloudflare Pages)
- **Mac + Cloudflare quick tunnel (no VM):** `docs/mac-cloudflare-tunnel.md` → `npm run dev:tunnel` or `npm run start:tunnel`

## Structure

- `apps/web`: browser client scaffold (PWA-oriented)
- `services/game-server`: realtime room/game server
- `packages/shared`: domain model, schemas, and game rules
- `packages/sim`: simulation for multi-player stress checks
- `tests`: unit/integration/scenario tests