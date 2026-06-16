# Toronto Route Finder Engine

Walking route planner for Toronto. Pick a start and end point, compare a few route styles on a map, and see distance, time, elevation, and any nearby road closures.

## How it works

The frontend is React + TypeScript with Vite. The map uses Leaflet and react-leaflet with OpenStreetMap tiles.

Address search runs through Nominatim and Photon, scoped to Toronto's bounding box so results stay in the city. You can also drop pins directly on the map.

Routing goes through Valhalla's public pedestrian API. Each mode tweaks costing options on the same engine:

- **Short** — straightest path
- **Best** — balanced default
- **Easy** — favors calmer geometry and gentler walking conditions
- **Green** — routes through parks and trail corridors when a reasonable detour exists

The green and easy modes pick candidate waypoints (parks, ravines, quieter corridors) and request routes through Valhalla with those as intermediate stops. The app keeps whichever option is meaningfully different from the shortest path.

Road disruption data comes from Toronto Open Data (`road-restrictions` package). A small script pulls the latest catalog and restriction records into `public/data/`. During routing, closures near the path get flagged on the map.

Elevation is sampled along the chosen route via OpenTopoData (SRTM) and summarized as ascent, descent, and max grade.

## Run locally

```bash
npm install
npm run dev
```

Refresh open data files:

```bash
npm run update:data
```

Build for production:

```bash
npm run build
```
