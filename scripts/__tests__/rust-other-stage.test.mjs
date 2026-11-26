import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RUST_FOLDER,
  changedFilesSince,
  run,
  touchesRust,
} from "../rust-other-stage.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

function captured(before, changed) {
  const outputs = [];
  const lines = [];
  const asked = [];
  const code = run({
    before,
    changedFiles: (from) => {
      asked.push(from);

      return changed;
    },
    output: (line) => outputs.push(line),
    log: (line) => lines.push(line),
  });

  return { code, outputs, lines, asked };
}

describe("touchesRust", () => {
  it("returns true when a file of the range is under rust/", () => {
    expect(touchesRust(["README.md", "rust/crates/bcct/src/main.rs"])).toBe(
      true,
    );
  });

  it("returns false when no file of the range is under rust/", () => {
    expect(touchesRust(["scripts/version.mjs", "trust/notes.md"])).toBe(false);
  });

  it("returns false for an empty range", () => {
    expect(touchesRust([])).toBe(false);
  });

  it("returns true when the range is unknown", () => {
    expect(touchesRust(null)).toBe(true);
  });

  it("names rust/ as the folder it watches", () => {
    expect(RUST_FOLDER).toBe("rust/");
  });
});

describe("run", () => {
  it("writes run=true and says why when the range touches rust/", () => {
    expect(captured("abc123", ["rust/Cargo.toml"])).toEqual({
      code: 0,
      outputs: ["run=true"],
      lines: [
        "The range changes rust/: the Rust tests run on the other stage of the version.",
      ],
      asked: ["abc123"],
    });
  });

  it("writes run=false and says it skipped when the range leaves rust/ alone", () => {
    expect(captured("abc123", ["scripts/version.mjs"])).toEqual({
      code: 0,
      outputs: ["run=false"],
      lines: [
        "Nothing in the range changes rust/: the Rust tests on the other stage are skipped.",
      ],
      asked: ["abc123"],
    });
  });

  it("writes run=true and says the range is unknown when there is no before commit, without reading it", () => {
    expect(captured("", ["scripts/version.mjs"])).toEqual({
      code: 0,
      outputs: ["run=true"],
      lines: [
        "The range is unknown: the Rust tests run on the other stage of the version.",
      ],
      asked: [],
    });
  });

  it("writes run=true and says the range is unknown when it cannot be read", () => {
    expect(captured("abc123", null)).toEqual({
      code: 0,
      outputs: ["run=true"],
      lines: [
        "The range is unknown: the Rust tests run on the other stage of the version.",
      ],
      asked: ["abc123"],
    });
  });
});

describe("changedFilesSince", () => {
  let repo;

  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    ).trim();

  function commit(message) {
    git("add", "-A");
    git("commit", "-q", "-m", message);

    return git("rev-parse", "HEAD");
  }

  function write(path, text) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }

  beforeEach(() => {
    repo = join(
      realpathSync(mkdtempSync(join(tmpdir(), "bcct-other-stage-"))),
      "repo",
    );
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    write("rust/fixture.txt", "a fixture long enough to be seen as a rename\n");
    write("README.md", "readme\n");
  });

  afterEach(() => {
    rmSync(join(repo, ".."), { recursive: true, force: true });
  });

  it("lists the rust/ path of a file renamed out of rust/", () => {
    const before = commit("base");

    mkdirSync(join(repo, "fixtures"));
    renameSync(
      join(repo, "rust/fixture.txt"),
      join(repo, "fixtures/fixture.txt"),
    );
    commit("move the fixture");

    expect(changedFilesSince(before, repo)).toEqual([
      "fixtures/fixture.txt",
      "rust/fixture.txt",
    ]);
  });

  it("lists the rust/ change when the branch moves back to an ancestor of before", () => {
    const ancestor = commit("base");

    write("rust/fixture.txt", "changed\n");
    const before = commit("change the fixture");

    git("reset", "-q", "--hard", ancestor);

    expect(changedFilesSince(before, repo)).toEqual(["rust/fixture.txt"]);
  });

  it("lists a path with an accent as it is, without quotes", () => {
    const before = commit("base");

    write("rust/café.txt", "accent\n");
    commit("add a fixture with an accent");

    expect(changedFilesSince(before, repo)).toEqual(["rust/café.txt"]);
  });

  it("returns null when the before commit does not exist", () => {
    commit("base");

    expect(changedFilesSince("0".repeat(40), repo)).toBeNull();
  });
});

describe("the ci:rust-other-stage npm script", () => {
  it("runs this script", () => {
    const scripts = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ).scripts;

    expect(scripts["ci:rust-other-stage"]).toBe(
      "node scripts/rust-other-stage.mjs",
    );
  });
});
