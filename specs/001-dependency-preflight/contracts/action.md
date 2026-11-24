# Contract: the `dependency-preflight` Action

The Action's public interface: `action.yml` inputs and outputs, environment, exit behaviour and the report.
**[built]** items exist on PR #2; **[P2]**/**[P3]** are planned and not in `action.yml` yet.

## Inputs

| Input | Default | Status | Meaning |
| --- | --- | --- | --- |
| `path` | `.` | built | directory to assess, relative to the workspace; must resolve inside it (symlinks out are refused) |
| `fail-on` | `blocked` | built | lowest verdict that fails the step: `blocked` or `review`. Failed coverage always fails |
| `key-packages` | `@solana/*,@coral-xyz/anchor` | built | comma-separated exact names or `<scope>/*` patterns |
| `case-label` | (none) | built | label shown at the top of the report, e.g. for a historical or controlled case (FR-016) |
| `miner-id` | `7314` | P2 | Telegraph miner asked for explanations |
| `node-url` | `https://devnode.telegraphprotocol.com` | P2 | Telegraph node |
| `max-price-per-call-usdc` | `0.05` | P2 | per-call cap |
| `budget-cap-usdc` | `0.30` | P2 | per-run cap |
| `max-purchases` | `10` | P2 | purchases per run |

## Environment

| Variable | Status | Use |
| --- | --- | --- |
| `GITHUB_WORKSPACE` | built | required; the checkout |
| `GITHUB_REPOSITORY`, `GITHUB_SHA` | built | shown in the report |
| `GITHUB_STEP_SUMMARY` | built | report destination (stdout when absent) |
| `TELEGRAPH_EVM_PRIVATE_KEY` | P2 | optional wallet; absent means free mode (FR-011). Never logged |
| `GITHUB_TOKEN` | P2/P3 | record writes (`contents: write`), PR comment (`pull-requests: write`) |

## Outputs

| Output | Status | Values |
| --- | --- | --- |
| `verdict` | built | `blocked`, `review`, `ready` |
| `coverage` | built | `complete`, `partial`, `failed` |

## Exit behaviour [built]

The step fails (`core.setFailed`) when coverage is `failed`, the verdict is `blocked`, or `fail-on: review` and the
verdict is `review`. The message names the reasons. Unexpected errors fail the step with their message; nothing is
caught and ignored.

## Report [built]

Markdown in the job summary, in this order:

1. Heading: verdict and coverage; the case label when set.
2. What was assessed (path, repository, commit, UTC time) and the positioning line: an npm dependency assessment, not
   a security audit; only lockfiles and manifests were read.
3. Totals: lockfiles assessed (format, members), locked versions, versions with advisories (malicious count), not
   checked.
4. "Why blocked", "Why review" / "Also needs review", "Why coverage is …".
5. Findings by tier: malicious; direct runtime; transitive runtime. Each row: package (🔑 for key packages, alias or
   override), locked version, lockfile and members (direct marked), advisories (ids linked to osv.dev, aliases,
   severity or "malicious", publication date, summary), fixed-in version, notes (removed from the registry).
6. Outdated key packages: locked, latest, gap, runtime/dev, where, link to the versions page.
7. Collapsed: dev-only advisories; advisories in unreachable lock entries; other outdated direct dependencies;
   not checked or not assessed items; the verdict rules.

Tables are capped at 50 rows with a "… N more" line. Text from lockfiles and advisories is escaped for table cells.

**[P2]** adds an explanations section (per package: breaking changes and deprecations with migration, quote and link;
`not_found` or unavailable stated) and a purchases section (miner, price, receipt, signal), plus skipped candidates
with reasons. **[P3]** adds the base/head comparison and posts a condensed comment (see research R12).

## Workflow requirements (for installers)

- Triggers `push`, `pull_request`, `workflow_dispatch`; never `pull_request_target`.
- `actions/checkout` with `persist-credentials: false`; no `npm install` or repository script in the job.
- Permissions: `contents: read` for P1. P2 adds `contents: write` (record); P3 adds `pull-requests: write` (comment).
- P2: a `concurrency` group per repository so runs don't overlap.
- Pull requests from forks get no secrets: free mode, summary only.
