import type { Discovery, LockedPackage } from "./lockfiles.js";
import type { AdvisoryGroup } from "./osv.js";
import type { Explanation } from "./explain.js";
import type { UpgradeResult } from "./purchase.js";
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
  /** Upgrade explanations (P2); absent when not run. */
  upgrades?: UpgradeResult;
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

const MAX_CHANGES = 30;

/** A link target from untrusted text: already checked to be https; parentheses and spaces can't end the link. */
const linkTarget = (url: string): string =>
  url.replace(/[()\s<>]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

const releaseNotes = (name: string): string => `[release notes](https://www.npmjs.com/package/${name}?activeTab=versions)`;

const explanationLines = (explanation: Explanation): string[] => {
  const heading = `#### ${code(explanation.name)} ${code(explanation.from)} → ${code(explanation.to)}`;
  if (explanation.outcome === "not_found")
    return [heading, "", `The miner found no release material for this upgrade. This does not mean nothing changed: see the ${releaseNotes(explanation.name)}.`, ""];
  if (explanation.outcome === "unusable")
    return [heading, "", `The answer could not be used and is not shown as guidance: ${cell(explanation.reason ?? "")}. See the ${releaseNotes(explanation.name)}.`, ""];
  if (explanation.outcome === "unavailable")
    return [heading, "", `No answer: ${cell(explanation.reason ?? "")}. See the ${releaseNotes(explanation.name)}.`, ""];
  const lines = [heading, ""];
  if (explanation.introducedAdvisories.length)
    lines.push(`> ⚠️ The miner reports that ${code(explanation.to)} introduces ${explanation.introducedAdvisories.map(advisoryLink).join(", ")}. Check before upgrading.`, "");
  lines.push(`Release coverage reported by the miner: ${explanation.coverageComplete ? "complete" : "partial"}.`, "");
  if (!explanation.changes.length) lines.push(`No documented change with a quote was returned. See the ${releaseNotes(explanation.name)}.`, "");
  for (const change of explanation.changes.slice(0, MAX_CHANGES)) {
    lines.push(`- **${change.kind.replace("_", " ")}** in ${code(change.version)}: ${cell(change.change)}${change.migration ? `<br>Migration: ${cell(change.migration)}` : ""}<br>“${cell(change.quote)}” ([source](${linkTarget(change.sourceUrl)}))`);
  }
  if (explanation.changes.length > MAX_CHANGES) lines.push(`- … ${explanation.changes.length - MAX_CHANGES} more`);
  lines.push("");
  return lines;
};

const upgradeLines = (upgrades: UpgradeResult): string[] => {
  const lines = ["### Upgrade explanations (Telegraph, P2)", ""];
  if (upgrades.mode === "free") {
    lines.push(`No explanation was bought: ${cell(upgrades.freeReason ?? "")}.`, "");
    if (upgrades.candidates.length)
      lines.push(
        "Upgrades that would be explained:",
        "",
        "| Package | Locked | Latest | Gap | Changes |",
        "| --- | --- | --- | --- | --- |",
        ...upgrades.candidates.slice(0, MAX_ROWS).map((candidate) => `| ${candidate.key ? "🔑 " : ""}${code(candidate.name)} | ${code(candidate.from)} | ${code(candidate.to)} | ${candidate.gap} | ${releaseNotes(candidate.name)} |`),
        "",
      );
  } else {
    if (upgrades.stoppedReason) lines.push(`Buying stopped: ${cell(upgrades.stoppedReason)}.`, "");
    for (const warning of upgrades.warnings) lines.push(`> ⚠️ ${cell(warning)}`, "");
    if (!upgrades.explanations.length && !upgrades.candidates.length) lines.push("No upgrade needed an explanation.", "");
    for (const explanation of upgrades.explanations) lines.push(...explanationLines(explanation));
    if (upgrades.purchases.length)
      lines.push(
        `Purchases (spent this run: ${upgrades.spentUsdc.toFixed(2)} test USDC):`,
        "",
        "| Package | Miner | Price (test USDC) | Receipt | Signal | |",
        "| --- | --- | --- | --- | --- | --- |",
        ...upgrades.purchases.map((purchase) => `| ${code(purchase.name)} ${code(purchase.from)} → ${code(purchase.to)} | ${code(purchase.receipt.minerId)} | ${purchase.receipt.amountUsdc} | ${code(purchase.receipt.receiptHash || "none")}${purchase.receipt.rail === "escrow" ? ` (escrow${purchase.receipt.epochId !== undefined ? `, epoch ${purchase.receipt.epochId}` : ""})` : purchase.receipt.txHash ? ` (tx ${code(purchase.receipt.txHash)})` : ""} | ${code(purchase.receipt.signalHash || "none")} | ${purchase.reused ? "reused from an earlier run" : "bought this run"} |`),
        "",
      );
    lines.push("Miner 7314 (Package Release Intelligence) is run by the same team as this check: purchases from it are related-party tests on testnet.", "");
  }
  if (upgrades.skipped.length)
    lines.push(
      `<details><summary>Upgrades not explained (${upgrades.skipped.length})</summary>`,
      "",
      ...upgrades.skipped.slice(0, MAX_ROWS).map((skipped) => `- ${code(skipped.name)} ${code(skipped.from)} → ${code(skipped.to)}: ${cell(skipped.reason)}`),
      ...(upgrades.skipped.length > MAX_ROWS ? [`- … ${upgrades.skipped.length - MAX_ROWS} more`] : []),
      "",
      "</details>",
      "",
    );
  return lines;
};

/** Renders the assessment as one Markdown report: verdict and coverage first, then the findings in ranked order. */
/** Dependency files outside what this check covers: unsupported or unparseable lockfiles, other ecosystems, manifests without a lockfile. */
const notAssessedFiles = (discovery: Discovery): string[] => [
  ...discovery.lockfiles.filter((report) => report.status !== "assessed").map((report) => `${code(report.path)}: ${cell(report.reason)}`),
  ...discovery.otherDependencyFiles.map((file) => `${code(file.path)}: ${file.ecosystem}, not assessed`),
  ...discovery.manifestsWithoutLockfile.map((path) => `${code(path)}: no lockfile, versions not pinned`),
];

const notAssessedCount = (assessment: Assessment): number => notAssessedFiles(assessment.discovery).length + assessment.notAssessed.length;

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
    `| Not assessed (outside this check's scope) | ${notAssessedCount(assessment)} |`,
    `| Not checked (a lookup failed) | ${assessment.notChecked.length + assessment.latestUnknown.length} |`,
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
  if (context.upgrades) lines.push(...upgradeLines(context.upgrades));

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

  const usedAt = (item: { unreachable: boolean; runtime: boolean }): string => (item.unreachable ? "unreachable" : item.runtime ? "runtime" : "dev");
  const notAssessedLines = [
    ...notAssessedFiles(discovery),
    ...assessment.notAssessed.map((item) => `${code(item.name)} in ${code(item.lockfile)} (${usedAt(item)}): ${cell(item.reason)}, ${code(item.source)}`),
  ];
  if (notAssessedLines.length) {
    lines.push(`<details><summary>Not assessed (${notAssessedLines.length}): outside what this check covers</summary>`, "");
    for (const line of notAssessedLines.slice(0, MAX_ROWS)) lines.push(`- ${line}`);
    if (notAssessedLines.length > MAX_ROWS) lines.push(`- … ${notAssessedLines.length - MAX_ROWS} more`);
    lines.push("", "</details>", "");
  }
  const notCheckedLines = [
    ...assessment.notChecked.map((item) => `${code(`${item.name}@${item.version}`)} in ${code(item.lockfile)} (${usedAt(item)}): ${cell(item.reason)}`),
    ...assessment.latestUnknown.map((name) => `${code(name)}: the latest release could not be looked up`),
  ];
  if (notCheckedLines.length) {
    lines.push(`<details><summary>Not checked (${notCheckedLines.length}): a lookup failed; a rerun may complete it</summary>`, "");
    for (const line of notCheckedLines.slice(0, MAX_ROWS)) lines.push(`- ${line}`);
    if (notCheckedLines.length > MAX_ROWS) lines.push(`- … ${notCheckedLines.length - MAX_ROWS} more`);
    lines.push("", "</details>", "");
  }

  lines.push(
    "<details><summary>Verdict rules</summary>",
    "",
    "- **blocked**: any locked version known to be malicious (an OSV `MAL-` record), even one no workspace member reaches, or a high or critical advisory in a direct runtime dependency.",
    "- **review**: other advisories in runtime dependencies, a runtime dependency that could not be checked or is not assessed, or an outdated key package (a newer major release, or a newer minor release on 0.x). Advisories in development-only dependencies and in lock entries no workspace member reaches are listed but don't change the verdict.",
    "- **ready (npm dependencies assessed)**: none of the above. It does not mean the application is safe to deploy.",
    "- Coverage is **complete** when every supported npm lockfile was assessed, **partial** when something was not checked or not assessed, and **failed** when nothing could be assessed.",
    `- Key packages: ${context.keyPackages.map(code).join(", ")}. Advisory data: [OSV](https://osv.dev); advisories without a severity count as moderate.`,
    "",
    "</details>",
  );
  return `${lines.join("\n")}\n`;
};
