import type { LockedPackage } from "./lockfiles.js";
import type { AdvisoryGroup } from "./osv.js";
import type { AdvisoryFinding, Assessment, OutdatedFinding, Tier } from "./verdict.js";

export type ReportContext = {
  /** Assessed directory, relative to the repository. */
  path: string;
  repository?: string;
  commit?: string;
  ranAt: Date;
  keyPackages: string[];
  /** Shown at the top, e.g. "Controlled test case: historical incident (December 2024)". */
  caseLabel?: string;
};

const MAX_ROWS = 50;
const MAX_MEMBERS = 3;

const VERDICT_LABEL = {
  blocked: "🛑 **BLOCKED**",
  review: "⚠️ **REVIEW**",
  ready: "✅ **READY** (npm dependencies assessed)",
};

const TIER_HEADING: Record<Tier, string> = {
  malicious: "Malicious versions",
  "direct-runtime": "Advisories in direct runtime dependencies",
  "transitive-runtime": "Advisories in transitive runtime dependencies",
  dev: "Advisories in development-only dependencies",
  unreachable: "Advisories in lock entries no workspace member reaches",
};

/** Escapes text from lockfiles and advisories for a Markdown table cell. */
const cell = (text: string): string => text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").replace(/</g, "&lt;");

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

const advisoryLink = (id: string): string => `[${id}](https://osv.dev/vulnerability/${encodeURIComponent(id)})`;

const where = (locked: LockedPackage, runtimeOnly: boolean): string => {
  const usages = locked.usages.filter((usage) => !runtimeOnly || usage.runtime);
  const members = usages.map((usage) => `${code(usage.member)}${usage.direct ? " (direct)" : ""}`);
  const shown = members.slice(0, MAX_MEMBERS).join(", ") || "no member depends on it";
  return `${code(locked.lockfile)} · ${shown}${members.length > MAX_MEMBERS ? `, +${members.length - MAX_MEMBERS} more` : ""}`;
};

const describeGroup = (group: AdvisoryGroup): string => {
  const [primary, ...others] = group.ids;
  const severity = group.malicious ? "malicious" : `${group.severity}${group.severityDefaulted ? " (no severity given)" : ""}`;
  const published = group.published ? `, published ${group.published.slice(0, 10)}` : "";
  const aliases = others.length ? ` (also ${others.map(advisoryLink).join(", ")})` : "";
  const missing = group.detailsMissing ? " — full record not retrieved" : "";
  return `${advisoryLink(primary)}${aliases}: ${severity}${published}. ${cell(group.summary)}${missing}`;
};

const packageName = (finding: { package: LockedPackage; key: boolean }): string => {
  const aliases = finding.package.localNames.map((local) => `${code(local.name)} ${local.kind === "alias" ? "alias" : "override"}`);
  return `${finding.key ? "🔑 " : ""}${code(finding.package.name)}${aliases.length ? ` (installed as ${aliases.join(", ")})` : ""}`;
};

const advisoryRow = (finding: AdvisoryFinding): string => {
  const notes: string[] = [];
  if (finding.removedFromRegistry) notes.push("version removed from the npm registry");
  return `| ${packageName(finding)} | ${code(finding.package.version)} | ${where(finding.package, finding.tier !== "dev" && finding.tier !== "unreachable")} | ${finding.groups.map(describeGroup).join("<br>")} | ${finding.fixedIn ? code(finding.fixedIn) : "no fixed version listed"} | ${notes.join("; ") || ""} |`;
};

const advisoryTable = (findings: AdvisoryFinding[]): string[] => [
  "| Package | Locked | Where (lockfile · workspace member) | Advisory | Fixed in | Notes |",
  "| --- | --- | --- | --- | --- | --- |",
  ...findings.slice(0, MAX_ROWS).map(advisoryRow),
  ...(findings.length > MAX_ROWS ? [`| … ${findings.length - MAX_ROWS} more | | | | | |`] : []),
];

const outdatedRow = (finding: OutdatedFinding): string =>
  `| ${packageName(finding)} | ${code(finding.package.version)} | ${code(finding.latest)} | ${finding.gap === "major" && finding.package.version.startsWith("0.") ? "major (minor on 0.x)" : finding.gap} | ${finding.runtime ? "runtime" : "dev"} | ${where(finding.package, false)} | [release notes](https://www.npmjs.com/package/${finding.package.name}?activeTab=versions) |`;

/** Renders the assessment as one Markdown report: verdict and coverage first, then the findings in ranked order. */
export const renderReport = (assessment: Assessment, context: ReportContext): string => {
  const lines: string[] = [];
  const { discovery } = assessment;
  lines.push(`## dependency-preflight: ${VERDICT_LABEL[assessment.verdict]} · coverage: **${assessment.coverage}**`, "");
  if (context.caseLabel) lines.push(`> **${cell(context.caseLabel)}**`, "");
  const target = [context.repository, context.commit ? `at ${code(context.commit.slice(0, 12))}` : undefined].filter(Boolean).join(" ");
  lines.push(
    `Assessed ${code(context.path)}${target ? ` in ${target}` : ""} on ${context.ranAt.toISOString().replace(/\.\d+Z$/, "Z")}. ` +
      "This is an npm dependency assessment (known advisories, malicious versions, outdated key packages), " +
      "not a security audit: only lockfiles and manifests were read; no source code was read, built, tested or run.",
    "",
  );

  const assessedLockfiles = discovery.lockfiles.filter((report) => report.status === "assessed");
  const maliciousCount = assessment.advisories.filter((finding) => finding.malicious).length;
  lines.push(
    "| | |",
    "| --- | --- |",
    `| Lockfiles assessed | ${assessedLockfiles.map((report) => `${code(report.path)} (${report.format}, ${report.members.length} ${report.members.length === 1 ? "member" : "members"})`).join(", ") || "none"} |`,
    `| Locked package versions | ${assessment.lockedVersionCount} |`,
    `| With advisories | ${assessment.advisories.length} (${maliciousCount} malicious) |`,
    `| Not checked or not assessed | ${assessment.notChecked.length} |`,
    "",
  );

  const { blocked, review } = assessment.verdictReasons;
  if (blocked.length) lines.push("### Why blocked", "", ...blocked.map((reason) => `- ${cell(reason)}`), "");
  if (review.length)
    lines.push(blocked.length ? "### Also needs review" : "### Why review", "", ...review.map((reason) => `- ${cell(reason)}`), "");
  if (assessment.coverageReasons.length) {
    lines.push(`### Why coverage is ${assessment.coverage}`, "", ...assessment.coverageReasons.map((reason) => `- ${cell(reason)}`), "");
  }

  for (const tier of ["malicious", "direct-runtime", "transitive-runtime"] as Tier[]) {
    const findings = assessment.advisories.filter((finding) => finding.tier === tier);
    if (findings.length) lines.push(`### ${TIER_HEADING[tier]} (${findings.length})`, "", ...advisoryTable(findings), "");
  }

  const outdatedKey = assessment.outdated.filter((finding) => finding.key);
  const outdatedOther = assessment.outdated.filter((finding) => !finding.key && finding.gap !== "patch");
  const outdatedHeader = ["| Package | Locked | Latest | Gap | Used at | Where | Changes |", "| --- | --- | --- | --- | --- | --- | --- |"];
  if (outdatedKey.length)
    lines.push(`### Outdated key packages (${outdatedKey.length})`, "", ...outdatedHeader, ...outdatedKey.slice(0, MAX_ROWS).map(outdatedRow), "");

  const devFindings = assessment.advisories.filter((finding) => finding.tier === "dev");
  if (devFindings.length)
    lines.push(
      `<details><summary>${TIER_HEADING.dev} (${devFindings.length}): listed, not part of the verdict</summary>`,
      "",
      ...advisoryTable(devFindings),
      "",
      "</details>",
      "",
    );
  const unreachableFindings = assessment.advisories.filter((finding) => finding.tier === "unreachable");
  if (unreachableFindings.length)
    lines.push(
      `<details><summary>${TIER_HEADING.unreachable} (${unreachableFindings.length}): listed, not part of the verdict</summary>`,
      "",
      "Locked, but no dependency path from a workspace member leads to them (e.g. entries kept by `resolutions`).",
      "",
      ...advisoryTable(unreachableFindings),
      "",
      "</details>",
      "",
    );
  if (outdatedOther.length)
    lines.push(
      `<details><summary>Other direct dependencies with a newer major or minor release (${outdatedOther.length})</summary>`,
      "",
      ...outdatedHeader,
      ...outdatedOther.slice(0, MAX_ROWS).map(outdatedRow),
      ...(outdatedOther.length > MAX_ROWS ? [`| … ${outdatedOther.length - MAX_ROWS} more | | | | | | |`] : []),
      "",
      "</details>",
      "",
    );

  const notAssessedFiles = [
    ...discovery.lockfiles.filter((report) => report.status !== "assessed").map((report) => `${code(report.path)}: ${cell(report.reason)}`),
    ...discovery.otherDependencyFiles.map((file) => `${code(file.path)}: ${file.ecosystem}, not assessed`),
    ...discovery.manifestsWithoutLockfile.map((path) => `${code(path)}: no lockfile, versions not pinned`),
  ];
  if (notAssessedFiles.length || assessment.notChecked.length) {
    lines.push(`<details><summary>Not checked or not assessed (${notAssessedFiles.length + assessment.notChecked.length})</summary>`, "");
    for (const line of notAssessedFiles.slice(0, MAX_ROWS)) lines.push(`- ${line}`);
    for (const item of assessment.notChecked.slice(0, MAX_ROWS))
      lines.push(`- ${code(item.version ? `${item.name}@${item.version}` : item.name)} in ${code(item.lockfile)} (${item.unreachable ? "unreachable" : item.runtime ? "runtime" : "dev"}): ${cell(item.reason)}`);
    const hidden = Math.max(0, notAssessedFiles.length - MAX_ROWS) + Math.max(0, assessment.notChecked.length - MAX_ROWS);
    if (hidden) lines.push(`- … ${hidden} more`);
    lines.push("", "</details>", "");
  }

  lines.push(
    "<details><summary>Verdict rules</summary>",
    "",
    "- **blocked**: any locked version known to be malicious (an OSV `MAL-` record), even one no workspace member reaches, or a high or critical advisory in a direct runtime dependency.",
    "- **review**: other advisories in runtime dependencies, a runtime dependency that could not be checked, or an outdated key package (a newer major release, or a newer minor release on 0.x). Advisories in development-only dependencies and in lock entries no workspace member reaches are listed but don't change the verdict.",
    "- **ready (npm dependencies assessed)**: none of the above. It does not mean the application is safe to deploy.",
    "- Coverage is **complete** when every supported npm lockfile was assessed, **partial** when something was not checked or not assessed, and **failed** when nothing could be assessed.",
    `- Key packages: ${context.keyPackages.map(code).join(", ")}. Advisory data: [OSV](https://osv.dev); advisories without a severity count as moderate.`,
    "",
    "</details>",
  );
  return `${lines.join("\n")}\n`;
};
