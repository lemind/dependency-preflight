import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { MAX_ANSWER_CHARACTERS, migrationQuestion, readAnswer, selectCandidates, type ExplanationCandidate } from "../src/explain.js";
import type { LockedPackage, Usage } from "../src/lockfiles.js";
import { DEFAULT_KEY_PACKAGES, type OutdatedFinding } from "../src/verdict.js";
import { FIXTURES, loadRecording, replayFetcher } from "./helpers.js";

const finding = (
  name: string,
  version: string,
  latest: string,
  gap: OutdatedFinding["gap"],
  options: { key?: boolean; usages?: Usage[]; lockfile?: string } = {},
): OutdatedFinding => {
  const usages = options.usages ?? [{ member: ".", direct: true, runtime: true }];
  const lockedPackage: LockedPackage = { name, version, lockfile: options.lockfile ?? "package-lock.json", localNames: [], usages };
  return { package: lockedPackage, key: options.key ?? false, runtime: usages.some((usage) => usage.runtime), latest, gap };
};

describe("selectCandidates (T021, FR-007, FR-010)", () => {
  it("ranks key packages first, then larger gap, then name; asks the PR Agent's question", () => {
    const { candidates } = selectCandidates(
      [
        finding("zod", "3.22.0", "4.6.7", "major"),
        finding("bn.js", "5.1.0", "5.2.2", "minor"),
        finding("@solana/spl-token", "0.3.11", "0.4.14", "major", { key: true }),
        finding("@coral-xyz/anchor", "0.29.0", "0.32.1", "major", { key: true }),
        finding("axios", "1.6.0", "1.13.0", "minor"),
      ],
      10,
    );
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "@coral-xyz/anchor",
      "@solana/spl-token",
      "zod",
      "axios",
      "bn.js",
    ]);
    expect(candidates[0].question).toBe("What changed in @coral-xyz/anchor from 0.29.0 to 0.32.1?");
    expect(candidates[0].question).toBe(migrationQuestion("@coral-xyz/anchor", "0.29.0", "0.32.1"));
  });

  it("skips patch gaps and dependencies that are direct only for development, with the reason", () => {
    const { candidates, skipped } = selectCandidates(
      [
        finding("typescript", "5.4.0", "5.9.3", "minor", { usages: [{ member: ".", direct: true, runtime: false }] }),
        finding("@solana/kit", "8.6.0", "8.6.1", "patch", { key: true }),
        // Direct as a dev dependency in one member, reached at runtime only transitively in another: not eligible.
        finding("@solana/web3.js", "1.98.0", "3.2.1", "major", {
          key: true,
          usages: [
            { member: "tools", direct: true, runtime: false },
            { member: "app", direct: false, runtime: true },
          ],
        }),
      ],
      10,
    );
    expect(candidates).toEqual([]);
    expect(skipped).toEqual([
      { name: "typescript", from: "5.4.0", to: "5.9.3", reason: "not a direct runtime dependency: not explained automatically" },
      { name: "@solana/kit", from: "8.6.0", to: "8.6.1", reason: "patch release only: listed, not explained" },
      { name: "@solana/web3.js", from: "1.98.0", to: "3.2.1", reason: "not a direct runtime dependency: not explained automatically" },
    ]);
  });

  it("buys one answer per package and version pair, listing every lockfile and member that locks it", () => {
    const { candidates } = selectCandidates(
      [
        finding("@coral-xyz/anchor", "0.29.0", "0.32.1", "major", {
          key: true,
          lockfile: "sdk/yarn.lock",
          usages: [{ member: "sdk", direct: true, runtime: true }],
        }),
        finding("@coral-xyz/anchor", "0.29.0", "0.32.1", "major", {
          key: true,
          lockfile: "tests/yarn.lock",
          usages: [
            { member: "tests", direct: true, runtime: true },
            { member: "tests/dev", direct: true, runtime: false },
          ],
        }),
        finding("@coral-xyz/anchor", "0.30.1", "0.32.1", "major", { key: true, lockfile: "app/yarn.lock" }),
      ],
      10,
    );
    expect(candidates.map((candidate) => `${candidate.name}@${candidate.from}`)).toEqual([
      "@coral-xyz/anchor@0.29.0",
      "@coral-xyz/anchor@0.30.1",
    ]);
    expect(candidates[0].locations).toEqual([
      { lockfile: "sdk/yarn.lock", members: ["sdk"] },
      { lockfile: "tests/yarn.lock", members: ["tests"] },
    ]);
  });

  it("an eligible lock of a pair wins over a dev-only lock of the same pair elsewhere", () => {
    const { candidates, skipped } = selectCandidates(
      [
        finding("zod", "3.22.0", "4.6.7", "major", { lockfile: "a/package-lock.json", usages: [{ member: "a", direct: true, runtime: false }] }),
        finding("zod", "3.22.0", "4.6.7", "major", { lockfile: "b/package-lock.json" }),
      ],
      10,
    );
    expect(candidates).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it("stops at max-purchases and lists the rest as over the limit, deterministically", () => {
    const outdated = Array.from({ length: 12 }, (_, index) =>
      finding(`pkg-${String(index).padStart(2, "0")}`, "1.0.0", "2.0.0", "major"),
    );
    const first = selectCandidates(outdated, 10);
    const reversed = selectCandidates([...outdated].reverse(), 10);
    expect(first.candidates).toHaveLength(10);
    expect(first.candidates).toEqual(reversed.candidates);
    expect(first.skipped).toEqual([
      { name: "pkg-10", from: "1.0.0", to: "2.0.0", reason: "over the limit of 10 purchases per run" },
      { name: "pkg-11", from: "1.0.0", to: "2.0.0", reason: "over the limit of 10 purchases per run" },
    ]);
    expect(selectCandidates(outdated, 0).candidates).toEqual([]);
  });

  it("refuses a max-purchases that is not a whole number of 0 or more", () => {
    expect(() => selectCandidates([], -1)).toThrow(/max-purchases/);
    expect(() => selectCandidates([], 1.5)).toThrow(/max-purchases/);
  });

  it("drift sdk/ (real fixture): both locked @coral-xyz/anchor versions (one through the alias anchor-30), then @solana/web3.js", async () => {
    const assessment = await assess(
      join(FIXTURES, "real/drift-sdk/files"),
      DEFAULT_KEY_PACKAGES,
      replayFetcher(loadRecording("real/drift-sdk/osv.json"), {
        "@coral-xyz/anchor": { latest: "0.32.1", versions: ["0.29.0", "0.30.1", "0.32.1"] },
        "@solana/web3.js": { latest: "3.2.1", versions: ["1.98.0", "3.2.1"] },
      }),
    );
    const { candidates } = selectCandidates(assessment.outdated, 10);
    expect(candidates.slice(0, 3).map((candidate) => [candidate.name, candidate.from, candidate.to, candidate.gap])).toEqual([
      ["@coral-xyz/anchor", "0.29.0", "0.32.1", "major"],
      ["@coral-xyz/anchor", "0.30.1", "0.32.1", "major"],
      ["@solana/web3.js", "1.98.0", "3.2.1", "major"],
    ]);
    expect(candidates[0].locations).toEqual([{ lockfile: "sdk/yarn.lock", members: ["sdk"] }]);
  });
});

// Shape of miner 7314's migration answer, as in the PR Agent's tests (test/action-miner-assessment.test.ts).
const anchor: ExplanationCandidate = {
  name: "@coral-xyz/anchor",
  from: "0.29.0",
  to: "0.32.1",
  gap: "major",
  key: true,
  question: migrationQuestion("@coral-xyz/anchor", "0.29.0", "0.32.1"),
  locations: [{ lockfile: "sdk/yarn.lock", members: ["sdk"] }],
};
const change = (kind: string, version: string, text: string, overrides: Record<string, unknown> = {}) => ({
  kind, version, evidenceType: "documented", change: text, excerpt: `${text}.`, sourceId: "s1", migration: null, ...overrides,
});
const answer = () => ({
  outcome: "found",
  request: { ecosystem: "npm", package: "@coral-xyz/anchor", fromResolved: "0.29.0", toResolved: "0.32.1" },
  changes: [change("breaking", "0.30.0", "IDL format changed", { migration: "Regenerate the IDL with anchor 0.30." })],
  coverage: { complete: false },
  security: { status: "complete", advisories: [] as Record<string, unknown>[] },
  sources: [{ id: "s1", url: "https://github.com/coral-xyz/anchor/blob/master/CHANGELOG.md" }],
});

describe("readAnswer (T022, FR-008, research R10)", () => {
  it("shows a documented change with its migration, verbatim quote and source", () => {
    const explanation = readAnswer(answer(), anchor, "7314");
    expect(explanation).toEqual({
      name: "@coral-xyz/anchor", from: "0.29.0", to: "0.32.1", minerId: "7314", outcome: "found", coverageComplete: false,
      changes: [{
        kind: "breaking", version: "0.30.0", change: "IDL format changed", migration: "Regenerate the IDL with anchor 0.30.",
        quote: "IDL format changed.", sourceUrl: "https://github.com/coral-xyz/anchor/blob/master/CHANGELOG.md",
      }],
      introducedAdvisories: [],
    });
  });

  it("accepts the answer as a JSON string too, as the Engine may return it", () => {
    expect(readAnswer(JSON.stringify(answer()), anchor, "7314").outcome).toBe("found");
  });

  it("orders breaking, then deprecations, then security fixes, oldest version first", () => {
    const miner = answer();
    miner.changes = [
      change("security_fix", "0.30.1", "sec"), change("deprecation", "0.31.0", "dep"), change("breaking", "0.32.0", "b2"),
      change("breaking", "0.30.0", "b1"),
    ] as typeof miner.changes;
    expect(readAnswer(miner, anchor, "7314").changes.map((entry) => `${entry.kind}:${entry.version}`)).toEqual([
      "breaking:0.30.0", "breaking:0.32.0", "deprecation:0.31.0", "security_fix:0.30.1",
    ]);
  });

  it("drops changes that are inferred, unquoted or outside (from, to]; never shows them as guidance", () => {
    const miner = answer();
    miner.changes = [
      change("breaking", "0.30.0", "inferred", { evidenceType: "inferred" }),
      change("breaking", "0.30.0", "no quote", { excerpt: null }),
      change("breaking", "0.29.0", "already locked"),
      change("breaking", "0.33.0", "after the target"),
      change("breaking", "next", "not a version"),
    ] as typeof miner.changes;
    const explanation = readAnswer(miner, anchor, "7314");
    // Found with nothing shown: the report says no documented change with a quote came back, never "no changes".
    expect(explanation).toMatchObject({ outcome: "found", changes: [] });
  });

  it("states not_found as its own outcome", () => {
    expect(readAnswer({ ...answer(), outcome: "not_found", request: null, coverage: null, changes: [] }, anchor, "7314"))
      .toMatchObject({ outcome: "not_found", changes: [] });
  });

  it("keeps a vulnerability the miner says the target introduces, as a warning", () => {
    const miner = answer();
    miner.security.advisories = [{ id: "GHSA-xxxx-yyyy-zzzz", aliases: [], sourceId: "s1", fromAffected: "no",
      targetAffected: "yes", conclusion: "introduced_by_upgrade" }];
    expect(readAnswer(miner, anchor, "7314").introducedAdvisories).toEqual(["GHSA-xxxx-yyyy-zzzz"]);
  });

  it.each([
    ["another package", (miner: ReturnType<typeof answer>) => void (miner.request.package = "@coral-xyz/borsh"), /not @coral-xyz\/anchor/],
    ["another target version", (miner: ReturnType<typeof answer>) => void (miner.request.toResolved = "0.31.0"), /0.31.0, not/],
    ["a plain-HTTP source", (miner: ReturnType<typeof answer>) => void (miner.sources[0].url = "http://example.org/x"), /plain HTTPS/],
    ["a source with credentials", (miner: ReturnType<typeof answer>) => void (miner.sources[0].url = "https://user:pw@example.org/x"), /plain HTTPS/],
    ["a missing source", (miner: ReturnType<typeof answer>) => void (miner.sources = []), /missing/],
    ["an unknown outcome", (miner: ReturnType<typeof answer>) => void (miner.outcome = "temporarily_unavailable"), /expected format/],
    ["a found answer without coverage", (miner: ReturnType<typeof answer>) => void ((miner as { coverage: unknown }).coverage = null), /coverage/],
  ])("is unusable with %s, and says why", (_case, mutate, reason) => {
    const miner = answer();
    mutate(miner);
    const explanation = readAnswer(miner, anchor, "7314");
    expect(explanation.outcome).toBe("unusable");
    expect(explanation.changes).toEqual([]);
    expect(explanation.reason).toMatch(reason);
  });

  it("is unusable, without validating it, when an adversarial answer is oversized", () => {
    const miner = answer();
    miner.changes = Array.from({ length: 20_000 }, (_, index) => change("breaking", "0.30.0", `x${index}`.padEnd(60, "x")));
    const explanation = readAnswer(miner, anchor, "7314");
    expect(explanation.outcome).toBe("unusable");
    expect(explanation.reason).toMatch(/answer too large \(\d+ characters, limit 1000000\)/);
    expect(readAnswer("x".repeat(MAX_ANSWER_CHARACTERS + 1), anchor, "7314").reason).toMatch(/too large/);
  });

  it("is unusable when the answer is not JSON or is empty", () => {
    expect(readAnswer("<html>", anchor, "7314")).toMatchObject({ outcome: "unusable", reason: expect.stringMatching(/not JSON/) });
    expect(readAnswer(undefined, anchor, "7314")).toMatchObject({ outcome: "unusable", reason: expect.stringMatching(/expected format/) });
  });

  it("caps long texts so a single change cannot flood the report", () => {
    const miner = answer();
    miner.changes = [change("breaking", "0.30.0", "y".repeat(10_000))] as typeof miner.changes;
    const [shown] = readAnswer(miner, anchor, "7314").changes;
    expect(shown.change).toHaveLength(2000);
    expect(shown.quote).toHaveLength(2000);
  });
});
