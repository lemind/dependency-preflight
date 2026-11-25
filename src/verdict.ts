import semver from "semver";
import type { Discovery, LockedPackage, NotAssessedDependency, Usage } from "./lockfiles.js";
import { packageKey, severityRank, type AdvisoryCheck, type AdvisoryGroup, type Severity } from "./osv.js";
import { upgradeGap, type RegistryLookup, type UpgradeGap } from "./registry.js";

export type Verdict = "blocked" | "review" | "ready";
export type Coverage = "complete" | "partial" | "failed";

/**
 * Ranking tiers, most urgent first. "unreachable": locked, but no workspace member's dependency graph reaches it
 * (e.g. an entry kept by "resolutions"); it is checked and listed, and only a malicious version affects the verdict.
 */
export type Tier = "malicious" | "direct-runtime" | "transitive-runtime" | "dev" | "unreachable";

export type AdvisoryFinding = {
  package: LockedPackage;
  groups: AdvisoryGroup[];
  tier: Tier;
  key: boolean;
  malicious: boolean;
  severity: Severity;
  /** Nearest version that resolves every advisory group, when each names a fix. */
  fixedIn?: string;
  /** The locked version is no longer published on the npm registry (undefined: not looked up). */
  removedFromRegistry?: boolean;
};

export type OutdatedFinding = {
  package: LockedPackage;
  key: boolean;
  runtime: boolean;
  latest: string;
  gap: Exclude<UpgradeGap, "none">;
};

/** A locked version whose advisory lookup did not complete (timeout, unavailable source): rerunning may fix it (FR-017). */
export type NotChecked = {
  name: string;
  version: string;
  lockfile: string;
  runtime: boolean;
  unreachable: boolean;
  reason: string;
};

/** A dependency outside what this check covers, or whose identity can't be verified: Git, local path, URL (FR-017). */
export type NotAssessed = {
  name: string;
  source: string;
  lockfile: string;
  runtime: boolean;
  unreachable: boolean;
  reason: string;
};

export type Assessment = {
  verdict: Verdict;
  coverage: Coverage;
  /** Why the verdict is not "ready", one line per rule that applied. */
  verdictReasons: { blocked: string[]; review: string[] };
  /** Why coverage is not "complete". */
  coverageReasons: string[];
  advisories: AdvisoryFinding[];
  outdated: OutdatedFinding[];
  notChecked: NotChecked[];
  notAssessed: NotAssessed[];
  /** Direct dependencies whose latest release could not be looked up (registry errors). */
  latestUnknown: string[];
  discovery: Discovery;
  lockedVersionCount: number;
};

export const DEFAULT_KEY_PACKAGES = ["@solana/*", "@coral-xyz/anchor"];

/** Key package patterns are exact names or "<scope>/*". */
export const isKeyPackage = (name: string, patterns: string[]): boolean =>
  patterns.some((pattern) => (pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern));

export const isRuntime = (usages: Usage[]): boolean => usages.some((usage) => usage.runtime);
export const isDirect = (usages: Usage[]): boolean => usages.some((usage) => usage.direct);
const isDirectRuntime = (usages: Usage[]): boolean => usages.some((usage) => usage.directRuntime);

const TIER_ORDER: Tier[] = ["malicious", "direct-runtime", "transitive-runtime", "dev", "unreachable"];

const tierOf = (malicious: boolean, usages: Usage[]): Tier =>
  malicious
    ? "malicious"
    : usages.length === 0
      ? "unreachable"
      : isDirectRuntime(usages)
        ? "direct-runtime"
        : isRuntime(usages)
          ? "transitive-runtime"
          : "dev";

const highestFix = (groups: AdvisoryGroup[]): string | undefined =>
  groups.every((group) => group.fixedIn) ? groups.map((group) => group.fixedIn!).sort(semver.rcompare)[0] : undefined;

export const rankAdvisories = (findings: AdvisoryFinding[]): AdvisoryFinding[] =>
  [...findings].sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
      Number(b.key) - Number(a.key) ||
      severityRank(b.severity) - severityRank(a.severity) ||
      a.package.name.localeCompare(b.package.name) ||
      semver.compare(a.package.version, b.package.version) ||
      a.package.lockfile.localeCompare(b.package.lockfile),
  );

const plural = (count: number, word: string, plural = `${word}s`) => `${count} ${count === 1 ? word : plural}`;

/** Applies the verdict rules (FR-004, FR-017) and the coverage rules (FR-004a) to the collected results. */
export const decide = (
  discovery: Discovery,
  advisoryCheck: AdvisoryCheck,
  registry: RegistryLookup,
  keyPackages: string[],
): Assessment => {
  const assessed = discovery.lockfiles.filter((report) => report.status === "assessed");
  const packages = assessed.flatMap((report) => report.packages);
  const unassessable: NotAssessedDependency[] = assessed.flatMap((report) => report.notAssessed);

  const advisories: AdvisoryFinding[] = [];
  const notChecked: NotChecked[] = [];
  for (const locked of packages) {
    const groups = advisoryCheck.advisories.get(packageKey(locked));
    const failure = advisoryCheck.notChecked.get(packageKey(locked));
    if (failure !== undefined || groups === undefined) {
      notChecked.push({
        name: locked.name,
        version: locked.version,
        lockfile: locked.lockfile,
        runtime: isRuntime(locked.usages),
        unreachable: locked.usages.length === 0,
        reason: failure ?? "advisory lookup did not return a result",
      });
      continue;
    }
    if (!groups.length) continue;
    const malicious = groups.some((group) => group.malicious);
    const record = registry.get(locked.name);
    advisories.push({
      package: locked,
      groups,
      tier: tierOf(malicious, locked.usages),
      key: isKeyPackage(locked.name, keyPackages),
      malicious,
      severity: groups.map((group) => group.severity).sort((a, b) => severityRank(b) - severityRank(a))[0],
      fixedIn: highestFix(groups),
      removedFromRegistry: record && "versions" in record ? !record.versions.has(locked.version) : undefined,
    });
  }
  const notAssessed: NotAssessed[] = unassessable.map((dependency) => ({
    name: dependency.name,
    source: dependency.source,
    lockfile: dependency.lockfile,
    runtime: isRuntime(dependency.usages),
    unreachable: dependency.usages.length === 0,
    reason: dependency.reason,
  }));

  const outdated: OutdatedFinding[] = [];
  const registryFailures: string[] = [];
  for (const locked of packages.filter((candidate) => isDirect(candidate.usages))) {
    const record = registry.get(locked.name);
    if (!record) continue;
    if ("error" in record) {
      registryFailures.push(`${locked.name}: ${record.error}`);
      continue;
    }
    if (!record.latest) continue;
    const gap = upgradeGap(locked.version, record.latest);
    if (gap === "none") continue;
    outdated.push({
      package: locked,
      key: isKeyPackage(locked.name, keyPackages),
      runtime: isRuntime(locked.usages),
      latest: record.latest,
      gap,
    });
  }
  outdated.sort(
    (a, b) =>
      Number(b.key) - Number(a.key) ||
      Number(b.runtime) - Number(a.runtime) ||
      ["major", "minor", "patch"].indexOf(a.gap) - ["major", "minor", "patch"].indexOf(b.gap) ||
      a.package.name.localeCompare(b.package.name),
  );

  // Verdict
  const blockedReasons: string[] = [];
  const malicious = advisories.filter((finding) => finding.malicious);
  if (malicious.length)
    blockedReasons.push(`${plural(malicious.length, "locked version")} known to be malicious: ${malicious.map((finding) => packageKey(finding.package)).join(", ")}`);
  const severeDirect = advisories.filter(
    (finding) => !finding.malicious && finding.tier === "direct-runtime" && severityRank(finding.severity) >= severityRank("high"),
  );
  if (severeDirect.length)
    blockedReasons.push(
      `high or critical advisory in ${plural(severeDirect.length, "direct runtime dependency", "direct runtime dependencies")}: ${severeDirect.map((finding) => packageKey(finding.package)).join(", ")}`,
    );
  const reviewReasons: string[] = [];
  const otherRuntime = advisories.filter(
    (finding) => (finding.tier === "direct-runtime" || finding.tier === "transitive-runtime") && !severeDirect.includes(finding),
  );
  if (otherRuntime.length) reviewReasons.push(`advisories in ${plural(otherRuntime.length, "runtime dependency version")}`);
  const uncheckedRuntime = notChecked.filter((item) => item.runtime);
  if (uncheckedRuntime.length) reviewReasons.push(`${plural(uncheckedRuntime.length, "runtime dependency", "runtime dependencies")} could not be checked`);
  const unassessedRuntime = notAssessed.filter((item) => item.runtime);
  if (unassessedRuntime.length)
    reviewReasons.push(`${plural(unassessedRuntime.length, "runtime dependency", "runtime dependencies")} not assessed (Git, local path or unverifiable source)`);
  const outdatedKey = outdated.filter((finding) => finding.key && finding.gap === "major");
  if (outdatedKey.length)
    reviewReasons.push(
      `outdated key ${outdatedKey.length === 1 ? "package" : "packages"}: ${outdatedKey.map((finding) => `${packageKey(finding.package)} (latest ${finding.latest})`).join(", ")}`,
    );

  // Coverage
  const coverageReasons: string[] = [];
  const checkedCount = packages.filter((locked) => advisoryCheck.advisories.has(packageKey(locked))).length;
  if (!assessed.length) coverageReasons.push("no supported npm lockfile could be assessed");
  else if (packages.length && checkedCount === 0) coverageReasons.push("the advisory database could not be reached for any package");
  const coverageFailed = coverageReasons.length > 0;
  // Nothing assessed is never "ready".
  if (coverageFailed && !blockedReasons.length) reviewReasons.unshift("nothing could be assessed (coverage failed)");
  const verdict: Verdict = blockedReasons.length ? "blocked" : reviewReasons.length ? "review" : "ready";
  for (const report of discovery.lockfiles)
    if (report.status !== "assessed") coverageReasons.push(`${report.path}: ${report.status === "failed" ? "failed, " : ""}${report.reason}`);
  for (const file of discovery.otherDependencyFiles) coverageReasons.push(`${file.path}: ${file.ecosystem} dependencies are not assessed`);
  if (discovery.manifestsWithoutLockfile.length)
    coverageReasons.push(`${plural(discovery.manifestsWithoutLockfile.length, "package.json", "package.json files")} without a lockfile: versions could not be pinned`);
  if (notChecked.length) coverageReasons.push(`${plural(notChecked.length, "package version")} not checked against advisories`);
  if (notAssessed.length) coverageReasons.push(`${plural(notAssessed.length, "dependency", "dependencies")} not assessed (Git, local path or unverifiable source)`);
  if (advisoryCheck.detailsMissing.length)
    coverageReasons.push(`${plural(advisoryCheck.detailsMissing.length, "advisory record")} could not be retrieved in full`);
  if (registryFailures.length) coverageReasons.push(`latest version unknown for ${plural(registryFailures.length, "direct dependency", "direct dependencies")}`);
  const coverage: Coverage = coverageFailed ? "failed" : coverageReasons.length ? "partial" : "complete";

  return {
    verdict,
    coverage,
    verdictReasons: { blocked: blockedReasons, review: reviewReasons },
    coverageReasons,
    advisories: rankAdvisories(advisories),
    outdated,
    notChecked,
    notAssessed,
    latestUnknown: [...new Set(registryFailures.map((failure) => failure.slice(0, failure.indexOf(": "))))],
    discovery,
    lockedVersionCount: new Set(packages.map(packageKey)).size,
  };
};
