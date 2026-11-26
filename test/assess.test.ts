import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { discover } from "../src/lockfiles.js";
import { checkAdvisories, type Fetcher } from "../src/osv.js";
import { upgradeGap } from "../src/registry.js";
import { renderReport } from "../src/report.js";
import { DEFAULT_KEY_PACKAGES, decide } from "../src/verdict.js";
import { FIXTURES, loadRecording, replayFetcher, tarball, writeTree, type RegistryStub } from "./helpers.js";

const controlled = loadRecording("controlled/osv.json");
// The compromised versions were removed from npm; the stub registry lists what is published (as of the recording).
const web3Registry: RegistryStub = {
  "@solana/web3.js": { latest: "1.95.8", versions: ["1.95.4", "1.95.5", "1.95.8"] },
};
const run = (directory: string, fetcher: Fetcher = replayFetcher(controlled, web3Registry)) =>
  assess(join(FIXTURES, directory), DEFAULT_KEY_PACKAGES, fetcher);

const offline: Fetcher = async () => {
  throw new Error("getaddrinfo ENOTFOUND api.osv.dev");
};

describe("compromised @solana/web3.js (controlled, historical)", () => {
  for (const version of ["1.95.6", "1.95.7"])
    it(`${version} is blocked as malicious, fixed in 1.95.8, removed from the registry`, async () => {
      const assessment = await run(`controlled/compromised-web3js-${version}`);
      expect(assessment.verdict).toBe("blocked");
      expect(assessment.coverage).toBe("complete");
      expect(assessment.advisories).toHaveLength(1);
      const [finding] = assessment.advisories;
      expect(finding).toMatchObject({ tier: "malicious", malicious: true, key: true, fixedIn: "1.95.8", removedFromRegistry: true });
      expect(finding.groups.flatMap((group) => group.ids)).toEqual(
        expect.arrayContaining(["MAL-2024-11183", "GHSA-jcxm-7wvp-g6p5"]),
      );
    });

  it("1.95.8 has no malware finding and, when current, is ready", async () => {
    const assessment = await run("controlled/clean-web3js-1.95.8");
    expect(assessment.advisories).toEqual([]);
    expect(assessment.verdict).toBe("ready");
    expect(assessment.coverage).toBe("complete");
  });

  it("the report says blocked, names the advisory and the fix, and carries the historical label", async () => {
    const assessment = await run("controlled/compromised-web3js-1.95.6");
    const report = renderReport(assessment, {
      path: ".",
      ranAt: new Date("2026-11-25T00:00:00Z"),
      keyPackages: DEFAULT_KEY_PACKAGES,
      caseLabel: "Controlled test case: historical incident (December 2024)",
    });
    expect(report).toContain("BLOCKED");
    expect(report).toContain("> **Controlled test case: historical incident (December 2024)**");
    expect(report).toContain("MAL-2024-11183");
    expect(report).toContain("`1.95.8`");
    expect(report).toContain("version removed from the npm registry");
    expect(report).toContain("not a security audit");
  });
});

describe("partial and failed coverage are never an empty clean report", () => {
  it("a malformed lockfile alone: coverage failed, verdict not ready, reason shown", async () => {
    const assessment = await run("controlled/malformed");
    expect(assessment.coverage).toBe("failed");
    expect(assessment.verdict).toBe("review");
    const report = renderReport(assessment, { path: ".", ranAt: new Date(), keyPackages: DEFAULT_KEY_PACKAGES });
    expect(report).toContain("coverage: **failed**");
    expect(report).toContain("could not parse");
  });

  it("an OSV outage: every package not checked, coverage failed, verdict review", async () => {
    const assessment = await run("controlled/clean-web3js-1.95.8", offline);
    expect(assessment.coverage).toBe("failed");
    expect(assessment.verdict).toBe("review");
    expect(assessment.notChecked).toEqual([expect.objectContaining({ name: "@solana/web3.js", runtime: true })]);
  });

  it("unsupported lockfiles next to a supported one make coverage partial and are listed", async () => {
    const root = writeTree({
      "package.json": { dependencies: { "@solana/web3.js": "1.95.8" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@solana/web3.js": "1.95.8" } },
          "node_modules/@solana/web3.js": { version: "1.95.8", resolved: tarball("@solana/web3.js", "1.95.8") },
        },
      },
      "web/bun.lock": "{}",
      "programs/Cargo.lock": "",
    });
    const assessment = await assess(root, DEFAULT_KEY_PACKAGES, replayFetcher(controlled, web3Registry));
    expect(assessment.verdict).toBe("ready");
    expect(assessment.coverage).toBe("partial");
    const report = renderReport(assessment, { path: ".", ranAt: new Date(), keyPackages: DEFAULT_KEY_PACKAGES });
    expect(report).toContain("`web/bun.lock`: Bun lockfiles are not assessed");
    expect(report).toContain("`programs/Cargo.lock`: Rust, not assessed");
  });

  it("not assessed and not checked are separate lists, totals and report sections (T034, FR-017)", async () => {
    const root = writeTree({
      "package.json": { dependencies: { "@solana/web3.js": "1.95.8", safe: "github:someone/safe#main" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "@solana/web3.js": "1.95.8", safe: "github:someone/safe#main" } },
          "node_modules/@solana/web3.js": { version: "1.95.8", resolved: tarball("@solana/web3.js", "1.95.8") },
          "node_modules/safe": { version: "1.0.0", resolved: "git+ssh://git@github.com/someone/safe.git#0123456789abcdef" },
        },
      },
    });
    const render = (assessment: Awaited<ReturnType<typeof assess>>) =>
      renderReport(assessment, { path: ".", ranAt: new Date(), keyPackages: DEFAULT_KEY_PACKAGES });

    // A Git dependency is outside the check: not assessed, and a rerun won't change that.
    const answered = await assess(root, DEFAULT_KEY_PACKAGES, replayFetcher(controlled, web3Registry));
    expect(answered.notChecked).toEqual([]);
    expect(answered.notAssessed).toEqual([expect.objectContaining({ name: "safe", runtime: true, reason: "Git dependency" })]);
    expect(answered.verdict).toBe("review");
    expect(answered.verdictReasons.review).toContain("1 runtime dependency not assessed (Git, local path or unverifiable source)");
    expect(answered.coverage).toBe("partial");
    const answeredReport = render(answered);
    expect(answeredReport).toContain("| Not assessed (outside this check's scope) | 1 |");
    expect(answeredReport).toContain("| Not checked (a lookup failed) | 0 |");
    expect(answeredReport).toContain("<summary>Not assessed (1): outside what this check covers</summary>");
    expect(answeredReport).toMatch(/- `safe` in `package-lock\.json` \(runtime\): Git dependency, `git\+ssh:/);
    expect(answeredReport).not.toContain("<summary>Not checked");

    // OSV down: the registry package is not checked (a rerun may complete it); the Git one is still not assessed.
    const outage = await assess(root, DEFAULT_KEY_PACKAGES, offline);
    expect(outage.notChecked).toEqual([expect.objectContaining({ name: "@solana/web3.js", version: "1.95.8", runtime: true })]);
    expect(outage.notAssessed).toHaveLength(1);
    expect(outage.verdictReasons.review).toEqual(
      expect.arrayContaining(["1 runtime dependency could not be checked", "1 runtime dependency not assessed (Git, local path or unverifiable source)"]),
    );
    const outageReport = render(outage);
    // One package, both lookups failed: one line, counted once.
    expect(outageReport).toContain("| Not checked (a lookup failed) | 1 |");
    expect(outageReport).toContain("<summary>Not checked (1): a lookup failed; a rerun may complete it</summary>");
    expect(outageReport).toMatch(/- `@solana\/web3\.js@1\.95\.8` in `package-lock\.json` \(runtime\): .*; the latest release could not be looked up either/);
  });

  it("a lockfile source can't break out of its report line", async () => {
    const hostile = "git+ssh://x\n\n</details>\n\n![t](https://evil.example/x.png)";
    const root = writeTree({
      "package.json": { dependencies: { safe: "github:someone/safe#main" } },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: { "": { dependencies: { safe: "github:someone/safe#main" } }, "node_modules/safe": { version: "1.0.0", resolved: hostile } },
      },
    });
    const report = renderReport(await assess(root, DEFAULT_KEY_PACKAGES, replayFetcher(controlled, web3Registry)), {
      path: ".", ranAt: new Date(), keyPackages: DEFAULT_KEY_PACKAGES,
    });
    const line = report.split("\n").find((candidate) => candidate.startsWith("- `safe`"));
    expect(line).toContain("git+ssh://x &lt;/details> ![t]");
    expect(report.match(/<\/details>/g)).toHaveLength(report.match(/<details>/g)!.length);
  });

  it("advisory details that can't be retrieved: still malicious by id, coverage partial", async () => {
    const withoutRecords = replayFetcher({ hits: controlled.hits, vulns: {} }, web3Registry);
    const assessment = await run("controlled/compromised-web3js-1.95.6", withoutRecords);
    expect(assessment.verdict).toBe("blocked");
    expect(assessment.coverage).toBe("partial");
    expect(assessment.advisories[0].groups.every((group) => group.detailsMissing)).toBe(true);
  });
});

describe("real lockfiles against recorded OSV answers", () => {
  for (const [name, withAdvisories] of [
    ["wallet-adapter", 58],
    ["anchor-ts", 29],
    ["drift-sdk", 33],
  ] as const)
    it(`${name}: ${withAdvisories} locked versions with advisories, all checked`, async () => {
      const recording = loadRecording(`real/${name}/osv.json`);
      const packages = discover(join(FIXTURES, `real/${name}/files`)).lockfiles.flatMap((report) =>
        report.status === "assessed" ? report.packages : [],
      );
      const check = await checkAdvisories(replayFetcher(recording), packages);
      expect(check.notChecked.size).toBe(0);
      expect(check.detailsMissing).toEqual([]);
      expect([...check.advisories.values()].filter((groups) => groups.length > 0)).toHaveLength(withAdvisories);
    });

  // The verdicts of the free-mode runs (T018, T047): the blocking reasons come from advisories alone.
  for (const [name, verdict, blockedBy] of [
    ["wallet-adapter", "blocked", ["next@15.3.3"]],
    ["anchor-ts", "review", []],
    ["drift-sdk", "blocked", ["nanoid@3.3.4", "zod@4.0.17"]],
  ] as const)
    it(`${name}: ${verdict}${blockedBy.length ? ` by ${blockedBy.join(", ")}` : ""}`, async () => {
      const assessment = await assess(join(FIXTURES, `real/${name}/files`), DEFAULT_KEY_PACKAGES, replayFetcher(loadRecording(`real/${name}/osv.json`)));
      expect(assessment.verdict).toBe(verdict);
      const directRuntimeBlocking = assessment.advisories.filter(
        (finding) => finding.tier === "direct-runtime" && (finding.severity === "high" || finding.severity === "critical"),
      );
      expect(directRuntimeBlocking.map((finding) => `${finding.package.name}@${finding.package.version}`).sort()).toEqual([...blockedBy]);
    });

  it("drift sdk/: runtime findings rank before development-only ones", async () => {
    const assessment = await assess(
      join(FIXTURES, "real/drift-sdk/files"),
      DEFAULT_KEY_PACKAGES,
      replayFetcher(loadRecording("real/drift-sdk/osv.json")),
    );
    const tiers = assessment.advisories.map((finding) => finding.tier);
    expect(tiers.indexOf("dev")).toBeGreaterThan(tiers.lastIndexOf("transitive-runtime"));
    expect(assessment.coverage).toBe("partial"); // the stub registry knows no package
  });
});

describe("OSV client", () => {
  it("follows next_page_token and groups records that alias each other", async () => {
    const records: Record<string, object> = {
      "GHSA-aaaa": { id: "GHSA-aaaa", aliases: ["CVE-1"], summary: "one", database_specific: { severity: "LOW" } },
      "CVE-1": { id: "CVE-1", aliases: ["GHSA-aaaa"], summary: "one", database_specific: { severity: "CRITICAL" } },
      "GHSA-bbbb": {
        id: "GHSA-bbbb",
        summary: "two",
        affected: [{ package: { name: "x", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.0" }] }] }],
      },
    };
    const fetcher: Fetcher = async (url, init) => {
      if (url.endsWith("/querybatch")) {
        const query = JSON.parse(String(init?.body)).queries[0];
        const page = query.page_token
          ? { vulns: [{ id: "GHSA-bbbb" }] }
          : { vulns: [{ id: "GHSA-aaaa" }, { id: "CVE-1" }], next_page_token: "page-2" };
        return Response.json({ results: [page] });
      }
      return Response.json(records[decodeURIComponent(url.split("/").pop()!)]);
    };
    const check = await checkAdvisories(fetcher, [{ name: "x", version: "1.0.0" }]);
    const groups = check.advisories.get("x@1.0.0")!;
    expect(groups.map((group) => [group.ids, group.severity, group.fixedIn, group.severityDefaulted])).toEqual([
      [["CVE-1", "GHSA-aaaa"], "critical", undefined, false],
      [["GHSA-bbbb"], "moderate", "1.2.0", true],
    ]);
  });
});

describe("verdict rules", () => {
  const project = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}) =>
    writeTree({
      "package.json": { dependencies, devDependencies },
      "package-lock.json": {
        lockfileVersion: 3,
        packages: {
          "": { dependencies, devDependencies },
          ...Object.fromEntries(
            Object.entries({ ...dependencies, ...devDependencies }).map(([name, version]) => [
              `node_modules/${name}`,
              { version, resolved: tarball(name, version) },
            ]),
          ),
        },
      },
    });
  const advisory = (id: string, severity: string) => ({ id, summary: id, database_specific: { severity } });
  const recording = {
    hits: { "high-dep@1.0.0": ["GHSA-high"], "low-dep@1.0.0": ["GHSA-low"] },
    vulns: { "GHSA-high": advisory("GHSA-high", "HIGH"), "GHSA-low": advisory("GHSA-low", "LOW") },
  };
  const verdictOf = async (root: string, registry: RegistryStub = {}) =>
    (await assess(root, DEFAULT_KEY_PACKAGES, replayFetcher(recording, registry))).verdict;

  it("high advisory in a direct runtime dependency: blocked", async () => {
    expect(await verdictOf(project({ "high-dep": "1.0.0" }))).toBe("blocked");
  });
  it("lower advisory in a runtime dependency: review", async () => {
    expect(await verdictOf(project({ "low-dep": "1.0.0" }))).toBe("review");
  });
  it("advisories only in development dependencies: ready", async () => {
    expect(await verdictOf(project({}, { "high-dep": "1.0.0" }))).toBe("ready");
  });
  it("key package behind by a minor on 0.x: review; by a minor on 1.x: ready", async () => {
    const anchor = { "@coral-xyz/anchor": { latest: "0.32.1", versions: ["0.29.0", "0.32.1"] } };
    expect(await verdictOf(project({ "@coral-xyz/anchor": "0.29.0" }), anchor)).toBe("review");
    const web3 = { "@solana/web3.js": { latest: "1.98.4", versions: ["1.95.8", "1.98.4"] } };
    expect(await verdictOf(project({ "@solana/web3.js": "1.95.8" }), web3)).toBe("ready");
  });
  it("latest release unknown: review for a key package, coverage partial only for others", async () => {
    const key = await assess(project({ "@coral-xyz/anchor": "0.29.0" }), DEFAULT_KEY_PACKAGES, replayFetcher(recording, {}));
    expect(key.verdict).toBe("review");
    expect(key.verdictReasons.review).toContain("latest release unknown for key package: @coral-xyz/anchor");
    expect(key.coverageReasons).toContain("latest version unknown for 1 direct dependency");
    const other = await assess(project({ "plain-dep": "1.0.0" }), DEFAULT_KEY_PACKAGES, replayFetcher(recording, {}));
    expect(other.verdict).toBe("ready");
    expect(other.coverage).toBe("partial");
  });
  it("lock entries no member reaches: advisories listed but not in the verdict; a malicious one still blocks", async () => {
    const unreachable = (name: string, version: string) =>
      writeTree({
        "package.json": { dependencies: {} },
        "package-lock.json": {
          lockfileVersion: 3,
          packages: { "": {}, [`node_modules/${name}`]: { version, resolved: tarball(name, version) } },
        },
      });
    const lowOnly = await assess(unreachable("high-dep", "1.0.0"), DEFAULT_KEY_PACKAGES, replayFetcher(recording));
    expect(lowOnly.advisories.map((finding) => finding.tier)).toEqual(["unreachable"]);
    expect(lowOnly.verdict).toBe("ready");
    const malware = await assess(unreachable("@solana/web3.js", "1.95.6"), DEFAULT_KEY_PACKAGES, replayFetcher(controlled, web3Registry));
    expect(malware.verdict).toBe("blocked");
  });
  it("upgrade gaps", () => {
    expect(upgradeGap("0.29.0", "0.30.1")).toBe("major");
    expect(upgradeGap("1.95.8", "3.2.1")).toBe("major");
    expect(upgradeGap("1.95.8", "1.98.4")).toBe("minor");
    expect(upgradeGap("1.95.6", "1.95.8")).toBe("patch");
    expect(upgradeGap("2.0.0", "2.0.0")).toBe("none");
  });
  it("decide() with nothing found and nothing assessed is not ready", () => {
    const assessment = decide(
      { lockfiles: [], otherDependencyFiles: [], manifestsWithoutLockfile: [] },
      { advisories: new Map(), notChecked: new Map(), detailsMissing: [] },
      new Map(),
      DEFAULT_KEY_PACKAGES,
    );
    expect([assessment.verdict, assessment.coverage]).toEqual(["review", "failed"]);
  });
});
