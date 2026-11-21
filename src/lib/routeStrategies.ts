import type { RouteMode, RouteResult } from "./routing";
import { haversineMeters, type LatLng } from "./toronto";
import { routeWithValhalla } from "./valhalla";

const MODES: RouteMode[] = ["best", "shortest", "accessible", "green"];

const GREEN_ANCHORS: LatLng[] = [
  { lat: 43.6465, lng: -79.4637 }, // High Park
  { lat: 43.6476, lng: -79.4136 }, // Trinity Bellwoods
  { lat: 43.6633, lng: -79.3925 }, // Queen's Park
  { lat: 43.6693, lng: -79.3567 }, // Riverdale Park
  { lat: 43.689, lng: -79.3607 }, // Don Valley Trail
  { lat: 43.7001, lng: -79.4053 }, // Beltline Trail
  { lat: 43.6907, lng: -79.4288 }, // Cedarvale Ravine
  { lat: 43.681, lng: -79.5035 }, // Humber River Trail
  { lat: 43.6375, lng: -79.3971 }, // Martin Goodman Trail
  { lat: 43.695, lng: -79.3095 }, // Taylor Creek Park
  { lat: 43.707, lng: -79.235 }, // Scarborough Bluffs
  { lat: 43.7869, lng: -79.1995 } // Morningside Park
];

async function routeOption(origin: LatLng, destination: LatLng, mode: RouteMode, signal: AbortSignal) {
  if (mode === "green") {
    const direct = haversineMeters(origin, destination);
    const anchor = GREEN_ANCHORS
      .map((point) => ({ point, distance: haversineMeters(origin, point) + haversineMeters(point, destination) }))
      .filter(({ distance }) => distance <= direct * 1.5)
      .sort((a, b) => a.distance - b.distance)[0];
    if (anchor) {
      try {
        const route = await routeWithValhalla(origin, destination, mode, [anchor.point], signal);
        if (route.distance <= direct * 1.75) return route;
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  }
  return routeWithValhalla(origin, destination, mode, [], signal);
}

export async function planAvailableRoute(origin: LatLng, destination: LatLng, mode: RouteMode, signal: AbortSignal) {
  try {
    return { mode, route: await routeOption(origin, destination, mode, signal) };
  } catch (error) {
    if (signal.aborted) throw error;
    const fallback: RouteMode = mode === "shortest" ? "best" : "shortest";
    return { mode: fallback, route: await routeOption(origin, destination, fallback, signal) };
  }
}

export async function loadRouteAlternatives(
  origin: LatLng,
  destination: LatLng,
  primary: RouteMode,
  signal: AbortSignal,
  publish: (mode: RouteMode, route: RouteResult) => void
) {
  return Promise.allSettled(MODES.filter((mode) => mode !== primary).map(async (mode) => {
    const route = await routeOption(origin, destination, mode, signal);
    if (!signal.aborted) publish(mode, route);
  }));
}
