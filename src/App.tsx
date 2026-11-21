import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { fetchRoadRestrictionsWithStatus, type DisruptionFeed } from "./lib/disruptions";
import { nearbyRoadRestrictions } from "./lib/restrictionGeometry";
import { ElevationSummary, fetchElevation } from "./lib/elevation";
import { geocodeToronto, Place } from "./lib/geocode";
import { loadRouteAlternatives, planAvailableRoute } from "./lib/routeStrategies";
import { RouteMode, RouteResult, RouteSegment } from "./lib/routing";
import {
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
  { value: "shortest", icon: RouteIcon, label: "Short", description: "Prioritizes a more direct walk." },
  { value: "accessible", icon: Activity, label: "Easy", description: "Prefers gentler terrain at a slower pace. Step-free access is unverified." },
  { value: "green", icon: Trees, label: "Green", description: "Prefers paths and adds a park waypoint when a nearby one fits." }
];

const EXAMPLE_WALK = {
  from: { label: "Toronto City Hall", point: { lat: 43.6534, lng: -79.3839 } },
  to: { label: "Union Station", point: { lat: 43.6453, lng: -79.3806 } }
} satisfies Record<"from" | "to", Place>;
const CITY_RESTRICTIONS_URL = "https://open.toronto.ca/dataset/road-restrictions/";

type PinTarget = "from" | "to";

type RouteState = {
  request: AbortController;
  alternatives: Partial<Record<RouteMode, RouteResult>>;
  elevations: Partial<Record<RouteMode, ElevationSummary>>;
  route: RouteResult;
  elevation: ElevationSummary | null;
  disruptionFeed: DisruptionFeed;
  loadingAlternatives: boolean;
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

  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  function clearWalk() {
    requestRef.current?.abort();
    requestRef.current = null;
    setRouteState(null);
    setBusy(false);
    setError(null);
  }

  async function planRoute(event?: FormEvent, example?: typeof EXAMPLE_WALK) {
    event?.preventDefault();
    clearWalk();
    const request = new AbortController();
    requestRef.current = request;
    setBusy(true);

    try {
      const [from, to] = example
        ? [example.from, example.to]
        : (await Promise.all([geocodeToronto(fromText), geocodeToronto(toText)])).map((matches) => matches[0]);
      if (request.signal.aborted) return;
      if (!from || !to) throw new Error("Both places must resolve inside Toronto.");
      const restrictions = fetchRoadRestrictionsWithStatus(request.signal);
      const primary = await planAvailableRoute(from.point, to.point, mode ?? "best", request.signal);
      if (request.signal.aborted) return;

      setMode(primary.mode);
      setDraftFromPoint(from.point);
      setDraftToPoint(to.point);
      setRouteState({
        request,
        alternatives: { [primary.mode]: primary.route },
        elevations: {},
        route: primary.route,
        elevation: null,
        disruptionFeed: { source: "loading", items: [] },
        loadingAlternatives: true
      });

      void restrictions.then((disruptionFeed) => {
        updateWalk(request, (current) => ({ ...current, disruptionFeed }));
      });
      void loadRouteAlternatives(from.point, to.point, primary.mode, request.signal, (label, route) => {
        updateWalk(request, (current) => ({
          ...current,
          alternatives: { ...current.alternatives, [label]: route }
        }));
      }).then(() => updateWalk(request, (current) => ({ ...current, loadingAlternatives: false })));
      void loadElevation(request, primary.mode, primary.route);
    } catch (caught) {
      if (!request.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Route planning failed.");
      }
    } finally {
      if (requestRef.current === request) setBusy(false);
    }
  }

  function updateWalk(request: AbortController, update: (current: RouteState) => RouteState) {
    if (request.signal.aborted) return;
    setRouteState((current) => current?.request === request ? update(current) : current);
  }

  async function loadElevation(request: AbortController, mode: RouteMode, route: RouteResult) {
    const elevation = await fetchElevation(route.path, request.signal);
    updateWalk(request, (current) => ({
      ...current,
      elevation: current.route === route ? elevation : current.elevation,
      elevations: { ...current.elevations, [mode]: elevation }
    }));
  }

  function selectMode(value: RouteMode) {
    setMode(value);
    const route = routeState?.alternatives[value];
    if (!route || !routeState) return;
    const cached = routeState.elevations[value];
    updateWalk(routeState.request, (current) => ({ ...current, route, elevation: cached ?? null }));
    if (!cached) void loadElevation(routeState.request, value, route);
  }

  function tryExample() {
    setFromText(EXAMPLE_WALK.from.label);
    setToText(EXAMPLE_WALK.to.label);
    setPinTarget(null);
    void planRoute(undefined, EXAMPLE_WALK);
  }

  function swapPlaces() {
    setFromText(toText);
    setToText(fromText);
    setDraftFromPoint(draftToPoint);
    setDraftToPoint(draftFromPoint);
    clearWalk();
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
    clearWalk();
  }

  function updateToText(value: string) {
    setToText(value);
    setDraftToPoint(null);
    clearWalk();
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
    clearWalk();
  }

  const restrictionsByMode = useMemo(() => {
    if (!routeState) return {};
    return Object.fromEntries(Object.entries(routeState.alternatives).map(([key, route]) => [
      key,
      nearbyRoadRestrictions(route.path, routeState.disruptionFeed.items)
    ]));
  }, [routeState?.alternatives, routeState?.disruptionFeed]);
  const nearby = mode ? restrictionsByMode[mode] ?? [] : [];
  const feed = routeState?.disruptionFeed;
  const fromPoint = draftFromPoint;
  const toPoint = draftToPoint;

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
          {nearby.slice(0, 30).map(({ item }) => item.polyline.length > 1 ? (
            <Polyline
              key={item.id}
              positions={item.polyline.map((point) => [point.lat, point.lng])}
              pathOptions={{ color: "#bb4f2e", weight: 5, dashArray: "5 7", opacity: 0.9 }}
            >
              <Tooltip>{item.road} · {item.impact}</Tooltip>
            </Polyline>
          ) : (
            <CircleMarker
              key={item.id}
              center={[item.point.lat, item.point.lng]}
              radius={6}
              pathOptions={{ color: "#d34a31", fillColor: "#ffb199", fillOpacity: 0.75, weight: 1.5 }}
            >
              <Tooltip>{item.road} · {item.impact}</Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </section>

      <aside className="control-panel">
        <div className="brand-row">
          <div>
            <p className="eyebrow">Toronto</p>
            <h1>Walkline</h1>
            <p className="title-help">Compare Toronto walking routes and see where City-reported road work may affect your walk.</p>
          </div>
        </div>

        <form className="route-form" onSubmit={planRoute}>
          <div className="form-actions">
            <button className="icon-button" type="button" onClick={swapPlaces} title="Swap" aria-label="Swap start and end">
              <ArrowRightLeft size={18} />
            </button>
            <button className="icon-button" type="button" onClick={() => planRoute()} disabled={busy} title="Refresh" aria-label="Refresh route">
              <RefreshCcw size={18} />
            </button>
          </div>

          <label>
            <span>From</span>
            <div className="input-row">
              <MapPin size={18} />
              <input aria-label="From" value={fromText} onChange={(event) => updateFromText(event.target.value)} />
              <button className="mini-button" type="button" onClick={useLocation} title="Use location" aria-label="Use my location">
                <LocateFixed size={16} />
              </button>
            </div>
          </label>

          <label>
            <span>To</span>
            <div className="input-row">
              <Navigation size={18} />
              <input aria-label="To" value={toText} onChange={(event) => updateToText(event.target.value)} />
            </div>
          </label>

          <div className="pin-row" aria-label="Map pin target">
            <button type="button" aria-pressed={pinTarget === "from"} className={pinTarget === "from" ? "pin-target active" : "pin-target"} onClick={() => setPinTarget("from")}>
              <MapPin size={15} />
              <span>Pin start</span>
            </button>
            <button type="button" aria-pressed={pinTarget === "to"} className={pinTarget === "to" ? "pin-target active" : "pin-target"} onClick={() => setPinTarget("to")}>
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
          <button type="button" className="example-walk" onClick={tryExample} disabled={busy}>
            Try City Hall to Union Station
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
            <Metric label="Up / down" value={!routeState.elevation ? "Loading" : routeState.elevation.ascent === null || routeState.elevation.descent === null ? "Unavailable" : `${Math.round(routeState.elevation.ascent)} / ${Math.round(routeState.elevation.descent)} m`} />
          </section>
        )}

        {routeState && (
          <>
            <section className="route-readout">
              <div className="route-title">
                <span>{selectedModeDetails(mode ?? "best").label} walk selected</span>
              </div>
              <p className="route-description">{selectedModeDetails(mode ?? "best").description}</p>
              {routeState.elevation ? <ElevationChart summary={routeState.elevation} /> : <p className="chart-empty">Loading elevation…</p>}
              <div className="signal-grid">
                <Signal label="Stairs" value={routeState.route.quality.stairMeters === null ? "Unknown" : formatDistance(routeState.route.quality.stairMeters)} />
                <Signal label="Reports within 90 m" value={feed?.source === "live" || feed?.source === "snapshot" ? String(nearby.length) : "Unknown"} />
                <Signal label="Grade estimate" value={!routeState.elevation ? "Loading" : routeState.elevation.maxGrade === null ? "Unavailable" : `${routeState.elevation.maxGrade.toFixed(1)}%`} />
                <Signal label="Reported rough path" value={formatDistance(routeState.route.quality.roughSurfaceMeters)} />
              </div>
              <p className="route-description" role="status">{roadFeedLabel(routeState.disruptionFeed)}</p>
              {nearby.length > 0 && (
                <ul className="restriction-list" aria-label="Nearby City road restrictions">
                  {nearby.slice(0, 5).map(({ item, meters }) => (
                    <li key={item.id}>
                      <a href={item.url ?? CITY_RESTRICTIONS_URL} target="_blank" rel="noreferrer">{item.road}</a>
                      <span>{item.impact} impact · {meters < 5 ? "Crosses or touches the route" : `${formatDistance(meters)} from route`}</span>
                    </li>
                  ))}
                </ul>
              )}
              <details className="walk-details">
                <summary>Compare routes</summary>
                <ul className="restriction-list" aria-label="Route comparison">
                  {ROUTE_MODES.map(({ value, label }) => {
                    const option = routeState.alternatives[value];
                    const count = restrictionsByMode[value]?.length ?? 0;
                    const known = feed?.source === "live" || feed?.source === "snapshot";
                    return (
                      <li key={value}>
                        <strong>{label}</strong>
                        <span>{option ? `${formatMinutes(option.seconds)} · ${formatDistance(option.distance)}${known ? ` · ${count} nearby reports` : ""}` : routeState.loadingAlternatives ? "Loading…" : "Unavailable"}</span>
                      </li>
                    );
                  })}
                </ul>
              </details>
              <details className="walk-details">
                <summary>Walking directions</summary>
                <ol className="direction-list">
                  {routeState.route.steps.map((step, index) => (
                    <li key={index}>{step.label}{step.distance > 0 && ` · ${formatDistance(step.distance)}`}</li>
                  ))}
                </ol>
              </details>
              <p className="route-description">Road restrictions may affect vehicles only. Check signs for pedestrian access.</p>
              <p className="route-description"><a href={CITY_RESTRICTIONS_URL} target="_blank" rel="noreferrer">City of Toronto open data</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> · <a href="https://www.opentopodata.org/" target="_blank" rel="noreferrer">SRTM elevation</a></p>
            </section>

          </>
        )}

      </aside>
    </main>
  );
}

function roadFeedLabel(feed: DisruptionFeed) {
  if (feed.source === "loading") return "Checking City road restrictions…";
  if (feed.source === "live") return "Road restrictions from the live City of Toronto feed.";
  if (feed.source === "unavailable") return "Current road restrictions are unavailable.";
  const date = feed.updatedAt && new Date(feed.updatedAt).toLocaleString("en-CA", {
    timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short"
  });
  return date
    ? `Saved City snapshot from ${date} Toronto time. Current conditions may have changed.`
    : "Saved City snapshot, date unknown. Current conditions may have changed.";
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
  useEffect(() => {
    if (points.length < 2) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lng]));
    const frame = requestAnimationFrame(() => map.fitBounds(bounds, { padding: [56, 56] }));
    return () => cancelAnimationFrame(frame);
  }, [map, points]);
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
