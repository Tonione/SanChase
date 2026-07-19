import { z } from "zod";
import { RoomSettings } from "./domain.js";

const RALLY_RADIUS_M = 320;
const FURTHEST_MISSION_OFFSET_M = 350 + 2 * 220;
const MISSION_MARGIN_M = 60;
const WALK_KMH = 5;
const JOG_KMH = 11;

export type PlayAreaVerdict = "too_small" | "tight" | "balanced" | "large" | "too_large";

export type PlayAreaAssessment = {
  radiusM: number;
  minRadiusM: number;
  recommendedRadiusM: number;
  balancedMinM: number;
  balancedMaxM: number;
  diameterM: number;
  areaKm2: number;
  evasionMarginM: number;
  walkCrossingMin: number;
  jogCrossingMin: number;
  copCount: number;
  areaPerCopKm2: number;
  verdict: PlayAreaVerdict;
  verdictLabelFr: string;
  hintFr: string;
};

export const PlayAreaAssessmentSchema = z.object({
  radiusM: z.number().positive(),
  minRadiusM: z.number().positive(),
  recommendedRadiusM: z.number().positive(),
  balancedMinM: z.number().positive(),
  balancedMaxM: z.number().positive(),
  diameterM: z.number().positive(),
  areaKm2: z.number().positive(),
  evasionMarginM: z.number(),
  walkCrossingMin: z.number().int().nonnegative(),
  jogCrossingMin: z.number().int().nonnegative(),
  copCount: z.number().int().positive(),
  areaPerCopKm2: z.number().positive(),
  verdict: z.enum(["too_small", "tight", "balanced", "large", "too_large"]),
  verdictLabelFr: z.string(),
  hintFr: z.string()
});

/** Smallest radius that still fits rally spread + furthest mission from center. */
export function computeMinPlayAreaRadiusM(): number {
  return RALLY_RADIUS_M + FURTHEST_MISSION_OFFSET_M + MISSION_MARGIN_M;
}

/**
 * Target radius from cop pressure: more cops → less evasion margin needed.
 * tuned for ~60 min urban foot chase.
 */
export function computeRecommendedPlayAreaRadiusM(
  playerCount: number,
  preset: RoomSettings["boundaryPreset"] = "district_medium"
): number {
  const min = computeMinPlayAreaRadiusM();
  const copCount = Math.max(playerCount - 1, 1);
  const presetScale = { district_small: 0.9, district_medium: 1, district_large: 1.12 }[preset];
  const evasionFactor = Math.min(1.32, 1.06 + Math.max(0, 7 - copCount) * 0.035);
  return Math.round(min * evasionFactor * presetScale);
}

export function assessPlayArea(input: {
  radiusM: number;
  playerCount: number;
  durationSec?: number;
  preset?: RoomSettings["boundaryPreset"];
}): PlayAreaAssessment {
  const { radiusM, playerCount, durationSec = 3600, preset = "district_medium" } = input;
  const minRadiusM = computeMinPlayAreaRadiusM();
  const recommendedRadiusM = computeRecommendedPlayAreaRadiusM(playerCount, preset);
  const balancedMinM = Math.round(minRadiusM * 1.1);
  const balancedMaxM = Math.round(minRadiusM * 1.28);
  const diameterM = radiusM * 2;
  const areaKm2 = Math.PI * (radiusM / 1000) ** 2;
  const evasionMarginM = radiusM - minRadiusM;
  const walkCrossingMin = Math.round((diameterM / 1000 / WALK_KMH) * 60);
  const jogCrossingMin = Math.round((diameterM / 1000 / JOG_KMH) * 60);
  const copCount = Math.max(playerCount - 1, 1);
  const areaPerCopKm2 = areaKm2 / copCount;

  const ratio = radiusM / minRadiusM;
  let verdict: PlayAreaVerdict;
  if (radiusM < minRadiusM * 1.02) verdict = "too_small";
  else if (ratio < 1.12 || walkCrossingMin < 12) verdict = "tight";
  else if (ratio <= 1.28 && walkCrossingMin <= 32) verdict = "balanced";
  else if (ratio <= 1.45 && walkCrossingMin <= 42) verdict = "large";
  else verdict = "too_large";

  // Long games tolerate slightly larger zones.
  if (verdict === "large" && durationSec >= 4500 && ratio <= 1.38) verdict = "balanced";
  if (verdict === "balanced" && walkCrossingMin > 36) verdict = "large";

  const labels: Record<PlayAreaVerdict, string> = {
    too_small: "Trop petite",
    tight: "Compacte — avantage flics",
    balanced: "Équilibrée",
    large: "Grande — risque de traîne",
    too_large: "Trop grande"
  };

  const hints: Record<PlayAreaVerdict, string> = {
    too_small: "Les missions risquent de sortir de la zone. Réduisez l'écart des missions ou agrandissez.",
    tight: "Peu de marge pour se cacher : bon pour les flics, dur pour le fugitif.",
    balanced: "Bon compromis entre fuite possible et pression policière.",
    large: "Traverser la zone prend du temps — la partie peut traîner. Envisagez district_small.",
    too_large: "Zone difficile à couvrir à pied en 1 h — les joueurs s'ennuieront. Réduisez la taille."
  };

  let hintFr = hints[verdict];
  if (Math.abs(radiusM - recommendedRadiusM) > 120) {
    hintFr += ` Cible suggérée : ~${(recommendedRadiusM / 1000).toFixed(2)} km (${copCount} flic${copCount > 1 ? "s" : ""}).`;
  }

  return {
    radiusM,
    minRadiusM,
    recommendedRadiusM,
    balancedMinM,
    balancedMaxM,
    diameterM,
    areaKm2: Math.round(areaKm2 * 100) / 100,
    evasionMarginM: Math.round(evasionMarginM),
    walkCrossingMin,
    jogCrossingMin,
    copCount,
    areaPerCopKm2: Math.round(areaPerCopKm2 * 100) / 100,
    verdict,
    verdictLabelFr: labels[verdict],
    hintFr
  };
}
