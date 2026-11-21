import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }
});
after(() => vite.close());
const { nearbyRoadRestrictions } = await vite.ssrLoadModule("/src/lib/restrictionGeometry.ts");
const { activeRoadRestrictions } = await vite.ssrLoadModule("/src/lib/disruptions.ts");
const { loadRouteAlternatives, planAvailableRoute } = await vite.ssrLoadModule("/src/lib/routeStrategies.ts");

const start = { lat: 43.65, lng: -79.385 };
const end = { lat: 43.65, lng: -79.379 };

test("a crossing between vertices counts, distant work does not", () => {
  const crossing = {
    id: "crossing", point: { lat: 43.648, lng: -79.382 },
    polyline: [{ lat: 43.648, lng: -79.382 }, { lat: 43.652, lng: -79.382 }]
  };
  const distant = { id: "far", point: { lat: 43.66, lng: -79.382 }, polyline: [] };
  const point = { id: "point", point: { lat: 43.6504, lng: -79.382 }, polyline: [] };
  const matches = nearbyRoadRestrictions([start, end], [distant, point, crossing]);
  assert.deepEqual(matches.map(({ item }) => item.id), ["crossing", "point"]);
  assert.equal(matches[0].meters, 0);
  assert.ok(matches[1].meters > 40 && matches[1].meters < 50);
});

test("only active restrictions with current impact are shown", () => {
  const now = Date.parse("2026-11-20T17:00:00Z");
  const row = {
    latitude: "43.65", longitude: "-79.382",
    currImpact: "Low", maxImpact: "High",
    startTime: String(now - 1000), endTime: String(now + 1000),
    geoPolyline: "[-79.382, 43.650], [-79.381, 43.650]",
    URL: "https://www.toronto.ca/example"
  };
  const results = activeRoadRestrictions([
    { ...row, id: "active" }, { ...row, id: "future", startTime: String(now + 1) },
    { ...row, id: "expired", endTime: String(now - 1) }, { ...row, id: "none", currImpact: "None" },
    { ...row, id: "invalid", latitude: "0" }
  ], now);
  assert.deepEqual(results.map(item => item.id), ["active"]);
  assert.equal(results[0].impact, "Low");
  assert.equal(results[0].polyline.length, 2);
});

function encodeShape(points) {
  const encode = (n) => {
    let value = n < 0 ? ~(n << 1) : n << 1;
    let encoded = "";
    while (value >= 32) {
      encoded += String.fromCharCode((value & 31) + 95);
      value >>= 5;
    }
    return encoded + String.fromCharCode(value + 63);
  };
  let lat = 0;
  let lng = 0;
  return points.map(point => {
    const a = Math.round(point.lat * 1e6);
    const b = Math.round(point.lng * 1e6);
    const chunk = encode(a - lat) + encode(b - lng);
    lat = a;
    lng = b;
    return chunk;
  }).join("");
}

test("a failed routing option does not discard usable routes", async (t) => {
  const shape = encodeShape([start, end]);
  const speeds = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const payload = JSON.parse(url.searchParams.get("json"));
    const speed = payload.costing_options.pedestrian.walking_speed;
    speeds.push(speed);
    if (speed === 4 || speeds.length === 1) return new Response(null, { status: 503 });
    return Response.json({ trip: { summary: { time: 350 }, legs: [{ shape, maneuvers: [{ instruction: "Go east" }] }] } });
  });
  const signal = new AbortController().signal;
  const primary = await planAvailableRoute(start, end, "best", signal);
  assert.equal(primary.mode, "shortest");
  assert.equal(primary.route.distance > 400, true);
  const published = [];
  const results = await loadRouteAlternatives(start, end, primary.mode, signal, (mode) => published.push(mode));
  assert.ok(published.includes("best"));
  assert.ok(!published.includes("accessible"));
  assert.ok(results.some(result => result.status === "rejected"));
});
