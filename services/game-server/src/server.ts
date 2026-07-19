import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ClientMessageSchema, DEV_MISSION_HOLD_SEC, GameState, assessPlayArea, isCopScanActive, playAreaRadiusInfo, revealDisplaySec, ServerMessage } from "../../../packages/shared/src/index.js";
import { RoomManager } from "./room-manager.js";

const manager = new RoomManager();
const socketsByRoom = new Map<string, Map<string, WebSocket>>();
const isDevServer = process.env.NODE_ENV !== "production";

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, rooms: manager.all().size }));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      const msg = ClientMessageSchema.parse(JSON.parse(raw.toString()));
      if (msg.type === "create_room") {
        const { room, reconnectToken } = manager.createRoom(msg.roomId, msg.playerId, msg.name, msg.settings);
        attachSocket(msg.roomId, msg.playerId, socket);
        send(socket, { type: "session", reconnectToken });
        sync(msg.roomId, room.state);
        return;
      }
      if (msg.type === "join_room") {
        const { room, reconnectToken } = manager.join(msg.roomId, msg.playerId, msg.name);
        attachSocket(msg.roomId, msg.playerId, socket);
        send(socket, { type: "session", reconnectToken });
        sync(msg.roomId, room.state);
        return;
      }
      if (msg.type === "set_ready") return sync(msg.roomId, manager.setReady(msg.roomId, msg.playerId, msg.ready).state);
      if (msg.type === "select_fugitive") return sync(msg.roomId, manager.selectFugitive(msg.roomId, msg.by, msg.fugitiveId).state);
      if (msg.type === "start_game") return sync(msg.roomId, manager.startGame(msg.roomId, msg.by).state);
      if (msg.type === "start_chase") return sync(msg.roomId, manager.startChase(msg.roomId, msg.by, msg.force ?? false).state);
      if (msg.type === "use_decoy_reveal") return sync(msg.roomId, manager.useDecoyReveal(msg.roomId, msg.by).state);
      if (msg.type === "use_cop_scan") {
        const room = manager.useCopScan(msg.roomId, msg.by);
        broadcastToCops(msg.roomId, room.state, {
          type: "action_event",
          message: "Le fugitif active un scan — vos positions sont visibles !"
        });
        return sync(msg.roomId, room.state);
      }
      if (msg.type === "attempt_arrest") {
        const { room, result } = manager.attemptArrest(msg.roomId, msg.by);
        const copName = room.state.players[msg.by]?.name ?? msg.by;
        broadcast(msg.roomId, {
          type: "action_event",
          message: result.success
            ? `${copName} a arrêté le fugitif. Rendez-vous au point de debrief.`
            : `Échec de l'arrestation (${result.distanceM.toFixed(1)} m > ${result.thresholdM.toFixed(1)} m). ${copName} doit rester immobile 10 s.`
        });
        return sync(msg.roomId, room.state);
      }
      if (msg.type === "start_mission_hold") return sync(msg.roomId, manager.startMissionHold(msg.roomId, msg.by, msg.missionId).state);
      if (msg.type === "cancel_mission_hold") return sync(msg.roomId, manager.cancelMissionHold(msg.roomId, msg.by, msg.missionId).state);
      if (msg.type === "complete_mission_hold") {
        const holdSec = isDevServer && msg.devShortHold ? DEV_MISSION_HOLD_SEC : undefined;
        const room = manager.completeMissionHold(msg.roomId, msg.by, msg.missionId, holdSec);
        const mission = room.state.missions.find((m) => m.id === msg.missionId);
        const completedCount = room.state.missions.filter((m) => m.completed).length;
        const totalCount = room.state.missions.length;
        if (mission?.completed) {
          broadcastToCops(msg.roomId, room.state, {
            type: "mission_completed",
            missionName: mission.name,
            completedCount,
            totalCount
          });
        }
        return sync(msg.roomId, room.state);
      }
      if (msg.type === "cop_noise_ping") {
        const room = manager.useCopNoisePing(msg.roomId, msg.by);
        const fugitiveId = room.state.fugitiveId;
        if (fugitiveId) {
          const ws = socketsByRoom.get(msg.roomId)?.get(fugitiveId);
          if (ws) send(ws, { type: "sound_event", sound: "noise_ping", reason: "cop_power" });
        }
        return sync(msg.roomId, room.state);
      }
      if (msg.type === "dev_trigger_reveal") {
        if (!isDevServer) throw new Error("dev reveal only available in dev mode");
        const room = manager.get(msg.roomId);
        if (!room || room.state.phase !== "active") throw new Error("reveal only during active chase");
        broadcastToCops(msg.roomId, room.state, { type: "reveal_positions", positions: manager.revealPositions(msg.roomId) });
        return;
      }
      if (msg.type === "set_play_area_radius") {
        return sync(msg.roomId, manager.setPlayAreaRadius(msg.roomId, msg.by, msg.radiusM).state);
      }
      if (msg.type === "location_update") {
        return sync(msg.roomId, manager.updateLocation(msg.roomId, msg.playerId, msg.location, msg.simulated ?? false).state);
      }
      if (msg.type === "trigger_action") return sync(msg.payload.roomId, manager.triggerAction(msg.payload.roomId, msg.payload).state);
      manager.heartbeat(msg.roomId, msg.playerId);
    } catch (err) {
      send(socket, { type: "error", message: String(err) });
    }
  });
});

setInterval(() => {
  manager.tickAll();
  for (const [roomId, room] of manager.all()) {
    sync(roomId, room.state);
    if (room.state.phase === "active" && room.state.revealUntilTick > 0) {
      const radiusM = room.state.playArea?.radiusM ?? 1320;
      const displaySec = revealDisplaySec(radiusM);
      if (room.state.tick === room.state.revealUntilTick - displaySec) {
        broadcastToCops(roomId, room.state, { type: "reveal_positions", positions: manager.revealPositions(roomId) });
      }
    }
  }
}, 1000);

function sync(roomId: string, state: GameState) {
  const roomSockets = socketsByRoom.get(roomId);
  if (!roomSockets) return;
  for (const [playerId, ws] of roomSockets.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const sanitized = sanitizeStateForPlayer(state, playerId);
    const playAreaAssessment = state.playArea
      ? assessPlayArea({
          radiusM: state.playArea.radiusM,
          playerCount: Object.keys(state.players).length,
          durationSec: state.durationSec,
          preset: state.settings.boundaryPreset
        })
      : null;
    ws.send(JSON.stringify({
      type: "state_sync",
      state: sanitized,
      startEligibility: manager.startEligibility(roomId),
      playAreaAssessment,
      playAreaRadius: playAreaRadiusInfo(state)
    }));
  }
}

function sanitizeStateForPlayer(state: GameState, playerId: string): GameState {
  const isFugitive = state.fugitiveId === playerId;
  const hidePositions = state.phase === "rally" || state.phase === "active";

  if (isFugitive) {
    if (hidePositions && !(state.phase === "active" && isCopScanActive(state))) {
      const players = { ...state.players };
      for (const [id, player] of Object.entries(players)) {
        if (id !== playerId && id !== state.fugitiveId) {
          players[id] = { ...player, lastLocation: null };
        }
      }
      return { ...state, players };
    }
    return state;
  }

  const players = { ...state.players };
  if (hidePositions && state.fugitiveId && players[state.fugitiveId]) {
    players[state.fugitiveId] = { ...players[state.fugitiveId], lastLocation: null };
  }

  return {
    ...state,
    players,
    missions: state.missions.map((m) => ({
      ...m,
      point: { lat: 0, lng: 0, accuracyM: 0, ts: 0 },
      holdStartTick: null
    }))
  };
}

function broadcastToCops(roomId: string, state: GameState, msg: ServerMessage) {
  const roomSockets = socketsByRoom.get(roomId);
  if (!roomSockets) return;
  const payload = JSON.stringify(msg);
  for (const [playerId, ws] of roomSockets.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (playerId === state.fugitiveId) continue;
    ws.send(payload);
  }
}

function attachSocket(roomId: string, playerId: string, socket: WebSocket) {
  const roomSockets = socketsByRoom.get(roomId) ?? new Map<string, WebSocket>();
  roomSockets.set(playerId, socket);
  socketsByRoom.set(roomId, roomSockets);
}

function send(socket: WebSocket, msg: ServerMessage) {
  socket.send(JSON.stringify(msg));
}

function broadcast(roomId: string, msg: ServerMessage) {
  const roomSockets = socketsByRoom.get(roomId);
  if (!roomSockets) return;
  const payload = JSON.stringify(msg);
  for (const ws of roomSockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
httpServer.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`game-server listening on ${host}:${port}`);
});
