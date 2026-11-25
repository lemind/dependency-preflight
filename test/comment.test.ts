import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { commentMarker, MAX_COMMENT_CHARACTERS, renderComment, upsertComment } from "../src/comment.js";
import { compare } from "../src/compare.js";
import { DEFAULT_KEY_PACKAGES, type Assessment } from "../src/verdict.js";
import { FIXTURES, loadRecording, replayFetcher } from "./helpers.js";

const controlled = async () => {
  const registry = { "@solana/web3.js": { latest: "1.95.8", versions: ["1.95.5", "1.95.8"] } };
  const run = (directory: string) => assess(join(FIXTURES, directory), DEFAULT_KEY_PACKAGES, replayFetcher(loadRecording("controlled/osv.json"), registry));
  return { base: await run("controlled/compromised-web3js-1.95.6"), head: await run("controlled/clean-web3js-1.95.8") };
};
const emptyBase = (head: Assessment): Assessment => ({ ...head, verdict: "ready", advisories: [], outdated: [], notChecked: [], latestUnknown: [] });

describe("renderComment (T031, R12)", () => {
  it("remediation: base and head verdicts, the malware finding resolved, and the no-build line (SC-006)", async () => {
    const { base, head } = await controlled();
    const body = renderComment(compare(base, head), head, { path: ".", runUrl: "https://github.com/o/r/actions/runs/1" });
    expect(body.startsWith(commentMarker("."))).toBe(true);
    expect(body).toContain("| Verdict | 🛑 blocked | **✅ ready** |");
    // Two advisories that aren't aliases (the malware record and GHSA-jcxm-7wvp-g6p5), and a patch-level outdated entry.
    expect(body).toContain("Findings: 3 resolved · 0 still open · 0 new · 0 not verified.");
    expect(body).toMatch(/\*\*Resolved\*\* \(2 that affect the verdict\)\n\n- 🔑 `@solana\/web3.js` `1.95.6` in `.`: \*\*malicious\*\* \[MAL-2024-11183\]/);
    expect(body).toContain("[GHSA-jcxm-7wvp-g6p5]");
    expect(body).not.toContain("release behind"); // a patch gap doesn't affect the verdict
    expect(body).toContain("[Full report](https://github.com/o/r/actions/runs/1)");
    expect(body).toContain("no code was built, tested or run");
  });

  it("stays under the comment limit on the largest fixture (wallet-adapter, everything new)", async () => {
    const head = await assess(join(FIXTURES, "real/wallet-adapter/files"), DEFAULT_KEY_PACKAGES, replayFetcher(loadRecording("real/wallet-adapter/osv.json")));
    const body = renderComment(compare(emptyBase(head), head), head, { path: "." });
    expect(body.length).toBeLessThan(MAX_COMMENT_CHARACTERS);
    expect(body).toMatch(/… \d+ more in the full report/);
  });

  it("says so when the base could not be assessed, without inventing a comparison", async () => {
    const { head } = await controlled();
    const body = renderComment(undefined, head, { path: "sdk", baseError: "the base tree is too large to list in one request" });
    expect(body).toContain("The base branch could not be assessed, so nothing is compared: the base tree is too large to list in one request.");
    expect(body).not.toContain("resolved");
  });
});

describe("upsertComment", () => {
  const fakeIssues = () => {
    const comments: { id: number; body: string; html_url: string }[] = [{ id: 1, body: "unrelated", html_url: "u1" }];
    const calls: string[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method} ${href.replace("https://api.github.com/repos/o/r/issues", "")}`);
      if (init?.method === "GET") return Response.json(comments);
      const body = JSON.parse(String(init?.body)).body as string;
      if (init?.method === "POST") {
        comments.push({ id: comments.length + 1, body, html_url: `u${comments.length + 1}` });
        return Response.json(comments.at(-1));
      }
      const id = Number(href.split("/").pop());
      comments.find((comment) => comment.id === id)!.body = body;
      return Response.json(comments.find((comment) => comment.id === id));
    }) as unknown as typeof fetch;
    return { comments, calls, fetcher };
  };

  it("creates one comment, then updates that same comment on the next run", async () => {
    const { comments, calls, fetcher } = fakeIssues();
    const target = { repository: "o/r", token: "t", pullNumber: 7 };
    expect(await upsertComment(fetcher, target, `${commentMarker("sdk")}\nfirst\n`)).toBe("u2");
    expect(await upsertComment(fetcher, target, `${commentMarker("sdk")}\nsecond\n`)).toBe("u2");
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toContain("second");
    expect(calls).toEqual([
      "GET /7/comments?per_page=100&page=1",
      "POST /7/comments",
      "GET /7/comments?per_page=100&page=1",
      "PATCH /comments/2",
    ]);
    // Another assessed path gets its own comment.
    expect(await upsertComment(fetcher, target, `${commentMarker(".")}\nroot\n`)).toBe("u3");
  });

  it("fails with the HTTP status when the token can't comment (e.g. read-only)", async () => {
    const fetcher = (async () => new Response("Resource not accessible by integration", { status: 403 })) as unknown as typeof fetch;
    await expect(upsertComment(fetcher, { repository: "o/r", token: "t", pullNumber: 7 }, `${commentMarker(".")}\nx\n`)).rejects.toThrow(/list comments: HTTP 403/);
  });
});
