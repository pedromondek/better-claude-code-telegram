import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PLUGIN_ROOT = join(import.meta.dirname, "..");
const HOOKS_JSON = join(PLUGIN_ROOT, "hooks", "hooks.json");
const HOOK_CALL = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/telegram\.mjs" (\w+)/;

let stateDir;
let homeDir;
let appDir;

function loadHooks() {
  return JSON.parse(readFileSync(HOOKS_JSON, "utf8")).hooks;
}

function commandsOf(event) {
  return loadHooks()[event].flatMap((group) =>
    group.hooks.map((hook) => hook.command),
  );
}

function telegramCommand(event, mode) {
  return commandsOf(event).find((command) =>
    command.includes(`telegram.mjs" ${mode}`),
  );
}

function activityCommand(event) {
  return commandsOf(event).find((command) => command.includes("last-activity"));
}

function runCommand(command, { telegram, input = "{}", extraEnv = {} }) {
  const env = {
    ...process.env,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    TELEGRAM_STATE_DIR: stateDir,
  };

  delete env.BETTER_CC_TELEGRAM;
  delete env.BETTER_CC_TELEGRAM_DIR;
  Object.assign(env, extraEnv);

  if (telegram) env.BETTER_CC_TELEGRAM = "1";

  return spawnSync("bash", ["-c", command], { env, input, encoding: "utf8" });
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bcct-state-"));
  homeDir = mkdtempSync(join(tmpdir(), "bcct-home-"));
  appDir = join(homeDir, ".claude", "better-claude-code-telegram");
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("hooks.json structure", () => {
  it("is valid JSON with a hooks object", () => {
    expect(typeof loadHooks()).toBe("object");
  });

  it("covers PermissionRequest, UserPromptSubmit, PostToolUse and Stop", () => {
    expect(Object.keys(loadHooks()).toSorted()).toEqual([
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
  });

  it("registers PermissionRequest for AskUserQuestion in permission mode with a 86400 timeout", () => {
    const [group, ...others] = loadHooks().PermissionRequest;

    expect(others).toEqual([]);
    expect(group.matcher).toBe("AskUserQuestion");
    expect(group.hooks).toHaveLength(1);
    expect(group.hooks[0].type).toBe("command");
    expect(group.hooks[0].timeout).toBe(86400);
    expect(group.hooks[0].command).toMatch(HOOK_CALL);
    expect(group.hooks[0].command.match(HOOK_CALL)[1]).toBe("permission");
  });

  it("registers UserPromptSubmit in prompt mode", () => {
    expect(commandsOf("UserPromptSubmit")).toHaveLength(1);
    expect(telegramCommand("UserPromptSubmit", "prompt")).toBeDefined();
  });

  it("registers PostToolUse for AskUserQuestion in post mode and an activity marker for every tool", () => {
    const [askGroup, activityGroup, ...others] = loadHooks().PostToolUse;

    expect(others).toEqual([]);
    expect(askGroup.matcher).toBe("AskUserQuestion");
    expect(askGroup.hooks[0].command.match(HOOK_CALL)[1]).toBe("post");
    expect(activityGroup.matcher).toBeUndefined();
    expect(activityGroup.hooks[0].command).toContain("last-activity");
    expect(activityGroup.hooks[0].command).not.toContain("telegram.mjs");
  });

  it("registers Stop in stop mode followed by the activity marker", () => {
    const commands = commandsOf("Stop");

    expect(commands).toHaveLength(2);
    expect(commands[0].match(HOOK_CALL)[1]).toBe("stop");
    expect(commands[1]).toContain("last-activity");
  });

  it("makes every command that calls telegram.mjs use CLAUDE_PLUGIN_ROOT with a known mode", () => {
    const modes = [];

    for (const event of Object.keys(loadHooks())) {
      for (const command of commandsOf(event)) {
        if (!command.includes("telegram.mjs")) continue;

        const match = command.match(HOOK_CALL);

        expect(match).not.toBeNull();
        modes.push(match[1]);
      }
    }

    expect(modes.toSorted()).toEqual(["permission", "post", "prompt", "stop"]);
  });

  it("gates every telegram.mjs command on BETTER_CC_TELEGRAM or a bot.pid and never fails", () => {
    for (const event of Object.keys(loadHooks())) {
      for (const command of commandsOf(event)) {
        if (!command.includes("telegram.mjs")) continue;

        expect(command).toContain('[ "$BETTER_CC_TELEGRAM" = 1 ]');
        expect(command).toContain("bot.pid");
        expect(command.endsWith("|| true")).toBe(true);
      }
    }
  });

  it("resolves scripts through the plugin root, never through the project directory", () => {
    const raw = readFileSync(HOOKS_JSON, "utf8");

    expect(raw).not.toContain("CLAUDE_PROJECT_DIR");
    expect(raw).not.toContain(".claude/hooks");
  });
});

describe("hooks.json commands run with bash -c", () => {
  it("exits 0 without creating anything when BETTER_CC_TELEGRAM is unset and there is no bot.pid", () => {
    const result = runCommand(telegramCommand("Stop", "stop"), {
      telegram: false,
      input: JSON.stringify({
        session_id: "s1",
        last_assistant_message: "waiting",
      }),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("exits 0 for the permission command too when the gate is closed", () => {
    const result = runCommand(
      telegramCommand("PermissionRequest", "permission"),
      {
        telegram: false,
      },
    );

    expect(result.status).toBe(0);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("writes the waiting ping to the pings of the app folder, out of the channel folder, when BETTER_CC_TELEGRAM is 1", () => {
    const result = runCommand(telegramCommand("Stop", "stop"), {
      telegram: true,
      input: JSON.stringify({
        session_id: "s1",
        last_assistant_message: "  waiting for you  ",
      }),
    });

    expect(result.status).toBe(0);
    expect(readdirSync(stateDir)).toEqual([]);

    const ping = JSON.parse(
      readFileSync(join(appDir, "pings", "s1.json"), "utf8"),
    );

    expect(ping.sessionId).toBe("s1");
    expect(ping.text).toBe("waiting for you");
  });

  it("writes the last-activity marker to the app folder only when BETTER_CC_TELEGRAM is 1", () => {
    const command = activityCommand("PostToolUse");

    expect(runCommand(command, { telegram: false }).status).toBe(0);
    expect(existsSync(appDir)).toBe(false);

    expect(runCommand(command, { telegram: true }).status).toBe(0);
    expect(readdirSync(stateDir)).toEqual([]);

    const marker = readFileSync(join(appDir, "pings", "last-activity"), "utf8");

    expect(marker.trim()).toMatch(/^\d{13}$/);
  });

  it("follows BETTER_CC_TELEGRAM_DIR for the last-activity marker", () => {
    const customDir = join(homeDir, "custom-app");

    expect(
      runCommand(activityCommand("Stop"), {
        telegram: true,
        extraEnv: { BETTER_CC_TELEGRAM_DIR: customDir },
      }).status,
    ).toBe(0);
    expect(existsSync(join(customDir, "pings", "last-activity"))).toBe(true);
  });
});
