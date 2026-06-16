export type LatLng = {
  lat: number;
  lng: number;
};

export type Bounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export const TORONTO_BOUNDS: Bounds = {
  south: 43.581,
  west: -79.64,
  north: 43.855,
  east: -79.115
};

export const TORONTO_CENTER: LatLng = {
  lat: 43.6532,
  lng: -79.3832
};

export function inToronto(point: LatLng) {
  return (
    point.lat >= TORONTO_BOUNDS.south &&
    point.lat <= TORONTO_BOUNDS.north &&
    point.lng >= TORONTO_BOUNDS.west &&
    point.lng <= TORONTO_BOUNDS.east
  );
}

export function boundsForPoints(points: LatLng[], padMeters = 600): Bounds {
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latPad = padMeters / 111_320;
  const lngPad = padMeters / (111_320 * Math.cos((minLat * Math.PI) / 180));

  return clampBounds({
    south: minLat - latPad,
    west: minLng - lngPad,
    north: maxLat + latPad,
    east: maxLng + lngPad
  });
}

export function clampBounds(bounds: Bounds): Bounds {
  return {
    south: Math.max(bounds.south, TORONTO_BOUNDS.south),
    west: Math.max(bounds.west, TORONTO_BOUNDS.west),
    north: Math.min(bounds.north, TORONTO_BOUNDS.north),
    east: Math.min(bounds.east, TORONTO_BOUNDS.east)
  };
}

export function haversineMeters(a: LatLng, b: LatLng) {
  const earthRadius = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

export function formatMinutes(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}
