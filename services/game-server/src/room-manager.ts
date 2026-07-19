import { randomUUID } from "node:crypto";
import {
  ActionEvent,
  Coordinates,
  GameState,
  RoomSettings,
  PlayerSchema,
  applyAction,
  assignFugitiveMissions,
  assignRallyPoints,
  attemptArrest,
  canStartChase,
  canStartGame,
  clampLocation,
  completeMissionHold,
  createInitialState,
  enableNextDecoyReveal,
  markRallyReached,
  revealPositions,
  startMissionHold,
  cancelMissionHold,
  tickState,
  useCopScan
} from "../../../packages/shared/src/index.js";

export type Room = { state: GameState; tokens: Map<string, string> };

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  createRoom(roomId: string, creatorId: string, creatorName: string, settings: Partial<RoomSettings>) {
    if (this.rooms.has(roomId)) throw new Error("room already exists");
    const room: Room = { state: createInitialState(roomId, settings), tokens: new Map() };
    this.rooms.set(roomId, room);
    return this.join(roomId, creatorId, creatorName);
  }

  join(roomId: string, playerId: string, name: string) {
    const room = this.requireRoom(roomId);
    if (Object.keys(room.state.players).length >= room.state.settings.maxPlayers) throw new Error("room is full");
    const isFirst = Object.keys(room.state.players).length === 0;
    room.state.players[playerId] = PlayerSchema.parse({
      id: playerId,
      name,
      role: isFirst ? "organizer" : "hunter",
      connected: true,
      ready: false,
      reachedRally: false,
      usedNoisePing: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestAttemptsUsed: 0,
      lastLocation: null
    });
    const token = randomUUID();
    room.tokens.set(playerId, token);
    return { room, reconnectToken: token };
  }

  setReady(roomId: string, playerId: string, ready: boolean) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[playerId];
    if (!player) throw new Error("player not found");
    player.ready = ready;
    return room;
  }

  selectFugitive(roomId: string, by: string, fugitiveId: string) {
    const room = this.requireRoom(roomId);
    const organizer = room.state.players[by];
    if (!organizer || organizer.role !== "organizer") throw new Error("only organizer can select fugitive");
    if (!room.state.players[fugitiveId]) throw new Error("unknown fugitive id");
    room.state.fugitiveId = fugitiveId;
    return room;
  }

  startGame(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    const starter = room.state.players[by];
    if (!starter || starter.role !== "organizer") throw new Error("only organizer can start");
    const gate = canStartGame(room.state);
    if (!gate.ok) throw new Error(gate.reason);
    if (!room.state.fugitiveId) {
      if (room.state.settings.fugitiveSelection === "manual") throw new Error("select fugitive first");
      room.state.fugitiveId = this.pickRandomPlayerId(room.state);
    }
    room.state.phase = "rally";
    const center = room.state.players[by].lastLocation;
    if (!center) throw new Error("organizer location required before launch");
    assignRallyPoints(room.state, center);
    room.state.eventLog.push(`${Date.now()}:system:rally_started`);
    return room;
  }

  startChase(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    const starter = room.state.players[by];
    if (!starter || starter.role !== "organizer") throw new Error("only organizer can force chase start");
    room.state.phase = "active";
    room.state.nextRevealTick = room.state.tick + 7 * 60;
    assignFugitiveMissions(room.state);
    room.state.eventLog.push(`${Date.now()}:system:chase_started`);
    return room;
  }

  attemptArrest(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    return { room, result: attemptArrest(room.state, by) };
  }

  updateLocation(roomId: string, playerId: string, location: Coordinates, simulated = false) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[playerId];
    if (!player) throw new Error("player not found");
    player.lastLocation = simulated ? location : clampLocation(player.lastLocation, location);
    if (room.state.phase === "rally") markRallyReached(room.state, playerId);
    return room;
  }

  startMissionHold(roomId: string, by: string, missionId: string) {
    const room = this.requireRoom(roomId);
    startMissionHold(room.state, by, missionId);
    return room;
  }

  cancelMissionHold(roomId: string, by: string, missionId: string) {
    const room = this.requireRoom(roomId);
    cancelMissionHold(room.state, by, missionId);
    return room;
  }

  completeMissionHold(roomId: string, by: string, missionId: string, requiredHoldSec?: number) {
    const room = this.requireRoom(roomId);
    completeMissionHold(room.state, by, missionId, requiredHoldSec);
    return room;
  }

  triggerAction(roomId: string, evt: ActionEvent) {
    const room = this.requireRoom(roomId);
    applyAction(room.state, evt);
    return room;
  }

  useDecoyReveal(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    enableNextDecoyReveal(room.state, by);
    return room;
  }

  useCopScan(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    useCopScan(room.state, by);
    return room;
  }

  useCopNoisePing(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[by];
    if (!player || by === room.state.fugitiveId) throw new Error("only cops can use noise ping");
    if (player.usedNoisePing) throw new Error("noise ping already used");
    player.usedNoisePing = true;
    room.state.eventLog.push(`${Date.now()}:power:noise_ping:by:${by}`);
    return room;
  }

  heartbeat(roomId: string, playerId: string) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[playerId];
    if (player) player.connected = true;
  }

  startEligibility(roomId: string) {
    const room = this.requireRoom(roomId);
    if (room.state.phase === "lobby") return canStartGame(room.state);
    if (room.state.phase === "rally") return canStartChase(room.state);
    return { ok: false, reason: "Game already running" };
  }

  revealPositions(roomId: string) {
    const room = this.requireRoom(roomId);
    return revealPositions(room.state);
  }

  tickAll() {
    for (const room of this.rooms.values()) tickState(room.state);
  }

  get(roomId: string) {
    return this.rooms.get(roomId);
  }

  all() {
    return this.rooms;
  }

  private pickRandomPlayerId(state: GameState): string {
    const ids = Object.keys(state.players);
    return ids[Math.floor(Math.random() * ids.length)];
  }

  private requireRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("room not found");
    return room;
  }
}
