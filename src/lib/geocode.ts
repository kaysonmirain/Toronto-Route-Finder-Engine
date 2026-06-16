import { inToronto, LatLng } from "./toronto";

export type Place = {
  label: string;
  point: LatLng;
};

type NominatimPlace = {
  display_name: string;
  lat: string;
  lon: string;
};

type PhotonFeature = {
  geometry?: {
    coordinates?: [number, number];
  };
  properties?: {
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    state?: string;
    postcode?: string;
    country?: string;
    osm_key?: string;
    type?: string;
  };
};

type PhotonResponse = {
  features?: PhotonFeature[];
};

const VIEWBOX = "-79.64,43.855,-79.115,43.581";
const PHOTON_BBOX = "-79.64,43.581,-79.115,43.855";

export async function geocodeToronto(query: string): Promise<Place[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];

  const coordinate = parseCoordinate(cleaned);
  if (coordinate) {
    return inToronto(coordinate)
      ? [{ label: `${coordinate.lat.toFixed(5)}, ${coordinate.lng.toFixed(5)}`, point: coordinate }]
      : [];
  }

  const photonPlaces = await withTimeout(searchPhoton(cleaned), 4500, []);
  if (photonPlaces.length) {
    return dedupePlaces(photonPlaces).sort((a, b) => scorePlace(b, cleaned) - scorePlace(a, cleaned));
  }

  const nominatimPlaces = await withTimeout(searchNominatim(cleaned), 4500, []);
  const places = [...photonPlaces, ...nominatimPlaces];

  return dedupePlaces(places).sort((a, b) => scorePlace(b, cleaned) - scorePlace(a, cleaned));
}

async function searchNominatim(query: string): Promise<Place[]> {
  const attempts = buildQueries(query);
  const results: Place[] = [];

  for (const attempt of attempts) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("q", attempt);
    url.searchParams.set("viewbox", VIEWBOX);
    url.searchParams.set("bounded", "1");
    url.searchParams.set("addressdetails", "0");

    const response = await fetch(url);
    if (!response.ok) continue;
    const rows = (await response.json()) as NominatimPlace[];
    results.push(
      ...rows
        .map((row) => ({
          label: simplifyLabel(row.display_name),
          point: { lat: Number(row.lat), lng: Number(row.lon) }
        }))
        .filter((place) => inToronto(place.point))
    );
    if (results.length) break;
  }

  return results;
}

async function searchPhoton(query: string): Promise<Place[]> {
  const attempts = buildQueries(query);
  const results: Place[] = [];

  for (const attempt of attempts) {
    const url = new URL("https://photon.komoot.io/api/");
    url.searchParams.set("q", attempt);
    url.searchParams.set("limit", "8");
    url.searchParams.set("bbox", PHOTON_BBOX);

    const response = await fetch(url);
    if (!response.ok) continue;
    const data = (await response.json()) as PhotonResponse;
    results.push(...(data.features ?? []).map(photonFeatureToPlace).filter((place): place is Place => Boolean(place)));
    if (results.length) break;
  }

  return results.filter((place) => inToronto(place.point));
}

function buildQueries(query: string) {
  const hasTorontoContext = /\b(toronto|north york|scarborough|etobicoke|east york|york|ontario|canada)\b/i.test(query);
  return [
    hasTorontoContext ? query : `${query}, Toronto, Ontario, Canada`,
    hasTorontoContext ? query : `${query}, North York, Ontario, Canada`,
    hasTorontoContext ? query : `${query}, Scarborough, Ontario, Canada`,
    hasTorontoContext ? query : `${query}, Etobicoke, Ontario, Canada`,
    query
  ].filter((value, index, list) => value.trim() && list.indexOf(value) === index);
}

function photonFeatureToPlace(feature: PhotonFeature): Place | null {
  const coordinates = feature.geometry?.coordinates;
  if (!coordinates) return null;
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    label: photonLabel(feature),
    point: { lat, lng }
  };
}

function photonLabel(feature: PhotonFeature) {
  const props = feature.properties ?? {};
  const address = [props.housenumber, props.street].filter(Boolean).join(" ");
  const primary = address || props.name || props.street || "Toronto place";
  const area = props.city ?? props.district;
  return [primary, area, props.postcode].filter(Boolean).join(", ");
}

function simplifyLabel(label: string) {
  return label
    .replace(/,\s*Toronto,\s*Ontario,\s*Canada$/i, "")
    .replace(/,\s*Ontario,\s*Canada$/i, "")
    .replace(/,\s*Canada$/i, "");
}

function dedupePlaces(places: Place[]) {
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.label.toLowerCase()}|${place.point.lat.toFixed(5)}|${place.point.lng.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scorePlace(place: Place, query: string) {
  const normalizedQuery = normalize(query);
  const normalizedLabel = normalize(place.label);
  const address = parseAddressQuery(query);
  let score = 0;

  if (normalizedLabel.includes(normalizedQuery)) score += 50;
  if (address?.number && normalizedLabel.includes(address.number)) score += 35;
  if (address?.street && normalizedLabel.includes(address.street)) score += 45;
  if (/\btoronto|north york|scarborough|etobicoke|east york|york\b/i.test(place.label)) score += 8;
  if (/\b[a-z]/i.test(query) && /^-?\d/.test(place.label)) score += 4;
  return score;
}

function parseAddressQuery(query: string) {
  const match = query.match(/^\s*(\d+[a-z]?)\s+(.+?)\s*$/i);
  if (!match) return null;
  return {
    number: normalize(match[1]),
    street: normalize(match[2].replace(/\b(toronto|north york|scarborough|etobicoke|east york|york|ontario|canada)\b/gi, ""))
  };
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(road|rd)\b/g, "rd")
    .replace(/\b(street|st)\b/g, "st")
    .replace(/\b(avenue|ave)\b/g, "ave")
    .replace(/\b(drive|dr)\b/g, "dr")
    .replace(/\s+/g, " ")
    .trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function parseCoordinate(value: string): LatLng | null {
  const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  return {
    lat: Number(match[1]),
    lng: Number(match[2])
  };
}
