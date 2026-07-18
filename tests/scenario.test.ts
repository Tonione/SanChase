import { describe, expect, it } from "vitest";
import { RoomManager } from "../services/game-server/src/room-manager.js";

describe("scenario: fugitive mission win", () => {
  it("fugitive wins after completing 3 missions", () => {
    const manager = new RoomManager();
    manager.createRoom("birthd", "org1", "Organizer", { minPlayersToStart: 2, fugitiveSelection: "manual" });
    manager.join("birthd", "hun1", "Hunter");
    manager.selectFugitive("birthd", "org1", "hun1");

    manager.updateLocation("birthd", "org1", { lat: 48.85, lng: 2.35, accuracyM: 10, ts: 1000 });
    manager.updateLocation("birthd", "hun1", { lat: 48.8505, lng: 2.351, accuracyM: 10, ts: 1000 });

    manager.setReady("birthd", "org1", true);
    manager.setReady("birthd", "hun1", true);
    manager.startGame("birthd", "org1");
    manager.startChase("birthd", "org1");

    const room = manager.get("birthd");
    if (!room) throw new Error("room missing");

    let ts = 200000;
    for (const m of room.state.missions) {
      manager.updateLocation("birthd", "hun1", { ...m.point, accuracyM: 5, ts });
      manager.startMissionHold("birthd", "hun1", m.id);
      room.state.tick += 30;
      manager.completeMissionHold("birthd", "hun1", m.id);
      ts += 120000;
    }

    expect(room.state.winner).toBe("fugitive");
    expect(room.state.phase).toBe("finished");
  });

  it("cops win on successful arrest and get debrief point", () => {
    const manager = new RoomManager();
    manager.createRoom("arrst1", "org1", "Organizer", { minPlayersToStart: 2, fugitiveSelection: "manual" });
    manager.join("arrst1", "cop11", "Cop");
    manager.selectFugitive("arrst1", "org1", "org1");

    manager.updateLocation("arrst1", "org1", { lat: 48.85, lng: 2.35, accuracyM: 2, ts: 1000 });
    manager.updateLocation("arrst1", "cop11", { lat: 48.85, lng: 2.35, accuracyM: 2, ts: 1000 });

    manager.setReady("arrst1", "org1", true);
    manager.setReady("arrst1", "cop11", true);
    manager.startGame("arrst1", "org1");
    manager.startChase("arrst1", "org1");
    const out = manager.attemptArrest("arrst1", "cop11");

    expect(out.result.success).toBe(true);
    expect(out.room.state.phase).toBe("finished");
    expect(out.room.state.winner).toBe("cops");
    expect(out.room.state.debriefPoint).not.toBeNull();
  });
});
