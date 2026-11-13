---
name: commit
description: Use whenever the user asks to commit, push, ship or update a PR. Splits the changes into one commit per theme (and a fixup! of the branch commit that introduced the lines being fixed), scans the stage for private data, validates each commit with check:commit, pushes per theme and keeps the PR body in sync, with approval for every git operation.
argument-hint: "[stage | autonomous] [theme or scope, optional] [resume from step <n>]"
---

Organizes the changes into commits per theme, validates each commit, pushes per theme and keeps the PR body up to date. Run it after `/pre-commit`, which leaves the change verified. No git operation that changes state runs without approval.

If `.claude/rules/git.md` exists in this clone, read it first. This skill is complete without it.

Commit, push and PR always go through this skill: the hook `.claude/hooks/require-command.mjs` blocks `git commit`, `git push`, `npm run commit`, `npm run fixup:fuse` and `gh pr create` unless the `commit` skill was invoked in the turn, and reminds you to call it when the request mentions committing or pushing.

Every new user message ends the skill in the hook: a prose approval, the "I committed" of stage mode, an adjustment asked mid-plan. Before the next `git commit`, `git push` or `gh pr create`, call the `commit` skill again with "resume from step <n>", the mode, the autonomous scope and the approved plan as the argument, and continue from there without redoing the survey.

## Rules that always apply

- **Authorization.** A git operation that changes state (commit, push, branch, PR, merge, reset, rebase, `branch -d/-f`) runs only when the user asks for it, and the request covers only that operation. Fixing a mistake (moving a commit, deleting a branch) needs approval too. Editing files, installing dependencies and running checks need no approval.
- **Never `--no-verify`**, and never skip or weaken a hook. A red hook means fix the cause and repeat.
- **Never a `Co-Authored-By` trailer** or any AI attribution in a commit message or PR body.
- **Questions** go through `AskUserQuestion`, recommendation first with `(Recommended)` in the label, `multiSelect` when the choices do not exclude each other, independent questions in the same call (up to 4). A draft, such as the commit message, is approved through `AskUserQuestion` too, its text in the `preview`. The argument pre-answers: what it already answered is not asked again, only confirmed in one line. A pre-answer never replaces an approval that is required case by case (every git operation outside the approved plan).
- **Only finished work becomes a commit**: nothing with a red test or half a change.

## Argument

`$ARGUMENTS` may carry the mode and the theme, in any order and free language:

- stage mode: `stage`, "build the stage", "I'll commit", "just prepare";
- autonomous mode: `autonomous`, "you commit", "commit and push";
- the autonomous scope, when stated: "commit and push" (commits and push), `autonomous all` (the four operations of section 2); the mode without a scope falls to the scope question;
- `resume from step <n>` with the mode, scope and approved plan: continue from step `<n>` without surveying or asking again what the plan already decided;
- the rest is the theme or scope that restricts the plan (e.g. `/commit stage hooks`).

An ambiguous argument, or one without a mode, falls to the question in section 2.

## 1. State

Survey without changing anything:

- current branch and upstream: `git rev-parse --abbrev-ref @{upstream}` and `git rev-list --count @{upstream}..HEAD`. **No upstream, or no `origin` remote:** state it in one line. The reference range for what a push would carry is `origin/main..HEAD` when `origin/main` exists; with no remote at all there is no push, no PR and no `fixup:fuse` base, so sections 4 and 5 are skipped and section 6 uses the local fallback;
- branch commits not yet on main (`git log --oneline origin/main..HEAD`; without `origin/main`, use the local base branch or the whole history) — these are the `fixup!` candidates;
- open PR for the branch (`gh pr view --json number,url,body`), only when a remote exists;
- working tree: `git status --short` and `git diff`, including untracked files.

The issue of the branch comes from its name: `0042-short-title` is issue #42 (`npm run branch -- check <name>` checks the pattern). A branch outside the pattern (other than `main`, `revert/*`, `dependabot/*`) is refused by the hooks: propose `npm run branch -- <issue number>` (or `npm run branch -- "<title>"` to open an issue and the branch together) instead of committing there.

If `/pre-commit` did not run on these changes, offer to run it first. Weigh what is already ahead of the remote (`git diff --stat @{upstream}..HEAD`: changed sources, test support files, dependencies or config all force the mutation run over everything) and, if it is already heavy, recommend pushing before committing more. About 10 commits is a reference, not a limit.

## 2. Commit plan

Split the changes into themes: one theme per commit, staged by hunk, neighbours of the same subject together, a pure rename in its own commit. Put in the same commit what belongs together:

- `package.json` with `package-lock.json`;
- the coverage ratchet with the spec that paid the debt;
- `mutation-baseline.json` with the spec or code that changed it;
- a decision file in `docs/decisions/` with the change it records;
- updated docs with the change they describe.

A hunk that is not part of the branch's work (another PR, an experiment, a local tweak) goes in no theme: leave it out of the stage and list it below the table, with file and hunk, for the user to decide.

**Fixups.** For each hunk that changes or removes lines, run `git blame` on the original lines. If the commit that introduced them is in `origin/main..HEAD`, the hunk fixes a commit of the own branch and becomes a `fixup!` of it (`git commit --fixup=<sha>`), not a new commit. A fix that crosses several commits is split, each hunk into the `fixup!` of the commit that introduced it.

**Issues.** For each theme, look for open issues it may resolve or advance on the current repo: `gh repo view --json nameWithOwner` to confirm the repo, then `gh issue list --state open --search "<strong term from the diff> in:title,body"` (error code, file name, script, command, function or message; never a generic term that returns the whole list), plus `--label bug` when the theme is a fix. Read each candidate and compare with the diff: only one that the theme fully resolves (`Closes`) or partly advances (`Refs`) enters the plan. A shared term is not enough. An uncertain candidate goes through `AskUserQuestion` with the issue excerpt and the diff excerpt side by side; no issue is closed by the plan without that confirmation. With none, the Issue column says "no related open issue". Without a remote, skip the search and say so.

**Docs.** For each theme, check the versioned docs against the change: search `docs/`, the READMEs and `.claude/` for anything that mentions the file, script, command, variable or behavior that changed. A doc that must change is updated and goes in the commit of the theme; a new technical decision goes through `/decision`.

Show the plan as a table, in the order the commits will land (dependencies first):

| #   | Theme | Files and hunks | Issue | Docs | Kind | Message |
| --- | ----- | --------------- | ----- | ---- | ---- | ------- |

- **Issue:** the default is the branch issue, with no line in the message. A commit that resolves another issue carries in the body a line `Closes #<number>` (one per issue, always with the keyword; `Closes #44, #45` only closes 44); one that only advances an issue carries `Refs #<number>`, which does not close. **A closing word (close, fix, resolve and variants) followed by `#N` goes only on its own line**: in the middle of the text or in the title ("fix #12 in login") GitHub closes the issue just the same, so the `commit-msg` hook refuses the commit. To mention without closing, `Refs #N`.
- **Kind:** new commit or `fixup!` of `<short sha> <title>`.
- **Message of a new commit:** `<emoji> <type>(<scope>): <subject>` as defined in `cz.config.mjs` (read it for the type list, the emoji of each type and the suggested scopes; `🔧 chore`, `✨ feat`, `🐛 fix`, `📝 docs`, `✅ test`...), up to 100 characters counted by code point, emoji included, scope optional and without spaces, plus a body in English with the why. Give 2 more subject alternatives for the main commit. A `fixup!` has no message of its own.

Then, if the argument did not bring the mode, ask with `AskUserQuestion`, always these two in this order, in the same call as the plan approval:

1. **Build the stage for me to commit (Recommended):** Claude builds the stage of one theme at a time with the message ready and stops; the user reviews `git diff --cached` and commits. Push and PR body stay with the user, with the commands ready.
2. **Autonomous:** Claude runs on its own what the user picks in the next question, and asks about the rest on the spot.

If autonomous, ask in the next call, with `multiSelect`, what it does without asking again:

1. **Commits (Recommended):** commits and validates each theme of the plan;
2. **Push per theme (Recommended):** pushes each theme that closed green;
3. **PR body (Recommended):** writes the body with `gh pr edit`;
4. **Create the PR:** opens it with `gh pr create` when it does not exist yet.

Anything left unchecked is asked on the spot. Fixing a red commit or push, and fusing `fixup!` commits, always ask. The mode and scope, answered or given in the argument, hold only for the commits and pushes of this plan.

## 3. Commits

One theme at a time, in plan order:

1. **Stage the theme.** A whole file: `git add <file>`. A file with hunks of different themes: save the patch of the theme's hunks in the scratchpad (`git diff <file>` cut to those hunks) and apply with `git apply --cached --recount`. Confirm with `git diff --cached` that only the theme entered, and review each staged file for debugging leftovers, dead code and puppet tests.
2. **Scan the stage for private data**, on every commit, and show the result with the plan: run `npm run --silent check:private` (the same scan the `pre-commit` hook runs: machine paths, personal e-mails, tokens and keys, terms from the local list in `.git/info/private-data`, and the commit author identity). Also look by eye for real user data, other projects or accounts, and a lock `resolved` outside the public registry. A fictitious test value or a doc example appears in the report but does not block; a real finding blocks the commit until it leaves the stage.
3. **Commit.**
   - **Stage mode:** show `git diff --cached --stat` and the approved message, saved in a scratchpad file, with the command ready (`git commit -F <file>`, `npm run commit` or `git commit --fixup=<sha>`), and stop until the user says they committed.
   - **Autonomous mode:** a new commit with `git commit -F <message file>`; a `fixup!` with `git commit --fixup=<sha>`. A commit outside the chosen scope asks before each one.

   The `commit-msg` hook checks the format and `pre-commit` runs the private-data scan and lint-staged. Red hook: fix the cause and repeat, never `--no-verify`.

4. **Validate the commit**, in both modes: `npm run --silent check:commit -- <sha>` (no argument validates `HEAD`), the pre-push without the mutation run, on the commit itself in a temporary worktree. A commit that changes `package.json` or the lock needs `npm ci` first, because the worktree reuses the current `node_modules`. Run it **in the background**, like `git commit` and `git push` themselves (output to the terminal and a log at once with `tee`, exit code from `PIPESTATUS`): carry on without waiting, and only the push of that commit waits for the verdict. While `git commit` runs, do not edit versioned files or build the next stage (lint-staged touches the working tree); `check:commit` and push run in a worktree and free everything. Red: propose the fix, `--amend` if it is the last commit and not yet pushed, or a `fixup!` of the red commit; in autonomous mode each one with approval.

## 4. Push per theme

Skipped when there is no `origin` remote: say "no remote, push skipped" and continue.

With the theme closed and green, push. The pre-push validates the whole range with the mutation run, so it runs in the background. One theme per push, to keep the gate short and the failure close to its cause.

The first push of a branch without upstream, or with an upstream of another name, is `git push -u origin HEAD`; the following ones, `git push`.

- **Autonomous mode:** `git push` as soon as the theme closes, without accumulating commits (a push outside the chosen scope asks first); a theme that alone touches many sources goes in more than one push. Red push: show only the failures and propose the fix through step 3, without pushing the next theme.
- **Stage mode:** recommend the push with the command ready when the theme closes, and insist when what is ahead of the remote gets heavy.

After the push, show the PR check (`gh pr checks <n>`): every push reruns the PR checks and cancels the previous run.

## 5. PR body

Skipped when there is no remote. A new commit changes what the PR delivers; a `fixup!` does not. With a new commit in the round, write the PR body: a short summary of what the branch delivers (derived from `main...HEAD`), then one line `Closes #<number>` per issue the PR resolves (the branch issue and those the commits close), each **on its own line**. Compare it with the current body (`gh pr view <n> --json body`) and show the difference.

`<body> | gh pr edit <n> --body-file -`; with no PR open, after the first push, `gh pr create --base main --assignee @me --title "<issue number padded to 4 digits>: <issue title>" --body-file -` (the title pattern is `0042: title`, which the repo checks and which ties the PR to the issue). In autonomous mode, `gh pr edit` and `gh pr create` run without a new question only when they are in the chosen scope; outside it they ask on the spot. In stage mode, hand the command to the user. Check afterwards with `gh pr view <n> --json body` that the saved body has the `Closes` lines.

## 6. Before the merge

When the PR is ready to merge and the branch has `fixup!` commits, propose fusing them (each operation with approval):

1. `npm run fixup:fuse`, which runs `git rebase -i --autosquash --keep-base` onto `origin/main` with no editor, then one `check:commit` on the fused `HEAD`. Every commit already passed `check:commit` when it was created, so the fusion does not validate each step again: the final state is checked by that run, by the pre-push of the `--force-with-lease` and by the PR gate. A conflict stops the rebase in the user's repository without running the check: resolve, `git add`, `git rebase --continue` and `npm run check:commit`. A red `HEAD` fails with the fusion already done, and the fix goes through section 3 as a new commit or `fixup!`;
2. `git push --force-with-lease`.

**No `origin/main` (no remote yet):** `fixup:fuse` has no base, so do it by hand with approval: find the oldest `fixup!` target (`git log --oneline` and the `fixup!` subjects), then `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <parent of the oldest target>` (use `--root` if the target is the first commit), then `npm run --silent check:commit` once, on the fused `HEAD`. No push afterwards.

Remind the user that the last PR run must be green and later than the last advance of `main`.
