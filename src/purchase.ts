import { randomUUID } from "node:crypto";
import {
  MAX_ANSWER_CHARACTERS,
  readAnswer,
  type CandidateSelection,
  type Explanation,
  type ExplanationCandidate,
  type SkippedUpgrade,
} from "./explain.js";
import { LeaseLostError, type AttemptRow, type PurchaseReceipt, type PurchaseRecord } from "./record.js";
import { AskFailedError, BudgetCapError, PaymentUnknownError, PriceGuardError, type AttemptEvent, type Purchase } from "./telegraph.js";

/** The intent miner 7314 is listed under (as in the PR Agent; the node lists it there with one endpoint, /answer). */
export const INTENT_ID = "QUESTION_ANSWERING_GENERAL";

/** What the purchase loop needs; tests pass fakes. */
export type PaidMode = {
  client: { buy: (intent: string, query: string, onAttempt: (event: AttemptEvent) => Promise<void>) => Promise<Purchase>; spentUsdc: number };
  /** Acquires the lease; throws when the record can't be maintained (FR-009b). */
  openRecord: () => Promise<PurchaseRecord>;
  runId: string;
  now?: () => Date;
};

export type PurchaseLine = { name: string; from: string; to: string; receipt: PurchaseReceipt; reused: boolean };

export type UpgradeResult = {
  /** `free`: no purchase was attempted, for `freeReason`. */
  mode: "paid" | "free";
  freeReason?: string;
  candidates: ExplanationCandidate[];
  explanations: Explanation[];
  purchases: PurchaseLine[];
  skipped: SkippedUpgrade[];
  /** Why buying stopped before every candidate was handled. */
  stoppedReason?: string;
  spentUsdc: number;
  /** Problems the report must state: a paid answer not recorded, a lease not released. */
  warnings: string[];
};

const receiptOf = (purchase: Purchase): PurchaseReceipt => ({
  minerId: purchase.minerId,
  amountUsdc: purchase.amountUsdc,
  txHash: purchase.txHash,
  receiptHash: purchase.receiptHash,
  signalHash: purchase.signalHash,
  network: purchase.network,
  chainId: purchase.chainId,
  ...(purchase.rail ? { rail: purchase.rail } : {}),
  ...(purchase.epochId !== undefined ? { epochId: purchase.epochId } : {}),
});

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Free mode: nothing bought; the report lists what would be explained (FR-011). */
export const freeUpgrades = (selection: CandidateSelection, freeReason: string): UpgradeResult => ({
  mode: "free",
  freeReason,
  candidates: selection.candidates,
  explanations: [],
  purchases: [],
  skipped: selection.skipped,
  spentUsdc: 0,
  warnings: [],
});

/**
 * Explains the selected upgrades (FR-007 to FR-010): a delivered answer is reused; a key with an open attempt is
 * skipped until a person reconciles it; otherwise one answer is bought, every stage recorded before it happens.
 * Buying stops for the run on an unknown payment outcome, a lost lease, the budget cap or an unexpected error; each
 * reason is reported. Nothing here lowers the verdict.
 */
export const explainUpgrades = async (selection: CandidateSelection, paid: PaidMode): Promise<UpgradeResult> => {
  const now = paid.now ?? (() => new Date());
  let record: PurchaseRecord;
  try {
    record = await paid.openRecord();
  } catch (error) {
    return freeUpgrades(selection, `the purchase record could not be maintained: ${message(error)}`);
  }

  const result: UpgradeResult = {
    mode: "paid",
    candidates: selection.candidates,
    explanations: [],
    purchases: [],
    skipped: [...selection.skipped],
    spentUsdc: 0,
    warnings: [],
  };
  const stop = (index: number, reason: string) => {
    result.stoppedReason = reason;
    for (const candidate of selection.candidates.slice(index))
      result.skipped.push({ name: candidate.name, from: candidate.from, to: candidate.to, reason: `not bought: ${reason}` });
  };

  for (const [index, candidate] of selection.candidates.entries()) {
    const key = { name: candidate.name, from: candidate.from, to: candidate.to };
    const status = record.status(key);
    if (status.status === "delivered") {
      result.explanations.push(readAnswer(status.row.answer, candidate, status.row.minerId));
      if (status.row.receipt) result.purchases.push({ ...key, receipt: status.row.receipt, reused: true });
      continue;
    }
    if (status.status === "open") {
      result.skipped.push({
        ...key,
        reason: `an earlier attempt needs reconciliation (${status.rows.map((row) => `${row.attemptId}: ${row.state}`).join(", ")})`.slice(0, 300),
      });
      continue;
    }
    if (!record.canStartPurchase()) {
      stop(index, "too little time left on this run's lease");
      break;
    }

    const attemptId = randomUUID();
    const row = (fields: Pick<AttemptRow, "state" | "minerId"> & Partial<AttemptRow>): AttemptRow => ({
      kind: "attempt",
      key,
      attemptId,
      runId: paid.runId,
      time: now().toISOString(),
      ...fields,
    });
    let purchase: Purchase;
    try {
      purchase = await paid.client.buy(INTENT_ID, candidate.question, (event) =>
        record.append([
          row({
            state: event.state,
            minerId: event.minerId,
            ...(event.quotedAmountUsdc !== undefined ? { quotedAmountUsdc: event.quotedAmountUsdc } : {}),
            ...(event.reason ? { reason: event.reason } : {}),
          }),
        ]),
      );
    } catch (error) {
      result.spentUsdc = paid.client.spentUsdc;
      if (error instanceof PriceGuardError) {
        result.skipped.push({ ...key, reason: `not bought: ${message(error)}` });
        continue;
      }
      if (error instanceof AskFailedError) {
        result.explanations.push({ ...key, minerId: "", outcome: "unavailable", reason: message(error), changes: [], introducedAdvisories: [] });
        continue;
      }
      if (error instanceof BudgetCapError) {
        stop(index, `budget cap reached (${message(error)})`);
        break;
      }
      // Unknown payment outcome, lost lease, or anything unexpected: stop buying for this run.
      const reason =
        error instanceof PaymentUnknownError
          ? `payment outcome unknown, needs reconciliation: ${message(error)}`
          : error instanceof LeaseLostError
            ? `the purchase record was lost: ${message(error)}`
            : `unexpected error: ${message(error)}`;
      result.explanations.push({ ...key, minerId: "", outcome: "unavailable", reason, changes: [], introducedAdvisories: [] });
      stop(index + 1, reason);
      break;
    }

    result.spentUsdc = paid.client.spentUsdc;
    const receipt = receiptOf(purchase);
    const answer = purchase.result ?? purchase.answer;
    const storable = JSON.stringify(answer ?? null).length <= MAX_ANSWER_CHARACTERS;
    result.explanations.push(readAnswer(answer, candidate, purchase.minerId));
    result.purchases.push({ ...key, receipt, reused: false });
    try {
      await record.append([row({ state: "delivered", minerId: purchase.minerId, receipt, ...(storable ? { answer } : {}) })]);
    } catch (error) {
      // Paid and answered, but not recorded: the attempt stays request_sent and the next run flags it.
      const reason = `answer for ${candidate.name} ${candidate.from} → ${candidate.to} was paid (receipt ${receipt.receiptHash || "none"}) but not recorded: ${message(error)}`;
      result.warnings.push(reason);
      stop(index + 1, reason);
      break;
    }
  }

  try {
    await record.release();
  } catch (error) {
    result.warnings.push(`the purchase lease was not released (it expires on its own): ${message(error)}`);
  }
  return result;
};
