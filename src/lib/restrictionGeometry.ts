import type { Disruption } from "./disruptions";
import { TORONTO_CENTER, type LatLng } from "./toronto";

type XY = { x: number; y: number };
type Segment = { start: XY; end: XY; minX: number; maxX: number; minY: number; maxY: number };

function project(point: LatLng): XY {
  return {
    x: (point.lng - TORONTO_CENTER.lng) * 111_320 * Math.cos(TORONTO_CENTER.lat * Math.PI / 180),
    y: (point.lat - TORONTO_CENTER.lat) * 111_320
  };
}

function segments(points: LatLng[]): Segment[] {
  const projected = points.map(project);
  if (projected.length === 1) projected.push(projected[0]);
  return projected.slice(1).map((end, index) => {
    const start = projected[index];
    return {
      start,
      end,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y)
    };
  });
}

function pointDistanceSquared(point: XY, { start, end }: Segment) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = dx * dx + dy * dy;
  const projection = len ? ((point.x - start.x) * dx + (point.y - start.y) * dy) / len : 0;
  const fraction = Math.min(1, Math.max(0, projection));
  return (point.x - start.x - fraction * dx) ** 2 + (point.y - start.y - fraction * dy) ** 2;
}

function side(start: XY, end: XY, point: XY) {
  return (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
}

function segmentDistanceSquared(a: Segment, b: Segment) {
  const crosses =
    side(a.start, a.end, b.start) * side(a.start, a.end, b.end) < 0 &&
    side(b.start, b.end, a.start) * side(b.start, b.end, a.end) < 0;
  if (crosses) return 0;
  return Math.min(
    pointDistanceSquared(a.start, b),
    pointDistanceSquared(a.end, b),
    pointDistanceSquared(b.start, a),
    pointDistanceSquared(b.end, a)
  );
}

export function nearbyRoadRestrictions(route: LatLng[], disruptions: Disruption[], radius = 90) {
  const routeSegments = segments(route);
  return disruptions.flatMap((item) => {
    let bestSquared = radius ** 2;
    let nearby = false;
    for (const b of segments(item.polyline.length ? item.polyline : [item.point])) {
      for (const a of routeSegments) {
        if (a.maxX + radius < b.minX || b.maxX + radius < a.minX ||
            a.maxY + radius < b.minY || b.maxY + radius < a.minY) continue;
        const squared = segmentDistanceSquared(a, b);
        if (squared <= bestSquared) {
          nearby = true;
          bestSquared = squared;
        }
      }
      if (bestSquared === 0) break;
    }
    return nearby ? [{ item, meters: Math.sqrt(bestSquared) }] : [];
  }).sort((a, b) => a.meters - b.meters || a.item.id.localeCompare(b.item.id));
}
