import { Bounds, LatLng } from "./toronto";

export type WayKind =
  | "footway"
  | "path"
  | "pedestrian"
  | "steps"
  | "sidewalk-road"
  | "quiet-road"
  | "fallback-road";

export type WalkWay = {
  id: number;
  nodeIds: number[];
  geometry: LatLng[];
  tags: Record<string, string>;
  kind: WayKind;
};

type OverpassWay = {
  type: "way";
  id: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements: OverpassWay[];
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];

export async function fetchPedestrianWays(bounds: Bounds): Promise<WalkWay[]> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `
    [out:json][timeout:24];
    (
      way["highway"~"footway|path|pedestrian|steps|living_street"](${bbox});
      way["highway"~"residential|service|unclassified"]["sidewalk"](${bbox});
      way["highway"~"residential|service|unclassified"]["foot"~"yes|designated|permissive"](${bbox});
      way["route"="foot"](${bbox});
      way["highway"="cycleway"]["foot"~"yes|designated|permissive"](${bbox});
    );
    out body geom;
  `;

  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchOverpass(endpoint, query);
      return data.elements
        .filter((element) => element.type === "way" && element.geometry?.length && element.nodes?.length)
        .map((element) => {
          const tags = element.tags ?? {};
          return {
            id: element.id,
            nodeIds: element.nodes ?? [],
            geometry: element.geometry!.map((point) => ({ lat: point.lat, lng: point.lon })),
            tags,
            kind: classifyWay(tags)
          };
        })
        .filter((way) => !isBlocked(way.tags));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Pedestrian network fetch failed.");
}

async function fetchOverpass(endpoint: string, query: string): Promise<OverpassResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 28_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Pedestrian network fetch failed.");
    return (await response.json()) as OverpassResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

function classifyWay(tags: Record<string, string>): WayKind {
  const highway = tags.highway;
  if (highway === "steps") return "steps";
  if (highway === "pedestrian") return "pedestrian";
  if (highway === "footway") return tags.footway === "sidewalk" ? "sidewalk-road" : "footway";
  if (highway === "path") return "path";
  if (highway === "living_street") return "quiet-road";
  if (tags.sidewalk && tags.sidewalk !== "no") return "sidewalk-road";
  if (tags.foot === "designated") return "footway";
  return "fallback-road";
}

function isBlocked(tags: Record<string, string>) {
  return (
    tags.access === "private" ||
    tags.access === "no" ||
    tags.foot === "no" ||
    tags.highway === "construction" ||
    tags.construction === "yes"
  );
}
