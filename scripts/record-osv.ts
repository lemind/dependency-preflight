// Records live OSV answers for every package version locked in a fixture, so offline tests replay them.
// Free and read-only. Build and run (Node fetch needs NODE_USE_ENV_PROXY=1 behind a proxy):
//   npx esbuild scripts/record-osv.ts --bundle --platform=node --format=esm --outfile=<tmp>/record-osv.mjs \
//     --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
//   node <tmp>/record-osv.mjs <fixture files dir> <output osv.json>
import { writeFileSync } from "node:fs";
import { discover } from "../src/lockfiles.js";
import { checkAdvisories, type Fetcher } from "../src/osv.js";

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("Usage: record-osv <fixture files dir> <output osv.json>");

const packages = discover(root).lockfiles.flatMap((report) => (report.status === "assessed" ? report.packages : []));
const hits: Record<string, string[]> = {};
const vulns: Record<string, unknown> = {};

const recording: Fetcher = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) return response;
  const body = await response.clone().json();
  if (url.endsWith("/querybatch")) {
    const queries = JSON.parse(String(init?.body)).queries as { package: { name: string }; version: string }[];
    body.results.forEach((result: { vulns?: { id: string }[] }, index: number) => {
      const key = `${queries[index].package.name}@${queries[index].version}`;
      if (result.vulns?.length) hits[key] = [...(hits[key] ?? []), ...result.vulns.map((vuln) => vuln.id)];
    });
  } else vulns[decodeURIComponent(url.split("/").pop()!)] = body;
  return response;
};

const capturedAt = new Date().toISOString();
const check = await checkAdvisories(recording, packages);
if (check.notChecked.size || check.detailsMissing.length)
  throw new Error(`Incomplete recording: ${check.notChecked.size} not checked, ${check.detailsMissing.length} records missing`);
writeFileSync(
  output,
  `${JSON.stringify({ capturedAt, source: "https://api.osv.dev/v1", packageVersions: new Set(packages.map((item) => `${item.name}@${item.version}`)).size, hits, vulns }, null, 1)}\n`,
);
console.log(`${output}: ${Object.keys(hits).length} package versions with advisories, ${Object.keys(vulns).length} records`);
