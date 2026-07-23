import type { Express } from "express";

export function isClientDevMode(): boolean {
  return process.env.SANCHASE_DEV === "1";
}

export function runtimeConfigPayload() {
  return {
    wsUrl: process.env.SANCHASE_WS_URL ?? "",
    devMode: isClientDevMode()
  };
}

export function mountRuntimeConfig(app: Express) {
  app.get("/config.js", (_req, res) => {
    res
      .type("application/javascript")
      .send(`window.__SANCHASE_CONFIG__ = ${JSON.stringify(runtimeConfigPayload())};`);
  });
}
