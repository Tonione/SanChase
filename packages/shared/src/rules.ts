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
  radarRangeM,
  rallySpreadM
} from "./play-area-layout.js";
import {
  isLocationAccurateEnough,
  isLocationFresh,
  LOCATION_MAX_ACCURACY_M,
  LOCATION_WEAK_ACCURACY_M,
  MISSION_PROXIMITY_FIXES_REQUIRED,
  rallyHitRadiusWithAccuracy,
  rejectImplausibleJump
} from "./location-quality.js";
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
export const OUTSIDE_GRACE_SEC = 20;
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
    copRadars: [],
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

export function resetRoomToLobby(state: GameState): GameState {
  const fresh = createInitialState(state.roomId, state.settings);
  fresh.players = Object.fromEntries(
    Object.entries(state.players).map(([id, p]) => [
      id,
      {
        ...p,
        connected: p.connected,
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
        missionProximityId: null,
        missionProximityStreak: 0,
        cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
      }
    ])
  );
  fresh.eventLog.push(`${Date.now()}:system:dev_reset_lobby`);
  return fresh;
}

function resetPlayerRoundState(player: GameState["players"][string]) {
  player.reachedRally = false;
  player.usedRadar = false;
  player.usedDecoyPower = false;
  player.copScanUses = 0;
  player.arrestPenaltyAnchor = null;
  player.arrestStillRemainingSec = null;
  player.arrestStillCounting = false;
  player.outsideSinceTick = null;
  player.eliminated = false;
  player.missionProximityId = null;
  player.missionProximityStreak = 0;
  player.cooldowns = { sonar_ping: 0, jam: 0, fake_clue: 0 };
}

export function resetRoomToSetup(state: GameState, organizerId: string): GameState {
  const organizer = state.players[organizerId];
  if (!organizer || organizer.role !== "organizer") throw new Error("only organizer can reset game");
  if (state.phase === "lobby") throw new Error("game not started");
  const center = organizer.lastLocation;
  if (!center) throw new Error("organizer location required");

  for (const player of Object.values(state.players)) {
    resetPlayerRoundState(player);
  }

  state.phase = "setup";
  state.winner = null;
  state.endReason = null;
  state.arrestedById = null;
  state.debriefPoint = null;
  state.missions = [];
  state.copRadars = [];
  state.revealUntilTick = 0;
  state.nextRevealTick = 0;
  state.decoyNextReveal = false;
  state.copScanUntilTick = 0;
  state.rallyPoints = {};
  beginPlayAreaSetup(state, center);
  state.eventLog.push(`${Date.now()}:system:organizer_reset_setup`);
  return state;
}

export function clampLocation(previous: Coordinates | null, next: Coordinates): Coordinates | null {
  if (next.accuracyM > LOCATION_MAX_ACCURACY_M) return previous;
  if (rejectImplausibleJump(previous, next)) return previous;
  if (!previous) return next;
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
  resetBoundaryState(state);
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

export function confirmPlayAreaSetup(state: GameState, organizerId?: string): void {
  if (state.phase !== "setup") throw new Error("La zone n'est pas en préparation");
  if (!state.playArea?.center) throw new Error("Zone de jeu non définie");
  const organizer = organizerId ? state.players[organizerId] : undefined;
  const center = organizer?.lastLocation ?? state.playArea.center;
  if (organizer?.lastLocation) {
    state.playArea = { ...state.playArea, center: { ...organizer.lastLocation } };
  }
  assignRallyPoints(state, center);
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

export function isInsidePlayArea(area: PlayArea, location: Coordinates): boolean {
  return haversineMeters(area.center.lat, area.center.lng, location.lat, location.lng) <= area.radiusM;
}

export function outsideGraceRemainingSec(state: GameState, playerId: string): number | null {
  const player = state.players[playerId];
  if (!player?.outsideSinceTick || player.eliminated) return null;
  return Math.max(0, OUTSIDE_GRACE_SEC - (state.tick - player.outsideSinceTick));
}

export function updatePlayerBoundary(state: GameState, playerId: string): void {
  if (!state.playArea || !["rally", "active"].includes(state.phase)) return;
  const player = state.players[playerId];
  if (!player?.lastLocation || player.eliminated) return;

  if (isInsidePlayArea(state.playArea, player.lastLocation)) {
    player.outsideSinceTick = null;
    return;
  }

  if (player.outsideSinceTick === null) {
    player.outsideSinceTick = state.tick;
  }
}

export function resetBoundaryState(state: GameState): void {
  for (const player of Object.values(state.players)) {
    player.eliminated = false;
    player.outsideSinceTick = null;
  }
}

export function constrainLocation(state: GameState, previous: Coordinates | null, next: Coordinates): Coordinates | null {
  return clampLocation(previous, next);
}

export function assignFugitiveMissions(state: GameState) {
  const fugitiveId = state.fugitiveId;
  if (!fugitiveId) throw new Error("fugitive not set");
  const fugitive = state.players[fugitiveId];
  if (!fugitive?.lastLocation) throw new Error("fugitive location required for missions");

  const base = fugitive.lastLocation;
  const names = pickMissionNames(3);
  const radiusM = state.playArea?.radiusM ?? computePlayAreaRadiusM(Object.keys(state.players).length, state.settings.boundaryPreset);
  const bearings = pickRandomMissionBearings(3);
  const distances = shuffleMissionDistances(missionDistancesM(radiusM));
  state.missions = bearings.map((bearing, i) => {
    const point = offsetMeters(base, distances[i], bearing);
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

function pickRandomMissionBearings(count: number, minSepRad = Math.PI / 2.5): number[] {
  const bearings: number[] = [];
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const bearing = Math.random() * Math.PI * 2;
      if (bearings.every((existing) => angularSeparationRad(existing, bearing) >= minSepRad)) {
        bearings.push(bearing);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const rotation = Math.random() * Math.PI * 2;
      return Array.from({ length: count }, (_, idx) => rotation + ((Math.PI * 2) / count) * idx);
    }
  }
  return bearings;
}

function angularSeparationRad(a: number, b: number): number {
  const diff = Math.abs(a - b) % (Math.PI * 2);
  return Math.min(diff, Math.PI * 2 - diff);
}

function shuffleMissionDistances(distances: number[]): number[] {
  const copy = [...distances];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.map((distance) => distance * (0.82 + Math.random() * 0.36));
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

export function markRallyReached(state: GameState, playerId: string, nowMs: number = Date.now()) {
  const player = state.players[playerId];
  const target = state.rallyPoints[playerId];
  if (!player || !player.lastLocation || !target) return;
  if (!isLocationFresh(player.lastLocation, nowMs)) return;
  if (player.lastLocation.accuracyM > LOCATION_WEAK_ACCURACY_M) return;
  const hitM = state.playArea
    ? rallyHitRadiusWithAccuracy(rallyHitRadiusM(state.playArea.radiusM), player.lastLocation)
    : rallyHitRadiusWithAccuracy(40, player.lastLocation);
  if (haversineMeters(player.lastLocation.lat, player.lastLocation.lng, target.lat, target.lng) <= hitM) {
    player.reachedRally = true;
  }
}

export function updateMissionProximity(state: GameState, playerId: string, nowMs: number = Date.now()) {
  const player = state.players[playerId];
  if (!player) return;
  if (state.phase !== "active" || state.fugitiveId !== playerId) {
    player.missionProximityId = null;
    player.missionProximityStreak = 0;
    return;
  }

  const loc = player.lastLocation;
  if (!loc || !isLocationFresh(loc, nowMs) || loc.accuracyM > LOCATION_WEAK_ACCURACY_M) {
    player.missionProximityId = null;
    player.missionProximityStreak = 0;
    return;
  }

  const nearMission = state.missions.find(
    (mission) => !mission.completed && isPlayerNearMission(state, playerId, mission)
  );
  if (!nearMission) {
    player.missionProximityId = null;
    player.missionProximityStreak = 0;
    return;
  }

  if (player.missionProximityId === nearMission.id) {
    player.missionProximityStreak = Math.min(player.missionProximityStreak + 1, 8);
  } else {
    player.missionProximityId = nearMission.id;
    player.missionProximityStreak = 1;
  }
}

export function startMissionHold(state: GameState, playerId: string, missionId: string, nowMs: number = Date.now()) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can capture missions");
  const player = state.players[playerId];
  if (player?.eliminated) throw new Error("vous êtes éliminé");
  const mission = state.missions.find((m) => m.id === missionId);
  if (!mission || mission.completed) throw new Error("mission not available");
  if (!player?.lastLocation || !isLocationFresh(player.lastLocation, nowMs)) throw new Error("GPS trop ancien");
  if (!isLocationAccurateEnough(player.lastLocation, LOCATION_WEAK_ACCURACY_M)) throw new Error("GPS trop imprécis");
  if (!isPlayerNearMission(state, playerId, mission)) throw new Error("too far from mission point");
  if (
    player.missionProximityId !== missionId ||
    player.missionProximityStreak < MISSION_PROXIMITY_FIXES_REQUIRED
  ) {
    throw new Error("GPS instable — restez sur la mission quelques secondes");
  }
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

export function canAttemptArrest(cop: GameState["players"][string], _tick: number): { ok: boolean; reason: string; remainingSec: number } {
  if (!cop.arrestPenaltyAnchor || cop.arrestStillRemainingSec == null || cop.arrestStillRemainingSec <= 0) {
    return { ok: true, reason: "", remainingSec: 0 };
  }
  const remainingSec = cop.arrestStillRemainingSec;
  const reason = cop.arrestStillCounting
    ? `Restez immobile encore ${remainingSec} s avant de réessayer.`
    : `Restez immobile ${remainingSec} s pour réessayer l'arrestation.`;
  return { ok: false, reason, remainingSec };
}

export function updateArrestStillness(state: GameState, copId: string, loc: Coordinates): void {
  const cop = state.players[copId];
  if (!cop?.arrestPenaltyAnchor || cop.arrestStillRemainingSec == null || cop.arrestStillRemainingSec <= 0) return;
  const moved = haversineMeters(cop.arrestPenaltyAnchor.lat, cop.arrestPenaltyAnchor.lng, loc.lat, loc.lng);
  if (moved > ARREST_FAIL_MOVE_M) {
    cop.arrestStillCounting = false;
    cop.arrestPenaltyAnchor = { ...loc };
  } else {
    cop.arrestStillCounting = true;
  }
}

function clearArrestPenalty(cop: GameState["players"][string]): void {
  cop.arrestPenaltyAnchor = null;
  cop.arrestStillRemainingSec = null;
  cop.arrestStillCounting = false;
}

function tickArrestRecovery(state: GameState): void {
  for (const cop of Object.values(state.players)) {
    if (!cop.arrestPenaltyAnchor || cop.arrestStillRemainingSec == null || cop.arrestStillRemainingSec <= 0) continue;
    if (!cop.arrestStillCounting) continue;
    cop.arrestStillRemainingSec -= 1;
    if (cop.arrestStillRemainingSec <= 0) clearArrestPenalty(cop);
  }
}

export function attemptArrest(
  state: GameState,
  copId: string,
  nowMs: number = Date.now()
): { success: boolean; distanceM: number; thresholdM: number } {
  if (state.phase !== "active") throw new Error("arrest only possible during active chase");
  if (!state.fugitiveId) throw new Error("fugitive unknown");
  if (copId === state.fugitiveId) throw new Error("fugitive cannot arrest");

  const cop = state.players[copId];
  const fug = state.players[state.fugitiveId];
  if (!cop || !fug) throw new Error("player not found");
  if (cop.eliminated) throw new Error("vous êtes éliminé");
  if (fug.eliminated) throw new Error("fugitive already eliminated");
  const readiness = canAttemptArrest(cop, state.tick);
  if (!readiness.ok) throw new Error(readiness.reason);
  if (!cop.lastLocation || !fug.lastLocation) throw new Error("missing location for arrest");
  if (!isLocationFresh(cop.lastLocation, nowMs) || !isLocationFresh(fug.lastLocation, nowMs)) {
    throw new Error("GPS trop ancien pour arrêter");
  }
  if (!isLocationAccurateEnough(cop.lastLocation, LOCATION_WEAK_ACCURACY_M)) {
    throw new Error("Votre GPS est trop imprécis pour arrêter");
  }

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
    cop.arrestStillRemainingSec = ARREST_FAIL_STILL_SEC;
    cop.arrestStillCounting = false;
    state.eventLog.push(`${Date.now()}:arrest:failed:by:${copId}:d=${distance.toFixed(2)}`);
  }

  return { success, distanceM: distance, thresholdM: effectiveThreshold };
}

export function tickState(state: GameState): GameState {
  state.tick += 1;
  tickArrestRecovery(state);
  tickBoundaryElimination(state);
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
  const radiusM = state.playArea?.radiusM ?? 1320;
  const minD = Math.max(6, radiusM * 0.15);
  const maxD = Math.max(minD + 4, radiusM * 0.55);
  return [truth, makeDecoyPoint(state, truth, minD, maxD), makeDecoyPoint(state, truth, minD, maxD)];
}

export function isCopScanActive(state: GameState): boolean {
  return state.phase === "active" && state.tick < state.copScanUntilTick;
}

export function useCopScan(state: GameState, playerId: string) {
  if (state.phase !== "active") throw new Error("scan des flics uniquement pendant la chasse");
  if (state.fugitiveId !== playerId) throw new Error("seul le fugitif peut scanner les flics");
  const player = state.players[playerId];
  if (!player) throw new Error("joueur introuvable");
  if (player.eliminated) throw new Error("vous êtes éliminé");
  if (player.copScanUses >= MAX_COP_SCAN_USES) throw new Error("scan des flics déjà utilisé deux fois");
  if (isCopScanActive(state)) throw new Error("un scan est déjà actif");
  player.copScanUses += 1;
  state.copScanUntilTick = state.tick + COP_SCAN_DURATION_SEC;
  state.eventLog.push(`${Date.now()}:power:cop_scan:by:${playerId}`);
}

export function deployCopRadar(state: GameState, playerId: string) {
  if (state.phase !== "active") throw new Error("radar uniquement pendant la chasse");
  if (playerId === state.fugitiveId) throw new Error("seul un flic peut poser un radar");
  const player = state.players[playerId];
  if (!player || player.eliminated) throw new Error("vous êtes éliminé");
  if (player.usedRadar) throw new Error("radar déjà posé");
  if (!player.lastLocation) throw new Error("position GPS requise");
  player.usedRadar = true;
  state.copRadars.push({
    id: `rad_${playerId}_${state.tick}`,
    ownerId: playerId,
    point: { ...player.lastLocation }
  });
  state.eventLog.push(`${Date.now()}:power:radar:by:${playerId}`);
}

export function computeRadarDetections(
  state: GameState,
  copId: string
): Array<{ radarId: string; position: Coordinates }> {
  const fugitive = state.fugitiveId ? state.players[state.fugitiveId] : null;
  if (state.phase !== "active" || !fugitive?.lastLocation) return [];
  const rangeM = radarRangeM(state.playArea?.radiusM ?? 1320);
  const fugLoc = fugitive.lastLocation;
  return state.copRadars
    .filter((radar) => radar.ownerId === copId)
    .filter((radar) => haversineMeters(radar.point.lat, radar.point.lng, fugLoc.lat, fugLoc.lng) <= rangeM)
    .map((radar) => ({ radarId: radar.id, position: { ...fugLoc } }));
}

export function getPlayerViewRadars(state: GameState, playerId: string) {
  const isFugitive = state.fugitiveId === playerId;
  if (isFugitive) {
    return isCopScanActive(state) ? state.copRadars : [];
  }
  if (playerId === state.fugitiveId) return [];
  return state.copRadars.filter((radar) => radar.ownerId === playerId);
}

export function buildPlayerView(state: GameState, playerId: string) {
  return {
    copRadars: getPlayerViewRadars(state, playerId),
    radarDetections: state.fugitiveId === playerId ? [] : computeRadarDetections(state, playerId),
    radarRangeM: radarRangeM(state.playArea?.radiusM ?? 1320)
  };
}

export function enableNextDecoyReveal(state: GameState, playerId: string) {
  if (state.fugitiveId !== playerId) throw new Error("only fugitive can enable decoy reveal");
  const player = state.players[playerId];
  if (!player) throw new Error("joueur introuvable");
  if (player.eliminated) throw new Error("vous êtes éliminé");
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

function missionReachRadiusM(loc: Coordinates | undefined): number {
  return MISSION_HIT_M + Math.min(25, loc?.accuracyM ?? 20);
}

function isPlayerNearMission(state: GameState, playerId: string, mission: Mission) {
  const loc = state.players[playerId]?.lastLocation;
  return !!loc && haversineMeters(loc.lat, loc.lng, mission.point.lat, mission.point.lng) <= missionReachRadiusM(loc);
}

function tickBoundaryElimination(state: GameState): void {
  if (!state.playArea || !["rally", "active"].includes(state.phase)) return;

  for (const player of Object.values(state.players)) {
    if (player.eliminated || !player.lastLocation || player.outsideSinceTick === null) continue;
    if (state.tick - player.outsideSinceTick < OUTSIDE_GRACE_SEC) continue;
    eliminatePlayerForBoundary(state, player.id);
  }
}

function eliminatePlayerForBoundary(state: GameState, playerId: string): void {
  const player = state.players[playerId];
  if (!player || player.eliminated) return;
  player.eliminated = true;
  player.outsideSinceTick = null;
  state.eventLog.push(`${Date.now()}:eliminated:${playerId}:boundary`);

  if (playerId === state.fugitiveId) {
    state.phase = "finished";
    state.winner = "cops";
    state.endReason = "boundary";
    state.debriefPoint = computeDebriefPoint(state);
    state.eventLog.push(`${Date.now()}:system:fugitive_eliminated_outside`);
  }
}

function makeDecoyPoint(state: GameState, origin: Coordinates, minDistM: number, maxDistM: number): Coordinates {
  for (let attempt = 0; attempt < 16; attempt++) {
    const scale = attempt < 8 ? 1 : 0.72;
    const dist = (minDistM + Math.random() * (maxDistM - minDistM)) * scale;
    const point = jitterPoint(origin, dist);
    if (!state.playArea) return point;
    const fromCenter = haversineMeters(state.playArea.center.lat, state.playArea.center.lng, point.lat, point.lng);
    const fromTruth = haversineMeters(origin.lat, origin.lng, point.lat, point.lng);
    if (fromCenter <= state.playArea.radiusM * 0.92 && fromTruth >= 4) {
      return { ...point, accuracyM: origin.accuracyM, ts: Date.now() };
    }
  }

  if (state.playArea) {
    const bearing = Math.random() * Math.PI * 2;
    const dist = state.playArea.radiusM * (0.2 + Math.random() * 0.45);
    const fallback = offsetMeters(state.playArea.center, dist, bearing);
    return { ...fallback, accuracyM: origin.accuracyM, ts: Date.now() };
  }

  return jitterPoint(origin, minDistM);
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
