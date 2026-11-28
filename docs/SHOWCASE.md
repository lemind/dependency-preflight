# dependency-preflight: a pre-deploy dependency check for Solana apps

A GitHub Action that reads a repository's lockfiles before you deploy and gives one verdict: **blocked**, **review**
or **ready**. It also gives a coverage level, so you know what was actually checked. It reads npm (v2 and v3), pnpm
(v6 and v9) and Yarn Classic (v1) lockfiles.

- It flags locked versions with known **malicious-package or vulnerability advisories** in OSV, and **outdated key
  packages** (`@solana/*` and `@coral-xyz/anchor` by default).
- With a testnet wallet, it **buys sourced "what changed" answers** from Telegraph miner 7314 for outdated direct
  runtime dependencies with a minor or major gap. Key packages come first, and it buys at most 10 per run by default.
  Each answer lists breaking changes, deprecations and security fixes, each with a quote and a link. Each purchase
  returns a node-signed Telegraph escrow receipt, which is not an on-chain transaction. An answer is never bought
  twice.
- On a pull request, it re-checks against the base branch. Where the workflow can write comments, it keeps one
  comment up to date: what got fixed, what's still open, what's new. A pull request from a fork gets the re-check in
  the run summary only.

It reads lockfiles and manifests only: nothing is installed, built or run. It's not a security audit.

**Video (3 min):** [youtu.be/NGhZ6B5em8k](https://youtu.be/NGhZ6B5em8k)
**Repository:** [lemind/dependency-preflight](https://github.com/lemind/dependency-preflight), Action pinned at
`2b25fab`

## Results

All run on the pinned commit, 26–27 Nov 2026. The run pages need a GitHub sign-in. Saved reports, commits and
receipts are in [docs/results](results/README.md).

- **Compromised dependency.** This is a controlled test case of the December 2024 `@solana/web3.js` 1.95.6 malware.
  Verdict blocked, coverage complete
  ([run](https://github.com/lemind/preflight-demo-compromised/actions/runs/45811070521)).
- **The fix, re-checked on a pull request.** Moving to 1.95.8 resolves both advisories. The verdict goes from
  blocked to review, because the package is still a major release behind
  ([pull request](https://github.com/lemind/preflight-demo-compromised/pull/2)).
- **Clean project.** On `@solana/kit` 8.6.0 the verdict is ready, coverage complete
  ([run](https://github.com/lemind/preflight-demo-clean/actions/runs/45811076777)).
- **Upgrades explained by a paid miner.** On a fork of `drift-labs/protocol-v2` (the `sdk` package), the run bought
  one new answer for 0.02 test USDC and reused three at no cost
  ([run](https://github.com/lemind/protocol-v2/actions/runs/45809367818)).

## Commercial summary

### Who is the user or buyer, and how often do they have this problem?

Teams that ship Solana wallets, DeFi and institutional apps in JavaScript/TypeScript, where one bad dependency costs
real money. In December 2024, `@solana/web3.js` 1.95.6 and 1.95.7 shipped malware that stole private keys
([advisory](https://osv.dev/vulnerability/GHSA-jcxm-7wvp-g6p5)). The problem comes back with every dependency update.
Once the workflow is set up for push and pull request events, the check runs on every one of them. The buyer is the
team that installs the Action and funds a small testnet wallet, or a platform such as Solana that offers the check
to its developers.

### What does the app improve over today's options?

`npm audit` and Dependabot find known vulnerabilities and propose dependency updates. dependency-preflight adds three
things:

- a single CI verdict;
- explicit coverage (complete, partial or failed), so dependencies it couldn't check are never silently "ready";
- optional explanations of what an upgrade changes, for the exact version pair, with quotes and links, at 0.02 test
  USDC per upgrade. An answer is reused afterwards.

### What works today, with proof of Telegraph use, spending and latency?

- A GitHub Action pinned at `2b25fab`, with 158 offline tests.
- **Telegraph use:** four escrow purchases from miner 7314 on 25 and 26 Nov, 0.08 test USDC in total, with four
  responses delivered. Three contained explanations, with 57, 37 and 16 documented changes. One returned "not found",
  and the report says so.
- **Proof:** each purchase has a node-signed receipt hash and a signal hash, recorded in `ledger.jsonl` on the
  fork's `preflight` branch. Reruns spent 0.00 and reused the answers.
- **Latency:** each answer was recorded 5.4 to 11.8 s after its request was sent, including the record writes. That
  is four purchases, not a benchmark.
- **Spend controls:**
  - a per-call price cap, a budget per run and a cap on purchases per run;
  - a lease, so two runs never buy at once;
  - no purchases on `pull_request_target` or for pull requests from forks;
  - Ethereum Sepolia and Base Sepolia only: any other chain, mainnet included, is refused. The demo payments used
    Ethereum Sepolia.

### Why would someone use or pay for it, and what remains before production?

The free check can flag locked versions with known OSV vulnerability or malicious-package advisories before merge.
The paid part saves reading release notes by hand, at cents per upgrade.

Before production:

- mainnet payments;
- miners other than our own, for independent answers;
- checking the miner's quotes against the release notes;
- Yarn Berry and Bun lockfiles;
- real users. So far all usage is the team's own. The
  [outside reproduction](https://github.com/lemind-bt/preflight-repro/pull/1) was done by an AI agent on a separate
  GitHub account that the team controls.

### How can someone try it, and who maintains it?

Add one workflow file from the [README](../README.md#install). The free check needs no wallet and no secret. For
paid explanations, add a testnet wallet key as a repository secret. Step-by-step reproduction:
[docs/REPRODUCE.md](REPRODUCE.md). It is maintained by the team behind the Telegraph PR Agent and miner 7314.

## Disclosure

- Testnet only: payments are Ethereum Sepolia test USDC.
- Miner 7314 is run by our team, so every purchase is a related-party test.
- The Action does not check the miner's quotes against the release notes.
- The demo repositories are controlled test cases, labelled in every report.
- There are no independent users yet.
