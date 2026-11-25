import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { migrationQuestion, selectCandidates } from "../src/explain.js";
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
