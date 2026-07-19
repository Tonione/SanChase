/** Play-area sizing from urban chase down to cache-cache / hide-and-seek. */

export const PLAY_AREA_MIN_M = 20;
export const PLAY_AREA_MAX_M = 2200;
export const PLAY_AREA_STEP_M = 5;

/** 100 m diameter — hide-and-seek in a park or large garden. */
export const PLAY_AREA_HIDE_SEEK_RADIUS_M = 50;

/** ~50 m diameter — very tight indoor/small yard. */
export const PLAY_AREA_MICRO_RADIUS_M = 25;

const URBAN_RALLY_SPREAD_M = 320;
const URBAN_MISSION_DISTANCES_M = [350, 570, 790] as const;

export function rallySpreadM(radiusM: number): number {
  return Math.min(URBAN_RALLY_SPREAD_M, Math.max(6, radiusM * 0.42));
}

export function missionDistancesM(radiusM: number): number[] {
  const cap = radiusM * 0.78;
  if (radiusM >= 400) {
    return URBAN_MISSION_DISTANCES_M.map((d) => Math.min(d, cap));
  }
  const floor = Math.max(5, radiusM * 0.18);
  return [0.28, 0.48, 0.62].map((f) => Math.max(floor, radiusM * f));
}

export function rallyHitRadiusM(radiusM: number): number {
  return Math.min(40, Math.max(8, radiusM * 0.35));
}

/** Minimum radius required for a specific target size (for assessment). */
export function computeRequiredRadiusM(radiusM: number): number {
  const spread = rallySpreadM(radiusM);
  const furthestMission = Math.max(...missionDistancesM(radiusM));
  if (radiusM >= 400) {
    return Math.ceil(spread + furthestMission + 60);
  }
  return Math.ceil(Math.max(spread, furthestMission) + Math.max(3, radiusM * 0.08));
}

export function computeMinPlayAreaRadiusM(referenceRadiusM = 1320): number {
  return computeRequiredRadiusM(referenceRadiusM);
}

export function isMicroPlayArea(radiusM: number): boolean {
  return radiusM < 120;
}

export function clampPlayAreaRadiusM(radiusM: number): number {
  return Math.min(PLAY_AREA_MAX_M, Math.max(PLAY_AREA_MIN_M, Math.round(radiusM)));
}
