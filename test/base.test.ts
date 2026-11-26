import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { fetchBaseFiles } from "../src/base.js";
import { discover } from "../src/lockfiles.js";
import { DEFAULT_KEY_PACKAGES } from "../src/verdict.js";
import { FIXTURES, loadRecording, replayFetcher } from "./helpers.js";

const SHA = "a".repeat(40);
const listFiles = (root: string, directory = root): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(root, join(directory, entry.name)) : [relative(root, join(directory, entry.name)).split(sep).join("/")],
  );

/** Serves a directory as a commit's tree and blobs, like the GitHub API; records every URL asked for. */
const githubServing = (root: string, extra: { path: string; type: string; sha: string; size?: number }[] = [], truncated = false) => {
  const urls: string[] = [];
  const files = listFiles(root);
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const href = String(url);
    if (href.endsWith(`/git/trees/${SHA}?recursive=1`))
      return Response.json({
        truncated,
        tree: [
          ...files.map((path) => ({ path, type: "blob", sha: Buffer.from(path).toString("hex"), size: statSync(join(root, path)).size })),
          { path: "sdk/src", type: "tree", sha: "t" },
          ...extra,
        ],
      });
    const blob = href.match(/\/git\/blobs\/([0-9a-f]+)$/);
    if (blob) return new Response(readFileSync(join(root, Buffer.from(blob[1], "hex").toString())));
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
};

describe("fetchBaseFiles (T030): the base without a checkout", () => {
  it("drift sdk/: downloads only dependency files, and the base assesses exactly like the files themselves", async () => {
    const fixture = join(FIXTURES, "real/drift-sdk/files");
    const { fetcher, urls } = githubServing(fixture, [
      { path: "sdk/src/index.ts", type: "blob", sha: "00", size: 10 },
      { path: "sdk/node_modules/x/package.json", type: "blob", sha: "01", size: 10 },
    ]);
    const root = await fetchBaseFiles(fetcher, { repository: "lemind/protocol-v2", token: "t" }, SHA, "sdk");
    expect(urls.filter((url) => url.includes("/blobs/"))).toHaveLength(2); // sdk/package.json and sdk/yarn.lock
    expect(listFiles(root).sort()).toEqual(["sdk/package.json", "sdk/yarn.lock"]);
    const osv = replayFetcher(loadRecording("real/drift-sdk/osv.json"));
    const fromBase = await assess(join(root, "sdk"), DEFAULT_KEY_PACKAGES, osv, "sdk");
    const direct = await assess(join(fixture, "sdk"), DEFAULT_KEY_PACKAGES, osv, "sdk");
    expect(fromBase.verdict).toBe(direct.verdict);
    expect(fromBase.lockedVersionCount).toBe(direct.lockedVersionCount);
    expect(fromBase.advisories.map((finding) => `${finding.package.name}@${finding.package.version}`)).toEqual(
      direct.advisories.map((finding) => `${finding.package.name}@${finding.package.version}`),
    );
  });

  it("an oversized base lockfile is not downloaded and is reported as failed, like on the head", async () => {
    const fixture = join(FIXTURES, "controlled/clean-web3js-1.95.8");
    const { fetcher, urls } = githubServing(fixture, [{ path: "big/package-lock.json", type: "blob", sha: "02", size: 70 * 1024 * 1024 }]);
    const root = await fetchBaseFiles(fetcher, { repository: "o/r", token: "t" }, SHA, ".");
    expect(urls.some((url) => url.endsWith("/blobs/02"))).toBe(false);
    expect(statSync(join(root, "big/package-lock.json")).size).toBe(70 * 1024 * 1024);
    expect(discover(root).lockfiles.find((report) => report.path === "big/package-lock.json")).toMatchObject({ status: "failed", reason: expect.stringMatching(/larger than/) });
  });

  it("refuses a truncated tree listing, an unsafe path and a malformed SHA rather than assessing part of the base", async () => {
    const fixture = join(FIXTURES, "controlled/clean-web3js-1.95.8");
    await expect(fetchBaseFiles(githubServing(fixture, [], true).fetcher, { repository: "o/r", token: "t" }, SHA, ".")).rejects.toThrow(/too large to list/);
    await expect(
      fetchBaseFiles(githubServing(fixture, [{ path: "../evil/package.json", type: "blob", sha: "03", size: 1 }]).fetcher, { repository: "o/r", token: "t" }, SHA, "."),
    ).rejects.toThrow(/unsafe path/);
    await expect(fetchBaseFiles(githubServing(fixture).fetcher, { repository: "o/r", token: "t" }, "main", ".")).rejects.toThrow(/40-character SHA/);
  });
});
