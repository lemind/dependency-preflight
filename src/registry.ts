import semver from "semver";
import type { Fetcher } from "./osv.js";

// The public npm registry, free. The abbreviated document (versions and dist-tags, no release dates) is enough here
// and is much smaller: @solana/web3.js is about 4.7 MB abbreviated against 12 MB in full.

export type RegistryRecord = {
  /** Latest stable release: dist-tags.latest, or the highest non-prerelease version when that tag is a prerelease. */
  latest?: string;
  versions: Set<string>;
};

export type RegistryLookup = Map<string, RegistryRecord | { error: string }>;

const REGISTRY = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 60_000;
const CONCURRENCY = 6;

const documentUrl = (name: string): string => `${REGISTRY}/${name.replace("/", "%2f")}`;

const latestStable = (tag: unknown, versions: string[]): string | undefined => {
  if (typeof tag === "string" && semver.valid(tag) && !semver.prerelease(tag)) return tag;
  return versions.filter((version) => semver.valid(version) && !semver.prerelease(version)).sort(semver.rcompare)[0];
};

const lookup = async (fetcher: Fetcher, name: string): Promise<RegistryRecord | { error: string }> => {
  try {
    const response = await fetcher(documentUrl(name), {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return { error: "not found on the npm registry" };
    if (!response.ok) return { error: `npm registry answered HTTP ${response.status}` };
    const document = (await response.json()) as { "dist-tags"?: { latest?: unknown }; versions?: Record<string, unknown> };
    const versions = Object.keys(document.versions ?? {});
    return { latest: latestStable(document["dist-tags"]?.latest, versions), versions: new Set(versions) };
  } catch (error) {
    return { error: `npm registry lookup failed: ${(error as Error).message}` };
  }
};

/** Fetches the registry record of each package name. Failures are kept per name, never thrown. */
export const lookupPackages = async (fetcher: Fetcher, names: string[]): Promise<RegistryLookup> => {
  const unique = [...new Set(names)].sort();
  const results: RegistryLookup = new Map();
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const name = unique[next++];
      results.set(name, await lookup(fetcher, name));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  return results;
};

export type UpgradeGap = "major" | "minor" | "patch" | "none";

/** How far the locked version is behind latest. A newer minor on 0.x is treated as major (breaking under semver). */
export const upgradeGap = (locked: string, latest: string): UpgradeGap => {
  if (!semver.valid(locked) || !semver.valid(latest) || !semver.gt(latest, locked)) return "none";
  if (semver.major(latest) > semver.major(locked)) return "major";
  if (semver.minor(latest) > semver.minor(locked)) return semver.major(locked) === 0 ? "major" : "minor";
  return "patch";
};
