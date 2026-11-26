# Scenario results (T041)

Evidence for the three demo scenarios, all run on GitHub-hosted runners on 25 Nov 2026. All three are test cases we
set up, not findings in anyone's live project.

GitHub has no API for downloading a run's job summary, where the Action writes its full report. So each file keeps
the hosted run's verdict, coverage and spend as the historical record, and adds what can be reproduced or was stored:

| Scenario | Hosted result | Full report in this file | File |
| --- | --- | --- | --- |
| 1. Compromised dependency, then the fix (controlled) | main blocked; pull request #1 review | local rerun of the exact commits; the hosted pull request comment as posted | [1-compromised.md](1-compromised.md) |
| 2. Breaking upgrades, paid explanations (related-party, testnet) | blocked, partial; 0.06 test USDC, rerun 0.00 | the purchase record: receipts and the stored answers | [2-paid-upgrades.md](2-paid-upgrades.md) |
| 3. Clean project (controlled) | ready, complete | local rerun of the exact commit | [3-clean.md](3-clean.md) |

Local reruns (2026-11-25T13:43:52Z) used the Action's committed `dist/index.cjs` at the commit the hosted run pinned, the exact
repository commits, and no wallet or token. Each matched its hosted verdict and coverage. Advisory and registry data
can change, so a later rerun may differ; the hosted result stays the record.
