import { describe, expect, it } from "vitest";
import { migrationQuestion, type CandidateSelection, type ExplanationCandidate } from "../src/explain.js";
import { explainUpgrades, freeUpgrades, INTENT_ID, type PaidMode } from "../src/purchase.js";
import { LEASE_FILE, LEDGER_FILE, parseLedger, PurchaseRecord } from "../src/record.js";
import { renderReport } from "../src/report.js";
import { AskFailedError, BudgetCapError, PaymentUnknownError, type AttemptEvent, type Purchase } from "../src/telegraph.js";
import type { Assessment } from "../src/verdict.js";
import { fakeGitHub } from "./fake-github.js";

const candidate = (name: string, from: string, to: string, key = false): ExplanationCandidate => ({
  name, from, to, gap: "major", key, question: migrationQuestion(name, from, to), locations: [{ lockfile: "sdk/yarn.lock", members: ["sdk"] }],
});
const anchor = candidate("@coral-xyz/anchor", "0.29.0", "0.32.1", true);
const zod = candidate("zod", "3.22.0", "4.6.7");
const selection = (...candidates: ExplanationCandidate[]): CandidateSelection => ({ candidates, skipped: [] });

const minerAnswer = (c: ExplanationCandidate) => ({
  outcome: "found",
  request: { ecosystem: "npm", package: c.name, fromResolved: c.from, toResolved: c.to },
  changes: [{ kind: "breaking", version: c.to, evidenceType: "documented", change: "API changed", excerpt: "The API changed.", sourceId: "s1", migration: "Use the new API." }],
  coverage: { complete: true },
  security: { status: "complete", advisories: [] },
  sources: [{ id: "s1", url: "https://example.org/changelog" }],
  summary: "extra fields from the miner are ignored",
});
const purchaseFor = (c: ExplanationCandidate, receiptHash: string): Purchase => ({
  intent: INTENT_ID, minerId: "7314", minerName: "Package Release Intelligence", minerRank: 7, minerScore: 0, amountUsdc: 0.02, txHash: "",
  receiptHash, rail: "escrow", epochId: 18, signalHash: "0xsignal", answer: "", result: minerAnswer(c), status: "settled", selectedBy: "our_choice",
  network: "eip155:11155111", chainId: 11155111, usdcContract: "0xcc19", explorerBaseUrl: "",
});

/** A client that records each stage through onAttempt, like the real one, and answers per question. */
const fakeClient = (answers: Record<string, (onAttempt: (event: AttemptEvent) => Promise<void>) => Promise<Purchase>>) => {
  const client: PaidMode["client"] & { questions: string[] } = {
    spentUsdc: 0,
    questions: [],
    async buy(intent, query, onAttempt) {
      expect(intent).toBe(INTENT_ID);
      client.questions.push(query);
      return answers[query](onAttempt);
    },
  };
  return client;
};
const paysAndAnswers = (client: { spentUsdc: number }, c: ExplanationCandidate, receiptHash: string) => async (onAttempt: (event: AttemptEvent) => Promise<void>) => {
  await onAttempt({ state: "reserved", minerId: "7314" });
  await onAttempt({ state: "request_sent", minerId: "7314", quotedAmountUsdc: 0.02 });
  client.spentUsdc += 0.02;
  return purchaseFor(c, receiptHash);
};
const at = (iso: string) => () => new Date(iso);

describe("explainUpgrades (T024, FR-007 to FR-011)", () => {
  it("buys one answer per candidate, records every stage, releases the lease; a rerun buys nothing (SC-004)", async () => {
    const github = fakeGitHub();
    const answers: Parameters<typeof fakeClient>[0] = {};
    const client = fakeClient(answers);
    answers[anchor.question] = paysAndAnswers(client, anchor, "0xr1");
    answers[zod.question] = paysAndAnswers(client, zod, "0xr2");
    const paid = { client, openRecord: () => PurchaseRecord.open(github, "run-1", at("2026-11-27T10:00:00Z")), runId: "run-1" };

    const first = await explainUpgrades(selection(anchor, zod), paid);
    expect(first.mode).toBe("paid");
    expect(first.explanations.map((explanation) => [explanation.name, explanation.outcome, explanation.changes.length])).toEqual([
      ["@coral-xyz/anchor", "found", 1],
      ["zod", "found", 1],
    ]);
    expect(first.purchases.map((purchase) => [purchase.name, purchase.receipt.receiptHash, purchase.reused])).toEqual([
      ["@coral-xyz/anchor", "0xr1", false],
      ["zod", "0xr2", false],
    ]);
    expect(first.spentUsdc).toBeCloseTo(0.04);
    expect(parseLedger(github.files()[LEDGER_FILE]).map((row) => `${row.key.name} ${row.state}`)).toEqual([
      "@coral-xyz/anchor reserved", "@coral-xyz/anchor request_sent", "@coral-xyz/anchor delivered",
      "zod reserved", "zod request_sent", "zod delivered",
    ]);
    expect(github.files()[LEASE_FILE]).toBe("");

    const rerunClient = fakeClient({});
    const second = await explainUpgrades(selection(anchor, zod), { client: rerunClient, openRecord: () => PurchaseRecord.open(github, "run-2"), runId: "run-2" });
    expect(rerunClient.questions).toEqual([]);
    expect(second.spentUsdc).toBe(0);
    expect(second.purchases.every((purchase) => purchase.reused)).toBe(true);
    expect(second.explanations.map((explanation) => explanation.outcome)).toEqual(["found", "found"]);
  });

  it("buys nothing when the record can't be maintained (FR-009b), and says why", async () => {
    const client = fakeClient({});
    const result = await explainUpgrades(selection(anchor), {
      client,
      openRecord: async () => { throw new Error("read preflight: HTTP 403 Resource not accessible by integration"); },
      runId: "run-1",
    });
    expect(result).toMatchObject({ mode: "free", freeReason: expect.stringMatching(/could not be maintained: .*HTTP 403/) });
    expect(client.questions).toEqual([]);
  });

  it("stops buying after an unknown payment outcome, and leaves the attempt open for reconciliation", async () => {
    const github = fakeGitHub();
    const client = fakeClient({
      [anchor.question]: async (onAttempt) => {
        await onAttempt({ state: "reserved", minerId: "7314" });
        await onAttempt({ state: "request_sent", minerId: "7314", quotedAmountUsdc: 0.02 });
        await onAttempt({ state: "unknown_needs_reconciliation", minerId: "7314", reason: "no response" });
        throw new PaymentUnknownError("7314: no response");
      },
    });
    const result = await explainUpgrades(selection(anchor, zod), { client, openRecord: () => PurchaseRecord.open(github, "run-1"), runId: "run-1" });
    expect(client.questions).toEqual([anchor.question]); // zod never asked
    expect(result.explanations[0]).toMatchObject({ outcome: "unavailable", reason: expect.stringMatching(/payment outcome unknown/) });
    expect(result.skipped).toEqual([{ name: "zod", from: "3.22.0", to: "4.6.7", reason: expect.stringMatching(/^not bought: payment outcome unknown/) }]);
    const next = await explainUpgrades(selection(anchor), { client: fakeClient({}), openRecord: () => PurchaseRecord.open(github, "run-2"), runId: "run-2" });
    expect(next.skipped[0].reason).toMatch(/needs reconciliation/);
  });

  it("an unavailable answer doesn't stop the run; the budget cap does", async () => {
    const github = fakeGitHub();
    const web3 = candidate("@solana/web3.js", "1.98.0", "3.2.1", true);
    const client = fakeClient({
      [anchor.question]: async (onAttempt) => {
        await onAttempt({ state: "reserved", minerId: "7314" });
        throw new AskFailedError("QUESTION_ANSWERING_GENERAL: miner 7314 is not listed by the node with an endpoint for this intent");
      },
      [zod.question]: async (onAttempt) => {
        await onAttempt({ state: "reserved", minerId: "7314" });
        await onAttempt({ state: "quote_refused", minerId: "7314", reason: "budget" });
        throw new BudgetCapError("spend 0.28 + worst-case 0.05 USDC exceeds budgetCapUsdc 0.3");
      },
    });
    const result = await explainUpgrades(selection(anchor, zod, web3), { client, openRecord: () => PurchaseRecord.open(github, "run-1"), runId: "run-1" });
    expect(result.explanations[0]).toMatchObject({ name: "@coral-xyz/anchor", outcome: "unavailable" });
    expect(result.stoppedReason).toMatch(/budget cap reached/);
    expect(result.skipped.map((skipped) => skipped.name)).toEqual(["zod", "@solana/web3.js"]);
  });

  it("an answer that fails validation is bought, recorded and shown as unusable, never as guidance", async () => {
    const github = fakeGitHub();
    const client = fakeClient({
      [anchor.question]: async (onAttempt) => {
        await onAttempt({ state: "reserved", minerId: "7314" });
        await onAttempt({ state: "request_sent", minerId: "7314", quotedAmountUsdc: 0.02 });
        return { ...purchaseFor(anchor, "0xr1"), result: { ...minerAnswer(anchor), request: { ...minerAnswer(anchor).request, toResolved: "0.31.0" } } };
      },
    });
    const result = await explainUpgrades(selection(anchor), { client, openRecord: () => PurchaseRecord.open(github, "run-1"), runId: "run-1" });
    expect(result.explanations[0]).toMatchObject({ outcome: "unusable", changes: [] });
    expect(result.purchases).toHaveLength(1);
  });
});

describe("report section (T024)", () => {
  const assessment: Assessment = {
    verdict: "review", coverage: "complete", verdictReasons: { blocked: [], review: ["outdated key package"] }, coverageReasons: [],
    advisories: [], outdated: [], notChecked: [], lockedVersionCount: 1,
    discovery: { lockfiles: [], otherDependencyFiles: [], manifestsWithoutLockfile: [] },
  };
  const render = (upgrades: Parameters<typeof renderReport>[1]["upgrades"]) =>
    renderReport(assessment, { path: "sdk", ranAt: new Date("2026-11-27T00:00:00Z"), keyPackages: ["@solana/*"], upgrades });

  it("free mode lists what would be explained, with release notes, and why nothing was bought", () => {
    const report = render(freeUpgrades(selection(anchor), "no wallet configured"));
    expect(report).toContain("No explanation was bought: no wallet configured.");
    expect(report).toContain("| 🔑 `@coral-xyz/anchor` | `0.29.0` | `0.32.1` | major | [release notes](https://www.npmjs.com/package/@coral-xyz/anchor?activeTab=versions) |");
  });

  it("paid mode shows changes with migration, quote and source, the purchase, and the related-party disclosure", async () => {
    const github = fakeGitHub();
    const answers: Parameters<typeof fakeClient>[0] = {};
    const client = fakeClient(answers);
    answers[anchor.question] = paysAndAnswers(client, anchor, "0xr1");
    const report = render(await explainUpgrades(selection(anchor), { client, openRecord: () => PurchaseRecord.open(github, "run-1"), runId: "run-1" }));
    expect(report).toContain("#### `@coral-xyz/anchor` `0.29.0` → `0.32.1`");
    expect(report).toContain("- **breaking** in `0.32.1`: API changed<br>Migration: Use the new API.<br>“The API changed.” ([source](https://example.org/changelog))");
    expect(report).toContain("| `@coral-xyz/anchor` `0.29.0` → `0.32.1` | `7314` | 0.02 | `0xr1` (escrow, epoch 18) | `0xsignal` | bought this run |");
    expect(report).toContain("related-party tests on testnet");
  });

  it("escapes miner text and keeps a hostile source URL inside its link", () => {
    const report = render({
      mode: "paid", candidates: [anchor], purchases: [], skipped: [], spentUsdc: 0, warnings: [],
      explanations: [{
        name: anchor.name, from: anchor.from, to: anchor.to, minerId: "7314", outcome: "found", coverageComplete: false, introducedAdvisories: ["GHSA-aaaa-bbbb-cccc"],
        changes: [{ kind: "breaking", version: "0.30.0", change: "a | b <script>\nnext", migration: null, quote: "q", sourceUrl: "https://example.org/x) [evil](https://evil.example" }],
      }],
    });
    expect(report).toContain("a \\| b &lt;script> next");
    expect(report).toContain("([source](https://example.org/x%29%20[evil]%28https://evil.example))");
    expect(report).toContain("introduces [GHSA-aaaa-bbbb-cccc]");
    expect(report).toContain("Release coverage reported by the miner: partial.");
  });

  it("not_found and unusable are stated, never shown as 'no changes'", () => {
    const report = render({
      mode: "paid", candidates: [anchor, zod], purchases: [], skipped: [], spentUsdc: 0, warnings: [],
      explanations: [
        { name: anchor.name, from: anchor.from, to: anchor.to, minerId: "7314", outcome: "not_found", changes: [], introducedAdvisories: [] },
        { name: zod.name, from: zod.from, to: zod.to, minerId: "7314", outcome: "unusable", reason: "answer is for zod 3.22.0 → 4.0.0", changes: [], introducedAdvisories: [] },
      ],
    });
    expect(report).toContain("The miner found no release material for this upgrade. This does not mean nothing changed");
    expect(report).toContain("The answer could not be used and is not shown as guidance: answer is for zod 3.22.0 → 4.0.0.");
    expect(report).not.toMatch(/no breaking changes/i);
  });
});
