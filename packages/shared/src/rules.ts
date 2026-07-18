import { ActionEvent, DEFAULT_COOLDOWN_SEC, DEFAULT_SETTINGS, GameState, Coordinates, Mission, RoomSettings } from "./domain.js";

const REVEAL_INTERVAL_SEC = 7 * 60;
const REVEAL_DURATION_SEC = 20;
const RALLY_RADIUS_M = 320;
const RALLY_HIT_M = 40;
const MISSION_HIT_M = 15;
const MISSION_HOLD_SEC = 30;

export function createInitialState(roomId: string, settings: Partial<RoomSettings> = {}): GameState {
  const merged: RoomSettings = {
    ...DEFAULT_SETTINGS,
    ...settings,
    actionToggles: {
      ...DEFAULT_SETTINGS.actionToggles,
      ...(settings.actionToggles ?? {})
    }
  };
  return {
    roomId,
    phase: "lobby",
    tick: 0,
    durationSec: merged.durationSec,
    settings: merged,
    players: {},
    fugitiveId: null,
    rallyPoints: {},
    missions: [],
    revealUntilTick: 0,
    nextRevealTick: 0,
    decoyNextReveal: false,
    winner: null,
    debriefPoint: null,
    eventLog: []
  };
}

export function clampLocation(previous: Coordinates | null, next: Coordinates): Coordinates | null {
  if (next.accuracyM > 120) return previous;
  if (!previous) return next;
  const dtSec = Math.max((next.ts - previous.ts) / 1000, 1);
  const meters = haversineMeters(previous.lat, previous.lng, next.lat, next.lng);
  if (meters / dtSec > 16) return previous;
  return next;
}

export function applyAction(state: GameState, evt: ActionEvent): GameState {
  const actor = state.players[evt.actorId];
  if (!actor) throw new Error("unknown actor");
  if (!state.settings.actionToggles[evt.action]) throw new Error("action disabled");
  const currentCooldown = actor.cooldowns[evt.action] ?? 0;
  if (currentCooldown > state.tick) throw new Error("action on cooldown");
  actor.cooldowns[evt.action] = state.tick + DEFAULT_COOLDOWN_SEC[evt.action];
  state.eventLog.push(`${evt.ts}:action:${evt.action}:by:${evt.actorId}`);
  return state;
}

export function canStartGame(state: GameState): { ok: boolean; reason: string } {
  const players = Object.values(state.players);
  if (players.length < state.settings.minPlayersToStart) return { ok: false, reason: `Need at least ${state.settings.minPlayersToStart} players` };
  if (players.some((p) => !p.ready)) return { ok: false, reason: "All players must be ready" };
  return { ok: true, reason: "Ready to launch" };
}

export function canStartChase(state: GameState): { ok: boolean; reason: string } {
  if (state.phase !== "rally") return { ok: false, reason: "Not in rally phase" };
  const players = Object.values(state.players);
  if (players.some((p) => !p.reachedRally)) return { ok: false, reason: "Waiting for players to reach rally points" };
  return { ok: true, reason: "Chase can start" };
}

export function assignRallyPoints(state: GameState, center: Coordinates) {
  const ids = Object.keys(state.players);
  state.rallyPoints = {};
  ids.forEach((id, index) => {
    const bearing = (2 * Math.PI * index) / Math.max(ids.length, 1);
    const point = offsetMeters(center, RALLY_RADIUS_M, bearing);
    state.rallyPoints[id] = { ...point, accuracyM: 10, ts: Date.now() };
  });
}

export function assignFugitiveMissions(state: GameState) {
  const fugitiveId = state.fugitiveId;
  if (!fugitiveId) throw new Error("fugitive not set");
  const fugitive = state.players[fugitiveId];
  if (!fugitive?.lastLocation) throw new Error("fugitive location required for missions");

  const base = fugitive.lastLocation;
  state.missions = [0, 1, 2].map((i) => {
    const bearing = ((Math.PI * 2) / 3) * i + Math.random() * 0.2;
    const distance = 350 + i * 220;
    const point = offsetMeters(base, distance, bearing);
    return { id: `m${i + 1}`, point: { ...point, accuracyM: 10, ts: Date.now() }, completed: false, holdStartTick: null } as Mission;
  });
}

export function markRallyReached(state: GameState, playerId: string) {
  const player = state.players[playerId];
  const target = state.rallyPoints[playerId];
  if (!player || !player.lastLocation || !target) return;
  if (haversineMeters(player.lastLocation.lat, player.lastLocation.lng, target.lat, target.lng) <= RALLY_HIT_M) player.reachedRally = true;
}

export function startMissionHold(state: GameState, playerId: string, missionId: string) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can capture missions");
  const mission = state.missions.find((m) => m.id === missionId);
  if (!mission || mission.completed) throw new Error("mission not available");
  if (!isPlayerNearMission(state, playerId, mission)) throw new Error("too far from mission point");
  mission.holdStartTick = state.tick;
}

export function cancelMissionHold(state: GameState, playerId: string, missionId: string) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can capture missions");
  const mission = state.missions.find((m) => m.id === missionId);
  if (!mission || mission.completed) return;
  mission.holdStartTick = null;
}

export function completeMissionHold(state: GameState, playerId: string, missionId: string) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can capture missions");
  const mission = state.missions.find((m) => m.id === missionId);
  if (!mission || mission.completed || mission.holdStartTick === null) throw new Error("mission hold not started");
  if (!isPlayerNearMission(state, playerId, mission)) throw new Error("too far from mission point");
  if (state.tick - mission.holdStartTick < MISSION_HOLD_SEC) throw new Error("hold duration too short");
  mission.completed = true;
  mission.holdStartTick = null;
  state.eventLog.push(`${Date.now()}:mission:${missionId}:completed`);
  if (state.missions.every((m) => m.completed)) {
    state.phase = "finished";
    state.winner = "fugitive";
    state.debriefPoint = computeDebriefPoint(state);
    state.eventLog.push(`${Date.now()}:system:fugitive_won`);
  }
}

export function attemptArrest(state: GameState, copId: string): { success: boolean; distanceM: number; thresholdM: number } {
  if (state.phase !== "active") throw new Error("arrest only possible during active chase");
  if (!state.fugitiveId) throw new Error("fugitive unknown");
  if (copId === state.fugitiveId) throw new Error("fugitive cannot arrest");

  const cop = state.players[copId];
  const fug = state.players[state.fugitiveId];
  if (!cop || !fug) throw new Error("player not found");
  if (cop.arrestAttemptsUsed >= 2) throw new Error("no arrest attempts left");
  if (!cop.lastLocation || !fug.lastLocation) throw new Error("missing location for arrest");

  cop.arrestAttemptsUsed += 1;
  const distance = haversineMeters(cop.lastLocation.lat, cop.lastLocation.lng, fug.lastLocation.lat, fug.lastLocation.lng);
  const effectiveThreshold = Math.max(1, Math.min(8, (cop.lastLocation.accuracyM + fug.lastLocation.accuracyM) / 2));
  const success = distance <= effectiveThreshold;

  if (success) {
    state.phase = "finished";
    state.winner = "cops";
    state.debriefPoint = computeDebriefPoint(state);
    state.eventLog.push(`${Date.now()}:arrest:success:by:${copId}`);
  } else {
    state.eventLog.push(`${Date.now()}:arrest:failed:by:${copId}:d=${distance.toFixed(2)}`);
  }

  return { success, distanceM: distance, thresholdM: effectiveThreshold };
}

export function tickState(state: GameState): GameState {
  state.tick += 1;
  if (state.phase === "active") {
    if (state.tick >= state.durationSec) {
      state.phase = "finished";
      state.winner = "cops";
      state.debriefPoint = computeDebriefPoint(state);
      state.eventLog.push(`${Date.now()}:system:time_up_cops_win`);
    }
    if (state.tick >= state.nextRevealTick) {
      state.revealUntilTick = state.tick + REVEAL_DURATION_SEC;
      state.nextRevealTick = state.tick + REVEAL_INTERVAL_SEC;
      state.eventLog.push(`${Date.now()}:system:reveal_window_open`);
    }
  }
  return state;
}

export function revealPositions(state: GameState): Coordinates[] {
  const fugitive = state.fugitiveId ? state.players[state.fugitiveId] : null;
  if (!fugitive?.lastLocation) return [];
  const truth = fugitive.lastLocation;
  if (!state.decoyNextReveal) return [truth];
  state.decoyNextReveal = false;
  return [truth, jitterPoint(truth, 180), jitterPoint(truth, 260)];
}

export function enableNextDecoyReveal(state: GameState, playerId: string) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can enable decoy reveal");
  const player = state.players[playerId];
  if (player.usedDecoyPower) throw new Error("decoy power already used");
  player.usedDecoyPower = true;
  state.decoyNextReveal = true;
}

function computeDebriefPoint(state: GameState): Coordinates | null {
  const locs = Object.values(state.players).map((p) => p.lastLocation).filter((l): l is Coordinates => Boolean(l));
  if (locs.length === 0) return null;
  const avgLat = locs.reduce((s, l) => s + l.lat, 0) / locs.length;
  const avgLng = locs.reduce((s, l) => s + l.lng, 0) / locs.length;
  return { lat: avgLat, lng: avgLng, accuracyM: 20, ts: Date.now() };
}

function isPlayerNearMission(state: GameState, playerId: string, mission: Mission) {
  const loc = state.players[playerId]?.lastLocation;
  return !!loc && haversineMeters(loc.lat, loc.lng, mission.point.lat, mission.point.lng) <= MISSION_HIT_M;
}

function jitterPoint(origin: Coordinates, radiusM: number): Coordinates {
  const p = offsetMeters(origin, radiusM, Math.random() * Math.PI * 2);
  return { ...p, accuracyM: origin.accuracyM, ts: origin.ts };
}

function offsetMeters(origin: Coordinates, meters: number, bearingRad: number) {
  const dLat = (meters * Math.cos(bearingRad)) / 111320;
  const dLng = (meters * Math.sin(bearingRad)) / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
