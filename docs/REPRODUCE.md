# Outside reproduction (T042)

For someone outside the team, a person or a browser agent, with a GitHub account and no context on this project.

## Goal

Install and run the GitHub Action "dependency-preflight" by following **only** its README, then report exactly what
happened. You are testing the README, not the code. Don't ask the authors for help during the test. If something is
unclear, write down what you tried and what you guessed.

README to follow:
<https://github.com/lemind/dependency-preflight/blob/002-p1-verdict-in-ci/README.md>
(The work is on branch `002-p1-verdict-in-ci`, not yet merged to `main`.) Use only the README's **Free check** install.
That README pins the Action at commit `98e6c7a`; that is the version under test.

## Rules

- Free mode only. Do **not** add a wallet, a private key or any secret, and don't follow the "Paid explanations" steps.
- Don't install, build or run the test project's code. Don't add `npm install` or other scripts to the workflow.
- Use a new public repository under your own account. Delete it afterwards if you like.

## Steps

1. Create a new public repository, e.g. `preflight-repro`.
2. Add a small npm project with a lockfile. Either:
   - **With Node.js on your machine:** a `package.json` with 2–5 real dependencies of your choice, at least one of
     them an `@solana/*` package (e.g. `"@solana/web3.js": "1.98.0"`). Then run
     `npm install --package-lock-only --ignore-scripts` and commit `package.json` and `package-lock.json`; or
   - **Browser only:** copy `package.json` and `package-lock.json` from
     <https://github.com/lemind/preflight-demo-clean> into your repository with the GitHub web editor. Say in your
     report that you did this.
3. Add the workflow file exactly as the README's "Free check" section shows. Commit it to the default branch.
4. Open the **Actions** tab and wait for the run. Open the run's summary page.
5. On a new branch, add a dependency with a known high-severity advisory, `nanoid` 3.3.4, then open a pull request.
   Your repository contains no code, so this is harmless.
   - **With Node.js:** `npm install --package-lock-only --ignore-scripts nanoid@3.3.4`, then commit both files.
   - **Browser only:** edit both files in the GitHub web editor:
     - in `package.json`, add `"nanoid": "3.3.4"` under `"dependencies"`;
     - in `package-lock.json`, add the same line under `"dependencies"` of the `""` entry (inside `"packages"`), and
       add this entry inside `"packages"`:
       ```json
       "node_modules/nanoid": {
         "version": "3.3.4",
         "resolved": "https://registry.npmjs.org/nanoid/-/nanoid-3.3.4.tgz"
       },
       ```
   Expected: the pull request's run is **blocked** (a high-severity advisory in a direct runtime dependency), and a
   comment from `github-actions` lists `nanoid` as **new**. Wait for the run, then check the pull request.

## Report back

- Your repository URL, plus the run URLs for the main-branch run and the pull request run.
- For each run: the verdict (blocked / review / ready), the coverage (complete / partial / failed), and whether the
  step passed or failed. Copy the first ~15 lines of the run summary.
- The pull request comment, copied in full. If there was none, say so.
- For each step: how long it took. Note anything in the README that was unclear, wrong, missing or out of order:
  quote the README line and say what actually happened.
- Any error message, copied exactly.
- One sentence: could you tell from the report what to do next?

**Done when:** both runs have finished and the report above is complete, or you are stuck and have written down
exactly where and why.
