import { describe, expect, it } from "vitest";
import {
  createInitialState,
  startMissionHold,
  updateMissionProximity
} from "../packages/shared/src/index.js";

describe("mission proximity gating", () => {
  it("requires consecutive near fixes before mission hold", () => {
    const state = createInitialState("roomx");
    state.phase = "active";
    state.tick = 10;
    state.fugitiveId = "fug1";
    state.playArea = { center: { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 }, radiusM: 500 };
    state.players.fug1 = {
      id: "fug1",
      name: "F",
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
      lastLocation: { lat: 48.8566, lng: 2.3522, accuracyM: 12, ts: Date.now() },
      missionProximityId: null,
      missionProximityStreak: 0,
      cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 }
    };
    state.missions = [{
      id: "m1",
      name: "Test",
      point: { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1 },
      completed: false,
      holdStartTick: null
    }];

    expect(() => startMissionHold(state, "fug1", "m1")).toThrow(/instable/i);
    updateMissionProximity(state, "fug1");
    expect(() => startMissionHold(state, "fug1", "m1")).toThrow(/instable/i);
    updateMissionProximity(state, "fug1");
    expect(() => startMissionHold(state, "fug1", "m1")).not.toThrow();
  });
});
