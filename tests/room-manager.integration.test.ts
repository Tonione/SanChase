import { describe, expect, it } from "vitest";
import { RoomManager } from "../services/game-server/src/room-manager.js";

describe("room manager integration", () => {
  it("supports manual fugitive selection", () => {
    const manager = new RoomManager();
    manager.createRoom("r1xx", "org1", "Organizer", { fugitiveSelection: "manual", minPlayersToStart: 2 });
    manager.join("r1xx", "hun1", "Hunter");
    manager.selectFugitive("r1xx", "org1", "hun1");
    expect(manager.get("r1xx")?.state.fugitiveId).toBe("hun1");
  });

  it("blocks launch when organizer location missing", () => {
    const manager = new RoomManager();
    manager.createRoom("r2xx", "org1", "Organizer", { minPlayersToStart: 2 });
    manager.join("r2xx", "hun1", "Hunter");
    manager.setReady("r2xx", "org1", true);
    manager.setReady("r2xx", "hun1", true);
    expect(() => manager.startGame("r2xx", "org1")).toThrow(/location required/);
  });

  it("reconnects an existing player without resetting state", async () => {
    const manager = new RoomManager();
    const { reconnectToken } = manager.createRoom("r3xx", "org1", "Organizer", { minPlayersToStart: 2 });
    manager.join("r3xx", "hun1", "Hunter");
    manager.setReady("r3xx", "org1", true);
    manager.setReady("r3xx", "hun1", true);
    await manager.updateLocation("r3xx", "org1", { lat: 48.85, lng: 2.35, accuracyM: 5, ts: Date.now() });
    manager.startGame("r3xx", "org1");
    const before = manager.get("r3xx")!.state;
    expect(before.phase).toBe("setup");
    expect(before.players.org1.ready).toBe(true);

    manager.disconnect("r3xx", "org1");
    expect(manager.get("r3xx")!.state.players.org1.connected).toBe(false);

    const { reconnectToken: again } = manager.join("r3xx", "org1", "Organizer", reconnectToken);
    expect(again).toBe(reconnectToken);
    const after = manager.get("r3xx")!.state;
    expect(after.phase).toBe("setup");
    expect(after.players.org1.connected).toBe(true);
    expect(after.players.org1.ready).toBe(true);
  });

  it("resets room to lobby for dev retests", async () => {
    const manager = new RoomManager();
    manager.createRoom("r4xx", "org1", "Organizer", { minPlayersToStart: 2 });
    manager.join("r4xx", "hun1", "Hunter");
    manager.setReady("r4xx", "org1", true);
    manager.setReady("r4xx", "hun1", true);
    await manager.updateLocation("r4xx", "org1", { lat: 48.85, lng: 2.35, accuracyM: 5, ts: Date.now() });
    manager.startGame("r4xx", "org1");
    manager.devResetRoom("r4xx", "org1");
    const state = manager.get("r4xx")!.state;
    expect(state.phase).toBe("lobby");
    expect(state.fugitiveId).toBeNull();
    expect(state.playArea).toBeNull();
    expect(state.players.org1.ready).toBe(false);
    expect(state.players.org1.lastLocation?.lat).toBe(48.85);
  });

  it("resets an in-progress game back to setup", async () => {
    const manager = new RoomManager();
    manager.createRoom("r5xx", "org1", "Organizer", { minPlayersToStart: 2 });
    manager.join("r5xx", "hun1", "Hunter");
    manager.setReady("r5xx", "org1", true);
    manager.setReady("r5xx", "hun1", true);
    await manager.updateLocation("r5xx", "org1", { lat: 48.85, lng: 2.35, accuracyM: 5, ts: Date.now() });
    manager.startGame("r5xx", "org1");
    await manager.confirmSetup("r5xx", "org1");
    await manager.startChase("r5xx", "org1", true);
    expect(manager.get("r5xx")!.state.phase).toBe("active");
    expect(manager.get("r5xx")!.state.missions.length).toBeGreaterThan(0);

    manager.organizerResetGame("r5xx", "org1");
    const state = manager.get("r5xx")!.state;
    expect(state.phase).toBe("setup");
    expect(state.missions).toEqual([]);
    expect(state.fugitiveId).toBeTruthy();
    expect(state.players.hun1.reachedRally).toBe(false);
    expect(state.playArea?.center.lat).toBe(48.85);
  });

  it("dissolves the room when organizer quits", async () => {
    const manager = new RoomManager();
    manager.createRoom("r6xx", "org1", "Organizer", { minPlayersToStart: 2 });
    manager.join("r6xx", "hun1", "Hunter");
    manager.setReady("r6xx", "org1", true);
    manager.setReady("r6xx", "hun1", true);
    await manager.updateLocation("r6xx", "org1", { lat: 48.85, lng: 2.35, accuracyM: 5, ts: Date.now() });
    manager.startGame("r6xx", "org1");
    manager.organizerQuitGame("r6xx", "org1");
    expect(manager.get("r6xx")).toBeUndefined();
  });
});
