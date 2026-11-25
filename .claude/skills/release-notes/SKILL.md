---
name: release-notes
description: Use when the user asks for the release notes of a version, before the version pull request. Turns the patch notes of the pull requests merged since the last tag, the git-cliff draft and the commits into the public notes of the GitHub Release, in en-us with a collapsed pt-br block, and gets each part approved.
argument-hint: "[<version>] [replace] [no omitted]"
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# /release-notes

Write the notes of the next release in the description of the version pull request (`release/v<version>`), between the lines `<!-- notes -->` and `<!-- /notes -->`, which the prepare workflow (`prepare-release.yml`, through `npm run release:pr -- prepare`) opens with the git-cliff draft there, under a `<!-- draft -->` line. The `Release notes` check (`release-pull-request.yml`) keeps the pull request red while that line is between the markers or the notes are empty, so the notes written here leave it out. On merge, the release workflow reads only what is between the two markers, uses it as the body of the GitHub Release and records it in `docs/releases/<major.minor.patch>/<stage>.md` (`0.1.0-alpha.2` in `docs/releases/0.1.0/alpha.2.md`, the stable `0.1.0` in `docs/releases/0.1.0/stable.md`) in the commit that records the checksums. The notes are drafted in a scratchpad file, approved part by part and only then written to the description with `gh pr edit <n> --body-file -`, keeping everything outside the markers as it was. If the markers already hold notes other than the git-cliff draft (no `<!-- draft -->` line), ask with `AskUserQuestion` whether to replace them. After the edit, `npm run release:pr -- check-notes` with the new description in `PR_BODY` gives the same answer as the check.

Questions go through `AskUserQuestion`, recommendation first with `(Recommended)` in the label, and each draft part is approved there with its text in the `preview`. When the user answers through Telegram, only the question reaches them: the explanation, the options and the numbers go inside the question, never only in the terminal.

## Argument

`$ARGUMENTS` can pre-answer: the version (`0.1.0-alpha.1`; without it, `npm run release:version -- check` gives the current one, and `gh pr list --head release/v<version>` gives the pull request), `replace` (replaces the notes in the description without asking) and `no omitted` (closes the notes without offering the omitted items). What the argument answered is not asked again.

## Reader

- **Only the public.** The notes are for whoever installs the plugin and uses Claude Code through Telegram: features, fixes the user notices, speed, setup and update, and security in general terms. Product language, without function, file, script, crate or flag names, except the commands the user types (`bcct update`, `/bcct:health`).
- **Repository work stays out.** Hooks, CI, tests, mutation, scripts and the Claude Code setup of the repository do not enter the notes; they go to the omitted list, where the user can still pick one that the public notices.
- **A release with nothing for the public** says so in one summary bullet and lists the rest as omitted.
- **When in doubt, ask.** An item whose place is not clear (the user notices it or not, a security detail that may not fit the public) or whose wording is not clear goes to the user with `AskUserQuestion` before the notes are closed:
  - **Place:** options "Include" and "Omit", recommendation first, with the proposed bullet in the question.
  - **Wording:** two or three versions of the bullet as options, each in its `preview`, recommendation first.
  - Independent questions go together in one call (up to 4); an item without doubt is not asked.

## The body of the Release

What goes between the markers is the body of the GitHub Release as it is, so it has the two languages: en-us first, then the same sections in pt-br inside a collapsed block.

```
### 📋 Summary
<two to four bullets>

✨ new · 🐛 fix · ⚡ performance · 🔐 security

<the sections that apply>

📣 Follow the releases on Telegram: [@bcct_tips](https://t.me/bcct_tips) (stable) · [@bcct_tips_prereleases](https://t.me/bcct_tips_prereleases) (every version)

<details><summary>🇧🇷 Português</summary>

### 📋 Resumo
<os mesmos tópicos em pt-br>

✨ novo · 🐛 correção · ⚡ desempenho · 🔐 segurança

<as mesmas seções em pt-br>

📣 Acompanhe as novidades no Telegram: [@bcct_tips_br](https://t.me/bcct_tips_br) (estáveis) · [@bcct_tips_prelancamentos](https://t.me/bcct_tips_prelancamentos) (todas as versões)

</details>
```

Every Release ends each language with the 📣 line that invites to follow the Telegram channels of that language, with the handles of `ANNOUNCE_CHANNELS` in `scripts/release.constants.mjs`; it is a plain line, outside every section, so the announcement does not take it as an item.

The pt-br block is a faithful version of the en-us one, section by section and item by item, in correct Portuguese with every accent; it is written from the en-us text, never with fewer or more items.

## Formatting rules

- No title at the top: the Release has the version as its name. The notes start with `### 📋 Summary`.
- No horizontal rules (`---`) and no count of files or lines.
- GitHub markdown: `###` for the sections, `**bold**`, `- bullets`; `<details>` only for the pt-br block.
- A dependency update the user notices names the version before and after (`grammy 1.21 → 1.46`), checked in the lock of the last tag and of `HEAD`.
- A ✨ item reads like a Telegram Tips post: `- ✨ **Title.** First sentence with **key words** in bold.` The bold title is the name of the feature, and the first sentence says what it does, with its key words in bold. An optional second paragraph says what the user gains: an indented text line (two or more spaces) under the item, after a blank line. More paragraphs follow the same way, each after a blank line. Each language writes its own paragraphs. On Telegram, the caption of the item is the title and the sentence, then each paragraph after a blank line, without the leading ✨, within the 1024 characters Telegram takes.
- A ✨ item that a demo shows carries three attachments: a GIF for the Release, which autoplays and loops on GitHub, and one H.264 MP4 per language for the Telegram channels, each opening on a title card in its language for about 0.7 s, since Telegram uses the first frame of the video as its preview. `gh pr edit <n> --attach <file>` (gh 2.99 or later) uploads them into the description of the version pull request and rewrites a local path the body references, such as `![alt](./demo.gif)`, to the attachment URL. After the paragraphs of the en-us item come a blank line, the image line `  ![<short alt>](<gif url>)` indented two spaces, so GitHub renders the GIF as its own paragraph inside the item instead of inline in its text, and the comment line `  <!-- telegram: <en-us mp4 url> -->`, indented the same way. The pt-br item carries only its own comment line, `  <!-- telegram: <pt-br mp4 url> -->`. GitHub hides the comments, so the Release shows only the GIF. The block of one item in each language:

  ```
  - ✨ **Buttons for questions.** Claude's questions arrive on Telegram with **one button per option**.

    Answer from your phone with one tap, without typing the option back.

    ![Buttons on Telegram](https://github.com/user-attachments/assets/<gif id>)
    <!-- telegram: https://github.com/user-attachments/assets/<en-us mp4 id> -->
  ```

  ```
  - ✨ **Botões nas perguntas.** As perguntas do Claude chegam no Telegram com **um botão por opção**.

    Responda pelo celular com um toque, sem digitar a opção de volta.

    <!-- telegram: https://github.com/user-attachments/assets/<pt-br mp4 id> -->
  ```

  The pt-br ✨ items pair with the en-us ones by order and share their GIF, so both languages keep the same ✨ items in the same order. Once the version is verified, `announce-release.yml` posts the notes on the Telegram channels (`npm run release:announce`), with one post per ✨ item that has a demo, as a reply to the opening: the MP4 of the item in the language of the channel, else the en-us MP4, else the GIF. A URL that ends in an extension other than `.gif` or `.mp4` fails the announcement.

### Emojis

- **Section title:** starts with the fixed emoji of the area, the same in both languages: 💬 Telegram channel, 🧰 Setup, health and update, 🧩 Plugin and binary, 🎙️ Voice transcription, 📊 Status line, 🔐 Security. A new area picks an emoji not in use yet and keeps it in every release.
- **Item:** each change starts with the emoji of its kind, right after `- `: ✨ new, 🐛 fix, ⚡ performance, 🔐 security, 💥 breaking change, 🔥 removal, ♻️ redone. The kind says the nature of the change and the area stays in the title: an item never repeats the emoji of its own section.
- **Legend:** right after the summary of each language, with only the item emojis that language block uses, separated by `·`. GitHub has no script that adds it, so the notes carry it.
- **No item emoji** in the summary bullets: they are short sentences about the release as a whole.

## Structure

Use only the sections that apply:

```
### 📋 Summary
### 💬 Telegram channel
### 🧰 Setup, health and update
### 🧩 Plugin and binary
### 🎙️ Voice transcription
### 📊 Status line
### 🔐 Security
```

- `### 📋 Summary` in two to four bullets: what someone who updates notices first, with **bold** at the start when it helps scanning. A breaking change, a new requirement (Node, git, a command to run after updating) or a step the user has to take comes first.
- `### 🔐 Security` only in general terms. The detail of a fix (which path answered what) stays out of the notes until every installed version can update.
- Self-contained bullets, one change each. Each item appears once in the notes.

## Process

1. The range of a pre-release is the last tag to `HEAD`: `git describe --tags --abbrev=0` (no tag yet: the whole history). The range of a stable version is the previous stable tag to `HEAD`, `git describe --tags --abbrev=0 --exclude '*-*'`, since its notes cover everything since the previous stable, the pre-releases of the version included; with no stable tag yet (the command fails with `No names found`), the range is the whole history, from the first commit, `git rev-list --max-parents=0 HEAD`, which takes the place of the tag in the commands below (step 3 then runs `npm run --silent release:cliff` with no range). Then `git log --oneline <tag>..HEAD` and `git diff --stat <tag>..HEAD`.
2. Start from the patch notes of the pull requests: `npm run --silent release:patch-notes` for a pre-release, and `npm run --silent release:patch-notes -- <tag>` with the previous stable tag for a stable version. It lists the pull requests merged on `main` since the last tag, by the first-parent merge commits, and prints for each one its number, title and the `🇺🇸 English` and `🇧🇷 Português` blocks of its description, marks the ones from `dependabot/`, `release/v` and `revert/` as exempt, and ends naming the pull requests whose notes are missing, not shown by GitHub, empty, still the template placeholder or not readable as GitHub shows them. Each printed block renders as GitHub shows it in the description. The printed blocks leave out the HTML comments, so the `<!-- telegram: <url> -->` line of each ✨ item comes from the raw description of its pull request: `gh pr view <n> --json body --jq .body`. The blocks were written for the public under the same rules as these notes; they are the starting point, not the notes.
3. Read the draft: `npm run --silent release:cliff -- --unreleased` for a pre-release, and `npm run --silent release:cliff -- <previous stable tag>..HEAD` for a stable version, whose notes cover the pre-releases too. It lists the features, fixes, performance and security commits by kind, without the emoji and without maintenance.
4. Reconcile the patch notes with the draft and the commits: a draft item that no patch notes cover is checked in its commits, in case a pull request left out something the public notices; the same change in the notes of more than one pull request becomes one item; an item a later pull request undid or redid leaves the notes or takes the final shape.
5. A pull request without patch notes, named at the end of the output, is read from its commits and the diff behind each draft item, plus the maintenance commits the draft leaves out, in case one changes something the user notices (a new requirement, a step after updating).
6. Classify each change by impact: high (the user notices and has to know), medium (a feature changes in a way the user notices), low (internal, repository work or trivial: omitted).
7. Decide whether each item enters; what is in doubt becomes a question (section "Reader").
8. Write the en-us notes, then the pt-br block from them, and get each part approved (summary, each section, the pt-br block) with `AskUserQuestion`, `Approve (Recommended)` first and the adjustment through "Other"; a changed part comes back in a new question for that part only.

## Confidentiality

The notes are public: the Release page and anyone who watches the repository read them. Leave out what helps an attacker, even when it is in the code:

**Never include:**

- The bot token, the chat id, the pairing code or any value from `.env`, `access.json` or the app config, nor where exactly they are stored beyond what the README already documents.
- How the permission relay could be bypassed (which check a message passes, timing windows, how a sender is matched).
- Paths and names of the machine where the release was built, and any personal data from commits.

**Can include (in general terms):**

- That pairing, the allowlist or the permission relay got stricter, without the mechanism.
- New commands and flags the user types.
- High-level architecture decisions.

**When in doubt:** use the general sentence. "Messages from chats outside the allowlist are dropped earlier" is fine; the exact check and its order is not.

## Omitted items

After writing the notes, list **in the terminal (not in the notes)** the omitted items, split by why they stayed out:

```
**Left out as low impact (confirm if you want any):**
- ...

**Left out as repository work (confirm if you want any):**
- ...
```

The user picks which to add in one `AskUserQuestion` call: one `multiSelect` question per list (one option per item, none checked = done; more than 4 items split into more questions in the same call), with the list itself in the question, since the terminal may not reach the user. A checked item enters written for the public, in both languages. An empty list is not asked. With `no omitted` in the argument, only list them.

## Example of a well-formed bullet

In `### 🧰 Setup, health and update`:

```
- ✨ `bcct update` installs the newest version of the marketplace, the plugins and the binary, and checks the binary against the hash the plugin carries before switching to it.
```
