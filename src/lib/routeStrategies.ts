import { Disruption } from "./disruptions";
import { RouteMode, RouteResult } from "./routing";
import { haversineMeters, inToronto, LatLng } from "./toronto";
import { routeWithValhalla } from "./valhalla";

type Anchor = {
  name: string;
  point: LatLng;
};

const GREEN_ANCHORS: Anchor[] = [
  { name: "High Park", point: { lat: 43.6465, lng: -79.4637 } },
  { name: "Trinity Bellwoods", point: { lat: 43.6476, lng: -79.4136 } },
  { name: "Queen's Park", point: { lat: 43.6633, lng: -79.3925 } },
  { name: "Riverdale Park", point: { lat: 43.6693, lng: -79.3567 } },
  { name: "Don Valley Trail", point: { lat: 43.689, lng: -79.3607 } },
  { name: "Beltline Trail", point: { lat: 43.7001, lng: -79.4053 } },
  { name: "Cedarvale Ravine", point: { lat: 43.6907, lng: -79.4288 } },
  { name: "Humber River Trail", point: { lat: 43.681, lng: -79.5035 } },
  { name: "Martin Goodman Trail", point: { lat: 43.6375, lng: -79.3971 } },
  { name: "Taylor Creek Park", point: { lat: 43.695, lng: -79.3095 } },
  { name: "Scarborough Bluffs", point: { lat: 43.707, lng: -79.235 } },
  { name: "Morningside Park", point: { lat: 43.7869, lng: -79.1995 } }
];

export async function buildRouteAlternatives(
  origin: LatLng,
  destination: LatLng,
  disruptions: Disruption[]
): Promise<Partial<Record<RouteMode, RouteResult>>> {
  const directRoutes = await Promise.all([
    routeWithValhalla(origin, destination, "shortest", disruptions),
    routeWithValhalla(origin, destination, "best", disruptions)
  ]);
  const alternatives: Partial<Record<RouteMode, RouteResult>> = {
    shortest: directRoutes[0],
    best: directRoutes[1]
  };

  const [green, accessible, balanced] = await Promise.allSettled([
    routeModeWithCandidates(origin, destination, "green", disruptions, greenCandidates(origin, destination)),
    routeModeWithCandidates(origin, destination, "accessible", disruptions, easyCandidates(origin, destination)),
    routeModeWithCandidates(origin, destination, "best", disruptions, bestCandidates(origin, destination))
  ]);

  alternatives.green =
    green.status === "fulfilled" && !sameRoute(green.value, alternatives.shortest) ? green.value : await distinctFallback(origin, destination, "green", disruptions);
  alternatives.accessible =
    accessible.status === "fulfilled" && !sameRoute(accessible.value, alternatives.shortest)
      ? accessible.value
      : await distinctFallback(origin, destination, "accessible", disruptions);

  alternatives.best =
    balanced.status === "fulfilled" && isUnique(balanced.value, [alternatives.shortest, alternatives.accessible, alternatives.green])
      ? balanced.value
      : chooseBest(alternatives);
  if (!isUnique(alternatives.best, [alternatives.shortest, alternatives.accessible, alternatives.green])) {
    alternatives.best = await distinctFallback(origin, destination, "best", disruptions);
  }
  return alternatives;
}

async function routeModeWithCandidates(
  origin: LatLng,
  destination: LatLng,
  mode: RouteMode,
  disruptions: Disruption[],
  candidates: LatLng[]
) {
  const attempts = await Promise.allSettled(candidates.slice(0, 4).map((point) => routeWithValhalla(origin, destination, mode, disruptions, [point])));
  const routes = attempts
    .filter((result): result is PromiseFulfilledResult<RouteResult> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((route) => route.distance <= directDistance(origin, destination) * (mode === "green" ? 1.75 : 1.55));

  if (!routes.length) return routeWithValhalla(origin, destination, mode, disruptions);
  return routes.sort((a, b) => scoreCandidateRoute(b, mode) - scoreCandidateRoute(a, mode))[0];
}

async function distinctFallback(origin: LatLng, destination: LatLng, mode: RouteMode, disruptions: Disruption[]) {
  const fallback = offsetCandidates(origin, destination, mode === "green" ? 850 : mode === "best" ? 350 : 550)[0];
  return routeWithValhalla(origin, destination, mode, disruptions, fallback ? [fallback] : []);
}

function chooseBest(alternatives: Partial<Record<RouteMode, RouteResult>>) {
  const allRoutes = [alternatives.shortest, alternatives.green, alternatives.accessible].filter(Boolean) as RouteResult[];
  const shortestRoute = alternatives.shortest;
  const shortest = shortestRoute?.distance ?? allRoutes[0]?.distance ?? 1;
  const nonShortRoutes = allRoutes.filter((route) => !sameRoute(route, shortestRoute) && route.distance <= shortest * 1.22);
  const routes = nonShortRoutes.length ? nonShortRoutes : allRoutes;
  const best =
    routes
      .map((route) => ({
        route,
        score:
          route.quality.comfort * 1.25 +
          route.quality.directness * 0.55 -
          ((route.distance - shortest) / Math.max(shortest, 1)) * 48 -
          route.quality.roughSurfaceMeters / Math.max(route.distance, 1) * 18
      }))
      .sort((a, b) => b.score - a.score)[0]?.route ?? alternatives.shortest!;

  return best;
}

function greenCandidates(origin: LatLng, destination: LatLng) {
  const direct = directDistance(origin, destination);
  return GREEN_ANCHORS.map((anchor) => ({
    anchor,
    detour: haversineMeters(origin, anchor.point) + haversineMeters(anchor.point, destination),
    corridor: distanceToLineMeters(anchor.point, origin, destination)
  }))
    .filter(({ detour, corridor }) => detour <= direct * 1.75 && corridor <= Math.max(900, direct * 0.28))
    .sort((a, b) => a.detour + a.corridor * 1.4 - (b.detour + b.corridor * 1.4))
    .map(({ anchor }) => anchor.point)
    .concat(offsetCandidates(origin, destination, 900))
    .filter(inToronto);
}

function easyCandidates(origin: LatLng, destination: LatLng) {
  return offsetCandidates(origin, destination, 550)
    .concat(offsetCandidates(origin, destination, 1000))
    .sort((a, b) => syntheticGrade(a) - syntheticGrade(b))
    .filter(inToronto);
}

function bestCandidates(origin: LatLng, destination: LatLng) {
  return offsetCandidates(origin, destination, 350)
    .concat(offsetCandidates(origin, destination, 700))
    .sort((a, b) => distanceToLineMeters(a, origin, destination) + syntheticGrade(a) - (distanceToLineMeters(b, origin, destination) + syntheticGrade(b)))
    .filter(inToronto);
}

function offsetCandidates(origin: LatLng, destination: LatLng, meters: number) {
  const midpoint = { lat: (origin.lat + destination.lat) / 2, lng: (origin.lng + destination.lng) / 2 };
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((midpoint.lat * Math.PI) / 180);
  const dx = (destination.lng - origin.lng) * lngScale;
  const dy = (destination.lat - origin.lat) * latScale;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  return [
    { lat: midpoint.lat + (ny * meters) / latScale, lng: midpoint.lng + (nx * meters) / lngScale },
    { lat: midpoint.lat - (ny * meters) / latScale, lng: midpoint.lng - (nx * meters) / lngScale }
  ].filter(inToronto);
}

function scoreCandidateRoute(route: RouteResult, mode: RouteMode) {
  if (mode === "green") return route.quality.comfort + route.quality.directness * 0.2 - route.quality.roughSurfaceMeters / 120;
  return route.quality.comfort * 1.2 + route.quality.directness * 0.35 - route.quality.roughSurfaceMeters / 90;
}

function sameRoute(a?: RouteResult, b?: RouteResult) {
  if (!a || !b) return false;
  if (Math.abs(a.distance - b.distance) > 35) return false;
  const aKey = signature(a.path);
  const bKey = signature(b.path);
  return aKey === bKey;
}

function isUnique(route: RouteResult | undefined, others: Array<RouteResult | undefined>) {
  return Boolean(route) && others.every((other) => !sameRoute(route, other));
}

function signature(path: LatLng[]) {
  const samples = [0.25, 0.5, 0.75].map((ratio) => path[Math.min(path.length - 1, Math.floor(path.length * ratio))]);
  return samples.map((point) => `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`).join("|");
}

function directDistance(origin: LatLng, destination: LatLng) {
  return haversineMeters(origin, destination);
}

function syntheticGrade(point: LatLng) {
  return Math.abs((point.lat - 43.64) * 210 + Math.sin((point.lng + 79.39) * 80) * 6);
}

function distanceToLineMeters(point: LatLng, start: LatLng, end: LatLng) {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const sx = start.lng * lngScale;
  const sy = start.lat * latScale;
  const ex = end.lng * lngScale;
  const ey = end.lat * latScale;
  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSquared));
  return Math.hypot(px - (sx + t * dx), py - (sy + t * dy));
}
