# Data model: Dependency preflight

Spec entities mapped to the types in `src/`. **[built]** types exist today; **[P2]**/**[P3]** are planned. All paths
are repository-relative (`.` is the repository root); when the Action assesses a subdirectory, paths are re-based onto
the repository (e.g. `sdk/yarn.lock`, member `sdk`).

## Repository snapshot → `Discovery` [built] (`src/lockfiles.ts`)

| Field | Type | Meaning |
| --- | --- | --- |
| `lockfiles` | `LockfileReport[]` | every npm-family lockfile found |
| `otherDependencyFiles` | `{ path, ecosystem }[]` | `Cargo.lock` (Rust), `go.sum`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Gemfile.lock`, `composer.lock`: not assessed |
| `manifestsWithoutLockfile` | `string[]` | `package.json` files that declare dependencies but no lockfile pins |

The commit assessed comes from `GITHUB_SHA` and is shown in the report.

### `LockfileReport` (one per lockfile, by `status`)

| Status | Fields | Coverage effect |
| --- | --- | --- |
| `assessed` | `path`, `format` (`npm` \| `pnpm` \| `yarn1`), `members: string[]`, `packages: LockedPackage[]`, `notAssessed: NotAssessedDependency[]` | none by itself |
| `not-assessed` | `path`, `reason` (Yarn Berry, Bun, unrecognised `yarn.lock`) | partial |
| `failed` | `path`, `format`, `reason` (unreadable, oversized, unparseable, unsupported version) | partial; failed if no lockfile is assessed |

## Locked dependency → `LockedPackage` [built]

| Field | Type | Rule |
| --- | --- | --- |
| `name` | `string` | registry package, verified against the resolved tarball (FR-001a) |
| `version` | `string` | valid semver, exactly as locked |
| `lockfile` | `string` | where it is locked |
| `localNames` | `{ name, kind: "alias" \| "override" }[]` | install names that differ from `name` |
| `usages` | `Usage[]` | one per workspace member that reaches it; empty = unreachable |

Unique by (`lockfile`, `name`, `version`). Different versions of one package in different members are separate entries.

### `Usage`

`{ member: string, direct: boolean, runtime: boolean, directRuntime: boolean }`: direct = declared in that member's
manifest or importer (runtime or dev); runtime = reachable from its runtime declarations (see research R3);
directRuntime = declared in its runtime declarations. A direct devDependency that another dependency pulls in at
runtime is direct and runtime, but not directRuntime: it is not in the direct-runtime tier and is never bought.

### `NotAssessedDependency`

`{ name, source, reason, lockfile, usages }`. Reasons: Git dependency; local path dependency; URL dependency;
unresolved workspace reference; package identity could not be verified; declared in the manifest but not found in
the lockfile. A workspace reference that resolves to a member is not listed here: that member is assessed through its
own dependencies. Shown as "not
checked"; a runtime one makes the verdict at least review; any makes coverage partial.

## Advisory data → `AdvisoryGroup`, `AdvisoryCheck` [built] (`src/osv.ts`)

`AdvisoryGroup`: records that alias each other, one issue.

| Field | Type | Rule |
| --- | --- | --- |
| `ids` | `string[]` | OSV ids returned for the version, then their aliases |
| `summary` | `string` | first record summary (or the start of its details) |
| `severity` | `low` \| `moderate` \| `high` \| `critical` | highest in the group; moderate when none is given |
| `severityDefaulted` | `boolean` | no record stated a severity |
| `malicious` | `boolean` | an id or alias starts with `MAL-` (FR-002) |
| `published` | `string?` | earliest publication date |
| `fixedIn` | `string?` | smallest fix above the locked version, when every record names one |
| `detailsMissing` | `boolean` | a record could not be fetched |

`AdvisoryCheck`: `advisories: Map<"name@version", AdvisoryGroup[]>` (empty list = checked, none found),
`notChecked: Map<"name@version", reason>`, `detailsMissing: string[]`.

## Registry → `RegistryRecord` [built] (`src/registry.ts`)

`{ latest?: string, versions: Set<string> }` or `{ error }` per package name. `upgradeGap(locked, latest)`: `major`
(including a minor on 0.x), `minor`, `patch`, `none`.

## Finding [built] (`src/verdict.ts`)

### `AdvisoryFinding`

`{ package: LockedPackage, groups: AdvisoryGroup[], tier, key, malicious, severity, fixedIn?, removedFromRegistry? }`

- `tier`: `malicious` > `direct-runtime` > `transitive-runtime` > `dev` > `unreachable`.
- `key`: matches a key-package pattern (default `@solana/*`, `@coral-xyz/anchor`).
- `fixedIn`: the highest of the groups' fixes (all must have one).
- `removedFromRegistry`: the locked version is no longer published (only when the registry was consulted).

### `OutdatedFinding`

`{ package, key, runtime, latest, gap }` for direct dependencies behind the latest stable release. `patch` = listed
only; `minor`/`major` = outdated; only `key` with `major` makes the verdict review (FR-004b). Paid explanation
candidates (P2): `runtime` and `minor`/`major`.

### `NotChecked`

`{ name, version?, lockfile, runtime, unreachable, reason }`: OSV lookups that didn't complete, and not-assessed
dependencies. **Planned (T034)**: split into `notAssessed` (outside the supported scope or identity not verifiable:
Git, local path, URL, unresolved workspace reference, unsupported lockfile) and `notChecked` (a lookup that should
have completed but failed: OSV or registry timeout or outage), each with its own report section.

## Report → `Assessment` [built]

| Field | Type |
| --- | --- |
| `verdict` | `blocked` \| `review` \| `ready` |
| `coverage` | `complete` \| `partial` \| `failed` |
| `verdictReasons` | `{ blocked: string[], review: string[] }` |
| `coverageReasons` | `string[]` |
| `advisories` | `AdvisoryFinding[]`, ranked |
| `outdated` | `OutdatedFinding[]`, key packages first |
| `notChecked` | `NotChecked[]` |
| `discovery` | `Discovery` |
| `lockedVersionCount` | `number` (unique name@version) |

Rendered by `renderReport(assessment, { path, repository?, commit?, ranAt, keyPackages, caseLabel? })`.

State rules: failed coverage is never `ready`; blocked takes precedence over review; an explanation (P2) never lowers
the verdict.

## Upgrade explanation [P2]

`Explanation` [built] (`src/explain.ts`, from a validated miner answer, research R10):

| Field | Type | Rule |
| --- | --- | --- |
| `name`, `from`, `to` | `string` | the candidate (`to` = latest stable at run time) |
| `minerId` | `string` | the miner that answered; a delivered answer is reused under a later miner configuration |
| `outcome` | `found` \| `not_found` \| `unavailable` \| `unusable` | `unavailable`: no answer bought (set by the caller); `unusable`: failed validation, never shown as guidance |
| `reason` | `string?` | why unavailable or unusable |
| `coverageComplete` | `boolean?` | the miner's own release-coverage statement (found only) |
| `changes` | `{ kind: breaking \| deprecation \| security_fix, version, change, migration \| null, quote, sourceUrl }[]` | documented changes only, each with a verbatim quote and a plain HTTPS source; breaking first, then deprecations and security fixes, oldest version first (as in the PR Agent) |
| `introducedAdvisories` | `string[]` | advisories the miner says the target version introduces: always shown as a warning (the PR Agent rejects such answers instead) |

The answer schema has no field saying whether a change affects TypeScript or Rust, so the report does not infer it.
`found` with no changes is shown as "no documented change with a quote was returned", never "no changes".

## Purchase and attempt [P2]

`PurchaseReceipt` [built] (`src/record.ts`): `{ minerId, amountUsdc, txHash, receiptHash, signalHash, network, chainId,
rail?: "escrow", epochId? }` (an escrow payment has no `txHash`; it is billed in ledger epoch `epochId`). It sits on the
`delivered` attempt row with the miner's raw `answer`, validated again whenever it is shown; the row's `time` is the
purchase time. One row per `receiptHash`.

Attempt (copied from the PR Agent ledger), keyed by package + exact from + exact to:

```text
reserved ──► quote_refused
   │
   └──► request_sent ──► delivered
                     ├──► failed_and_credited | failed_not_charged
                     └──► unknown_needs_reconciliation ──(person)──► failed_*
```

Spec mapping: **pending** = reserved, request_sent; **delivered**; **unknown** = request_sent (stale),
unknown_needs_reconciliation. A key with a pending or unknown attempt is never bought again until reconciled; a
delivered key is reused (whatever miner is configured now). No purchase without a durably written `reserved` record
and a held lease (FR-009b).

## Lease [P2]

`{ token, runId, acquiredAt, expiresAt }` in `lease.json` on the `preflight` branch (research R11). Held by at most one
run; every record write is a compare-and-swap from the run's own last commit, so it fails once anything else moved
the branch. Taking the lease marks any unfinished attempt (`reserved`, `request_sent`) for reconciliation.

```text
free ──acquire (CAS)──► held ──release (CAS)──► free
                         │
                         └── expiresAt passed ──► expired ──acquire by another run (CAS, after reconciliation)──► held
```

## Comparison [P3]

Finding identity: advisory finding = workspace member + package + advisory group; outdated finding = workspace
member + package + `outdated` (exact versions and dependency paths are context only). Status per finding:

| Status | Rule |
| --- | --- |
| `resolved` | base only, and on the head the lockfile was parsed and the package's lookup completed (OSV for advisories, registry for outdated) |
| `unverified` | base only, but on the head the lockfile failed or was not assessed, or the lookup did not complete |
| `open` | base and head |
| `new` | head only |

A failed check never resolves a finding. The comment shows base and head verdicts and coverage.
