import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDependencyFile, maxDependencyFileBytes } from "./lockfiles.js";

/**
 * A pull request's base, materialised without a second checkout and without running anything: the base commit's tree
 * is listed through the GitHub API, and only the files discovery reads (lockfiles, manifests, other ecosystems'
 * dependency files) under the assessed path are downloaded into a temporary directory (T030, FR-014).
 */
export type BaseSource = { repository: string; token: string; apiUrl?: string };

/** More files than any target we've seen (wallet-adapter has 47 manifests); a cap on what a base can make us fetch. */
const MAX_FILES = 2000;
const CONCURRENCY = 6;

type TreeEntry = { path: string; type: string; sha: string; size?: number };

export const fetchBaseFiles = async (fetcher: typeof fetch, source: BaseSource, baseSha: string, path: string): Promise<string> => {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`base commit must be a 40-character SHA, got "${baseSha}"`);
  const apiUrl = (source.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${source.token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const get = async (url: string, accept: string, what: string): Promise<Response> => {
    const response = await fetcher(url, { headers: { ...headers, Accept: accept }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  };

  const tree = (await (
    await get(`${apiUrl}/repos/${source.repository}/git/trees/${baseSha}?recursive=1`, "application/vnd.github+json", "list the base tree")
  ).json()) as { tree: TreeEntry[]; truncated: boolean };
  // A truncated listing could miss a lockfile: then the base is not assessed rather than assessed in part.
  if (tree.truncated) throw new Error("the base tree is too large to list in one request");
  const prefix = path === "." ? "" : `${path}/`;
  const unsafe = tree.tree.find((entry) => entry.path.startsWith("/") || entry.path.split("/").some((part) => part === ".." || part === "." || part === ""));
  if (unsafe) throw new Error(`the base tree has an unsafe path: ${JSON.stringify(unsafe.path.slice(0, 200))}`);
  const wanted = tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix) && isDependencyFile(entry.path));
  if (wanted.length > MAX_FILES) throw new Error(`the base has ${wanted.length} dependency files, more than ${MAX_FILES}`);

  const root = mkdtempSync(join(tmpdir(), "preflight-base-"));
  const queue = [...wanted];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const target = join(root, ...entry.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      // Oversized or binary files only need to exist: discovery reports them by name and size, as on the head.
      if ((entry.size ?? 0) > maxDependencyFileBytes(entry.path) || entry.path.endsWith(".lockb")) {
        writeFileSync(target, "");
        // A sparse file of the real size: discovery refuses it as oversized without anything being downloaded.
        if (!entry.path.endsWith(".lockb")) truncateSync(target, entry.size ?? 0);
        continue;
      }
      const blob = await get(`${apiUrl}/repos/${source.repository}/git/blobs/${entry.sha}`, "application/vnd.github.raw+json", `download ${entry.path}`);
      writeFileSync(target, Buffer.from(await blob.arrayBuffer()));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return root;
};
