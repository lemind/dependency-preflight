import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { compare } from "../src/compare.js";
import type { LockedPackage, LockfileReport } from "../src/lockfiles.js";
import type { AdvisoryGroup } from "../src/osv.js";
import { DEFAULT_KEY_PACKAGES, type AdvisoryFinding, type Assessment, type NotChecked, type OutdatedFinding } from "../src/verdict.js";
import { FIXTURES, loadRecording, replayFetcher } from "./helpers.js";

const LOCKFILE = "sdk/yarn.lock";
const locked = (name: string, version: string): LockedPackage => ({
  name, version, lockfile: LOCKFILE, localNames: [], usages: [{ member: "sdk", direct: true, runtime: true, directRuntime: true }],
});
const group = (...ids: string[]): AdvisoryGroup => ({
  ids, summary: "x", severity: "high", severityDefaulted: false, malicious: ids.some((id) => id.startsWith("MAL-")), detailsMissing: false,
});
const advisory = (name: string, version: string, ...groups: AdvisoryGroup[]): AdvisoryFinding => ({
  package: locked(name, version), groups, tier: "direct-runtime", key: false, malicious: groups.some((g) => g.malicious), severity: "high",
});
const outdated = (name: string, version: string, latest: string): OutdatedFinding => ({ package: locked(name, version), key: true, runtime: true, latest, gap: "major" });
const assessedLockfile: LockfileReport = { status: "assessed", path: LOCKFILE, format: "yarn1", members: ["sdk"], packages: [], notAssessed: [] };

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  verdict: "review", coverage: "complete", verdictReasons: { blocked: [], review: [] }, coverageReasons: [],
  advisories: [], outdated: [], notChecked: [], latestUnknown: [], lockedVersionCount: 1,
  discovery: { lockfiles: [assessedLockfile], otherDependencyFiles: [], manifestsWithoutLockfile: [] },
  ...overrides,
});
const statuses = (base: Assessment, head: Assessment) =>
  compare(base, head).findings.map((finding) => `${finding.status} ${finding.kind} ${finding.name}${finding.reason ? ` (${finding.reason})` : ""}`);

describe("compare (T030, FR-013): the reviewer's four cases", () => {
  const base = assessment({ verdict: "blocked", advisories: [advisory("nanoid", "3.3.4", group("GHSA-mwcw-c2x4-8c55", "CVE-2024-55565"))] });

  it("advisory on base, absent on head with OSV answered: resolved", () => {
    expect(statuses(base, assessment())).toEqual(["resolved advisory nanoid"]);
  });

  it("advisory on base, head OSV lookup timed out for that package: unverified, not resolved", () => {
    const notChecked: NotChecked = { name: "nanoid", version: "3.3.8", lockfile: LOCKFILE, runtime: true, unreachable: false, reason: "OSV timeout" };
    expect(statuses(base, assessment({ coverage: "partial", notChecked: [notChecked] }))).toEqual([
      "unverified advisory nanoid (the advisory lookup for nanoid did not complete on the head)",
    ]);
  });

  it("advisory on base, head lockfile parser failed: unverified, not resolved", () => {
    const failed: LockfileReport = { status: "failed", path: LOCKFILE, format: "yarn1", reason: "unparseable: bad indentation" };
    expect(statuses(base, assessment({ coverage: "failed", discovery: { lockfiles: [failed], otherDependencyFiles: [], manifestsWithoutLockfile: [] } }))).toEqual([
      "unverified advisory nanoid (the head could not be assessed)",
    ]);
    // A second lockfile assessed keeps coverage partial; the failed one still can't resolve anything.
    const other: LockfileReport = { ...assessedLockfile, path: "app/yarn.lock" };
    expect(statuses(base, assessment({ coverage: "partial", discovery: { lockfiles: [failed, other], otherDependencyFiles: [], manifestsWithoutLockfile: [] } }))).toEqual([
      "unverified advisory nanoid (sdk/yarn.lock was not assessed on the head: unparseable: bad indentation)",
    ]);
  });

  it("no advisory on base, advisory on head: new", () => {
    expect(statuses(assessment(), base)).toEqual(["new advisory nanoid"]);
  });
});

describe("compare: identity", () => {
  it("the same advisory at a different version is still open; identity ignores versions and paths", () => {
    const base = assessment({ advisories: [advisory("zod", "4.0.17", group("GHSA-mrhx-c7xc-m3w5"))] });
    const head = assessment({ advisories: [advisory("zod", "4.6.5", group("GHSA-mrhx-c7xc-m3w5"))] });
    expect(compare(base, head).findings).toMatchObject([{ status: "open", name: "zod", baseVersion: "4.0.17", headVersion: "4.6.5" }]);
  });

  it("matches advisory groups by any shared id, in any order", () => {
    const base = assessment({ advisories: [advisory("nanoid", "3.3.4", group("GHSA-mwcw-c2x4-8c55", "CVE-2024-55565"))] });
    const head = assessment({ advisories: [advisory("nanoid", "3.3.4", group("CVE-2024-55565", "GHSA-mwcw-c2x4-8c55"))] });
    expect(compare(base, head).counts).toEqual({ new: 0, open: 1, unverified: 0, resolved: 0 });
  });

  it("a different advisory in the same package is resolved plus new, not open", () => {
    const base = assessment({ advisories: [advisory("next", "15.3.3", group("GHSA-aaaa-aaaa-aaaa"))] });
    const head = assessment({ advisories: [advisory("next", "15.4.0", group("GHSA-bbbb-bbbb-bbbb"))] });
    expect(statuses(base, head)).toEqual(["new advisory next", "resolved advisory next"]);
  });

  it("the same package in another workspace member is a different finding", () => {
    const base = assessment({ advisories: [advisory("zod", "4.0.17", group("GHSA-mrhx-c7xc-m3w5"))] });
    const elsewhere = advisory("zod", "4.0.17", group("GHSA-mrhx-c7xc-m3w5"));
    elsewhere.package.usages = [{ member: "app", direct: true, runtime: true, directRuntime: true }];
    expect(statuses(base, assessment({ advisories: [elsewhere] }))).toEqual(["new advisory zod", "resolved advisory zod"]);
  });

  it("outdated findings: member + package + outdated; resolved only when the latest release was looked up", () => {
    const base = assessment({ outdated: [outdated("@coral-xyz/anchor", "0.29.0", "0.32.1")] });
    expect(compare(base, assessment({ outdated: [outdated("@coral-xyz/anchor", "0.31.0", "0.32.1")] })).findings).toMatchObject([
      { status: "open", kind: "outdated", baseVersion: "0.29.0", headVersion: "0.31.0" },
    ]);
    expect(statuses(base, assessment())).toEqual(["resolved outdated @coral-xyz/anchor"]);
    expect(statuses(base, assessment({ latestUnknown: ["@coral-xyz/anchor"] }))).toEqual([
      "unverified outdated @coral-xyz/anchor (the latest release of @coral-xyz/anchor could not be looked up on the head)",
    ]);
  });

  it("a lockfile removed on the head can't resolve its findings", () => {
    const base = assessment({ advisories: [advisory("nanoid", "3.3.4", group("GHSA-mwcw-c2x4-8c55"))] });
    expect(statuses(base, assessment({ discovery: { lockfiles: [], otherDependencyFiles: [], manifestsWithoutLockfile: [] } }))).toEqual([
      "unverified advisory nanoid (sdk/yarn.lock is not in the head)",
    ]);
  });
});

describe("compare: controlled remediation (historical case, SC-006)", () => {
  it("web3.js 1.95.6 → 1.95.8: the malware finding is resolved and the verdict moves from blocked", async () => {
    const recording = loadRecording("controlled/osv.json");
    const registry = { "@solana/web3.js": { latest: "1.95.8", versions: ["1.95.5", "1.95.8"] } };
    const run = (directory: string) => assess(join(FIXTURES, directory), DEFAULT_KEY_PACKAGES, replayFetcher(recording, registry));
    const comparison = compare(await run("controlled/compromised-web3js-1.95.6"), await run("controlled/clean-web3js-1.95.8"));
    expect(comparison.base.verdict).toBe("blocked");
    expect(comparison.head.verdict).not.toBe("blocked");
    expect(comparison.findings.filter((finding) => finding.malicious)).toMatchObject([
      { status: "resolved", name: "@solana/web3.js", member: ".", baseVersion: "1.95.6", ids: expect.arrayContaining(["MAL-2024-11183"]) },
    ]);
    expect(comparison.counts.new).toBe(0);
  });
});
