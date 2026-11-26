import type { GitHubApi } from "../src/record.js";
import { LEASE_FILE, LEDGER_FILE } from "../src/record.js";

/** An in-memory branch with GitHub's compare-and-swap rule: a move succeeds only from the exact expected head. */
export const fakeGitHub = () => {
  const commits = new Map<string, Record<string, string>>();
  let head: string | null = null;
  let counter = 0;
  const tree = (oid: string) => `t${oid.slice(1)}`;
  const api: GitHubApi & { head: () => string | null; files: () => Record<string, string> } = {
    head: () => head,
    files: () => (head ? commits.get(head)! : {}),
    readBranch: async () =>
      head
        ? { head: { oid: head, treeOid: tree(head) }, ledger: commits.get(head)![LEDGER_FILE] ?? "", lease: commits.get(head)![LEASE_FILE] ?? null }
        : null,
    commitFiles: async (parent, files) => {
      if (parent && parent.treeOid !== tree(parent.oid)) throw new Error("wrong parent tree");
      const oid = `c${++counter}`.padEnd(40, "0");
      commits.set(oid, { ...(parent ? commits.get(parent.oid) : {}), ...files });
      return { oid, treeOid: tree(oid) };
    },
    moveBranch: async (beforeOid, afterOid) => {
      if ((head ?? "0".repeat(40)) !== beforeOid) throw new Error(`ref moved: expected ${beforeOid}, is ${head}`);
      head = afterOid;
    },
  };
  return api;
};

