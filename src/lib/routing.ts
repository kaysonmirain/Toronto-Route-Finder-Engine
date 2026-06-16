import { Disruption } from "./disruptions";
import { haversineMeters, LatLng } from "./toronto";
import { WalkWay, WayKind } from "./osm";

export type RouteMode = "best" | "shortest" | "accessible" | "green";

export type RouteSegment = {
  from: LatLng;
  to: LatLng;
  distance: number;
  kind: WayKind | "connector";
  name?: string;
  tags?: Record<string, string>;
};

export type RouteStep = {
  label: string;
  distance: number;
  kind: WayKind | "connector";
};

export type RouteQuality = {
  comfort: number;
  directness: number;
  stairMeters: number;
  trailMeters: number;
  sidewalkMeters: number;
  knownLitMeters: number;
  coveredMeters: number;
  roughSurfaceMeters: number;
  crossingMeters: number;
  kindMeters: Partial<Record<WayKind | "connector", number>>;
};

export type RouteResult = {
  path: LatLng[];
  segments: RouteSegment[];
  steps: RouteStep[];
  distance: number;
  weightedDistance: number;
  seconds: number;
  pedestrianFirstPercent: number;
  quality: RouteQuality;
  insights: string[];
};

type NodeRecord = {
  id: string;
  point: LatLng;
  edges: EdgeRecord[];
};

type EdgeRecord = {
  to: string;
  distance: number;
  weight: number;
  kind: WayKind | "connector";
  name?: string;
  tags?: Record<string, string>;
};

export function routePedestrianNetwork(
  ways: WalkWay[],
  origin: LatLng,
  destination: LatLng,
  mode: RouteMode,
  disruptions: Disruption[]
): RouteResult {
  const graph = buildGraph(ways, mode, disruptions);
  if (graph.nodes.size < 2) throw new Error("No walkable network found in this part of Toronto.");

  const originNode = connectVirtualNode(graph, "origin", origin, mode);
  const destinationNode = connectVirtualNode(graph, "destination", destination, mode);
  const nodeIds = astar(graph, originNode, destinationNode);
  if (!nodeIds.length) throw new Error("No connected pedestrian route was found. Try a closer pair of places.");

  const segments = segmentsFromPath(graph, nodeIds);
  const distance = segments.reduce((sum, segment) => sum + segment.distance, 0);
  const straightDistance = haversineMeters(origin, destination);
  const weightedDistance = nodeIds.slice(1).reduce((sum, nodeId, index) => {
    const from = graph.nodes.get(nodeIds[index])!;
    const edge = from.edges.find((candidate) => candidate.to === nodeId);
    return sum + (edge?.weight ?? 0);
  }, 0);
  const pedestrianFirst = segments
    .filter((segment) => ["footway", "path", "pedestrian", "steps", "sidewalk-road", "connector"].includes(segment.kind))
    .reduce((sum, segment) => sum + segment.distance, 0);
  const quality = buildQuality(segments, distance, straightDistance);

  return {
    path: nodeIds.map((id) => graph.nodes.get(id)!.point),
    segments,
    steps: buildSteps(segments),
    distance,
    weightedDistance,
    seconds: estimateSeconds(segments, mode),
    pedestrianFirstPercent: distance ? (pedestrianFirst / distance) * 100 : 0,
    quality,
    insights: buildInsights(segments, distance, mode, quality)
  };
}

function buildGraph(ways: WalkWay[], mode: RouteMode, disruptions: Disruption[]) {
  const nodes = new Map<string, NodeRecord>();

  for (const way of ways) {
    const oneWay = way.tags.oneway === "yes" && way.tags.onewayFoot !== "no";
    for (let index = 1; index < way.geometry.length; index += 1) {
      const fromPoint = way.geometry[index - 1];
      const toPoint = way.geometry[index];
      const fromId = String(way.nodeIds[index - 1] ?? keyForPoint(fromPoint));
      const toId = String(way.nodeIds[index] ?? keyForPoint(toPoint));
      const distance = haversineMeters(fromPoint, toPoint);
      if (distance <= 0 || distance > 1500) continue;

      ensureNode(nodes, fromId, fromPoint);
      ensureNode(nodes, toId, toPoint);
      const weight = distance * kindMultiplier(way.kind, way.tags, mode) * disruptionMultiplier(fromPoint, toPoint, disruptions);
      const name = way.tags.name ?? way.tags["addr:street"];
      nodes.get(fromId)!.edges.push({ to: toId, distance, weight, kind: way.kind, name, tags: way.tags });
      if (!oneWay) nodes.get(toId)!.edges.push({ to: fromId, distance, weight, kind: way.kind, name, tags: way.tags });
    }
  }

  return { nodes };
}

function connectVirtualNode(graph: { nodes: Map<string, NodeRecord> }, id: string, point: LatLng, mode: RouteMode) {
  const nearest = [...graph.nodes.values()]
    .map((node) => ({ node, distance: haversineMeters(point, node.point) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  graph.nodes.set(id, { id, point, edges: [] });
  for (const { node, distance } of nearest) {
    const weight = distance * (mode === "shortest" ? 1 : 1.15);
    graph.nodes.get(id)!.edges.push({ to: node.id, distance, weight, kind: "connector" });
    node.edges.push({ to: id, distance, weight, kind: "connector" });
  }
  return id;
}

function astar(graph: { nodes: Map<string, NodeRecord> }, start: string, goal: string) {
  const open = new Set([start]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[start, 0]]);
  const fScore = new Map<string, number>([[start, heuristic(graph, start, goal)]]);

  while (open.size) {
    const current = [...open].sort((a, b) => (fScore.get(a) ?? Infinity) - (fScore.get(b) ?? Infinity))[0];
    if (current === goal) return reconstruct(cameFrom, current);

    open.delete(current);
    const currentNode = graph.nodes.get(current);
    if (!currentNode) continue;

    for (const edge of currentNode.edges) {
      const tentative = (gScore.get(current) ?? Infinity) + edge.weight;
      if (tentative < (gScore.get(edge.to) ?? Infinity)) {
        cameFrom.set(edge.to, current);
        gScore.set(edge.to, tentative);
        fScore.set(edge.to, tentative + heuristic(graph, edge.to, goal));
        open.add(edge.to);
      }
    }
  }

  return [];
}

function reconstruct(cameFrom: Map<string, string>, current: string) {
  const route = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current)!;
    route.unshift(current);
  }
  return route;
}

function segmentsFromPath(graph: { nodes: Map<string, NodeRecord> }, nodeIds: string[]): RouteSegment[] {
  const segments: RouteSegment[] = [];
  for (let index = 1; index < nodeIds.length; index += 1) {
    const from = graph.nodes.get(nodeIds[index - 1])!;
    const to = graph.nodes.get(nodeIds[index])!;
    const edge = from.edges.find((candidate) => candidate.to === to.id);
    if (!edge) continue;
    segments.push({
      from: from.point,
      to: to.point,
      distance: edge.distance,
      kind: edge.kind,
      name: edge.name,
      tags: edge.tags
    });
  }
  return segments;
}

function kindMultiplier(kind: WayKind, tags: Record<string, string>, mode: RouteMode) {
  if (mode === "shortest") return kind === "steps" ? 1.08 : 1;
  if (mode === "accessible" && kind === "steps") return 5.5;

  const base: Record<WayKind, number> = {
    footway: 0.74,
    path: mode === "green" ? 0.66 : 0.78,
    pedestrian: 0.72,
    steps: 1.45,
    "sidewalk-road": 0.98,
    "quiet-road": 1.08,
    "fallback-road": 1.8
  };

  let multiplier = base[kind];
  if (tags.surface && /unpaved|gravel|dirt|ground/.test(tags.surface) && mode === "accessible") multiplier *= 1.55;
  if (tags.lit === "yes") multiplier *= 0.96;
  if (tags.covered === "yes" || tags.tunnel === "building_passage") multiplier *= 0.96;
  return multiplier;
}

function disruptionMultiplier(from: LatLng, to: LatLng, disruptions: Disruption[]) {
  if (!disruptions.length) return 1;
  const segmentMid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  const near = disruptions.some((disruption) => {
    const candidates = disruption.polyline.length ? disruption.polyline : [disruption.point];
    return candidates.some((point) => haversineMeters(segmentMid, point) < 75);
  });
  return near ? 1.65 : 1;
}

function estimateSeconds(segments: RouteSegment[], mode: RouteMode) {
  const metersPerSecond = mode === "accessible" ? 1.05 : 1.28;
  return segments.reduce((sum, segment) => {
    const stairPenalty = segment.kind === "steps" ? 20 : 0;
    return sum + segment.distance / metersPerSecond + stairPenalty;
  }, 0);
}

function buildQuality(segments: RouteSegment[], distance: number, straightDistance: number): RouteQuality {
  const counts = segments.reduce<Record<string, number>>((acc, segment) => {
    acc[segment.kind] = (acc[segment.kind] ?? 0) + segment.distance;
    return acc;
  }, {});

  const stairMeters = counts.steps ?? 0;
  const trailMeters = (counts.path ?? 0) + (counts.pedestrian ?? 0);
  const sidewalkMeters = (counts.footway ?? 0) + (counts["sidewalk-road"] ?? 0);
  const fallbackMeters = (counts["fallback-road"] ?? 0) + (counts["quiet-road"] ?? 0);
  const knownLitMeters = sumWhere(segments, (segment) => segment.tags?.lit === "yes");
  const coveredMeters = sumWhere(
    segments,
    (segment) => segment.tags?.covered === "yes" || segment.tags?.tunnel === "building_passage" || segment.tags?.arcade === "yes"
  );
  const roughSurfaceMeters = sumWhere(segments, (segment) =>
    Boolean(segment.tags?.surface && /unpaved|gravel|dirt|ground|grass|sand|mud|sett|cobblestone/.test(segment.tags.surface))
  );
  const crossingMeters = sumWhere(segments, (segment) => segment.tags?.footway === "crossing" || segment.tags?.crossing !== undefined);
  const directness = Math.min(100, Math.max(0, (straightDistance / Math.max(distance, 1)) * 100));
  const comfortRaw =
    96 -
    (fallbackMeters / Math.max(distance, 1)) * 34 -
    (stairMeters / Math.max(distance, 1)) * 26 -
    (roughSurfaceMeters / Math.max(distance, 1)) * 18 +
    (trailMeters / Math.max(distance, 1)) * 6 +
    (coveredMeters / Math.max(distance, 1)) * 4;

  return {
    comfort: Math.round(Math.max(35, Math.min(100, comfortRaw))),
    directness: Math.round(directness),
    stairMeters,
    trailMeters,
    sidewalkMeters,
    knownLitMeters,
    coveredMeters,
    roughSurfaceMeters,
    crossingMeters,
    kindMeters: counts as Partial<Record<WayKind | "connector", number>>
  };
}

function buildSteps(segments: RouteSegment[]): RouteStep[] {
  const steps: RouteStep[] = [];
  for (const segment of segments) {
    const label = segment.name ?? humanKind(segment.kind);
    const current = steps[steps.length - 1];
    if (current && current.label === label && current.kind === segment.kind) {
      current.distance += segment.distance;
    } else {
      steps.push({ label, distance: segment.distance, kind: segment.kind });
    }
  }
  return steps.filter((step) => step.distance >= 8).slice(0, 8);
}

function buildInsights(segments: RouteSegment[], distance: number, mode: RouteMode, quality: RouteQuality) {
  const counts = quality.kindMeters;
  const topKind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "footway";
  const named = [...new Set(segments.map((segment) => segment.name).filter(Boolean))].slice(0, 3);
  const insights = [
    `${Math.round(
      ((counts.footway ?? 0) + (counts.path ?? 0) + (counts.pedestrian ?? 0) + (counts["sidewalk-road"] ?? 0)) /
        Math.max(distance, 1) *
        100
    )}% uses sidewalks, paths, or pedestrian-first links.`,
    topKind === "steps" ? "Includes stairs." : "Avoids long stair-heavy stretches.",
    mode === "green" ? "Prefers trails and park-like paths where available." : "Balances directness with sidewalk comfort."
  ];
  if (quality.roughSurfaceMeters > 40) insights.push(`${Math.round(quality.roughSurfaceMeters)} m may be rough or unpaved.`);
  if (quality.knownLitMeters > 80) insights.push(`${Math.round(quality.knownLitMeters)} m is tagged as lit in OpenStreetMap.`);
  if (quality.coveredMeters > 40) insights.push(`${Math.round(quality.coveredMeters)} m has covered or sheltered links.`);
  if (named.length) insights.push(`Key links: ${named.join(", ")}.`);
  return insights;
}

function humanKind(kind: WayKind | "connector") {
  const labels: Record<WayKind | "connector", string> = {
    footway: "Footway",
    path: "Path",
    pedestrian: "Pedestrian street",
    steps: "Steps",
    "sidewalk-road": "Sidewalk",
    "quiet-road": "Quiet street",
    "fallback-road": "Street edge",
    connector: "Map match"
  };
  return labels[kind];
}

function sumWhere(segments: RouteSegment[], predicate: (segment: RouteSegment) => boolean) {
  return segments.reduce((sum, segment) => sum + (predicate(segment) ? segment.distance : 0), 0);
}

function ensureNode(nodes: Map<string, NodeRecord>, id: string, point: LatLng) {
  if (!nodes.has(id)) nodes.set(id, { id, point, edges: [] });
}

function keyForPoint(point: LatLng) {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}

function heuristic(graph: { nodes: Map<string, NodeRecord> }, from: string, to: string) {
  const fromNode = graph.nodes.get(from);
  const toNode = graph.nodes.get(to);
  if (!fromNode || !toNode) return 0;
  return haversineMeters(fromNode.point, toNode.point);
}
