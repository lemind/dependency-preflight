# Controlled fixtures

Written by hand for offline tests. They are **controlled test cases**, not scans of real repositories.

| Directory | What it is | Expected |
| --- | --- | --- |
| `compromised-web3js-1.95.6` | npm lockfile v3 pinning `@solana/web3.js` 1.95.6. **Historical:** the December 2024 compromise (`GHSA-jcxm-7wvp-g6p5`, `MAL-2024-11183`); npm has removed the version, so this lockfile can't come from a real install today and has no `integrity` field | blocked, malicious finding, fixed in 1.95.8 |
| `compromised-web3js-1.95.7` | the same with 1.95.7, the other compromised version. **Historical** | blocked |
| `clean-web3js-1.95.8` | the same with 1.95.8, the first fixed release | no malware finding |
| `malformed` | a truncated `package-lock.json` | lockfile listed as failed to parse; coverage partial or failed, never an empty clean report |
| `yarn-berry` | a Yarn Berry (`__metadata`) `yarn.lock` | listed as not assessed |
| `bun` | a Bun text `bun.lock` | listed as not assessed |

Only the `@solana/web3.js` entry is locked; its own dependencies are left out on purpose, so the tests check exactly one
package version.
