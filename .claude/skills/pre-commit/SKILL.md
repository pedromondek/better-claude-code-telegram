---
name: pre-commit
description: Use before committing, when the user asks to check, verify or review the changes. Runs the lint, type-check, hook tests, unit tests with coverage of the changed lines and the private-data scan on what changed, offers to record a decision, then hands over to the commit skill. It only verifies; it never commits.
argument-hint: "[decision | no decision] [mutation | no mutation] [stage | autonomous]"
---

Verifies the current changes with the same checks the hooks will run, so a red result shows up here and not at the commit or the push. It changes no git state: committing is the job of the `commit` skill, which this skill calls at the end.

If `.claude/rules/git.md` exists in this clone, read it first. This skill is complete without it.

## Argument

Questions go through `AskUserQuestion`, recommendation first with `(Recommended)` in the label, `multiSelect` when the choices do not exclude each other. `$ARGUMENTS` may pre-answer them, in keywords or free language; what it answered is not asked again, only confirmed in one line:

- `decision` / `no decision`: whether to record a technical decision with `/decision`;
- `mutation` / `no mutation`: whether to run the mutation check on the changed sources;
- `stage` or `autonomous` ("you commit"), with the autonomous scope when it comes ("commit and push", `autonomous all`): passed on to the `commit` skill.

E.g.: `/pre-commit no decision no mutation autonomous`.

## 1. What changed

Look at `git status --short` and `git diff` (including untracked files) and classify what was touched:

- **plugin and extension code** (`plugins/**`, `*.ts`, `*.mjs`, `*.js`, `*.sh`);
- **tooling** (`.husky`, `scripts`, `.github`, `.claude`, `lint-staged.config.mjs`, `cz.config.mjs`);
- **dependencies** (`package.json`, `package-lock.json`);
- **docs** (`docs/**`, READMEs) and **decisions** (`docs/decisions/**`).

If only docs changed, skip to step 4.

## 2. Checks

Run independent checks in parallel when possible. A heavy step (coverage, mutation) runs alone, never in parallel with another heavy one. Fix every failure before the next step.

1. **Lint and types:** `npm run lint` (oxlint, ESLint and `tsc`, zero warnings). Use `npm run lint:fix` for what is auto-fixable, then run it again.
2. **Format:** `npm run --silent format:check`. Fix with `npm run --silent format:file -- <files>`.
3. **Typos:** `npm run --silent lint:typos`.
4. **Secrets:** `npm run --silent lint:secrets`.
5. **Lock:** when `package.json` or `package-lock.json` changed, `npm run --silent lint:lockfile`. The two files go in the same commit.
6. **Workflows:** when `.github/workflows/` changed, `npm run --silent lint:workflows`.
7. **Hook and script tests:** when tooling changed (`.husky`, `scripts`, `.claude/hooks`), `npm run test:hooks`, which lint-staged would only run at commit time.
8. **IDE diagnostics:** if the `mcp__ide__getDiagnostics` tool is available, call it on every changed source file (all in one message, in parallel) and fix errors; unrelated pre-existing warnings are noted but do not block.
9. **Unit tests with coverage:** `npm run test:cov`.
10. **Changed lines covered:** `COVERAGE_RANGE="$(git merge-base origin/main HEAD)" npm run test:cov:changed`, which measures the whole branch plus what is not committed yet, like the push gate. A new untracked file is outside the diff: add it with `git add -N <file>` first. Without `origin/main` (no remote yet), use the first commit or `HEAD~<n>` as the base and say so.
11. **End-to-end:** when the plugin's runtime behavior changed, `npm run test:e2e`.
12. **Mutation:** the pre-push hook runs it on the pushed range and holds the survivors to `mutation-baseline.json`. Running it here (`npm run test:mutation:changed`) finds survivors before the push; heavy and optional, ask unless the argument answered. If a mutant survives, kill it with a test; do not add a `Stryker disable` without researching why. The baseline file goes in the same commit as the spec or code that changed it.

The pre-push hook runs lint and types, secrets, typos, lockfile, unit tests with coverage of the changed lines and the mutation run; `npm run check:commit` runs the same without the mutation.

## 3. Private data

Run `npm run --silent check:private`: it scans the staged diff for machine paths, personal e-mails, tokens and keys, terms from the local list (`.git/info/private-data`, never versioned) and the commit author identity. It reads only the stage, so it is clean when nothing is staged yet: also look at the unstaged diff by eye for the same kinds of data, and fix it before the commit skill stages anything. The scan repeats in the `pre-commit` hook and in `/commit`.

## 4. Decision (optional)

Ask with `AskUserQuestion` whether to record a technical decision of this change with `/decision`: a choice that had a real alternative and closed a door (topology, contract, data format, limit, policy, what was deliberately discarded). It is optional, and skipped when the argument said so or when the change has no such choice. The file goes in `docs/decisions/` and enters the same commit as the change it records, which is why this step comes before `/commit`. Wait for `/decision` to finish before moving on.

## 5. Hand over to commit

Finish by invoking the `commit` skill, passing on the mode and the scope if the argument brought them. It splits the changes into themes (and `fixup!` of the branch commit the hunk fixes), proposes the messages and asks between building the stage for the user to commit or the autonomous mode. This skill never runs `git commit`, `git push` or `gh pr create` itself.
