import { Disruption } from "./disruptions";
import { RouteMode, RouteResult, RouteSegment, RouteStep } from "./routing";
import { haversineMeters, LatLng } from "./toronto";

type ValhallaManeuver = {
  instruction?: string;
  length?: number;
  time?: number;
  begin_shape_index?: number;
  end_shape_index?: number;
  rough?: boolean;
  travel_mode?: string;
};

type ValhallaResponse = {
  trip?: {
    legs?: Array<{
      shape?: string;
      maneuvers?: ValhallaManeuver[];
    }>;
    summary?: {
      length?: number;
      time?: number;
    };
  };
};

export async function routeWithValhalla(
  origin: LatLng,
  destination: LatLng,
  mode: RouteMode,
  disruptions: Disruption[],
  waypoints: LatLng[] = []
): Promise<RouteResult> {
  const payload = {
    locations: [
      { lat: origin.lat, lon: origin.lng, type: "break" },
      ...waypoints.map((point) => ({ lat: point.lat, lon: point.lng, type: "through" })),
      { lat: destination.lat, lon: destination.lng, type: "break" }
    ],
    costing: "pedestrian",
    costing_options: {
      pedestrian: pedestrianOptions(mode)
    },
    directions_options: {
      units: "kilometers"
    }
  };

  const url = new URL("https://valhalla1.openstreetmap.de/route");
  url.searchParams.set("json", JSON.stringify(payload));
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 28_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Pedestrian router failed.");
    const data = (await response.json()) as ValhallaResponse;
    const legs = data.trip?.legs ?? [];
    const path = legs.flatMap((leg, index) => {
      const legPath = leg.shape ? decodeValhallaShape(leg.shape) : [];
      return index > 0 ? legPath.slice(1) : legPath;
    });
    const maneuvers = legs.flatMap((leg) => leg.maneuvers ?? []);
    if (path.length < 2) throw new Error("Pedestrian router did not return a walkable shape.");
    return buildRouteResult(path, maneuvers, data.trip?.summary?.time, mode, disruptions, waypoints.length);
  } finally {
    window.clearTimeout(timeout);
  }
}

function pedestrianOptions(mode: RouteMode) {
  if (mode === "shortest") return { walking_speed: 5.0, use_living_streets: 0.5, use_tracks: 0.4 };
  if (mode === "accessible") return { walking_speed: 4.0, use_hills: 0.1, use_living_streets: 0.7, use_tracks: 0.2 };
  if (mode === "green") return { walking_speed: 4.7, use_living_streets: 0.8, use_tracks: 0.8, use_hills: 0.4 };
  return { walking_speed: 4.7, use_living_streets: 0.65, use_tracks: 0.55, use_hills: 0.35 };
}

function buildRouteResult(
  path: LatLng[],
  maneuvers: ValhallaManeuver[],
  summarySeconds: number | undefined,
  mode: RouteMode,
  disruptions: Disruption[],
  waypointCount: number
): RouteResult {
  const segments: RouteSegment[] = [];
  for (let index = 1; index < path.length; index += 1) {
    segments.push({
      from: path[index - 1],
      to: path[index],
      distance: haversineMeters(path[index - 1], path[index]),
      kind: "footway",
      name: "Pedestrian route"
    });
  }

  const distance = segments.reduce((sum, segment) => sum + segment.distance, 0);
  const straightDistance = haversineMeters(path[0], path[path.length - 1]);
  const seconds = summarySeconds ?? estimateSeconds(distance, mode);
  const steps = buildSteps(maneuvers, path, distance);
  const roughMeters = maneuvers.filter((maneuver) => maneuver.rough).reduce((sum, maneuver) => sum + (maneuver.length ?? 0) * 1000, 0);
  const nearbyWork = disruptions.some((item) => path.some((point) => haversineMeters(point, item.point) < 80));
  const directness = Math.round(Math.min(100, Math.max(0, (straightDistance / Math.max(distance, 1)) * 100)));
  const comfort = Math.round(Math.max(55, Math.min(94, 90 - (roughMeters / Math.max(distance, 1)) * 18 - (nearbyWork ? 4 : 0))));

  return {
    path,
    segments,
    steps,
    distance,
    weightedDistance: distance,
    seconds,
    pedestrianFirstPercent: 100,
    quality: {
      comfort,
      directness,
      stairMeters: null,
      trailMeters: 0,
      sidewalkMeters: distance,
      knownLitMeters: 0,
      coveredMeters: 0,
      roughSurfaceMeters: roughMeters,
      crossingMeters: 0,
      kindMeters: { footway: distance }
    },
    insights: [
      waypointCount
        ? `Uses fast pedestrian routing shaped by ${waypointCount} route preference point${waypointCount === 1 ? "" : "s"}.`
        : "Uses fast pedestrian routing for this Toronto walk.",
      `${directness}% directness compared with straight-line distance.`,
      roughMeters > 40 ? `${Math.round(roughMeters)} m may be rough or unpaved.` : "No rough segments were reported by the pedestrian router.",
      `Step data is summarized from ${maneuvers.length} pedestrian maneuvers.`,
      "Stair coverage is unknown; this route is not verified as step-free."
    ]
  };
}

function buildSteps(maneuvers: ValhallaManeuver[], path: LatLng[], totalDistance: number): RouteStep[] {
  const steps = maneuvers.slice(0, 8).map((maneuver) => ({
    label: cleanInstruction(maneuver.instruction ?? "Continue walking"),
    distance: (maneuver.length ?? 0) * 1000,
    kind: "footway" as const
  }));
  if (steps.length) return steps;
  return [{ label: "Pedestrian route", distance: totalDistance || routeDistance(path), kind: "footway" }];
}

function cleanInstruction(value: string) {
  return value.replace(/\.$/, "").replace(/^Walk\s+/i, "");
}

function routeDistance(path: LatLng[]) {
  return path.slice(1).reduce((sum, point, index) => sum + haversineMeters(path[index], point), 0);
}

function estimateSeconds(distance: number, mode: RouteMode) {
  const metersPerSecond = mode === "accessible" ? 1.05 : 1.28;
  return distance / metersPerSecond;
}

function decodeValhallaShape(encoded: string): LatLng[] {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: LatLng[] = [];

  while (index < encoded.length) {
    const latChange = decodeNext(encoded, () => index++);
    index = latChange.index;
    const lngChange = decodeNext(encoded, () => index++);
    index = lngChange.index;
    lat += latChange.value;
    lng += lngChange.value;
    coordinates.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }

  return coordinates;
}

function decodeNext(encoded: string, advance: () => number) {
  let shift = 0;
  let result = 0;
  let byte = 0;
  let index = 0;

  do {
    index = advance();
    byte = encoded.charCodeAt(index) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);

  return {
    value: result & 1 ? ~(result >> 1) : result >> 1,
    index: index + 1
  };
}
