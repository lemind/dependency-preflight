# Quickstart: Dependency preflight

Status (24 Nov): the free check (P1) works in local runs and offline tests. It has not yet run on a hosted runner
against a target repository, so the workflow below is the intended setup, not a verified one.

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
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4
        with:
          persist-credentials: false
      - uses: lemind/dependency-preflight@<commit sha>
        with:
          path: .            # or a subdirectory, e.g. sdk
          fail-on: blocked   # or review
```

The report is in the run's summary; outputs `verdict` and `coverage` are available to later steps. Never add
`npm install` or repository scripts to this job.

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
