import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nearestPointOnSegment } from "../packages/shared/src/geo-utils.js";

const overpassFixture = {
  elements: [
    {
      type: "way",
      id: 1,
      tags: { highway: "residential" },
      geometry: [
        { lat: 48.856, lon: 2.352 },
        { lat: 48.857, lon: 2.353 }
      ]
    },
    {
      type: "way",
      id: 2,
      tags: { highway: "service", service: "driveway", access: "private" },
      geometry: [
        { lat: 48.8564, lon: 2.3524 },
        { lat: 48.8564, lon: 2.3528 }
      ]
    },
    {
      type: "way",
      id: 3,
      tags: { building: "yes" },
      geometry: [
        { lat: 48.85645, lon: 2.35245 },
        { lat: 48.85655, lon: 2.35245 },
        { lat: 48.85655, lon: 2.35255 },
        { lat: 48.85645, lon: 2.35255 },
        { lat: 48.85645, lon: 2.35245 }
      ]
    }
  ]
};

describe("street snap", () => {
  beforeEach(() => {
    process.env.STREET_SNAP = "1";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.STREET_SNAP = "0";
  });

  it("finds nearest point on a segment", () => {
    const point = nearestPointOnSegment(48.8565, 2.3525, 48.856, 2.352, 48.857, 2.353);
    expect(point.distanceM).toBeLessThan(40);
    expect(point.lat).toBeGreaterThan(48.856);
    expect(point.lat).toBeLessThan(48.857);
  });

  it("snaps to public streets and skips private driveways", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => overpassFixture
      }))
    );

    const { StreetSnapContext } = await import("../services/game-server/src/street-snap.js");
    const ctx = new StreetSnapContext();
    await ctx.loadForArea(48.8565, 2.3525, 500);

    const result = ctx.snap(48.8562, 2.3522, 80);
    expect(result.snapped).toBe(true);
    expect(result.source).toBe("overpass");
    expect(result.lat).toBeGreaterThan(48.8559);
    expect(result.lat).toBeLessThan(48.8571);
  });
});
