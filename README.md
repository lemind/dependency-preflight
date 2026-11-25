# dependency-preflight

Pre-deploy **npm dependency check** for Solana and any JavaScript/TypeScript project, backed by Telegraph
intelligence.

Run it in CI before you deploy. It:

- flags **compromised** (malware) and **vulnerable** dependency versions, from public advisory data (OSV);
- for outdated key packages (`@solana/*`, `@coral-xyz/anchor`, configurable), buys a sourced "what changed" answer
  from a Telegraph miner: the breaking changes, what to change, quotes and links to the release notes, with a
  receipt for each purchase;
- gives a verdict (**blocked**, **review** or **ready**) with its coverage, and re-checks after you fix it.

**Not a security audit.** It doesn't read your code, run your tests or check Rust crates. "Ready" means your npm
dependencies passed these checks, not that the app is safe to deploy.

Built for the Telegraph Hackathon Season II (Apps & Agents, mission 10, Model Economy). It reuses the
[Telegraph PR Agent](https://github.com/borodedamie/telegraph-pr-agent) team's package-release miner (Telegraph
miner 7314). Testnet only (Ethereum Sepolia test USDC).

**Status:** in development. The free check (P1: lockfiles, OSV advisories, verdict and coverage, job summary, fail on
blocked) works in offline tests and on a GitHub-hosted runner (25 Nov, three pinned Solana repositories:
[run](https://github.com/lemind/dependency-preflight-hosted-check/actions/runs/45557722045)). Paid explanations (P2) are built and tested offline but have not been run with a wallet yet; the re-check on pull requests (P3) is built and tested offline but hasn't run on a pull request yet. Context, plan and tasks: [PROJECT.md](PROJECT.md). Spec:
[specs/001-dependency-preflight/spec.md](specs/001-dependency-preflight/spec.md).
