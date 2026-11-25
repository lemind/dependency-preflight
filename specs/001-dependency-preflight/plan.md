# Implementation Plan: Dependency preflight

**Branch**: `001-dependency-preflight` (feature); implementation on `002-p1-verdict-in-ci`, PR #2 | **Date**: 2026-11-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-dependency-preflight/spec.md`

This plan was written after Phase 0 (setup) and Phase 1 (P1, verdict in CI) were implemented. For those phases it
describes what exists in the repository; for P2–P4 it is the plan. Research and decisions: [research.md](research.md).
Entities: [data-model.md](data-model.md). Action interface: [contracts/action.md](contracts/action.md). Running it:
[quickstart.md](quickstart.md).

## Summary

A GitHub Action that reads every npm lockfile in a checkout (never running repository code), checks every locked
version against OSV, finds outdated direct dependencies, and writes one Markdown report with a verdict (**blocked /
review / ready (npm dependencies assessed)**) and a coverage status (**complete / partial / failed**). It fails the
step on blocked or failed coverage. P2 adds paid "what changed A → B" explanations from Telegraph miner 7314 for
outdated key packages, with caps and a purchase record; P3 compares a pull request with its base branch and keeps one
comment updated. P4 (a web page) is optional.

## Technical Context

**Language/Version**: TypeScript 7 (`tsc --noEmit` only), bundled by esbuild 0.28.2 (pinned) to one CommonJS file
for Node 24 (`runs.using: node24`). Developed on Node 26.

**Primary Dependencies**: `@actions/core` (inputs, outputs, job summary), `@yarnpkg/parsers` (Yarn 1 and pnpm YAML),
`semver`; for P2, `viem` and `zod` (≥ 4.6.6; the copied miner schema imports `zod/v3`). Approved 24 Nov. The PR Agent's
escrow client also needs `@x402/fetch` and `@x402/evm` 2.32.0, pinned exactly (approved 25 Nov, research R9).

**Storage**: none for P1. P2: an append-only JSONL record on a `preflight` branch of the installer's repository,
written through the GitHub API.

**Testing**: vitest 5, offline only: pinned real lockfiles plus recorded OSV answers, controlled fixtures, temporary
directory trees; a replay fetcher fails any unexpected request.

**Target Platform**: GitHub-hosted runners (`ubuntu-latest`), public repositories.

**Project Type**: GitHub Action (single TypeScript project, one bundled entry point).

**Performance Goals**: under 5 minutes per target repository in free mode (SC-001). Measured on 24 Nov: 6.5–18 s.

**Constraints**: no scanned-repository code is ever installed or run (FR-014); least-privilege tokens; testnet only;
caps of 0.05 test USDC per call, 0.30 per run, 10 purchases per run; GitHub comments max 65,536 characters (full
reports are 30–80 KB); job summary max 1 MiB.

**Scale/Scope**: about 700–1,500 locked versions and up to ~80 workspace members per target repository; three target
repositories and three demo scenarios; deadline 1 Dec 2026, 23:59 UTC.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so the gates are the working rules in
[AGENTS.md](../../AGENTS.md):

| Rule | Status |
| --- | --- |
| KISS over DRY; no abstraction before the third use | Pass. One module per concern; the graph walk is shared by the three lockfile formats because all three use it. PR Agent code is copied, not shared. |
| Never commit secrets; never log the wallet key | Pass for P1 (no secrets used). P2: the key comes from `TELEGRAPH_EVM_PRIVATE_KEY` only and is never printed. |
| No paid call, signature or testnet spend without approval | Pass. Nothing paid so far. T025 (first paid run) and T026 (miner deploy) wait for approval. |
| Scanned repositories and miner answers are untrusted input | Pass. Lockfiles are parsed as data; identity is verified against registry tarball URLs; report cells are escaped; P2 validates answers with a schema. |
| No silent failures | Pass. Every failed lookup becomes "not checked" or "not assessed" and lowers coverage; failed coverage fails the step. |
| New dependencies only with approval and a reason in the PR | Pass. `@x402/fetch` and `@x402/evm` approved 25 Nov (R9). Everything installed is approved and listed in PR #2. |
| Docs in sync; claim only what was run | Pass. README states P1 works locally and in tests and hasn't run on a hosted runner against a target repository. |

Re-check after design: unchanged. The only open gate is the P2 dependency approval, which blocks T020, not P1.

## Project Structure

### Documentation (this feature)

```text
specs/001-dependency-preflight/
├── spec.md              # feature specification
├── plan.md              # this file
├── research.md          # decisions and their evidence
├── data-model.md        # entities and types
├── quickstart.md        # install and run, local reproduction, tests
├── contracts/
│   └── action.md        # action.yml inputs, outputs, exit behaviour, report contract
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # task list (/speckit-tasks)
```

### Source Code (repository root)

```text
action.yml                    # Action metadata (contract: contracts/action.md)
src/
├── lockfiles.ts              # [built] discovery; npm/pnpm/Yarn 1 parsing; workspace members; usages; aliases and identity
├── osv.ts                    # [built] querybatch with pagination, full records, alias grouping, malicious detection
├── registry.ts               # [built] latest stable, published versions, upgrade gap
├── verdict.ts                # [built] tiers, ranking, verdict and coverage rules
├── assess.ts                 # [built] free assessment of a checkout: discovery → OSV → registry → decide
├── report.ts                 # [built] Markdown report
├── action.ts                 # [built] entry: inputs, job summary, outputs, exit code
├── telegraph.ts              # [P2] escrow payment client copied from the PR Agent; caps
├── explain.ts                # [P2] candidate ranking, question, answer validation
├── record.ts                 # [P2] purchase record on the `preflight` branch, attempt states
└── compare.ts                # [P3] base vs head: resolved, open, new; PR comment
test/
├── helpers.ts                # replay fetcher (recorded OSV + registry stub), temp trees
├── lockfiles.test.ts         # parsing, members, aliases, identity, discovery
├── assess.test.ts            # verdict, coverage, OSV client, report, real-fixture counts
└── fixtures/
    ├── real/<name>/          # files/ (pinned lockfiles and manifests), fixture.json (commit, sha256, date), osv.json
    └── controlled/           # web3.js 1.95.6/1.95.7/1.95.8, malformed, Yarn Berry, Bun; osv.json; README
scripts/
├── fetch-fixture.sh          # pin a repository's dependency files by commit and hash
└── record-osv.ts             # record live OSV answers for a fixture
dist/index.cjs                # committed bundle the Action runs
.github/workflows/test.yml    # typecheck, build, bundle-is-current, smoke run, tests
```

**Structure Decision**: a single TypeScript project at the repository root, packaged as a Node Action like the PR
Agent. Modules map one-to-one to concerns; `assess.ts` was added during Phase 1 to keep I/O orchestration out of
`verdict.ts` (pure rules) and `action.ts` (GitHub I/O).

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Setup: package, bundle, fixtures, CI | Done (PR #2) |
| 1 | P1 verdict in CI | Done (PR #2): 35 offline tests; local free-mode runs on the three targets |
| 2 | P2 paid explanations | Planned; `@x402/*` approved 25 Nov (R9). First paid run T025 needs approval |
| 3 | P3 re-check after the fix, PR comment | Planned. Comment is a condensed summary that links the job summary (R12) |
| 4 | Demo, docs, submission | Planned |
| 5 | P4 web page | Only if P1–P3 are done |

## Complexity Tracking

No violations to justify.
