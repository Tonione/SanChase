import { haversineMeters, nearestPointOnSegment, offsetMeters } from "../../../packages/shared/src/geo-utils.js";

const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK_URL = process.env.OVERPASS_FALLBACK_URL ?? "https://overpass.kumi.systems/api/interpreter";
const OSRM_NEAREST_URL = process.env.OSRM_NEAREST_URL ?? "https://router.project-osrm.org/nearest/v1/foot";

const OVERPASS_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "Accept-Encoding": "gzip, deflate",
  "User-Agent": process.env.OVERPASS_USER_AGENT ?? "SanChase/0.1 (street-snapping; +https://github.com/sanchase)"
};

function streetSnapEnabled(): boolean {
  return process.env.STREET_SNAP !== "0";
}

const WALKABLE_HIGHWAYS = new Set([
  "footway",
  "pedestrian",
  "path",
  "steps",
  "cycleway",
  "living_street",
  "residential",
  "unclassified",
  "tertiary",
  "tertiary_link",
  "secondary",
  "secondary_link",
  "primary",
  "primary_link",
  "service"
]);

type OsmNode = { lat: number; lon: number };
type OsmWay = {
  type: "way";
  tags?: Record<string, string>;
  geometry?: OsmNode[];
};

export type StreetSnapResult = {
  lat: number;
  lng: number;
  snapped: boolean;
  source: "overpass" | "osrm" | "none";
};

function isAccessiblePublicWay(tags: Record<string, string> | undefined): boolean {
  if (!tags?.highway) return false;
  const highway = tags.highway;
  if (!WALKABLE_HIGHWAYS.has(highway)) return false;
  if (highway === "construction" || highway === "proposed") return false;
  if (tags.access === "private" || tags.access === "no") return false;
  if (tags.foot === "no" || tags.foot === "private") return false;
  if (tags.indoor === "yes") return false;
  if (highway === "service") {
    const service = tags.service;
    if (service === "parking_aisle" || service === "driveway" || service === "private") return false;
  }
  return true;
}

function wayToRing(way: OsmWay): Array<{ lat: number; lng: number }> | null {
  if (!way.geometry?.length) return null;
  return way.geometry.map((node) => ({ lat: node.lat, lng: node.lon }));
}

function isInsideBuilding(lat: number, lng: number, buildings: OsmWay[]): boolean {
  for (const building of buildings) {
    const ring = wayToRing(building);
    if (ring && pointInBuilding(lat, lng, ring)) return true;
  }
  return false;
}

function pointInBuilding(lat: number, lng: number, ring: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lng;
    const yj = ring[j].lat;
    const xj = ring[j].lng;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function snapToWays(
  lat: number,
  lng: number,
  ways: OsmWay[],
  buildings: OsmWay[],
  maxSnapDistanceM: number
): StreetSnapResult | null {
  let best: StreetSnapResult | null = null;
  let bestDist = Infinity;

  for (const way of ways) {
    if (!isAccessiblePublicWay(way.tags)) continue;
    const ring = wayToRing(way);
    if (!ring || ring.length < 2) continue;

    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const proj = nearestPointOnSegment(lat, lng, a.lat, a.lng, b.lat, b.lng);
      if (proj.distanceM > maxSnapDistanceM || proj.distanceM >= bestDist) continue;
      if (isInsideBuilding(proj.lat, proj.lng, buildings)) continue;
      bestDist = proj.distanceM;
      best = { lat: proj.lat, lng: proj.lng, snapped: true, source: "overpass" };
    }
  }

  return best;
}

async function fetchOverpassData(centerLat: number, centerLng: number, radiusM: number): Promise<{ ways: OsmWay[]; buildings: OsmWay[] }> {
  const query = `
[out:json][timeout:20];
(
  way["highway"](around:${Math.ceil(radiusM)},${centerLat},${centerLng});
  way["building"](around:${Math.ceil(radiusM)},${centerLat},${centerLng});
);
out geom;
`.trim();

  const body = `data=${encodeURIComponent(query)}`;
  const urls = [OVERPASS_URL, OVERPASS_FALLBACK_URL].filter((url, index, all) => all.indexOf(url) === index);
  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: OVERPASS_HEADERS,
        body,
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) {
        lastError = new Error(`Overpass HTTP ${response.status}`);
        if (response.status === 406 && url !== urls[urls.length - 1]) continue;
        throw lastError;
      }

      const payload = (await response.json()) as { elements?: OsmWay[] };
      const elements = payload.elements ?? [];
      return {
        ways: elements.filter((el) => el.type === "way" && el.tags?.highway),
        buildings: elements.filter((el) => el.type === "way" && el.tags?.building)
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (url !== urls[urls.length - 1]) continue;
      throw lastError;
    }
  }

  throw lastError ?? new Error("Overpass request failed");
}

async function osrmNearest(lat: number, lng: number, maxSnapDistanceM: number): Promise<StreetSnapResult | null> {
  const url = `${OSRM_NEAREST_URL}/${lng},${lat}?number=1`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    code?: string;
    waypoints?: Array<{ location: [number, number] }>;
  };
  if (payload.code !== "Ok" || !payload.waypoints?.[0]) return null;

  const [snapLng, snapLat] = payload.waypoints[0].location;
  const distanceM = haversineMeters(lat, lng, snapLat, snapLng);
  if (distanceM > maxSnapDistanceM) return null;
  return { lat: snapLat, lng: snapLng, snapped: true, source: "osrm" };
}

export class StreetSnapContext {
  private ways: OsmWay[] = [];
  private buildings: OsmWay[] = [];
  private loaded = false;

  async loadForArea(centerLat: number, centerLng: number, radiusM: number): Promise<void> {
    if (!streetSnapEnabled()) {
      this.loaded = true;
      return;
    }
    const searchRadiusM = Math.min(Math.ceil(radiusM * 1.15) + 120, 2500);
    const data = await fetchOverpassData(centerLat, centerLng, searchRadiusM);
    this.ways = data.ways;
    this.buildings = data.buildings;
    this.loaded = true;
  }

  snap(lat: number, lng: number, maxSnapDistanceM = 80): StreetSnapResult {
    if (!streetSnapEnabled() || !this.loaded) {
      return { lat, lng, snapped: false, source: "none" };
    }

    const overpass = snapToWays(lat, lng, this.ways, this.buildings, maxSnapDistanceM);
    return overpass ?? { lat, lng, snapped: false, source: "none" };
  }

  async snapWithFallback(
    lat: number,
    lng: number,
    opts?: { maxSnapDistanceM?: number; maxRelocateM?: number }
  ): Promise<StreetSnapResult> {
    const maxSnapDistanceM = opts?.maxSnapDistanceM ?? 80;
    const maxRelocateM = opts?.maxRelocateM ?? 120;

    if (!streetSnapEnabled()) {
      return { lat, lng, snapped: false, source: "none" };
    }

    const direct = this.snap(lat, lng, maxSnapDistanceM);
    if (direct.snapped) return direct;

    for (const dist of [20, 35, 50, 70, 90]) {
      if (dist > maxRelocateM) break;
      for (let i = 0; i < 8; i++) {
        const bearing = (Math.PI * 2 * i) / 8;
        const candidate = offsetMeters({ lat, lng }, dist, bearing);
        const attempt = this.snap(candidate.lat, candidate.lng, maxSnapDistanceM);
        if (attempt.snapped && haversineMeters(lat, lng, attempt.lat, attempt.lng) <= maxRelocateM) {
          return attempt;
        }
      }
    }

    try {
      const osrm = await osrmNearest(lat, lng, maxSnapDistanceM);
      if (osrm && !isInsideBuilding(osrm.lat, osrm.lng, this.buildings)) {
        return osrm;
      }
    } catch {
      // OSRM is best-effort fallback.
    }

    return { lat, lng, snapped: false, source: "none" };
  }
}
