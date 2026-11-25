import type { OutdatedFinding } from "./verdict.js";

/** Where a candidate is locked as a direct runtime dependency. */
export type CandidateLocation = { lockfile: string; members: string[] };

/** One upgrade the check may buy a "what changed from A to B" answer for (FR-007). */
export type ExplanationCandidate = {
  name: string;
  from: string;
  /** The latest stable release at run time, recorded in the report. */
  to: string;
  gap: "major" | "minor";
  key: boolean;
  question: string;
  locations: CandidateLocation[];
};

/** An outdated direct dependency that is not explained, with the reason shown in the report. */
export type SkippedUpgrade = { name: string; from: string; to: string; reason: string };

export type CandidateSelection = { candidates: ExplanationCandidate[]; skipped: SkippedUpgrade[] };

/** The question asked of the miner; the same wording as the PR Agent's migration prompt. */
export const migrationQuestion = (name: string, from: string, to: string): string =>
  `What changed in ${name} from ${from} to ${to}?`;

const GAP_ORDER = ["major", "minor", "patch"] as const;

/**
 * Picks the upgrades to explain: outdated direct runtime dependencies with a minor or major gap (a minor on 0.x is
 * already a major gap), one per package and version pair, ranked key packages first, then larger gap, then name and
 * version. At most `maxPurchases`; every other outdated direct dependency is listed as skipped with the reason.
 * Transitive dependencies never reach this point: `Assessment.outdated` holds direct dependencies only.
 */
export const selectCandidates = (outdated: OutdatedFinding[], maxPurchases: number): CandidateSelection => {
  if (!Number.isInteger(maxPurchases) || maxPurchases < 0)
    throw new Error(`max-purchases must be a whole number of 0 or more, got ${maxPurchases}`);

  const eligible = new Map<string, ExplanationCandidate>();
  const skipped = new Map<string, SkippedUpgrade>();
  for (const finding of outdated) {
    const { name, version: from, lockfile } = finding.package;
    const pair = `${name}@${from}->${finding.latest}`;
    // Direct and runtime in the same member: a package that is direct only as a dev dependency is not eligible,
    // even if another member reaches it transitively at runtime.
    const members = finding.package.usages.filter((usage) => usage.direct && usage.runtime).map((usage) => usage.member);
    const reason =
      finding.gap === "patch"
        ? "patch release only: listed, not explained"
        : members.length === 0
          ? "not a direct runtime dependency: not explained automatically"
          : undefined;
    if (reason) {
      if (!eligible.has(pair) && !skipped.has(pair)) skipped.set(pair, { name, from, to: finding.latest, reason });
      continue;
    }
    // Eligible in one lockfile wins over a skip of the same pair elsewhere.
    skipped.delete(pair);
    const existing = eligible.get(pair);
    if (existing) {
      existing.locations.push({ lockfile, members });
      continue;
    }
    eligible.set(pair, {
      name,
      from,
      to: finding.latest,
      gap: finding.gap as "major" | "minor",
      key: finding.key,
      question: migrationQuestion(name, from, finding.latest),
      locations: [{ lockfile, members }],
    });
  }

  const ranked = [...eligible.values()].sort(
    (a, b) =>
      Number(b.key) - Number(a.key) ||
      GAP_ORDER.indexOf(a.gap) - GAP_ORDER.indexOf(b.gap) ||
      a.name.localeCompare(b.name) ||
      a.from.localeCompare(b.from),
  );
  const candidates = ranked.slice(0, maxPurchases);
  const overLimit = ranked.slice(maxPurchases).map(({ name, from, to }) => ({
    name,
    from,
    to,
    reason: `over the limit of ${maxPurchases} ${maxPurchases === 1 ? "purchase" : "purchases"} per run`,
  }));
  return { candidates, skipped: [...overLimit, ...skipped.values()] };
};
