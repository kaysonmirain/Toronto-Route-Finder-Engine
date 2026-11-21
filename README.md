# Toronto Route Finder Engine

Walkline is a Toronto walking planner that shows where City-reported road restrictions cross or come close to a route. Compare walking time, distance, and nearby reports before heading out. Use an address, coordinates, a map pin, or the City Hall to Union Station example.

## What the City data adds

The [City of Toronto Road Restrictions dataset](https://open.toronto.ca/dataset/road-restrictions/) supplies the restriction points, line shapes, reported impact, and active dates. Walkline measures the distance between both shapes along the walk and lists City reports within 90 metres for each route. A restriction near the route can affect vehicles only. The planner does not infer a sidewalk closure or certify step-free access.

The app labels the City feed as live, a dated saved snapshot, or unavailable. A saved snapshot can omit new restrictions. On a static host, run the data refresh before building so the fallback is current.

Contains information licensed under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/).

## Routes and elevation

Routing uses Valhalla's public pedestrian service and OpenStreetMap. The map, the first available walk, and turn directions work independently of optional comparisons and elevation. Short prioritizes a direct walk, Easy prefers lower hills at a slower pace, and Green adds a nearby park waypoint when it fits. Options may overlap. Addresses are sent to Photon or Nominatim when searched. Coordinates and map pins skip address search.

Elevation comes from the OpenTopoData SRTM terrain model. Grades are estimates over sampled terrain. Missing elevation and unverified stairs are labeled in the interface.

## Run and verify

```sh
npm ci
npm test
npm run dev
```

Use the built-in example to check a full walk and compare its directions and City reports without entering a personal address.

```sh
npm run update:data
npm run build
npm run preview
```

Serve the resulting `dist/` directory from an HTTPS static host. The build supports repository subpaths. Location is optional and requires browser permission.
