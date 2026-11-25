# dependency-preflight

A GitHub Action that checks a project's **npm dependencies** before you deploy. It works for Solana or any
JavaScript/TypeScript project and draws on Telegraph intelligence.

It reads your lockfiles and manifests (nothing is installed, built or run) and:

- flags **compromised** (malware) and **vulnerable** locked versions, using public advisory data from
  [OSV](https://osv.dev);
- flags outdated **key packages** (`@solana/*` and `@coral-xyz/anchor` by default; you can change the list);
- with a testnet wallet, **buys a sourced "what changed" answer** for each upgrade it flags, from a Telegraph miner. The
  answer lists breaking changes and deprecations, what to change, and quotes and links from the release notes. You
  get a receipt for each purchase, and an answer is bought only once;
- gives a **verdict** (**blocked**, **review** or **ready**) and says how much it could check (**coverage**:
  complete, partial or failed). On a pull request, it **re-checks** against the base branch and posts one comment
  that says what the change resolved, what is still open and what is new.

**Not a security audit.** It doesn't read your code, run your tests or check Rust crates. "Ready" means the npm
dependencies passed these checks. It doesn't mean the app is safe to deploy.

Built for the Telegraph Hackathon Season II (Apps & Agents, mission 10, Model Economy). **Testnet only:** payments
are in Ethereum Sepolia test USDC.

## Three scenarios, run on GitHub-hosted runners

All three are test cases we set up ourselves, not findings in someone's live project. Commits, receipts and full
reports: [docs/results](docs/results/README.md).

### 1. Compromised dependency, then the fix (controlled test case)

Repository: [lemind/preflight-demo-compromised](https://github.com/lemind/preflight-demo-compromised), set up
around a past incident: the December 2024 compromise of `@solana/web3.js`.

- `main` locks `@solana/web3.js` **1.95.6**, a malicious version. The verdict is **blocked**, the run fails, and the
  report names [MAL-2024-11183](https://osv.dev/vulnerability/MAL-2024-11183).
- [Pull request #1](https://github.com/lemind/preflight-demo-compromised/pull/1) upgrades to 1.95.8. The Action
  re-checks it and posts this comment (as posted, abridged):

  | | Base | This pull request |
  | --- | --- | --- |
  | Verdict | 🛑 blocked | **⚠️ review** |
  | Coverage | complete | complete |

  > Findings: 2 resolved · 1 still open · 0 new · 0 not verified.
  >
  > **Resolved**
  > - 🔑 `@solana/web3.js` `1.95.6` in `.`: **malicious** MAL-2024-11183, GHSA-2mhj-xmf4-pr8m
  > - 🔑 `@solana/web3.js` `1.95.6` in `.`: high GHSA-jcxm-7wvp-g6p5, CVE-2024-54134
  >
  > **Still open**
  > - 🔑 `@solana/web3.js` `1.95.6` → `1.95.8` in `.`: key package a major release behind

  The malware is resolved. The verdict is now **review**, not **ready**, because 1.x is a major release behind the
  latest `@solana/web3.js`.

### 2. Breaking upgrades, explained by a paid miner (related-party test)

Repository: a fork of `drift-labs/protocol-v2` at `13e8e9b` ([lemind/protocol-v2](https://github.com/lemind/protocol-v2),
branch `preflight-demo`, path `sdk`). Drift's own workflows are removed on that branch, so none of its code runs.

- The verdict is **blocked**: high-severity advisories in `nanoid@3.3.4` and `zod@4.0.17` (direct runtime
  dependencies). Coverage is partial.
- Three key packages are a major release behind. The Action bought one explanation for each from Telegraph miner
  7314, at 0.02 test USDC each (0.06 in total, paid through escrow):

  | Upgrade | Changes in the answer |
  | --- | --- |
  | `@coral-xyz/anchor` 0.29.0 → 0.32.1 | 57 |
  | `@coral-xyz/anchor` 0.30.1 → 0.32.1 | 37 |
  | `@solana/web3.js` 1.98.0 → 3.2.1 | 16 |

  Each change says what changed, at which version and what to do. It quotes the release notes and links to them.
- [Rerunning the same commit](https://github.com/lemind/protocol-v2/actions/runs/45584252938) spent **0.00**: the
  answers are reused from the purchase record on the fork's `preflight` branch. The receipts, with their receipt and
  signal hashes, are in `ledger.jsonl` on that branch.

### 3. Clean project (controlled test case)

Repository: [lemind/preflight-demo-clean](https://github.com/lemind/preflight-demo-clean). It depends only on
`@solana/kit` 8.6.0, the latest release on 25 Nov 2026. Its lockfile holds 47 locked versions.

- [Run](https://github.com/lemind/preflight-demo-clean/actions/runs/45594603907):
  `Verdict: ready, coverage: complete, spent: 0.00 test USDC`.
- "Ready" can change: a new advisory or a new major release of a key package turns it to blocked or review.

The free check was also run on three pinned public Solana repositories
([run](https://github.com/lemind/dependency-preflight-hosted-check/actions/runs/45557722045)).

## Install

### Free check

Add `.github/workflows/dependency-preflight.yml`:

```yaml
name: Dependency preflight
on:
  push:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: write # the re-check comment on pull requests
jobs:
  preflight:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          persist-credentials: false
      # Reads lockfiles and manifests only; nothing is installed, built or run.
      - uses: lemind/dependency-preflight@98e6c7acf637efbad749eeef65e975e7231ab1f2
```

The report is in the run's summary. The step fails on **blocked**; set `fail-on: review` to fail on review too. A
failed coverage always fails the step. Don't add `npm install` or repository scripts to this job, and never use
`pull_request_target`.

### Paid explanations (optional)

1. Create a **dedicated testnet wallet**. Deposit Sepolia test USDC into the Telegraph escrow for it.
2. Store its private key as the repository secret `TELEGRAPH_EVM_PRIVATE_KEY`.
3. Give the job write access for the purchase record, and run one job at a time per repository:

```yaml
permissions:
  contents: write # the purchase record on the preflight branch
  pull-requests: write
concurrency:
  group: dependency-preflight-${{ github.repository }}
  cancel-in-progress: false
jobs:
  preflight:
    runs-on: ubuntu-latest
    timeout-minutes: 15 # shorter than the 20-minute lease
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          persist-credentials: false
      - uses: lemind/dependency-preflight@98e6c7acf637efbad749eeef65e975e7231ab1f2
        env:
          TELEGRAPH_EVM_PRIVATE_KEY: ${{ secrets.TELEGRAPH_EVM_PRIVATE_KEY }}
```

Without the secret, or without write access, the Action runs the free check and says why it skipped paid
explanations. Pull requests from forks never get the secret.

### Inputs and outputs

| Input | Default | |
| --- | --- | --- |
| `path` | `.` | directory to assess |
| `fail-on` | `blocked` | `blocked` or `review` |
| `key-packages` | `@solana/*,@coral-xyz/anchor` | comma-separated patterns |
| `case-label` | | label at the top of the report |
| `github-token` | `${{ github.token }}` | purchase record, base branch, comment |
| `miner-id` | `7314` | the only miner asked |
| `max-price-per-call-usdc` | `0.05` | highest price for one answer |
| `budget-cap-usdc` | `0.30` | most spent in one run |
| `max-purchases` | `10` | most upgrades explained in one run |
| `node-url`, `chain-id`, `usdc-address` | Telegraph devnode, Sepolia, test USDC | |

Outputs: `verdict`, `coverage`, `spent-usdc`. The full contract:
[contracts/action.md](specs/001-dependency-preflight/contracts/action.md).

## Costs

- **The free check costs nothing.** It uses OSV and the npm registry, without keys.
- **An explanation costs what the miner quotes.** Miner 7314 quoted 0.02 test USDC on 25 Nov 2026. A quote above
  `max-price-per-call-usdc` is refused, and a run stops at `budget-cap-usdc`.
- Each upgrade (package, from, to) is bought once per repository; later runs reuse the answer.

## Limits

- npm ecosystem only: `package-lock.json` and `npm-shrinkwrap.json` (v2 and v3), `yarn.lock` (v1) and
  `pnpm-lock.yaml` (v6 and v9). Yarn Berry lockfiles, other ecosystems' dependency files (Cargo, pip and others) and
  manifests without a lockfile are listed as not assessed.
- Dependencies from Git, a local path or a URL can't be looked up, so they are listed as not assessed and coverage is
  partial.
- The verdict is only as complete as OSV. A version with no known advisory isn't proven safe.
- The miner's answers are drawn from release notes, and their quality depends on those notes. Each change carries the
  quote it rests on; check it before you act on it.
- The base of a pull request is read through the GitHub API. A base tree too large to list in one request isn't
  compared; the comment says so.

## Disclosure

- **Related party:** miner 7314 is run by the [Telegraph PR Agent](https://github.com/borodedamie/telegraph-pr-agent)
  team, whose package-release miner this project reuses. Every report with purchases says so.
- **Testnet only:** all payments so far were Sepolia test USDC, with no real value.

## Status

What works today (25 Nov 2026), each step run on GitHub-hosted runners:

- **P1** (free check: lockfiles, OSV advisories, verdict and coverage, job summary, fail on blocked);
- **P2** (paid explanations, purchase record, receipts, reuse);
- **P3** (pull request re-check and comment).

Not done yet: an outside reproduction from this README. Built and tested offline, but not yet in the pinned Action:
separate "not assessed" and "not checked" sections in the report (T034).

Context, plan and tasks: [PROJECT.md](PROJECT.md), [plan](specs/001-dependency-preflight/plan.md),
[tasks](specs/001-dependency-preflight/tasks.md). Spec:
[specs/001-dependency-preflight/spec.md](specs/001-dependency-preflight/spec.md).
