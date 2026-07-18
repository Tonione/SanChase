# SanChase

Web-first, real-world city chase game inspired by Scotland Yard.

## Quick start

- `npm install`
- `npm run dev:server`
- `npm run dev:web`
- `npm test`

## Build for hosting

- `npm run build:web` (outputs static site to `dist/web`)
- Backend runs with `npm run start:server`
- Deployment instructions: `docs/deployment-oracle.md` (free Oracle VM + Cloudflare Pages)

## Structure

- `apps/web`: browser client scaffold (PWA-oriented)
- `services/game-server`: realtime room/game server
- `packages/shared`: domain model, schemas, and game rules
- `packages/sim`: simulation for multi-player stress checks
- `tests`: unit/integration/scenario tests