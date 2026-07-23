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
  beginPlayAreaSetup,
  canStartChase,
  canStartGame,
  confirmPlayAreaSetup,
  clampLocation,
  completeMissionHold,
  computePlayAreaRadiusM,
  constrainLocation,
  createInitialState,
  deployCopRadar,
  enableNextDecoyReveal,
  markRallyReached,
  revealIntervalSec,
  revealPositions,
  resetRoomToLobby,
  resetRoomToSetup,
  setPlayAreaCenter,
  setPlayAreaRadius,
  startMissionHold,
  cancelMissionHold,
  tickState,
  updateArrestStillness,
  updateMissionProximity,
  updatePlayerBoundary,
  useCopScan
} from "../../../packages/shared/src/index.js";
import { snapMissionsInState, snapRallyPointsInState } from "./street-placement.js";
import { clearPlayerSnapCache, maybeSnapPlayerLocation } from "./player-location-snap.js";
import { StreetSnapContext } from "./street-snap.js";

export type Room = { state: GameState; tokens: Map<string, string> };

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly streetSnapContexts = new Map<string, StreetSnapContext>();

  createRoom(roomId: string, creatorId: string, creatorName: string, settings: Partial<RoomSettings>) {
    if (this.rooms.has(roomId)) throw new Error("room already exists");
    const room: Room = { state: createInitialState(roomId, settings), tokens: new Map() };
    this.rooms.set(roomId, room);
    return this.join(roomId, creatorId, creatorName);
  }

  join(roomId: string, playerId: string, name: string, reconnectToken?: string) {
    const room = this.requireRoom(roomId);
    const existing = room.state.players[playerId];
    if (existing) {
      if (!reconnectToken || room.tokens.get(playerId) !== reconnectToken) {
        throw new Error("session expirée — rejoignez la salle manuellement");
      }
      existing.connected = true;
      if (name.trim()) existing.name = name.trim();
      return { room, reconnectToken: room.tokens.get(playerId)! };
    }
    if (Object.keys(room.state.players).length >= room.state.settings.maxPlayers) throw new Error("room is full");
    const isFirst = Object.keys(room.state.players).length === 0;
    room.state.players[playerId] = PlayerSchema.parse({
      id: playerId,
      name,
      role: isFirst ? "organizer" : "hunter",
      connected: true,
      ready: false,
      reachedRally: false,
      usedRadar: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillRemainingSec: null,
      arrestStillCounting: false,
      outsideSinceTick: null,
      eliminated: false,
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
    room.state.phase = "setup";
    const center = room.state.players[by].lastLocation;
    if (!center) throw new Error("organizer location required before launch");
    beginPlayAreaSetup(room.state, center);
    room.state.eventLog.push(`${Date.now()}:system:setup_started`);
    return room;
  }

  async confirmSetup(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    const organizer = room.state.players[by];
    if (!organizer || organizer.role !== "organizer") throw new Error("only organizer can confirm setup");
    confirmPlayAreaSetup(room.state, by);
    await snapRallyPointsInState(room.state);
    return room;
  }

  async setPlayAreaCenter(roomId: string, by: string, lat: number, lng: number) {
    const room = this.requireRoom(roomId);
    const organizer = room.state.players[by];
    if (!organizer || organizer.role !== "organizer") throw new Error("only organizer can set play area center");
    setPlayAreaCenter(room.state, lat, lng);
    if (room.state.phase === "rally") {
      await snapRallyPointsInState(room.state);
    }
    return room;
  }

  async startChase(roomId: string, by: string, force = false) {
    const room = this.requireRoom(roomId);
    const starter = room.state.players[by];
    if (!starter || starter.role !== "organizer") throw new Error("only organizer can force chase start");
    if (!force) {
      const gate = canStartChase(room.state);
      if (!gate.ok) throw new Error(gate.reason);
    }
    room.state.phase = "active";
    const radiusM = room.state.playArea?.radiusM ?? 1320;
    room.state.nextRevealTick = room.state.tick + revealIntervalSec(radiusM);
    assignFugitiveMissions(room.state);
    await snapMissionsInState(room.state);
    room.state.eventLog.push(`${Date.now()}:system:${force ? "chase_forced" : "chase_started"}`);
    return room;
  }

  attemptArrest(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    return { room, result: attemptArrest(room.state, by) };
  }

  async updateLocation(roomId: string, playerId: string, location: Coordinates, simulated = false) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[playerId];
    if (!player) throw new Error("player not found");

    let nextLocation = location;
    if (!simulated && room.state.playArea && location.accuracyM > 40) {
      const ctx = await this.streetSnapContextForRoom(roomId, room.state.playArea);
      nextLocation = await maybeSnapPlayerLocation(`${roomId}:${playerId}`, location, room.state.playArea, ctx);
    }

    player.lastLocation = simulated ? nextLocation : constrainLocation(room.state, player.lastLocation, nextLocation);
    if (player.lastLocation) {
      updatePlayerBoundary(room.state, playerId);
      updateMissionProximity(room.state, playerId);
    }
    if (room.state.phase === "active" && player.id !== room.state.fugitiveId && player.arrestPenaltyAnchor) {
      updateArrestStillness(room.state, playerId, player.lastLocation!);
    }
    if (room.state.phase === "rally") markRallyReached(room.state, playerId);
    return room;
  }

  private async streetSnapContextForRoom(roomId: string, playArea: NonNullable<GameState["playArea"]>) {
    let ctx = this.streetSnapContexts.get(roomId);
    if (!ctx) {
      ctx = new StreetSnapContext();
      this.streetSnapContexts.set(roomId, ctx);
    }
    await ctx.loadForArea(playArea.center.lat, playArea.center.lng, playArea.radiusM);
    return ctx;
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

  async setPlayAreaRadius(roomId: string, by: string, radiusM: number | null) {
    const room = this.requireRoom(roomId);
    const organizer = room.state.players[by];
    if (!organizer || organizer.role !== "organizer") throw new Error("only organizer can set play area radius");
    if (!["lobby", "setup", "rally", "active"].includes(room.state.phase)) {
      throw new Error("cannot change play area radius now");
    }
    setPlayAreaRadius(room.state, radiusM);
    if (room.state.phase === "rally") {
      await snapRallyPointsInState(room.state);
    }
    return room;
  }

  deployCopRadar(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[by];
    if (!player || by === room.state.fugitiveId) throw new Error("only cops can deploy radar");
    if (player.eliminated) throw new Error("vous êtes éliminé");
    deployCopRadar(room.state, by);
    return room;
  }

  heartbeat(roomId: string, playerId: string) {
    const room = this.requireRoom(roomId);
    const player = room.state.players[playerId];
    if (player) player.connected = true;
  }

  disconnect(roomId: string, playerId: string) {
    const room = this.rooms.get(roomId);
    const player = room?.state.players[playerId];
    if (player) player.connected = false;
  }

  devResetRoom(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    if (!room.state.players[by]) throw new Error("player not found");
    room.state = resetRoomToLobby(room.state);
    this.streetSnapContexts.delete(roomId);
    clearPlayerSnapCache(roomId);
    return room;
  }

  organizerResetGame(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    room.state = resetRoomToSetup(room.state, by);
    this.streetSnapContexts.delete(roomId);
    clearPlayerSnapCache(roomId);
    return room;
  }

  organizerQuitGame(roomId: string, by: string) {
    const room = this.requireRoom(roomId);
    const organizer = room.state.players[by];
    if (!organizer || organizer.role !== "organizer") throw new Error("only organizer can quit game");
    if (room.state.phase === "lobby") throw new Error("no game in progress");
    this.streetSnapContexts.delete(roomId);
    clearPlayerSnapCache(roomId);
    this.rooms.delete(roomId);
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
