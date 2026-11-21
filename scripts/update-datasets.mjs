import { mkdir, writeFile } from "node:fs/promises";

const outputDir = new URL("../public/data/", import.meta.url);

const packages = [
  "pedestrian-network",
  "road-restrictions",
  "cycling-network",
  "sidewalk-inventory",
  "traffic-signals-tabular",
  "traffic-signals"
];

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const repaired = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    return JSON.parse(repaired);
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const catalog = [];
  for (const id of packages) {
    try {
      const data = await fetchJson(`https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=${id}`);
      const result = data.result;
      catalog.push({
        name: result.title,
        id: result.name,
        excerpt: result.excerpt,
        refreshRate: result.refresh_rate,
        lastRefreshed: result.last_refreshed,
        formats: result.formats,
        resources: result.resources?.map((resource) => ({
          name: resource.name,
          format: resource.format,
          url: resource.url
        }))
      });
    } catch (error) {
      catalog.push({ id, error: error.message });
    }
  }

  const restrictions = await fetchJson("https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json");

  await writeFile(new URL("source-status.json", outputDir), JSON.stringify({ updatedAt: new Date().toISOString(), catalog }, null, 2));
  await writeFile(new URL("road-restrictions.json", outputDir), JSON.stringify(restrictions, null, 2));

  console.log(`Wrote ${catalog.length} source records and ${(restrictions.Closure ?? []).length} road restrictions.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
