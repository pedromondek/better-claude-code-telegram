import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
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

import {
  isolatedArgs,
  isolatedEnv,
  runDirFor,
  staleRunDirs,
} from "../stryker-run.mjs";

const SCRIPT = join(import.meta.dirname, "..", "stryker-run.mjs");

const FAKE_STRYKER = [
  "#!/usr/bin/env node",
  'const { writeFileSync } = require("node:fs");',
  'const { join } = require("node:path");',
  "writeFileSync(",
  '  "stryker-call.json",',
  "  JSON.stringify({ argv: process.argv.slice(2), tmpdir: process.env.TMPDIR }),",
  ");",
  'writeFileSync(join(process.env.TMPDIR, "vitest-orphan"), "x");',
  'if (process.env.FAKE_STRYKER_WAIT === "1") {',
  '  process.on("SIGINT", () => process.exit(130));',
  '  writeFileSync("stryker-ready", "");',
  "  setInterval(() => {}, 1000);",
  "} else {",
  "  process.exitCode = Number(process.env.FAKE_STRYKER_EXIT ?? 0);",
  "}",
].join("\n");

const DEAD_PID = 2 ** 22 + 1;

let layer;

function write(relativePath, content, mode) {
  const file = join(layer, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, mode ? { mode } : undefined);
}

function readCall() {
  return JSON.parse(readFileSync(join(layer, "stryker-call.json"), "utf8"));
}

function runWrapper(env = {}) {
  return spawnSync(process.execPath, [SCRIPT, "run", "--mutate", "src/a.ts"], {
    cwd: layer,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met in 5 s");
}

beforeEach(() => {
  layer = realpathSync(mkdtempSync(join(tmpdir(), "stryker-run-")));
  write("node_modules/.bin/stryker", FAKE_STRYKER, 0o755);
});

afterEach(() => {
  rmSync(layer, { recursive: true, force: true });
});

describe("stryker-run › sandbox contents", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const config = JSON.parse(
    readFileSync(join(ROOT, "stryker.config.json"), "utf8"),
  );

  it("leaves the Rust workspace out of the copy of each run", () => {
    expect(config.ignorePatterns).toEqual([
      "dist",
      "coverage",
      "reports",
      ".stryker-tmp",
      "rust",
      "tmp",
    ]);
    expect(
      [config.mutate, config.vitest?.configFile]
        .flat()
        .filter((pattern) => String(pattern).startsWith("rust")),
    ).toEqual([]);
  });
});

describe("stryker-run › own folder per run", () => {
  it("names the run folder by the pid inside .stryker-tmp", () => {
    expect(runDirFor(4321)).toBe(join(".stryker-tmp", "run-4321"));
  });

  it("appends the run folder as tempDirName and cleans the folder even when the run fails", () => {
    expect(
      isolatedArgs(["run", "--mutate", "src/a.ts"], ".stryker-tmp/run-7"),
    ).toEqual([
      "run",
      "--mutate",
      "src/a.ts",
      "--tempDirName",
      ".stryker-tmp/run-7",
      "--cleanTempDir",
      "always",
    ]);
  });

  it("points TMPDIR at the absolute tmp path inside the run folder, pins TZ and keeps the rest of the environment", () => {
    const env = isolatedEnv(
      { PATH: "/bin", TMPDIR: "/tmp", TZ: "Asia/Tokyo" },
      ".stryker-tmp/run-7",
      "/repo/frontend",
    );

    expect(env).toEqual({
      PATH: "/bin",
      TMPDIR: "/repo/frontend/.stryker-tmp/run-7/tmp",
      TZ: "UTC",
    });
  });

  it("the pinned timezone holds inside a worker thread, where vi.stubEnv of TZ does not change the timezone", () => {
    const hourInWorker = (env) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            'import { Worker } from "node:worker_threads";',
            "const worker = new Worker(",
            '  "process.env.TZ = \\"Asia/Tokyo\\"; console.log(new Date(\\"2026-01-15T12:05:03.000Z\\").getHours());",',
            "  { eval: true },",
            ");",
            'worker.on("error", (error) => { throw error; });',
          ].join("\n"),
        ],
        { env, encoding: "utf8" },
      ).stdout.trim();

    expect(
      hourInWorker(isolatedEnv({ ...process.env, TZ: "Asia/Tokyo" }, "run")),
    ).toBe("12");
  });
});

describe("stryker-run › orphan folders", () => {
  it("picks only the run-<pid> folders whose process no longer exists", () => {
    const alive = new Set([10, 30]);

    expect(
      staleRunDirs(
        ["run-10", "run-20", "run-30", "run-40", "sandbox-abc", "run-x", "tmp"],
        (pid) => alive.has(pid),
      ),
    ).toEqual(["run-20", "run-40"]);
  });

  it("deletes the run folder of a dead pid, keeps the live run's one and leaves other folders alone", () => {
    write(`.stryker-tmp/run-${DEAD_PID}/sandbox-1/a.ts`, "x");
    write(`.stryker-tmp/run-${process.pid}/sandbox-2/a.ts`, "x");
    write(".stryker-tmp/sandbox-legacy/a.ts", "x");

    const { status } = runWrapper();

    expect(status).toBe(0);
    expect(existsSync(join(layer, `.stryker-tmp/run-${DEAD_PID}`))).toBe(false);
    expect(
      existsSync(join(layer, `.stryker-tmp/run-${process.pid}/sandbox-2`)),
    ).toBe(true);
    expect(existsSync(join(layer, ".stryker-tmp/sandbox-legacy"))).toBe(true);
  });
});

describe("stryker-run › execution", () => {
  it("calls Stryker with the run folder and the TMPDIR inside it and deletes the folder at the end", () => {
    const { status } = runWrapper();
    const { argv, tmpdir: strykerTmp } = readCall();
    const runDir = argv[argv.indexOf("--tempDirName") + 1];

    expect(status).toBe(0);
    expect(runDir).toMatch(/^\.stryker-tmp[/\\]run-\d+$/);
    expect(argv.slice(0, 3)).toEqual(["run", "--mutate", "src/a.ts"]);
    expect(strykerTmp).toBe(join(layer, runDir, "tmp"));
    expect(existsSync(join(layer, runDir))).toBe(false);
  });

  it("returns the Stryker exit code and deletes the run folder when it fails", () => {
    const { status } = runWrapper({ FAKE_STRYKER_EXIT: "3" });
    const { argv } = readCall();
    const runDir = argv[argv.indexOf("--tempDirName") + 1];

    expect(status).toBe(3);
    expect(existsSync(join(layer, runDir))).toBe(false);
  });

  it("forwards Ctrl+C to Stryker, waits for it to exit and deletes the run folder", async () => {
    const child = spawn(
      process.execPath,
      [SCRIPT, "run", "--mutate", "src/a.ts"],
      {
        cwd: layer,
        env: { ...process.env, FAKE_STRYKER_WAIT: "1" },
        stdio: "ignore",
      },
    );
    const exited = new Promise((resolve) => child.on("exit", resolve));

    await waitFor(() => existsSync(join(layer, "stryker-ready")));
    const { argv } = readCall();
    const runDir = argv[argv.indexOf("--tempDirName") + 1];
    expect(existsSync(join(layer, runDir, "tmp", "vitest-orphan"))).toBe(true);

    child.kill("SIGINT");
    const code = await exited;

    expect(code).toBe(130);
    expect(existsSync(join(layer, runDir))).toBe(false);
  });
});
