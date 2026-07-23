import type { Coordinates, GameState, Mission } from "../../../packages/shared/src/domain.js";
import { clampToPlayArea } from "../../../packages/shared/src/rules.js";
import { StreetSnapContext } from "./street-snap.js";

async function snapCoordinate(
  ctx: StreetSnapContext,
  point: Coordinates,
  playArea: GameState["playArea"],
  maxRelocateM: number
): Promise<Coordinates> {
  const snapped = await ctx.snapWithFallback(point.lat, point.lng, { maxRelocateM });
  const next = { ...point, lat: snapped.lat, lng: snapped.lng, ts: Date.now() };
  return playArea ? clampToPlayArea(playArea, next) : next;
}

export async function snapRallyPointsInState(state: GameState): Promise<void> {
  if (!state.playArea?.center || Object.keys(state.rallyPoints).length === 0) return;

  const ctx = new StreetSnapContext();
  const maxRelocateM = Math.min(120, Math.max(40, state.playArea.radiusM * 0.25));
  await ctx.loadForArea(state.playArea.center.lat, state.playArea.center.lng, state.playArea.radiusM);

  for (const [playerId, point] of Object.entries(state.rallyPoints)) {
    state.rallyPoints[playerId] = await snapCoordinate(ctx, point, state.playArea, maxRelocateM);
  }
}

export async function snapMissionsInState(state: GameState): Promise<void> {
  if (!state.playArea?.center || state.missions.length === 0) return;

  const ctx = new StreetSnapContext();
  const maxRelocateM = Math.min(150, Math.max(50, state.playArea.radiusM * 0.3));
  await ctx.loadForArea(state.playArea.center.lat, state.playArea.center.lng, state.playArea.radiusM);

  state.missions = await Promise.all(
    state.missions.map(async (mission: Mission) => ({
      ...mission,
      point: await snapCoordinate(ctx, mission.point, state.playArea, maxRelocateM)
    }))
  );
}
