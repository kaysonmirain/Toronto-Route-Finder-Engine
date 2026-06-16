export type SourceRecord = {
  name: string;
  role: string;
  url: string;
  freshness: string;
};

export const SOURCES: SourceRecord[] = [
  {
    name: "City of Toronto Pedestrian Network",
    role: "Official sidewalk/crosswalk-informed graph reference",
    url: "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/pedestrian-network",
    freshness: "As available; portal metadata showed 2026-02-20"
  },
  {
    name: "City of Toronto Road Restrictions",
    role: "Real-time closures, restrictions, work events",
    url: "https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json",
    freshness: "Real-time feed"
  },
  {
    name: "City of Toronto Cycling Network",
    role: "Multi-use trails and newest installed active-transportation corridors",
    url: "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/cycling-network",
    freshness: "Semi-annual; portal metadata showed 2026-06-01"
  },
  {
    name: "OpenStreetMap via Overpass",
    role: "Live footways, pedestrian streets, paths, stairs, sidewalks",
    url: "https://overpass-api.de/",
    freshness: "Community updated"
  },
  {
    name: "Nominatim",
    role: "Toronto-bounded place search",
    url: "https://nominatim.org/",
    freshness: "OpenStreetMap derived"
  },
  {
    name: "OpenTopoData SRTM",
    role: "Route elevation profile and grade estimates",
    url: "https://www.opentopodata.org/",
    freshness: "Public elevation model"
  }
];
