import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  maskTime,
  readCalls,
  readLog,
  sandboxPath,
  treeSnapshot,
  writeFakeBcct,
  writeFakeTool,
} from "./fixtures/fake-bcct.mjs";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const SHIM = join(ROOT_DIR, "scripts", "bcct.sh");
const NOT_A_BCCT = "other 1.0.0";
const JS_TARGETS = [
  ["hook", ["stop"], "plugins/telegram-hooks/hooks/telegram.mjs", ["stop"]],
  [
    "statusline",
    ["--after-previous"],
    "plugins/telegram-hooks/statusline.mjs",
    ["--after-previous"],
  ],
  ["release", ["ab"], "scripts/release.mjs", ["ab"]],
  [
    "health",
    ["--json", "install"],
    "scripts/health.mjs",
    ["--json", "install"],
  ],
  [
    "setup",
    ["--set", "delay", "3"],
    "scripts/setup.mjs",
    ["--set", "delay", "3"],
  ],
  ["uninstall", [], "scripts/setup.mjs", ["--uninstall"]],
];

let workDir;
let homeDir;
let binDir;
let logDir;
let configBin;

function shimEnv(extra = {}) {
  return {
    PATH: sandboxPath(binDir),
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: join(workDir, "config"),
    ...extra,
  };
}

function runShim(
  shell,
  args,
  { env = shimEnv(), input, cwd, shim = SHIM } = {},
) {
  return spawnSync(shell, [shim, ...args], {
    env,
    input,
    cwd,
    encoding: "utf8",
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-shim-"));
  homeDir = join(workDir, "home");
  binDir = join(workDir, "bin");
  logDir = join(workDir, "log");
  configBin = join(
    workDir,
    "config",
    "better-claude-code-telegram",
    "bin",
    "bcct",
  );
  mkdirSync(homeDir);
  mkdirSync(binDir);
  mkdirSync(logDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.each(["sh", "bash"])("scripts/bcct.sh under %s", (shell) => {
  describe("finding the binary", () => {
    it("prefers BETTER_CC_TELEGRAM_BIN over the app folder and the PATH", () => {
      const fromEnv = join(workDir, "env", "custom");

      writeFakeBcct(fromEnv, logDir);
      writeFakeBcct(configBin, logDir);
      writeFakeBcct(join(binDir, "bcct"), logDir);

      runShim(shell, ["health"], {
        env: shimEnv({ BETTER_CC_TELEGRAM_BIN: fromEnv }),
      });

      expect(readCalls(logDir).map(({ program }) => program)).toEqual([
        fromEnv,
      ]);
    });

    it("prefers the app folder over the PATH", () => {
      writeFakeBcct(configBin, logDir);
      writeFakeBcct(join(binDir, "bcct"), logDir);

      runShim(shell, ["health"]);

      expect(readCalls(logDir).map(({ program }) => program)).toEqual([
        configBin,
      ]);
    });

    it("looks in ~/.claude when CLAUDE_CONFIG_DIR is not set", () => {
      const inHome = join(
        homeDir,
        ".claude",
        "better-claude-code-telegram",
        "bin",
        "bcct",
      );

      writeFakeBcct(inHome, logDir);

      const env = shimEnv();

      delete env.CLAUDE_CONFIG_DIR;
      runShim(shell, ["health"], { env });

      expect(readCalls(logDir).map(({ program }) => program)).toEqual([inHome]);
    });

    it("uses the bcct of the PATH when it is the only one", () => {
      const onPath = join(binDir, "bcct");

      writeFakeBcct(onPath, logDir);

      runShim(shell, ["health"]);

      expect(readCalls(logDir).map(({ program }) => program)).toEqual([onPath]);
    });

    it("moves on from each invalid candidate until a valid one", () => {
      const missing = join(workDir, "missing");
      const onPath = join(binDir, "bcct");

      writeFakeBcct(configBin, logDir, { versionExit: 1 });
      writeFakeBcct(onPath, logDir);

      runShim(shell, ["health"], {
        env: shimEnv({ BETTER_CC_TELEGRAM_BIN: missing }),
      });

      expect(readCalls(logDir).map(({ program }) => program)).toEqual([onPath]);
    });

    it("probes only until the first valid candidate", () => {
      writeFakeBcct(configBin, logDir);
      writeFakeBcct(join(binDir, "bcct"), logDir);

      runShim(shell, ["health"]);

      expect(readLog(logDir, "probes")).toBe(`${configBin}\n`);
    });
  });

  describe("falling to the JavaScript", () => {
    function fallbackOutcome(env) {
      const result = runShim(shell, ["release", "ab"], { env });

      return {
        binaryCalls: readCalls(logDir),
        nodeArgs: readCalls(logDir, "tool-calls").map(({ args }) => args),
        status: result.status,
        stderr: result.stderr,
      };
    }

    function ranTheJavaScript() {
      return {
        binaryCalls: [],
        nodeArgs: [[join(ROOT_DIR, "scripts", "release.mjs"), "ab"]],
        status: 0,
        stderr: "",
      };
    }

    beforeEach(() => {
      writeFakeTool(join(binDir, "node"), logDir);
    });

    it("when there is no binary at all", () => {
      expect(fallbackOutcome(shimEnv())).toEqual(ranTheJavaScript());
    });

    it("when BETTER_CC_TELEGRAM_BIN points to nothing", () => {
      expect(
        fallbackOutcome(
          shimEnv({ BETTER_CC_TELEGRAM_BIN: join(workDir, "missing") }),
        ),
      ).toEqual(ranTheJavaScript());
    });

    it("when BETTER_CC_TELEGRAM_BIN is empty", () => {
      expect(fallbackOutcome(shimEnv({ BETTER_CC_TELEGRAM_BIN: "" }))).toEqual(
        ranTheJavaScript(),
      );
    });

    it("when the binary has no execute permission", () => {
      mkdirSync(dirname(configBin), { recursive: true });
      writeFileSync(configBin, "#!/bin/sh\necho bcct 9.9.9\n", { mode: 0o644 });

      expect(fallbackOutcome(shimEnv())).toEqual(ranTheJavaScript());
    });

    it("when the candidate is a folder", () => {
      mkdirSync(configBin, { recursive: true });

      expect(fallbackOutcome(shimEnv())).toEqual(ranTheJavaScript());
    });

    it("when --version fails, even with the right text", () => {
      writeFakeBcct(configBin, logDir, { versionExit: 3 });

      expect(fallbackOutcome(shimEnv())).toEqual(ranTheJavaScript());
    });

    it("when --version works but it is some other program", () => {
      writeFakeBcct(join(binDir, "bcct"), logDir, { version: NOT_A_BCCT });

      expect(fallbackOutcome(shimEnv())).toEqual(ranTheJavaScript());
    });

    it("when --version prints nothing", () => {
      writeFakeBcct(configBin, logDir, { version: "" });

      expect(fallbackOutcome(shimEnv())).toEqual(ranTheJavaScript());
    });

    it.each(JS_TARGETS)(
      "%s runs the same script with the same arguments",
      (subcommand, args, script, scriptArgs) => {
        const result = runShim(shell, [subcommand, ...args]);

        expect(readCalls(logDir, "tool-calls")[0].args).toEqual([
          join(ROOT_DIR, script),
          ...scriptArgs,
        ]);
        expect(result.status).toBe(0);
      },
    );

    it("launch runs the bash launcher, not node", () => {
      writeFakeTool(join(binDir, "bash"), logDir);

      runShim(shell === "bash" ? "sh" : shell, ["launch", "--continue"]);

      expect(readCalls(logDir, "tool-calls")).toEqual([
        expect.objectContaining({
          program: join(binDir, "bash"),
          args: [join(ROOT_DIR, "scripts", "telegram.sh"), "--continue"],
        }),
      ]);
    });

    it("keeps the exit code of node", () => {
      writeFakeTool(join(binDir, "node"), logDir, { exit: 42 });

      expect(runShim(shell, ["health"]).status).toBe(42);
    });

    it("hands stdin to node and replaces the shell with it", () => {
      const result = runShim(shell, ["hook", "stop"], { input: "{}" });

      expect(readLog(logDir, "tool-stdin")).toBe("{}");
      expect(readCalls(logDir, "tool-calls")[0].pid).toBe(result.pid);
    });

    it("finds the scripts through a relative path and with CDPATH set", () => {
      const result = runShim(shell, ["release"], {
        cwd: ROOT_DIR,
        env: shimEnv({ CDPATH: workDir }),
        shim: "scripts/bcct.sh",
      });

      expect(result.stdout).toBe("");
      expect(readCalls(logDir, "tool-calls")[0].args).toEqual([
        join(ROOT_DIR, "scripts", "release.mjs"),
      ]);
    });

    it("finds the scripts through a folder with spaces", () => {
      const folder = join(workDir, "with space", "scripts");
      const shim = join(folder, "bcct.sh");

      mkdirSync(folder, { recursive: true });
      copyFileSync(SHIM, shim);

      runShim(shell, ["release"], { shim });

      expect(readCalls(logDir, "tool-calls")[0].args).toEqual([
        join(workDir, "with space", "scripts", "release.mjs"),
      ]);
    });
  });

  describe("without a binary and without a JavaScript equivalent", () => {
    it.each([
      ["no subcommand", [], "''"],
      ["an unknown subcommand", ["nope"], "'nope'"],
      ["--version", ["--version"], "'--version'"],
    ])("fails with the usage code for %s", (_name, args, shown) => {
      const result = runShim(shell, args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `bcct: no binary found and no JavaScript fallback for ${shown}\n`,
      );
    });
  });

  describe("running the binary", () => {
    it("passes every argument intact, spaces and empty ones included", () => {
      writeFakeBcct(configBin, logDir);

      runShim(shell, ["release", "two words", "", "*", "--x=y"]);

      expect(readCalls(logDir)[0].args).toEqual([
        "release",
        "two words",
        "",
        "*",
        "--x=y",
      ]);
    });

    it("passes a subcommand it does not know, for the binary to answer", () => {
      writeFakeBcct(configBin, logDir, { exit: 2 });

      const result = runShim(shell, ["nope"]);

      expect(readCalls(logDir)[0].args).toEqual(["nope"]);
      expect(result.status).toBe(2);
    });

    it.each([0, 1, 42])("keeps the exit code %i", (exit) => {
      writeFakeBcct(configBin, logDir, { exit });

      expect(runShim(shell, ["health"]).status).toBe(exit);
    });

    it("passes stdout and stderr through", () => {
      writeFakeBcct(configBin, logDir, { stdout: "from bcct" });

      const result = runShim(shell, ["health"]);

      expect(result.stdout).toBe("from bcct");
      expect(result.stderr).toBe("bcct-stderr\n");
    });

    it("does not let the --version probe take the stdin of the command", () => {
      writeFakeBcct(configBin, logDir);

      runShim(shell, ["hook", "stop"], { input: '{"session_id":"s1"}' });

      expect(readLog(logDir, "probe-stdin")).toBe("");
      expect(readLog(logDir, "stdin")).toBe('{"session_id":"s1"}');
    });

    it("replaces the shell with the binary, leaving no process in between", () => {
      writeFakeBcct(configBin, logDir);

      const result = runShim(shell, ["health"]);

      expect(readCalls(logDir)[0].pid).toBe(result.pid);
    });

    it("never runs node when the binary fails, so nothing runs twice", () => {
      writeFakeBcct(configBin, logDir, { exit: 1 });
      writeFakeTool(join(binDir, "node"), logDir);

      expect(runShim(shell, ["hook", "stop"]).status).toBe(1);
      expect(readCalls(logDir)).toHaveLength(1);
      expect(readCalls(logDir, "tool-calls")).toEqual([]);
    });
  });
});

describe("scripts/bcct.sh without a binary matches the JavaScript it falls to", () => {
  const SESSION_INPUT = JSON.stringify({
    session_id: "s1",
    last_assistant_message: "waiting for you",
  });
  const SCENARIOS = [
    ["setup --show", ["setup", "--show"], "scripts/setup.mjs", ["--show"]],
    [
      "setup --set with a valid value",
      ["setup", "--set", "delay", "7"],
      "scripts/setup.mjs",
      ["--set", "delay", "7"],
    ],
    [
      "setup --set with an invalid value",
      ["setup", "--set", "delay", "0"],
      "scripts/setup.mjs",
      ["--set", "delay", "0"],
    ],
    [
      "setup --set of an unknown step",
      ["setup", "--set", "nope", "1"],
      "scripts/setup.mjs",
      ["--set", "nope", "1"],
    ],
    [
      "setup --statusline-prompt --take",
      ["setup", "--statusline-prompt", "--take"],
      "scripts/setup.mjs",
      ["--statusline-prompt", "--take"],
    ],
    [
      "health --json security",
      ["health", "--json", "security"],
      "scripts/health.mjs",
      ["--json", "security"],
    ],
    ["release", ["release"], "scripts/release.mjs", []],
    ["release with a prefix", ["release", "ab"], "scripts/release.mjs", ["ab"]],
    [
      "statusline",
      ["statusline"],
      "plugins/telegram-hooks/statusline.mjs",
      [],
      "{}",
    ],
    [
      "hook stop",
      ["hook", "stop"],
      "plugins/telegram-hooks/hooks/telegram.mjs",
      ["stop"],
      SESSION_INPUT,
    ],
  ];

  function sandboxEnv() {
    return shimEnv({
      BETTER_CC_TELEGRAM: "1",
      TELEGRAM_STATE_DIR: join(workDir, "state"),
    });
  }

  function resetSandbox() {
    rmSync(join(workDir, "config"), { recursive: true, force: true });
    rmSync(join(workDir, "state"), { recursive: true, force: true });
    mkdirSync(join(workDir, "config"));
    mkdirSync(join(workDir, "state"));
  }

  function outcome(result) {
    return {
      status: result.status,
      stdout: maskTime(result.stdout),
      stderr: maskTime(result.stderr),
      config: treeSnapshot(join(workDir, "config")),
      state: treeSnapshot(join(workDir, "state")),
    };
  }

  it.each(SCENARIOS)("%s", (_name, shimArgs, script, scriptArgs, input) => {
    resetSandbox();

    const direct = outcome(
      spawnSync("node", [join(ROOT_DIR, script), ...scriptArgs], {
        env: sandboxEnv(),
        input,
        encoding: "utf8",
      }),
    );

    resetSandbox();

    const throughShim = outcome(
      runShim("sh", shimArgs, { env: sandboxEnv(), input }),
    );

    expect(throughShim).toEqual(direct);
  });

  it("the health of that scenario really fails, so the exit code is being compared", () => {
    resetSandbox();

    expect(
      runShim("sh", ["health", "--json", "security"], { env: sandboxEnv() })
        .status,
    ).toBe(1);
  });
});

describe("scripts/bcct.sh against the binary", () => {
  it("only names subcommands that the bcct of this repository has", () => {
    const shim = readFileSync(SHIM, "utf8");
    const lib = readFileSync(
      join(ROOT_DIR, "rust", "crates", "bcct", "src", "lib.rs"),
      "utf8",
    );
    const subcommands = [...shim.matchAll(/^ {2}(\w+)\) exec /gm)].map(
      ([, name]) => name,
    );

    expect(subcommands.toSorted()).toEqual(
      [
        "health",
        "hook",
        "launch",
        "release",
        "setup",
        "statusline",
        "uninstall",
      ].toSorted(),
    );

    for (const name of subcommands) {
      expect(
        lib.includes(`Some("${name}") =>`) ||
          lib.includes(`if word == "${name}" =>`),
      ).toBe(true);
    }
  });
});
