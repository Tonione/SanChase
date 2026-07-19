import { describe, expect, it } from "vitest";
import {
  assessPlayArea,
  computeMinPlayAreaRadiusM,
  computeRecommendedPlayAreaRadiusM
} from "../packages/shared/src/play-area-assessment.js";
import {
  assignRallyPoints,
  computePlayAreaRadiusM,
  createInitialState,
  resolvePlayAreaRadiusM,
  setPlayAreaRadius
} from "../packages/shared/src/rules.js";

describe("play area assessment", () => {
  it("computes geometry minimum from rally and missions", () => {
    expect(computeMinPlayAreaRadiusM()).toBe(1170);
  });

  it("recommends smaller zones with more cops", () => {
    expect(computeRecommendedPlayAreaRadiusM(12)).toBeLessThan(computeRecommendedPlayAreaRadiusM(4));
  });

  it("matches gameplay formula", () => {
    expect(computePlayAreaRadiusM(6)).toBe(computeRecommendedPlayAreaRadiusM(6));
  });

  it("flags oversized zones", () => {
    const huge = assessPlayArea({ radiusM: 2000, playerCount: 6 });
    expect(["large", "too_large"]).toContain(huge.verdict);
    expect(huge.walkCrossingMin).toBeGreaterThan(30);
  });

  it("flags tight zones as cop-favored", () => {
    const tight = assessPlayArea({ radiusM: 1200, playerCount: 6 });
    expect(tight.verdict).toBe("tight");
    expect(tight.evasionMarginM).toBeLessThan(80);
  });
});

describe("play area radius override", () => {
  it("stores override in lobby and applies on rally", () => {
    const state = createInitialState("roomx");
    state.players.a = { id: "a", name: "A", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestAttemptsUsed: 0, lastLocation: { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.b = { id: "b", name: "B", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestAttemptsUsed: 0, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    setPlayAreaRadius(state, 1300);
    expect(state.settings.playAreaRadiusM).toBe(1300);
    assignRallyPoints(state, { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 });
    expect(state.playArea?.radiusM).toBe(1300);
  });

  it("resets to auto when radius is cleared", () => {
    const state = createInitialState("roomx");
    state.players.a = { id: "a", name: "A", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestAttemptsUsed: 0, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.b = { id: "b", name: "B", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestAttemptsUsed: 0, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    setPlayAreaRadius(state, 1800);
    setPlayAreaRadius(state, null);
    expect(state.settings.playAreaRadiusM).toBeUndefined();
    expect(resolvePlayAreaRadiusM(state)).toBe(1486);
  });
});
