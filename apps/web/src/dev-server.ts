import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountRuntimeConfig } from "./runtime-config.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
mountRuntimeConfig(app);
app.use(express.static(path.resolve(dirname, "../static")));

const port = Number(process.env.WEB_PORT ?? 5173);
const host = process.env.WEB_HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`web client on http://localhost:${port} (listening on ${host})`);
});
