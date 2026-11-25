# Feature Specification: Dependency preflight

**Feature Branch**: `001-dependency-preflight`

**Created**: 2026-11-24

**Status**: Draft

**Input**: User description: "Pre-deploy dependency check for Solana and any npm project, backed by Telegraph intelligence. A GitHub Action (priority) and later optionally a web page where someone pastes a public repo URL. It reads the repository's npm lockfiles including monorepos, checks every locked version against known advisories (compromised and vulnerable versions), finds outdated direct dependencies (Solana packages first), buys a sourced 'what changed from A to B' answer from a Telegraph miner for the upgrades that matter, and writes one report: what needs changing, why, and a verdict ready/review/blocked. After remediation it re-runs and shows pass/fail. Three demo scenarios: compromised dependency (historical, controlled test repo, clearly labelled), breaking upgrade, clean assessment. Rust crates out of scope. Testnet only, spending caps, no scanned-repo code ever runs with secrets."

Background: [docs/research-2026-11-24.md](../../docs/research-2026-11-24.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Pre-deploy dependency verdict in CI (Priority: P1)

A developer on a Solana (or any npm) project adds the check to their repository's CI. On every push or pull request, and on demand, it reads every npm lockfile in the repository, including each workspace member of a monorepo and nested packages, and checks every locked package version against public advisory data. It produces one report with a verdict for the **npm dependency scope** it assessed, plus a separate coverage status:

- **blocked**: a locked version is known to be compromised (malicious), or a direct runtime dependency has a high or critical advisory;
- **review**: other advisories in runtime dependencies, a runtime dependency that could not be checked, or an outdated key package (a newer major release, or a newer minor for a 0.x version);
- **ready (npm dependencies assessed)**: none of the above. It never means the whole application is safe to deploy.

Coverage is **complete** (every supported npm lockfile assessed), **partial** (something was not checked or not assessed, e.g. a lookup timed out, an unsupported lockfile, Rust files present) or **failed** (no assessment possible). The report always shows both, so "ready, partial coverage" is visible as such. A runtime dependency that could not be checked makes the verdict at least **review**; an unsupported lockfile or Rust files only make coverage **partial**.

Each finding says which package and version, where it is locked, what the advisory is, and the nearest version that fixes it.

**Why this priority**: It is the core promise ("are my npm dependencies safe to ship?"), it works without paying anything, and it catches the most expensive failure, a compromised dependency in an app that handles funds.

**Independent Test**: Run the check on a controlled test repository that locks `@solana/web3.js` 1.95.6. The report must say **blocked**, name the malware advisory, label the case as historical, and name a safe version.

**Acceptance Scenarios**:

1. **Given** a repository whose lockfile contains `@solana/web3.js` 1.95.6 or 1.95.7 (versions removed from npm after the December 2024 compromise), **When** the check runs, **Then** the verdict is **blocked**, the finding cites the malware advisory (related advisory records grouped as one issue), notes that the version was removed from the registry, and names 1.95.8 as the fixed version.
1a. **Given** a lockfile with `@solana/web3.js` 1.95.8, **When** the check runs, **Then** there is no finding for that malware advisory.
2. **Given** a pnpm workspace monorepo (such as `anza-xyz/wallet-adapter`), **When** the check runs, **Then** every workspace member's dependencies are assessed and each finding names the member it belongs to.
3. **Given** a repository whose npm package lives in a subdirectory (such as `drift-labs/protocol-v2` `sdk/` or `solana-foundation/anchor` `ts/`), **When** the check runs, **Then** those lockfiles are found and assessed, non-npm dependency files (Rust) are listed as not assessed, and coverage is **partial**.
4. **Given** a repository with no advisories in runtime dependencies and no outdated key packages, **When** the check runs, **Then** the verdict is **ready (npm dependencies assessed)**, and the report still lists what was checked, the coverage status and when.
5. **Given** a verdict of **blocked**, **When** the check runs in CI, **Then** the CI step fails so a deploy can be gated on it. **review** and **ready** do not fail the step unless the maintainer configures it.

---

### User Story 2 - Sourced migration guidance for breaking upgrades (Priority: P2)

For outdated direct dependencies that matter (Solana packages first, then other runtime dependencies), the check buys a sourced answer from a Telegraph miner: what changed between the locked version and the target version. The report then shows, per package, the breaking changes and deprecations, each with its migration step, a verbatim quote and a link to the release material. Each purchase lists its price and receipt.

**Why this priority**: It turns "you are outdated" into "here is exactly what to change and why", the part Telegraph intelligence adds. It is what the Solana use case asks for.

**Independent Test**: Run the check with a funded testnet wallet on `drift-labs/protocol-v2` `sdk/`, which locks `@coral-xyz/anchor` 0.29.0. The report must list the documented breaking changes for the upgrade, each with a quote and a source, plus the purchase receipt.

**Acceptance Scenarios**:

1. **Given** a locked `@coral-xyz/anchor` 0.29.0 and a newer release, **When** the check runs with a wallet configured, **Then** the report lists the breaking changes between the two versions with quotes and links. TypeScript-client changes come before changes that only affect Rust code, and the report shows the price paid and the receipt.
2. **Given** no wallet configured, **When** the check runs, **Then** no purchase is attempted. The report says which upgrades would have been explained and links each package's release notes.
3. **Given** the same package and version pair was already answered in an earlier run, **When** the check runs again, **Then** the saved answer is reused and nothing is bought twice.
4. **Given** the per-run spending cap would be exceeded, **When** further upgrades remain, **Then** the check stops buying, completes the report, and lists the upgrades left unexplained and why.
5. **Given** the miner answers that no release material was found, or a source was unavailable, **When** the report is written, **Then** that is stated for the package, never presented as "no breaking changes".

---

### User Story 3 - Re-check after remediation (Priority: P3)

After a developer applies the fixes (upgrades a compromised or vulnerable package, migrates a breaking upgrade) on a branch, the check runs on that branch's pull request and shows a before and after comparison against the base branch. It lists the findings resolved, the findings still open and new findings, and the new verdict. This is a **dependency assessment re-check**: it shows the new lockfile no longer contains the identified issue. It does not build, test or run the application, and says so.

**Why this priority**: It closes the loop Telegraph asked for ("whether the application passes the dependency checks after remediation") and makes the CI gate useful day to day.

**Independent Test**: On the controlled compromised-dependency test repository, open a pull request that moves `@solana/web3.js` from 1.95.6 to a safe version. The check on that pull request must show the malware finding as resolved and the verdict moving from **blocked** to **ready** or **review**.

**Acceptance Scenarios**:

1. **Given** a pull request that upgrades the compromised package, **When** the check runs on it, **Then** the report shows the base branch verdict, the pull request verdict and the finding marked resolved.
2. **Given** a pull request that introduces a new vulnerable version, **When** the check runs, **Then** the report marks that finding as new.
3. **Given** a pull request from a branch of the same repository, **When** the check completes, **Then** the report is posted on the pull request as one comment, updated in place on later runs rather than duplicated. For a pull request from a fork, the report appears in the run summary only.

---

### User Story 4 - Paste a repository URL (Priority: P4, optional)

Someone without CI access pastes a public GitHub repository URL into a web page and gets the free-mode report: verdict, coverage and findings. If the repository already runs the check, the Telegraph-backed explanations recorded on its `preflight` branch are shown too.

**Why this priority**: It makes the check easy to try and demo, but the CI integration is the commercial core. It is built only if P1–P3 are done before the deadline.

**Independent Test**: Paste `https://github.com/anza-xyz/wallet-adapter` and receive a report matching a free-mode CI report for the same commit.

**Acceptance Scenarios**:

1. **Given** a public repository URL, **When** it is submitted, **Then** a report for its default branch's latest commit is shown, naming that commit.
2. **Given** a private, missing or non-npm repository, **When** it is submitted, **Then** a clear message explains why it cannot be assessed.
3. **Given** the web page, **When** a report is generated, **Then** nothing is bought on the visitor's behalf; paid explanations appear only if they are recorded on that repository's `preflight` branch.

---

### Edge Cases

- A locked version has been removed from the registry (as with the compromised `@solana/web3.js` versions): it is reported, never treated as an error that stops the run.
- A package's registry record is very large (`@solana/web3.js` is about 12 MB) and slow: the check still completes; a lookup that times out is reported as "not checked", never as clean.
- The advisory database or the registry is unavailable: affected packages are marked "not checked"; an unchecked runtime dependency makes the verdict at least **review**, and coverage **partial** (or **failed** if nothing could be checked).
- Hundreds of advisories in transitive development tools: they are grouped and summarised, and never outweigh findings in direct runtime dependencies.
- A package's version numbers on npm don't match its repository's release tags (for example `@solana/spl-token`): the explanation is reported as not found, with a link to the registry page.
- The repository has no npm lockfile, or only a manifest without a lockfile: the report says what was missing, and that versions could not be pinned.
- Lockfile formats not supported: the file is named in the report as not assessed.
- Monorepo members that pin different versions of the same package: each pinned version is assessed and attributed to its member.
- The miner returns an answer that fails validation (malformed, or quotes that don't match its sources): it is treated as unusable and not shown as guidance.
- A pull request from a fork: the check runs without any wallet or secret, so it stays in the free mode.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The check MUST find every npm lockfile in the repository, including nested packages and every member of a workspace, and assess the supported formats: npm `package-lock.json` v2/v3, pnpm v6/v9 and Yarn 1. Other lockfiles (Yarn Berry, Bun) MUST be listed as not assessed in this version. Discovery MUST skip `.git`, `node_modules` and vendored directories, MUST NOT follow symlinks outside the checkout, and MUST cap file sizes.
- **FR-001a**: Direct versus transitive and runtime versus development MUST be decided per workspace member from that member's manifest. npm aliases, Git URLs, `file:` and workspace references MUST be reported as not assessed rather than guessed.
- **FR-002**: The check MUST assess every locked package version against public advisory data, retrieving each advisory's full record (severity, affected ranges, fixed versions). An advisory is **malicious** when its identifier or any alias is a malicious-package record (`MAL-` prefix in OSV); that is classified separately from ordinary vulnerabilities, not inferred from severity. Advisories that are aliases of each other MUST be grouped as one issue.
- **FR-003**: The check MUST distinguish direct from transitive dependencies, and runtime from development-only dependencies, and rank findings in that order.
- **FR-004**: The check MUST produce one verdict per run, **blocked**, **review** or **ready (npm dependencies assessed)**, with the rules stated in the report: **blocked** for any malicious version or a high/critical advisory in a direct runtime dependency; **review** for other runtime advisories, an unchecked runtime dependency, or an outdated key package (a newer major release, or a newer minor release for a 0.x version), whether or not it was explained; **ready** otherwise. An explanation never lowers the verdict: it tells the developer what to change.
- **FR-004a**: The check MUST report a coverage status, **complete**, **partial** or **failed**, separate from the verdict. Any lookup that did not complete, unsupported lockfile or non-npm dependency file makes coverage **partial**; a parser failure or advisory-source outage on all lockfiles makes it **failed**, which MUST NOT be shown as an empty finding list.
- **FR-005**: For each finding, the report MUST state the package, the locked version, where it is locked (file and workspace member), the advisory identifiers, and the nearest version that resolves it when one exists.
- **FR-006**: The check MUST treat `@solana/*` and `@coral-xyz/anchor` packages as key packages and list them first. The list of key packages MUST be configurable.
- **FR-007**: For outdated key packages and direct runtime dependencies with a newer major or minor release, the check MUST be able to buy one sourced "what changed from A to B" answer per package and version pair from a Telegraph miner. Miner 7314 is the default; the miner MUST be configurable.
- **FR-008**: Every shown breaking change or deprecation MUST carry its migration step when documented, a verbatim quote and a source link, as returned by the miner. Answers that fail validation MUST NOT be shown as guidance.
- **FR-009**: Every purchase MUST be listed in the report with the miner, price, receipt and signal reference, and kept in a record in the repository keyed by package, exact from-version and exact to-version, so it is not bought twice.
- **FR-009a**: Before paying, the check MUST record the attempt as **pending**; after delivery, **delivered** with the receipt; on an ambiguous outcome (timeout, lost response), **unknown**. A key with a pending or unknown attempt MUST NOT be bought again until it is reconciled. Runs on the same repository MUST NOT overlap.
- **FR-010**: The check MUST enforce a per-call price cap, a per-run spending cap and a maximum number of purchases per run (defaults 0.05 test USDC, 0.30 test USDC and 10), and MUST stop buying, not fail, when a cap is reached. Candidates are ranked deterministically: key packages first, then direct runtime dependencies, larger version jumps first, then name. Charged replies that turn out unusable count against the caps. Skipped candidates are listed with the reason.
- **FR-011**: Without a configured wallet, the check MUST run in a free mode (advisories, outdated versions and release-note links) and attempt no purchase.
- **FR-012**: The check MUST fail its CI step when the verdict is **blocked** or the coverage is **failed**, and MAY be configured to fail on **review**.
- **FR-013**: On a pull request, the check MUST compare against the base branch and mark each finding as resolved, still open or new, identifying a finding by workspace member, package and advisory (dependency paths are context only), and post a single comment that later runs update in place.
- **FR-013a**: Permissions MUST be the minimum per operation: reading the repository needs read access only; writing the purchase record needs write access to repository contents; the comment needs write access to pull requests. Pull requests from forks run with read-only access and no secrets: free mode, results in the run summary only, no record writes and no comment.
- **FR-014**: The check MUST never install, build or execute code from the scanned repository, and the step that holds the wallet key MUST NOT run any scanned-repository code.
- **FR-015**: Non-npm dependency files (such as `Cargo.lock`) MUST be listed in the report as not assessed.
- **FR-016**: Any finding based on a historical or controlled test case MUST be labelled as such in the report and the demo, separate from current findings.
- **FR-017**: A lookup that could not complete (timeout, unavailable source) MUST be reported as "not checked". An unchecked runtime dependency MUST make the verdict at least **review**; an unchecked development-only dependency makes coverage **partial**.
- **FR-018** *(P4, optional)*: A web page MUST accept a public GitHub repository URL and show the free-mode report for its default branch without buying on the visitor's behalf. When the repository has a `preflight` branch, the explanations already recorded there are shown too.

### Key Entities

- **Repository snapshot**: the repository and the commit assessed, with the list of lockfiles found and files not assessed.
- **Locked dependency**: package, version, lockfile, workspace member, direct or transitive, runtime or development.
- **Finding**: a locked dependency with an advisory (identifiers, severity, malicious or not, fixed-in version) or a pending upgrade (current and target version), plus status (new, open, resolved) when compared.
- **Upgrade explanation**: a purchased answer for one package and version pair: changes (kind, version, description, migration, quote, source), coverage and outcome.
- **Purchase**: miner, price, receipt, signal, time, and the explanation it bought.
- **Report**: verdict, the rules applied, findings in ranked order, explanations, purchases, items not checked, and the commit assessed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On the three target repositories (`anza-xyz/wallet-adapter`, `solana-foundation/anchor` `ts/`, `drift-labs/protocol-v2` `sdk/`), a report is produced in under 5 minutes per repository, in free mode, with every supported npm lockfile assessed (coverage **partial** where Rust files are present, never **failed**).
- **SC-002**: 100% of locked versions that the advisory data marks as malicious are reported as **blocked** in controlled tests, including versions removed from the registry (`@solana/web3.js` 1.95.6 and 1.95.7 blocked; 1.95.8 without that finding).
- **SC-003**: Every breaking change shown in a report has a quote and a source link; 0 explanations are shown that failed validation.
- **SC-004**: A full paid run on any target repository stays within the default spending cap (0.30 test USDC), and a second run on the same commit buys nothing.
- **SC-005**: The three demo scenarios (compromised, breaking upgrade, clean) are each reproduced end to end from the README by someone outside the team, with the historical case clearly labelled.
- **SC-006**: In the remediation demo, the dependency verdict moves from **blocked** to **review** or **ready** on the fixing pull request, and the comparison shows the finding as resolved; the comment states that no build or test was run.
- **SC-007**: No secret is ever available to a step that reads or processes scanned-repository content beyond its lockfiles and manifests, verified by review of the workflow.

## Assumptions

- Users are developers or teams with a public GitHub repository using npm, pnpm or Yarn 1. Yarn Berry and Bun lockfiles are listed as not assessed. Private repositories are out of scope for this version.
- Public advisory data (OSV, which includes GitHub advisories and malicious-package reports) is the source of truth for vulnerable and compromised versions; the check makes no security judgement of its own.
- Telegraph runs on testnet (Ethereum Sepolia test USDC). The paid explanations cost about 0.02 test USDC each, paid from a pre-funded escrow balance of the installer's dedicated wallet.
- The default miner is 7314 (Package Release Intelligence), run by the same team. Purchases from it are related-party and are disclosed as such.
- "Outdated" means a newer stable major or minor release exists. Patch-level gaps are listed but not explained with paid answers. The target of an explanation is the latest stable release at run time, recorded in the report; demos pin the repository commit and record the resolved target.
- Positioning: a pre-deploy **npm dependency assessment** (known advisories, malicious versions, version-to-version migration risk, with evidence and a re-check). It is not a security audit or a deployment guarantee: it doesn't inspect source code, run tests or assess Rust dependencies.
- Paid runs from the team's wallet to the team's miner are related-party tests: they prove the purchase path, not customer demand.
- Rust (`Cargo.lock`) and other ecosystems are out of scope for this version and listed as not assessed.
- Severity comes from the advisory data. Advisories without a severity are treated as moderate.
- The deadline is 1 Dec 2026, so the web page (P4) is built only if P1–P3 are working end to end before then.
