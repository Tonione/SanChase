import { z } from "zod";
import { RoomSettings } from "./domain.js";
import {
  PLAY_AREA_HIDE_SEEK_RADIUS_M,
  PLAY_AREA_MICRO_RADIUS_M,
  clampPlayAreaRadiusM,
  computeMinPlayAreaRadiusM,
  computeRequiredRadiusM,
  isMicroPlayArea,
  missionDistancesM,
  rallySpreadM
} from "./play-area-layout.js";

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
  isMicro: boolean;
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
  hintFr: z.string(),
  isMicro: z.boolean()
});

const WALK_KMH = 5;
const JOG_KMH = 11;

/**
 * Target radius from cop pressure — urban scale only; micro maps use explicit presets.
 */
export function computeRecommendedPlayAreaRadiusM(
  playerCount: number,
  preset: RoomSettings["boundaryPreset"] = "district_medium"
): number {
  const min = computeMinPlayAreaRadiusM();
  const copCount = Math.max(playerCount - 1, 1);
  const presetScale = { district_small: 0.9, district_medium: 1, district_large: 1.12 }[preset];
  const evasionFactor = Math.min(1.32, 1.06 + Math.max(0, 7 - copCount) * 0.035);
  return clampPlayAreaRadiusM(min * evasionFactor * presetScale);
}

export function assessPlayArea(input: {
  radiusM: number;
  playerCount: number;
  durationSec?: number;
  preset?: RoomSettings["boundaryPreset"];
}): PlayAreaAssessment {
  const { radiusM, playerCount, durationSec = 3600, preset = "district_medium" } = input;
  const requiredM = computeRequiredRadiusM(radiusM);
  const minRadiusM = requiredM;
  const recommendedRadiusM = computeRecommendedPlayAreaRadiusM(playerCount, preset);
  const micro = isMicroPlayArea(radiusM);
  const balancedMinM = micro
    ? clampPlayAreaRadiusM(Math.max(PLAY_AREA_MICRO_RADIUS_M, requiredM))
    : Math.round(computeMinPlayAreaRadiusM() * 1.1);
  const balancedMaxM = micro
    ? clampPlayAreaRadiusM(PLAY_AREA_HIDE_SEEK_RADIUS_M * 1.4)
    : Math.round(computeMinPlayAreaRadiusM() * 1.28);
  const diameterM = radiusM * 2;
  const areaKm2 = Math.PI * (radiusM / 1000) ** 2;
  const evasionMarginM = radiusM - requiredM;
  const walkCrossingMin = Math.max(1, Math.round((diameterM / 1000 / WALK_KMH) * 60));
  const jogCrossingMin = Math.max(1, Math.round((diameterM / 1000 / JOG_KMH) * 60));
  const copCount = Math.max(playerCount - 1, 1);
  const areaPerCopKm2 = areaKm2 / copCount;

  let verdict: PlayAreaVerdict;
  if (radiusM < requiredM * 0.98) {
    verdict = "too_small";
  } else if (micro) {
    if (radiusM <= PLAY_AREA_HIDE_SEEK_RADIUS_M) verdict = "balanced";
    else verdict = "tight";
  } else {
    const urbanMin = computeMinPlayAreaRadiusM();
    const ratio = radiusM / urbanMin;
    if (ratio < 1.12 || walkCrossingMin < 12) verdict = "tight";
    else if (ratio <= 1.28 && walkCrossingMin <= 32) verdict = "balanced";
    else if (ratio <= 1.45 && walkCrossingMin <= 42) verdict = "large";
    else verdict = "too_large";
    if (verdict === "large" && durationSec >= 4500 && ratio <= 1.38) verdict = "balanced";
    if (verdict === "balanced" && walkCrossingMin > 36) verdict = "large";
  }

  const labels: Record<PlayAreaVerdict, string> = {
    too_small: "Trop petite",
    tight: micro ? "Cache-cache serré" : "Compacte — avantage flics",
    balanced: micro ? "Cache-cache" : "Équilibrée",
    large: "Grande — risque de traîne",
    too_large: "Trop grande"
  };

  const hints: Record<PlayAreaVerdict, string> = {
    too_small: micro
      ? "Zone trop petite pour les missions — augmentez le rayon ou réduisez les joueurs."
      : "Les missions risquent de sortir de la zone. Réduisez l'écart des missions ou agrandissez.",
    tight: micro
      ? "Très petit terrain — idéal cache-cache rapide, fugitif sous pression."
      : "Peu de marge pour se cacher : bon pour les flics, dur pour le fugitif.",
    balanced: micro
      ? "Taille cache-cache (~50–100 m de diamètre) — parties courtes et intenses."
      : "Bon compromis entre fuite possible et pression policière.",
    large: "Traverser la zone prend du temps — la partie peut traîner.",
    too_large: "Zone difficile à couvrir — les joueurs s'ennuieront. Réduisez la taille."
  };

  let hintFr = hints[verdict];
  if (!micro && Math.abs(radiusM - recommendedRadiusM) > 120) {
    hintFr += ` Cible suggérée : ~${(recommendedRadiusM / 1000).toFixed(2)} km (${copCount} flic${copCount > 1 ? "s" : ""}).`;
  }

  return {
    radiusM,
    minRadiusM,
    recommendedRadiusM,
    balancedMinM,
    balancedMaxM,
    diameterM,
    areaKm2: Math.round(areaKm2 * 10000) / 10000,
    evasionMarginM: Math.round(evasionMarginM),
    walkCrossingMin,
    jogCrossingMin,
    copCount,
    areaPerCopKm2: Math.round(areaPerCopKm2 * 10000) / 10000,
    verdict,
    verdictLabelFr: labels[verdict],
    hintFr,
    isMicro: micro
  };
}
