# better-claude-code-telegram

Telegram for Claude Code: a fork of the official Telegram channel plugin extended with `AskUserQuestion` buttons, a notice when Claude waits on you, voice transcription and one bot shared by every Claude Code instance on the machine. Each user runs it with a bot of their own.

**Stack:** TypeScript (strict) for the channel server and its extensions, Node.js scripts (`.mjs`) for setup, hooks and tooling, Bun to run the channel server, Vitest, Stryker, oxlint, ESLint, Prettier, Husky. One layer, no backend/frontend split. The Rust binary `bcct` ports the hooks, setup, health, launcher and status line from the Node.js scripts; the TypeScript extensions and the channel server stay TypeScript.

## Layout

- `plugins/telegram/` - the channel plugin fork (`server.ts`, skills) with the project's own TypeScript in `plugins/telegram/extensions/`. Upstream files stay identical to the official plugin; see `NOTICE` for the exceptions, and keep it in step when one is added.
- `plugins/telegram-hooks/` - the hooks and status line plugin.
- `plugins/bcct/` - the `/bcct:` skills (setup, health, token, pairing and the rest).
- `scripts/` - setup, health, release, mutation, coverage and git helpers, each with its test in `scripts/__tests__/`.
- `rust/` - the Rust workspace of the `bcct` binary (`rust/crates/bcct/`), with the toolchain pinned in `rust-toolchain.toml` at the root and its lints, `clippy.toml`, `rustfmt.toml` and `deny.toml` in `rust/`.
- `.husky/` - git hooks, with their tests in `.husky/__tests__/`.
- `docs/` - `docs/setup/` (setup guide) and `docs/decisions/<Scope>/NNN-slug.md` (one file per decision, `000` is the scope index).

## Main scripts

- `npm run setup` (and `setup:<step>`) - interactive setup; `npm run health` checks it.
- `npm test` - unit suite; `npm run test:e2e` - end-to-end suite; `npm run test:all` - both; `npm run test:hooks` - the hook tests.
- `npm run lint` - oxlint, ESLint and `tsc`; `npm run lint:typos`, `lint:secrets`, `lint:lockfile`.
- `npm run format` / `format:check` / `format:file -- <files>` - Prettier.
- `npm run test:mutation`, `test:mutation:changed`, `test:mutation:score`, `test:mutation:baseline` - Stryker.
- `npm run rust:check` (`cargo check`, short and quiet, for the edit loop), `rust:lint` (clippy with `-D warnings` and `rustfmt --check`), `rust:test` (nextest), `rust:cov` (100% of lines), `rust:deny` (known vulnerabilities and yanked versions), `rust:mutation` (cargo-mutants), `rust:build` (release binary). The cargo tools come pinned through mise.
- `npm run check:commit` - runs the pre-push checks (without mutation) on a commit in a temporary worktree.
- `npm run check:private` - scans the staged changes for personal data.
- Run tools through these scripts, never `npx`.

## Non-negotiables

- Code, identifiers and commit messages in English; the user-facing messages follow the `en-us`/`pt-br` language the user picked in the setup.
- No comments in code unless explicitly requested; the names explain.
- Explicit return types on functions, and `===`/`!==` only.
- Every change comes with tests, covering the error and edge paths and not only the happy path. Write the test before the fix; for a refactor, a test that locks the current behavior before touching the source.
- Mutation testing is a gate: the pre-push hook mutates the pushed sources, a survivor on a changed line blocks the push, and the rest of a file may not exceed `mutation-baseline.json`. The baseline only goes down (`npm run test:mutation:baseline`); never raise it to get a push through.
- Never read, print or commit `.env` files or tokens; the bot token only enters through the setup.
- Tests never touch the real `~/.claude`, the real bot or the real `.git`: they run on a temporary home and temporary repositories (`vitest.setup.ts`).
- No personal data in commits (emails, machine paths, tokens, other people's accounts): the pre-commit runs `npm run check:private`.
- Check the editor diagnostics of the files you edited before declaring the work done; use `npm run lint` at the end of a task and the targeted spec in the middle of it.
- Dependencies: install pinned versions, keep `package.json` and `package-lock.json` in the same commit, and run `npm run lint:lockfile` after changing either.
- Decisions that change how the project works go to `docs/decisions/` with the `/decision` skill.

## Project skills and hooks

- `/commit` - groups the changes by theme, validates each commit and pushes with approval; the only path to `git commit` and `git push`.
- `/pre-commit` - reviews the changes and runs the checks, then hands over to `/commit`.
- `/decision` - records a technical decision in `docs/decisions/<Scope>/` as Decision, Why, Discarded, and updates the scope index.
- `.claude/hooks/` - hooks that enforce these conventions on tool calls (routing commit and push through `/commit`, formatting and linting edited files, checking the lockfile after dependency commands); read them before relying on their behavior.

## Questions in skills

Applies to every skill in `.claude/skills/` that asks the developer something:

- A question with options goes through `AskUserQuestion`, with the recommendation first (`(Recommended)` in the label) and `multiSelect` when the choices do not exclude each other. Independent questions of the same moment go together in one call (up to 4); one that depends on another answer goes in a later call. Open text, such as approving a draft, stays in prose.
- The argument pre-answers. The developer may pass the answer in the command itself, as a keyword or in free language (`/commit stage`, `/pre-commit skip the review`). What the argument answers is not asked again: confirm in one line what was understood. An ambiguous argument falls back to the question.
- Each skill declares the answers it accepts in the `argument-hint` of its frontmatter and in an **Argument** section at the top. A skill that calls another passes along the part of the argument that belongs to the other.
- A pre-answer is valid only for that run and never replaces an approval the rules require case by case, such as each git operation outside the approved plan.

## Orchestration and models

The main session orchestrates, and each piece of work goes to the model sized for it. The current version of each family applies.

- **Opus** (main loop, `high` effort): whatever needs judgment: planning, deciding, triaging mutation survivors, designing, reviewing and integrating.
- **Sonnet** (`model: "sonnet"`, `medium` effort by default, `high` only as an exception when the task needs more reasoning): surveys (mapping files, inventories, comparing versions, reading a changelog or doc) and simple, well-specified implementation.
- **Haiku** (`model: "haiku"`, `medium` to `high` effort by scenario): trivial reading (finding a file, counting occurrences, extracting a snippet, checking a fact). It only reads and never writes a file.

What an agent returns is checked by the orchestrator before it becomes code, a commit or an answer; an agent never commits or pushes. A workflow is used only when the fan-out passes five agents.

## Local rules

The maintainer's detailed rules live in `.claude/rules/` (local, not versioned) and load by path when present. Without them, this file and the scripts above are the contract; the hooks and their tests under `.husky/__tests__/` are the source of truth for what each git hook enforces.

## Keeping the docs true

- No task IDs and no temporal wording in versioned files: state the convention as it holds, with an anchor to a rule, a file, a symbol or a lint mechanism.
- When a convention, script or behavior changes, search the docs, skills and READMEs that cite it and fix them in the same commit.
- Every doc has its own folder, `docs/<name>/<name>.md` (en-us) and `docs/<name>/<name>.pt-br.md`; decisions are written in pt-br.
