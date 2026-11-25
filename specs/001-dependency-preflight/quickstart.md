# Quickstart: Dependency preflight

Status (25 Nov): the free check (P1) works in offline tests and on a GitHub-hosted runner: the workflow below, run
in [lemind/dependency-preflight-hosted-check](https://github.com/lemind/dependency-preflight-hosted-check/actions/runs/45557722045) against three pinned target repositories.

## Add it to a repository (free mode)

```yaml
# .github/workflows/dependency-preflight.yml
name: Dependency preflight
on:
  push:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          persist-credentials: false
      - uses: lemind/dependency-preflight@<commit sha>
        with:
          path: .            # or a subdirectory, e.g. sdk
          fail-on: blocked   # or review
```

The report is in the run's summary; outputs `verdict` and `coverage` are available to later steps. Never add
`npm install` or repository scripts to this job.

## Paid explanations (P2): not yet run with a wallet

Built and tested offline (T024); the first paid run is T025. The intended setup: a dedicated testnet wallet with an
escrow deposit, stored as a repository secret, and write access for the purchase record.

```yaml
permissions:
  contents: write          # the purchase record on the preflight branch
concurrency:
  group: dependency-preflight-${{ github.repository }}
  cancel-in-progress: false
jobs:
  preflight:
    runs-on: ubuntu-latest
    timeout-minutes: 15     # shorter than the 20-minute lease
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
        with:
          persist-credentials: false
      - uses: lemind/dependency-preflight@<commit sha>
        env:
          TELEGRAPH_EVM_PRIVATE_KEY: ${{ secrets.TELEGRAPH_EVM_PRIVATE_KEY }}
        with:
          path: sdk
```

Without the secret (and on pull requests from forks) it runs in free mode and lists the upgrades it would explain.
Purchases are capped at 0.05 test USDC per call, 0.30 per run and 10 per run (inputs in contracts/action.md); output
`spent-usdc` reports the run's spend.

## Run locally against a checkout

```bash
cd /home/dl/_prog/dependency-preflight && npm ci --ignore-scripts && npm run build
NODE_USE_ENV_PROXY=1 GITHUB_WORKSPACE=/absolute/path/to/checkout INPUT_PATH=sdk \
  node /home/dl/_prog/dependency-preflight/dist/index.cjs
```

Without `GITHUB_STEP_SUMMARY` the report goes to stdout. `NODE_USE_ENV_PROXY=1` is only needed behind a proxy. Inputs
with a dash need `env "INPUT_CASE-LABEL=…"`. Only free OSV and npm registry reads are made.

## Tests

```bash
cd /home/dl/_prog/dependency-preflight && npm test
```

Offline: recorded OSV answers and a registry stub; any other request fails the test.

## Refresh fixtures (free, read-only)

```bash
cd /home/dl/_prog/dependency-preflight
scripts/fetch-fixture.sh drift-sdk drift-labs/protocol-v2 <commit sha> '^sdk/(yarn\.lock|package\.json)$'
npx esbuild scripts/record-osv.ts --bundle --platform=node --format=esm --outfile=/tmp/record-osv.mjs \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
NODE_USE_ENV_PROXY=1 node /tmp/record-osv.mjs test/fixtures/real/drift-sdk/files test/fixtures/real/drift-sdk/osv.json
```

Changing the commit or the recording changes the expected counts in the tests.

## Expected results (24 Nov, fixture commits)

| Target | Verdict | Coverage |
| --- | --- | --- |
| controlled `@solana/web3.js` 1.95.6 or 1.95.7 | blocked (malicious, fixed in 1.95.8) | complete |
| controlled 1.95.8, registry stub with latest 1.95.8 | ready | complete |
| wallet-adapter | blocked (`next@15.3.3`) | complete |
| anchor `ts/` | review | complete |
| drift `sdk/` | blocked (`nanoid@3.3.4`, `zod@4.0.17`) | partial (`sdk/bun.lock`) |

Against the live registry, 1.95.8 is **review**: `@solana/web3.js` latest is 3.2.1.
