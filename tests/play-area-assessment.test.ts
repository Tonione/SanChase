import { describe, expect, it } from "vitest";
import {
  assessPlayArea,
  computeRecommendedPlayAreaRadiusM
} from "../packages/shared/src/play-area-assessment.js";
import {
  computeMinPlayAreaRadiusM,
  PLAY_AREA_HIDE_SEEK_RADIUS_M,
  PLAY_AREA_MICRO_RADIUS_M,
  PLAY_AREA_MIN_M,
  rallySpreadM
} from "../packages/shared/src/play-area-layout.js";
import {
  assignRallyPoints,
  computePlayAreaRadiusM,
  createInitialState,
  resolvePlayAreaRadiusM,
  setPlayAreaRadius
} from "../packages/shared/src/rules.js";

describe("play area assessment", () => {
  it("computes urban geometry minimum from rally and missions", () => {
    expect(computeMinPlayAreaRadiusM()).toBe(1170);
  });

  it("allows micro hide-and-seek radii down to 20 m", () => {
    expect(PLAY_AREA_MIN_M).toBe(20);
    expect(PLAY_AREA_HIDE_SEEK_RADIUS_M).toBe(50);
    expect(PLAY_AREA_MICRO_RADIUS_M).toBe(25);
  });

  it("scales rally spread for tiny maps", () => {
    expect(rallySpreadM(50)).toBeLessThan(25);
    expect(rallySpreadM(50)).toBeGreaterThan(15);
  });

  it("assesses cache-cache size as balanced", () => {
    const result = assessPlayArea({ radiusM: 50, playerCount: 4 });
    expect(result.isMicro).toBe(true);
    expect(result.verdict).toBe("balanced");
    expect(result.diameterM).toBe(100);
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

  it("flags tight zones as cop-favored at urban scale", () => {
    const tight = assessPlayArea({ radiusM: 1200, playerCount: 6 });
    expect(tight.verdict).toBe("tight");
    expect(tight.evasionMarginM).toBeLessThan(80);
  });
});

describe("play area radius override", () => {
  it("stores override in lobby and applies on rally", () => {
    const state = createInitialState("roomx");
    state.players.a = { id: "a", name: "A", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.b = { id: "b", name: "B", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    setPlayAreaRadius(state, 1300);
    expect(state.settings.playAreaRadiusM).toBe(1300);
    assignRallyPoints(state, { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 });
    expect(state.playArea?.radiusM).toBe(1300);
  });

  it("assigns compact rally points for hide-and-seek radius", () => {
    const state = createInitialState("roomx");
    state.players.org1 = { id: "org1", name: "Org", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.hun1 = { id: "hun1", name: "Hun", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    setPlayAreaRadius(state, 50);
    assignRallyPoints(state, { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1 });
    const center = state.playArea!.center;
    const rp = state.rallyPoints.hun1;
    const dist = Math.hypot(
      (rp.lat - center.lat) * 111320,
      (rp.lng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180)
    );
    expect(dist).toBeLessThan(25);
    expect(state.playArea?.radiusM).toBe(50);
  });

  it("resets to auto when radius is cleared", () => {
    const state = createInitialState("roomx");
    state.players.a = { id: "a", name: "A", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.b = { id: "b", name: "B", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, copScanUses: 0, arrestPenaltyAnchor: null, arrestStillSinceTick: null, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    setPlayAreaRadius(state, 1800);
    setPlayAreaRadius(state, null);
    expect(state.settings.playAreaRadiusM).toBeUndefined();
    expect(resolvePlayAreaRadiusM(state)).toBe(computePlayAreaRadiusM(2));
  });
});
