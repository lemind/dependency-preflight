# Scenario 2: breaking upgrades, explained by a paid miner

| | |
| --- | --- |
| Case | Related-party test on testnet: miner 7314 is run by the team whose package-release miner this project reuses. Paid in Ethereum Sepolia test USDC, which has no real value. |
| Repository | [lemind/protocol-v2](https://github.com/lemind/protocol-v2), a fork of `drift-labs/protocol-v2` at `13e8e9b`; branch `preflight-demo`, path `sdk`. Drift's own workflows are removed on that branch. |
| Commit | `9352aebe46796c1f258a0deca96087365c432765`, hosted run [45584252938](https://github.com/lemind/protocol-v2/actions/runs/45584252938), 2026-11-25T09:19:09Z |
| Action commit | `067085460776661bf3f8f98f538b5f0658bf439a` |
| Purchase record | `ledger.jsonl` on the fork's `preflight` branch, read at commit `7008c029ece6ed5ef18b9d5792e8464216ea271d` on 2026-11-25T13:43:52Z |

Not rerun locally: a local run has no wallet, so it would not show the explanations, and the miner was not asked
again. The full hosted report can't be downloaded (GitHub has no API for job summaries), so this file holds what
was kept: the hosted log lines and the purchase record.

## Hosted results (the historical record)

| Attempt | Verdict | Coverage | Spent (test USDC) |
| --- | --- | --- | --- |
| [1](https://github.com/lemind/protocol-v2/actions/runs/45584252938/attempts/1): bought | blocked | partial | 0.06 |
| [2](https://github.com/lemind/protocol-v2/actions/runs/45584252938/attempts/2): same commit, answers reused | blocked | partial | 0.00 |

Both attempts logged the same reason: "high or critical advisory in 2 direct runtime dependencies: nanoid@3.3.4,
zod@4.0.17; advisories in 15 runtime dependency versions; outdated key packages: @coral-xyz/anchor@0.29.0 (latest
0.32.1), @coral-xyz/anchor@0.30.1 (latest 0.32.1), @solana/web3.js@1.98.0 (latest 3.2.1)". The step was set to
`continue-on-error`, because this run is about the explanations.

## Purchases (every row in the record, in order)

| Upgrade | Time (UTC) | State | Quote / price | Receipt hash | Signal hash | Rail, epoch |
| --- | --- | --- | --- | --- | --- | --- |
| `@coral-xyz/anchor` 0.29.0 → 0.32.1 | 2026-11-25T09:19:23.317Z | reserved |  |  |  |  |
| `@coral-xyz/anchor` 0.29.0 → 0.32.1 | 2026-11-25T09:19:25.588Z | request_sent | 0.02 |  |  |  |
| `@coral-xyz/anchor` 0.29.0 → 0.32.1 | 2026-11-25T09:19:36.643Z | delivered | 0.02 | `0x5dc2301d71c7978a9cd069e838d0ef1170b90647ddff078e7274314582b0c0c0` | `0xff28889c118917b6cbb135a39e708aa8f88e0308b01aea773de4e1f9ae354c28` | escrow, 54 |
| `@coral-xyz/anchor` 0.30.1 → 0.32.1 | 2026-11-25T09:19:39.911Z | reserved |  |  |  |  |
| `@coral-xyz/anchor` 0.30.1 → 0.32.1 | 2026-11-25T09:19:42.228Z | request_sent | 0.02 |  |  |  |
| `@coral-xyz/anchor` 0.30.1 → 0.32.1 | 2026-11-25T09:19:50.470Z | delivered | 0.02 | `0x37b21b24e72e91b9ed06b523f79a724da5fb7a5e9a68666ae2043d9440dcfe82` | `0xa40fd5a93e5419aa39634fdd819a3a13cb6f088e7c7ce4a96cbbe4ac0178b77c` | escrow, 54 |
| `@solana/web3.js` 1.98.0 → 3.2.1 | 2026-11-25T09:19:53.650Z | reserved |  |  |  |  |
| `@solana/web3.js` 1.98.0 → 3.2.1 | 2026-11-25T09:19:56.216Z | request_sent | 0.02 |  |  |  |
| `@solana/web3.js` 1.98.0 → 3.2.1 | 2026-11-25T09:20:08.016Z | delivered | 0.02 | `0x94962cc1195ff38e4844be1d4a53184ff6e2b1da54fed266cdf86d00ec1bbd61` | `0x4c920e8c6d66498af2e6d9df332b1b5a094586b25a91a5ae0161d2694db4d462` | escrow, 54 |

Each purchase went reserved → request_sent → delivered, all in attempt 1 (run id `45584252938-1`). Attempt 2 added
no rows.

## Answers

Quoted as the miner delivered them, not edited and not reviewed by us. Quality varies with the release notes:
the first `@solana/web3.js` entry, for example, is commentary rather than a change. Each stored change also carries
the excerpt and source it rests on.

### `@coral-xyz/anchor` 0.29.0 → 0.32.1

57 changes; outcome `found`. The first two, quoted from the stored answer (miner text, truncated to 300 characters):

- breaking at 0.32.0:
  ```text
  lang: Use `solana-invoke` instead of `solana_cpi::invoke` ([#3900](https://github.com/solana-foundation/anchor/pull/3900)).
  ```
- breaking at 0.32.0:
  ```text
  spl: Update SPL dependencies to latest compatible versions ([#3860](https://github.com/solana-foundation/anchor/pull/3860)).
  ```

### `@coral-xyz/anchor` 0.30.1 → 0.32.1

37 changes; outcome `found`. The first two, quoted from the stored answer (miner text, truncated to 300 characters):

- breaking at 0.32.0:
  ```text
  lang: Use `solana-invoke` instead of `solana_cpi::invoke` ([#3900](https://github.com/solana-foundation/anchor/pull/3900)).
  ```
- breaking at 0.32.0:
  ```text
  spl: Update SPL dependencies to latest compatible versions ([#3860](https://github.com/solana-foundation/anchor/pull/3860)).
  ```

### `@solana/web3.js` 1.98.0 → 3.2.1

16 changes; outcome `found`. The first two, quoted from the stored answer (miner text, truncated to 300 characters):

- breaking at 3.2.1:
  ```text
  The method and the option both arrived in 3.2.0 four days ago, so very few projects are using this already.
  ```
- breaking at 3.2.1:
  ```text
  Agave already rejects base58 when `maxSupportedTransactionVersion` is 1 or higher. base64 carries the same bytes at a lower cost.
  ```
