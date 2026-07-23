import { describe, expect, it } from "vitest";
import {
  classifyGpsQuality,
  isLocationFresh,
  rejectImplausibleJump,
  smoothLocation,
  LOCATION_STALE_MS
} from "../packages/shared/src/location-quality.js";

describe("location quality", () => {
  it("classifies GPS quality from accuracy and age", () => {
    const now = 1_000_000;
    expect(classifyGpsQuality({ lat: 1, lng: 1, accuracyM: 10, ts: now - 1000 }, now)).toBe("good");
    expect(classifyGpsQuality({ lat: 1, lng: 1, accuracyM: 45, ts: now - 1000 }, now)).toBe("weak");
    expect(classifyGpsQuality({ lat: 1, lng: 1, accuracyM: 90, ts: now - 1000 }, now)).toBe("poor");
    expect(classifyGpsQuality({ lat: 1, lng: 1, accuracyM: 10, ts: now - LOCATION_STALE_MS - 1 }, now)).toBe("stale");
  });

  it("smooths noisy readings toward previous fix", () => {
    const prev = { lat: 48.8566, lng: 2.3522, accuracyM: 12, ts: 1000 };
    const raw = { lat: 48.857, lng: 2.353, accuracyM: 40, ts: 2000 };
    const smoothed = smoothLocation(prev, raw);
    expect(smoothed.lat).toBeGreaterThan(prev.lat);
    expect(smoothed.lat).toBeLessThan(raw.lat);
    expect(smoothed.accuracyM).toBeLessThanOrEqual(raw.accuracyM);
  });

  it("rejects implausible jumps when accuracy is poor", () => {
    const prev = { lat: 48.8566, lng: 2.3522, accuracyM: 10, ts: 1000 };
    const jump = { lat: 48.8666, lng: 2.3522, accuracyM: 60, ts: 2000 };
    expect(rejectImplausibleJump(prev, jump)).toBe(true);
    expect(isLocationFresh(jump, 2000)).toBe(true);
  });
});
