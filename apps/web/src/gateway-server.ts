import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(dirname, "../static");
const apiPort = Number(process.env.SANCHASE_API_PORT ?? 8787);
const apiHost = process.env.SANCHASE_API_HOST ?? "127.0.0.1";
const apiBase = `http://${apiHost}:${apiPort}`;
const apiWs = `ws://${apiHost}:${apiPort}/ws`;

const app = express();
app.use(express.static(staticRoot));

app.get("/health", async (_req, res) => {
  try {
    const r = await fetch(`${apiBase}/health`);
    const body = await r.text();
    res.status(r.status).type("application/json").send(body);
  } catch {
    res.status(502).json({ ok: false, error: "game server unreachable" });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    const backend = new WebSocket(apiWs);
    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
      if (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING) {
        backend.close();
      }
    };
    backend.on("open", () => {
      client.on("message", (data, isBinary) => backend.send(data, { binary: isBinary }));
      backend.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
      client.on("close", closeBoth);
      backend.on("close", closeBoth);
      client.on("error", closeBoth);
      backend.on("error", closeBoth);
    });
    backend.on("error", closeBoth);
  });
});

const port = Number(process.env.SANCHASE_GATEWAY_PORT ?? 8080);
const host = process.env.SANCHASE_GATEWAY_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`gateway on http://${host}:${port} → API ${apiBase}`);
});
