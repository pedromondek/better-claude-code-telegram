import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readCalls,
  readLog,
  sandboxPath,
  writeFakeBcct,
} from "../../../scripts/__tests__/fixtures/fake-bcct.mjs";

import { SETUP_COMMAND } from "../lib/package.constants.mjs";

const PLUGINS = join(import.meta.dirname, "..", "..");
const COPIES = ["bcct", "telegram-hooks"].map((plugin) =>
  join(PLUGINS, plugin, "scripts", "bcct"),
);
const SCRIPT = COPIES[1];
const EXECUTABLE = 0o755;

let workDir;
let logDir;
let binDir;

function missing(app) {
  return [
    `bcct: not installed (no launcher in ${app}/bin). Run: npx @pedromondek/better-claude-code-telegram`,
    `bcct: não instalado (sem launcher em ${app}/bin). Rode: npx @pedromondek/better-claude-code-telegram`,
    "",
  ].join("\n");
}

function run(
  shell,
  env,
  args = ["hook", "stop"],
  input = '{"session_id":"s1"}',
) {
  return spawnSync(shell, [SCRIPT, ...args], {
    env: { PATH: sandboxPath(binDir), HOME: join(workDir, "home"), ...env },
    input,
    encoding: "utf8",
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-script-"));
  logDir = join(workDir, "log");
  binDir = join(workDir, "bin");
  mkdirSync(logDir);
  mkdirSync(binDir);
  mkdirSync(join(workDir, "home"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("the bcct script of the plugins", () => {
  it("is the same executable file in both plugins", () => {
    const [first, second] = COPIES.map((file) => readFileSync(file, "utf8"));

    expect(second).toBe(first);

    for (const file of COPIES) {
      expect(statSync(file).mode & 0o777).toBe(EXECUTABLE);
    }
  });

  it("names the setup command once, the same SETUP_COMMAND as the hooks plugin", () => {
    const text = readFileSync(SCRIPT, "utf8");

    expect(text).toContain(`setup="${SETUP_COMMAND}"\n`);
    expect(text.split("npx ")).toHaveLength(2);
  });

  it("starts with sh and needs nothing outside the plugin but the launcher it looks for", () => {
    const text = readFileSync(SCRIPT, "utf8");

    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).not.toContain("node");
    expect(text).not.toContain("../");
    expect(text).not.toContain("--version");
  });
});

describe.each(["sh", "bash"])("the bcct script under %s", (shell) => {
  it.each(COPIES)("tells the binary where its plugin is (%s)", (copy) => {
    const app = join(workDir, "app");
    writeFakeBcct(join(app, "bin", "bcct"), logDir);

    const result = spawnSync(shell, [copy, "hook", "session-start"], {
      env: {
        PATH: sandboxPath(binDir),
        HOME: join(workDir, "home"),
        BETTER_CC_TELEGRAM_DIR: app,
        BETTER_CC_TELEGRAM_PLUGIN_DIR: "/somewhere/else",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readLog(logDir, "plugin-dir")).toBe(`${join(copy, "..", "..")}\n`);
  });

  it("runs BETTER_CC_TELEGRAM_BIN first, with the arguments, the stdin, the output and the exit code", () => {
    const chosen = join(workDir, "chosen", "bcct");
    writeFakeBcct(chosen, logDir, { exit: 7, stdout: "out" });
    writeFakeBcct(join(workDir, "app", "bin", "bcct"), logDir);

    const result = run(shell, {
      BETTER_CC_TELEGRAM_BIN: chosen,
      BETTER_CC_TELEGRAM_DIR: join(workDir, "app"),
    });

    expect(result.status).toBe(7);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("bcct-stderr\n");
    expect(
      readCalls(logDir).map(({ program, args }) => [program, args]),
    ).toEqual([[chosen, ["hook", "stop"]]]);
    expect(readLog(logDir, "stdin")).toBe('{"session_id":"s1"}');
    expect(readLog(logDir, "probes")).toBe("");
  });

  it.each([
    [
      "BETTER_CC_TELEGRAM_DIR",
      (dir) => ({ BETTER_CC_TELEGRAM_DIR: dir }),
      "app",
    ],
    [
      "CLAUDE_CONFIG_DIR",
      (dir) => ({ CLAUDE_CONFIG_DIR: join(dir, "..") }),
      "config/better-claude-code-telegram",
    ],
    ["HOME", () => ({}), "home/.claude/better-claude-code-telegram"],
  ])("finds the launcher of the app folder from %s", (_name, env, folder) => {
    const app = join(workDir, folder);
    writeFakeBcct(join(app, "bin", "bcct"), logDir);

    const result = run(shell, env(app));

    expect(result.status).toBe(0);
    expect(readCalls(logDir).map(({ program }) => program)).toEqual([
      join(app, "bin", "bcct"),
    ]);
  });

  it("falls to the bcct on the PATH when the app folder has no launcher", () => {
    writeFakeBcct(join(binDir, "bcct"), logDir);

    const result = run(shell, { BETTER_CC_TELEGRAM_DIR: join(workDir, "app") });

    expect(result.status).toBe(0);
    expect(readCalls(logDir).map(({ args }) => args)).toEqual([
      ["hook", "stop"],
    ]);
  });

  it.each([
    ["an empty variable", () => ({ BETTER_CC_TELEGRAM_BIN: "" })],
    [
      "a file without execute permission",
      () => {
        const file = join(workDir, "plain");
        writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
        return { BETTER_CC_TELEGRAM_BIN: file };
      },
    ],
    [
      "a folder",
      () => {
        const folder = join(workDir, "folder");
        mkdirSync(folder);
        return { BETTER_CC_TELEGRAM_BIN: folder };
      },
    ],
  ])(
    "skips %s and says how to install when nothing is found",
    (_name, prepare) => {
      const app = join(workDir, "app");

      const result = run(shell, { ...prepare(), BETTER_CC_TELEGRAM_DIR: app });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(missing(app));
    },
  );
});
