import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  Footprints,
  LocateFixed,
  MapPin,
  Navigation,
  Play,
  RefreshCcw,
  Route as RouteIcon,
  Trees
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Disruption, DisruptionFeed, fetchRoadRestrictionsWithStatus, nearestDisruptionMeters } from "./lib/disruptions";
import { ElevationSummary, fetchElevation } from "./lib/elevation";
import { geocodeToronto, Place } from "./lib/geocode";
import { buildRouteAlternatives } from "./lib/routeStrategies";
import { RouteMode, RouteResult, RouteSegment } from "./lib/routing";
import {
  boundsForPoints,
  formatDistance,
  formatMinutes,
  LatLng,
  TORONTO_BOUNDS,
  TORONTO_CENTER,
  inToronto
} from "./lib/toronto";

const startMarkerIcon = L.divIcon({
  className: "pin-marker start-pin",
  html: "<span>A</span>",
  iconSize: [28, 28],
  iconAnchor: [14, 14]
});

const endMarkerIcon = L.divIcon({
  className: "pin-marker end-pin",
  html: "<span>B</span>",
  iconSize: [28, 28],
  iconAnchor: [14, 14]
});

const DEFAULT_FROM = "";
const DEFAULT_TO = "";
const ROUTE_MODES: Array<{ value: RouteMode; icon: LucideIcon; label: string; description: string }> = [
  { value: "best", icon: Footprints, label: "Best", description: "Balanced for a comfortable walk without adding too much distance." },
  { value: "shortest", icon: RouteIcon, label: "Short", description: "Most direct walking route between your two points." },
  { value: "accessible", icon: Activity, label: "Easy", description: "Chooses a calmer route shape with gentler walking conditions." },
  { value: "green", icon: Trees, label: "Green", description: "Bends toward park, trail, and quieter walking corridors when possible." }
];

type PinTarget = "from" | "to";

type RouteState = {
  from: Place;
  to: Place;
  alternatives: Partial<Record<RouteMode, RouteResult>>;
  elevations: Partial<Record<RouteMode, ElevationSummary>>;
  route: RouteResult;
  elevation: ElevationSummary;
  disruptions: Disruption[];
  disruptionFeed: DisruptionFeed;
  networkCount: number;
};

export default function App() {
  const [fromText, setFromText] = useState(DEFAULT_FROM);
  const [toText, setToText] = useState(DEFAULT_TO);
  const [mode, setMode] = useState<RouteMode | null>(null);
  const [pinTarget, setPinTarget] = useState<PinTarget | null>(null);
  const [draftFromPoint, setDraftFromPoint] = useState<LatLng | null>(null);
  const [draftToPoint, setDraftToPoint] = useState<LatLng | null>(null);
  const [routeState, setRouteState] = useState<RouteState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function planRoute(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const [fromMatches, toMatches] = await Promise.all([geocodeToronto(fromText), geocodeToronto(toText)]);
      const from = fromMatches[0];
      const to = toMatches[0];
      if (!from || !to) throw new Error("Both places must resolve inside Toronto.");

      const bounds = boundsForPoints([from.point, to.point], 900);
      const disruptionsPromise = withTimeout<DisruptionFeed>(fetchRoadRestrictionsWithStatus(bounds), 6500, { items: [], source: "unavailable" });
      const alternatives = await buildRouteAlternatives(from.point, to.point, []);

      const availableMode = (mode && alternatives[mode] ? mode : alternatives.best ? "best" : ROUTE_MODES.find((candidate) => alternatives[candidate.value])?.value) ?? "best";
      const route = alternatives[availableMode];
      if (!route) throw new Error("No connected pedestrian route was found. Try a closer pair of places.");
      if (availableMode !== mode) setMode(availableMode);
      const elevation = await fetchElevation(route.path);

      setRouteState({
        from,
        to,
        alternatives,
        elevations: { [availableMode]: elevation },
        route,
        elevation,
        disruptions: [],
        disruptionFeed: { items: [], source: "loading" },
        networkCount: route.path.length
      });
      setDraftFromPoint(from.point);
      setDraftToPoint(to.point);
      void disruptionsPromise.then((feed) => {
        setRouteState((current) =>
          current && current.from.label === from.label && current.to.label === to.label
            ? {
                ...current,
                disruptions: feed.items,
                disruptionFeed: feed
              }
            : current
        );
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Route planning failed.");
    } finally {
      setBusy(false);
    }
  }

  async function selectMode(value: RouteMode) {
    setMode(value);
    const route = routeState?.alternatives[value];
    if (!route || !routeState) return;

    const cachedElevation = routeState.elevations[value];
    if (cachedElevation) {
      setRouteState({ ...routeState, route, elevation: cachedElevation, networkCount: route.path.length });
      return;
    }

    setBusy(true);
    try {
      const elevation = await fetchElevation(route.path);
      setRouteState((current) =>
        current
          ? {
              ...current,
              route,
              elevation,
              networkCount: route.path.length,
              elevations: { ...current.elevations, [value]: elevation }
            }
          : current
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Elevation refresh failed.");
    } finally {
      setBusy(false);
    }
  }

  function swapPlaces() {
    setFromText(toText);
    setToText(fromText);
    setDraftFromPoint(draftToPoint);
    setDraftToPoint(draftFromPoint);
    setRouteState(null);
  }

  function useLocation() {
    navigator.geolocation?.getCurrentPosition(
      (position) => setPinnedPoint("from", { lat: position.coords.latitude, lng: position.coords.longitude }),
      () => setError("Location permission was not available.")
    );
  }

  function updateFromText(value: string) {
    setFromText(value);
    setDraftFromPoint(null);
    setRouteState(null);
  }

  function updateToText(value: string) {
    setToText(value);
    setDraftToPoint(null);
    setRouteState(null);
  }

  function setPinnedPoint(target: PinTarget, point: LatLng) {
    if (!inToronto(point)) {
      setError("Pin must be inside Toronto.");
      return;
    }

    const text = `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
    if (target === "from") {
      setFromText(text);
      setDraftFromPoint(point);
      setPinTarget("to");
    } else {
      setToText(text);
      setDraftToPoint(point);
    }
    setRouteState(null);
    setError(null);
  }

  const nearestWork = useMemo(
    () => (routeState ? nearestDisruptionMeters(routeState.route.path, routeState.disruptions) : Infinity),
    [routeState]
  );
  const fromPoint = draftFromPoint ?? routeState?.from.point ?? null;
  const toPoint = draftToPoint ?? routeState?.to.point ?? null;

  return (
    <main className="shell">
      <section className="map-stage" aria-label="Toronto pedestrian route map">
        <MapContainer
          center={[TORONTO_CENTER.lat, TORONTO_CENTER.lng]}
          zoom={13}
          minZoom={11}
          maxBounds={[
            [TORONTO_BOUNDS.south, TORONTO_BOUNDS.west],
            [TORONTO_BOUNDS.north, TORONTO_BOUNDS.east]
          ]}
          className="map"
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            updateWhenIdle={false}
          />
          <MapResizeFix />
          <MapClickPicker target={pinTarget} onPick={setPinnedPoint} />
          {routeState && <RouteViewport points={routeState.route.path} />}
          {fromPoint && (
            <Marker position={[fromPoint.lat, fromPoint.lng]} icon={startMarkerIcon}>
              <Tooltip>Start</Tooltip>
            </Marker>
          )}
          {toPoint && (
            <Marker position={[toPoint.lat, toPoint.lng]} icon={endMarkerIcon}>
              <Tooltip>End</Tooltip>
            </Marker>
          )}
          {routeState?.route.segments.map((segment, index) => (
            <Polyline
              key={`${segment.kind}-${index}`}
              positions={[
                [segment.from.lat, segment.from.lng],
                [segment.to.lat, segment.to.lng]
              ]}
              pathOptions={{ color: segmentColor(segment), weight: segment.kind === "connector" ? 4 : 6, opacity: 0.86 }}
            />
          ))}
          {routeState?.disruptions.slice(0, 80).map((item) => (
            <CircleMarker
              key={item.id}
              center={[item.point.lat, item.point.lng]}
              radius={6}
              pathOptions={{ color: "#d34a31", fillColor: "#ffb199", fillOpacity: 0.75, weight: 1.5 }}
            >
              <Tooltip>
                {item.road} · {item.impact}
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </section>

      <aside className="control-panel">
        <div className="brand-row">
          <div>
            <p className="eyebrow">Toronto</p>
            <h1>Walkline</h1>
            <p className="title-help">Plan Toronto walks from typed addresses or exact map pins, then compare the shortest, easiest, greenest, and best-balanced route.</p>
          </div>
        </div>

        <form className="route-form" onSubmit={planRoute}>
          <div className="form-actions">
            <button className="icon-button" type="button" onClick={swapPlaces} title="Swap">
              <ArrowRightLeft size={18} />
            </button>
            <button className="icon-button" type="button" onClick={() => planRoute()} disabled={busy} title="Refresh">
              <RefreshCcw size={18} />
            </button>
          </div>

          <label>
            <span>From</span>
            <div className="input-row">
              <MapPin size={18} />
              <input value={fromText} onChange={(event) => updateFromText(event.target.value)} />
              <button className="mini-button" type="button" onClick={useLocation} title="Use location">
                <LocateFixed size={16} />
              </button>
            </div>
          </label>

          <label>
            <span>To</span>
            <div className="input-row">
              <Navigation size={18} />
              <input value={toText} onChange={(event) => updateToText(event.target.value)} />
            </div>
          </label>

          <div className="pin-row" aria-label="Map pin target">
            <button type="button" className={pinTarget === "from" ? "pin-target active" : "pin-target"} onClick={() => setPinTarget("from")}>
              <MapPin size={15} />
              <span>Pin start</span>
            </button>
            <button type="button" className={pinTarget === "to" ? "pin-target active" : "pin-target"} onClick={() => setPinTarget("to")}>
              <Navigation size={15} />
              <span>Pin end</span>
            </button>
          </div>

          <div className="mode-row" role="group" aria-label="Routing mode">
            {ROUTE_MODES.map(({ value, icon: Icon, label }) => {
              const route = routeState?.alternatives[value];
              return (
                <button
                  className={mode === value ? "mode active" : "mode"}
                  type="button"
                  aria-pressed={mode === value}
                  key={value}
                  onClick={() => selectMode(value)}
                  disabled={Boolean(routeState) && (!route || busy)}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <button className="primary-button" type="submit" disabled={busy}>
            <Play size={18} />
            <span>{busy ? "Planning" : "Plan walk"}</span>
          </button>
        </form>

        {error && (
          <div className="status-line error" role="alert">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {routeState && (
          <section className="metrics-band">
            <Metric label="Distance" value={formatDistance(routeState.route.distance)} />
            <Metric label="Time" value={formatMinutes(routeState.route.seconds)} />
            <Metric label="Directness" value={`${routeState.route.quality.directness}%`} />
            <Metric label="Up / down" value={routeState.elevation.ascent === null || routeState.elevation.descent === null ? "Unavailable" : `${Math.round(routeState.elevation.ascent)} / ${Math.round(routeState.elevation.descent)} m`} />
          </section>
        )}

        {routeState && (
          <>
            <section className="route-readout">
              <div className="route-title">
                <span>{selectedModeDetails(mode ?? "best").label} walk selected</span>
              </div>
              <p className="route-description">{selectedModeDetails(mode ?? "best").description}</p>
              <ElevationChart summary={routeState.elevation} />
              <div className="signal-grid">
                <Signal label="Stairs" value={routeState.route.quality.stairMeters === null ? "Unknown" : formatDistance(routeState.route.quality.stairMeters)} />
                <Signal label="Closest work" value={Number.isFinite(nearestWork) ? formatDistance(nearestWork) : routeState.disruptionFeed.source === "live" ? "None reported" : "Unknown"} />
                <Signal label="Grade estimate" value={routeState.elevation.maxGrade === null ? "Unavailable" : `${routeState.elevation.maxGrade.toFixed(1)}%`} />
                <Signal label="Rough path" value={formatDistance(routeState.route.quality.roughSurfaceMeters)} />
              </div>
              <p className="route-description" role="status">{routeState.disruptionFeed.source === "live" ? "Road restrictions: live City of Toronto feed." : routeState.disruptionFeed.source === "snapshot" ? `Road restrictions: saved City snapshot${routeState.disruptionFeed.updatedAt ? ` from ${new Date(routeState.disruptionFeed.updatedAt).toLocaleDateString()}` : " (date unknown)"}. Check current conditions.` : routeState.disruptionFeed.source === "loading" ? "Loading road restrictions…" : "Current road restrictions unavailable."} Stairs and step-free access are not verified.</p>
              <p className="route-description"><a href="https://open.toronto.ca/dataset/road-restrictions/" target="_blank" rel="noreferrer">City of Toronto open data</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href="https://www.opentopodata.org/" target="_blank" rel="noreferrer">SRTM elevation</a></p>
            </section>

          </>
        )}

      </aside>
    </main>
  );
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

function MapResizeFix() {
  const map = useMap();

  useEffect(() => {
    const fixSize = () => map.invalidateSize({ animate: false });
    fixSize();
    const timeoutId = window.setTimeout(fixSize, 0);
    const rafId = window.requestAnimationFrame(fixSize);
    window.addEventListener("resize", fixSize);
    return () => {
      window.clearTimeout(timeoutId);
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", fixSize);
    };
  }, [map]);

  return null;
}

function RouteViewport({ points }: { points: LatLng[] }) {
  const map = useMap();
  if (points.length > 1) {
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]));
    window.setTimeout(() => map.fitBounds(bounds, { padding: [56, 56] }), 0);
  }
  return null;
}

function MapClickPicker({ target, onPick }: { target: PinTarget | null; onPick: (target: PinTarget, point: LatLng) => void }) {
  useMapEvents({
    click(event) {
      if (!target) return;
      onPick(target, { lat: event.latlng.lat, lng: event.latlng.lng });
    }
  });
  return null;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <div className="signal">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function shortPlaceLabel(place: Place) {
  if (/^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/.test(place.label)) {
    return `${place.point.lat.toFixed(5)}, ${place.point.lng.toFixed(5)}`;
  }
  return place.label.split(",")[0];
}

function selectedModeDetails(value: RouteMode) {
  return ROUTE_MODES.find((candidate) => candidate.value === value) ?? ROUTE_MODES[0];
}

function ElevationChart({ summary }: { summary: ElevationSummary }) {
  const points = summary.points;
  if (points.length < 2) return <div className="chart-empty">Elevation unavailable</div>;

  const width = 320;
  const height = 82;
  const min = Math.min(...points.map((point) => point.elevation));
  const max = Math.max(...points.map((point) => point.elevation));
  const total = points[points.length - 1].distance || 1;
  const path = points
    .map((point, index) => {
      const x = (point.distance / total) * width;
      const y = height - ((point.elevation - min) / Math.max(max - min, 1)) * (height - 14) - 7;
      return `${index ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg className="elevation-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Elevation profile">
      <path d={`${path} L ${width} ${height} L 0 ${height} Z`} className="chart-fill" />
      <path d={path} className="chart-line" />
    </svg>
  );
}

function segmentColor(segment: RouteSegment) {
  switch (segment.kind) {
    case "path":
      return "#3e8f59";
    case "footway":
    case "pedestrian":
      return "#15a6a3";
    case "steps":
      return "#c0782d";
    case "sidewalk-road":
      return "#2677c9";
    case "quiet-road":
      return "#778c39";
    case "fallback-road":
      return "#8d65c8";
    default:
      return "#121826";
  }
}
