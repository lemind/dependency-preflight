import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import * as core from "@actions/core";
import { randomUUID } from "node:crypto";
import { assess } from "./assess.js";
import { fetchBaseFiles } from "./base.js";
import { renderComment, upsertComment } from "./comment.js";
import { compare, type Comparison } from "./compare.js";
import { selectCandidates, type CandidateSelection } from "./explain.js";
import { explainUpgrades, freeUpgrades, paidEventRefusal, type UpgradeResult } from "./purchase.js";
import { githubApi, PurchaseRecord } from "./record.js";
import { renderReport } from "./report.js";
import { IntelligenceClient } from "./telegraph.js";
import { DEFAULT_KEY_PACKAGES, type Assessment } from "./verdict.js";

/** Resolves the input path inside the workspace; symlinks out of the checkout are refused. */
const resolveTarget = (workspace: string, input: string): { root: string; path: string } => {
  const root = realpathSync(resolve(workspace, input || "."));
  const path = relative(realpathSync(workspace), root);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`path must stay inside the workspace: ${input}`);
  return { root, path: path ? path.split(sep).join("/") : "." };
};

const numberInput = (name: string, fallback: string, check: (value: number) => boolean, rule: string): number => {
  const raw = core.getInput(name) || fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !check(value)) throw new Error(`${name} must be ${rule}, not ${raw}`);
  return value;
};

/**
 * P2: explains the selected upgrades when a wallet, a writable record and the lease are all available (FR-009b);
 * otherwise free mode with the reason. The wallet key is masked and never logged or put in a message.
 */
const upgrades = async (selection: CandidateSelection, pr: PullRequest | undefined): Promise<UpgradeResult> => {
  const key = process.env.TELEGRAPH_EVM_PRIVATE_KEY?.trim();
  if (!key) return freeUpgrades(selection, "no wallet configured (TELEGRAPH_EVM_PRIVATE_KEY is not set)");
  core.setSecret(key);
  const refusal = paidEventRefusal(process.env.GITHUB_EVENT_NAME, pr?.fromFork ?? false);
  if (refusal) return freeUpgrades(selection, refusal);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return freeUpgrades(selection, "TELEGRAPH_EVM_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key");
  if (!selection.candidates.length) return freeUpgrades(selection, "no upgrade to explain");
  const token = core.getInput("github-token");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return freeUpgrades(selection, "no GitHub token and repository to write the purchase record");
  core.setSecret(token);

  const minerId = core.getInput("miner-id") || "7314";
  if (!/^\d+$/.test(minerId)) throw new Error(`miner-id must be a number, not ${minerId}`);
  const chainId = numberInput("chain-id", "11155111", (value) => Number.isSafeInteger(value) && value > 0, "a positive integer");
  const usdcAddress = core.getInput("usdc-address") || "0xcc194e1a843B658526D0D5C431f670028582Ae17";
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdcAddress)) throw new Error(`usdc-address must be a 0x-prefixed 20-byte address, not ${usdcAddress}`);
  const client = new IntelligenceClient({
    nodeUrl: core.getInput("node-url") || "https://devnode.telegraphprotocol.com",
    evmPrivateKey: key as `0x${string}`,
    chainId,
    usdcAddress,
    maxPricePerCallUsdc: numberInput("max-price-per-call-usdc", "0.05", (value) => value > 0, "a positive number"),
    budgetCapUsdc: numberInput("budget-cap-usdc", "0.30", (value) => value > 0, "a positive number"),
    preferredMinerId: minerId,
  });
  const github = githubApi(fetch, {
    repository,
    token,
    apiUrl: process.env.GITHUB_API_URL,
    graphqlUrl: process.env.GITHUB_GRAPHQL_URL,
  });
  const runId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${randomUUID()}`;
  const result = await explainUpgrades(selection, { client, openRecord: () => PurchaseRecord.open(github, runId), runId });
  for (const warning of result.warnings) core.warning(warning);
  if (result.mode === "free") core.warning(`Paid explanations skipped: ${result.freeReason}`);
  return result;
};

type PullRequest = { number: number; baseSha: string; fromFork: boolean };

/** The pull request this run is for: only the `pull_request` event (never `pull_request_target`). */
const pullRequest = (): PullRequest | undefined => {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !process.env.GITHUB_EVENT_PATH) return undefined;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) as {
    pull_request?: { number: number; base: { sha: string; repo: { full_name: string } }; head: { repo: { full_name: string } | null } };
  };
  const pr = event.pull_request;
  if (!pr) return undefined;
  return { number: pr.number, baseSha: pr.base.sha, fromFork: pr.head.repo?.full_name !== pr.base.repo.full_name };
};

/**
 * P3: compares the pull request with its base (fetched through the API, never checked out or run) and posts or
 * updates one comment. Returns the re-check to put at the top of the job summary. A base that can't be assessed or
 * a comment that can't be posted is stated, not fatal: the head's own verdict still decides the step.
 */
const recheck = async (pr: PullRequest, head: Assessment, keyPackages: string[], path: string): Promise<string> => {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = core.getInput("github-token");
  if (!repository || !token) throw new Error("a pull request re-check needs GITHUB_REPOSITORY and github-token");
  core.setSecret(token);
  let comparison: Comparison | undefined;
  let baseError: string | undefined;
  try {
    const baseRoot = await fetchBaseFiles(fetch, { repository, token, apiUrl: process.env.GITHUB_API_URL }, pr.baseSha, path);
    const base = await assess(path === "." ? baseRoot : join(baseRoot, ...path.split("/")), keyPackages, fetch, path);
    comparison = compare(base, head);
  } catch (error) {
    baseError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    core.warning(`Base branch not assessed: ${baseError}`);
  }
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const body = renderComment(comparison, head, { path, runUrl, ...(baseError ? { baseError } : {}) });
  if (pr.fromFork) core.info("Pull request from a fork: the re-check is in the run summary only, no comment.");
  else
    try {
      core.info(`Re-check comment: ${await upsertComment(fetch, { repository, token, apiUrl: process.env.GITHUB_API_URL, pullNumber: pr.number }, body)}`);
    } catch (error) {
      core.warning(`Re-check comment not posted (needs pull-requests: write): ${error instanceof Error ? error.message : String(error)}`);
    }
  return body;
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

  const assessment = await assess(root, keyPackages, fetch, path);
  const maxPurchases = numberInput("max-purchases", "10", (value) => Number.isInteger(value) && value >= 0, "a whole number of 0 or more");
  const pr = pullRequest();
  const upgradeResult = await upgrades(selectCandidates(assessment.outdated, maxPurchases), pr);
  const report = renderReport(assessment, {
    path,
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.GITHUB_SHA,
    ranAt: new Date(),
    keyPackages,
    caseLabel: core.getInput("case-label") || undefined,
    upgrades: upgradeResult,
  });

  const summary = pr ? `${await recheck(pr, assessment, keyPackages, path)}\n---\n\n${report}` : report;
  if (process.env.GITHUB_STEP_SUMMARY) await core.summary.addRaw(summary).write();
  else process.stdout.write(summary);
  core.setOutput("verdict", assessment.verdict);
  core.setOutput("coverage", assessment.coverage);
  core.setOutput("spent-usdc", upgradeResult.spentUsdc.toFixed(2));
  core.info(`Verdict: ${assessment.verdict}, coverage: ${assessment.coverage}, spent: ${upgradeResult.spentUsdc.toFixed(2)} test USDC`);
  if (shouldFail(assessment, failOn))
    core.setFailed(
      assessment.coverage === "failed"
        ? "Dependency assessment failed: nothing could be assessed"
        : `Dependency verdict is ${assessment.verdict}: ${[...assessment.verdictReasons.blocked, ...assessment.verdictReasons.review].join("; ")}`,
    );
};

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
