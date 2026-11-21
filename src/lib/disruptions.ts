import { inToronto, type LatLng } from "./toronto";

export type Disruption = {
  id: string;
  title: string;
  road: string;
  type: string;
  impact: string;
  source: string;
  start?: number;
  end?: number;
  point: LatLng;
  polyline: LatLng[];
  url?: string;
};

type RoadRestriction = {
  id: string;
  name?: string;
  road?: string;
  type?: string;
  maxImpact?: string;
  currImpact?: string;
  source?: string;
  startTime?: string;
  endTime?: string;
  latitude?: string;
  longitude?: string;
  geoPolyline?: string;
  URL?: string;
};

type RoadRestrictionResponse = {
  Closure?: RoadRestriction[];
};

export type DisruptionFeed = {
  items: Disruption[];
  source: "live" | "snapshot" | "unavailable" | "loading";
  updatedAt?: string;
};

export async function fetchRoadRestrictionsWithStatus(signal?: AbortSignal): Promise<DisruptionFeed> {
  const base = import.meta.env.BASE_URL;
  const endpoints = [
    "https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json",
    `${base}data/road-restrictions.json`
  ];

  for (const endpoint of endpoints) {
    try {
      const timeout = AbortSignal.timeout(4000);
      const response = await fetch(endpoint, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) continue;
      const data = await parseRestrictionResponse(response);
      if (!Array.isArray(data.Closure)) throw new Error("Invalid road restriction feed.");
      const source = endpoint.startsWith("https:") ? "live" : "snapshot";
      let updatedAt: string | undefined;
      if (source === "snapshot") {
        try {
          const metadata = await fetch(`${base}data/source-status.json`, { signal: AbortSignal.timeout(1500) });
          if (metadata.ok) {
            const status = await metadata.json() as { updatedAt?: string };
            if (status.updatedAt && Number.isFinite(Date.parse(status.updatedAt))) updatedAt = status.updatedAt;
          }
        } catch { /* Keep the snapshot visibly marked even if its date is unavailable. */ }
      }
      return { items: activeRoadRestrictions(data.Closure), source, updatedAt };
    } catch {
      if (signal?.aborted) break;
    }
  }

  return { items: [], source: "unavailable" };
}

async function parseRestrictionResponse(response: Response): Promise<RoadRestrictionResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as RoadRestrictionResponse;
  } catch {
    return JSON.parse(text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")) as RoadRestrictionResponse;
  }
}

export function activeRoadRestrictions(rows: RoadRestriction[], now = Date.now()): Disruption[] {
  return rows
    .filter((row) => row.currImpact?.trim().toLowerCase() !== "none")
    .map(normalizeRestriction)
    .filter((item): item is Disruption => item !== null && (item.start ?? -Infinity) <= now && (item.end ?? Infinity) >= now);
}

function normalizeRestriction(row: RoadRestriction): Disruption | null {
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!row.id || !inToronto({ lat, lng })) return null;

  return {
    id: row.id,
    title: row.name ?? row.road ?? "Road restriction",
    road: row.road ?? "Unknown road",
    type: row.type ?? "restriction",
    impact: row.currImpact ?? row.maxImpact ?? "Unknown",
    source: row.source ?? "City of Toronto",
    start: toNumber(row.startTime),
    end: toNumber(row.endTime),
    point: { lat, lng },
    polyline: parsePolyline(row.geoPolyline),
    url: row.URL?.startsWith("https://www.toronto.ca/") ? row.URL : undefined
  };
}

function parsePolyline(value?: string): LatLng[] {
  if (!value) return [];
  const matches = value.match(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g) ?? [];
  return matches
    .map((pair) => {
      const [lng, lat] = pair.replace("[", "").replace("]", "").split(",").map(Number);
      return { lat, lng };
    })
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function toNumber(value?: string) {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
