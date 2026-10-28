---
name: decision
description: Use when the user wants to record a technical decision. Writes one numbered file in docs/decisions/<Scope>/ in the Decisão · Porquê · Descartado format and updates the scope's 000 index in the same pass.
argument-hint: "[scope + the decision, e.g. Hooks, answer questions through PermissionRequest] [descartado: X, Y]"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# /decision

Record a technical decision as a canonical document in `docs/decisions/`.

The document answers **one** question: "what is the current decision about X, and why did the alternatives fall?". So it describes the **current state**, never a chronological history: whoever wants the "when" reads the git log; whoever opens a decision wants the **why** that stops the choice from being relitigated three months later.

`docs/decisions/**` is versioned, so what is written here enters the repository and everyone reads it. Questions go through `AskUserQuestion`, recommendation first with `(Recommended)` in the label; the argument pre-answers (`descartado: X, Y` gives the discarded alternatives), and what it answered is not asked again. The draft in step 5 is always approved before writing.

## Language

The existing decision files are written in Portuguese (pt-br), with the field names `Decisão`, `Porquê` and `Descartado`, scope folders without accents (`Fork`, `Hooks`, `Instalacao`, `Transcricao`) and slugs in pt-br kebab-case. Read one or two of them first and match their language and tone exactly. Identifiers (files, functions, flags, hooks) stay in English, inside backticks.

## What is (and is not) a decision

**It is:** a choice that had a real alternative and closed a door: topology, contract, data format, limit, policy, invariant, what was deliberately discarded.

**It is not:** an execution walkthrough, how to consume the thing, a fixed bug, a finished task.

Quick test: if you cannot fill **Descartado** with an alternative a reasonable person would defend, it is probably a task, not a decision. Say so and ask with `AskUserQuestion` (treat as a task / record anyway) before creating the file.

## Layout on disk

```
docs/decisions/
└── <Scope>/
    ├── 000-<scope>-decisoes.md   (index of the scope)
    ├── 001-<slug>.md             (one decision)
    └── 002-<slug>.md
```

## Step 1. Scope

The scope is the feature or line of work, not the issue: `Fork`, `Hooks`, `Instalacao`, `Transcricao`. Several issues can feed the same scope.

- List what exists: `ls docs/decisions/`.
- If `$ARGUMENTS` already names the scope, match it with an existing folder (ignoring case and accents) and go on, confirming in one line which scope was understood.
- Otherwise ask with `AskUserQuestion`: 3 predefined options (the closest existing folders plus the new scope you inferred), your recommendation first. A new folder fragments the docs, so the confirmation avoids duplicate scopes.

## Step 2. Is it already decided?

Before reserving a number, read the scope's `000` index and the titles of the existing files. Three outcomes:

- **New subject:** a new decision, go on.
- **The subject has a file and the decision changed:** this is an **edit** of that file (see "A decision that changes later"), not a new file. Say so before continuing.
- **Already covered, you were about to write the same with other words:** do not write. Point to the file that already holds.

Two files saying similar things is the fastest way for the folder to lose authority.

## Step 3. Confirm the anchors

A decision is worth what can be checked. Before writing, confirm **every concrete name** that will enter the text: file, function, hook, flag, script, command, setting, number of a limit or timeout. Use `grep -rn "<name>" plugins scripts`, read the file, or run the command. **Never guess a plausible name:** a name that does not exist is worse than none. What could not be confirmed goes in the approval as pending, not as fact. A design decision made before the code exists is legitimate: declare it and anchor on what already exists (the module where it will live). The confirmed names become the **Âncoras** field.

## Step 4. Write

Number = highest `NNN` in the folder **+ 1**, three digits, starting at `001` (`000` is always the index); read it with `ls`, not from memory. File name `NNN-<slug>.md`, short kebab-case slug in pt-br, by the **subject** (`001-transcricao-local.md`), not by the whole conclusion. A new scope is born with the folder **and** its `000` together.

Exact file format (copy from an existing file when in doubt):

```markdown
# NNN. <Short title: what was decided>

> **Versão:** 1 · **Decidido por:** <name>
> **Card:** [#<n>](<issue url>)
> **Branch:** `<branch>` · **PR:** [#<n>](url)
> **Criado em:** <YYYY-MM-DD HH:MM> · **Atualizado em:** —
> **Âncoras:** `<file or symbol>` · `<file or symbol>`

**Decisão:** <the current state, affirmative>

**Porquê:** <the constraint or evidence that forced the choice>

**Descartado:** <the alternatives considered and why each fell>
```

Where each piece of metadata comes from (automatic, nothing typed by hand):

- **Versão:** starts at `1` and goes up on every edit. There is no status field: what was revoked lives in **Descartado**.
- **Decidido por:** `git config user.name`.
- **Card:** the issue of the branch (`0042-short-title` is #42): `[#42](<issue url>)`, the url from `gh issue view 42 --json url`. A branch outside the pattern (`main`, `revert/*`), or no remote, has no issue: **omit the line**.
- **Branch:** `git branch --show-current`; it dies at the merge, the durable reference is the PR.
- **PR:** `gh pr view --json number,url`, printed as a link. No PR yet: **omit the field**, better absent than a `—` that never gets filled. Omit the whole line when both Branch and PR are absent.
- **Criado em / Atualizado em:** `date '+%F %H:%M'`; `Atualizado em` is born `—`.
- **Âncoras:** the symbols confirmed in step 3.

How to fill the three fields, where the doc wins or loses its value:

- **Decisão:** what **is**, in the present. If you wrote "became", "we changed from X to Y" or "now uses", rewrite it as state. Anchor on the concrete: file, hook, flag, script, function.
- **Porquê:** the real constraint, not the preference. "It is simpler" is not a reason; **what breaks if we do it differently** is. When the reason is empirical (a measurement, a limit of a provider, official docs), say which: the evidence is what holds the decision when someone questions it.
- **Descartado:** each alternative with the reason it fell, in a line. This field is what stops the discussion from restarting from zero.

Writing rules:

1. Inline `code` for identifiers; **no code blocks** (the optional flowchart below is the only exception). If you miss a block, what is missing is an integration guide, not a decision.
2. **No chronology** and no "phase 1/2/3": describe the final state.
3. **No emoji**, no decorative icon.
4. **No private data**: no personal path, e-mail, token or name of a third party. The decision is technical.
5. **One decision per file.** Several in one request become one file each, sequential numbers.

### Flowchart (optional)

When the decision is about evaluation order, branching, precedence between rules or a state machine, a `mermaid` block right after the **Decisão** paragraph can say what prose would take three paragraphs to say. The test: does it answer something the text does not answer better? If it only repeats the paragraph in boxes, do not draw it. Rules: at most ~10 nodes; each label is the behavior in a few words, with the real function or script name in parentheses only when confirmed (labels with parentheses must be in quotes); a decision node is a question and the edge carries the answer; the happy path straight down, exceptions to the side; no colors or `style`. The block stays in the file (GitHub renders it); do not generate a PNG. If `mmdc` is installed you may render it to check the proportions and read the image; never install it without an explicit yes from the user, and if it is not there say in the final report that the diagram was not checked visually.

## Calibration

The right density, from this repository (`Hooks/001`): **Decisão** names the hook, the file and the functions that implement it; **Porquê** says what was measured and what only this path guarantees; **Descartado** lists each alternative with the reason in the same line.

The same decision written badly, to recognize the pattern: "**Decisão:** we improved how questions are answered. **Porquê:** it is simpler and more robust. **Descartado:** none." It does not say what is true today, so nobody can check it against the code; "simpler" does not say what breaks otherwise, so it does not hold when questioned; and with no Descartado the next contributor proposes the same alternatives again.

## Step 5. Approve before writing

Send the draft in exactly this format, without touching the disk:

```
I will record this decision. Confirm or adjust:

File:  docs/decisions/<Scope>/NNN-<slug>.md
Title: <title>

Decisão:    <...>
Porquê:     <...>
Descartado: <...>

Âncoras:       <confirmed symbols>
To confirm:    <what could not be verified, or "nothing">
```

If `$ARGUMENTS` came terse or empty, build it from what was decided **in this session**. The field that is missing most is **Descartado**: the alternatives live in the head of whoever decided and cannot be deduced from the code. Ask instead of inventing ("did we consider X?" beats a plausible and false Descartado), unless the argument brought `descartado:`. Several decisions at once go in the same message, numbered, and are written only after the general OK.

## Step 6. Write and update the `000` index

Every new decision updates the index in the same pass: a stale index is worse than none. Create the index when the scope is new, copying an existing `000`:

```markdown
# <Scope> — Decisões

## Resumo

<the two intro paragraphs, copied verbatim from an existing `000`, with one line about the scope>

## Decisões

| #                    | Decisão             | Versão | Por    | Criado           | Atualizado |
| -------------------- | ------------------- | ------ | ------ | ---------------- | ---------- |
| [001](001-<slug>.md) | <title of the file> | 1      | <name> | 2026-10-19 01:16 | —          |
```

The **Decisão** column repeats the file title. Branch and Âncoras stay only in the file. Run `npm run --silent format:file -- <files>` on the new and edited files (the table alignment is prettier's).

## A decision that changes later

Two paths: **revising** is the same decision maturing; **replacing** is a different decision taking the place of the old one. Run all the actions of the path and list what was touched in the final report.

**Revision (same decision, new content).** Edit the existing file, do not create a new `NNN`.

1. Rewrite **Decisão** in the new current state (and **Porquê** if the reason changed).
2. **Move what fell into Descartado.** The alternative that used to be the standing decision is the most valuable of the discarded ones: it is the one someone will propose again, arguing "it was already like that".
3. Raise **Versão** (`1` to `2`) and fill **Atualizado em** with `date '+%F %H:%M'`.
4. In the `000` index update **Versão** and **Atualizado**, and the **Decisão** column if the title changed.

**Replacement.** Three files are touched; forgetting one leaves the folder lying:

1. **New file:** right under the header, `> **Substitui a [MMM](MMM-slug.md).**`, and its **Descartado** opens with the old decision and the reason it fell.
2. **Old file:** right under the header, `> **Substituída pela [NNN](NNN-slug.md).**`. Do not delete, empty or rewrite its body. Raise **Versão** and fill **Atualizado em**.
3. **Index `000`:** the old row gains `(substituída pela NNN)` at the end of the **Decisão** column; the new one enters in sequence.

Never delete a decision: deleting what was discarded deletes exactly the learning the folder exists to keep.

## Step 7. Deliver

Report briefly:

- the **absolute path** of each file created or edited, one per line (`git rev-parse --show-toplevel` plus the relative path);
- the row that entered (or changed) in the index;
- a reminder that `docs/decisions/**` is versioned: the file enters the next commit, and when the decision accompanies a change it goes in the same commit as the change it explains (the `commit` skill stages it with the theme);
- whether a flowchart could not be checked visually.

Do not repeat the whole decision in the chat; it was approved in step 5.
