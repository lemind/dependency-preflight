# dependency-preflight

Pre-deploy dependency check for Solana and any npm project, backed by Telegraph intelligence.

Point it at a repository and it reports, before you deploy:

- dependency versions that are compromised or have known advisories (OSV);
- upgrades that break your code, with exactly what changes and why, quoted from the release notes and bought as a sourced answer from a Telegraph miner (with a receipt);
- a verdict (ready / review / blocked), and the same check again after you fix it.

Built for the Telegraph Hackathon Season II (Apps & Agents, mission 10, Model Economy). It reuses the [Telegraph PR Agent](https://github.com/borodedamie/telegraph-pr-agent) team's package-release miner (Telegraph miner 7314).

**Status:** in development; nothing below is built yet. Testnet only (Ethereum Sepolia test USDC).
