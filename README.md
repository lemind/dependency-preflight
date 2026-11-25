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

**Status:** in development; nothing works yet. Context, plan and tasks: [PROJECT.md](PROJECT.md). Spec:
[specs/001-dependency-preflight/spec.md](specs/001-dependency-preflight/spec.md).
