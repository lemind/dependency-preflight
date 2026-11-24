# Research and decisions: Dependency preflight

Background measurements: [docs/research-2026-11-24.md](../../docs/research-2026-11-24.md). Each entry: decision,
rationale, alternatives. "Verified" means run or measured on the date given.

## R1. Packaging: a Node GitHub Action with a committed bundle

- **Decision**: TypeScript compiled for type checking only, bundled by esbuild (pinned 0.28.2) into `dist/index.cjs`,
  committed; `runs.using: node24`. CI rebuilds and fails if the bundle differs, then smoke-runs it with an empty
  environment.
- **Rationale**: the PR Agent ships the same way; no install step runs on the user's runner.
- **Alternatives**: a Docker action (slower, larger); publishing to npm and installing at run time (an install step in
  the job that may hold a wallet).

## R2. Lockfile support and parsing

- **Decision**: npm `package-lock.json` / `npm-shrinkwrap.json` v2/v3 (JSON), pnpm v6/v9 and Yarn 1 (`parseSyml` from
  `@yarnpkg/parsers`, which handles both). Yarn Berry (detected by `__metadata`) and Bun are listed as not assessed.
  Discovery walks the checkout, skipping `.git`, `node_modules`, `vendor`, `third_party`, `bower_components`, `.yarn`;
  never follows symlinks; caps lockfiles at 64 MB and manifests at 1 MB; depth 25.
- **Rationale**: what we can test against real targets (wallet-adapter pnpm v9, anchor and drift Yarn 1). No extra
  YAML dependency.
- **Alternatives**: running the package manager to list dependencies (executes repository configuration: rejected by
  FR-014).

## R3. Workspace members and dependency classification

- **Decision**: one dependency graph per lockfile. Members are npm non-`node_modules` keys, pnpm importers, or Yarn 1
  `workspaces` globs matched against manifests on disk. For each member, direct = declared in its manifest (or
  importer); runtime = reachable from its `dependencies`/`optionalDependencies` (plus `peerDependencies` for npm,
  which installs them); dev = reachable only from `devDependencies`. A member reached through a workspace link
  contributes its runtime dependencies. npm resolution follows Node's `node_modules` lookup upwards.
- **Verified 24 Nov**: counts match the research prototype: wallet-adapter 1,520 versions / 44 members, anchor `ts/`
  744 / 18, drift `sdk/` 706 / 1.
- **Alternatives**: flags in the lockfile (`dev: true`): npm only, absent from pnpm v9 and Yarn 1.

## R4. Aliases, overrides and package identity

- **Decision** (approved 24 Nov, FR-001a updated): npm aliases (`npm:<real>@<range>`) and registry-backed overrides or
  resolutions are assessed under the real package. Identity comes from the lockfile descriptor, checked against the
  registry tarball URL (`/<name>/-/<basename>-<version>.tgz`) and, where present, the manifest or importer specifier.
  The install directory name and the package's own `package.json` are never trusted. A mismatch, a Git or `file:`
  source, or an unparseable source is "not assessed".
- **Evidence**: drift `sdk/` `@coral-xyz/anchor-30` → `@coral-xyz/anchor` 0.30.1; anchor `ts/`
  `@anchor-lang/solana-web3-v3` → `@solana/web3.js` 3.0.0; wallet-adapter override `@types/web` → `typescript` 5.8.3,
  which is a runtime dependency there (direct in `packages/starter/example`, and a resolved peer of
  `@solana/codecs-*`), not dev-only as first assumed.
- **Alternatives**: aliases as not assessed (the original FR-001a): false "review" verdicts and a known way to slip a
  malicious package past scanners.

## R5. Workspace references and unreachable lock entries

- **Decision**: a workspace link that resolves to a member is that member, assessed through its own dependencies, and
  is not listed as not assessed; an unresolvable local link is. Lock entries no member reaches (11 in drift `sdk/`,
  kept by `resolutions`) are still checked and shown as **unreachable**: their advisories don't change the verdict,
  except a malicious version, which still blocks (the graph walk can't prove the package is never installed).
- **Alternatives**: counting unreachable entries as runtime (could block on packages nothing installs); dropping them
  (leaves locked versions unchecked).

## R6. OSV: querying, grouping, malicious detection

- **Decision**: `POST /v1/querybatch` in chunks of 1,000, following `next_page_token` per query; `GET /v1/vulns/{id}`
  for every returned id (8 at a time, 30 s timeout, one retry). Records that alias each other are grouped; each locked
  version is one finding listing its groups. Malicious = a `MAL-` id or alias. Withdrawn records are ignored. Severity
  from `database_specific.severity` (GHSA) or the affected entry; none means moderate, flagged as defaulted. "Fixed in"
  = the smallest `fixed` event above the locked version; a group needs every record to name a fix.
- **Evidence (24 Nov)**: `GHSA-jcxm-7wvp-g6p5` (alias `CVE-2024-54134`) and `MAL-2024-11183` (alias
  `GHSA-2mhj-xmf4-pr8m`) are not aliases of each other. Hence one finding per locked version rather than one group.
- **Failure handling**: a failed batch marks its packages "not checked"; a missing record keeps the id (malicious still
  detected by prefix) and makes coverage partial.

## R7. npm registry

- **Decision**: the abbreviated document (`Accept: application/vnd.npm.install-v1+json`), 60 s timeout, 6 at a time,
  for direct dependencies and for packages with a malicious finding. Latest = `dist-tags.latest` unless it is a
  prerelease, then the highest stable version. "Removed" = the locked version is absent from `versions`. Upgrade gap:
  major; minor on 0.x counts as major (breaking under semver); minor; patch.
- **Evidence**: `@solana/web3.js` is 4.7 MB abbreviated against 12 MB in full. Its `latest` is 3.2.1 (24 Nov), so any
  1.x lock is an outdated key package and the remediation demo ends at **review**, not ready.

## R8. Verdict and coverage

- **Decision**: tiers malicious > direct runtime > transitive runtime > dev > unreachable; key packages first, then
  severity, then name. Blocked: any malicious version, or a high/critical advisory in a direct runtime dependency.
  Review: other runtime advisories, an unchecked runtime dependency, an outdated key package (major gap). Ready
  otherwise. Coverage failed when no lockfile was assessed or OSV answered for no package; failed coverage is never
  ready. Partial for anything not assessed or not checked.

## R9. Telegraph payment client (P2) — open approval

- **Finding**: the PR Agent's `bot/src/x402.ts` uses `@x402/fetch` (`wrapFetchWithPaymentFromConfig`) and
  `@x402/evm` (`ExactEvmScheme`, `toClientEvmSigner`) together with `viem`. PROJECT.md only lists `viem`.
- **Options**: (a) approve `@x402/fetch` and `@x402/evm` and copy the client as is (proven in production on the PR
  Agent); (b) reimplement the x402 exact-EVM payment with `viem` alone (new, untested payment code before the
  deadline).
- **Recommendation**: (a). **Needs the owner's approval before T020.**

## R10. Miner answers (P2)

- **Decision**: ask `POST https://devnode.telegraphprotocol.com/engine/v1/ask/7314` with
  `{"method":"GET","endpoint":"/answer","payload":{"query":"What changed in X from A to B?"}}`. Validate with the
  schema in the PR Agent's `bot/src/miner-assessment.ts` (`outcome` found / not_found, `changes[]` with kind, version,
  evidence type, change, excerpt, source id, migration; `sources[]`), not `assessment.ts` as the handoff says. Import
  it from `zod/v3` under zod 4.6. Unusable answers are dropped and counted against caps; `not_found` and unavailable are
  stated, never "no changes".

## R11. Purchase record and attempt states (P2)

- **Decision**: copy the PR Agent's ledger states (`bot/src/ledger.ts`): reserved → request_sent → delivered /
  failed_* / unknown_needs_reconciliation. The spec's **pending** maps to reserved and request_sent, **unknown** to
  request_sent and unknown_needs_reconciliation. Key = package + exact from + exact to. Written to a `preflight`
  branch through the GitHub API (`contents: write`); the workflow's `concurrency` group prevents overlapping runs.

## R12. Pull request comment (P3)

- **Decision**: one comment found by a hidden marker and updated in place, condensed: base and head verdicts and
  coverage, resolved / open / new counts, the blocked and review findings with member and package (truncated with an
  omitted count), and a link to the full job summary. Fork PRs: summary only.
- **Rationale**: full reports are 30–80 KB (24 Nov runs); GitHub's comment limit is 65,536 characters.

## R13. Demo repositories

- **Decision**: compromised = controlled repo pinning `@solana/web3.js` 1.95.6 (historical, labelled with
  `case-label`), fixed by a PR to 1.95.8 (blocked → review: the malware is resolved, the 1.x line is still behind 3.x);
  breaking upgrade = fork of `drift-labs/protocol-v2`, `sdk/` (`@coral-xyz/anchor` 0.29.0); clean = a controlled repo
  on `@solana/kit` alone, pinned to the version captured in its fixture (8.6.0 on 24 Nov). wallet-adapter and anchor
  `ts/` are the large free-mode runs.
- **Scope**: every workspace member is assessed by default; an explicit include list is a possible later input, not in
  this release.
