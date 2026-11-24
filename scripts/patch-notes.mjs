import { execFileSync } from "node:child_process";

import { git as gitCli } from "./git.mjs";
import { MERGE_LOG_FORMAT, mergedPrTarget, parseMerges } from "./merged-pr.mjs";
import {
  EXEMPT_HEAD_PREFIXES,
  PATCH_NOTES_HEADING,
  PATCH_NOTES_LANGUAGES,
  PATCH_NOTES_PLACEHOLDER,
  PATCH_NOTES_TEMPLATE,
} from "./patch-notes.constants.mjs";
import { PULL_REQUEST_NUMBER } from "./pull-request.constants.mjs";

const USAGE = [
  "Usage: npm run pr:patch-notes -- check <pull request number>",
  "       npm run release:patch-notes -- [<tag>]",
].join("\n");
const COMMENT_START = "<!--";
const COMMENT_END = "-->";
const DETAILS_START = "<details>";
const DETAILS_OPEN = "<details";
const DETAILS_END = "</details>";
const IMAGE_START = "<img";
const TAG_START = "<";
const TAG_END = ">";
const ZERO_WIDTH_CHARACTERS = new RegExp(
  [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("|"),
  "g",
);
const WHITESPACE_BETWEEN_TAGS = />\s+</g;
const RENDERED_HEADING = `>${PATCH_NOTES_HEADING.slice("## ".length)}</h2>`;
const MAX_CANDIDATES = 5;
const MARKDOWN_MODE = "gfm";
const RENDER_MAX_BUFFER = 16 * 1024 * 1024;

class UsageError extends Error {}

function withoutClosedComments(text) {
  let visible = "";
  let from = 0;

  for (;;) {
    const start = text.indexOf(COMMENT_START, from);
    const end =
      start === -1
        ? -1
        : text.indexOf(COMMENT_END, start + COMMENT_START.length);

    if (end === -1) return visible + text.slice(from);

    visible += text.slice(from, start);
    from = end + COMMENT_END.length;
  }
}

function nextBlockStart(text, label, from) {
  const summaryStarts = Object.values(PATCH_NOTES_LANGUAGES)
    .filter((other) => other !== label)
    .map((other) => text.indexOf(`<summary>${other}</summary>`, from))
    .filter((index) => index !== -1);

  if (summaryStarts.length === 0) return text.length;

  const summaryStart = Math.min(...summaryStarts);
  const detailsStart = text.lastIndexOf(DETAILS_START, summaryStart);

  return detailsStart < from ? summaryStart : detailsStart;
}

function contentStartOf(text, label) {
  const summary = `<summary>${label}</summary>`;
  const start = text.indexOf(summary);

  return start === -1 ? -1 : start + summary.length;
}

function firstDetailsEnd(text, from) {
  return text.indexOf(DETAILS_END, from);
}

function matchingDetailsEnd(html, from) {
  let depth = 1;
  let at = from;

  for (;;) {
    const end = html.indexOf(DETAILS_END, at);

    if (end === -1) return -1;

    const open = html.indexOf(DETAILS_OPEN, at);
    const opensFirst = open !== -1 && open < end;

    depth += opensFirst ? 1 : -1;

    if (depth === 0) return end;

    at = (opensFirst ? open : end) + 1;
  }
}

function boundedBlock(text, label, endOf) {
  const contentStart = contentStartOf(text, label);

  if (contentStart === -1) return null;

  const boundary = nextBlockStart(text, label, contentStart);
  const end = endOf(text, contentStart);

  return text.slice(
    contentStart,
    end === -1 || end > boundary ? boundary : end,
  );
}

function blockOf(text, label) {
  return boundedBlock(text, label, firstDetailsEnd);
}

function shownBlockOf(html, label) {
  return boundedBlock(html, label, matchingDetailsEnd);
}

function rawBlocksOf(section, label) {
  const contentStart = contentStartOf(section, label);
  const boundary = nextBlockStart(section, label, contentStart);
  const blocks = [];
  let end = firstDetailsEnd(section, contentStart);

  while (end !== -1 && end < boundary && blocks.length < MAX_CANDIDATES) {
    blocks.push(section.slice(contentStart, end));
    end = firstDetailsEnd(section, end + DETAILS_END.length);
  }

  return blocks.length === 0 ? [section.slice(contentStart, boundary)] : blocks;
}

function candidatesOf(section, label) {
  const candidates = [
    blockOf(withoutClosedComments(section), label),
    ...rawBlocksOf(section, label),
  ]
    .filter((candidate) => candidate !== null)
    .map((candidate) => candidate.trim());

  return [...new Set(candidates)].slice(0, MAX_CANDIDATES);
}

function withoutTags(html) {
  let text = "";
  let from = 0;

  for (;;) {
    const start = html.indexOf(TAG_START, from);

    if (start === -1) return text + html.slice(from);

    text += html.slice(from, start);

    const end = html.indexOf(TAG_END, start);

    if (end === -1) return text;

    from = end + TAG_END.length;
  }
}

function hasContent(shown) {
  return (
    shown.includes(IMAGE_START) ||
    withoutTags(shown).replace(ZERO_WIDTH_CHARACTERS, "").trim() !== ""
  );
}

function squeezed(html) {
  return html.replace(WHITESPACE_BETWEEN_TAGS, "><").trim();
}

function failed(text) {
  return { problem: text, notes: null };
}

function blockResult(section, rendered, label, render) {
  const source = blockOf(section, label);

  if (source === null) return failed(`the ${label} block is missing`);

  const shown = rendered === null ? null : shownBlockOf(rendered, label);

  if (shown === null) {
    return failed(
      `the ${label} block is not shown by GitHub (hidden by an HTML comment or inside code)`,
    );
  }

  if (!hasContent(shown)) {
    return failed(
      source.includes(PATCH_NOTES_PLACEHOLDER)
        ? `the ${label} block is still the template placeholder`
        : `the ${label} block is empty`,
    );
  }

  const expected = squeezed(shown);
  const notes = candidatesOf(section, label).find(
    (candidate) => squeezed(render(candidate)) === expected,
  );

  return notes === undefined
    ? failed(`the ${label} block could not be read as GitHub shows it`)
    : { problem: null, notes };
}

function sectionsOf(text, html) {
  const lines = text.split("\n");
  const start = lines.findLastIndex(
    (line) => line.trimEnd() === PATCH_NOTES_HEADING,
  );

  if (start === -1) return { section: text, rendered: html };

  const renderedStart = html.lastIndexOf(RENDERED_HEADING);

  return {
    section: lines.slice(start).join("\n"),
    rendered: renderedStart === -1 ? null : html.slice(renderedStart),
  };
}

function normalized(body) {
  return (body ?? "").replaceAll("\r\n", "\n");
}

function languageBlocks(body, render) {
  const text = normalized(body);
  const html = text === "" ? "" : render(text);
  const { section, rendered } = sectionsOf(text, html);

  return Object.entries(PATCH_NOTES_LANGUAGES).map(([language, label]) => ({
    language,
    label,
    ...blockResult(section, rendered, label, render),
  }));
}

export function patchNotesFrom(body, render) {
  const blocks = languageBlocks(body, render);

  return {
    notes: Object.fromEntries(
      blocks.map(({ language, notes }) => [language, notes]),
    ),
    problems: blocks
      .map(({ problem }) => problem)
      .filter((problem) => problem !== null),
  };
}

function isExemptHead(head) {
  return EXEMPT_HEAD_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function readPullRequest(gh, number) {
  const { body, headRefName } = JSON.parse(
    gh(["pr", "view", String(number), "--json", "body,headRefName"]),
  );

  return { body, head: headRefName ?? "" };
}

function checkPullRequest(args, { gh, render, out, err }) {
  const [number] = args;

  if (args.length !== 1 || !PULL_REQUEST_NUMBER.test(number)) {
    throw new UsageError();
  }

  const { body, head } = readPullRequest(gh, number);

  if (isExemptHead(head)) {
    out(
      `✓ Pull request #${number} comes from ${head}, which carries no patch notes.`,
    );
    return 0;
  }

  const { problems } = patchNotesFrom(body, render);

  if (problems.length === 0) {
    out(
      `✓ Pull request #${number} carries the patch notes in English and in Portuguese.`,
    );
    return 0;
  }

  err(
    [
      `✗ Pull request #${number} has no complete patch notes in the description: ${problems.join("; ")}.`,
      `  Fill both blocks under "${PATCH_NOTES_HEADING}" of ${PATCH_NOTES_TEMPLATE} with only what whoever installs the plugin notices, in the /release-notes format.`,
    ].join("\n"),
  );
  return 1;
}

function lastTag(git) {
  try {
    return git(["describe", "--tags", "--abbrev=0"]).trim();
  } catch {
    return null;
  }
}

function pullRequestCount(count) {
  return count === 1 ? "1 pull request" : `${count} pull requests`;
}

function pullRequestSection(merge, { gh, render }) {
  const { body, head } = readPullRequest(gh, merge.number);
  const title = `### ${mergedPrTarget(merge).label}`;

  if (isExemptHead(head)) {
    return {
      lines: [title, "", `Exempt: ${head} carries no patch notes.`, ""],
      complete: true,
    };
  }

  const blocks = languageBlocks(body, render);
  const lines = blocks.flatMap(({ label, problem, notes }) => [
    `#### ${label}`,
    "",
    problem === null ? notes : `✗ ${problem}`,
    "",
  ]);

  return {
    lines: [title, "", ...lines],
    complete: blocks.every(({ problem }) => problem === null),
  };
}

function collectPatchNotes(args, { gh, git, render, out }) {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    throw new UsageError();
  }

  const tag = args[0] ?? lastTag(git);
  const range = tag === null ? "HEAD" : `${tag}..HEAD`;
  const since = tag === null ? "in the whole history" : `since ${tag}`;
  const merges = parseMerges(
    git(["log", "--first-parent", "--merges", MERGE_LOG_FORMAT, range]),
  ).toReversed();

  if (merges.length === 0) {
    out(`No pull request merged on main ${since}.`);
    return 0;
  }

  const sections = merges.map((merge) => ({
    number: merge.number,
    ...pullRequestSection(merge, { gh, render }),
  }));
  const missing = sections
    .filter(({ complete }) => !complete)
    .map(({ number }) => `#${number}`);
  const merged = `${pullRequestCount(merges.length)} merged ${since}`;
  const summary =
    missing.length === 0
      ? `✓ ${merged}, none without patch notes.`
      : `✗ ${missing.length} of ${merged} without complete patch notes: ${missing.join(", ")}.`;

  out([...sections.flatMap(({ lines }) => lines), summary].join("\n"));
  return 0;
}

const COMMANDS = { check: checkPullRequest, collect: collectPatchNotes };

export function run(argv, { gh, git, render, out, err }) {
  const [command = "", ...args] = argv;

  try {
    if (!Object.hasOwn(COMMANDS, command)) throw new UsageError();

    return COMMANDS[command](args, { gh, git, render, out, err });
  } catch (error) {
    if (error instanceof UsageError) {
      err(USAGE);
      return 1;
    }

    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function ghCli(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function markdownRenderer(exec) {
  return (text) =>
    exec("gh", ["api", "-X", "POST", "markdown", "--input", "-"], {
      input: JSON.stringify({ text, mode: MARKDOWN_MODE }),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: RENDER_MAX_BUFFER,
    });
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    gh: ghCli,
    git: gitCli,
    render: markdownRenderer(execFileSync),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
