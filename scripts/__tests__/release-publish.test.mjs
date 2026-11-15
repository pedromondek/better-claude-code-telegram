import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TARGETS } from "../release-binary.mjs";
import { CHECKSUMS_FILE } from "../release-order.mjs";
import { NOTES_END, NOTES_START, notesPath } from "../release-pr.mjs";
import { RELEASE_ASSETS, recordHeadline, run } from "../release-publish.mjs";
import { VERSION_FILES, setVersion } from "../version.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const VERSION = "0.2.0-beta.1";
const MERGE = "a".repeat(40);
const RECORD = "b".repeat(40);
const NOTES = "### 📋 Summary\n\nFaster buttons.";

let root;
let assets;

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function project(version = VERSION) {
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  setVersion(root, version);
  mkdirSync(assets, { recursive: true });
  for (const { asset } of TARGETS) {
    writeFileSync(join(assets, asset), `binary ${asset}`);
    writeFileSync(
      join(assets, `${asset}.sha256`),
      `${sha256(`binary ${asset}`)}  ${asset}\n`,
    );
  }
}

function recordedChecksums(version = VERSION) {
  return [
    "# version asset sha256",
    ...TARGETS.map(
      ({ asset }) => `${version} ${asset} ${sha256(`binary ${asset}`)}`,
    ),
    "",
  ].join("\n");
}

function pullRequest(overrides = {}) {
  return {
    number: 12,
    state: "MERGED",
    baseRefName: "main",
    headRefName: `release/v${VERSION}`,
    body: `${NOTES_START}\n${NOTES}\n${NOTES_END}\n\nVersion pull request.`,
    mergeCommit: { oid: MERGE },
    ...overrides,
  };
}

function fakeGithub(state = {}) {
  const calls = [];
  const github = {
    pullRequest: (number) => {
      calls.push(["pullRequest", number]);
      return state.pullRequest ?? pullRequest();
    },
    branchHead: () => state.head ?? MERGE,
    commit: (sha) =>
      state.commits?.[sha] ?? { parents: [], headline: "something else" },
    releaseByTag: (tag) => {
      calls.push(["releaseByTag", tag]);
      return state.release ?? null;
    },
    fileAt: (sha, path) => {
      calls.push(["fileAt", sha, path]);
      return state.checksumsAt ?? recordedChecksums();
    },
    commitFiles: (commit) => {
      calls.push(["commitFiles", commit]);
      return RECORD;
    },
    createDraft: (draft) => calls.push(["createDraft", draft]),
    editDraft: (draft) => calls.push(["editDraft", draft]),
    upload: (upload) => calls.push(["upload", upload]),
    publish: (published) => calls.push(["publish", published]),
    branchHeadIfAny: (branch) => {
      calls.push(["branchHeadIfAny", branch]);
      return state.stableHead === undefined ? MERGE : state.stableHead;
    },
    compare: (base, head) => {
      calls.push(["compare", base, head]);
      return state.compareStatus ?? "ahead";
    },
    createBranch: (branch, sha) => calls.push(["createBranch", branch, sha]),
    moveBranch: (branch, sha) => calls.push(["moveBranch", branch, sha]),
  };

  return { github, calls };
}

function runWith(args, { env = {}, state, released } = {}) {
  const { github, calls } = fakeGithub(state);
  const out = [];
  const err = [];
  const output = join(root, "github-output");
  const code = run(args, {
    root,
    env: { PR_NUMBER: "12", GITHUB_OUTPUT: output, ...env },
    github,
    released: () => released ?? { versions: ["0.1.0"], warnings: [] },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  return {
    code,
    out,
    err,
    calls,
    outputs: existsSync(output) ? readFileSync(output, "utf8") : "",
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bcct-release-publish-"));
  assets = join(root, "dist");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("plan", () => {
  it("takes the version, the merge commit and the stage from the merged version pull request, with main still at the merge", () => {
    project();

    const result = runWith(["plan"]);

    expect(result.code).toBe(0);
    expect(result.outputs).toBe(
      `number=12\nversion=${VERSION}\nmerge=${MERGE}\nrecorded=\nprerelease=true\n`,
    );
    expect(result.out).toEqual([
      `✓ v${VERSION} from #12, built at ${MERGE.slice(0, 7)}`,
    ]);
  });

  it("marks only a stable version as the latest release", () => {
    project("0.2.0");

    const result = runWith(["plan"], {
      state: {
        pullRequest: pullRequest({ headRefName: "release/v0.2.0" }),
      },
      released: { versions: ["0.2.0-rc.1"], warnings: [] },
    });

    expect(result.outputs).toContain("prerelease=false\n");
  });

  it("resumes after the commit of the checksums of this version, which main points to, though the record lists the version", () => {
    project();

    const result = runWith(["plan"], {
      state: {
        head: RECORD,
        commits: {
          [RECORD]: { parents: [MERGE], headline: recordHeadline(VERSION) },
        },
      },
      released: { versions: ["0.1.0", VERSION], warnings: [] },
    });

    expect(result.code).toBe(0);
    expect(result.outputs).toContain(`recorded=${RECORD}\n`);
    expect(result.out[0]).toContain("resuming after");
  });

  it("resumes on a draft Release of the version, whose tag may already exist", () => {
    project();

    const result = runWith(["plan"], {
      state: { release: { draft: true } },
      released: { versions: ["0.1.0", VERSION], warnings: [] },
    });

    expect(result.code).toBe(0);
  });

  it.each([
    [
      "a pull request that was not merged",
      { pullRequest: pullRequest({ state: "CLOSED", mergeCommit: null }) },
      "#12 was not merged",
    ],
    [
      "a pull request into another branch",
      { pullRequest: pullRequest({ baseRefName: "stable" }) },
      "#12 was merged into stable, not into main",
    ],
    [
      "a pull request that is not a version pull request",
      { pullRequest: pullRequest({ headRefName: "0042-feature" }) },
      "#12 comes from 0042-feature, not from a release/v<version> branch",
    ],
    [
      "a version that was already published",
      { release: { draft: false } },
      `v${VERSION} is already published`,
    ],
    [
      "main moved past the merge by something else",
      { head: "c".repeat(40) },
      `main moved past the merge ${MERGE.slice(0, 7)} of #12`,
    ],
  ])("refuses %s", (_case, state, message) => {
    project();

    const result = runWith(["plan"], { state });

    expect(result.code).toBe(1);
    expect(result.err[0]).toContain(message);
    expect(result.outputs).toBe("");
  });

  it("refuses notes that are still the draft, with the reason of the notes check", () => {
    project();

    const result = runWith(["plan"], {
      state: {
        pullRequest: pullRequest({
          body: `${NOTES_START}\n<!-- draft -->\nx\n${NOTES_END}`,
        }),
      },
    });

    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("still the git-cliff draft");
  });

  it("refuses a version out of order, as the version pull request does", () => {
    project();

    const result = runWith(["plan"], {
      released: { versions: ["0.3.0"], warnings: [] },
    });

    expect(result.code).toBe(1);
    expect(result.err[0]).toMatch(/^✗ /u);
  });

  it("refuses version files that are not on the version of the branch", () => {
    project("0.1.0");

    const result = runWith(["plan"]);

    expect(result.code).toBe(1);
    expect(result.err[0]).toContain("not on 0.2.0-beta.1");
  });
});

describe("record", () => {
  it("appends the checksums, writes the notes and commits both on main over the merge, through the API", () => {
    project();

    const result = runWith(["record", "dist"], {
      env: { MERGE, RECORDED: "", VERSION },
    });
    const [, commit] = result.calls.find(([name]) => name === "commitFiles");

    expect(result.code).toBe(0);
    expect(commit).toMatchObject({
      branch: "main",
      expectedHead: MERGE,
      headline: recordHeadline(VERSION),
    });
    expect(commit.files.map(({ path }) => path)).toEqual([
      CHECKSUMS_FILE,
      notesPath(VERSION),
    ]);
    expect(
      Buffer.from(commit.files[1].contents, "base64").toString("utf8"),
    ).toBe(`${NOTES}\n`);
    expect(readFileSync(join(root, CHECKSUMS_FILE), "utf8")).toBe(
      recordedChecksums(),
    );
    expect(result.outputs).toBe(`commit=${RECORD}\n`);
  });

  it("checks main again right before the commit and refuses when it moved", () => {
    project();

    const result = runWith(["record", "dist"], {
      env: { MERGE, RECORDED: "", VERSION },
      state: { head: "c".repeat(40) },
    });

    expect(result.code).toBe(1);
    expect(result.calls.some(([name]) => name === "commitFiles")).toBe(false);
  });

  it("skips the commit when the plan found it already made", () => {
    project();

    const result = runWith(["record", "dist"], {
      env: { MERGE, RECORDED: RECORD, VERSION },
    });

    expect(result.code).toBe(0);
    expect(result.calls.some(([name]) => name === "commitFiles")).toBe(false);
    expect(result.outputs).toBe(`commit=${RECORD}\n`);
  });
});

describe("release", () => {
  const env = { COMMIT: RECORD, VERSION, PRERELEASE: "true" };

  it("creates the draft at the recorded commit with every asset, then publishes it", () => {
    project();

    const result = runWith(["release", "dist"], { env });
    const names = result.calls.map(([name]) => name);
    const [, draft] = result.calls.find(([name]) => name === "createDraft");

    expect(result.code).toBe(0);
    expect(names.slice(-2)).toEqual(["createDraft", "publish"]);
    expect(draft).toMatchObject({
      tag: `v${VERSION}`,
      target: RECORD,
      title: `v${VERSION}`,
      prerelease: true,
    });
    expect(readFileSync(draft.notesFile, "utf8")).toBe(`${NOTES}\n`);
    expect(draft.files.map((file) => file.split("/").at(-1))).toEqual(
      RELEASE_ASSETS,
    );
    expect(result.calls.at(-1)).toEqual([
      "publish",
      { tag: `v${VERSION}`, latest: false },
    ]);
  });

  it("publishes a stable version as the latest release", () => {
    project("0.2.0");

    const result = runWith(["release", "dist"], {
      env: { COMMIT: RECORD, VERSION: "0.2.0", PRERELEASE: "false" },
      state: {
        pullRequest: pullRequest({ headRefName: "release/v0.2.0" }),
        checksumsAt: recordedChecksums("0.2.0"),
      },
    });

    expect(result.calls.at(-1)).toEqual([
      "publish",
      { tag: "v0.2.0", latest: true },
    ]);
  });

  it("reuses a draft of the version: fixes its target and notes and uploads the assets again", () => {
    project();

    const result = runWith(["release", "dist"], {
      env,
      state: { release: { draft: true } },
    });
    const names = result.calls.map(([name]) => name);

    expect(result.code).toBe(0);
    expect(names).toContain("editDraft");
    expect(names).toContain("upload");
    expect(names).not.toContain("createDraft");
    expect(names.at(-1)).toBe("publish");
  });

  it("ships the checksums.txt of the recorded commit", () => {
    project();

    const result = runWith(["release", "dist"], { env });
    const [, draft] = result.calls.find(([name]) => name === "createDraft");
    const shipped = draft.files.find((file) => file.endsWith("checksums.txt"));

    expect(result.calls).toContainEqual(["fileAt", RECORD, CHECKSUMS_FILE]);
    expect(readFileSync(shipped, "utf8")).toBe(recordedChecksums());
  });

  it("refuses binaries that do not match the checksums of the recorded commit, which a new build gives", () => {
    project();
    writeFileSync(join(assets, "bcct-linux-x64"), "rebuilt");
    writeFileSync(
      join(assets, "bcct-linux-x64.sha256"),
      `${sha256("rebuilt")}  bcct-linux-x64\n`,
    );

    const result = runWith(["release", "dist"], { env });

    expect(result.code).toBe(1);
    expect(result.err[0]).toContain(
      "bcct-linux-x64 does not match the checksum recorded",
    );
    expect(result.calls.some(([name]) => name === "createDraft")).toBe(false);
  });

  it("refuses a version that was published in the meantime", () => {
    project();

    const result = runWith(["release", "dist"], {
      env,
      state: { release: { draft: false } },
    });

    expect(result.code).toBe(1);
    expect(result.err[0]).toContain(`v${VERSION} is already published`);
  });
});

describe("stable", () => {
  const OLD = "c".repeat(40);
  const stableEnv = { VERSION: "0.2.0", COMMIT: RECORD };
  const moves = (calls) =>
    calls.filter(([name]) => name === "createBranch" || name === "moveBranch");

  it("moves stable forward to the verified record of a stable version, only after checking that stable is behind it", () => {
    const result = runWith(["stable"], {
      env: stableEnv,
      state: { stableHead: OLD },
    });

    expect(result.code).toBe(0);
    expect(result.calls).toContainEqual(["branchHeadIfAny", "stable"]);
    expect(result.calls).toContainEqual(["compare", OLD, RECORD]);
    expect(moves(result.calls)).toEqual([["moveBranch", "stable", RECORD]]);
    expect(result.out).toEqual([
      "✓ stable moved from ccccccc to bbbbbbb, the record of v0.2.0",
    ]);
  });

  it("creates stable at the record when the first stable version finds no stable branch", () => {
    const result = runWith(["stable"], {
      env: stableEnv,
      state: { stableHead: null },
    });

    expect(result.code).toBe(0);
    expect(moves(result.calls)).toEqual([["createBranch", "stable", RECORD]]);
    expect(result.out).toEqual([
      "✓ stable created at bbbbbbb, the record of v0.2.0",
    ]);
  });

  it("leaves stable alone when it already is at the record, so a re-run goes through", () => {
    const result = runWith(["stable"], {
      env: stableEnv,
      state: { stableHead: RECORD },
    });

    expect(result.code).toBe(0);
    expect(moves(result.calls)).toEqual([]);
    expect(result.calls.some(([name]) => name === "compare")).toBe(false);
    expect(result.out).toEqual([
      "✓ stable is already at bbbbbbb, the record of v0.2.0",
    ]);
  });

  it.each(["behind", "diverged", "identical"])(
    "refuses to move stable when the record is not ahead of it (%s), since stable only moves forward",
    (status) => {
      const result = runWith(["stable"], {
        env: stableEnv,
        state: { stableHead: OLD, compareStatus: status },
      });

      expect(result.code).toBe(1);
      expect(moves(result.calls)).toEqual([]);
      expect(result.err).toEqual([
        `✗ stable at ccccccc is not behind bbbbbbb, the record of v0.2.0 (the compare says ${status}): stable only moves forward, so find what moved it`,
      ]);
    },
  );

  it("refuses a pre-release, whose testers follow its tag and never stable", () => {
    const result = runWith(["stable"], {
      env: { VERSION, COMMIT: RECORD },
      state: { stableHead: OLD },
    });

    expect(result.code).toBe(1);
    expect(result.calls.some(([name]) => name === "branchHeadIfAny")).toBe(
      false,
    );
    expect(result.err).toEqual([
      `✗ v${VERSION} is a pre-release, which never moves stable`,
    ]);
  });

  it("names the branch that the setup registers for a stable version", () => {
    expect(
      readFileSync(join(ROOT, "rust/crates/bcct/src/install.rs"), "utf8"),
    ).toContain('const STABLE_REF: &str = "stable";');
  });
});

describe("run", () => {
  it.each([[[]], [["record"]], [["release"]], [["stable", "x"]], [["nope"]]])(
    "a usage error exits 2 (%j)",
    (args) => {
      const result = runWith(args);

      expect(result.code).toBe(2);
      expect(result.err).toEqual([
        "usage: npm run release:publish -- plan | record <assets folder> | release <assets folder> | stable",
      ]);
    },
  );

  it("keeps the notes record out of prettier and typos, since the release commits it through the API as the literal notes of the pull request, pt-br included", () => {
    expect(readFileSync(join(ROOT, ".prettierignore"), "utf8")).toMatch(
      /^docs\/releases\/$/mu,
    );
    expect(readFileSync(join(ROOT, "_typos.toml"), "utf8")).toContain(
      '"docs/releases/"',
    );
  });

  it("is the release:publish npm script", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    );

    expect(scripts["release:publish"]).toBe("node scripts/release-publish.mjs");
  });
});
