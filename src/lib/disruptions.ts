import { Bounds, haversineMeters, LatLng } from "./toronto";

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

export async function fetchRoadRestrictions(bounds?: Bounds): Promise<Disruption[]> {
  const endpoints = [
    "https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json",
    "/data/road-restrictions.json"
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) continue;
      const data = await parseRestrictionResponse(response);
      const disruptions = (data.Closure ?? []).map(normalizeRestriction).filter(Boolean) as Disruption[];
      return bounds ? disruptions.filter((item) => inBounds(item.point, bounds)) : disruptions;
    } catch {
      // Try the local fallback next.
    }
  }

  return [];
}

async function parseRestrictionResponse(response: Response): Promise<RoadRestrictionResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as RoadRestrictionResponse;
  } catch {
    return JSON.parse(text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")) as RoadRestrictionResponse;
  }
}

export function nearestDisruptionMeters(route: LatLng[], disruptions: Disruption[]) {
  let nearest = Infinity;
  for (const disruption of disruptions) {
    const candidates = disruption.polyline.length ? disruption.polyline : [disruption.point];
    for (const routePoint of route) {
      for (const disruptionPoint of candidates) {
        nearest = Math.min(nearest, haversineMeters(routePoint, disruptionPoint));
      }
    }
  }
  return nearest;
}

export function countNearbyDisruptions(route: LatLng[], disruptions: Disruption[], thresholdMeters = 90) {
  return disruptions.filter((disruption) => {
    const candidates = disruption.polyline.length ? disruption.polyline : [disruption.point];
    return route.some((routePoint) =>
      candidates.some((disruptionPoint) => haversineMeters(routePoint, disruptionPoint) <= thresholdMeters)
    );
  }).length;
}

function normalizeRestriction(row: RoadRestriction): Disruption | null {
  const lat = Number(row.latitude);
  const lng = Number(row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    id: row.id,
    title: row.name ?? row.road ?? "Road restriction",
    road: row.road ?? "Unknown road",
    type: row.type ?? "restriction",
    impact: row.maxImpact ?? row.currImpact ?? "Unknown",
    source: row.source ?? "City of Toronto",
    start: toNumber(row.startTime),
    end: toNumber(row.endTime),
    point: { lat, lng },
    polyline: parsePolyline(row.geoPolyline),
    url: row.URL
  };
}

function parsePolyline(value?: string): LatLng[] {
  if (!value) return [];
  const matches = value.match(/\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/g) ?? [];
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

function inBounds(point: LatLng, bounds: Bounds) {
  return point.lat >= bounds.south && point.lat <= bounds.north && point.lng >= bounds.west && point.lng <= bounds.east;
}
