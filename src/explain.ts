import semver from "semver";
import { z } from "zod";
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

/** Change kinds in display order, the most consequential first. */
export const CHANGE_KINDS = ["breaking", "deprecation", "security_fix"] as const;

/** One change shown in the report: always with a verbatim quote and an HTTPS source (FR-008). */
export type ExplainedChange = {
  kind: (typeof CHANGE_KINDS)[number];
  version: string;
  change: string;
  migration: string | null;
  quote: string;
  sourceUrl: string;
};

/**
 * What the report shows for one candidate (data-model.md, Upgrade explanation). `found` may have no changes: the
 * report then says no documented change with a quote was returned, never "no changes". `unavailable` (no answer was
 * bought) is set by the caller; `unusable` means the answer failed validation and is never shown as guidance.
 */
export type Explanation = {
  name: string;
  from: string;
  to: string;
  minerId: string;
  outcome: "found" | "not_found" | "unavailable" | "unusable";
  /** Why an answer is unavailable or unusable. */
  reason?: string;
  /** The miner's own statement that its release coverage was complete (found only). */
  coverageComplete?: boolean;
  changes: ExplainedChange[];
  /** Advisories the miner reports the target version introduces: shown as a warning, never hidden. */
  introducedAdvisories: string[];
};

/** Answers larger than this are not validated at all (an oversized answer is unusable, not a memory problem). */
export const MAX_ANSWER_CHARACTERS = 1_000_000;
const MAX_CHANGES_SHOWN = 200;
const MAX_TEXT = 2000;

// The PR Agent's migration answer schema (bot/src/miner-assessment.ts, 25 Nov): the fields we read, as miner 7314
// returns them. Written against zod 3; it uses only APIs zod 4 keeps, so the patched zod 4.6.7 runs it directly.
const migrationAnswer = z.object({
  outcome: z.enum(["found", "not_found"]),
  request: z
    .object({
      ecosystem: z.literal("npm"),
      package: z.string(),
      fromResolved: z.string().nullable(),
      toResolved: z.string().nullable(),
    })
    .nullable(),
  changes: z.array(
    z.object({
      kind: z.enum(CHANGE_KINDS),
      version: z.string(),
      evidenceType: z.enum(["documented", "repository_evidence", "inferred"]),
      change: z.string().min(1),
      excerpt: z.string().min(1).nullable(),
      sourceId: z.string(),
      migration: z.string().nullable(),
    }),
  ),
  security: z.object({
    status: z.enum(["complete", "partial", "unavailable", "not_checked"]),
    advisories: z.array(
      z.object({
        id: z.string(),
        aliases: z.array(z.string()),
        sourceId: z.string(),
        fromAffected: z.enum(["yes", "no", "unknown"]),
        targetAffected: z.enum(["yes", "no", "unknown"]),
        conclusion: z.enum(["fixed_by_upgrade", "still_affected", "introduced_by_upgrade", "not_applicable", "unknown"]),
      }),
    ),
  }),
  coverage: z.object({ complete: z.boolean() }).nullable(),
  sources: z.array(z.object({ id: z.string(), url: z.string().url() })),
});

const safeSourceUrl = (url: string): boolean => {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && !parsed.username && !parsed.password;
};

/**
 * Validates a miner answer for one candidate (T022, research R10). The answer is untrusted input: it must name the
 * same package and versions, and only documented changes with a quote, a version inside (from, to] and an HTTPS
 * source without credentials are shown. Any other answer is `unusable`, with the reason; nothing is guessed.
 */
export const readAnswer = (answer: unknown, candidate: ExplanationCandidate, minerId: string): Explanation => {
  const base = { name: candidate.name, from: candidate.from, to: candidate.to, minerId, changes: [], introducedAdvisories: [] };
  const unusable = (reason: string): Explanation => ({ ...base, outcome: "unusable", reason });

  const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? null);
  if (text.length > MAX_ANSWER_CHARACTERS)
    return unusable(`answer too large (${text.length} characters, limit ${MAX_ANSWER_CHARACTERS})`);
  let json: unknown;
  try {
    json = typeof answer === "string" ? JSON.parse(answer) : answer;
  } catch (error) {
    return unusable(`answer is not JSON: ${String(error)}`.slice(0, 300));
  }
  const parsed = migrationAnswer.safeParse(json);
  if (!parsed.success)
    return unusable(
      `answer does not match the expected format: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`.slice(0, 300),
    );
  const migration = parsed.data;
  if (migration.outcome === "not_found") return { ...base, outcome: "not_found" };

  const request = migration.request;
  if (!request || !migration.coverage) return unusable("a found answer must name the versions and its coverage");
  if (request.package !== candidate.name || request.fromResolved !== candidate.from || request.toResolved !== candidate.to)
    return unusable(
      `answer is for ${request.package} ${request.fromResolved} → ${request.toResolved}, not ${candidate.name} ${candidate.from} → ${candidate.to}`.slice(0, 300),
    );

  const sources = new Map(migration.sources.map((source) => [source.id, source.url]));
  const shown = migration.changes.filter(
    (change) =>
      change.evidenceType === "documented" &&
      change.excerpt !== null &&
      change.excerpt.trim() !== "" &&
      semver.valid(change.version) !== null &&
      semver.gt(change.version, candidate.from) &&
      semver.lte(change.version, candidate.to),
  );
  for (const change of shown) {
    const url = sources.get(change.sourceId);
    if (!url || !safeSourceUrl(url))
      return unusable(`change in ${change.version} cites source "${change.sourceId}", which is missing or not a plain HTTPS link`.slice(0, 300));
  }
  const changes = shown
    .sort((a, b) => CHANGE_KINDS.indexOf(a.kind) - CHANGE_KINDS.indexOf(b.kind) || semver.compare(a.version, b.version))
    .slice(0, MAX_CHANGES_SHOWN)
    .map((change) => {
      const migrationStep = change.migration?.trim() || null;
      return {
        kind: change.kind,
        version: change.version,
        change: change.change.trim().slice(0, MAX_TEXT),
        migration: migrationStep ? migrationStep.slice(0, MAX_TEXT) : null,
        quote: change.excerpt!.trim().slice(0, MAX_TEXT),
        sourceUrl: sources.get(change.sourceId)!,
      };
    });
  const introducedAdvisories = migration.security.advisories
    .filter((advisory) => advisory.conclusion === "introduced_by_upgrade")
    .map((advisory) => advisory.id.slice(0, 100))
    .slice(0, 50);
  return { ...base, outcome: "found", coverageComplete: migration.coverage.complete, changes, introducedAdvisories };
};
