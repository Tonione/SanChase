import { describe, expect, it } from "vitest";
import { attemptArrest, canStartGame, completeMissionHold, createInitialState, startMissionHold } from "../packages/shared/src/index.js";

describe("shared rules", () => {
  it("requires min players and ready", () => {
    const state = createInitialState("roomx", { minPlayersToStart: 2 });
    state.players.org1 = { id: "org1", name: "Org", role: "organizer", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, arrestAttemptsUsed: 0, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.hun1 = { id: "hun1", name: "Hun", role: "hunter", connected: true, ready: false, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, arrestAttemptsUsed: 0, lastLocation: null, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    expect(canStartGame(state).ok).toBe(false);
    state.players.hun1.ready = true;
    expect(canStartGame(state).ok).toBe(true);
  });

  it("completes mission after 30s hold", () => {
    const state = createInitialState("roomx");
    state.fugitiveId = "fug1";
    state.players.fug1 = { id: "fug1", name: "F", role: "hunter", connected: true, ready: true, reachedRally: false, usedNoisePing: false, usedDecoyPower: false, arrestAttemptsUsed: 0, lastLocation: { lat: 1, lng: 1, accuracyM: 10, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.missions = [{ id: "m1", point: { lat: 1, lng: 1, accuracyM: 10, ts: 1 }, completed: false, holdStartTick: null }];
    startMissionHold(state, "fug1", "m1");
    state.tick += 30;
    completeMissionHold(state, "fug1", "m1");
    expect(state.missions[0].completed).toBe(true);
  });

  it("limits each cop to two arrest attempts", () => {
    const state = createInitialState("roomx");
    state.phase = "active";
    state.fugitiveId = "fug1";
    state.players.fug1 = { id: "fug1", name: "F", role: "hunter", connected: true, ready: true, reachedRally: true, usedNoisePing: false, usedDecoyPower: false, arrestAttemptsUsed: 0, lastLocation: { lat: 48.85, lng: 2.35, accuracyM: 3, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    state.players.cop1 = { id: "cop1", name: "C", role: "hunter", connected: true, ready: true, reachedRally: true, usedNoisePing: false, usedDecoyPower: false, arrestAttemptsUsed: 0, lastLocation: { lat: 48.851, lng: 2.351, accuracyM: 3, ts: 1 }, cooldowns: { sonar_ping: 0, jam: 0, fake_clue: 0 } };
    attemptArrest(state, "cop1");
    attemptArrest(state, "cop1");
    expect(() => attemptArrest(state, "cop1")).toThrow(/no arrest attempts/);
  });
});
