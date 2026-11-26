import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Fetcher } from "../src/osv.js";

export const FIXTURES = join(import.meta.dirname, "fixtures");

type Recording = { hits: Record<string, string[]>; vulns: Record<string, unknown> };

export const loadRecording = (path: string): Recording => JSON.parse(readFileSync(join(FIXTURES, path), "utf8"));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Registry stub: name -> { latest, versions }; unknown names answer 404. */
export type RegistryStub = Record<string, { latest: string; versions: string[] }>;

/** Serves recorded OSV answers and a registry stub, offline. Any other URL fails the test. */
export const replayFetcher = (recording: Recording, registry: RegistryStub = {}): Fetcher => async (url, init) => {
  if (url === "https://api.osv.dev/v1/querybatch") {
    const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
    return json({
      results: queries.map((query) => {
        const ids = recording.hits[`${query.package.name}@${query.version}`];
        return ids ? { vulns: ids.map((id) => ({ id })) } : {};
      }),
    });
  }
  if (url.startsWith("https://api.osv.dev/v1/vulns/")) {
    const record = recording.vulns[decodeURIComponent(url.slice("https://api.osv.dev/v1/vulns/".length))];
    return record ? json(record) : json({ message: "not found" }, 404);
  }
  if (url.startsWith("https://registry.npmjs.org/")) {
    const name = decodeURIComponent(url.slice("https://registry.npmjs.org/".length).replace("%2f", "/"));
    const record = registry[name];
    return record
      ? json({ "dist-tags": { latest: record.latest }, versions: Object.fromEntries(record.versions.map((v) => [v, {}])) })
      : json({ error: "Not found" }, 404);
  }
  throw new Error(`Unexpected request in an offline test: ${url}`);
};

/** Writes files into a fresh temporary directory, returning its path. */
export const writeTree = (files: Record<string, string | object>): string => {
  const root = mkdtempSync(join(tmpdir(), "preflight-test-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
};

export const tarball = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
