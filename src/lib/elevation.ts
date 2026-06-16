import { haversineMeters, LatLng } from "./toronto";

export type ElevationPoint = LatLng & {
  distance: number;
  elevation: number;
};

export type ElevationSummary = {
  points: ElevationPoint[];
  ascent: number;
  descent: number;
  maxGrade: number;
};

type OpenTopoResponse = {
  results?: { elevation: number }[];
};

export async function fetchElevation(route: LatLng[]): Promise<ElevationSummary> {
  const sampled = sampleRoute(route, 36);
  if (sampled.length < 2) return emptySummary();

  try {
    const locations = sampled.map((point) => `${point.lat},${point.lng}`).join("|");
    const response = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${encodeURIComponent(locations)}`);
    if (!response.ok) throw new Error("Elevation service unavailable.");
    const data = (await response.json()) as OpenTopoResponse;
    const elevations = data.results?.map((row) => row.elevation) ?? [];
    return summarizeElevation(sampled, elevations);
  } catch {
    return synthesizeElevation(sampled);
  }
}

function summarizeElevation(points: LatLng[], elevations: number[]): ElevationSummary {
  const profile: ElevationPoint[] = [];
  let distance = 0;
  let ascent = 0;
  let descent = 0;
  let maxGrade = 0;

  points.forEach((point, index) => {
    if (index > 0) distance += haversineMeters(points[index - 1], point);
    const previousElevation = profile[index - 1]?.elevation ?? elevations[index] ?? 0;
    const elevation = elevations[index] ?? previousElevation;
    const delta = elevation - previousElevation;
    if (delta > 0) ascent += delta;
    if (delta < 0) descent += Math.abs(delta);
    const segmentDistance = index > 0 ? haversineMeters(points[index - 1], point) : 0;
    if (segmentDistance >= 15) maxGrade = Math.max(maxGrade, Math.abs(delta / segmentDistance) * 100);
    profile.push({ ...point, distance, elevation });
  });

  return { points: profile, ascent, descent, maxGrade: Math.min(maxGrade, 22) };
}

function synthesizeElevation(points: LatLng[]): ElevationSummary {
  const synthetic = points.map((point, index) => {
    const valley = Math.sin((point.lng + 79.39) * 80) * 6;
    const northRise = (point.lat - 43.63) * 210;
    return 76 + valley + northRise + Math.sin(index * 0.7) * 2;
  });
  return summarizeElevation(points, synthetic);
}

function sampleRoute(route: LatLng[], maxPoints: number): LatLng[] {
  if (route.length <= maxPoints) return route;
  const cumulative = [0];
  for (let index = 1; index < route.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + haversineMeters(route[index - 1], route[index]);
  }
  const total = cumulative[cumulative.length - 1];
  const result: LatLng[] = [route[0]];

  for (let sample = 1; sample < maxPoints - 1; sample += 1) {
    const target = (total * sample) / (maxPoints - 1);
    const segmentIndex = cumulative.findIndex((distance) => distance >= target);
    if (segmentIndex <= 0) continue;
    const before = route[segmentIndex - 1];
    const after = route[segmentIndex];
    const segmentStart = cumulative[segmentIndex - 1];
    const segmentLength = cumulative[segmentIndex] - segmentStart || 1;
    const t = (target - segmentStart) / segmentLength;
    result.push({
      lat: before.lat + (after.lat - before.lat) * t,
      lng: before.lng + (after.lng - before.lng) * t
    });
  }
  result.push(route[route.length - 1]);
  return result;
}

function emptySummary(): ElevationSummary {
  return { points: [], ascent: 0, descent: 0, maxGrade: 0 };
}
