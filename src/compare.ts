import type { Severity } from "./osv.js";
import type { Assessment, Coverage, Tier, Verdict } from "./verdict.js";

/**
 * Base/head comparison for a pull request (T030, FR-013, research R12). A finding is identified by workspace member,
 * package and advisory (any shared id: OSV aliases can be listed in a different order), or by member, package and
 * "outdated"; versions and dependency paths are context only. A base finding is `resolved` only when the head's
 * lockfile was assessed and the package's lookup completed; otherwise it is `unverified`, never resolved.
 */
export type FindingStatus = "new" | "open" | "unverified" | "resolved";

export type ComparedFinding = {
  kind: "advisory" | "outdated";
  /** Workspace member; for a lock entry no member reaches, "<lockfile> (unreachable)". */
  member: string;
  name: string;
  lockfile: string;
  /** Advisory ids (advisory findings). */
  ids: string[];
  baseVersion?: string;
  headVersion?: string;
  /** From the head when present there, else the base. */
  tier?: Tier;
  severity?: Severity;
  malicious: boolean;
  key: boolean;
  /** Outdated findings: the gap to the latest release (only a major gap on a key package affects the verdict). */
  gap?: "major" | "minor" | "patch";
  status: FindingStatus;
  /** Why a base finding couldn't be confirmed as resolved. */
  reason?: string;
};

export type Comparison = {
  base: { verdict: Verdict; coverage: Coverage };
  head: { verdict: Verdict; coverage: Coverage };
  findings: ComparedFinding[];
  counts: Record<FindingStatus, number>;
};

type Entry = Omit<ComparedFinding, "status" | "reason" | "baseVersion" | "headVersion"> & { version: string };

const entries = (assessment: Assessment): Entry[] => {
  const list: Entry[] = [];
  for (const finding of assessment.advisories) {
    const members = finding.package.usages.length
      ? finding.package.usages.map((usage) => usage.member)
      : [`${finding.package.lockfile} (unreachable)`];
    for (const member of members)
      for (const group of finding.groups)
        list.push({
          kind: "advisory",
          member,
          name: finding.package.name,
          lockfile: finding.package.lockfile,
          version: finding.package.version,
          ids: group.ids,
          tier: finding.tier,
          severity: group.malicious ? "critical" : group.severity,
          malicious: group.malicious,
          key: finding.key,
        });
  }
  for (const finding of assessment.outdated)
    for (const usage of finding.package.usages.filter((candidate) => candidate.direct))
      list.push({
        kind: "outdated",
        member: usage.member,
        name: finding.package.name,
        lockfile: finding.package.lockfile,
        version: finding.package.version,
        ids: [],
        malicious: false,
        key: finding.key,
        gap: finding.gap,
      });
  return list;
};

const sameFinding = (a: Entry, b: Entry): boolean =>
  a.kind === b.kind && a.member === b.member && a.name === b.name && (a.kind === "outdated" || a.ids.some((id) => b.ids.includes(id)));

/** Why the head can't confirm that a base finding is gone, or undefined when it can. */
const unverifiedReason = (entry: Entry, head: Assessment): string | undefined => {
  if (head.coverage === "failed") return "the head could not be assessed";
  const lockfile = head.discovery.lockfiles.find((report) => report.path === entry.lockfile);
  if (!lockfile) return `${entry.lockfile} is not in the head`;
  if (lockfile.status !== "assessed") return `${entry.lockfile} was not assessed on the head: ${lockfile.reason}`;
  // Moved to Git, a path, a URL or an unverifiable entry: gone from the findings because it wasn't looked up.
  const unassessed = head.notAssessed.find((item) => item.name === entry.name && item.lockfile === entry.lockfile);
  if (unassessed) return `${entry.name} is not assessed on the head: ${unassessed.reason}`;
  if (entry.kind === "advisory" && head.notChecked.some((item) => item.name === entry.name && item.lockfile === entry.lockfile))
    return `the advisory lookup for ${entry.name} did not complete on the head`;
  if (entry.kind === "outdated" && head.latestUnknown.includes(entry.name))
    return `the latest release of ${entry.name} could not be looked up on the head`;
  return undefined;
};

const STATUS_ORDER: FindingStatus[] = ["new", "open", "unverified", "resolved"];

export const compare = (base: Assessment, head: Assessment): Comparison => {
  const baseEntries = entries(base);
  const headEntries = entries(head);
  const findings: ComparedFinding[] = [];
  const matchedHead = new Set<Entry>();

  for (const entry of baseEntries) {
    const { version, ...fields } = entry;
    const match = headEntries.find((candidate) => sameFinding(entry, candidate));
    if (match) {
      matchedHead.add(match);
      // Open: the head's state is the current one (a key package may now be only a minor release behind).
      findings.push({ ...fields, tier: match.tier, severity: match.severity, gap: match.gap, key: match.key, malicious: match.malicious, ids: [...new Set([...match.ids, ...entry.ids])], baseVersion: version, headVersion: match.version, status: "open" });
      continue;
    }
    const reason = unverifiedReason(entry, head);
    findings.push({ ...fields, baseVersion: version, status: reason ? "unverified" : "resolved", ...(reason ? { reason } : {}) });
  }
  for (const entry of headEntries) {
    if (matchedHead.has(entry) || baseEntries.some((candidate) => sameFinding(candidate, entry))) continue;
    const { version, ...fields } = entry;
    findings.push({ ...fields, headVersion: version, status: "new" });
  }

  // One row per finding: several base entries can match one head entry (e.g. two groups sharing an alias).
  const unique = new Map<string, ComparedFinding>();
  for (const finding of findings) {
    const id = `${finding.status}|${finding.kind}|${finding.member}|${finding.name}|${[...finding.ids].sort().join(",")}`;
    if (!unique.has(id)) unique.set(id, finding);
  }
  const sorted = [...unique.values()].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      Number(b.malicious) - Number(a.malicious) ||
      Number(b.key) - Number(a.key) ||
      Number(a.kind === "outdated") - Number(b.kind === "outdated") ||
      a.name.localeCompare(b.name) ||
      a.member.localeCompare(b.member),
  );
  const counts = { new: 0, open: 0, unverified: 0, resolved: 0 };
  for (const finding of sorted) counts[finding.status]++;
  return {
    base: { verdict: base.verdict, coverage: base.coverage },
    head: { verdict: head.verdict, coverage: head.coverage },
    findings: sorted,
    counts,
  };
};
