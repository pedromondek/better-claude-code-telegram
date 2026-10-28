import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = join(import.meta.dirname, "..", "lockfile-sync.mjs");
const NPM_TIMEOUT = 60_000;

let project;

function writeProject(
  dir,
  { dependencies, lockDependencies, lock = true } = {},
) {
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "package-lock.json"), { force: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies }),
  );

  if (!lock) return;

  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "fixture",
          version: "1.0.0",
          dependencies: lockDependencies ?? dependencies,
        },
      },
    }),
  );
}

function runHook(command, { env = {}, cwd = project, input } = {}) {
  const payload =
    input ??
    (command === undefined
      ? "not json"
      : JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }));

  return spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
  });
}

function blockReason(result) {
  expect(result.status).toBe(0);
  expect(result.stdout).not.toBe("");

  const output = JSON.parse(result.stdout);

  expect(output.decision).toBe("block");

  return output.reason;
}

function stdoutOf(result) {
  expect(result.status).toBe(0);

  return result.stdout;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "bcct-lockfile-sync-hook-"));
  writeProject(project, {});
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("lockfile-sync", { timeout: NPM_TIMEOUT }, () => {
  it("stays silent after an install with package.json and the lock in sync", () => {
    expect(stdoutOf(runHook("npm install"))).toBe("");
  });

  it("blocks the install when the lock root diverges from package.json and names the package and both versions", () => {
    writeProject(project, {
      dependencies: { "left-pad": "1.2.0" },
      lockDependencies: { "left-pad": "1.3.0" },
    });

    const reason = blockReason(runHook("npm i -D left-pad"));

    expect(reason).toMatch(/^The install left the lock out of sync/u);
    expect(reason).toContain(
      ".: package.json and package-lock.json are out of sync",
    );
    expect(reason).toContain("dependencies.left-pad");
    expect(reason).toContain("1.2.0");
    expect(reason).toContain("1.3.0");
    expect(reason).toContain("Run npm install to update the lock");
  });

  it("blocks when the lock still lists a package that left package.json", () => {
    writeProject(project, {
      dependencies: {},
      lockDependencies: { "left-pad": "1.3.0" },
    });

    expect(blockReason(runHook("npm uninstall left-pad"))).toContain(
      "dependencies.left-pad",
    );
  });

  it("blocks when the project has no lock", () => {
    writeProject(project, { lock: false });

    expect(blockReason(runHook("npm update"))).toContain(
      "package-lock.json is missing",
    );
  });

  it("blocks when the lock became unreadable", () => {
    writeFileSync(join(project, "package-lock.json"), "{ merge conflict");

    expect(blockReason(runHook("npm i"))).toContain(
      "package-lock.json is unreadable",
    );
  });

  for (const [scenario, env] of [
    ["with the default npm log level", { npm_config_loglevel: "notice" }],
    ["even with npm silenced", { npm_config_loglevel: "silent" }],
  ]) {
    it(`blocks a package missing from the lock and shows the npm ci error ${scenario}`, () => {
      writeProject(project, { dependencies: { "left-pad": "1.3.0" } });

      const reason = blockReason(runHook("npm install", { env }));

      expect(reason).toContain("Missing: left-pad@1.3.0 from lock file");
      expect(reason).not.toContain("npm ci exited with");
    });
  }

  it("checks the project root only, not the folders under it", () => {
    writeProject(join(project, "backend"), {
      dependencies: { "left-pad": "1.2.0" },
      lockDependencies: { "left-pad": "1.3.0" },
    });

    expect(stdoutOf(runHook("cd backend && npm install"))).toBe("");
  });

  it("recognizes the dependency commands, their aliases and the npm binary by path", () => {
    writeProject(project, {
      dependencies: { "left-pad": "1.2.0" },
      lockDependencies: { "left-pad": "1.3.0" },
    });

    const commands = [
      "npm add left-pad",
      "npm remove left-pad",
      "npm rm left-pad",
      "npm un left-pad",
      "npm up",
      "npm upgrade",
      "npm dedupe",
      "npm prune",
      "npm it",
      "npm --prefix . install",
      "cd . && npm install",
      "git status; npm i",
      "/usr/bin/npm install",
    ];

    expect(commands.map((command) => blockReason(runHook(command)))).toEqual(
      commands.map(() => expect.stringContaining("dependencies.left-pad")),
    );
  });

  it("does not run for a command that does not touch dependencies", () => {
    writeProject(project, {
      dependencies: { "left-pad": "1.2.0" },
      lockDependencies: { "left-pad": "1.3.0" },
    });

    const commands = [
      "git status",
      "npm run lint",
      "npm test -- --update",
      "npm ci",
      "ls install",
    ];

    expect(commands.map((command) => stdoutOf(runHook(command)))).toEqual(
      commands.map(() => ""),
    );
  });

  it("stays silent when there is no project directory", () => {
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_input: { command: "npm install" } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: "" },
    });

    expect(stdoutOf(result)).toBe("");
  });

  it("uses the cwd of the input when CLAUDE_PROJECT_DIR is not set", () => {
    writeProject(project, {
      dependencies: { "left-pad": "1.2.0" },
      lockDependencies: { "left-pad": "1.3.0" },
    });
    const env = { ...process.env };

    delete env.CLAUDE_PROJECT_DIR;
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_input: { command: "npm install" },
        cwd: project,
      }),
      encoding: "utf8",
      env,
    });

    expect(blockReason(result)).toContain("dependencies.left-pad");
  });

  it("never fails the tool on invalid input or a non-string command", () => {
    expect(stdoutOf(runHook(undefined))).toBe("");
    expect(
      stdoutOf(
        runHook(undefined, {
          input: JSON.stringify({ tool_input: { command: 42 } }),
        }),
      ),
    ).toBe("");
  });
});
