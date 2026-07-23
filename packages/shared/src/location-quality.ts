import type { Coordinates } from "./domain.js";
import { haversineMeters } from "./geo-utils.js";

export const LOCATION_MAX_ACCURACY_M = 120;
export const LOCATION_GOOD_ACCURACY_M = 35;
export const LOCATION_WEAK_ACCURACY_M = 55;
export const LOCATION_STALE_MS = 15_000;
export const LOCATION_SNAP_ACCURACY_M = 40;
export const MISSION_PROXIMITY_FIXES_REQUIRED = 2;
export const MAX_PLAUSIBLE_SPEED_MPS = 16;

export type GpsQuality = "good" | "weak" | "poor" | "stale" | "none";

export function isLocationFresh(loc: Coordinates, nowMs: number = Date.now()): boolean {
  return nowMs - loc.ts <= LOCATION_STALE_MS;
}

export function isLocationAccurateEnough(loc: Coordinates, maxM: number = LOCATION_GOOD_ACCURACY_M): boolean {
  return loc.accuracyM <= maxM;
}

export function classifyGpsQuality(loc: Coordinates | null | undefined, nowMs: number = Date.now()): GpsQuality {
  if (!loc) return "none";
  if (!isLocationFresh(loc, nowMs)) return "stale";
  if (loc.accuracyM <= LOCATION_GOOD_ACCURACY_M) return "good";
  if (loc.accuracyM <= LOCATION_WEAK_ACCURACY_M) return "weak";
  if (loc.accuracyM <= LOCATION_MAX_ACCURACY_M) return "poor";
  return "poor";
}

export function gpsQualityLabel(quality: GpsQuality): string {
  return {
    good: "GPS précis",
    weak: "GPS approximatif",
    poor: "GPS faible",
    stale: "GPS expiré",
    none: "GPS indisponible"
  }[quality];
}

export function smoothLocation(prev: Coordinates | null, raw: Coordinates): Coordinates {
  if (!prev) return raw;
  const weight = Math.max(0.15, Math.min(0.6, 25 / raw.accuracyM));
  return {
    lat: prev.lat * (1 - weight) + raw.lat * weight,
    lng: prev.lng * (1 - weight) + raw.lng * weight,
    accuracyM: Math.min(raw.accuracyM, prev.accuracyM * 0.85 + raw.accuracyM * 0.15),
    ts: raw.ts
  };
}

export function rejectImplausibleJump(
  prev: Coordinates | null,
  next: Coordinates,
  maxSpeedMps: number = MAX_PLAUSIBLE_SPEED_MPS
): boolean {
  if (!prev) return false;
  const dtSec = Math.max((next.ts - prev.ts) / 1000, 0.5);
  const meters = haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
  return meters / dtSec > maxSpeedMps && next.accuracyM > LOCATION_GOOD_ACCURACY_M;
}

export function rallyHitRadiusWithAccuracy(baseHitM: number, loc: Coordinates): number {
  return baseHitM + Math.min(20, loc.accuracyM * 0.35);
}
