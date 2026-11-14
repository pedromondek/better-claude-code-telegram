import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import czConfig from "../../cz.config.mjs";
import { validateCommitMessage } from "../../.husky/lib/validate-commit-msg.mjs";
import {
  DRAFT_MARK,
  NOTES_END,
  NOTES_START,
  draftFromCliff,
  notesFrom,
  notesPath,
  notesProblem,
  prepareRelease,
  pullRequestBody,
  releaseBranch,
  run,
} from "../release-pr.mjs";
import { VERSION_FILES, readVersions, setVersion } from "../version.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const HEAD = "a".repeat(40);
const CLIFF = [
  "",
  "## 0.1.0-alpha.2",
  "",
  "### Features",
  "",
  "- **telegram:** Send the voice transcription back",
  "",
].join("\n");

let root;

function copyProject(version) {
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  setVersion(root, version);
}

function fakeGithub({ refs = [], failOn = null } = {}) {
  const calls = [];
  const fail = (step) => {
    if (failOn === step) {
      throw new Error(`${step} failed`);
    }
  };

  return {
    calls,
    refExists: (ref) => refs.includes(ref),
    createBranch: (name, sha) => {
      calls.push(["createBranch", name, sha]);
      fail("createBranch");
    },
    deleteBranch: (name) => {
      calls.push(["deleteBranch", name]);
    },
    commitFiles: (commit) => {
      calls.push(["commitFiles", commit]);
      fail("commitFiles");
    },
    openPullRequest: (pullRequest) => {
      calls.push(["openPullRequest", pullRequest]);
      fail("openPullRequest");

      return "https://github.com/owner/repo/pull/7";
    },
  };
}

function sources(versions = [], warnings = []) {
  return () => ({ versions, warnings });
}

function prepare(target, github, { released = sources() } = {}) {
  const asked = [];

  const result = prepareRelease({
    target,
    root,
    head: () => HEAD,
    bumped: () => {
      asked.push("bumped");

      return "0.2.0";
    },
    notes: (tag) => {
      asked.push(`notes ${tag}`);

      return CLIFF;
    },
    released,
    github,
  });

  return { result, asked };
}

function notesBody(notes) {
  return `${NOTES_START}\n${notes}\n${NOTES_END}\n\nText outside the notes.`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-release-pr-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("releaseBranch", () => {
  it("is release/v<version>, the branch the hooks and the title check let through", () => {
    expect(releaseBranch("0.1.0-alpha.1")).toBe("release/v0.1.0-alpha.1");
  });
});

describe("notesPath", () => {
  it.each([
    ["0.1.0-alpha.2", "docs/releases/0.1.0/alpha.2.md"],
    ["0.1.0-rc.1", "docs/releases/0.1.0/rc.1.md"],
    ["1.2.3", "docs/releases/1.2.3/stable.md"],
  ])("keeps the notes of %s in %s", (version, path) => {
    expect(notesPath(version)).toBe(path);
  });

  it("refuses an invalid version", () => {
    expect(() => notesPath("0.1")).toThrow("invalid version: 0.1");
  });
});

describe("draftFromCliff", () => {
  it("drops the version heading, which the Release carries as its name, and the blank lines around", () => {
    expect(draftFromCliff(CLIFF)).toBe(
      "### Features\n\n- **telegram:** Send the voice transcription back",
    );
  });

  it("is empty when git-cliff has nothing but the heading", () => {
    expect(draftFromCliff("\n## 0.1.0-alpha.2\n\n")).toBe("");
  });

  it("keeps a text without the heading as it is, trimmed", () => {
    expect(draftFromCliff("\n### Bug fixes\n- x\n")).toBe("### Bug fixes\n- x");
  });
});

describe("pullRequestBody", () => {
  const body = pullRequestBody("0.1.0-alpha.2", "### Features\n- x");

  it("opens with the draft between the notes markers, marked as a draft", () => {
    expect(
      body.startsWith(
        `${NOTES_START}\n${DRAFT_MARK}\n### Features\n- x\n${NOTES_END}\n`,
      ),
    ).toBe(true);
  });

  it("explains outside the markers how the draft becomes the notes and where they go on merge", () => {
    const outside = body.slice(body.indexOf(NOTES_END) + NOTES_END.length);

    expect(outside).toContain("/release-notes");
    expect(outside).toContain(DRAFT_MARK);
    expect(outside).toContain("Release notes");
    expect(outside).toContain("v0.1.0-alpha.2");
    expect(outside).toContain("docs/releases/0.1.0/alpha.2.md");
  });

  it("keeps the draft mark when git-cliff found nothing, so the check still asks for the notes", () => {
    expect(notesFrom(pullRequestBody("0.1.0-alpha.2", ""))).toBe(DRAFT_MARK);
  });
});

describe("notesFrom", () => {
  it("reads only the text between the markers, trimmed", () => {
    expect(notesFrom(notesBody("\n### 📋 Summary\n- x\n"))).toBe(
      "### 📋 Summary\n- x",
    );
  });

  it("reads a description edited on GitHub, which saves the lines with CRLF", () => {
    expect(
      notesFrom(`${NOTES_START}\r\n### 📋 Summary\r\n- x\r\n${NOTES_END}\r\n`),
    ).toBe("### 📋 Summary\n- x");
  });

  it.each([
    ["without the start marker", `### 📋 Summary\n${NOTES_END}`],
    ["without the end marker", `${NOTES_START}\n### 📋 Summary`],
    ["with the markers swapped", `${NOTES_END}\nx\n${NOTES_START}`],
    [
      "with a marker twice",
      `${NOTES_START}\nx\n${NOTES_END}\n${NOTES_START}\ny\n${NOTES_END}`,
    ],
    ["empty", ""],
    ["missing", null],
  ])("refuses a description %s", (_case, body) => {
    expect(() => notesFrom(body)).toThrow(
      `the description needs the notes between one ${NOTES_START} and one ${NOTES_END}`,
    );
  });
});

describe("notesProblem", () => {
  it("lets written notes through", () => {
    expect(notesProblem(notesBody("### 📋 Summary\n- x"))).toBeNull();
  });

  it("stops the git-cliff draft while its mark is there", () => {
    expect(
      notesProblem(pullRequestBody("0.1.0-alpha.2", "### Features\n- x")),
    ).toBe(
      `the notes are still the git-cliff draft: write them with /release-notes, or edit the description and delete the ${DRAFT_MARK} line`,
    );
  });

  it("stops empty notes", () => {
    expect(notesProblem(notesBody("  \n "))).toBe(
      "the notes are empty: write them with /release-notes",
    );
  });

  it("stops a description without the markers", () => {
    expect(notesProblem("### 📋 Summary")).toBe(
      `the description needs the notes between one ${NOTES_START} and one ${NOTES_END}`,
    );
  });
});

describe("prepareRelease", () => {
  it("moves the stage, opens the branch on the checked-out commit, commits the version files and opens the pull request with the draft", () => {
    copyProject("0.1.0-alpha.1");
    const github = fakeGithub();

    const { result, asked } = prepare("alpha", github);

    expect(result).toEqual({
      version: "0.1.0-alpha.2",
      branch: "release/v0.1.0-alpha.2",
      url: "https://github.com/owner/repo/pull/7",
      warnings: [],
    });
    expect(asked).toEqual(["notes v0.1.0-alpha.2"]);
    expect(readVersions(root).map(({ version }) => version)).toEqual(
      readVersions(root).map(() => "0.1.0-alpha.2"),
    );
    expect(github.calls.map(([name]) => name)).toEqual([
      "createBranch",
      "commitFiles",
      "openPullRequest",
    ]);
    expect(github.calls[0]).toEqual([
      "createBranch",
      "release/v0.1.0-alpha.2",
      HEAD,
    ]);

    const [, commit] = github.calls[1];

    expect(commit).toMatchObject({
      branch: "release/v0.1.0-alpha.2",
      expectedHead: HEAD,
      headline: "📦 build(root): release v0.1.0-alpha.2",
    });
    expect(commit.files.map(({ path }) => path)).toEqual(VERSION_FILES);
    for (const { path, contents } of commit.files) {
      expect({
        path,
        text: Buffer.from(contents, "base64").toString("utf8"),
      }).toEqual({
        path,
        text: readFileSync(join(root, path), "utf8"),
      });
    }

    expect(github.calls[2][1]).toEqual({
      base: "main",
      head: "release/v0.1.0-alpha.2",
      title: "Release v0.1.0-alpha.2",
      body: pullRequestBody("0.1.0-alpha.2", draftFromCliff(CLIFF)),
    });
  });

  it("writes a commit message the commit-msg hook accepts", () => {
    copyProject("0.1.0-alpha.1");
    const github = fakeGithub();

    prepare("alpha", github);

    const [, { headline, body }] = github.calls[1];

    expect(validateCommitMessage(`${headline}\n\n${body}\n`, czConfig)).toEqual(
      [],
    );
  });

  it("asks git-cliff for the bump from a stable version", () => {
    copyProject("0.1.0");
    const github = fakeGithub();

    const { result, asked } = prepare("alpha", github, {
      released: sources(["0.1.0"]),
    });

    expect(result.version).toBe("0.2.0-alpha.1");
    expect(asked).toEqual(["bumped", "notes v0.2.0-alpha.1"]);
  });

  it("takes an exact version instead of a stage, for the first release or a jump the stage does not give", () => {
    copyProject("0.1.0");
    const github = fakeGithub();

    const { result, asked } = prepare("0.1.0-alpha.1", github);

    expect(result.version).toBe("0.1.0-alpha.1");
    expect(asked).toEqual(["notes v0.1.0-alpha.1"]);
  });

  it("hands back the warnings of the sources that disagree", () => {
    copyProject("0.1.0-alpha.1");

    const { result } = prepare("alpha", fakeGithub(), {
      released: sources(["0.1.0-alpha.1"], ["v0.1.0-alpha.1 is in npm"]),
    });

    expect(result.warnings).toEqual(["v0.1.0-alpha.1 is in npm"]);
  });

  it.each([
    [
      "the version already came out",
      "alpha",
      ["0.1.0-alpha.2"],
      "v0.1.0-alpha.2 already exists",
    ],
    [
      "the exact version skips one",
      "0.3.0",
      ["0.1.0"],
      "v0.3.0 skips a version: the next one has the base 0.1.1, 0.2.0, 1.0.0",
    ],
    [
      "the exact version comes before one released",
      "0.1.0-alpha.1",
      ["0.1.0"],
      "v0.1.0-alpha.1 does not come after v0.1.0, the highest version released",
    ],
  ])("refuses when %s, writing nothing", (_case, target, released, message) => {
    copyProject("0.1.0-alpha.1");
    const github = fakeGithub();

    expect(() =>
      prepare(target, github, { released: sources(released) }),
    ).toThrow(message);
    expect(github.calls).toEqual([]);
    expect(readVersions(root)[0].version).toBe("0.1.0-alpha.1");
  });

  it("refuses when the branch of the version exists, writing nothing", () => {
    copyProject("0.1.0-alpha.1");
    const github = fakeGithub({ refs: ["heads/release/v0.1.0-alpha.2"] });

    expect(() => prepare("alpha", github)).toThrow(
      "the branch release/v0.1.0-alpha.2 already exists: the version pull request opens once, so write its notes with /release-notes, or close it and delete the branch to prepare it again",
    );
    expect(github.calls).toEqual([]);
    expect(readVersions(root)[0].version).toBe("0.1.0-alpha.1");
  });

  it("refuses version files that disagree, before asking anything", () => {
    copyProject("0.1.0-alpha.1");
    const plugin = join(root, "plugins/bcct/.claude-plugin/plugin.json");
    writeFileSync(
      plugin,
      readFileSync(plugin, "utf8").replace(
        /"version": "[^"]+"/,
        '"version": "9.9.9"',
      ),
    );
    const github = fakeGithub();

    expect(() => prepare("alpha", github)).toThrow(
      "the version files disagree: npm run release:version -- check names them",
    );
    expect(github.calls).toEqual([]);
  });

  it.each(["commitFiles", "openPullRequest"])(
    "deletes the branch it opened when %s fails, so the next run can prepare again",
    (step) => {
      copyProject("0.1.0-alpha.1");
      const github = fakeGithub({ failOn: step });

      expect(() => prepare("alpha", github)).toThrow(`${step} failed`);
      expect(github.calls.at(-1)).toEqual([
        "deleteBranch",
        "release/v0.1.0-alpha.2",
      ]);
    },
  );

  it("leaves nothing to delete when the branch itself was not created", () => {
    copyProject("0.1.0-alpha.1");
    const github = fakeGithub({ failOn: "createBranch" });

    expect(() => prepare("alpha", github)).toThrow("createBranch failed");
    expect(github.calls.map(([name]) => name)).toEqual(["createBranch"]);
  });

  it("refuses an unknown stage", () => {
    copyProject("0.1.0-alpha.1");

    expect(() => prepare("gamma", fakeGithub())).toThrow(
      "unknown stage: gamma (use alpha, beta, rc or stable)",
    );
  });
});

describe("run", () => {
  function runWith(
    args,
    { env = {}, github = fakeGithub(), released = sources() } = {},
  ) {
    const out = [];
    const err = [];
    const code = run(args, {
      root,
      env,
      head: () => HEAD,
      bumped: () => "0.2.0",
      notes: () => CLIFF,
      released,
      github,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });

    return { code, out, err };
  }

  function outputFiles() {
    const files = {
      GITHUB_OUTPUT: join(root, "output"),
      GITHUB_STEP_SUMMARY: join(root, "summary"),
    };

    writeFileSync(files.GITHUB_OUTPUT, "");
    writeFileSync(files.GITHUB_STEP_SUMMARY, "");

    return {
      env: files,
      output: () => readFileSync(files.GITHUB_OUTPUT, "utf8"),
      summary: () => readFileSync(files.GITHUB_STEP_SUMMARY, "utf8"),
    };
  }

  it("prepare prints the warnings, the version and the pull request", () => {
    copyProject("0.1.0-alpha.1");

    expect(
      runWith(["prepare", "alpha"], {
        released: sources(["0.1.0-alpha.1"], ["v0.1.0-alpha.1 is in npm"]),
      }),
    ).toEqual({
      code: 0,
      out: [
        "⚠ v0.1.0-alpha.1 is in npm",
        "✓ v0.1.0-alpha.2 prepared in release/v0.1.0-alpha.2: https://github.com/owner/repo/pull/7",
      ],
      err: [],
    });
  });

  it("prepare exits 1 with the reason", () => {
    copyProject("0.1.0-alpha.1");

    expect(
      runWith(["prepare", "alpha"], {
        released: sources(["0.1.0-alpha.2"]),
      }),
    ).toEqual({
      code: 1,
      out: [],
      err: ["✗ v0.1.0-alpha.2 already exists"],
    });
  });

  it.each([
    [
      "a minor that opens its base waits for approval",
      "0.1.0",
      "alpha",
      ["0.1.0"],
      { version: "0.2.0-alpha.1", bump: "minor", approval: "true" },
      "v0.1.0",
      "waits for your approval in Review deployments",
    ],
    [
      "a pre-release inside an open line goes straight on",
      "0.2.0-alpha.1",
      "beta",
      ["0.1.0", "0.2.0-alpha.1"],
      { version: "0.2.0-beta.1", bump: "minor", approval: "false" },
      "v0.2.0-alpha.1",
      "opens the pull request without approval",
    ],
    [
      "the first version waits for approval",
      "0.1.0",
      "0.1.0-alpha.1",
      [],
      { version: "0.1.0-alpha.1", bump: "minor", approval: "true" },
      "nothing released",
      "waits for your approval in Review deployments",
    ],
  ])(
    "plan writes the version, the bump and the approval for the next jobs: %s",
    (_case, current, target, released, values, from, next) => {
      copyProject(current);
      const files = outputFiles();

      expect(
        runWith(["plan", target], {
          env: files.env,
          released: sources(released),
        }),
      ).toEqual({
        code: 0,
        out: [`✓ v${values.version} (${values.bump}, from ${from}) ${next}`],
        err: [],
      });
      expect(files.output()).toBe(
        `version=${values.version}\nbump=${values.bump}\napproval=${values.approval}\n`,
      );
      expect(files.summary()).toBe(
        [
          `### Release v${values.version}`,
          "",
          "| From | To | Bump | Next |",
          "| --- | --- | --- | --- |",
          `| ${from} | v${values.version} | ${values.bump} | ${next} |`,
          "",
          "",
        ].join("\n"),
      );
    },
  );

  it("plan lists the warnings in the output and in the summary", () => {
    copyProject("0.1.0");
    const files = outputFiles();

    const { out } = runWith(["plan", "alpha"], {
      env: files.env,
      released: sources(["0.1.0"], ["v0.1.0 is in npm, but not in the tags"]),
    });

    expect(out[0]).toBe("⚠ v0.1.0 is in npm, but not in the tags");
    expect(files.summary()).toContain(
      "> ⚠ v0.1.0 is in npm, but not in the tags\n",
    );
  });

  it("plan exits 1 with the reason and writes nothing for the next jobs", () => {
    copyProject("0.1.0");
    const files = outputFiles();

    expect(
      runWith(["plan", "0.3.0"], {
        env: files.env,
        released: sources(["0.1.0"]),
      }),
    ).toEqual({
      code: 1,
      out: [],
      err: [
        "✗ v0.3.0 skips a version: the next one has the base 0.1.1, 0.2.0, 1.0.0",
      ],
    });
    expect(files.output()).toBe("");
    expect(files.summary()).toBe("");
  });

  it("plan only prints outside GitHub Actions, where the two files do not exist", () => {
    copyProject("0.1.0");

    expect(
      runWith(["plan", "alpha"], { released: sources(["0.1.0"]) }).code,
    ).toBe(0);
  });

  it("check-version passes a version branch whose files carry its version, still free and in order", () => {
    copyProject("0.1.0-alpha.2");

    expect(
      runWith(["check-version"], {
        env: { PR_BRANCH: "release/v0.1.0-alpha.2" },
        released: sources(["0.1.0-alpha.1"]),
      }),
    ).toEqual({
      code: 0,
      out: ["✓ v0.1.0-alpha.2 is free and comes in order"],
      err: [],
    });
  });

  it.each([
    [
      "the files carry another version",
      "0.1.0-alpha.1",
      "release/v0.1.0-alpha.2",
      [],
      "the version files are on 0.1.0-alpha.1, not on 0.1.0-alpha.2 of the branch release/v0.1.0-alpha.2",
    ],
    [
      "the version came out meanwhile",
      "0.1.0-alpha.2",
      "release/v0.1.0-alpha.2",
      ["0.1.0-alpha.2"],
      "v0.1.0-alpha.2 already exists",
    ],
    [
      "the branch is not a version branch",
      "0.1.0-alpha.2",
      "0042-x",
      [],
      "0042-x is not a version branch (release/v<version>)",
    ],
  ])(
    "check-version exits 1 when %s",
    (_case, current, branch, released, problem) => {
      copyProject(current);

      expect(
        runWith(["check-version"], {
          env: { PR_BRANCH: branch },
          released: sources(released),
        }),
      ).toEqual({ code: 1, out: [], err: [`✗ ${problem}`] });
    },
  );

  it("check-notes reads the description from PR_BODY and exits 0 on written notes", () => {
    expect(
      runWith(["check-notes"], {
        env: { PR_BODY: notesBody("### 📋 Summary") },
      }),
    ).toEqual({ code: 0, out: ["✓ the release notes are written"], err: [] });
  });

  it("check-notes exits 1 with the problem", () => {
    expect(runWith(["check-notes"], { env: { PR_BODY: "" } })).toEqual({
      code: 1,
      out: [],
      err: [
        `✗ the description needs the notes between one ${NOTES_START} and one ${NOTES_END}`,
      ],
    });
  });

  it.each([
    [[]],
    [["prepare"]],
    [["plan"]],
    [["plan", "alpha", "x"]],
    [["check-version", "x"]],
    [["check-notes", "x"]],
    [["publish"]],
  ])("a usage error exits 2 with the usage (%j)", (args) => {
    expect(runWith(args)).toEqual({
      code: 2,
      out: [],
      err: [
        "usage: npm run release:pr -- plan|prepare <alpha|beta|rc|stable|version> | check-version (branch in PR_BRANCH) | check-notes (description in PR_BODY)",
      ],
    });
  });

  it("is the release:pr npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:pr"]).toBe("node scripts/release-pr.mjs");
  });
});
