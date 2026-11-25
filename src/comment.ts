import type { Comparison, ComparedFinding, FindingStatus } from "./compare.js";

/**
 * The pull request comment (T031, research R12): condensed, because full reports run to 30–80 KB and a comment is
 * capped at 65,536 characters. One comment per assessed path, found by a hidden marker and updated in place.
 */
export const commentMarker = (path: string): string => `<!-- dependency-preflight:${path.replace(/-->/g, "")} -->`;

export const MAX_COMMENT_CHARACTERS = 60_000;
const MAX_LISTED = 20;

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;
const cell = (text: string): string => text.replace(/[\r\n]+/g, " ").replace(/</g, "&lt;");

const LABEL = { blocked: "🛑 blocked", review: "⚠️ review", ready: "✅ ready" } as const;
const HEADING: Record<FindingStatus, string> = {
  new: "New in this pull request",
  open: "Still open",
  unverified: "Not verified on this pull request",
  resolved: "Resolved",
};

/** A finding the verdict depends on (R8): a malicious version, a runtime advisory, or a key package a major release behind. */
const mattersToVerdict = (finding: ComparedFinding): boolean =>
  finding.kind === "outdated"
    ? finding.key && finding.gap === "major"
    : finding.malicious || finding.tier === "malicious" || finding.tier === "direct-runtime" || finding.tier === "transitive-runtime";

const describe = (finding: ComparedFinding): string => {
  const versions =
    finding.baseVersion && finding.headVersion && finding.baseVersion !== finding.headVersion
      ? `${code(finding.baseVersion)} → ${code(finding.headVersion)}`
      : code(finding.headVersion ?? finding.baseVersion ?? "");
  const what =
    finding.kind === "outdated"
      ? `key package a ${finding.gap} release behind`
      : `${finding.malicious ? "**malicious**" : finding.severity ?? ""} ${finding.ids.slice(0, 3).map((id) => `[${id}](https://osv.dev/vulnerability/${encodeURIComponent(id)})`).join(", ")}`;
  return `- ${finding.key ? "🔑 " : ""}${code(finding.name)} ${versions} in ${code(finding.member)}: ${what.trim()}${finding.reason ? ` (${cell(finding.reason)})` : ""}`;
};

export type CommentContext = {
  path: string;
  /** The run's page, where the job summary holds the full report. */
  runUrl?: string;
  /** Set when the base could not be assessed: then there is no comparison. */
  baseError?: string;
};

export const renderComment = (comparison: Comparison | undefined, head: { verdict: keyof typeof LABEL; coverage: string }, context: CommentContext): string => {
  const lines = [commentMarker(context.path), `### dependency-preflight re-check: ${code(context.path)}`, ""];
  if (!comparison) {
    lines.push(
      `This pull request: **${LABEL[head.verdict]}**, coverage **${head.coverage}**.`,
      "",
      `The base branch could not be assessed, so nothing is compared: ${cell(context.baseError ?? "unknown error")}.`,
      "",
    );
  } else {
    lines.push(
      "| | Base | This pull request |",
      "| --- | --- | --- |",
      `| Verdict | ${LABEL[comparison.base.verdict]} | **${LABEL[comparison.head.verdict]}** |`,
      `| Coverage | ${comparison.base.coverage} | ${comparison.head.coverage} |`,
      "",
      `Findings: ${comparison.counts.resolved} resolved · ${comparison.counts.open} still open · ${comparison.counts.new} new · ${comparison.counts.unverified} not verified.`,
      "",
    );
    for (const status of ["new", "unverified", "resolved", "open"] as FindingStatus[]) {
      const relevant = comparison.findings.filter((finding) => finding.status === status && mattersToVerdict(finding));
      if (!relevant.length) continue;
      lines.push(`**${HEADING[status]}** (${relevant.length} that affect the verdict)`, "", ...relevant.slice(0, MAX_LISTED).map(describe));
      if (relevant.length > MAX_LISTED) lines.push(`- … ${relevant.length - MAX_LISTED} more in the full report`);
      lines.push("");
    }
    if (comparison.counts.unverified)
      lines.push("A finding is marked resolved only when this pull request's lockfile was assessed and its lookup completed; otherwise it is not verified.", "");
  }
  lines.push(
    `${context.runUrl ? `[Full report](${context.runUrl}) in the run's summary. ` : ""}This is a dependency re-check: lockfiles and manifests were compared; no code was built, tested or run.`,
  );
  const body = `${lines.join("\n")}\n`;
  return body.length <= MAX_COMMENT_CHARACTERS ? body : `${body.slice(0, MAX_COMMENT_CHARACTERS - 80)}\n\n… cut to fit a comment; see the full report.\n`;
};

export type CommentTarget = { repository: string; token: string; apiUrl?: string; pullNumber: number };

/** Creates the comment, or updates the one carrying the marker. Returns its URL. */
export const upsertComment = async (fetcher: typeof fetch, target: CommentTarget, body: string): Promise<string> => {
  const apiUrl = (target.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${target.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const call = async <T>(url: string, init: RequestInit, what: string): Promise<T> => {
    const response = await fetcher(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return (await response.json()) as T;
  };
  const marker = body.slice(0, body.indexOf("\n"));
  const issue = `${apiUrl}/repos/${target.repository}/issues`;
  for (let page = 1; page <= 10; page++) {
    const comments = await call<{ id: number; body?: string; html_url: string }[]>(`${issue}/${target.pullNumber}/comments?per_page=100&page=${page}`, { method: "GET" }, "list comments");
    const existing = comments.find((comment) => comment.body?.startsWith(marker));
    if (existing) return (await call<{ html_url: string }>(`${issue}/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) }, "update the comment")).html_url;
    if (comments.length < 100) break;
  }
  return (await call<{ html_url: string }>(`${issue}/${target.pullNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) }, "create the comment")).html_url;
};
