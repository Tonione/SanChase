import { ActionEvent, DEFAULT_COOLDOWN_SEC, DEFAULT_SETTINGS, GameState, Coordinates, Mission, PlayArea, RoomSettings } from "./domain.js";
import {
  clampPlayAreaRadiusM,
  computeMinPlayAreaRadiusM,
  missionDistancesM,
  PLAY_AREA_HIDE_SEEK_RADIUS_M,
  PLAY_AREA_MAX_M,
  PLAY_AREA_MICRO_RADIUS_M,
  PLAY_AREA_MIN_M,
  PLAY_AREA_STEP_M,
  rallyHitRadiusM,
  rallySpreadM
} from "./play-area-layout.js";
import { computeRecommendedPlayAreaRadiusM } from "./play-area-assessment.js";

const REVEAL_INTERVAL_URBAN_SEC = 7 * 60;
const REVEAL_INTERVAL_MICRO_SEC = 2 * 60;
const REVEAL_DISPLAY_URBAN_SEC = 30;
const REVEAL_DISPLAY_MICRO_SEC = 15;
export const REVEAL_DISPLAY_SEC = REVEAL_DISPLAY_URBAN_SEC;
export const ARREST_FAIL_STILL_SEC = 10;
export const ARREST_FAIL_MOVE_M = 4;

export function revealIntervalSec(radiusM: number): number {
  return radiusM < 120 ? REVEAL_INTERVAL_MICRO_SEC : REVEAL_INTERVAL_URBAN_SEC;
}

export function revealDisplaySec(radiusM: number): number {
  return radiusM < 120 ? REVEAL_DISPLAY_MICRO_SEC : REVEAL_DISPLAY_URBAN_SEC;
}
const MISSION_HIT_M = 15;
const MISSION_HOLD_SEC = 30;
export const DEV_MISSION_HOLD_SEC = 5;
export const MISSION_HIT_RADIUS_M = MISSION_HIT_M;
export const COP_SCAN_DURATION_SEC = 180;
export const MAX_COP_SCAN_USES = 2;

export { clampPlayAreaRadiusM, PLAY_AREA_MIN_M, PLAY_AREA_MAX_M, PLAY_AREA_STEP_M };

export const MISSION_NAMES = [
  "Déposer un colis mort",
  "Rencontrer l'informateur",
  "Échanger la mallette",
  "Marquer le monument",
  "Photographier la cible",
  "Laisser une carte de visite",
  "Récupérer le paquet",
  "Neutraliser la caméra",
  "Semer une fausse piste",
  "Récupérer le microfilm",
  "Remplacer le panneau",
  "Graffiti sur la statue",
  "Voler le parapluie du maire",
  "Pirater le parcmètre",
  "Passer la contrebande",
  "Falsifier la liste d'invités",
  "Saboter la fontaine",
  "Soudoyer le musicien",
  "Échanger les étiquettes du musée",
  "Organiser une diversion"
] as const;

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
    playArea: null,
    rallyPoints: {},
    missions: [],
    revealUntilTick: 0,
    nextRevealTick: 0,
    decoyNextReveal: false,
    copScanUntilTick: 0,
    winner: null,
    endReason: null,
    arrestedById: null,
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
  if (players.length < state.settings.minPlayersToStart) {
    return { ok: false, reason: `Il faut au moins ${state.settings.minPlayersToStart} joueurs` };
  }
  if (players.some((p) => !p.ready)) return { ok: false, reason: "Tous les joueurs doivent être prêts" };
  return { ok: true, reason: "Prêt à lancer la partie" };
}

export function rallyProgress(state: GameState): { reached: number; total: number } {
  const players = Object.values(state.players);
  return {
    reached: players.filter((p) => p.reachedRally).length,
    total: players.length
  };
}

export function canStartChase(state: GameState): { ok: boolean; reason: string } {
  if (state.phase !== "rally") return { ok: false, reason: "Pas en phase de rassemblement" };
  const { reached, total } = rallyProgress(state);
  const missing = total - reached;
  if (missing > 0) {
    return { ok: false, reason: `${reached}/${total} aux positions — il en manque ${missing}` };
  }
  return { ok: true, reason: `Tous les joueurs (${total}) sont en place — prêt à chasser !` };
}

export function resolvePlayAreaRadiusM(state: GameState): number {
  if (state.settings.playAreaRadiusM != null) {
    return clampPlayAreaRadiusM(state.settings.playAreaRadiusM);
  }
  return computePlayAreaRadiusM(Object.keys(state.players).length, state.settings.boundaryPreset);
}

export function computePlayAreaRadiusM(playerCount: number, preset: RoomSettings["boundaryPreset"] = "district_medium"): number {
  const recommended = computeRecommendedPlayAreaRadiusM(playerCount, preset);
  return clampPlayAreaRadiusM(recommended);
}

export function playAreaRadiusInfo(state: GameState) {
  const playerCount = Math.max(Object.keys(state.players).length, 1);
  const defaultM = computePlayAreaRadiusM(playerCount, state.settings.boundaryPreset);
  const minGeometryM = computeMinPlayAreaRadiusM();
  const recommendedM = computeRecommendedPlayAreaRadiusM(playerCount, state.settings.boundaryPreset);
  const currentM = state.playArea?.radiusM ?? state.settings.playAreaRadiusM ?? defaultM;
  return {
    minM: PLAY_AREA_MIN_M,
    maxM: PLAY_AREA_MAX_M,
    stepM: PLAY_AREA_STEP_M,
    defaultM,
    currentM: clampPlayAreaRadiusM(currentM),
    isAuto: state.settings.playAreaRadiusM == null,
    presets: {
      tightM: clampPlayAreaRadiusM(Math.round(minGeometryM * 1.1)),
      balancedM: clampPlayAreaRadiusM(recommendedM),
      recommendedM: clampPlayAreaRadiusM(recommendedM),
      hideSeekM: clampPlayAreaRadiusM(PLAY_AREA_HIDE_SEEK_RADIUS_M),
      microM: clampPlayAreaRadiusM(PLAY_AREA_MICRO_RADIUS_M)
    },
    rallyHitM: state.playArea ? rallyHitRadiusM(state.playArea.radiusM) : rallyHitRadiusM(currentM)
  };
}

export function beginPlayAreaSetup(state: GameState, center: Coordinates): void {
  const radiusM = resolvePlayAreaRadiusM(state);
  state.playArea = {
    center: { ...center, accuracyM: center.accuracyM, ts: center.ts },
    radiusM
  };
  state.rallyPoints = {};
  for (const player of Object.values(state.players)) {
    player.reachedRally = false;
  }
}

export function setPlayAreaCenter(state: GameState, lat: number, lng: number): void {
  if (!["setup", "rally"].includes(state.phase)) throw new Error("Impossible de déplacer la zone maintenant");
  if (!state.playArea) throw new Error("Zone de jeu non définie");
  const center: Coordinates = {
    lat,
    lng,
    accuracyM: state.playArea.center.accuracyM,
    ts: Date.now()
  };
  if (state.phase === "setup") {
    state.playArea = { ...state.playArea, center };
    return;
  }
  assignRallyPoints(state, center);
}

export function confirmPlayAreaSetup(state: GameState): void {
  if (state.phase !== "setup") throw new Error("La zone n'est pas en préparation");
  if (!state.playArea?.center) throw new Error("Zone de jeu non définie");
  assignRallyPoints(state, state.playArea.center);
  state.phase = "rally";
  state.eventLog.push(`${Date.now()}:system:rally_started`);
}

export function setPlayAreaRadius(state: GameState, radiusM: number | null): void {
  if (state.phase === "finished") throw new Error("Impossible de modifier la zone après la partie");

  if (radiusM == null) {
    delete state.settings.playAreaRadiusM;
  } else {
    state.settings.playAreaRadiusM = clampPlayAreaRadiusM(radiusM);
  }

  const resolved = resolvePlayAreaRadiusM(state);
  if (state.playArea) {
    state.playArea = { ...state.playArea, radiusM: resolved };
    if (state.phase === "rally") {
      const center = state.playArea.center;
      const ids = Object.keys(state.players);
      ids.forEach((id, index) => {
        const bearing = (2 * Math.PI * index) / Math.max(ids.length, 1);
        const point = offsetMeters(center, rallySpreadM(resolved), bearing);
        state.rallyPoints[id] = { ...point, accuracyM: 10, ts: Date.now() };
      });
    }
    for (const player of Object.values(state.players)) {
      if (player.lastLocation) {
        player.lastLocation = clampToPlayArea(state.playArea, player.lastLocation);
      }
    }
    for (const mission of state.missions) {
      if (mission.point.lat) {
        mission.point = clampToPlayArea(state.playArea, mission.point);
      }
    }
  }

  state.eventLog.push(`${Date.now()}:system:play_area_radius:${resolved}`);
}

export function assignRallyPoints(state: GameState, center: Coordinates) {
  const ids = Object.keys(state.players);
  const radiusM = resolvePlayAreaRadiusM(state);
  state.playArea = {
    center: { ...center, accuracyM: center.accuracyM, ts: center.ts },
    radiusM
  };
  state.rallyPoints = {};
  ids.forEach((id, index) => {
    const bearing = (2 * Math.PI * index) / Math.max(ids.length, 1);
    const point = offsetMeters(center, rallySpreadM(radiusM), bearing);
    state.rallyPoints[id] = { ...point, accuracyM: 10, ts: Date.now() };
  });
}

export function clampToPlayArea(area: PlayArea, location: Coordinates): Coordinates {
  const dist = haversineMeters(area.center.lat, area.center.lng, location.lat, location.lng);
  if (dist <= area.radiusM) return location;
  const bearing = Math.atan2(
    (location.lng - area.center.lng) * Math.cos((area.center.lat * Math.PI) / 180),
    location.lat - area.center.lat
  );
  const insetM = Math.max(area.radiusM - 8, area.radiusM * 0.98);
  const edge = offsetMeters(area.center, insetM, bearing);
  return { ...edge, accuracyM: location.accuracyM, ts: location.ts };
}

export function constrainLocation(state: GameState, previous: Coordinates | null, next: Coordinates): Coordinates | null {
  let loc = next;
  if (state.playArea && (state.phase === "rally" || state.phase === "active")) {
    loc = clampToPlayArea(state.playArea, loc);
  }
  return clampLocation(previous, loc);
}

export function assignFugitiveMissions(state: GameState) {
  const fugitiveId = state.fugitiveId;
  if (!fugitiveId) throw new Error("fugitive not set");
  const fugitive = state.players[fugitiveId];
  if (!fugitive?.lastLocation) throw new Error("fugitive location required for missions");

  const base = fugitive.lastLocation;
  const names = pickMissionNames(3);
  const radiusM = state.playArea?.radiusM ?? computePlayAreaRadiusM(Object.keys(state.players).length, state.settings.boundaryPreset);
  const distances = missionDistancesM(radiusM);
  state.missions = [0, 1, 2].map((i) => {
    const bearing = ((Math.PI * 2) / 3) * i + Math.random() * 0.2;
    const distance = distances[i];
    const point = offsetMeters(base, distance, bearing);
    const raw = { ...point, accuracyM: 10, ts: Date.now() };
    const placed = state.playArea ? clampToPlayArea(state.playArea, raw) : raw;
    return {
      id: `m${i + 1}`,
      name: names[i],
      point: placed,
      completed: false,
      holdStartTick: null
    } as Mission;
  });
}

function pickMissionNames(count: number): string[] {
  const pool = [...MISSION_NAMES];
  const picked: string[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

export function markRallyReached(state: GameState, playerId: string) {
  const player = state.players[playerId];
  const target = state.rallyPoints[playerId];
  if (!player || !player.lastLocation || !target) return;
  const hitM = state.playArea ? rallyHitRadiusM(state.playArea.radiusM) : 40;
  if (haversineMeters(player.lastLocation.lat, player.lastLocation.lng, target.lat, target.lng) <= hitM) {
    player.reachedRally = true;
  }
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

export function completeMissionHold(
  state: GameState,
  playerId: string,
  missionId: string,
  requiredHoldSec: number = MISSION_HOLD_SEC
) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can capture missions");
  const mission = state.missions.find((m) => m.id === missionId);
  if (!mission || mission.completed || mission.holdStartTick === null) throw new Error("mission hold not started");
  if (!isPlayerNearMission(state, playerId, mission)) throw new Error("too far from mission point");
  if (state.tick - mission.holdStartTick < requiredHoldSec) throw new Error("hold duration too short");
  mission.completed = true;
  mission.holdStartTick = null;
  state.eventLog.push(`${Date.now()}:mission:${missionId}:completed`);
  if (state.missions.every((m) => m.completed)) {
    state.phase = "finished";
    state.winner = "fugitive";
    state.endReason = "missions";
    state.debriefPoint = computeDebriefPoint(state);
    state.eventLog.push(`${Date.now()}:system:fugitive_won`);
  }
}

export function canAttemptArrest(cop: GameState["players"][string], tick: number): { ok: boolean; reason: string; remainingSec: number } {
  if (!cop.arrestPenaltyAnchor) return { ok: true, reason: "", remainingSec: 0 };
  if (cop.arrestStillSinceTick === null) {
    return { ok: false, reason: "Restez immobile 10 s pour réessayer l'arrestation.", remainingSec: ARREST_FAIL_STILL_SEC };
  }
  const remainingSec = Math.max(0, ARREST_FAIL_STILL_SEC - (tick - cop.arrestStillSinceTick));
  if (remainingSec === 0) return { ok: true, reason: "", remainingSec: 0 };
  return { ok: false, reason: `Restez immobile encore ${remainingSec} s avant de réessayer.`, remainingSec };
}

export function updateArrestStillness(state: GameState, copId: string, loc: Coordinates): void {
  const cop = state.players[copId];
  if (!cop?.arrestPenaltyAnchor) return;
  const moved = haversineMeters(cop.arrestPenaltyAnchor.lat, cop.arrestPenaltyAnchor.lng, loc.lat, loc.lng);
  if (moved > ARREST_FAIL_MOVE_M) {
    cop.arrestStillSinceTick = null;
    cop.arrestPenaltyAnchor = { ...loc };
  } else if (cop.arrestStillSinceTick === null) {
    cop.arrestStillSinceTick = state.tick;
  }
}

function clearArrestPenalty(cop: GameState["players"][string]): void {
  cop.arrestPenaltyAnchor = null;
  cop.arrestStillSinceTick = null;
}

function tickArrestRecovery(state: GameState): void {
  for (const cop of Object.values(state.players)) {
    if (!cop.arrestPenaltyAnchor || cop.arrestStillSinceTick === null) continue;
    if (state.tick - cop.arrestStillSinceTick >= ARREST_FAIL_STILL_SEC) clearArrestPenalty(cop);
  }
}

export function attemptArrest(state: GameState, copId: string): { success: boolean; distanceM: number; thresholdM: number } {
  if (state.phase !== "active") throw new Error("arrest only possible during active chase");
  if (!state.fugitiveId) throw new Error("fugitive unknown");
  if (copId === state.fugitiveId) throw new Error("fugitive cannot arrest");

  const cop = state.players[copId];
  const fug = state.players[state.fugitiveId];
  if (!cop || !fug) throw new Error("player not found");
  const readiness = canAttemptArrest(cop, state.tick);
  if (!readiness.ok) throw new Error(readiness.reason);
  if (!cop.lastLocation || !fug.lastLocation) throw new Error("missing location for arrest");

  const distance = haversineMeters(cop.lastLocation.lat, cop.lastLocation.lng, fug.lastLocation.lat, fug.lastLocation.lng);
  const effectiveThreshold = Math.max(1, Math.min(8, (cop.lastLocation.accuracyM + fug.lastLocation.accuracyM) / 2));
  const success = distance <= effectiveThreshold;

  if (success) {
    state.phase = "finished";
    state.winner = "cops";
    state.endReason = "arrest";
    state.arrestedById = copId;
    state.debriefPoint = computeDebriefPoint(state);
    state.eventLog.push(`${Date.now()}:arrest:success:by:${copId}`);
  } else {
    cop.arrestPenaltyAnchor = { ...cop.lastLocation };
    cop.arrestStillSinceTick = null;
    state.eventLog.push(`${Date.now()}:arrest:failed:by:${copId}:d=${distance.toFixed(2)}`);
  }

  return { success, distanceM: distance, thresholdM: effectiveThreshold };
}

export function tickState(state: GameState): GameState {
  state.tick += 1;
  tickArrestRecovery(state);
  if (state.phase === "active") {
    if (state.tick >= state.durationSec) {
      state.phase = "finished";
      state.winner = "cops";
      state.endReason = "timeout";
      state.debriefPoint = computeDebriefPoint(state);
      state.eventLog.push(`${Date.now()}:system:time_up_cops_win`);
    }
    if (state.tick >= state.nextRevealTick) {
      const radiusM = state.playArea?.radiusM ?? 1320;
      state.revealUntilTick = state.tick + revealDisplaySec(radiusM);
      state.nextRevealTick = state.tick + revealIntervalSec(radiusM);
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

export function isCopScanActive(state: GameState): boolean {
  return state.phase === "active" && state.tick < state.copScanUntilTick;
}

export function useCopScan(state: GameState, playerId: string) {
  if (state.phase !== "active") throw new Error("scan des flics uniquement pendant la chasse");
  if (state.fugitiveId !== playerId) throw new Error("seul le fugitif peut scanner les flics");
  const player = state.players[playerId];
  if (!player) throw new Error("joueur introuvable");
  if (player.copScanUses >= MAX_COP_SCAN_USES) throw new Error("scan des flics déjà utilisé deux fois");
  if (isCopScanActive(state)) throw new Error("un scan est déjà actif");
  player.copScanUses += 1;
  state.copScanUntilTick = state.tick + COP_SCAN_DURATION_SEC;
  state.eventLog.push(`${Date.now()}:power:cop_scan:by:${playerId}`);
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
