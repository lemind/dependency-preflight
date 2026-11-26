import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover, tarballIdentity, type LockedPackage, type LockfileReport } from "../src/lockfiles.js";
import { FIXTURES, tarball, writeTree } from "./helpers.js";

const assessed = (report: LockfileReport | undefined) => {
  if (report?.status !== "assessed") throw new Error(`expected an assessed lockfile, got ${JSON.stringify(report)}`);
  return report;
};
const find = (packages: LockedPackage[], name: string, version?: string) =>
  packages.filter((locked) => locked.name === name && (!version || locked.version === version));

describe("real lockfiles (pinned fixtures)", () => {
  it("wallet-adapter: pnpm v9 workspace, every member assessed", () => {
    const report = assessed(discover(join(FIXTURES, "real/wallet-adapter/files")).lockfiles[0]);
    expect(report.format).toBe("pnpm");
    expect(report.members).toHaveLength(44);
    expect(report.packages).toHaveLength(1520);
    expect(report.notAssessed).toEqual([]);
    // A workspace member's own runtime dependency is attributed to that member.
    const [features] = find(report.packages, "@solana/wallet-standard-features");
    expect(features.usages).toContainEqual({ member: "packages/core/base", direct: true, runtime: true, directRuntime: true });
  });

  it("wallet-adapter: the @types/web override is assessed as the replacing package, typescript", () => {
    const report = assessed(discover(join(FIXTURES, "real/wallet-adapter/files")).lockfiles[0]);
    const [typescript] = find(report.packages, "typescript", "5.8.3");
    expect(typescript.localNames).toEqual([{ name: "@types/web", kind: "override" }]);
    // Not dev-only in this lockfile: a resolved peer of @solana/codecs-* packages, which pnpm installs. But the
    // example app declares it only as a devDependency, so it is direct and runtime, not a direct runtime dependency.
    expect(typescript.usages).toContainEqual({ member: "packages/starter/example", direct: true, runtime: true, directRuntime: false });
    expect(typescript.usages).toContainEqual({ member: ".", direct: true, runtime: false, directRuntime: false });
  });

  it("anchor ts/: Yarn 1 workspaces; the web3.js alias is assessed as @solana/web3.js 3.0.0", () => {
    const report = assessed(discover(join(FIXTURES, "real/anchor-ts/files")).lockfiles[0]);
    expect(report.path).toBe("ts/yarn.lock");
    expect(report.members).toHaveLength(18);
    expect(report.packages).toHaveLength(744);
    const [web3] = find(report.packages, "@solana/web3.js", "3.0.0");
    expect(web3.localNames).toEqual([{ name: "@anchor-lang/solana-web3-v3", kind: "alias" }]);
    expect(web3.usages).toContainEqual({ member: "ts/packages/anchor", direct: true, runtime: true, directRuntime: true });
  });

  it("drift sdk/: the Anchor alias is assessed as @coral-xyz/anchor 0.30.1; resolution-only entries are kept", () => {
    const report = assessed(discover(join(FIXTURES, "real/drift-sdk/files")).lockfiles[0]);
    expect(report.members).toEqual(["sdk"]);
    expect(report.packages).toHaveLength(706);
    expect(find(report.packages, "@coral-xyz/anchor").map((locked) => locked.version).sort()).toEqual(["0.29.0", "0.30.1"]);
    const [anchor30] = find(report.packages, "@coral-xyz/anchor", "0.30.1");
    expect(anchor30.localNames).toEqual([{ name: "@coral-xyz/anchor-30", kind: "alias" }]);
    expect(anchor30.usages).toEqual([{ member: "sdk", direct: true, runtime: true, directRuntime: true }]);
    // Entries pinned by "resolutions" that no dependency reaches are still assessed, unattributed.
    expect(report.packages.filter((locked) => locked.usages.length === 0)).toHaveLength(11);
  });
});

describe("controlled lockfiles", () => {
  it("unsupported formats are listed as not assessed, a malformed lockfile as failed", () => {
    const berry = discover(join(FIXTURES, "controlled/yarn-berry")).lockfiles;
    expect(berry).toEqual([{ path: "yarn.lock", status: "not-assessed", reason: expect.stringContaining("Yarn Berry") }]);
    const bun = discover(join(FIXTURES, "controlled/bun")).lockfiles;
    expect(bun).toEqual([{ path: "bun.lock", status: "not-assessed", reason: expect.stringContaining("Bun") }]);
    const malformed = discover(join(FIXTURES, "controlled/malformed")).lockfiles;
    expect(malformed).toEqual([{ path: "package-lock.json", format: "npm", status: "failed", reason: expect.stringContaining("could not parse") }]);
  });

  it("the compromised fixture locks @solana/web3.js 1.95.6 as a direct runtime dependency", () => {
    const report = assessed(discover(join(FIXTURES, "controlled/compromised-web3js-1.95.6")).lockfiles[0]);
    expect(report.packages).toEqual([
      { name: "@solana/web3.js", version: "1.95.6", lockfile: "package-lock.json", localNames: [], usages: [{ member: ".", direct: true, runtime: true, directRuntime: true }] },
    ]);
  });
});

const npmLock = (packages: Record<string, object>, root: object = {}) => ({
  name: "app",
  lockfileVersion: 3,
  packages: { "": { name: "app", ...root }, ...packages },
});

describe("discovery", () => {
  it("lists other ecosystems, skips node_modules, does not follow symlinks, and names manifests without a lockfile", () => {
    const root = writeTree({
      "Cargo.lock": "# rust",
      "node_modules/x/package-lock.json": "{}",
      "tools/package.json": { dependencies: { left: "1.0.0" } },
      "docs/package.json": { name: "no-dependencies" },
    });
    symlinkSync("/", join(root, "outside"));
    const discovery = discover(root);
    expect(discovery.lockfiles).toEqual([]);
    expect(discovery.otherDependencyFiles).toEqual([{ path: "Cargo.lock", ecosystem: "Rust" }]);
    expect(discovery.manifestsWithoutLockfile).toEqual(["tools/package.json"]);
  });

  it("npm workspaces: members, links, nested installs, dev versus runtime", () => {
    const root = writeTree({
      "package.json": { name: "app", workspaces: ["packages/*"], devDependencies: { vitest: "^1.0.0" } },
      "packages/lib/package.json": { name: "lib", dependencies: { a: "^1.0.0" } },
      "packages/app/package.json": { name: "web", dependencies: { lib: "*", a: "^2.0.0" } },
      "package-lock.json": npmLock({
        "node_modules/lib": { resolved: "packages/lib", link: true },
        "packages/lib": { name: "lib", dependencies: { a: "^1.0.0" } },
        "packages/app": { name: "web", dependencies: { lib: "*", a: "^2.0.0" } },
        "node_modules/a": { version: "1.0.0", resolved: tarball("a", "1.0.0"), dependencies: { b: "^1.0.0" } },
        "node_modules/b": { version: "1.1.0", resolved: tarball("b", "1.1.0") },
        "packages/app/node_modules/a": { version: "2.0.0", resolved: tarball("a", "2.0.0") },
        "node_modules/vitest": { version: "1.6.0", resolved: tarball("vitest", "1.6.0"), dev: true },
      }),
    });
    const report = assessed(discover(root).lockfiles[0]);
    expect(report.members).toEqual([".", "packages/app", "packages/lib"]);
    expect(find(report.packages, "a", "2.0.0")[0].usages).toEqual([{ member: "packages/app", direct: true, runtime: true, directRuntime: true }]);
    expect(find(report.packages, "a", "1.0.0")[0].usages).toEqual([
      { member: "packages/app", direct: false, runtime: true, directRuntime: false },
      { member: "packages/lib", direct: true, runtime: true, directRuntime: true },
    ]);
    expect(find(report.packages, "b")[0].usages.every((usage) => !usage.direct && usage.runtime)).toBe(true);
    expect(find(report.packages, "vitest")[0].usages).toEqual([{ member: ".", direct: true, runtime: false, directRuntime: false }]);
  });

  it("a direct devDependency that a runtime dependency also pulls in is runtime, but not a direct runtime dependency", () => {
    const root = writeTree({
      "package.json": { name: "app", dependencies: { express: "^4.0.0" }, devDependencies: { debug: "^2.6.0" } },
      "package-lock.json": npmLock(
        {
          "node_modules/express": { version: "4.21.0", resolved: tarball("express", "4.21.0"), dependencies: { debug: "2.6.9" } },
          "node_modules/debug": { version: "2.6.9", resolved: tarball("debug", "2.6.9") },
        },
        { dependencies: { express: "^4.0.0" }, devDependencies: { debug: "^2.6.0" } },
      ),
    });
    const report = assessed(discover(root).lockfiles[0]);
    expect(find(report.packages, "debug")[0].usages).toEqual([{ member: ".", direct: true, runtime: true, directRuntime: false }]);
    expect(find(report.packages, "express")[0].usages).toEqual([{ member: ".", direct: true, runtime: true, directRuntime: true }]);
  });

  it("pnpm v6 (single project)", () => {
    const root = writeTree({
      "package.json": { dependencies: { a: "^1.0.0" }, devDependencies: { d: "^1.0.0" } },
      "pnpm-lock.yaml": [
        "lockfileVersion: '6.0'",
        "dependencies:",
        "  a:",
        "    specifier: ^1.0.0",
        "    version: 1.0.0",
        "devDependencies:",
        "  d:",
        "    specifier: ^1.0.0",
        "    version: 1.2.0",
        "packages:",
        "  /a@1.0.0:",
        "    resolution: {integrity: sha512-x}",
        "    dependencies:",
        "      b: 2.0.0",
        "  /b@2.0.0:",
        "    resolution: {integrity: sha512-y}",
        "  /d@1.2.0:",
        "    resolution: {integrity: sha512-z}",
        "    dev: true",
        "",
      ].join("\n"),
    });
    const report = assessed(discover(root).lockfiles[0]);
    expect(report.packages.map((locked) => [locked.name, locked.version, locked.usages])).toEqual([
      ["a", "1.0.0", [{ member: ".", direct: true, runtime: true, directRuntime: true }]],
      ["b", "2.0.0", [{ member: ".", direct: false, runtime: true, directRuntime: false }]],
      ["d", "1.2.0", [{ member: ".", direct: true, runtime: false, directRuntime: false }]],
    ]);
  });
});

describe("aliases and package identity", () => {
  const yarnProject = (dependency: string, entry: string) =>
    writeTree({
      "package.json": { name: "app", dependencies: { "safe-name": dependency } },
      "yarn.lock": `# yarn lockfile v1\n\n\n"safe-name@${dependency}":\n${entry}`,
    });

  it("an alias to a malicious registry package is assessed under the real package name", () => {
    const root = yarnProject(
      "npm:@solana/web3.js@1.95.6",
      `  version "1.95.6"\n  resolved "${tarball("@solana/web3.js", "1.95.6")}#abc"\n`,
    );
    const report = assessed(discover(root).lockfiles[0]);
    expect(report.packages).toEqual([
      {
        name: "@solana/web3.js",
        version: "1.95.6",
        lockfile: "yarn.lock",
        localNames: [{ name: "safe-name", kind: "alias" }],
        usages: [{ member: ".", direct: true, runtime: true, directRuntime: true }],
      },
    ]);
  });

  it("an alias whose resolved tarball names another package is not assessed", () => {
    const root = yarnProject("npm:@solana/web3.js@1.95.8", `  version "1.95.8"\n  resolved "${tarball("left-pad", "1.95.8")}"\n`);
    const report = assessed(discover(root).lockfiles[0]);
    expect(report.packages).toEqual([]);
    expect(report.notAssessed).toEqual([
      expect.objectContaining({ name: "safe-name", reason: "package identity could not be verified", usages: [{ member: ".", direct: true, runtime: true, directRuntime: true }] }),
    ]);
  });

  it("a Git dependency is not assessed", () => {
    const root = yarnProject(
      "github:someone/safe#main",
      `  version "1.0.0"\n  resolved "https://codeload.github.com/someone/safe/tar.gz/0123456789abcdef"\n`,
    );
    const report = assessed(discover(root).lockfiles[0]);
    expect(report.packages).toEqual([]);
    expect(report.notAssessed[0]).toMatchObject({ name: "safe-name", reason: "Git dependency" });
  });

  it("npm lock: an alias is verified against its tarball; the installed directory name is not trusted", () => {
    const root = writeTree({
      "package.json": { dependencies: { "safe-name": "npm:@solana/web3.js@1.95.6", other: "1.0.0" } },
      "package-lock.json": npmLock({
        "node_modules/safe-name": { name: "@solana/web3.js", version: "1.95.6", resolved: tarball("@solana/web3.js", "1.95.6") },
        // Claims to be "other" but its tarball is a different package: not assessed rather than guessed.
        "node_modules/other": { version: "1.0.0", resolved: tarball("evil", "1.0.0") },
      }),
    });
    const report = assessed(discover(root).lockfiles[0]);
    expect(report.packages.map((locked) => [locked.name, locked.localNames])).toEqual([
      ["@solana/web3.js", [{ name: "safe-name", kind: "alias" }]],
    ]);
    expect(report.notAssessed).toEqual([expect.objectContaining({ name: "other", reason: "package identity could not be verified" })]);
  });

  it("reads package identity from registry tarball URLs", () => {
    expect(tarballIdentity("https://registry.yarnpkg.com/@coral-xyz/anchor/-/anchor-0.30.1.tgz#17f3")).toEqual({ name: "@coral-xyz/anchor", version: "0.30.1" });
    expect(tarballIdentity("https://registry.npmjs.org/@solana/web3.js/-/web3.js-1.95.8.tgz")).toEqual({ name: "@solana/web3.js", version: "1.95.8" });
    expect(tarballIdentity("https://codeload.github.com/a/b/tar.gz/abc")).toBeUndefined();
  });
});

describe("assessing a subdirectory", () => {
  it("reports paths and members relative to the repository", () => {
    const discovery = discover(join(FIXTURES, "real/drift-sdk/files/sdk"), "sdk");
    const report = assessed(discovery.lockfiles[0]);
    expect([report.path, report.members]).toEqual(["sdk/yarn.lock", ["sdk"]]);
    expect(find(report.packages, "@coral-xyz/anchor", "0.29.0")[0]).toMatchObject({
      lockfile: "sdk/yarn.lock",
      usages: [{ member: "sdk", direct: true, runtime: true, directRuntime: true }],
    });
  });
});
