import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as core from "@actions/core";
import { assess } from "./assess.js";
import { renderReport } from "./report.js";
import { DEFAULT_KEY_PACKAGES, type Assessment } from "./verdict.js";

/** Resolves the input path inside the workspace; symlinks out of the checkout are refused. */
const resolveTarget = (workspace: string, input: string): { root: string; path: string } => {
  const root = realpathSync(resolve(workspace, input || "."));
  const path = relative(realpathSync(workspace), root);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`path must stay inside the workspace: ${input}`);
  return { root, path: path ? path.split(sep).join("/") : "." };
};

const shouldFail = (assessment: Assessment, failOn: string): boolean =>
  assessment.coverage === "failed" || assessment.verdict === "blocked" || (failOn === "review" && assessment.verdict === "review");

const run = async () => {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) throw new Error("GITHUB_WORKSPACE is required");
  const failOn = core.getInput("fail-on") || "blocked";
  if (!["blocked", "review"].includes(failOn)) throw new Error(`fail-on must be blocked or review, not ${failOn}`);
  const keyPackageInput = core.getInput("key-packages");
  const keyPackages = keyPackageInput
    ? keyPackageInput.split(",").map((pattern) => pattern.trim()).filter(Boolean)
    : DEFAULT_KEY_PACKAGES;
  const { root, path } = resolveTarget(workspace, core.getInput("path"));

  const assessment = await assess(root, keyPackages, fetch);
  const report = renderReport(assessment, {
    path,
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA,
    ranAt: new Date(),
    keyPackages,
    caseLabel: core.getInput("case-label") || undefined,
  });

  if (process.env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(report).write();
  else process.stdout.write(report);
  core.setOutput("verdict", assessment.verdict);
  core.setOutput("coverage", assessment.coverage);
  core.info(`Verdict: ${assessment.verdict}, coverage: ${assessment.coverage}`);
  if (shouldFail(assessment, failOn))
    core.setFailed(
      assessment.coverage === "failed"
        ? "Dependency assessment failed: nothing could be assessed"
        : `Dependency verdict is ${assessment.verdict}: ${[...assessment.verdictReasons.blocked, ...assessment.verdictReasons.review].join("; ")}`,
    );
};

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
