import { describe, expect, it } from "vitest";
import {
  buildPlayerView,
  computeRadarDetections,
  createInitialState,
  deployCopRadar,
  radarRangeM,
  useCopScan
} from "../packages/shared/src/index.js";

describe("cop radar", () => {
  it("scales radar range with play area size", () => {
    expect(radarRangeM(1320)).toBe(75);
    expect(radarRangeM(50)).toBe(12);
    expect(radarRangeM(200)).toBe(36);
  });

  it("detects fugitive within owned radar range", () => {
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.playArea = { center: { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 }, radiusM: 800 };
    state.players.cop1 = {
      id: "cop1",
      name: "Bill",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedRadar: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillRemainingSec: null,
      arrestStillCounting: false,
      outsideSinceTick: null,
      eliminated: false,
      lastLocation: { lat: 48.8566, lng: 2.3522, accuracyM: 8, ts: Date.now() },
      missionProximityId: null,
      missionProximityStreak: 0,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };
    state.players.fug1 = {
      id: "fug1",
      name: "Fug",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedRadar: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillRemainingSec: null,
      arrestStillCounting: false,
      outsideSinceTick: null,
      eliminated: false,
      lastLocation: { lat: 48.85665, lng: 2.35225, accuracyM: 8, ts: Date.now() },
      missionProximityId: null,
      missionProximityStreak: 0,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };

    deployCopRadar(state, "cop1");
    expect(state.copRadars).toHaveLength(1);
    expect(computeRadarDetections(state, "cop1")).toHaveLength(1);

    const view = buildPlayerView(state, "cop1");
    expect(view.copRadars).toHaveLength(1);
    expect(view.radarDetections).toHaveLength(1);
    expect(buildPlayerView(state, "fug1").copRadars).toEqual([]);
    expect(buildPlayerView(state, "fug1").radarDetections).toEqual([]);
  });

  it("shows all radar ranges to the fugitive during a cop scan", () => {
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.playArea = { center: { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 }, radiusM: 800 };
    state.players.cop1 = {
      id: "cop1",
      name: "Bill",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedRadar: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillRemainingSec: null,
      arrestStillCounting: false,
      outsideSinceTick: null,
      eliminated: false,
      lastLocation: { lat: 48.8566, lng: 2.3522, accuracyM: 8, ts: Date.now() },
      missionProximityId: null,
      missionProximityStreak: 0,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };
    state.players.fug1 = {
      id: "fug1",
      name: "Fug",
      role: "hunter",
      connected: true,
      ready: true,
      reachedRally: true,
      usedRadar: false,
      usedDecoyPower: false,
      copScanUses: 0,
      arrestPenaltyAnchor: null,
      arrestStillRemainingSec: null,
      arrestStillCounting: false,
      outsideSinceTick: null,
      eliminated: false,
      lastLocation: { lat: 48.857, lng: 2.353, accuracyM: 8, ts: Date.now() },
      missionProximityId: null,
      missionProximityStreak: 0,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };

    deployCopRadar(state, "cop1");
    useCopScan(state, "fug1");

    const view = buildPlayerView(state, "fug1");
    expect(view.copRadars).toHaveLength(1);
    expect(view.radarRangeM).toBe(75);
    expect(view.radarDetections).toEqual([]);
  });
});
