import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "mutation-changed.mjs");

const EXT = "plugins/telegram/extensions";

const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "mutation-report.json"),
    "utf8",
  ),
);
const REPORT = JSON.stringify({
  ...FIXTURE,
  files: Object.fromEntries(
    Object.entries(FIXTURE.files).map(([file, content]) => [
      file.replace(/^src\//, `${EXT}/`),
      content,
    ]),
  ),
});

const EXT_MUTATE = [`${EXT}/**/*.ts`, `!${EXT}/**/__tests__/**`];
const EXT_TSX_MUTATE = [
  `${EXT}/**/*.{ts,tsx}`,
  `!${EXT}/**/__tests__/**`,
  `!${EXT}/**/*.d.ts`,
];

const FAKE_STRYKER = [
  "#!/usr/bin/env node",
  'const { writeFileSync } = require("node:fs");',
  'writeFileSync("stryker-args.json", JSON.stringify(process.argv.slice(2)));',
  "process.exitCode = Number(process.env.FAKE_STRYKER_EXIT ?? 0);",
].join("\n");

let repo;

function isolatedRunArgs(args) {
  const start = args.indexOf("--tempDirName");

  return start === -1
    ? ["--tempDirName", "(missing)", "--cleanTempDir", "always"]
    : args.slice(start);
}

function write(relativePath, content, mode) {
  const file = join(repo, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, mode ? { mode } : undefined);
}

function git(...args) {
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
    { cwd: repo, stdio: "ignore" },
  );
}

function setupRepo(mutateGlobs) {
  write("stryker.config.json", JSON.stringify({ mutate: mutateGlobs }));
  write("node_modules/.bin/stryker", FAKE_STRYKER, 0o755);
  write(".gitignore", "node_modules/\nreports/\nstryker-args.json\n");
}

function commitAll() {
  git("add", "-A");
  git("commit", "-m", "base");
}

function runChanged(env = {}) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return {
    status,
    stdout: stdout.split("\n"),
    stderr,
    strykerArgs: readStrykerArgs(),
  };
}

function readStrykerArgs() {
  try {
    return JSON.parse(readFileSync(join(repo, "stryker-args.json"), "utf8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "mutation-changed-")));
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("mutation-changed › file selection", () => {
  beforeEach(() => {
    setupRepo(EXT_MUTATE);
    for (const file of [
      `${EXT}/svc.ts`,
      `${EXT}/none.ts`,
      `${EXT}/__tests__/svc.test.ts`,
      `${EXT}/__tests__/support/x.ts`,
      "scripts/a.mjs",
    ]) {
      write(file, "export const v = 1;\n");
    }
    commitAll();
  });

  it("warns that there is nothing to mutate and does not call Stryker when no source changed", () => {
    write(`${EXT}/__tests__/svc.test.ts`, "export const v = 2;\n");
    write("scripts/a.mjs", "export const v = 2;\n");

    const { status, stdout, strykerArgs } = runChanged();

    expect(status).toBe(0);
    expect(stdout[0]).toMatch(/nothing to mutate/);
    expect(strykerArgs).toBeNull();
  });

  it("mutates only the changed or staged sources, outside spec, test support and untracked files", () => {
    for (const file of [
      `${EXT}/svc.ts`,
      `${EXT}/__tests__/svc.test.ts`,
      `${EXT}/__tests__/support/x.ts`,
      "scripts/a.mjs",
    ]) {
      write(file, "export const v = 2;\n");
    }
    write(`${EXT}/none.ts`, "export const v = 3;\n");
    git("add", `${EXT}/none.ts`);
    write(`${EXT}/untracked.ts`, "export const v = 4;\n");
    write("reports/mutation/report.json", REPORT);

    const { status, stdout, strykerArgs } = runChanged();

    expect(status).toBe(0);
    expect(stdout.slice(0, 3)).toEqual([
      "Mutating 2 changed file(s):",
      `  ${EXT}/none.ts`,
      `  ${EXT}/svc.ts`,
    ]);
    expect(strykerArgs).toEqual([
      "run",
      "--mutate",
      `${EXT}/none.ts,${EXT}/svc.ts`,
      "--reporters",
      "json",
      ...isolatedRunArgs(strykerArgs),
    ]);
    expect(isolatedRunArgs(strykerArgs)[1]).toMatch(
      /^\.stryker-tmp[/\\]run-\d+$/,
    );
  });
});

describe("mutation-changed › Stryker and report failures", () => {
  beforeEach(() => {
    setupRepo(EXT_MUTATE);
    write(`${EXT}/svc.ts`, "export const v = 1;\n");
    commitAll();
    write(`${EXT}/svc.ts`, "export const v = 2;\n");
  });

  it("propagates Stryker's exit code and does not read the report when it fails", () => {
    write("reports/mutation/report.json", REPORT);

    const { status, stdout } = runChanged({
      FAKE_STRYKER_EXIT: "3",
    });

    expect(status).toBe(3);
    expect(stdout.some((line) => line.startsWith(`${EXT}/svc.ts `))).toBe(
      false,
    );
  });

  it("exits with code 1 when Stryker finishes without writing the JSON report", () => {
    const { status, stderr } = runChanged();

    expect(status).toBe(1);
    expect(stderr).toMatch(
      /Stryker JSON report not found — see reports\/mutation\//,
    );
  });
});

describe("mutation-changed › score of each file", () => {
  it("prints raw, covered and effective per file with the same classifier as the range score", () => {
    setupRepo(EXT_MUTATE);
    const files = [`${EXT}/svc.ts`, `${EXT}/none.ts`, `${EXT}/empty.ts`];
    for (const file of files) {
      write(file, "export const v = 1;\n");
    }
    commitAll();
    for (const file of files) {
      write(file, "export const v = 2;\n");
    }
    write("reports/mutation/report.json", REPORT);

    const { status, stdout } = runChanged();

    expect(status).toBe(0);
    expect(stdout.slice(4).filter(Boolean)).toEqual([
      `${EXT}/empty.ts | no mutants in the report`,
      `${EXT}/none.ts | 1 mutants | killed 0 | survived 0 (log 0) | nocov 1 | raw 0.0% | covered — | effective —`,
      '  NoCoverage L1 StringLiteral -> ""',
      `${EXT}/svc.ts | 8 mutants | killed 3 | survived 3 (log 1, unmeasured 1) | nocov 1 | raw 42.9% | covered 50.0% | effective 60.0%`,
      '  Survived (log) L3 StringLiteral -> ""',
      "  Survived L8 ConditionalExpression -> true",
      '  NoCoverage L5 StringLiteral -> ""',
      '  Survived (unmeasured) L7 StringLiteral -> ""',
    ]);
  });
});

describe("mutation-changed › mutate glob from the config", () => {
  it("mutates the changed .tsx by the mutate of stryker.config.json", () => {
    setupRepo(EXT_TSX_MUTATE);
    const files = [
      `${EXT}/components/Card.tsx`,
      `${EXT}/lib/api.ts`,
      `${EXT}/components/__tests__/Card.test.tsx`,
      `${EXT}/types/env.d.ts`,
      "scripts/a.mjs",
    ];
    for (const file of files) {
      write(file, "export const v = 1;\n");
    }
    commitAll();
    for (const file of files) {
      write(file, "export const v = 2;\n");
    }
    write("reports/mutation/report.json", REPORT);

    const { status, strykerArgs } = runChanged();

    expect(status).toBe(0);
    expect(strykerArgs).toEqual([
      "run",
      "--mutate",
      `${EXT}/components/Card.tsx,${EXT}/lib/api.ts`,
      "--reporters",
      "json",
      ...isolatedRunArgs(strykerArgs),
    ]);
  });
});
