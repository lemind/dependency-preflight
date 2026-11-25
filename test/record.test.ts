import { describe, expect, it, vi } from "vitest";
import {
  type AttemptRow,
  type GitHubApi,
  githubApi,
  keyStatus,
  LEASE_FILE,
  LEASE_MS,
  LeaseHeldError,
  LeaseLostError,
  LEDGER_FILE,
  parseLedger,
  PurchaseRecord,
} from "../src/record.js";

/** An in-memory branch with GitHub's compare-and-swap rule: a move succeeds only from the exact expected head. */
const fakeGitHub = () => {
  const commits = new Map<string, Record<string, string>>();
  let head: string | null = null;
  let counter = 0;
  const api: GitHubApi & { head: () => string | null; files: () => Record<string, string> } = {
    head: () => head,
    files: () => (head ? commits.get(head)! : {}),
    readBranch: async () =>
      head ? { headOid: head, ledger: commits.get(head)![LEDGER_FILE] ?? "", lease: commits.get(head)![LEASE_FILE] ?? null } : null,
    commitFiles: async (parentOid, files) => {
      const oid = `c${++counter}`.padEnd(40, "0");
      commits.set(oid, { ...(parentOid ? commits.get(parentOid) : {}), ...files });
      return oid;
    },
    moveBranch: async (beforeOid, afterOid) => {
      if ((head ?? "0".repeat(40)) !== beforeOid) throw new Error(`ref moved: expected ${beforeOid}, is ${head}`);
      head = afterOid;
    },
  };
  return api;
};

const key = { name: "@coral-xyz/anchor", from: "0.29.0", to: "0.32.1" };
const row = (state: AttemptRow["state"], overrides: Partial<AttemptRow> = {}): AttemptRow => ({
  kind: "attempt", key, attemptId: "a1", runId: "run-1", state, minerId: "7314", time: "2026-11-25T10:00:00.000Z", ...overrides,
});
const at = (iso: string) => () => new Date(iso);

describe("purchase record and lease (T023, research R11)", () => {
  it("creates the branch with a lease, records attempts in order, and releases the lease", async () => {
    const github = fakeGitHub();
    const record = await PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z"));
    expect(JSON.parse(github.files()[LEASE_FILE])).toMatchObject({ runId: "run-1", expiresAt: "2026-11-25T10:20:00.000Z" });
    await record.append([row("reserved")]);
    await record.append([row("request_sent", { quotedAmountUsdc: 0.02 })]);
    expect(record.status(key)).toMatchObject({ status: "open" });
    await record.append([row("delivered", { receipt: { minerId: "7314", amountUsdc: 0.02, txHash: "", receiptHash: "0xr", signalHash: "0xs", network: "eip155:11155111", chainId: 11155111, rail: "escrow" }, answer: { outcome: "found" } })]);
    expect(record.status(key)).toMatchObject({ status: "delivered", row: { answer: { outcome: "found" } } });
    await record.release();
    expect(github.files()[LEASE_FILE]).toBe("");
    expect(parseLedger(github.files()[LEDGER_FILE]).map((entry) => entry.state)).toEqual(["reserved", "request_sent", "delivered"]);
  });

  it("refuses a second run while the lease is held: it buys nothing", async () => {
    const github = fakeGitHub();
    await PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z"));
    await expect(PurchaseRecord.open(github, "run-2", at("2026-11-25T10:05:00Z"))).rejects.toBeInstanceOf(LeaseHeldError);
  });

  it("two runs racing for a free record: exactly one gets the lease", async () => {
    const github = fakeGitHub();
    const results = await Promise.allSettled([
      PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z")),
      PurchaseRecord.open(github, "run-2", at("2026-11-25T10:00:00Z")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.any(LeaseHeldError) });
  });

  it("takes over an expired lease only after marking the previous run's open attempts for reconciliation", async () => {
    const github = fakeGitHub();
    const first = await PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z"));
    await first.append([row("reserved", { attemptId: "a1" })]);
    await first.append([row("reserved", { attemptId: "a2", key: { ...key, name: "zod" } }), row("request_sent", { attemptId: "a2", key: { ...key, name: "zod" } })]);
    // run-1 dies; its lease expires.
    const second = await PurchaseRecord.open(github, "run-2", at(new Date(Date.parse("2026-11-25T10:00:00Z") + LEASE_MS + 1).toISOString()));
    const latest = second.rows().slice(-2);
    expect(latest.map((entry) => [entry.attemptId, entry.state])).toEqual([
      ["a1", "unknown_needs_reconciliation"],
      ["a2", "unknown_needs_reconciliation"],
    ]);
    expect(latest[1].reason).toMatch(/run run-1's lease expired.*last state request_sent/);
    expect(second.status(key)).toMatchObject({ status: "open" }); // never bought again until a person reconciles
  });

  it("stops writing when the branch moved under the run", async () => {
    const github = fakeGitHub();
    const record = await PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z"));
    // Someone else commits to the branch (e.g. a person editing the ledger by hand).
    await github.moveBranch(github.head()!, await github.commitFiles(github.head(), { "note.txt": "x" }, "manual"));
    await expect(record.append([row("reserved")])).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("a lost updateRefs response counts only if the branch head is the run's commit", async () => {
    const github = fakeGitHub();
    const record = await PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z"));
    const move = github.moveBranch;
    // The move happens, but the response is lost.
    github.moveBranch = async (before, after) => {
      await move(before, after);
      throw new Error("socket hang up");
    };
    await record.append([row("reserved")]);
    expect(record.status(key)).toMatchObject({ status: "open" });
    // The move is refused and the response is lost: the run stops.
    github.moveBranch = async () => {
      throw new Error("socket hang up");
    };
    await expect(record.append([row("request_sent")])).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("stops writing once its own lease has expired, and stops starting purchases before that", async () => {
    const github = fakeGitHub();
    let now = new Date("2026-11-25T10:00:00Z");
    const record = await PurchaseRecord.open(github, "run-1", () => now);
    expect(record.canStartPurchase()).toBe(true);
    now = new Date("2026-11-25T10:18:00Z");
    expect(record.canStartPurchase()).toBe(false);
    now = new Date("2026-11-25T10:20:00Z");
    await expect(record.append([row("reserved")])).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("refuses a second row with the same receipt", async () => {
    const github = fakeGitHub();
    const record = await PurchaseRecord.open(github, "run-1", at("2026-11-25T10:00:00Z"));
    const receipt = { minerId: "7314", amountUsdc: 0.02, txHash: "", receiptHash: "0xr", signalHash: "", network: "eip155:11155111", chainId: 11155111 };
    await record.append([row("delivered", { receipt })]);
    await expect(record.append([row("delivered", { attemptId: "a2", receipt })])).rejects.toThrow(/already recorded/);
  });

  it("refuses a malformed ledger rather than skipping a line", () => {
    expect(() => parseLedger(`${JSON.stringify(row("reserved"))}\nnot json\n`)).toThrow(/line 2 is not JSON/);
    expect(() => parseLedger(`{"kind":"purchase"}\n`)).toThrow(/line 1 is not an attempt row/);
  });

  it("key status: delivered is reused whatever miner answered; failed attempts leave the key free", () => {
    expect(keyStatus([row("reserved"), row("delivered", { minerId: "9999" })], key)).toMatchObject({ status: "delivered", row: { minerId: "9999" } });
    expect(keyStatus([row("reserved"), row("failed_not_charged")], key)).toEqual({ status: "new" });
    expect(keyStatus([row("quote_refused")], key)).toEqual({ status: "new" });
    expect(keyStatus([row("unknown_needs_reconciliation")], key)).toMatchObject({ status: "open" });
    expect(keyStatus([row("delivered")], { ...key, to: "0.31.0" })).toEqual({ status: "new" });
  });
});

describe("githubApi request shapes", () => {
  const replies = (bodies: unknown[]) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(bodies.shift()), { status: 200 });
    });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
  };

  it("reads the branch and both files in one GraphQL query, then moves it with updateRefs from the exact head", async () => {
    const { calls, fetcher } = replies([
      { data: { repository: { id: "R_1", ref: { target: { oid: "head1", ledger: { object: { text: "", isTruncated: false } }, lease: null } } } } },
      { data: { updateRefs: { clientMutationId: null } } },
    ]);
    const github = githubApi(fetcher, { repository: "lemind/demo", token: "t0ken" });
    expect(await github.readBranch()).toEqual({ headOid: "head1", ledger: "", lease: null });
    await github.moveBranch("head1", "head2");
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      query: expect.stringContaining("updateRefs"),
      variables: { input: { repositoryId: "R_1", refUpdates: [{ name: "refs/heads/preflight", beforeOid: "head1", afterOid: "head2" }] } },
    });
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer t0ken");
  });

  it("builds a commit on the parent's tree with the files inline", async () => {
    const { calls, fetcher } = replies([{ tree: { sha: "tree0" } }, { sha: "tree1" }, { sha: "commit1" }]);
    const github = githubApi(fetcher, { repository: "lemind/demo", token: "t0ken" });
    expect(await github.commitFiles("parent0", { [LEDGER_FILE]: "x\n" }, "msg")).toBe("commit1");
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/lemind/demo/git/commits/parent0",
      "POST https://api.github.com/repos/lemind/demo/git/trees",
      "POST https://api.github.com/repos/lemind/demo/git/commits",
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      base_tree: "tree0",
      tree: [{ path: LEDGER_FILE, mode: "100644", type: "blob", content: "x\n" }],
    });
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ message: "msg", tree: "tree1", parents: ["parent0"] });
  });

  it("fails on a GraphQL error, and on a truncated ledger instead of reading part of it", async () => {
    const refused = replies([{ errors: [{ message: "A ref was not updated: expected oid head1" }] }]);
    const github = githubApi(refused.fetcher, { repository: "lemind/demo", token: "t" });
    await expect(github.readBranch()).rejects.toThrow(/expected oid head1/);
    const truncated = replies([{ data: { repository: { id: "R", ref: { target: { oid: "h", ledger: { object: { text: "x", isTruncated: true } }, lease: null } } } } }]);
    await expect(githubApi(truncated.fetcher, { repository: "lemind/demo", token: "t" }).readBranch()).rejects.toThrow(/too large/);
  });
});
