import type { Coordinates, PlayArea } from "../../../packages/shared/src/domain.js";
import { LOCATION_SNAP_ACCURACY_M } from "../../../packages/shared/src/location-quality.js";
import { StreetSnapContext } from "./street-snap.js";

const lastSnapAtMs = new Map<string, number>();

export async function maybeSnapPlayerLocation(
  roomKey: string,
  location: Coordinates,
  playArea: PlayArea,
  ctx: StreetSnapContext
): Promise<Coordinates> {
  if (location.accuracyM <= LOCATION_SNAP_ACCURACY_M) return location;

  const now = Date.now();
  const lastSnap = lastSnapAtMs.get(roomKey) ?? 0;
  if (now - lastSnap < 12_000) return location;

  const maxSnap = Math.min(50, Math.max(20, location.accuracyM * 0.75));
  const snapped = await ctx.snapWithFallback(location.lat, location.lng, {
    maxSnapDistanceM: maxSnap,
    maxRelocateM: maxSnap
  });
  lastSnapAtMs.set(roomKey, now);
  if (!snapped.snapped) return location;

  return {
    ...location,
    lat: snapped.lat,
    lng: snapped.lng,
    accuracyM: Math.min(location.accuracyM, 28),
    ts: now
  };
}

export function clearPlayerSnapCache(roomKey?: string) {
  if (!roomKey) {
    lastSnapAtMs.clear();
    return;
  }
  for (const key of lastSnapAtMs.keys()) {
    if (key.startsWith(`${roomKey}:`)) lastSnapAtMs.delete(key);
  }
}
