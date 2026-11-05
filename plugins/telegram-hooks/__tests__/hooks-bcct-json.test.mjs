import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  maskTime,
  readCalls,
  readLog,
  sandboxPath,
  treeSnapshot,
  writeFakeBcct,
  writeFakeTool,
} from "../../../scripts/__tests__/fixtures/fake-bcct.mjs";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const ROOT_DIR = join(PLUGIN_ROOT, "..", "..");
const REAL_HOOKS = join(PLUGIN_ROOT, "hooks", "hooks.json");
const BCCT_HOOKS = join(PLUGIN_ROOT, "hooks", "hooks.bcct.json");
const REAL_HOOKS_SHA256 =
  "2bab1852d9312bcf05c01dd6c47f377f1a9716571ebfceb4b9d0bfa03d5766e9";
const HOOK_CALL = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/telegram\.mjs" (\w+)/;
const GUARD = /^\{ .*bot\.pid" \]; \} && /;
const TOOL_INPUT = {
  session_id: "s1",
  tool_input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        multiSelect: false,
        options: [{ label: "Postgres" }, { label: "Redis" }],
      },
    ],
  },
};
const STOP_INPUT = { session_id: "s1", last_assistant_message: "  waiting  " };

let workDir;
let homeDir;
let stateDir;
let binDir;
let logDir;
let configBin;

function load(file) {
  return JSON.parse(readFileSync(file, "utf8")).hooks;
}

function allCommands(hooks) {
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
}

function telegramCommand(file, mode) {
  return allCommands(load(file)).find((command) =>
    command.includes(`telegram.mjs" ${mode}`),
  );
}

function hookEnv({ telegram = true, extra = {} } = {}) {
  return {
    PATH: sandboxPath(binDir),
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: join(workDir, "config"),
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    TELEGRAM_STATE_DIR: stateDir,
    ...(telegram ? { BETTER_CC_TELEGRAM: "1" } : {}),
    ...extra,
  };
}

function runCommand(command, { shell = "bash", env = hookEnv(), input } = {}) {
  return spawnSync(shell, ["-c", command], {
    env,
    input: input ?? "{}",
    encoding: "utf8",
  });
}

function runBcctHook(mode, options) {
  return runCommand(telegramCommand(BCCT_HOOKS, mode), options);
}

function resetState() {
  rmSync(join(workDir, "config"), { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(join(workDir, "config"));
  mkdirSync(stateDir);
}

function outcome(result) {
  return {
    status: result.status,
    stdout: maskTime(result.stdout),
    stderr: maskTime(result.stderr),
    config: treeSnapshot(join(workDir, "config")),
    state: treeSnapshot(stateDir),
  };
}

function writePendingAsk() {
  const asksDir = join(
    workDir,
    "config",
    "better-claude-code-telegram",
    "asks",
  );

  mkdirSync(asksDir, { recursive: true });
  writeFileSync(
    join(asksDir, "a1.json"),
    JSON.stringify({ id: "a1", sessionId: "s1", dueAt: 1 }),
  );
}

function writeBotPid() {
  writeFileSync(join(stateDir, "bot.pid"), String(process.pid));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-hooks-"));
  homeDir = join(workDir, "home");
  stateDir = join(workDir, "state");
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
  mkdirSync(stateDir);
  mkdirSync(binDir);
  mkdirSync(logDir);
  mkdirSync(join(workDir, "config"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("the real hooks.json", () => {
  it("stays byte for byte as the live sessions read it", () => {
    expect(
      createHash("sha256").update(readFileSync(REAL_HOOKS)).digest("hex"),
    ).toBe(REAL_HOOKS_SHA256);
  });

  it("is the only hooks file Claude Code loads, since no manifest names another", () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const marketplace = JSON.parse(
      readFileSync(
        join(ROOT_DIR, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    );

    expect(manifest.hooks).toBeUndefined();
    expect(
      marketplace.plugins.find(({ name }) => name === "telegram-hooks").hooks,
    ).toBeUndefined();
  });
});

describe("hooks.bcct.json structure", () => {
  const withoutCommands = (hooks) =>
    Object.fromEntries(
      Object.entries(hooks).map(([event, groups]) => [
        event,
        groups.map(({ hooks: list, ...group }) => ({
          ...group,
          hooks: list.map(({ command: _command, ...hook }) => hook),
        })),
      ]),
    );

  it("has the same events, matchers, order and timeouts as hooks.json", () => {
    expect(withoutCommands(load(BCCT_HOOKS))).toEqual(
      withoutCommands(load(REAL_HOOKS)),
    );
  });

  it("calls the same mode in the same place as hooks.json", () => {
    const modes = (hooks) =>
      allCommands(hooks).map((command) => command.match(HOOK_CALL)?.[1]);

    expect(modes(load(BCCT_HOOKS))).toEqual(modes(load(REAL_HOOKS)));
  });

  it("keeps the activity marker byte for byte", () => {
    const markers = (hooks) =>
      allCommands(hooks).filter((command) => command.includes("last-activity"));

    expect(markers(load(BCCT_HOOKS))).toEqual(markers(load(REAL_HOOKS)));
    expect(markers(load(BCCT_HOOKS))).toHaveLength(2);
  });

  it.each(["permission", "prompt", "post", "stop"])(
    "starts %s with the same guard as hooks.json",
    (mode) => {
      const guardOf = (file) =>
        telegramCommand(file, mode).match(GUARD)?.[0] ?? "";

      expect(guardOf(BCCT_HOOKS)).not.toBe("");
      expect(guardOf(BCCT_HOOKS)).toBe(guardOf(REAL_HOOKS));
    },
  );

  it.each(["permission", "prompt", "post", "stop"])(
    "chooses %s with if and else, and fails open",
    (mode) => {
      const command = telegramCommand(BCCT_HOOKS, mode);

      expect(command).toContain(
        `if [ -n "$b" ]; then "$b" hook ${mode}; else node "\${CLAUDE_PLUGIN_ROOT}/hooks/telegram.mjs" ${mode}; fi`,
      );
      expect(command).not.toMatch(/hook \w+ *\|\|/);
      expect(command.endsWith("2>/dev/null || true")).toBe(true);
    },
  );

  it("has the same search in the four commands, changing only the mode", () => {
    const bodies = ["permission", "prompt", "post", "stop"].map((mode) =>
      telegramCommand(BCCT_HOOKS, mode).replaceAll(mode, "<mode>"),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it("resolves everything through the plugin root and needs nothing outside the plugin", () => {
    const raw = readFileSync(BCCT_HOOKS, "utf8");

    expect(raw).not.toContain("CLAUDE_PROJECT_DIR");
    expect(raw).not.toContain(".claude/hooks");
    expect(raw).not.toContain("../");
    expect(raw).not.toContain("scripts/");
  });

  it("only calls modes that the bcct of this repository has", () => {
    const hookSource = readFileSync(
      join(ROOT_DIR, "rust", "crates", "bcct", "src", "hook.rs"),
      "utf8",
    );

    for (const mode of ["permission", "prompt", "post", "stop"]) {
      expect(hookSource).toContain(`"${mode}" => Some(Self::`);
    }

    expect(
      readFileSync(
        join(ROOT_DIR, "rust", "crates", "bcct", "src", "lib.rs"),
        "utf8",
      ),
    ).toContain('Some("hook") =>');
  });
});

describe.each(["bash", "sh"])(
  "hooks.bcct.json without a binary, under %s",
  (shell) => {
    const SCENARIOS = [
      {
        name: "stop writes the waiting ping",
        mode: "stop",
        input: JSON.stringify(STOP_INPUT),
      },
      {
        name: "stop with the gate open by a live bot.pid",
        mode: "stop",
        input: JSON.stringify(STOP_INPUT),
        telegram: false,
        prepare: writeBotPid,
      },
      {
        name: "stop with the gate closed writes nothing",
        mode: "stop",
        input: JSON.stringify(STOP_INPUT),
        telegram: false,
      },
      {
        name: "prompt typed at the terminal notes the prompt and closes the asks",
        mode: "prompt",
        input: JSON.stringify({ session_id: "s1", prompt: "hello" }),
        prepare: writePendingAsk,
      },
      {
        name: "prompt from another session does nothing",
        mode: "prompt",
        input: JSON.stringify({
          session_id: "s1",
          prompt: "Another Claude session sent a message: hi",
        }),
        prepare: writePendingAsk,
      },
      {
        name: "post closes the asks of the session",
        mode: "post",
        input: JSON.stringify({ session_id: "s1" }),
        prepare: writePendingAsk,
      },
      {
        name: "permission with invalid stdin prints nothing",
        mode: "permission",
        input: "not json",
      },
      {
        name: "permission with the gate closed prints nothing",
        mode: "permission",
        input: JSON.stringify(TOOL_INPUT),
        telegram: false,
      },
    ];

    it.each(SCENARIOS)(
      "$name, the same as hooks.json",
      ({ mode, input, telegram = true, prepare }) => {
        resetState();
        prepare?.();

        const real = outcome(
          runCommand(telegramCommand(REAL_HOOKS, mode), {
            shell,
            env: hookEnv({ telegram }),
            input,
          }),
        );

        resetState();
        prepare?.();

        const withShim = outcome(
          runBcctHook(mode, { shell, env: hookEnv({ telegram }), input }),
        );

        expect(withShim).toEqual(real);
      },
    );

    it("a node that fails stays silent and exits 0, the same as hooks.json", () => {
      writeFakeTool(join(binDir, "node"), logDir, { exit: 1 });

      const real = runCommand(telegramCommand(REAL_HOOKS, "stop"), { shell });
      const withShim = runBcctHook("stop", { shell });

      expect(withShim.status).toBe(real.status);
      expect(withShim.stdout).toBe(real.stdout);
      expect(withShim.stderr).toBe(real.stderr);
      expect(withShim.status).toBe(0);
    });

    it("runs node once, with the stdin intact", () => {
      writeFakeTool(join(binDir, "node"), logDir);

      runBcctHook("stop", { shell, input: '{"session_id":"s1"}' });

      expect(readCalls(logDir, "tool-calls").map(({ args }) => args)).toEqual([
        [join(PLUGIN_ROOT, "hooks", "telegram.mjs"), "stop"],
      ]);
      expect(readLog(logDir, "tool-stdin")).toBe('{"session_id":"s1"}');
    });

    it.each([
      ["no execute permission", "no-exec"],
      ["a folder", "folder"],
      ["--version that fails", "fails"],
      ["--version of another program", "foreign"],
      ["a path that does not exist", "missing"],
    ])("falls to node with a binary of %s", (_name, kind) => {
      writeFakeTool(join(binDir, "node"), logDir);

      if (kind === "no-exec") {
        mkdirSync(join(configBin, ".."), { recursive: true });
        writeFileSync(configBin, "#!/bin/sh\necho bcct 9.9.9\n", {
          mode: 0o644,
        });
      }

      if (kind === "folder") mkdirSync(configBin, { recursive: true });
      if (kind === "fails")
        writeFakeBcct(configBin, logDir, { versionExit: 3 });
      if (kind === "foreign")
        writeFakeBcct(configBin, logDir, { version: "other 1.0.0" });

      const env =
        kind === "missing"
          ? hookEnv({
              extra: { BETTER_CC_TELEGRAM_BIN: join(workDir, "missing") },
            })
          : hookEnv();
      const result = runBcctHook("stop", { shell, env });

      expect(readCalls(logDir)).toEqual([]);
      expect(readCalls(logDir, "tool-calls")).toHaveLength(1);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  },
);

describe("hooks.bcct.json without a binary, on the blocking permission", () => {
  async function askAndAnswer(command, shell) {
    const child = spawn(shell, ["-c", command], { env: hookEnv() });
    let stdout = "";
    const asksDir = join(
      workDir,
      "config",
      "better-claude-code-telegram",
      "asks",
    );

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stdin.end(JSON.stringify(TOOL_INPUT));

    let recordName;

    for (let attempt = 0; attempt < 100 && !recordName; attempt += 1) {
      await sleep(50);
      recordName = existsSync(asksDir)
        ? readdirSync(asksDir).find((name) => name.endsWith(".json"))
        : undefined;
    }

    writeFileSync(
      join(asksDir, recordName.replace(".json", ".answer.json")),
      JSON.stringify({ answers: { "Which database?": "Redis" } }),
    );

    const status = await new Promise((resolve) => child.on("close", resolve));

    return { status, stdout: maskTime(stdout), asks: treeSnapshot(asksDir) };
  }

  it("waits for the answer and prints the decision, the same as hooks.json", async () => {
    const real = await askAndAnswer(
      telegramCommand(REAL_HOOKS, "permission"),
      "bash",
    );

    resetState();

    const withShim = await askAndAnswer(
      telegramCommand(BCCT_HOOKS, "permission"),
      "bash",
    );

    expect(withShim).toEqual(real);
    expect(withShim.status).toBe(0);
    expect(
      JSON.parse(withShim.stdout).hookSpecificOutput.decision.behavior,
    ).toBe("allow");
  });
});

describe.each(["bash", "sh"])(
  "hooks.bcct.json with a binary, under %s",
  (shell) => {
    it.each(["permission", "prompt", "post", "stop"])(
      "%s calls bcct hook once and never node",
      (mode) => {
        writeFakeBcct(configBin, logDir, { stdout: '{"from":"bcct"}' });
        writeFakeTool(join(binDir, "node"), logDir);

        const result = runBcctHook(mode, {
          shell,
          input: '{"session_id":"s1"}',
        });

        expect(readCalls(logDir).map(({ args }) => args)).toEqual([
          ["hook", mode],
        ]);
        expect(readCalls(logDir, "tool-calls")).toEqual([]);
        expect(readLog(logDir, "stdin")).toBe('{"session_id":"s1"}');
        expect(readLog(logDir, "probe-stdin")).toBe("");
        expect(result.stdout).toBe('{"from":"bcct"}');
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      },
    );

    it.each([1, 2, 127])(
      "a binary that exits %i does not run node, stays silent and exits 0",
      (exit) => {
        writeFakeBcct(configBin, logDir, { exit });
        writeFakeTool(join(binDir, "node"), logDir);

        const result = runBcctHook("stop", { shell });

        expect(readCalls(logDir)).toHaveLength(1);
        expect(readCalls(logDir, "tool-calls")).toEqual([]);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
      },
    );

    it("with the gate closed does not even probe the binary", () => {
      writeFakeBcct(configBin, logDir);

      const result = runBcctHook("stop", {
        shell,
        env: hookEnv({ telegram: false }),
      });

      expect(readLog(logDir, "probes")).toBe("");
      expect(readCalls(logDir)).toEqual([]);
      expect(result.status).toBe(0);
    });

    it("with the gate open by a bot.pid calls the binary", () => {
      writeFakeBcct(configBin, logDir);
      writeBotPid();

      runBcctHook("stop", { shell, env: hookEnv({ telegram: false }) });

      expect(readCalls(logDir)).toHaveLength(1);
    });
  },
);

describe("hooks.bcct.json finds the same binary as scripts/bcct.sh", () => {
  const SHIM = join(ROOT_DIR, "scripts", "bcct.sh");
  const fromEnv = () => join(workDir, "env", "custom");
  const onPath = () => join(binDir, "bcct");
  const CASES = [
    {
      name: "the variable first",
      prepare: () => {
        writeFakeBcct(fromEnv(), logDir);
        writeFakeBcct(configBin, logDir);
        writeFakeBcct(onPath(), logDir);
      },
      extra: () => ({ BETTER_CC_TELEGRAM_BIN: fromEnv() }),
      expected: fromEnv,
    },
    {
      name: "the app folder before the PATH",
      prepare: () => {
        writeFakeBcct(configBin, logDir);
        writeFakeBcct(onPath(), logDir);
      },
      extra: () => ({}),
      expected: () => configBin,
    },
    {
      name: "the PATH last",
      prepare: () => writeFakeBcct(onPath(), logDir),
      extra: () => ({}),
      expected: onPath,
    },
    {
      name: "past the invalid ones",
      prepare: () => {
        writeFakeBcct(configBin, logDir, { version: "other 1.0.0" });
        writeFakeBcct(onPath(), logDir);
      },
      extra: () => ({ BETTER_CC_TELEGRAM_BIN: join(workDir, "missing") }),
      expected: onPath,
    },
  ];

  it.each(CASES)("$name", ({ prepare, extra, expected }) => {
    prepare();

    const env = hookEnv({ extra: extra() });

    runBcctHook("stop", { env });
    spawnSync("sh", [SHIM, "hook", "stop"], { env, input: "{}" });

    expect(readCalls(logDir).map(({ program }) => program)).toEqual([
      expected(),
      expected(),
    ]);
  });
});
