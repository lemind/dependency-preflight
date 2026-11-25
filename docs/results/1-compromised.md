# Scenario 1: compromised dependency, then the fix

| | |
| --- | --- |
| Case | Controlled test case of a past incident (the December 2024 `@solana/web3.js` compromise). Not a finding in anyone's live project. |
| Repository | [lemind/preflight-demo-compromised](https://github.com/lemind/preflight-demo-compromised) |
| Base (main) | `0925e318530182745cb3f5315b115359a03cbd13`, hosted run [45593926919](https://github.com/lemind/preflight-demo-compromised/actions/runs/45593926919), 2026-11-25T10:19:49Z |
| Pull request #1 head | `c25da0324c654f0f939eafaecd1d58309ed68014`, hosted run [45594043874](https://github.com/lemind/preflight-demo-compromised/actions/runs/45594043874), 2026-11-25T10:20:30Z |
| Action commit | `98e6c7acf637efbad749eeef65e975e7231ab1f2` |
| Local rerun | 2026-11-25T13:43:52Z, same Action commit (its committed `dist/index.cjs`), same repository commits, no wallet, no token |

## Hosted results (the historical record)

| Run | Verdict | Coverage | Spent (test USDC) |
| --- | --- | --- | --- |
| main, 45593926919 | blocked (step failed) | complete | 0.00 |
| pull request #1, 45594043874 | review | complete | 0.00 |

## Local rerun results

| Commit | Verdict | Coverage | Spent | Same as hosted |
| --- | --- | --- | --- | --- |
| base `0925e31` | blocked | complete | 0.00 | yes |
| head `c25da03` | review | complete | 0.00 | yes |

The pull request comparison needs the `pull_request` event and the GitHub API, so it was not rerun; the comment the
hosted run posted is copied below.

## Re-check comment on pull request #1 (hosted, as posted)

Source: [comment 7159564207](https://github.com/lemind/preflight-demo-compromised/pull/1#issuecomment-7159564207), last updated 2026-11-25T10:20:36Z. Copied exactly, inside a
code block. (Its "1 that affect" grammar was fixed later, in `50830aa`.)

````markdown
<!-- dependency-preflight:. -->
### dependency-preflight re-check: `.`

| | Base | This pull request |
| --- | --- | --- |
| Verdict | 🛑 blocked | **⚠️ review** |
| Coverage | complete | complete |

Findings: 2 resolved · 1 still open · 0 new · 0 not verified.

**Resolved** (2 that affect the verdict)

- 🔑 `@solana/web3.js` `1.95.6` in `.`: **malicious** [MAL-2024-11183](https://osv.dev/vulnerability/MAL-2024-11183), [GHSA-2mhj-xmf4-pr8m](https://osv.dev/vulnerability/GHSA-2mhj-xmf4-pr8m)
- 🔑 `@solana/web3.js` `1.95.6` in `.`: high [GHSA-jcxm-7wvp-g6p5](https://osv.dev/vulnerability/GHSA-jcxm-7wvp-g6p5), [CVE-2024-54134](https://osv.dev/vulnerability/CVE-2024-54134)

**Still open** (1 that affect the verdict)

- 🔑 `@solana/web3.js` `1.95.6` → `1.95.8` in `.`: key package a major release behind

[Full report](https://github.com/lemind/preflight-demo-compromised/actions/runs/45594043874) in the run's summary. This is a dependency re-check: lockfiles and manifests were compared; no code was built, tested or run.
````

## Full report, base `0925e31` (local rerun)

#### dependency-preflight: 🛑 **BLOCKED** · coverage: **complete**

> **Controlled test case: historical incident (December 2024 @solana/web3.js compromise). Not a real project.**

Assessed `.` on 2026-11-25T13:43:54Z. This is an npm dependency assessment (known advisories, malicious versions, outdated key packages), not a security audit: only lockfiles and manifests were read; no source code was read, built, tested or run.

| | |
| --- | --- |
| Lockfiles assessed | `package-lock.json` (npm, 1 member) |
| Locked package versions | 1 |
| With advisories | 1 (1 malicious) |
| Not checked or not assessed | 0 |

##### Why blocked

- 1 locked version known to be malicious: @solana/web3.js@1.95.6

##### Also needs review

- outdated key package: @solana/web3.js@1.95.6 (latest 3.2.1)

##### Malicious versions (1)

| Package | Locked | Where (lockfile · workspace member) | Advisory | Fixed in | Notes |
| --- | --- | --- | --- | --- | --- |
| 🔑 `@solana/web3.js` | `1.95.6` | `package-lock.json` · `.` (direct) | [GHSA-jcxm-7wvp-g6p5](https://osv.dev/vulnerability/GHSA-jcxm-7wvp-g6p5) (also [CVE-2024-54134](https://osv.dev/vulnerability/CVE-2024-54134)): high, published 2024-12-04. Modified package published to npm, containing malware that exfiltrates private key material<br>[MAL-2024-11183](https://osv.dev/vulnerability/MAL-2024-11183) (also [GHSA-2mhj-xmf4-pr8m](https://osv.dev/vulnerability/GHSA-2mhj-xmf4-pr8m)): malicious, published 2024-12-03. Malicious code in @solana/web3.js (npm) | `1.95.8` | version removed from the npm registry |

##### Outdated key packages (1)

| Package | Locked | Latest | Gap | Used at | Where | Changes |
| --- | --- | --- | --- | --- | --- | --- |
| 🔑 `@solana/web3.js` | `1.95.6` | `3.2.1` | major | runtime | `package-lock.json` · `.` (direct) | [release notes](https://www.npmjs.com/package/@solana/web3.js?activeTab=versions) |

##### Upgrade explanations (Telegraph, P2)

No explanation was bought: no wallet configured (TELEGRAPH_EVM_PRIVATE_KEY is not set; pull requests from forks never get it).

Upgrades that would be explained:

| Package | Locked | Latest | Gap | Changes |
| --- | --- | --- | --- | --- |
| 🔑 `@solana/web3.js` | `1.95.6` | `3.2.1` | major | [release notes](https://www.npmjs.com/package/@solana/web3.js?activeTab=versions) |

<details><summary>Verdict rules</summary>

- **blocked**: any locked version known to be malicious (an OSV `MAL-` record), even one no workspace member reaches, or a high or critical advisory in a direct runtime dependency.
- **review**: other advisories in runtime dependencies, a runtime dependency that could not be checked, or an outdated key package (a newer major release, or a newer minor release on 0.x). Advisories in development-only dependencies and in lock entries no workspace member reaches are listed but don't change the verdict.
- **ready (npm dependencies assessed)**: none of the above. It does not mean the application is safe to deploy.
- Coverage is **complete** when every supported npm lockfile was assessed, **partial** when something was not checked or not assessed, and **failed** when nothing could be assessed.
- Key packages: `@solana/*`, `@coral-xyz/anchor`. Advisory data: [OSV](https://osv.dev); advisories without a severity count as moderate.

</details>

## Full report, head `c25da03` (local rerun)

#### dependency-preflight: ⚠️ **REVIEW** · coverage: **complete**

> **Controlled test case: historical incident (December 2024 @solana/web3.js compromise). Not a real project.**

Assessed `.` on 2026-11-25T13:43:55Z. This is an npm dependency assessment (known advisories, malicious versions, outdated key packages), not a security audit: only lockfiles and manifests were read; no source code was read, built, tested or run.

| | |
| --- | --- |
| Lockfiles assessed | `package-lock.json` (npm, 1 member) |
| Locked package versions | 1 |
| With advisories | 0 (0 malicious) |
| Not checked or not assessed | 0 |

##### Why review

- outdated key package: @solana/web3.js@1.95.8 (latest 3.2.1)

##### Outdated key packages (1)

| Package | Locked | Latest | Gap | Used at | Where | Changes |
| --- | --- | --- | --- | --- | --- | --- |
| 🔑 `@solana/web3.js` | `1.95.8` | `3.2.1` | major | runtime | `package-lock.json` · `.` (direct) | [release notes](https://www.npmjs.com/package/@solana/web3.js?activeTab=versions) |

##### Upgrade explanations (Telegraph, P2)

No explanation was bought: no wallet configured (TELEGRAPH_EVM_PRIVATE_KEY is not set; pull requests from forks never get it).

Upgrades that would be explained:

| Package | Locked | Latest | Gap | Changes |
| --- | --- | --- | --- | --- |
| 🔑 `@solana/web3.js` | `1.95.8` | `3.2.1` | major | [release notes](https://www.npmjs.com/package/@solana/web3.js?activeTab=versions) |

<details><summary>Verdict rules</summary>

- **blocked**: any locked version known to be malicious (an OSV `MAL-` record), even one no workspace member reaches, or a high or critical advisory in a direct runtime dependency.
- **review**: other advisories in runtime dependencies, a runtime dependency that could not be checked, or an outdated key package (a newer major release, or a newer minor release on 0.x). Advisories in development-only dependencies and in lock entries no workspace member reaches are listed but don't change the verdict.
- **ready (npm dependencies assessed)**: none of the above. It does not mean the application is safe to deploy.
- Coverage is **complete** when every supported npm lockfile was assessed, **partial** when something was not checked or not assessed, and **failed** when nothing could be assessed.
- Key packages: `@solana/*`, `@coral-xyz/anchor`. Advisory data: [OSV](https://osv.dev); advisories without a severity count as moderate.

</details>
