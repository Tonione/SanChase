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
});
