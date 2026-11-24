import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { markdownRenderer, patchNotesFrom, run } from "../patch-notes.mjs";
import {
  PATCH_NOTES_BODIES as BODIES,
  PATCH_NOTES_RENDERS,
  RECORD_COMMAND,
} from "./fixtures/patch-notes-bodies.mjs";

const TEMPLATE = readFileSync(".github/pull_request_template.md", "utf8");
const RENDERS = JSON.parse(readFileSync(PATCH_NOTES_RENDERS, "utf8"));
const ENGLISH_NOTES = "### 📋 Summary\n- Buttons answer faster.";
const PORTUGUESE_NOTES = "### 📋 Resumo\n- Os botões respondem mais rápido.";
const BOTH_NOTES = { english: ENGLISH_NOTES, portuguese: PORTUGUESE_NOTES };
const NOT_SHOWN = [
  "the 🇺🇸 English block is not shown by GitHub (hidden by an HTML comment or inside code)",
  "the 🇧🇷 Português block is not shown by GitHub (hidden by an HTML comment or inside code)",
];

function recordedRender(text) {
  if (!Object.hasOwn(RENDERS, text)) {
    throw new Error(
      `No GitHub render recorded for this text in ${PATCH_NOTES_RENDERS}; record them again with ${RECORD_COMMAND}.`,
    );
  }

  return RENDERS[text];
}

const notesOf = (name) => patchNotesFrom(BODIES[name], recordedRender);

function fakeGh(pullRequests) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const number = Number(args[2]);
    const pullRequest = pullRequests[number];

    if (pullRequest instanceof Error) throw pullRequest;

    return JSON.stringify(pullRequest);
  };

  return { gh, calls };
}

function fakeRender(renderError) {
  const calls = [];
  const render = (text) => {
    calls.push(text);

    if (renderError !== null) throw renderError;

    return recordedRender(text);
  };

  return { render, calls };
}

function fakeGit({ tag = "v0.1.0", log = "", logError = null } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);

    if (args[0] === "describe") {
      if (tag === null) {
        throw new Error("fatal: No names found, cannot describe anything.");
      }

      return `${tag}\n`;
    }

    if (logError !== null) throw logError;

    return log;
  };

  return { git, calls };
}

const mergeRecord = (number, title) =>
  [
    String(number).repeat(40).slice(0, 40),
    `${"a".repeat(40)} ${"b".repeat(40)}`,
    `Merge pull request #${number} from owner/branch-${number}`,
    `${title}\n`,
  ].join("\x1f") + "\x1e";

function runWith(
  argv,
  { pullRequests = {}, git: gitOptions, renderError = null } = {},
) {
  const { gh, calls: ghCalls } = fakeGh(pullRequests);
  const { render, calls: renderCalls } = fakeRender(renderError);
  const { git, calls: gitCalls } = fakeGit(gitOptions);
  const out = [];
  const err = [];
  const code = run(argv, {
    gh,
    git,
    render,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    ghCalls,
    gitCalls,
    renderCalls,
  };
}

describe("patch-notes › bodies", () => {
  it("builds the template body from the pull request template as it is today", () => {
    expect(BODIES.template).toBe(TEMPLATE);
  });

  it("throws naming the record script when a text has no recorded render", () => {
    expect(() => recordedRender("- never recorded")).toThrow(
      "record them again with npm run pr:patch-notes:record.",
    );
  });
});

describe("patch-notes › patchNotesFrom", () => {
  it("returns both blocks of a filled template without problems", () => {
    expect(notesOf("filled")).toEqual({ notes: BOTH_NOTES, problems: [] });
  });

  it("reports both blocks as still the placeholder in the untouched template", () => {
    expect(notesOf("template")).toEqual({
      notes: { english: null, portuguese: null },
      problems: [
        "the 🇺🇸 English block is still the template placeholder",
        "the 🇧🇷 Português block is still the template placeholder",
      ],
    });
  });

  it("reports the missing Portuguese block and keeps the English one", () => {
    expect(notesOf("englishOnly")).toEqual({
      notes: { english: ENGLISH_NOTES, portuguese: null },
      problems: ["the 🇧🇷 Português block is missing"],
    });
  });

  it("reports an empty English block apart from the placeholder", () => {
    expect(notesOf("emptyEnglish")).toEqual({
      notes: { english: null, portuguese: PORTUGUESE_NOTES },
      problems: ["the 🇺🇸 English block is empty"],
    });
  });

  it.each([null, undefined, ""])(
    "reports both blocks missing without rendering when the body is %j",
    (body) => {
      const { render, calls } = fakeRender(null);

      expect(patchNotesFrom(body, render).problems).toEqual([
        "the 🇺🇸 English block is missing",
        "the 🇧🇷 Português block is missing",
      ]);
      expect(calls).toEqual([]);
    },
  );

  it("drops the placeholder left beside written notes", () => {
    expect(notesOf("placeholderBesideNotes").notes.english).toBe(ENGLISH_NOTES);
  });

  it("reads a body saved with CRLF line endings", () => {
    const { render, calls } = fakeRender(null);

    expect(
      patchNotesFrom(BODIES.filled.replaceAll("\n", "\r\n"), render),
    ).toEqual({ notes: BOTH_NOTES, problems: [] });
    expect(calls[0]).toBe(BODIES.filled);
  });

  it("reads an unclosed Portuguese block up to the end of the body", () => {
    expect(notesOf("unclosedPortugueseAtEnd")).toEqual({
      notes: BOTH_NOTES,
      problems: [],
    });
  });

  it.each(["wrappedSection", "openBeforeHeading", "openAfterHeading"])(
    "reports both blocks not shown when GitHub hides the section in the %s body",
    (name) => {
      expect(notesOf(name)).toEqual({
        notes: { english: null, portuguese: null },
        problems: NOT_SHOWN,
      });
    },
  );

  it("reports both blocks not shown when an example before the heading shows and the section does not", () => {
    expect(notesOf("earlierExampleHiddenSection")).toEqual({
      notes: { english: null, portuguese: null },
      problems: NOT_SHOWN,
    });
  });

  it("reports the English block empty and the Portuguese one not shown when the English comment stays open", () => {
    expect(notesOf("openLineInEnglish")).toEqual({
      notes: { english: null, portuguese: null },
      problems: ["the 🇺🇸 English block is empty", NOT_SHOWN[1]],
    });
  });

  it("keeps the notes when a comment opener in the middle of a line shows as text", () => {
    expect(notesOf("openMidLineInEnglish")).toEqual({
      notes: {
        english: "- Fixed a bug <!-- draft",
        portuguese: PORTUGUESE_NOTES,
      },
      problems: [],
    });
  });

  it.each(["codeSpanBefore", "fencedBefore", "summaryQuotesHeading"])(
    "keeps the notes when the %s body shows a comment opener as code",
    (name) => {
      expect(notesOf(name)).toEqual({ notes: BOTH_NOTES, problems: [] });
    },
  );

  it("finds the heading line with trailing spaces", () => {
    expect(notesOf("headingTrailingSpaces")).toEqual({
      notes: BOTH_NOTES,
      problems: [],
    });
  });

  it("reads the real section after a template example quoted in a fence", () => {
    expect(notesOf("fencedTemplateBeforeRealSection")).toEqual({
      notes: { english: "- real note", portuguese: "- nota real" },
      problems: [],
    });
  });

  it("keeps the English notes after a closed comment that holds a details end tag", () => {
    expect(notesOf("closedCommentWithDetailsEnd")).toEqual({
      notes: BOTH_NOTES,
      problems: [],
    });
  });

  it("drops every closed comment of a line and keeps the text between them", () => {
    expect(notesOf("closedCommentsInLine").notes.english).toBe("ace");
  });

  it("drops a closed comment between two English paragraphs that GitHub renders apart", () => {
    expect(notesOf("commentBetweenParagraphs")).toEqual({
      notes: {
        english: "First paragraph.\n\n\n\nSecond paragraph.",
        portuguese: PORTUGUESE_NOTES,
      },
      problems: [],
    });
  });

  it("keeps a comment written inside a code span as GitHub shows it", () => {
    expect(notesOf("codeSpanComment")).toEqual({
      notes: {
        english: "- The placeholder `<!-- notes -->` is gone.",
        portuguese: PORTUGUESE_NOTES,
      },
      problems: [],
    });
  });

  it("keeps the code span opener and the notes after it, which a later comment closes", () => {
    expect(notesOf("codeSpanOpenerThenComment")).toEqual({
      notes: {
        english:
          "- Fixed the `<!--` parsing.\n- Buttons answer faster. <!-- todo -->",
        portuguese: PORTUGUESE_NOTES,
      },
      problems: [],
    });
  });

  it("keeps both blocks when code spans open and close a comment around them", () => {
    expect(notesOf("codeSpansAroundBlocks")).toEqual({
      notes: {
        english: ENGLISH_NOTES,
        portuguese: "- The arrow `-->` closes it.",
      },
      problems: [],
    });
  });

  it("reads both English bullets past a details end tag written in a code span", () => {
    expect(notesOf("codeSpanDetailsEnd").notes.english).toBe(
      "- Fixed the `</details>` tag.\n- Buttons answer faster.",
    );
  });

  it("reads the whole English block with the details nested in it", () => {
    expect(notesOf("nestedDetails")).toEqual({
      notes: {
        english:
          "- Buttons answer faster.\n\n<details><summary>More 1</summary>\n\nInner 1.\n\n</details>\n\n- Voice works offline.",
        portuguese: PORTUGUESE_NOTES,
      },
      problems: [],
    });
  });

  it("reads the English block that ends at its fifth details end tag", () => {
    expect(notesOf("fourNestedDetails").notes.english).toMatch(
      /^- Buttons answer faster\.\n\n[\s\S]*Inner 4\.\n\n<\/details>\n\n- Voice works offline\.$/,
    );
  });

  it("drops the end tag of trailing nested details, which GitHub closes in the same way", () => {
    expect(notesOf("trailingNestedDetails").notes.english).toBe(
      "- Buttons answer faster.\n\n<details><summary>More 1</summary>\n\nInner 1.",
    );
  });

  it("reports the English block unreadable when it ends past its fifth details end tag", () => {
    expect(notesOf("fiveNestedDetails")).toEqual({
      notes: { english: null, portuguese: PORTUGUESE_NOTES },
      problems: ["the 🇺🇸 English block could not be read as GitHub shows it"],
    });
  });

  it("reports the English block unreadable when its reference link is defined after the blocks", () => {
    expect(notesOf("referenceLinkAfterBlocks")).toEqual({
      notes: { english: null, portuguese: PORTUGUESE_NOTES },
      problems: ["the 🇺🇸 English block could not be read as GitHub shows it"],
    });
  });

  it.each(["nbspOnly", "zeroWidthOnly"])(
    "reports the English block of the %s body empty",
    (name) => {
      expect(notesOf(name)).toEqual({
        notes: { english: null, portuguese: PORTUGUESE_NOTES },
        problems: ["the 🇺🇸 English block is empty"],
      });
    },
  );

  it("passes an English block that holds only an image", () => {
    expect(notesOf("imageOnly")).toEqual({
      notes: {
        english: "![screenshot](https://example.com/a.png)",
        portuguese: PORTUGUESE_NOTES,
      },
      problems: [],
    });
  });

  it("passes an English block written as open details", () => {
    expect(notesOf("detailsOpen")).toEqual({
      notes: { english: "- note", portuguese: PORTUGUESE_NOTES },
      problems: [],
    });
  });

  it("reports the English placeholder left without its details end tag", () => {
    expect(notesOf("englishPlaceholderUnclosed")).toEqual({
      notes: { english: null, portuguese: PORTUGUESE_NOTES },
      problems: ["the 🇺🇸 English block is still the template placeholder"],
    });
  });

  it("reads the English notes up to the Portuguese block when their details end tag is missing", () => {
    expect(notesOf("englishNotesUnclosed")).toEqual({
      notes: BOTH_NOTES,
      problems: [],
    });
  });

  it("reads both blocks when GitHub shows a Portuguese summary without its details tag inside the English block", () => {
    expect(notesOf("orphanPortugueseSummary")).toEqual({
      notes: BOTH_NOTES,
      problems: [],
    });
  });

  it("reads as empty a hand-built rendered block whose tag never closes, which GitHub never returns", () => {
    const filledHtml = recordedRender(BODIES.filled);
    const broken = [
      "<h2>Patch notes / Notas da versão</h2>",
      '<details><summary>🇺🇸 English</summary>\n<p class="x\n</details>',
      filledHtml.slice(filledHtml.indexOf("<details><summary>🇧🇷")),
    ].join("\n");
    const render = (text) => (text === BODIES.filled ? broken : RENDERS[text]);

    expect(patchNotesFrom(BODIES.filled, render)).toEqual({
      notes: { english: null, portuguese: PORTUGUESE_NOTES },
      problems: ["the 🇺🇸 English block is empty"],
    });
  });

  it("reads a hand-built rendered block without its details end tag, which GitHub never returns, to the end", () => {
    const filledHtml = recordedRender(BODIES.filled);
    const unclosed = filledHtml.slice(0, filledHtml.lastIndexOf("</details>"));
    const render = (text) =>
      text === BODIES.filled ? unclosed : RENDERS[text];

    expect(patchNotesFrom(BODIES.filled, render)).toEqual({
      notes: BOTH_NOTES,
      problems: [],
    });
  });
});

describe("patch-notes › markdownRenderer", () => {
  it("posts the text in gfm mode to the Markdown API through gh with a 16 MiB buffer", () => {
    const calls = [];
    const render = markdownRenderer((...args) => {
      calls.push(args);
      return "<p>rendered</p>";
    });

    expect(render("- a *b*")).toBe("<p>rendered</p>");
    expect(calls).toEqual([
      [
        "gh",
        ["api", "-X", "POST", "markdown", "--input", "-"],
        {
          input: '{"text":"- a *b*","mode":"gfm"}',
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        },
      ],
    ]);
  });

  it("lets the gh error through", () => {
    const render = markdownRenderer(() => {
      throw new Error("spawnSync gh ENOBUFS");
    });

    expect(() => render("- a")).toThrow("spawnSync gh ENOBUFS");
  });
});

describe("patch-notes › check", () => {
  it("passes a pull request with both blocks, rendering the body and then each block", () => {
    const { code, out, ghCalls, renderCalls } = runWith(["check", "12"], {
      pullRequests: {
        12: { body: BODIES.filled, headRefName: "0012-faster-buttons" },
      },
    });

    expect(code).toBe(0);
    expect(out).toBe(
      "✓ Pull request #12 carries the patch notes in English and in Portuguese.",
    );
    expect(ghCalls).toEqual([
      ["pr", "view", "12", "--json", "body,headRefName"],
    ]);
    expect(renderCalls).toEqual([
      BODIES.filled,
      ENGLISH_NOTES,
      PORTUGUESE_NOTES,
    ]);
  });

  it("fails naming every block that is missing, empty or still the placeholder", () => {
    const { code, err, renderCalls } = runWith(["check", "12"], {
      pullRequests: { 12: { body: TEMPLATE, headRefName: "0012-x" } },
    });

    expect(code).toBe(1);
    expect(err).toBe(
      [
        "✗ Pull request #12 has no complete patch notes in the description: the 🇺🇸 English block is still the template placeholder; the 🇧🇷 Português block is still the template placeholder.",
        '  Fill both blocks under "## Patch notes / Notas da versão" of .github/pull_request_template.md with only what whoever installs the plugin notices, in the /release-notes format.',
      ].join("\n"),
    );
    expect(renderCalls).toEqual([TEMPLATE]);
  });

  it("fails a block that could not be read as GitHub shows it", () => {
    const { code, err } = runWith(["check", "12"], {
      pullRequests: {
        12: { body: BODIES.referenceLinkAfterBlocks, headRefName: "0012-x" },
      },
    });

    expect(code).toBe(1);
    expect(err).toContain(
      "description: the 🇺🇸 English block could not be read as GitHub shows it.",
    );
  });

  it("fails a pull request whose body is null without rendering it", () => {
    const { code, err, renderCalls } = runWith(["check", "7"], {
      pullRequests: { 7: { body: null, headRefName: "0007-x" } },
    });

    expect(code).toBe(1);
    expect(err).toContain(
      "the 🇺🇸 English block is missing; the 🇧🇷 Português block is missing.",
    );
    expect(renderCalls).toEqual([]);
  });

  it.each([
    "dependabot/npm_and_yarn/vitest-5.0.1",
    "release/v0.2.0",
    "revert/0004-split-the-ci",
  ])("exempts the pull request from %s, which carries no notes", (head) => {
    const { code, out } = runWith(["check", "12"], {
      pullRequests: { 12: { body: "", headRefName: head } },
    });

    expect(code).toBe(0);
    expect(out).toBe(
      `✓ Pull request #12 comes from ${head}, which carries no patch notes.`,
    );
  });

  it.each(["0012-revert-the-buttons", "release-v0.2.0", "my-dependabot/x"])(
    "checks the notes of the branch %s, which only looks exempt",
    (head) => {
      const { code } = runWith(["check", "12"], {
        pullRequests: { 12: { body: "", headRefName: head } },
      });

      expect(code).toBe(1);
    },
  );

  it("checks the notes when gh returns no head branch", () => {
    const { code } = runWith(["check", "12"], {
      pullRequests: { 12: { body: BODIES.filled } },
    });

    expect(code).toBe(0);
  });

  it("sends the body with LF line endings to the render", () => {
    const { renderCalls } = runWith(["check", "12"], {
      pullRequests: {
        12: {
          body: BODIES.filled.replaceAll("\n", "\r\n"),
          headRefName: "0012-x",
        },
      },
    });

    expect(renderCalls[0]).toBe(BODIES.filled);
  });

  it("fails with the gh error when the pull request cannot be read", () => {
    const { code, err } = runWith(["check", "99"], {
      pullRequests: {
        99: new Error("GraphQL: Could not resolve to a PullRequest"),
      },
    });

    expect(code).toBe(1);
    expect(err).toBe("✗ GraphQL: Could not resolve to a PullRequest");
  });

  it("fails with the gh error when the description cannot be rendered", () => {
    const { code, err } = runWith(["check", "12"], {
      pullRequests: {
        12: { body: BODIES.filled, headRefName: "0012-x" },
      },
      renderError: new Error("HTTP 403: API rate limit exceeded"),
    });

    expect(code).toBe(1);
    expect(err).toBe("✗ HTTP 403: API rate limit exceeded");
  });

  it.each([[[]], [["12a"]], [["#12"]], [["0"]], [["12", "13"]]])(
    "prints the usage without calling gh for the arguments %j",
    (args) => {
      const { code, err, ghCalls } = runWith(["check", ...args]);

      expect(code).toBe(1);
      expect(err).toContain(
        "npm run pr:patch-notes -- check <pull request number>",
      );
      expect(ghCalls).toEqual([]);
    },
  );
});

describe("patch-notes › collect", () => {
  const LOG = [
    mergeRecord(4, "0004: split the ci"),
    mergeRecord(2, "0002: base"),
  ].join("\n");

  it("prints the notes of each pull request merged since the last tag, oldest first", () => {
    const { code, out, gitCalls, ghCalls, renderCalls } = runWith(["collect"], {
      git: { log: LOG },
      pullRequests: {
        2: { body: BODIES.collectFirst, headRefName: "0002-base" },
        4: { body: BODIES.collectSecond, headRefName: "0004-ci" },
      },
    });

    expect(code).toBe(0);
    expect(gitCalls).toEqual([
      ["describe", "--tags", "--abbrev=0"],
      [
        "log",
        "--first-parent",
        "--merges",
        "--format=%H%x1f%P%x1f%s%x1f%b%x1e",
        "v0.1.0..HEAD",
      ],
    ]);
    expect(ghCalls).toEqual([
      ["pr", "view", "2", "--json", "body,headRefName"],
      ["pr", "view", "4", "--json", "body,headRefName"],
    ]);
    expect(renderCalls).toEqual([
      BODIES.collectFirst,
      "- ✨ one",
      "- ✨ um",
      BODIES.collectSecond,
      "- 🐛 two",
      "- 🐛 dois",
    ]);
    expect(out).toBe(
      [
        "### #2 - 0002: base",
        "",
        "#### 🇺🇸 English",
        "",
        "- ✨ one",
        "",
        "#### 🇧🇷 Português",
        "",
        "- ✨ um",
        "",
        "### #4 - 0004: split the ci",
        "",
        "#### 🇺🇸 English",
        "",
        "- 🐛 two",
        "",
        "#### 🇧🇷 Português",
        "",
        "- 🐛 dois",
        "",
        "✓ 2 pull requests merged since v0.1.0, none without patch notes.",
      ].join("\n"),
    );
  });

  it("starts from the tag given instead of the last one", () => {
    const { gitCalls } = runWith(["collect", "v0.0.9"], { git: { log: "" } });

    expect(gitCalls).toEqual([
      [
        "log",
        "--first-parent",
        "--merges",
        "--format=%H%x1f%P%x1f%s%x1f%b%x1e",
        "v0.0.9..HEAD",
      ],
    ]);
  });

  it("reads the whole history when the repository has no tag", () => {
    const { code, out, gitCalls } = runWith(["collect"], {
      git: { tag: null, log: mergeRecord(2, "0002: base") },
      pullRequests: {
        2: { body: BODIES.filled, headRefName: "0002-base" },
      },
    });

    expect(code).toBe(0);
    expect(gitCalls.at(-1).at(-1)).toBe("HEAD");
    expect(out).toContain(
      "✓ 1 pull request merged in the whole history, none without patch notes.",
    );
  });

  it("says so when no pull request was merged since the tag", () => {
    const { code, out, ghCalls } = runWith(["collect"], { git: { log: "" } });

    expect(code).toBe(0);
    expect(out).toBe("No pull request merged on main since v0.1.0.");
    expect(ghCalls).toEqual([]);
  });

  it("lists a pull request without notes, with its problems, and keeps the others", () => {
    const { code, out } = runWith(["collect"], {
      git: { log: LOG },
      pullRequests: {
        2: { body: BODIES.collectEnglishOnly, headRefName: "0002-base" },
        4: { body: BODIES.filled, headRefName: "0004-ci" },
      },
    });

    expect(code).toBe(0);
    expect(out).toContain(
      [
        "### #2 - 0002: base",
        "",
        "#### 🇺🇸 English",
        "",
        "- ✨ one",
        "",
        "#### 🇧🇷 Português",
        "",
        "✗ the 🇧🇷 Português block is missing",
      ].join("\n"),
    );
    expect(out).toContain(`### #4 - 0004: split the ci`);
    expect(out).toContain(ENGLISH_NOTES);
    expect(out.split("\n").at(-1)).toBe(
      "✗ 1 of 2 pull requests merged since v0.1.0 without complete patch notes: #2.",
    );
  });

  it("lists a pull request as incomplete when its English comment stays open, without printing the opener", () => {
    const { code, out } = runWith(["collect"], {
      git: { log: mergeRecord(2, "0002: base") },
      pullRequests: {
        2: { body: BODIES.openLineInEnglish, headRefName: "0002-base" },
      },
    });

    expect(code).toBe(0);
    expect(out).toContain("✗ the 🇺🇸 English block is empty");
    expect(out).toContain(`✗ ${NOT_SHOWN[1]}`);
    expect(out).not.toContain("<!--");
    expect(out.split("\n").at(-1)).toBe(
      "✗ 1 of 1 pull request merged since v0.1.0 without complete patch notes: #2.",
    );
  });

  it("prints the notes with the code span GitHub shows instead of cutting them at its comment opener", () => {
    const { out } = runWith(["collect"], {
      git: { log: mergeRecord(2, "0002: base") },
      pullRequests: {
        2: { body: BODIES.codeSpanComment, headRefName: "0002-base" },
      },
    });

    expect(out).toContain(
      "#### 🇺🇸 English\n\n- The placeholder `<!-- notes -->` is gone.\n",
    );
  });

  it("marks a pull request from an exempt branch without counting it as missing", () => {
    const { out, renderCalls } = runWith(["collect"], {
      git: { log: mergeRecord(5, "Bump vitest") },
      pullRequests: {
        5: { body: "", headRefName: "dependabot/npm_and_yarn/vitest-5.0.1" },
      },
    });

    expect(out).toBe(
      [
        "### #5 - Bump vitest",
        "",
        "Exempt: dependabot/npm_and_yarn/vitest-5.0.1 carries no patch notes.",
        "",
        "✓ 1 pull request merged since v0.1.0, none without patch notes.",
      ].join("\n"),
    );
    expect(renderCalls).toEqual([]);
  });

  it("fails with the gh error when a pull request cannot be read", () => {
    const { code, err } = runWith(["collect"], {
      git: { log: LOG },
      pullRequests: {
        2: new Error("HTTP 502"),
        4: { body: BODIES.filled, headRefName: "0004-ci" },
      },
    });

    expect(code).toBe(1);
    expect(err).toBe("✗ HTTP 502");
  });

  it("fails with the git error when the tag does not exist", () => {
    const { code, err } = runWith(["collect", "v9.9.9"], {
      git: { logError: new Error("fatal: bad revision 'v9.9.9..HEAD'") },
    });

    expect(code).toBe(1);
    expect(err).toBe("✗ fatal: bad revision 'v9.9.9..HEAD'");
  });

  it.each([[["v0.1.0", "v0.2.0"]], [["--since"]]])(
    "prints the usage without calling git for the arguments %j",
    (args) => {
      const { code, err, gitCalls } = runWith(["collect", ...args]);

      expect(code).toBe(1);
      expect(err).toContain("npm run release:patch-notes -- [<tag>]");
      expect(gitCalls).toEqual([]);
    },
  );
});

describe("patch-notes › commands", () => {
  it.each([[[]], [["notes"]]])(
    "prints the usage for the arguments %j",
    (argv) => {
      const { code, err } = runWith(argv);

      expect(code).toBe(1);
      expect(err).toBe(
        [
          "Usage: npm run pr:patch-notes -- check <pull request number>",
          "       npm run release:patch-notes -- [<tag>]",
        ].join("\n"),
      );
    },
  );

  it("runs the check and the collect through the package scripts", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));

    expect(scripts["pr:patch-notes"]).toBe("node scripts/patch-notes.mjs");
    expect(scripts["release:patch-notes"]).toBe(
      "node scripts/patch-notes.mjs collect",
    );
  });
});
