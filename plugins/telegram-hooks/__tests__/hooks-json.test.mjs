import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const ROOT_DIR = join(PLUGIN_ROOT, "..", "..");
const HOOKS = join(PLUGIN_ROOT, "hooks", "hooks.json");
const MODES = ["permission", "prompt", "post", "stop"];
const GUARD =
  '[ "$BETTER_CC_TELEGRAM" = 1 ] || [ -f "${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}/bot.pid" ]';
const ACTIVITY =
  '[ "$BETTER_CC_TELEGRAM" = 1 ] && d="${BETTER_CC_TELEGRAM_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/better-claude-code-telegram}/pings" && mkdir -p "$d" && date +%s%3N > "$d/last-activity" 2>/dev/null || true';

let workDir;
let stateDir;
let logDir;
let binDir;
let appDir;
let appBin;

function telegramHook(mode) {
  return `if { ${GUARD}; }; then "\${CLAUDE_PLUGIN_ROOT}/scripts/bcct" hook ${mode}; fi`;
}

function hooks() {
  return JSON.parse(readFileSync(HOOKS, "utf8")).hooks;
}

function env({ telegram = true, extra = {} } = {}) {
  return {
    PATH: sandboxPath(binDir),
    HOME: join(workDir, "home"),
    CLAUDE_CONFIG_DIR: join(workDir, "config"),
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    TELEGRAM_STATE_DIR: stateDir,
    ...(telegram ? { BETTER_CC_TELEGRAM: "1" } : {}),
    ...extra,
  };
}

function run(shell, command, options = {}) {
  return spawnSync(shell, ["-c", command], {
    env: env(options),
    input: options.input ?? '{"session_id":"s1"}',
    encoding: "utf8",
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-hooks-json-"));
  stateDir = join(workDir, "state");
  logDir = join(workDir, "log");
  binDir = join(workDir, "bin");
  appDir = join(workDir, "config", "better-claude-code-telegram");
  appBin = join(appDir, "bin", "bcct");

  for (const folder of [stateDir, logDir, binDir, join(workDir, "home")]) {
    mkdirSync(folder, { recursive: true });
  }
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("hooks.json", () => {
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
    expect(existsSync(join(PLUGIN_ROOT, "hooks", "hooks.bcct.json"))).toBe(
      false,
    );
  });

  it("runs the binary through the script of the plugin, behind the Telegram guard", () => {
    expect(hooks()).toEqual({
      PermissionRequest: [
        {
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command: telegramHook("permission"),
              timeout: 86400,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: telegramHook("prompt") }] },
      ],
      PostToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [{ type: "command", command: telegramHook("post") }],
        },
        { hooks: [{ type: "command", command: ACTIVITY }] },
      ],
      Stop: [
        {
          hooks: [
            { type: "command", command: telegramHook("stop") },
            { type: "command", command: ACTIVITY },
          ],
        },
      ],
    });
  });

  it("never runs node nor hides a failure of the binary", () => {
    const raw = readFileSync(HOOKS, "utf8");

    expect(raw).not.toContain("node ");
    expect(raw).not.toContain("telegram.mjs");
    expect(raw).not.toContain("../");
    expect(raw).not.toContain("CLAUDE_PROJECT_DIR");

    for (const mode of MODES) {
      expect(telegramHook(mode)).not.toContain("2>/dev/null");
      expect(telegramHook(mode)).not.toContain("|| true");
    }
  });

  it("only calls modes that the bcct of this repository has", () => {
    const rust = join(ROOT_DIR, "rust", "crates", "bcct", "src");

    for (const mode of MODES) {
      expect(readFileSync(join(rust, "hook.rs"), "utf8")).toContain(
        `"${mode}" => Some(Self::`,
      );
    }

    expect(readFileSync(join(rust, "lib.rs"), "utf8")).toContain(
      'Some("hook") =>',
    );
  });
});

describe.each(["sh", "bash"])("the Telegram hooks under %s", (shell) => {
  it.each(MODES)(
    "%s does nothing and ends with 0 when Telegram is off",
    (mode) => {
      writeFakeBcct(appBin, logDir);

      const result = run(shell, telegramHook(mode), { telegram: false });

      expect([result.status, result.stdout, result.stderr]).toEqual([
        0,
        "",
        "",
      ]);
      expect(readCalls(logDir)).toEqual([]);
    },
  );

  it.each(MODES)(
    "%s runs bcct hook with the stdin, its output and its exit code",
    (mode) => {
      writeFakeBcct(appBin, logDir, { exit: 3, stdout: '{"ok":1}' });

      const result = run(shell, telegramHook(mode), {
        input: '{"session_id":"s9"}',
      });

      expect(result.status).toBe(3);
      expect(result.stdout).toBe('{"ok":1}');
      expect(result.stderr).toBe("bcct-stderr\n");
      expect(
        readCalls(logDir).map(({ program, args }) => [program, args]),
      ).toEqual([[appBin, ["hook", mode]]]);
      expect(readLog(logDir, "stdin")).toBe('{"session_id":"s9"}');
    },
  );

  it("opens the guard with a bot.pid even without the variable", () => {
    writeFakeBcct(appBin, logDir);
    writeFileSync(join(stateDir, "bot.pid"), String(process.pid));

    const result = run(shell, telegramHook("stop"), { telegram: false });

    expect(result.status).toBe(0);
    expect(readCalls(logDir).map(({ args }) => args)).toEqual([
      ["hook", "stop"],
    ]);
  });

  it.each(MODES)(
    "%s says how to install when bcct is missing, with 1 so it never blocks the session",
    (mode) => {
      const result = run(shell, telegramHook(mode));

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        [
          `bcct: not installed (no launcher in ${appDir}/bin). Run: npx better-claude-code-telegram`,
          `bcct: não instalado (sem launcher em ${appDir}/bin). Rode: npx better-claude-code-telegram`,
          "",
        ].join("\n"),
      );
    },
  );

  it("writes the last-activity marker to the app folder only when BETTER_CC_TELEGRAM is 1", () => {
    expect(run(shell, ACTIVITY, { telegram: false }).status).toBe(0);
    expect(existsSync(appDir)).toBe(false);

    expect(run(shell, ACTIVITY).status).toBe(0);
    expect(
      readFileSync(join(appDir, "pings", "last-activity"), "utf8").trim(),
    ).toMatch(/^\d{13}$/);
  });

  it("follows BETTER_CC_TELEGRAM_DIR for the last-activity marker", () => {
    const customDir = join(workDir, "custom-app");

    expect(
      run(shell, ACTIVITY, { extra: { BETTER_CC_TELEGRAM_DIR: customDir } })
        .status,
    ).toBe(0);
    expect(existsSync(join(customDir, "pings", "last-activity"))).toBe(true);
  });
});
