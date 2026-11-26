import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob, posix } from "node:path";
import { parseSyml } from "@yarnpkg/parsers";
import semver from "semver";

// Lockfiles and manifests are untrusted input: they are parsed as data, never executed.

export type LockfileFormat = "npm" | "pnpm" | "yarn1";

/**
 * How a workspace member uses a locked package. `direct`: declared in the member's manifest (runtime or dev).
 * `runtime`: reachable from its runtime declarations. `directRuntime`: declared in its runtime declarations; a direct
 * devDependency that is also pulled in at runtime by something else is direct and runtime, but not directRuntime.
 */
export type Usage = { member: string; direct: boolean; runtime: boolean; directRuntime: boolean };

/** A local install name that differs from the registry package it resolves to. */
export type LocalName = { name: string; kind: "alias" | "override" };

export type LockedPackage = {
  /** Registry package name, verified against the lockfile resolution. */
  name: string;
  version: string;
  lockfile: string;
  localNames: LocalName[];
  /** Empty when no workspace member reaches the package. */
  usages: Usage[];
};

export type NotAssessedDependency = {
  name: string;
  source: string;
  reason: string;
  lockfile: string;
  usages: Usage[];
};

export type LockfileReport =
  | {
      path: string;
      format: LockfileFormat;
      status: "assessed";
      members: string[];
      packages: LockedPackage[];
      notAssessed: NotAssessedDependency[];
    }
  | { path: string; status: "not-assessed"; reason: string }
  | { path: string; format: LockfileFormat; status: "failed"; reason: string };

export type Discovery = {
  lockfiles: LockfileReport[];
  /** Dependency files of other ecosystems, e.g. Rust's Cargo.lock. */
  otherDependencyFiles: { path: string; ecosystem: string }[];
  /** Manifests that declare dependencies but no assessed lockfile pins them. */
  manifestsWithoutLockfile: string[];
};

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "third_party",
  "bower_components",
  ".yarn",
]);
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DEPTH = 25;

const NPM_LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const UNSUPPORTED_LOCKFILES: Record<string, string> = {
  "bun.lock": "Bun lockfiles are not assessed in this version",
  "bun.lockb": "Bun lockfiles are not assessed in this version",
};
const OTHER_ECOSYSTEMS: Record<string, string> = {
  "Cargo.lock": "Rust",
  "go.sum": "Go",
  "poetry.lock": "Python",
  "uv.lock": "Python",
  "Pipfile.lock": "Python",
  "Gemfile.lock": "Ruby",
  "composer.lock": "PHP",
};

/**
 * Whether discovery reads a file at this repository path: lockfiles, manifests and other ecosystems' dependency files
 * outside skipped directories. Used to fetch only these files of a pull request's base (src/base.ts).
 */
export const isDependencyFile = (path: string): boolean => {
  const parts = path.split("/");
  if (parts.length - 1 > MAX_DEPTH || parts.slice(0, -1).some((part) => SKIPPED_DIRECTORIES.has(part))) return false;
  const filename = parts[parts.length - 1];
  return (
    filename === "package.json" ||
    filename === "pnpm-lock.yaml" ||
    filename === "yarn.lock" ||
    NPM_LOCKFILES.has(filename) ||
    filename in UNSUPPORTED_LOCKFILES ||
    filename in OTHER_ECOSYSTEMS
  );
};

/** Largest file discovery reads, by name. */
export const maxDependencyFileBytes = (path: string): number =>
  path.endsWith("package.json") ? MAX_MANIFEST_BYTES : MAX_LOCKFILE_BYTES;

type Manifest = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
};

type Tree = { files: string[]; fileSet: Set<string>; manifests: Map<string, Manifest | undefined> };

/** Lists repository files without following symlinks or entering skipped directories. */
const walk = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path, depth + 1);
      } else if (entry.isFile()) files.push(path);
    }
  };
  visit("", 0);
  return files.sort();
};

const readRegularFile = (root: string, path: string, maxBytes: number): string => {
  const stats = lstatSync(join(root, path));
  if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
  if (stats.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`);
  return readFileSync(join(root, path), "utf8");
};

const readManifest = (root: string, path: string): Manifest | undefined => {
  try {
    const parsed = JSON.parse(readRegularFile(root, path, MAX_MANIFEST_BYTES));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // An unreadable manifest is treated as missing; the lockfile's own records are used instead.
    return undefined;
  }
};

const directoryOf = (path: string): string => {
  const directory = posix.dirname(path);
  return directory === "." ? "" : directory;
};

/** Joins repository-relative paths; "" is the repository root, reported as ".". */
const repoPath = (directory: string, member: string): string => {
  const joined = posix.normalize(posix.join(directory || ".", member || "."));
  return joined === "./" ? "." : joined.replace(/\/$/, "");
};

const isInside = (path: string): boolean => path !== ".." && !path.startsWith("../") && !posix.isAbsolute(path);

const hasDependencies = (manifest: Manifest | undefined): boolean =>
  !!manifest &&
  ["dependencies", "devDependencies", "optionalDependencies"].some(
    (section) => Object.keys((manifest as Record<string, Record<string, string>>)[section] ?? {}).length > 0,
  );

// ---------------------------------------------------------------------------------------------------------------
// Package identity

const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;

/** Splits "name@rest" where name may be scoped. */
const splitAt = (descriptor: string): { name: string; rest: string } | undefined => {
  const match = descriptor.match(/^((?:@[^/@]+\/)?[^/@]+)@(.*)$/);
  return match ? { name: match[1], rest: match[2] } : undefined;
};

/** Reads the package name and version from a registry tarball URL: <registry>/<name>/-/<basename>-<version>.tgz */
export const tarballIdentity = (url: string): { name: string; version: string } | undefined => {
  let pathname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  const match = pathname.match(/(?:^|\/)((?:@[^/]+\/)?[^/@][^/]*)\/-\/(?:@[^/]+\/)?([^/]+)\.tgz$/);
  if (!match) return undefined;
  const name = match[1];
  const basename = name.split("/").pop()!;
  if (!match[2].startsWith(`${basename}-`)) return undefined;
  const version = match[2].slice(basename.length + 1);
  return semver.valid(version) ? { name, version } : undefined;
};

const NON_REGISTRY = /^(?:git\+|git:|github:|gitlab:|bitbucket:|file:|link:|portal:|patch:|workspace:|exec:)/;

/** Real package named by an "npm:<name>@<range>" specifier, if it is one. */
const npmAliasTarget = (specifier: string | undefined): string | undefined => {
  if (!specifier?.startsWith("npm:")) return undefined;
  return splitAt(specifier.slice(4))?.name ?? specifier.slice(4);
};

/** Local names replaced through overrides or resolutions by a registry package ("npm:<name>@<range>"), mapped to that package. */
const overrideTargets = (manifest: Manifest | undefined, lockOverrides?: Record<string, unknown>): Map<string, string> => {
  const targets = new Map<string, string>();
  const collect = (map: Record<string, unknown> | undefined) => {
    for (const [selector, value] of Object.entries(map ?? {})) {
      const target = typeof value === "string" ? npmAliasTarget(value) : undefined;
      if (!target) continue;
      // Selectors can be "name", "name@range", "parent>name" or "**/name"; the replaced name is the last part.
      const last = selector.split(">").pop()!.replace(/^(?:\*\*\/)+/, "");
      const scoped = last.match(/^(?:.*\/)?(@[^/@]+\/[^/@]+)(?:@.*)?$/)?.[1];
      targets.set(scoped ?? splitAt(last.split("/").pop()!)?.name ?? last.split("/").pop()!, target);
    }
  };
  collect(manifest?.overrides);
  collect(manifest?.resolutions);
  collect(manifest?.pnpm?.overrides);
  collect(lockOverrides);
  return targets;
};

// ---------------------------------------------------------------------------------------------------------------
// Dependency graph shared by all formats

type GraphNode =
  | { kind: "package"; name: string; version: string; localName: string; edges: string[] }
  | { kind: "member"; path: string; edges: string[] }
  | { kind: "unassessed"; name: string; source: string; reason: string };

type Member = { path: string; runtimeRoots: string[]; devRoots: string[] };

type Graph = { nodes: Map<string, GraphNode>; members: Member[] };

const reach = (graph: Graph, roots: string[]): Set<string> => {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes.get(id);
    if (node && node.kind !== "unassessed") queue.push(...node.edges);
  }
  return seen;
};

const collect = (
  graph: Graph,
  lockfile: string,
  lockDirectory: string,
  overrides: Map<string, string>,
): Pick<Extract<LockfileReport, { status: "assessed" }>, "members" | "packages" | "notAssessed"> => {
  const usages = new Map<string, Map<string, Usage>>();
  for (const member of graph.members) {
    const memberPath = repoPath(lockDirectory, member.path);
    const runtime = reach(graph, member.runtimeRoots);
    const all = new Set([...runtime, ...reach(graph, member.devRoots)]);
    const direct = new Set([...member.runtimeRoots, ...member.devRoots]);
    const directRuntime = new Set(member.runtimeRoots);
    for (const id of all) {
      if (!usages.has(id)) usages.set(id, new Map());
      usages.get(id)!.set(memberPath, {
        member: memberPath,
        direct: direct.has(id),
        runtime: runtime.has(id),
        directRuntime: directRuntime.has(id),
      });
    }
  }
  const packages = new Map<string, LockedPackage>();
  const notAssessed = new Map<string, NotAssessedDependency>();
  const merge = (target: Usage[], found: Map<string, Usage> | undefined) => {
    for (const usage of found?.values() ?? []) {
      const existing = target.find((candidate) => candidate.member === usage.member);
      if (!existing) target.push({ ...usage });
      else {
        existing.direct ||= usage.direct;
        existing.runtime ||= usage.runtime;
        existing.directRuntime ||= usage.directRuntime;
      }
    }
  };
  for (const [id, node] of graph.nodes) {
    if (node.kind === "package") {
      const key = `${node.name}@${node.version}`;
      if (!packages.has(key))
        packages.set(key, { name: node.name, version: node.version, lockfile, localNames: [], usages: [] });
      const locked = packages.get(key)!;
      if (node.localName !== node.name && !locked.localNames.some((local) => local.name === node.localName))
        locked.localNames.push({ name: node.localName, kind: overrides.has(node.localName) ? "override" : "alias" });
      merge(locked.usages, usages.get(id));
    } else if (node.kind === "unassessed") {
      const key = `${node.name}|${node.source}`;
      if (!notAssessed.has(key))
        notAssessed.set(key, { name: node.name, source: node.source, reason: node.reason, lockfile, usages: [] });
      merge(notAssessed.get(key)!.usages, usages.get(id));
    }
  }
  const byMember = (a: Usage, b: Usage) => a.member.localeCompare(b.member);
  return {
    members: graph.members.map((member) => repoPath(lockDirectory, member.path)).sort(),
    packages: [...packages.values()]
      .map((locked) => ({ ...locked, usages: locked.usages.sort(byMember) }))
      .sort((a, b) => a.name.localeCompare(b.name) || semver.compare(a.version, b.version)),
    notAssessed: [...notAssessed.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
};

const unassessed = (name: string, source: string, reason: string): GraphNode => ({
  kind: "unassessed",
  name,
  source,
  reason,
});

const sourceReason = (source: string): string =>
  /^(?:git|github:|gitlab:|bitbucket:)|^https:\/\/codeload\.github\.com\//.test(source)
    ? "Git dependency"
    : /^(?:file:|link:|portal:)/.test(source)
      ? "local path dependency"
      : /^https?:/.test(source)
        ? "URL dependency, not a registry package"
        : "not a registry package";

// ---------------------------------------------------------------------------------------------------------------
// npm package-lock.json v2/v3

type NpmEntry = {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const npmGraph = (content: string, manifestAt: (member: string) => Manifest | undefined): Graph => {
  const lock = JSON.parse(content);
  if (![2, 3].includes(lock?.lockfileVersion))
    throw new Error(`npm lockfile version ${lock?.lockfileVersion} is not supported (v2 and v3 are)`);
  const entries: Record<string, NpmEntry> = lock.packages ?? {};
  const nodes = new Map<string, GraphNode>();
  const isMemberKey = (key: string) => key === "" || !/(^|\/)node_modules\//.test(key);
  const localNameOf = (key: string) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  const nodeId = (key: string) => (isMemberKey(key) ? `member:${key}` : `npm:${key}`);

  // npm's lookup: <from>/node_modules/<name>, then each ancestor node_modules up to the root.
  const resolve = (from: string, name: string): string | undefined => {
    let base = from;
    for (;;) {
      const key = `${base ? `${base}/` : ""}node_modules/${name}`;
      const entry = entries[key];
      if (entry) {
        if (entry.link && entry.resolved) return nodeId(entry.resolved);
        return nodeId(key);
      }
      if (!base) return undefined;
      const parent = base.lastIndexOf("/node_modules/");
      base = parent === -1 ? "" : base.slice(0, parent);
    }
  };
  const edgesFrom = (key: string, sections: (keyof NpmEntry)[], declared: NpmEntry) =>
    sections
      .flatMap((section) => Object.keys((declared[section] as Record<string, string>) ?? {}))
      .map((name) => resolve(key, name))
      .filter((id): id is string => !!id);

  const members: Member[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.link) continue;
    if (isMemberKey(key)) {
      const declared: NpmEntry = manifestAt(key) ?? entry;
      const runtimeRoots = edgesFrom(key, ["dependencies", "optionalDependencies", "peerDependencies"], declared);
      nodes.set(nodeId(key), { kind: "member", path: key, edges: runtimeRoots });
      members.push({ path: key, runtimeRoots, devRoots: edgesFrom(key, ["devDependencies"], declared) });
      continue;
    }
    const localName = localNameOf(key);
    const name = entry.name ?? localName;
    const source = entry.resolved ?? "";
    if (!entry.version || !semver.valid(entry.version) || NON_REGISTRY.test(source)) {
      nodes.set(nodeId(key), unassessed(localName, source || entry.version || key, sourceReason(source || entry.version || "")));
      continue;
    }
    const fromTarball = source ? tarballIdentity(source) : undefined;
    if (source && !fromTarball) {
      nodes.set(nodeId(key), unassessed(localName, source, sourceReason(source)));
      continue;
    }
    // Identity: the lock entry's name and version must match its registry tarball. An alias needs a tarball to verify.
    if (
      !PACKAGE_NAME.test(name) ||
      (fromTarball && (fromTarball.name !== name || fromTarball.version !== entry.version)) ||
      (name !== localName && !fromTarball)
    ) {
      nodes.set(nodeId(key), unassessed(localName, source || `${name}@${entry.version}`, "package identity could not be verified"));
      continue;
    }
    nodes.set(nodeId(key), {
      kind: "package",
      name,
      version: entry.version,
      localName,
      edges: edgesFrom(key, ["dependencies", "optionalDependencies", "peerDependencies"], entry),
    });
  }
  return { nodes, members };
};

// ---------------------------------------------------------------------------------------------------------------
// pnpm-lock.yaml v6/v9

type PnpmImporterSection = Record<string, { specifier?: string; version?: string } | string>;
type PnpmImporter = {
  dependencies?: PnpmImporterSection;
  devDependencies?: PnpmImporterSection;
  optionalDependencies?: PnpmImporterSection;
  specifiers?: Record<string, string>;
};
type PnpmPackage = {
  resolution?: { integrity?: string; tarball?: string; type?: string; directory?: string; repo?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const pnpmGraph = (content: string, rootManifest: Manifest | undefined): { graph: Graph; overrides: Map<string, string> } => {
  const lock = parseSyml(content);
  const major = Math.floor(Number(lock?.lockfileVersion));
  if (major !== 6 && major !== 9)
    throw new Error(`pnpm lockfile version ${lock?.lockfileVersion} is not supported (v6 and v9 are)`);
  const packages: Record<string, PnpmPackage> = lock.packages ?? {};
  const snapshots: Record<string, PnpmPackage> = major === 9 ? (lock.snapshots ?? {}) : packages;
  const importers: Record<string, PnpmImporter> = lock.importers ?? { ".": lock };
  const nodes = new Map<string, GraphNode>();
  const overrides = overrideTargets(rootManifest, lock.overrides);

  const nodeFor = (localName: string, reference: string, fromImporter: string, specifier?: string): string => {
    if (reference.startsWith("link:")) {
      const target = posix.normalize(posix.join(fromImporter, reference.slice(5)));
      if (importers[target] || (target === "." && importers["."])) return `member:${target}`;
    }
    const base = reference.split("(")[0];
    const alias = major === 9 ? splitAt(base) : base.startsWith("/") ? splitAt(base.slice(1)) : undefined;
    const name = alias?.name ?? localName;
    const version = alias?.rest ?? base;
    const snapshotKey = major === 9 ? `${name}@${reference.slice(alias ? name.length + 1 : 0)}` : `/${name}@${reference.slice(alias ? name.length + 2 : 0)}`;
    // Aliased installs get their own node so the local name is kept; both report the same registry package.
    const id = alias ? `pnpm:${localName}>${snapshotKey}` : `pnpm:${snapshotKey}`;
    if (nodes.has(id)) return id;
    if (NON_REGISTRY.test(reference) || !semver.valid(version)) {
      nodes.set(id, unassessed(localName, reference, sourceReason(reference)));
      return id;
    }
    const resolution = packages[major === 9 ? `${name}@${version}` : snapshotKey]?.resolution;
    const tarball = resolution?.tarball ? tarballIdentity(resolution.tarball) : undefined;
    // An importer specifier states the alias target; an override replaces the specifier's package.
    const declaredTarget = npmAliasTarget(specifier) ?? overrides.get(localName);
    if (
      !resolution ||
      resolution.type ||
      resolution.directory ||
      (resolution.tarball && (!tarball || tarball.name !== name || tarball.version !== version)) ||
      !PACKAGE_NAME.test(name) ||
      (declaredTarget !== undefined && declaredTarget !== name) ||
      (alias && declaredTarget === undefined && specifier !== undefined)
    ) {
      nodes.set(
        id,
        unassessed(localName, reference, resolution?.type || resolution?.directory ? sourceReason(resolution.type ?? "file:") : "package identity could not be verified"),
      );
      return id;
    }
    const snapshot = snapshots[snapshotKey] ?? {};
    const node: GraphNode = { kind: "package", name, version, localName, edges: [] };
    nodes.set(id, node);
    for (const section of [snapshot.dependencies, snapshot.optionalDependencies])
      for (const [dependency, dependencyReference] of Object.entries(section ?? {}))
        node.edges.push(nodeFor(dependency, String(dependencyReference), "."));
    return id;
  };

  const members: Member[] = [];
  const rootsOf = (path: string, importer: PnpmImporter, sections: (keyof PnpmImporter)[]) =>
    sections.flatMap((section) =>
      Object.entries((importer[section] as PnpmImporterSection) ?? {}).map(([name, value]) =>
        typeof value === "string"
          ? nodeFor(name, value, path, importer.specifiers?.[name])
          : nodeFor(name, String(value.version), path, value.specifier),
      ),
    );
  for (const [path, importer] of Object.entries(importers)) {
    const runtimeRoots = rootsOf(path, importer, ["dependencies", "optionalDependencies"]);
    nodes.set(`member:${path}`, { kind: "member", path, edges: runtimeRoots });
    members.push({ path, runtimeRoots, devRoots: rootsOf(path, importer, ["devDependencies"]) });
  }
  // Every locked package is assessed, including entries no member reaches.
  for (const key of Object.keys(snapshots)) {
    const descriptor = splitAt(major === 9 ? key : key.replace(/^\//, ""));
    if (descriptor) nodeFor(descriptor.name, descriptor.rest, ".");
  }
  return { graph: { nodes, members }, overrides };
};

// ---------------------------------------------------------------------------------------------------------------
// Yarn 1 yarn.lock

type YarnEntry = {
  version?: string;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const yarnGraph = (
  content: string,
  rootManifest: Manifest | undefined,
  workspaceMembers: { path: string; manifest: Manifest }[],
  overrides: Map<string, string>,
): Graph => {
  const lock = parseSyml(content) as Record<string, YarnEntry>;
  const nodes = new Map<string, GraphNode>();
  const memberByName = new Map(
    workspaceMembers.filter((member) => member.manifest.name).map((member) => [member.manifest.name!, member.path]),
  );
  const nodeFor = (localName: string, range: string): string | undefined => {
    const entry = lock[`${localName}@${range}`];
    if (!entry) {
      const member = memberByName.get(localName);
      return member !== undefined ? `member:${member}` : undefined;
    }
    const name = npmAliasTarget(range) ?? overrides.get(localName) ?? localName;
    const version = entry.version ?? "";
    const source = entry.resolved ?? "";
    const id = `yarn:${name === localName ? "" : `${localName}>`}${name}@${version}|${source}`;
    if (nodes.has(id)) return id;
    if (NON_REGISTRY.test(range.replace(/^npm:/, "")) || !semver.valid(version) || !source) {
      nodes.set(id, unassessed(localName, source || range, sourceReason(source || range)));
      return id;
    }
    const tarball = tarballIdentity(source);
    if (!tarball) {
      nodes.set(id, unassessed(localName, source, sourceReason(source)));
      return id;
    }
    if (tarball.name !== name || tarball.version !== version || !PACKAGE_NAME.test(name)) {
      nodes.set(id, unassessed(localName, source, "package identity could not be verified"));
      return id;
    }
    const node: GraphNode = { kind: "package", name, version, localName, edges: [] };
    nodes.set(id, node);
    for (const section of [entry.dependencies, entry.optionalDependencies])
      for (const [dependency, dependencyRange] of Object.entries(section ?? {})) {
        const target = nodeFor(dependency, String(dependencyRange));
        if (target) node.edges.push(target);
      }
    return id;
  };
  const missing = (member: string, name: string, range: string) => {
    const id = `missing:${member}:${name}@${range}`;
    nodes.set(id, unassessed(name, range, "declared in the manifest but not found in the lockfile"));
    return id;
  };
  const rootsOf = (path: string, manifest: Manifest, sections: (keyof Manifest)[]) =>
    sections.flatMap((section) =>
      Object.entries((manifest[section] as Record<string, string>) ?? {}).map(
        ([name, range]) => nodeFor(name, String(range)) ?? missing(path, name, String(range)),
      ),
    );
  const members: Member[] = [];
  for (const { path, manifest } of [{ path: "", manifest: rootManifest ?? {} }, ...workspaceMembers]) {
    // Yarn 1 doesn't install peers; members are typed by what they install.
    const runtimeRoots = rootsOf(path, manifest, ["dependencies", "optionalDependencies"]);
    nodes.set(`member:${path}`, { kind: "member", path, edges: runtimeRoots });
    members.push({ path, runtimeRoots, devRoots: rootsOf(path, manifest, ["devDependencies"]) });
  }
  // Every locked package is assessed, including entries no member reaches (e.g. kept by "resolutions").
  for (const selector of Object.keys(lock)) {
    const descriptor = splitAt(selector);
    if (descriptor && selector !== "__metadata") nodeFor(descriptor.name, descriptor.rest);
  }
  return { nodes, members };
};

const workspacePatterns = (manifest: Manifest | undefined): string[] => {
  const workspaces = manifest?.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  return patterns.filter((pattern): pattern is string => typeof pattern === "string");
};

// ---------------------------------------------------------------------------------------------------------------
// Discovery

const assessLockfile = (root: string, path: string, tree: Tree): LockfileReport => {
  const filename = posix.basename(path);
  const lockDirectory = directoryOf(path);
  const manifestPath = (member: string) => repoPath(lockDirectory, posix.join(member || ".", "package.json"));
  const manifestAt = (member: string): Manifest | undefined => {
    const target = manifestPath(member);
    if (!isInside(target)) return undefined;
    if (!tree.manifests.has(target)) tree.manifests.set(target, tree.fileSet.has(target) ? readManifest(root, target) : undefined);
    return tree.manifests.get(target);
  };
  const format: LockfileFormat = NPM_LOCKFILES.has(filename) ? "npm" : filename === "pnpm-lock.yaml" ? "pnpm" : "yarn1";
  let content: string;
  try {
    content = readRegularFile(root, path, MAX_LOCKFILE_BYTES);
  } catch (error) {
    return { path, format, status: "failed", reason: (error as Error).message };
  }
  if (format === "yarn1" && !/^#\s*yarn lockfile v1\s*$/m.test(content.split("\n").slice(0, 5).join("\n")))
    return {
      path,
      status: "not-assessed",
      reason: /^__metadata:/m.test(content)
        ? "Yarn Berry (v2+) lockfiles are not assessed in this version"
        : "unrecognised yarn.lock format",
    };
  try {
    const rootManifest = manifestAt("");
    if (format === "npm")
      return { path, format, status: "assessed", ...collect(npmGraph(content, manifestAt), path, lockDirectory, overrideTargets(rootManifest)) };
    if (format === "pnpm") {
      const { graph, overrides } = pnpmGraph(content, rootManifest);
      return { path, format, status: "assessed", ...collect(graph, path, lockDirectory, overrides) };
    }
    const patterns = workspacePatterns(rootManifest);
    const prefix = lockDirectory ? `${lockDirectory}/` : "";
    const workspaceMembers = tree.files
      .filter((file) => file.startsWith(prefix) && posix.basename(file) === "package.json" && file !== `${prefix}package.json`)
      .map((file) => directoryOf(file.slice(prefix.length)))
      .filter((member) => patterns.some((pattern) => !pattern.startsWith("!") && matchesGlob(member, pattern)))
      .filter((member) => !patterns.some((pattern) => pattern.startsWith("!") && matchesGlob(member, pattern.slice(1))))
      .flatMap((member) => {
        const manifest = manifestAt(member);
        return manifest ? [{ path: member, manifest }] : [];
      });
    return {
      path,
      format,
      status: "assessed",
      ...collect(yarnGraph(content, rootManifest, workspaceMembers, overrideTargets(rootManifest)), path, lockDirectory, overrideTargets(rootManifest)),
    };
  } catch (error) {
    return { path, format, status: "failed", reason: `could not parse: ${(error as Error).message}` };
  }
};

/** Re-bases every reported path from the assessed directory onto the repository, e.g. "yarn.lock" -> "sdk/yarn.lock". */
const rebase = (discovery: Discovery, base: string): Discovery => {
  if (base === "." || !base) return discovery;
  const path = (relativePath: string) => repoPath(base, relativePath === "." ? "" : relativePath);
  const usages = (list: Usage[]) => list.map((usage) => ({ ...usage, member: path(usage.member) }));
  return {
    lockfiles: discovery.lockfiles.map((report) =>
      report.status === "assessed"
        ? {
            ...report,
            path: path(report.path),
            members: report.members.map(path),
            packages: report.packages.map((locked) => ({ ...locked, lockfile: path(locked.lockfile), usages: usages(locked.usages) })),
            notAssessed: report.notAssessed.map((item) => ({ ...item, lockfile: path(item.lockfile), usages: usages(item.usages) })),
          }
        : { ...report, path: path(report.path) },
    ),
    otherDependencyFiles: discovery.otherDependencyFiles.map((file) => ({ ...file, path: path(file.path) })),
    manifestsWithoutLockfile: discovery.manifestsWithoutLockfile.map(path),
  };
};

/**
 * Finds and parses every dependency file under root (a checkout, or a directory in one); reads files only, runs
 * nothing. Reported paths are prefixed with base, the directory's path in the repository.
 */
export const discover = (root: string, base = "."): Discovery => rebase(discoverIn(root), base);

const discoverIn = (root: string): Discovery => {
  const files = walk(root);
  const fileSet = new Set(files);
  const tree: Tree = { files, fileSet, manifests: new Map() };
  const lockfiles: LockfileReport[] = [];
  const otherDependencyFiles: Discovery["otherDependencyFiles"] = [];
  for (const path of files) {
    const filename = posix.basename(path);
    if (NPM_LOCKFILES.has(filename) || filename === "pnpm-lock.yaml" || filename === "yarn.lock") {
      // npm uses npm-shrinkwrap.json over package-lock.json in the same directory.
      if (filename === "package-lock.json" && fileSet.has(repoPath(directoryOf(path), "npm-shrinkwrap.json"))) continue;
      lockfiles.push(assessLockfile(root, path, tree));
    } else if (UNSUPPORTED_LOCKFILES[filename]) {
      lockfiles.push({ path, status: "not-assessed", reason: UNSUPPORTED_LOCKFILES[filename] });
    } else if (OTHER_ECOSYSTEMS[filename]) {
      otherDependencyFiles.push({ path, ecosystem: OTHER_ECOSYSTEMS[filename] });
    }
  }
  const covered = new Set<string>();
  for (const report of lockfiles) {
    covered.add(repoPath(directoryOf(report.path), "."));
    if (report.status === "assessed") for (const member of report.members) covered.add(member);
  }
  const manifestsWithoutLockfile = files.filter((file) => {
    if (posix.basename(file) !== "package.json" || covered.has(repoPath(directoryOf(file), "."))) return false;
    if (!tree.manifests.has(file)) tree.manifests.set(file, readManifest(root, file));
    return hasDependencies(tree.manifests.get(file));
  });
  return { lockfiles, otherDependencyFiles, manifestsWithoutLockfile };
};
