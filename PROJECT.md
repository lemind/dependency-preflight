# dependency-preflight: context, spec, plan and tasks

One file to start from. The detailed spec is [specs/001-dependency-preflight/spec.md](specs/001-dependency-preflight/spec.md),
and today's research is [docs/research-2026-11-24.md](docs/research-2026-11-24.md). Dates are 2026; the deadline is
**1 Dec 2026, 23:59 UTC**.

---

## 1. Context: why this exists

**Who we are.** The Telegraph PR Agent team (lemind, borodedamie, codexempire). For the Telegraph Hackathon Season II
we built two things:

- [Telegraph PR Agent](https://github.com/borodedamie/telegraph-pr-agent): a GitHub Action that, for each dependency
  update past the AI model's cutoff, buys a sourced "what changed" answer on Telegraph and opens a PR.
- **Miner 7314, Package Release Intelligence**: the Telegraph miner that sells those answers. It gives breaking
  changes, deprecations and security fixes between two versions of any npm package, each with a verbatim quote and a
  link. Endpoint `https://telegraph-pr-miner-n30sk.vercel.app`, intent `QUESTION_ANSWERING_GENERAL`, 0.02 test USDC.

**Why a second app.** On 24 Nov Ahmed Ali (Telegraph co-founder) asked us to build a commercial use case for Solana
that reuses our miner and agent, which Telegraph will present to Solana. His brief, in short:

- A **pre-deploy dependency check**: a developer connects a repository and gets an independent assessment of
  dependency risks, breaking changes, migration requirements, and whether the app is ready to deploy, backed by
  authoritative sources and Telegraph intelligence.
- Focus on **wallets, DeFi and institutional apps**, where a compromised dependency or a breaking change costs real
  money. Example: `@solana/web3.js` 1.95.6 and 1.95.7 (Dec 2024) shipped malware that stole private keys.
- **Three scenarios:** a compromised dependency, a breaking upgrade, a clean assessment. Historical or controlled
  cases are allowed, clearly labelled.
- **Go beyond detection:** show exactly what to change, why, and whether the app passes after the fix.
- **GitHub Action first** (it fits CI/CD); a paste-a-URL web page is nice to have. "Prioritise functionality over
  interface. Keep scope manageable, end to end."
- **Repositories:** `anza-xyz/wallet-adapter`, `solana-foundation/anchor`, `drift-labs/protocol-v2`.
- **Deliverables:** submit as a **distinct Apps & Agents entry, mission 10 (Model Economy)**, and post the app, the
  repo, the results and a short walkthrough video in Telegraph's Solana showcase forum thread.

**Commercial idea.** Solana (or any platform) offers it to developers so that every repository update is checked
independently before deployment. That makes it a recurring check, paid per explanation in cents.

**Name.** Generic on purpose (it works for any npm project); Solana is the first market and the demo.

## 2. What we're building (spec summary)

A check that runs in CI (and optionally from a web page), reads every npm lockfile in a repository, and writes **one
report with a verdict**.

| Priority | Story | Done when |
| --- | --- | --- |
| P1 | **Verdict in CI**: every lockfile, including monorepo members and nested packages; every locked version checked against OSV, including malicious versions; verdict **blocked / review / ready**; the step fails on blocked | the controlled repo with `@solana/web3.js` 1.95.6 is **blocked**, labelled historical, and names a safe version |
| P2 | **Paid explanations**: for outdated key packages (`@solana/*`, `@coral-xyz/anchor`) and runtime dependencies, buy "what changed A → B" from miner 7314, showing changes, migration, quote, source and receipt; never buy twice; caps | Drift `sdk/` `@coral-xyz/anchor` 0.29.0: breaking changes with quotes, plus the receipt |
| P3 | **Re-check after the fix**: on a PR, compare with the base branch, with findings marked resolved, open or new; one comment updated in place | on the fixing PR the dependency verdict moves from **blocked** to review or ready; the comment says no build or test was run |
| P4 | *Optional* **web page**: paste a public repo URL, get the free-mode report | only if P1–P3 are done |

**Verdict rules** (for the npm dependency scope only):
- **blocked**: any malicious version, or a high/critical advisory in a direct runtime dependency.
- **review**: other runtime advisories, an unchecked runtime dependency, or an outdated key package (newer major, or
  newer minor on 0.x), explained or not. An explanation says what to change; it never lowers the verdict.
- **ready (npm dependencies assessed)**: everything else. Never "the app is safe to deploy".

**Coverage status**, shown next to the verdict:
- **complete**: every supported npm lockfile assessed.
- **partial**: a lookup didn't complete, an unsupported lockfile, or Rust files present.
- **failed**: nothing could be assessed. That is never shown as an empty finding list, and it fails the CI step
  like blocked.

**Positioning:** a pre-deploy **npm dependency assessment** (known advisories, malicious versions, migration risk,
with evidence and a re-check). Not a security audit or a deployment guarantee.

**Out of scope:**
- Rust (`Cargo.lock`), listed as "not assessed" (coverage becomes partial).
- Yarn Berry and Bun lockfiles, listed as "not assessed". Supported: npm v2/v3, pnpm v6/v9, Yarn 1.
- Building, testing or running the app: the re-check after a fix is a dependency re-check, and says so.
- Private repositories.
- Running or installing any code from the scanned repository.
- Mainnet.

**Defaults:**
- Spending caps of 0.05 test USDC per call, 0.30 per run and at most 10 purchases per run. Candidates are ranked key
  packages first, then direct runtime dependencies, larger jumps first, then name. Charged unusable replies count.
- No wallet means free mode.
- "Outdated" means a newer major or minor release.

## 3. What research showed (24 Nov, free checks)

- **All three target repositories have real findings:**

  | Repo | Locked versions | With OSV advisories | Malicious |
  | --- | --- | --- | --- |
  | wallet-adapter | 1,520 | 58 | 0 |
  | anchor `ts/` | 744 | 29 | 0 |
  | drift `sdk/` | 706 | 33 | 0 |

  Most are transitive dev tools, so ranking matters.
- **The breaking-upgrade case is a current finding:** Drift `sdk/` locks `@coral-xyz/anchor` 0.29.0. Miner rules
  (free, local) give 22 breaking changes for 0.29 → 0.30, quoted. `@solana/kit` 2.3 → 3.0 gives 10.
- **The compromised case needs a controlled repo:** none of the three locks 1.95.6/1.95.7. OSV flags both
  (`GHSA-jcxm-7wvp-g6p5`, `MAL-2024-11183`). npm removed them.
- **The clean case works:** `@solana/web3.js` 1.95.5 → 1.95.8 has 0 breaking changes and no advisories.
- **Problems:**
  - `@solana/web3.js`'s registry record is 12 MB and takes 8.2 s, against the miner's 10 s limit, so it times out.
    The miner needs a fix. The abbreviated record lacks release dates, so the fix is a longer limit for the registry,
    not a smaller document.
  - `@solana/spl-token` versions don't match its repository's tags, so expect `not_found`.
- **All three are monorepos or nested packages.** The PR Agent rejects workspaces; a read-only report can read them.

## 4. Plan

**Stack:**
- TypeScript, Node 24, packaged as a GitHub Action (one bundled file, like the PR Agent).
- vitest for offline tests with recorded fixtures: the three real lockfiles plus a controlled compromised fixture.

**Reuse from the PR Agent** (copy, don't share code; KISS over DRY):
- **Lockfile reading:** the parsing approach and library (`@yarnpkg/parsers`), extended to every
  workspace member.
- **Telegraph payment:** the escrow purchase from `bot/src/x402.ts`, with `viem` for signing.
- **Answer validation:** the `zod` schema for miner answers (`bot/src/assessment.ts`).
- **Purchase record:** an append-only application record on a `preflight` branch in the installer's repo, like the
  PR Agent's `ledger` branch (a git branch, not tamper-proof storage). It is keyed by package + exact from + exact to.
  Attempt states are copied from the PR Agent: **pending** before paying, **delivered** with the receipt, **unknown**
  on an ambiguous outcome. Pending and unknown keys are never re-bought until reconciled. The workflow's
  `concurrency` group stops two runs overlapping on one repository.

**New dependencies** (need approval, reasons in the first PR): `@actions/core`, `@yarnpkg/parsers`,
`semver`, `viem`, `zod` (all already used by the PR Agent), plus a YAML parser for `pnpm-lock.yaml` if
`@yarnpkg/parsers` isn't enough.

**External services:**
- **OSV** (free): `/v1/querybatch` returns only advisory ids (handle its pagination); `/v1/vulns/{id}` gives severity,
  affected ranges and fixed versions. **Malicious** = the id or any alias starts with `MAL-`, classified separately
  from vulnerabilities. Aliases (e.g. `GHSA-jcxm-7wvp-g6p5` and `MAL-2024-11183`) are grouped as one issue.
- **npm registry** (latest versions): free.
- **Telegraph** (`POST /engine/v1/ask/7314`, escrow): paid.

**Structure:**

```text
action.yml               inputs: wallet secret (optional), miner id, caps, fail-on, key packages
src/
  lockfiles.ts           find every lockfile; parse npm/pnpm/yarn/bun; every workspace member; direct vs transitive, runtime vs dev
  osv.ts                 batch query + advisory details (severity, fixed in, malicious)
  registry.ts            latest stable versions; removed versions; generous timeout for huge records
  verdict.ts             rank findings, apply the verdict rules, "not checked" handling
  explain.ts             pick upgrades worth explaining, reuse saved answers, buy from the miner, validate
  telegraph.ts           escrow payment client (copied from the PR Agent), price and run caps
  record.ts              purchases and explanations on the `preflight` branch
  compare.ts             base vs head findings: resolved, open, new
  report.ts              one markdown report: verdict, rules, findings, explanations, receipts, not assessed
  action.ts              entry point: job summary, PR comment (create or update), exit code
test/fixtures/           wallet-adapter pnpm-lock, anchor ts/yarn.lock, drift sdk/yarn.lock, compromised fixture
dist/index.cjs           bundled Action
```

**Workflow security and permissions:**
- Triggers: `push`, `pull_request` and `workflow_dispatch`. Never `pull_request_target`.
- The checkout uses `persist-credentials: false`, and the workflow never runs `npm install` or any script from the
  repository. It only reads lockfiles and manifests (FR-014), so one job can hold the wallet safely.
- Writes go through the GitHub API with the job's `GITHUB_TOKEN`, not git credentials:
  - the record needs `contents: write`;
  - the PR comment needs `pull-requests: write`;
  - everything else needs read access only.
- PRs from forks get a read-only token and no secrets: free mode, results in the run summary only, with no record
  write and no comment.

**Demo repositories** (forks or controlled repos under our account):
1. **Compromised (historical, controlled):** a small repo whose lockfile pins `@solana/web3.js` 1.95.6. The lockfile
   is written by hand, since npm no longer serves the version. A PR moves it to 1.95.8, which is the re-check demo.
2. **Breaking upgrade (current):** a fork of `drift-labs/protocol-v2`, assessing `sdk/` (Anchor 0.29.0).
3. **Clean (current):** a small controlled repo on current, advisory-free versions of key packages (the three targets
   all have advisories and Rust files, so none can be the clean case).
4. Free-mode reports on `anza-xyz/wallet-adapter` and `solana-foundation/anchor` `ts/` as the large real-world runs.

**Miner fix (in the PR Agent repo, deploy as p11), not on the critical path.** The 10 s is the miner's own
per-source fetch limit, separate from its 20 s answer budget and the function's 30 s maximum. Fix: a longer limit
for `registry.npmjs.org`, keeping the full record (the miner needs its release dates). Measure a cold end-to-end run
of the exact `@solana/web3.js` question, including total time and memory. The paid demo uses Anchor, which already
works, so this only matters if the demo needs a web3.js explanation.

**Explanation targets:** the latest stable release at run time, recorded in the report. Demos pin the repository
commit and record the resolved target (e.g. Anchor 0.29.0 → whatever is latest on the run date).

## 5. Tasks

⚠ = needs explicit approval (spends testnet funds, public post, or new dependencies). Day targets are guides.

### Phase 0: setup (25 Nov)
- [ ] T001 ⚠ Approve dependencies; `package.json`, `tsconfig.json`, vitest, esbuild bundle script, `action.yml` skeleton
- [ ] T002 Save fixtures, pinned: for each target repo the commit SHA, lockfile path and sha256, workspace manifests and config, retrieval date; plus recorded OSV responses with capture time, so offline tests don't drift with the live database
- [ ] T003 Write controlled fixtures, labelled historical where relevant: npm `package-lock.json` v3 with `@solana/web3.js` 1.95.6; the same with 1.95.7; the same with 1.95.8 (clean); a malformed lockfile; a Yarn Berry or Bun lockfile (must come out "not assessed")
- [ ] T004 CI: tests and a bundle-is-up-to-date check on every push and PR

### Phase 1: P1, verdict in CI (25–26 Nov)
- [ ] T010 `lockfiles.ts`: find all npm/pnpm/yarn/bun lockfiles; list non-npm files (Cargo.lock) as not assessed
- [ ] T011 `lockfiles.ts`: every workspace member and nested package; direct vs transitive, runtime vs dev
- [ ] T012 `osv.ts`: batch query with pagination; full advisory records (severity, ranges, fixed versions); malicious = `MAL-` id or alias; alias grouping; "not checked" on failure
- [ ] T013 `registry.ts`: latest stable per direct dependency; removed versions; long timeout for big records
- [ ] T014 `verdict.ts`: ranking (malicious > direct runtime > transitive runtime > dev; key packages first), verdict rules, coverage status (complete / partial / failed)
- [ ] T015 `report.ts`: markdown report (verdict and rules, findings with file and member, fixed-in version, historical label, not assessed)
- [ ] T016 `action.ts`: job summary, exit code (fail on blocked; `fail-on: review` option)
- [ ] T017 Tests, offline: 1.95.6 and 1.95.7 blocked, 1.95.8 with no malware finding; the three pinned real lockfiles parse, with counts matching the recorded OSV fixtures; malformed lockfile and OSV outage give partial or failed coverage, never an empty clean report; unsupported lockfiles are listed
- [ ] T018 Free-mode runs on wallet-adapter, anchor `ts/` and drift `sdk/`; report coverage and elapsed time; each under 5 min (SC-001)

### Phase 2: P2, paid explanations (27 Nov)
- [ ] T020 `telegraph.ts`: copy the escrow client; per-call and per-run caps; no wallet means free mode
- [ ] T021 `explain.ts`: candidates ranked deterministically (key packages, direct runtime, larger jump, name); max 10 per run; skipped ones listed with the reason; question "What changed in X from A to B?"
- [ ] T022 Validate answers with the copied schema; drop unusable ones; `not_found` / unavailable stated, never "no changes"
- [ ] T023 `record.ts`: `preflight` branch record via the GitHub API; attempt states pending, delivered and unknown; reuse delivered answers; block pending/unknown keys until reconciled; workflow `concurrency` group (SC-004)
- [ ] T024 Report section: per package, breaking changes and deprecations, migration, quote, link; TS before Rust-only items; receipts
- [ ] T025 ⚠ First paid run **from the Action** (hosted runner, escrow) on the drift `sdk/` fork, about 0.02–0.30 test USDC, wallet funded from the team wallet. It is a related-party test, disclosed as such
- [ ] T026 ⚠ (only if the demo needs a web3.js explanation) Miner fix in the PR Agent repo: registry fetch limit; cold end-to-end test of the exact question; PR, then the production deploy as p11

### Phase 3: P3, re-check after the fix (28 Nov)
- [ ] T030 `compare.ts`: assess the base branch and the PR head; finding identity = workspace member + package + advisory group (paths are context); resolved, open, new
- [ ] T031 PR comment: create or update one comment (hidden marker), with before and after verdicts
- [ ] T032 Demo: on the compromised repo, a PR upgrading to 1.95.8 moves the dependency verdict from blocked to review or ready; the comment says no build or test was run (SC-006)

### Phase 4: demo, docs, submission (29–30 Nov)
- [ ] T040 README: what it is, the 3 scenarios with real outputs, install (workflow file plus optional secret), costs, limits, disclosure (related-party miner, testnet)
- [ ] T041 Run all scenarios end to end; save the reports under `docs/results/` with date and commit
- [ ] T042 Reproduction by someone outside the team, following only the README (SC-005); Grok can help. Do it as soon as P1 runs (about 27 Nov), not at the end
- [ ] T043 ⚠ Walkthrough video (2–5 min): problem, run, verdict, explanation with receipt, fix, re-check
- [ ] T044 ⚠ Post in Telegraph's Solana showcase thread: app, repo, results, video
- [ ] T045 ⚠ Submit as a distinct Apps & Agents entry, mission 10, using the five-question commercial summary

### Phase 5: P4, web page (only if time is left)
- [ ] T050 Static page plus one serverless function: repo URL in, free-mode report out, no purchases on the visitor's behalf

## 6. Open points

- Whether this second entry can win separately: rules say one Apps delivery award per group, so its main value is
  the Solana showcase and visibility. Confirmed as a distinct entry by Ahmed on 24 Nov.
- No licence file yet (the PR Agent repo has none either).
- The miner's Telegraph score is 0 since 17 Nov (being investigated by Telegraph). It doesn't block this app, which
  buys from 7314 by id.

## 7. Review decisions (24 Nov)

An external review of this plan found five gaps before implementation. All accepted:

1. **"ready" versus Rust "not assessed":** the verdict is scoped to npm ("ready (npm dependencies assessed)") and a
   separate coverage status (complete / partial / failed) is always shown.
2. **OSV:** the batch endpoint returns ids only, so full records are fetched. Malicious means a `MAL-` id or alias,
   aliases are grouped, and there are tests for 1.95.6 and 1.95.7 (blocked) and 1.95.8 (clean).
3. **Lockfile support** narrowed to what we can test: npm v2/v3, pnpm v6/v9, Yarn 1. Yarn Berry and Bun are "not
   assessed". Fixtures are pinned by commit and hash, with recorded OSV responses.
4. **Purchases:** pending, delivered and unknown attempt states, reconciliation, a concurrency group, at most 10
   purchases per run with deterministic ranking, and an unexplained key upgrade means review.
5. **Permissions:** `pull_request`, never `pull_request_target`. Least-privilege writes go through the API; fork PRs
   get free mode with the summary only. "Passes after the fix" means a dependency re-check, not a build or test.

Also: the miner fix is off the critical path (Anchor already works); the paid test runs from the Action, not a
script; outside reproduction moved earlier.
