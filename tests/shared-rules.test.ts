import { describe, expect, it } from "vitest";
import { RoomManager } from "../services/game-server/src/room-manager.js";
import { attemptArrest, assignFugitiveMissions, assignRallyPoints, beginPlayAreaSetup, canStartChase, canStartGame, completeMissionHold, computePlayAreaRadiusM, confirmPlayAreaSetup, createInitialState, enableNextDecoyReveal, isInsidePlayArea, rallyProgress, revealPositions, setPlayAreaCenter, startMissionHold, tickState, updateArrestStillness, updatePlayerBoundary, useCopScan } from "../packages/shared/src/index.js";

describe("shared rules", () => {
  it("requires min players and ready", () => {
    const state = createInitialState("roomx", { minPlayersToStart: 2 });
    state.players.org1 = { id: "org1", name: "Org", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.hun1 = { id: "hun1", name: "Hun", role: "hunter", connected: true, ready: false, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    expect(canStartGame(state).ok).toBe(false);
    state.players.hun1.ready = true;
    expect(canStartGame(state).ok).toBe(true);
  });

  it("completes mission after 30s hold", () => {
    const state = createInitialState("roomx");
    state.fugitiveId = "fug1";
    state.players.fug1 = { id: "fug1", name: "F", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: { lat: 1, lng: 1, accuracyM: 10, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.missions = [{ id: "m1", name: "Déposer un colis mort", point: { lat: 1, lng: 1, accuracyM: 10, ts: 1 }, completed: false, holdStartTick: null }];
    startMissionHold(state, "fug1", "m1");
    state.tick += 30;
    completeMissionHold(state, "fug1", "m1");
    expect(state.missions[0].completed).toBe(true);
  });

  it("reports rally progress before chase start", () => {
    const state = createInitialState("roomx");
    state.phase = "rally";
    state.players.a = { id: "a", name: "A", role: "hunter", connected: true, ready: true, reachedRally: true, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.b = { id: "b", name: "B", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    expect(rallyProgress(state)).toEqual({ reached: 1, total: 2 });
    expect(canStartChase(state).reason).toMatch(/1\/2.*il en manque 1/);
  });

  it("allows forced chase start when players are missing", () => {
    const manager = new RoomManager();
    manager.createRoom("force1", "org1", "Org", { minPlayersToStart: 2, fugitiveSelection: "manual" });
    manager.join("force1", "hun1", "Hun");
    manager.selectFugitive("force1", "org1", "hun1");
    manager.updateLocation("force1", "org1", { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 });
    manager.updateLocation("force1", "hun1", { lat: 48.8505, lng: 2.351, accuracyM: 10, ts: 1 });
    manager.setReady("force1", "org1", true);
    manager.setReady("force1", "hun1", true);
    manager.startGame("force1", "org1");
    expect(manager.get("force1")?.state.phase).toBe("setup");
    manager.confirmSetup("force1", "org1");
    expect(canStartChase(manager.get("force1")!.state).ok).toBe(false);
    manager.startChase("force1", "org1", true);
    expect(manager.get("force1")?.state.phase).toBe("active");
  });

  it("lets organizer adjust play area during setup before rally", () => {
    const state = createInitialState("roomx");
    state.phase = "setup";
    state.players.org1 = { id: "org1", name: "Org", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.hun1 = { id: "hun1", name: "Hun", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    beginPlayAreaSetup(state, state.players.org1.lastLocation!);
    expect(state.rallyPoints).toEqual({});
    setPlayAreaCenter(state, 48.851, 2.351);
    expect(state.playArea?.center.lat).toBe(48.851);
    confirmPlayAreaSetup(state);
    expect(state.phase).toBe("rally");
    expect(Object.keys(state.rallyPoints)).toEqual(["org1", "hun1"]);
  });

  it("recenters play area on organizer GPS when confirming setup", () => {
    const state = createInitialState("roomx");
    state.phase = "setup";
    state.players.org1 = { id: "org1", name: "Org", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: { lat: 48.86, lng: 2.36, accuracyM: 10, ts: 2 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.hun1 = { id: "hun1", name: "Hun", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    beginPlayAreaSetup(state, { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 });
    confirmPlayAreaSetup(state, "org1");
    expect(state.playArea?.center.lat).toBe(48.86);
    expect(state.playArea?.center.lng).toBe(2.36);
  });

  it("scales play area with player count", () => {
    expect(computePlayAreaRadiusM(6)).toBe(computePlayAreaRadiusM(6));
    expect(computePlayAreaRadiusM(12)).toBeLessThan(computePlayAreaRadiusM(6));

    const state = createInitialState("roomx");
    state.players.a = { id: "a", name: "A", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.b = { id: "b", name: "B", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    assignRallyPoints(state, { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 });
    expect(state.playArea?.radiusM).toBe(computePlayAreaRadiusM(2));
    expect(state.playArea?.center.lat).toBe(48.85);
  });

  it("randomizes mission placement across launches", () => {
    const base = { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 };
    const layouts = new Set<string>();
    for (let run = 0; run < 24; run++) {
      const state = createInitialState("roomx");
      state.fugitiveId = "fug1";
      state.players.fug1 = { id: "fug1", name: "F", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: base, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
      assignRallyPoints(state, base);
      assignFugitiveMissions(state);
      layouts.add(state.missions.map((m) => `${m.point.lat.toFixed(5)},${m.point.lng.toFixed(5)}`).join("|"));
    }
    expect(layouts.size).toBeGreaterThan(1);
  });

  it("keeps decoy reveals inside small play areas", () => {
    const center = { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 };
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.playArea = { center, radiusM: 50 };
    state.players.fug1 = {
      id: "fug1",
      name: "F",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedNoisePing: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillSinceTick: null,
      outsideSinceTick: null,
      eliminated: false,
      lastLocation: center,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };
    enableNextDecoyReveal(state, "fug1");
    const positions = revealPositions(state);
    expect(positions).toHaveLength(3);
    for (const point of positions.slice(1)) {
      expect(isInsidePlayArea(state.playArea!, point)).toBe(true);
    }
  });

  it("eliminates fugitive after 20s outside play area", () => {
    const center = { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 };
    const outside = { lat: 48.8576, lng: 2.3522, accuracyM: 10, ts: 2 };
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.playArea = { center, radiusM: 50 };
    state.players.fug1 = {
      id: "fug1",
      name: "F",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedNoisePing: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillSinceTick: null,
      outsideSinceTick: null,
      eliminated: false,
      lastLocation: outside,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };
    updatePlayerBoundary(state, "fug1");
    expect(state.players.fug1.outsideSinceTick).toBe(0);
    state.tick = 20;
    tickState(state);
    expect(state.players.fug1.eliminated).toBe(true);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe("cops");
    expect(state.endReason).toBe("boundary");
  });

  it("clears outside countdown when player re-enters play area", () => {
    const center = { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 };
    const state = createInitialState("roomx");
    state.phase = "active";
    state.playArea = { center, radiusM: 50 };
    state.players.cop1 = {
      id: "cop1",
      name: "C",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedNoisePing: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillSinceTick: null,
      outsideSinceTick: 5,
      eliminated: false,
      lastLocation: center,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };
    updatePlayerBoundary(state, "cop1");
    expect(state.players.cop1.outsideSinceTick).toBeNull();
  });

  it("allows fugitive to scan cops twice for three minutes", () => {
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.players.fug1 = { id: "fug1", name: "F", role: "hunter", connected: true, ready: true, reachedRally: true, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    useCopScan(state, "fug1");
    expect(state.copScanUntilTick).toBe(180);
    expect(state.players.fug1.copScanUses).toBe(1);
    state.tick = 180;
    useCopScan(state, "fug1");
    expect(state.players.fug1.copScanUses).toBe(2);
    expect(() => useCopScan(state, "fug1")).toThrow(/deux fois/);
  });

  it("requires cop to stay still after failed arrest", () => {
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.players.fug1 = { id: "fug1", name: "F", role: "hunter", connected: true, ready: true, reachedRally: true, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: { lat: 48.85, lng: 2.35, accuracyM: 3, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.cop1 = { id: "cop1", name: "C", role: "hunter", connected: true, ready: true, reachedRally: true, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: { lat: 48.851, lng: 2.351, accuracyM: 3, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    attemptArrest(state, "cop1");
    expect(state.players.cop1.arrestPenaltyAnchor).not.toBeNull();
    expect(() => attemptArrest(state, "cop1")).toThrow(/immobile/);
    updateArrestStillness(state, "cop1", state.players.cop1.lastLocation!);
    expect(state.players.cop1.arrestStillSinceTick).toBe(0);
    state.tick = 10;
    tickState(state);
    expect(state.players.cop1.arrestPenaltyAnchor).toBeNull();
    attemptArrest(state, "cop1");
    expect(state.players.cop1.arrestPenaltyAnchor).not.toBeNull();
  });
});
