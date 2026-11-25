import type { AttemptState } from "./telegraph.js";

/**
 * The purchase record and run lease on the installer's `preflight` branch (T023, research R11, FR-009, FR-009a,
 * FR-009b). Every write is a new commit on top of the head this run last read, moved with GraphQL `updateRefs`
 * (`beforeOid` = that head), so a write fails if anything else moved the branch. Every write also requires this
 * run's lease token in `lease.json` at that head. Attempt states and rules follow the PR Agent's ledger
 * (bot/src/ledger.ts): an open attempt (pending or unknown) blocks its key until a person reconciles it.
 */

export const RECORD_BRANCH = "preflight";
export const LEDGER_FILE = "ledger.jsonl";
export const LEASE_FILE = "lease.json";
/** Longer than the installer workflow's `timeout-minutes` (15 recommended). */
export const LEASE_MS = 20 * 60_000;
/** No paid request starts when less than this remains on the lease. */
export const LEASE_MARGIN_MS = 3 * 60_000;
const ZERO_OID = "0000000000000000000000000000000000000000";

/** Purchase key (FR-009): package, exact from-version, exact to-version. The miner is not part of it. */
export type PurchaseKey = { name: string; from: string; to: string };
export const keyId = (key: PurchaseKey): string => `${key.name}@${key.from}->${key.to}`;

export type Lease = { token: string; runId: string; acquiredAt: string; expiresAt: string };

/** What a purchase cost and proved, kept with its answer so a later run reuses it (FR-009). */
export type PurchaseReceipt = {
  minerId: string;
  amountUsdc: number;
  txHash: string;
  receiptHash: string;
  signalHash: string;
  network: string;
  chainId: number;
  rail?: "escrow";
  epochId?: number;
};

export type AttemptRow = {
  kind: "attempt";
  key: PurchaseKey;
  attemptId: string;
  runId: string;
  state: AttemptState;
  minerId: string;
  quotedAmountUsdc?: number;
  reason?: string;
  /** delivered only. */
  receipt?: PurchaseReceipt;
  /** delivered only: the miner's answer as returned, validated again whenever it is shown. */
  answer?: unknown;
  time: string;
};

export type KeyStatus =
  | { status: "new" }
  | { status: "delivered"; row: AttemptRow }
  | { status: "open"; rows: AttemptRow[] };

/** The lease is held by another run that hasn't expired: this run buys nothing. */
export class LeaseHeldError extends Error {}
/** The branch moved under this run, or this run's lease is gone: stop buying, never retry. */
export class LeaseLostError extends Error {}

/** A commit and its tree: knowing the tree saves a request on every write. */
export type Head = { oid: string; treeOid: string };

/** The few GitHub calls the record needs, so tests can replace them. */
export type GitHubApi = {
  /** The branch head (commit and tree) and both files at it, or null when the branch doesn't exist. */
  readBranch: () => Promise<{ head: Head; ledger: string; lease: string | null } | null>;
  /** A new commit with these files, on top of `parent` (null: the first commit of the branch). */
  commitFiles: (parent: Head | null, files: Record<string, string>, message: string) => Promise<Head>;
  /** Moves the branch from exactly `beforeOid` (all zeros: create it) to `afterOid`; throws if it moved. */
  moveBranch: (beforeOid: string, afterOid: string) => Promise<void>;
};

const OPEN_STATES: ReadonlySet<AttemptState> = new Set(["reserved", "request_sent", "unknown_needs_reconciliation"]);
const ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
  ...OPEN_STATES,
  "quote_refused",
  "delivered",
  "failed_and_credited",
  "failed_not_charged",
  "failed_and_charged",
]);

/** Parses the ledger. A malformed line is an error, never skipped: a lost row could mean buying twice. */
export const parseLedger = (text: string): AttemptRow[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new Error(`${LEDGER_FILE} line ${index + 1} is not JSON: ${String(error)}`);
      }
      const attempt = row as Partial<AttemptRow> | null;
      const problem =
        attempt?.kind !== "attempt"
          ? "is not an attempt row"
          : typeof attempt.attemptId !== "string" || attempt.attemptId === ""
            ? "has no attemptId"
            : !attempt.key || [attempt.key.name, attempt.key.from, attempt.key.to].some((part) => typeof part !== "string" || part === "")
              ? "has no complete key (name, from, to)"
              : !ATTEMPT_STATES.has(attempt.state as AttemptState)
                ? `has an unknown state ${JSON.stringify(attempt.state)}`
                : typeof attempt.minerId !== "string"
                  ? "has no minerId"
                  : null;
      if (problem) throw new Error(`${LEDGER_FILE} line ${index + 1} ${problem}`);
      return attempt as AttemptRow;
    });

const latestByAttempt = (rows: AttemptRow[]): AttemptRow[] => {
  const latest = new Map<string, AttemptRow>();
  for (const row of rows) latest.set(row.attemptId, row);
  return [...latest.values()];
};

/** Whether a key may be bought: a delivered answer is reused (any miner); an open attempt blocks it. */
export const keyStatus = (rows: AttemptRow[], key: PurchaseKey): KeyStatus => {
  const attempts = latestByAttempt(rows).filter((row) => keyId(row.key) === keyId(key));
  const open = attempts.filter((row) => OPEN_STATES.has(row.state));
  if (open.length) return { status: "open", rows: open };
  const delivered = attempts.find((row) => row.state === "delivered");
  return delivered ? { status: "delivered", row: delivered } : { status: "new" };
};

const parseLease = (text: string | null): Lease | null => {
  if (text === null || text.trim() === "") return null;
  const lease = JSON.parse(text) as Partial<Lease>;
  if (typeof lease.token !== "string" || typeof lease.expiresAt !== "string" || Number.isNaN(Date.parse(lease.expiresAt)))
    throw new Error(`${LEASE_FILE} is not a lease`);
  return lease as Lease;
};

const serializeLease = (lease: Lease | null): string => (lease ? `${JSON.stringify(lease, null, 2)}\n` : "");

/**
 * One run's handle on the record: holds the lease from `open` to `release`. All writes go through `write`, which
 * builds on the head this run last saw and fails closed when the branch moved.
 */
export class PurchaseRecord {
  private constructor(
    private readonly github: GitHubApi,
    private readonly lease: Lease,
    private head: Head,
    private ledger: string,
    private ledgerRows: AttemptRow[],
    private readonly now: () => Date,
  ) {}

  /**
   * Acquires the lease. Any attempt still reserved or request_sent belongs to a run that no longer holds the record
   * (its lease expired, or it released the lease without finishing), so it becomes unknown_needs_reconciliation in the
   * same commit: never bought again until a person checks the wallet and escrow.
   */
  static async open(github: GitHubApi, runId: string, now: () => Date = () => new Date()): Promise<PurchaseRecord> {
    const branch = await github.readBranch();
    const ledger = branch?.ledger ?? "";
    const rows = parseLedger(ledger);
    const current = parseLease(branch?.lease ?? null);
    const time = now();
    if (current && Date.parse(current.expiresAt) > time.getTime())
      throw new LeaseHeldError(`run ${current.runId} holds the purchase record until ${current.expiresAt}`);

    const lease: Lease = {
      token: crypto.randomUUID(),
      runId,
      acquiredAt: time.toISOString(),
      expiresAt: new Date(time.getTime() + LEASE_MS).toISOString(),
    };
    const stale = latestByAttempt(rows)
      .filter((row) => row.state === "reserved" || row.state === "request_sent")
      .map(
        (row): AttemptRow => ({
          ...row,
          runId,
          state: "unknown_needs_reconciliation",
          reason: `run ${row.runId} stopped during this attempt (last state ${row.state}); check the wallet and escrow before buying again`,
          time: time.toISOString(),
        }),
      );
    const nextLedger = ledger + stale.map((row) => `${JSON.stringify(row)}\n`).join("");
    const message = `preflight: lease for run ${runId}${stale.length ? `; ${stale.length} stale attempts need reconciliation` : ""}`;
    const files = { [LEDGER_FILE]: nextLedger, [LEASE_FILE]: serializeLease(lease) };
    const after = await github.commitFiles(branch?.head ?? null, files, message);
    try {
      await github.moveBranch(branch?.head.oid ?? ZERO_OID, after.oid);
    } catch (error) {
      // Lost or refused: only a re-read can tell whether the lease is ours.
      const reread = await github.readBranch();
      if (reread?.head.oid !== after.oid)
        throw new LeaseHeldError(`another run took the purchase record first (${String(error)})`.slice(0, 300));
    }
    return new PurchaseRecord(github, lease, after, nextLedger, parseLedger(nextLedger), now);
  }

  get runId(): string {
    return this.lease.runId;
  }

  rows(): AttemptRow[] {
    return this.ledgerRows;
  }

  status(key: PurchaseKey): KeyStatus {
    return keyStatus(this.rows(), key);
  }

  /** True while there is time left on the lease for a paid request to finish. */
  canStartPurchase(): boolean {
    return this.now().getTime() < Date.parse(this.lease.expiresAt) - LEASE_MARGIN_MS;
  }

  /** Appends rows in one commit. A delivered row's receipt must be new: one row per receipt (as in the PR Agent). */
  async append(rows: AttemptRow[]): Promise<void> {
    const receipts = new Set(this.ledgerRows.map((row) => row.receipt?.receiptHash).filter((hash) => hash));
    for (const row of rows) {
      const hash = row.receipt?.receiptHash;
      if (!hash) continue;
      if (receipts.has(hash)) throw new Error(`receipt ${hash} is already recorded`);
      receipts.add(hash);
    }
    const ledger = this.ledger + rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    // Parsed before writing: a row this run can't read back must never reach the branch.
    const ledgerRows = parseLedger(ledger);
    await this.write(ledger, this.lease, `preflight: ${rows.map((row) => `${keyId(row.key)} ${row.state}`).join("; ")}`.slice(0, 200));
    this.ledgerRows = ledgerRows;
  }

  /** Clears the lease so the next run needn't wait for it to expire. */
  async release(): Promise<void> {
    await this.write(this.ledger, null, `preflight: release run ${this.lease.runId}`);
  }

  // No clock check here: past its expiry the lease can be taken over, and a takeover moves the branch, so the
  // compare-and-swap below refuses the write. Until then a late write (say, a delivered row that finished just after
  // expiry) is still this run's and must be kept.
  private async write(ledger: string, lease: Lease | null, message: string): Promise<void> {
    const after = await this.github.commitFiles(this.head, { [LEDGER_FILE]: ledger, [LEASE_FILE]: serializeLease(lease) }, message);
    try {
      await this.github.moveBranch(this.head.oid, after.oid);
    } catch (error) {
      // Refused (the branch moved) or the answer was lost: the write counts only if the head is now our commit.
      const reread = await this.github.readBranch().catch((readError: unknown) => {
        throw new LeaseLostError(`write outcome unknown and the branch can't be read: ${String(readError)}`.slice(0, 300));
      });
      if (reread?.head.oid !== after.oid)
        throw new LeaseLostError(`the ${RECORD_BRANCH} branch moved under this run: ${String(error)}`.slice(0, 300));
    }
    this.head = after;
    this.ledger = ledger;
  }
}

export type GitHubConnection = {
  /** `owner/name` (GITHUB_REPOSITORY). */
  repository: string;
  /** GITHUB_TOKEN with `contents: write`; sent only to GitHub, never logged. */
  token: string;
  /** GITHUB_API_URL and GITHUB_GRAPHQL_URL; github.com when absent. */
  apiUrl?: string;
  graphqlUrl?: string;
};

type BlobObject = { text: string | null; isTruncated: boolean } | null;

/** The record's GitHub calls over the REST and GraphQL APIs (no git checkout, no credentials on disk). */
export const githubApi = (fetcher: typeof fetch, connection: GitHubConnection): GitHubApi => {
  const [owner, name] = connection.repository.split("/");
  if (!owner || !name) throw new Error(`repository must be owner/name, got "${connection.repository}"`);
  const apiUrl = (connection.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const graphqlUrl = connection.graphqlUrl ?? `${apiUrl}/graphql`;
  const headers = {
    Authorization: `Bearer ${connection.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let repositoryId: string | undefined;

  const call = async <T>(url: string, init: RequestInit, what: string): Promise<T> => {
    const response = await fetcher(url, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let body: T & { errors?: { message?: string }[]; message?: string };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${what}: HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok || body.errors?.length)
      throw new Error(`${what}: HTTP ${response.status} ${body.errors?.map((error) => error.message).join("; ") ?? body.message ?? ""}`.slice(0, 300));
    return body;
  };
  const graphql = <T>(query: string, variables: Record<string, unknown>, what: string) =>
    call<{ data: T }>(graphqlUrl, { method: "POST", body: JSON.stringify({ query, variables }) }, what).then((body) => body.data);
  const blobText = (object: BlobObject, path: string): string | null => {
    if (object === null) return null;
    if (object.isTruncated || object.text === null) throw new Error(`${path} on ${RECORD_BRANCH} is too large or binary`);
    return object.text;
  };

  return {
    async readBranch() {
      const data = await graphql<{
        repository: {
          id: string;
          ref: {
            target: { oid: string; tree: { oid: string }; ledger: { object: BlobObject } | null; lease: { object: BlobObject } | null };
          } | null;
        };
      }>(
        `query($owner: String!, $name: String!, $ref: String!) {
          repository(owner: $owner, name: $name) {
            id
            ref(qualifiedName: $ref) {
              target {
                oid
                ... on Commit {
                  tree { oid }
                  ledger: file(path: "${LEDGER_FILE}") { object { ... on Blob { text isTruncated } } }
                  lease: file(path: "${LEASE_FILE}") { object { ... on Blob { text isTruncated } } }
                }
              }
            }
          }
        }`,
        { owner, name, ref: `refs/heads/${RECORD_BRANCH}` },
        `read ${RECORD_BRANCH}`,
      );
      repositoryId = data.repository.id;
      const target = data.repository.ref?.target;
      if (!target) return null;
      return {
        head: { oid: target.oid, treeOid: target.tree.oid },
        ledger: blobText(target.ledger?.object ?? null, LEDGER_FILE) ?? "",
        lease: blobText(target.lease?.object ?? null, LEASE_FILE),
      };
    },

    async commitFiles(parent, files, message) {
      const base = `${apiUrl}/repos/${owner}/${name}/git`;
      const tree = await call<{ sha: string }>(
        `${base}/trees`,
        {
          method: "POST",
          body: JSON.stringify({
            ...(parent ? { base_tree: parent.treeOid } : {}),
            tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
          }),
        },
        "write tree",
      );
      const commit = await call<{ sha: string }>(
        `${base}/commits`,
        { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: parent ? [parent.oid] : [] }) },
        "write commit",
      );
      return { oid: commit.sha, treeOid: tree.sha };
    },

    async moveBranch(beforeOid, afterOid) {
      if (!repositoryId) throw new Error("readBranch must run before moveBranch");
      await graphql(
        `mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }`,
        { input: { repositoryId, refUpdates: [{ name: `refs/heads/${RECORD_BRANCH}`, beforeOid, afterOid }] } },
        `move ${RECORD_BRANCH}`,
      );
    },
  };
};
