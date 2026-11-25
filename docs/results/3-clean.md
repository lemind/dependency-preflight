# Scenario 3: clean project

| | |
| --- | --- |
| Case | Controlled test case: a project that depends only on `@solana/kit` 8.6.0. Clean at the recorded date; a new advisory or a new major release of a key package changes that. |
| Repository | [lemind/preflight-demo-clean](https://github.com/lemind/preflight-demo-clean) |
| Commit | `1e411ffa8cf14cd23c5d0be4f00a9e486489f85d`, hosted run [45594603907](https://github.com/lemind/preflight-demo-clean/actions/runs/45594603907), 2026-11-25T10:23:58Z |
| Action commit | `98e6c7acf637efbad749eeef65e975e7231ab1f2` |
| Local rerun | 2026-11-25T13:43:52Z, same Action commit (its committed `dist/index.cjs`), same repository commit, no wallet, no token |

## Results

| Source | Verdict | Coverage | Spent (test USDC) |
| --- | --- | --- | --- |
| Hosted run 45594603907 (the historical record) | ready | complete | 0.00 |
| Local rerun | ready | complete | 0.00 |

## Full report (local rerun)

#### dependency-preflight: ✅ **READY** (npm dependencies assessed) · coverage: **complete**

> **Controlled test case: a project on @solana/kit 8.6.0 only. Not a real project.**

Assessed `.` on 2026-11-25T13:43:56Z. This is an npm dependency assessment (known advisories, malicious versions, outdated key packages), not a security audit: only lockfiles and manifests were read; no source code was read, built, tested or run.

| | |
| --- | --- |
| Lockfiles assessed | `package-lock.json` (npm, 1 member) |
| Locked package versions | 47 |
| With advisories | 0 (0 malicious) |
| Not checked or not assessed | 0 |

##### Upgrade explanations (Telegraph, P2)

No explanation was bought: no wallet configured (TELEGRAPH_EVM_PRIVATE_KEY is not set; pull requests from forks never get it).

<details><summary>Verdict rules</summary>

- **blocked**: any locked version known to be malicious (an OSV `MAL-` record), even one no workspace member reaches, or a high or critical advisory in a direct runtime dependency.
- **review**: other advisories in runtime dependencies, a runtime dependency that could not be checked, or an outdated key package (a newer major release, or a newer minor release on 0.x). Advisories in development-only dependencies and in lock entries no workspace member reaches are listed but don't change the verdict.
- **ready (npm dependencies assessed)**: none of the above. It does not mean the application is safe to deploy.
- Coverage is **complete** when every supported npm lockfile was assessed, **partial** when something was not checked or not assessed, and **failed** when nothing could be assessed.
- Key packages: `@solana/*`, `@coral-xyz/anchor`. Advisory data: [OSV](https://osv.dev); advisories without a severity count as moderate.

</details>
