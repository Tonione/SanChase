FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/game-server/package.json services/game-server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/sim/package.json packages/sim/package.json

RUN npm ci

COPY services ./services
COPY packages ./packages

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "--import", "tsx", "services/game-server/src/server.ts"]
