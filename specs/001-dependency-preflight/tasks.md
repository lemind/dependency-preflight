---
description: "Task list for dependency preflight"
---

# Tasks: Dependency preflight

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/action.md](contracts/action.md), [quickstart.md](quickstart.md)

**Tests**: offline vitest tests are part of each story (the spec's independent tests and SC-002/SC-003 need them). No
test may reach the network; use the replay fetcher in `test/helpers.ts`.

**Task ids**: kept from PROJECT.md §5 so history and commits still match. New tasks use free ids (T019, T027, T033, T034,
T046, T047), so ids are not strictly in execution order; the order on the page is.

**Markers**: ⚠ = needs the owner's explicit approval first (new dependency, paid call or testnet spend, deploy, public
repository or post). `[P]` = can run in parallel with other `[P]` tasks of the same phase (different files).

**Dates** are targets; the deadline is 1 Dec 2026, 23:59 UTC.

---

## Phase 1: Setup (25 Nov) — done on PR #2

**Purpose**: package, bundle, fixtures and CI that every story builds on.

- [x] T001 ⚠ Add the approved dependencies and tooling: `package.json`, `tsconfig.json`, vitest, esbuild bundle script (`npm run build` → `dist/index.cjs`), `action.yml` skeleton. Dependencies approved 24 Nov; zod ≥ 4.6.6 (4.6.7 locked) and vitest 5 upgrades approved 24 Nov
- [x] T002 [P] Pin real fixtures in `test/fixtures/real/{wallet-adapter,anchor-ts,drift-sdk}/` with `scripts/fetch-fixture.sh` (commit SHA, lockfile and manifest sha256, retrieval date in `fixture.json`), and record OSV answers with capture time in `osv.json` via `scripts/record-osv.ts`
- [x] T003 [P] Write controlled fixtures in `test/fixtures/controlled/` (web3.js 1.95.6, 1.95.7, 1.95.8; malformed; Yarn Berry; Bun), labelled historical in `test/fixtures/controlled/README.md`
- [x] T004 [P] CI in `.github/workflows/test.yml` on Node 24 (the Action's runtime): `npm ci --ignore-scripts`, typecheck and build, bundle-is-current check, smoke run, tests, on every push and PR

**Checkpoint**: `npm run build && npm test` pass; CI green on PR #2.

---

## Phase 2: User Story 1 — Pre-deploy verdict in CI (P1, 25–26 Nov) 🎯 MVP — T010–T018 done on PR #2

**Goal**: every npm lockfile and workspace member assessed against OSV; verdict blocked / review / ready with coverage;
the step fails on blocked or failed coverage.

**Independent test**: on `test/fixtures/controlled/compromised-web3js-1.95.6` the verdict is blocked, the finding
cites `MAL-2024-11183`, names 1.95.8, notes the version was removed from the registry, and the report carries the
`case-label`.

- [x] T010 [US1] Discovery in `src/lockfiles.ts`: find npm/pnpm/Yarn 1 lockfiles, list Bun and Yarn Berry as not assessed and other ecosystems (`Cargo.lock` …) as not assessed; skip `.git`, `node_modules`, vendored directories; never follow symlinks; cap sizes
- [x] T011 [US1] Parsing in `src/lockfiles.ts`: every workspace member and nested package; direct vs transitive and runtime vs dev from a graph walk; aliases and overrides assessed under the real package, identity verified against the registry tarball (FR-001a, research R4); unreachable entries kept (R5)
- [x] T012 [P] [US1] OSV client in `src/osv.ts`: querybatch with pagination, full records, alias grouping, malicious = `MAL-` id or alias, withdrawn records ignored, "not checked" on failure (R6)
- [x] T013 [P] [US1] Registry lookup in `src/registry.ts`: latest stable per direct dependency, removed versions, abbreviated documents with a 60 s timeout, upgrade gap (R7)
- [x] T014 [US1] Rules in `src/verdict.ts` and orchestration in `src/assess.ts`: tiers (malicious > direct runtime > transitive runtime > dev > unreachable; key packages first), verdict rules, coverage complete / partial / failed (R8)
- [x] T015 [US1] Report in `src/report.ts`: verdict and rules, reasons, findings with lockfile and member, fixed-in version, removed-from-registry note, case label, not-assessed list (contracts/action.md)
- [x] T016 [US1] Entry in `src/action.ts` and `action.yml`: inputs `path`, `fail-on`, `key-packages`, `case-label`; job summary; outputs `verdict`, `coverage`; fail on blocked or failed coverage, optionally on review
- [x] T017 [US1] Offline tests in `test/lockfiles.test.ts` and `test/assess.test.ts`: 1.95.6 and 1.95.7 blocked, 1.95.8 no malware finding; real fixture counts (1,520 / 744 / 706 versions; 58 / 29 / 33 with advisories); malformed lockfile and OSV outage give failed coverage, never an empty clean report; unsupported lockfiles listed; alias, override, Git and identity-mismatch cases; unreachable entries
- [x] T018 [US1] Free-mode runs of `dist/index.cjs` on wallet-adapter, anchor `ts/`, drift `sdk/` at the fixture commits; coverage and time recorded in PROJECT.md (6.5–18 s, under the 5 min of SC-001). Local checkouts, not a hosted runner (see T047)

- [ ] T034 [US1] Split not assessed from not checked in `src/verdict.ts` and `src/report.ts`: `notAssessed` (Git, local path, URL, unresolved workspace reference, unsupported lockfile) and `notChecked` (OSV or registry lookup failed), each with its own report section and totals (FR-017, data-model.md); update `test/assess.test.ts`
- [x] T047 [US1] First P1 run on a hosted runner, before P2: a minimal public demo repository under the team's account (approved 25 Nov) with a workflow using this Action at a pinned commit; no secrets, no application code; README states what the assessment checks and does not check. Record commit, Action version, run URL, verdict, coverage and duration; update `README.md` status only after it passes. **Done 25 Nov**: `lemind/dependency-preflight-hosted-check` commit `5cf4f6d`, Action at `0dc4869`, [run 45557722045](https://github.com/lemind/dependency-preflight-hosted-check/actions/runs/45557722045): wallet-adapter blocked (`next@15.3.3`) / complete; anchor `ts/` review / complete; drift `sdk/` blocked (`nanoid@3.3.4`, `zod@4.0.17`) / partial. Action step 3–5 s per target. Same results as the local runs (T018)

**Checkpoint**: P1 works end to end locally, in tests and on a hosted runner.

---

## Phase 3: User Story 2 — Sourced migration guidance (P2, 27 Nov)

**Goal**: for outdated direct runtime dependencies (key packages first), buy one "what changed A → B" answer per package
and version pair from miner 7314, show breaking changes with migration, quote and source, list price and receipt,
never buy twice, respect the caps.

**Independent test**: with a funded testnet wallet on the drift `sdk/` fork, the report lists the breaking changes for
`@coral-xyz/anchor` 0.29.0 → the latest release, each with a quote and a source, plus the receipt; a second run on the
same commit buys nothing (SC-004). Offline: recorded miner answers and a fake payment client.

- [x] T019 ⚠ [US2] Get the owner's approval for `@x402/fetch` and `@x402/evm` (needed by the PR Agent's escrow client, research R9), then add them to `package.json` with the reason in the PR. Blocks T020. **Done 25 Nov**: approved; 2.32.0 pinned exactly (2.28.0 pulls vulnerable zod 3, research R9)
- [x] T020 [US2] Copy the escrow client from `/home/dl/_prog/telegraph-pr-agent/bot/src/x402.ts` into `src/telegraph.ts` (it was written against `@x402/*` 2.28.0; check it compiles and behaves the same on 2.32.0); keep its price guard, budget cap and `PaymentUnknownError`; caps per call 0.05, per run 0.30, at most 10 purchases; no `TELEGRAPH_EVM_PRIVATE_KEY` means free mode (FR-011); never log the key. A purchase needs a wallet, a durably written `reserved` record and the held lease (FR-009b; from T023); otherwise free mode with the reason. **Done 25 Nov**: `src/telegraph.ts` with the PR Agent's 38 client tests in `test/telegraph.test.ts`, passing on 2.32.0, including the real `@x402/fetch` payment path. One change: a configured miner is the only one asked (no leaderboard fallback; FR-007). The Action inputs move to T024, so `action.yml` never lists an input that does nothing
- [x] T021 [US2] Candidate selection in `src/explain.ts`: outdated direct runtime dependencies with a minor or major gap (from `Assessment.outdated`, `runtime` true; transitive and dev-only never, even if they match a key-package pattern); deterministic order (key packages, direct runtime, larger gap, name); at most 10; skipped ones listed with the reason; question "What changed in <package> from <locked> to <latest>?"; target = latest stable, recorded in the report **Done 25 Nov**: `selectCandidates` in `src/explain.ts`, 9 tests in `test/explain.test.ts`. Eligible = declared as a runtime dependency (`Usage.directRuntime`); one candidate per package and version pair, with every lockfile and member listed. On the drift `sdk/` fixture the first candidates are `@coral-xyz/anchor` 0.29.0 and 0.30.1 (the alias `anchor-30`), then `@solana/web3.js` 1.98.0
- [x] T022 [US2] Answer validation in `src/explain.ts`: copy the `migrationAnswer` schema from `/home/dl/_prog/telegraph-pr-agent/bot/src/miner-assessment.ts`, importing `z` from `zod` (4.6.7; the schema needs no `zod/v3`) (research R10); drop unusable answers and count them against the caps; `not_found` and unavailable stated per package, never "no changes"; add a test with an oversized adversarial answer **Done 25 Nov**: `readAnswer` in `src/explain.ts`, 16 tests. Outcomes found / not_found / unusable (with the reason); only documented changes with a quote, a version in (from, to] and a plain HTTPS source are shown, breaking first; a vulnerability the target introduces is kept as a warning (the PR Agent rejects the answer instead); answers over 1,000,000 characters aren't validated
- [ ] T023 [US2] Purchase record in `src/record.ts`: append-only JSONL on a `preflight` branch through the GitHub API (`contents: write`), keyed by package + exact from + exact to; copy the attempt states from `/home/dl/_prog/telegraph-pr-agent/bot/src/ledger.ts` (pending = reserved / request_sent, unknown = unknown_needs_reconciliation; data-model.md); reuse delivered answers even under a different configured miner, keeping the miner that answered; never re-buy pending or unknown keys. Run-level lease in `lease.json` (token, run id, expiry) acquired before paid processing; every write is a commit moved by GraphQL `updateRefs` with `beforeOid`/`afterOid` and requires the token; expired leases taken over only after marking the previous holder's `reserved`/`request_sent` attempts `unknown_needs_reconciliation`; a lost write response means re-read, and stop buying unless the head is ours (research R11). A failed `reserved` write or an unheld lease means no purchase. Verify `updateRefs` against the live API (free) before T025. Fork PRs have no secrets and never reach this path **Done offline 25 Nov** (`src/record.ts`, 15 tests in `test/record.test.ts` against an in-memory branch with the compare-and-swap rule, including two runs racing for the lease). Live `updateRefs` check passed 25 Nov on `lemind/dependency-preflight-hosted-check` (test branch, deleted): a forward move with a stale `beforeOid` and a create of an existing branch are refused, the branch unchanged
- [x] T024 [US2] Report sections in `src/report.ts`: per package, breaking changes and deprecations with migration, quote and link, breaking first, then deprecations and security fixes, oldest version first; purchases with miner, price, receipt, signal; skipped candidates with reasons; why paid explanations were skipped (no wallet, record not writable, lease not held); free mode lists the upgrades that would be explained, with release-note links. Related-party disclosure line for miner 7314. Wire `src/telegraph.ts` into `src/action.ts` and add inputs `miner-id`, `node-url`, `max-price-per-call-usdc`, `budget-cap-usdc`, `max-purchases` to `action.yml` (contracts/action.md), plus `chain-id` (11155111) and `usdc-address` (`0xcc194e1a843B658526D0D5C431f670028582Ae17`), as in the PR Agent **Done 25 Nov (offline)**: `src/purchase.ts` (reuse delivered, skip open, buy with every stage recorded; stop on unknown payment, lost lease, budget cap or unexpected error, each reported), report section in `src/report.ts`, inputs, `github-token` and output `spent-usdc` in `action.yml`; 9 tests in `test/purchase.test.ts`; free-mode smoke run of the bundle on the drift fixture. Not yet run with a wallet (T025)
- [ ] T027 [P] [US2] Offline tests in `test/explain.test.ts` and `test/record.test.ts`: ranking and caps; direct runtime only; reuse of a delivered answer under another miner; pending and unknown keys not re-bought; no purchase when the `reserved` write fails or the lease is held by another run; lease takeover after expiry reconciles stale attempts; lost write response stops buying; `not_found`; invalid answer dropped; free mode buys nothing
- [x] T025 ⚠ [US2] First paid run from the Action on a hosted runner, on the drift `sdk/` fork, about 0.02–0.30 test USDC from a wallet funded by the team wallet; disclosed as a related-party test. Give the owner a command that sources `/home/dl/_prog/telegraph-pr-agent/bot/.env` by absolute path; never read the key **First run 25 Nov**: `lemind/protocol-v2` (fork) branch `preflight-demo` at `9352aeb` (fixture commit `13e8e9b` plus our workflow; drift's own workflows removed), Action at `0670854`, [run 45584252938](https://github.com/lemind/protocol-v2/actions/runs/45584252938): 3 escrow purchases at 0.02 test USDC each (0.06 total) from miner 7314 for `@coral-xyz/anchor` 0.29.0 → 0.32.1, 0.30.1 → 0.32.1 and `@solana/web3.js` 1.98.0 → 3.2.1; all three valid (57, 37 and 16 documented changes with quotes and sources); record and lease on the fork's `preflight` branch as designed. Related-party test. Rerun on the same commit (attempt 2): 0.00 spent, no new ledger rows, the three answers reused (SC-004 passed)
- [ ] T026 ⚠ [US2] Only if the demo needs a web3.js explanation: miner fix in the PR Agent repo (longer registry fetch limit), cold end-to-end test of the exact question, PR, then the production deploy as p11 **Not needed (25 Nov)**: miner 7314 answered `@solana/web3.js` 1.98.0 → 3.2.1 with 16 documented changes

**Checkpoint**: the Anchor explanation with receipt appears in the drift `sdk/` report; a rerun buys nothing.

---

## Phase 4: User Story 3 — Re-check after remediation (P3, 28 Nov)

**Goal**: on a pull request, compare with the base branch: findings resolved, open, new, unverified; one comment updated in
place; says no build or test was run.

**Independent test**: on the controlled compromised repository, a PR moving `@solana/web3.js` 1.95.6 → 1.95.8 shows
the malware finding resolved and the verdict moving from blocked to review (web3.js 1.x is behind 3.x, research R13).

- [x] T030 [US3] Comparison in `src/compare.ts`: assess the base branch (fetched through the GitHub API or a second checkout path, never by running repository code) and the PR head; finding identity = workspace member + package + advisory group, or + `outdated` for outdated findings; statuses resolved, open, new, unverified; resolved only when the head lockfile was parsed and the lookup completed (FR-013, data-model.md) **Done 25 Nov**: `compare` in `src/compare.ts` (advisories matched by member, package and any shared id; outdated by member, package and `outdated`; `unverified` when the head lockfile is missing, not assessed or failed, or the package's OSV or registry lookup didn't complete); the base fetched through the GitHub API in `src/base.ts` (recursive tree, only dependency files under the path, no checkout, refuses a truncated listing or unsafe path); `Assessment.latestUnknown` added
- [ ] T031 [US3] PR comment in `src/action.ts`: create or update one comment found by a hidden marker (`pull-requests: write`); condensed (research R12): base and head verdicts and coverage, resolved / open / new / unverified counts, blocked and review findings with member and package, truncated with an omitted count, a link to the full job summary, and the line that no build or test was run; forks get the summary only
- [ ] T033 [P] [US3] Offline tests in `test/compare.test.ts`: advisory present on base → absent on head with OSV succeeded = resolved; → head OSV timed out = unverified; → head parser failed = unverified; none on base → present on head = new; open; outdated findings by member + package; identity ignores dependency paths; comment stays under 65,536 characters on the wallet-adapter fixture
- [ ] T032 ⚠ [US3] Demo: create the controlled compromised repository under the team's account (public), with a workflow using this Action and `case-label`; open a PR upgrading to 1.95.8; confirm blocked → review, the finding resolved, and the no-build line (SC-006)

**Checkpoint**: the fixing PR shows one updated comment with before and after.

---

## Phase 5: Demo, docs, submission (29–30 Nov)

**Purpose**: the three scenarios end to end, documentation, outside reproduction, submission.

- [ ] T046 ⚠ Clean demo: create a controlled public repository locking `@solana/kit` 8.6.0 only (research R13), with the workflow; confirm ready (npm dependencies assessed)
- [ ] T040 `README.md`: what it is, the three scenarios with real outputs, install (workflow file plus optional secret), costs, limits, disclosure (related-party miner, testnet)
- [ ] T041 Run all scenarios end to end; save the reports under `docs/results/` with date, repository and commit
- [ ] T042 Reproduction by someone outside the team following only the README (SC-005); start as soon as T047 passes; a self-contained prompt for the Grok browser agent can help
- [ ] T043 ⚠ Walkthrough video (2–5 min): problem, run, verdict, explanation with receipt, fix, re-check
- [ ] T044 ⚠ Post in Telegraph's Solana showcase thread: app, repository, results, video
- [ ] T045 ⚠ Submit as a distinct Apps & Agents entry, mission 10, with the five-question commercial summary

---

## Phase 6: User Story 4 — Paste a repository URL (P4, optional)

**Only if P1–P3 are done before the deadline.**

- [ ] T050 [US4] Static page plus one serverless function: public repository URL in, free-mode report for the default branch's latest commit out (reuses `src/assess.ts` and `src/report.ts`), recorded explanations from its `preflight` branch shown, nothing bought on the visitor's behalf (FR-018)

---

## Dependencies and order

- Setup (done) → US1 (done except T034, T047) → T047 → US2 and US3. US2 and US3 are independent of each other; both need US1.
- US2: T047 and T019 (approval) → T020 → T021 → T022 → T023 → T024; T027 alongside T021–T024; T025 after T020–T024 and approval; T026 only if needed.
- US3: T030 → T031; T033 alongside; T032 after T031 and approval.
- Phase 5: T042 after T047; T046 any time after US1; T040–T041 after US2 and US3; T043–T045 last, each with approval.
- US4 only after Phase 5 is safe.

## Parallel opportunities

- US2 and US3 can be developed in parallel once T019 is decided: `src/telegraph.ts`, `src/explain.ts`, `src/record.ts` vs `src/compare.ts`.
- Within US2: T027 tests with T021–T024. Within US3: T033 with T030–T031.
- T034 and T046 can run while US2/US3 are in progress.

## Implementation strategy

1. MVP = US1 (done): a free verdict in CI that blocks the compromised case.
2. Next, US3 needs no approval and closes the "passes after the fix" loop; US2 starts as soon as T019 is approved.
3. Order (25 Nov): docs commit → T047 demo repository → hosted P1 run → P2. Outside reproduction (T042) starts as soon as T047 passes.
4. Paid run (T025), public repositories (T032, T046), video, post and submission only with approval.
