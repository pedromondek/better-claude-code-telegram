import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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

import { MESSAGES } from "../../plugins/telegram-hooks/lib/messages.mjs";
import { statuslineCommand } from "../setup.mjs";

const LAUNCHER = join(import.meta.dirname, "..", "telegram.sh");

let workDir;
let stateDir;
let fakeBinDir;
let callFile;

function writeSetupDone() {
  writeFileSync(join(stateDir, ".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n");
  writeFileSync(
    join(stateDir, "access.json"),
    JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["42"] }),
  );
}

function writeLanguage(language) {
  const appDir = join(workDir, "claude", "better-claude-code-telegram");

  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, "better-cc-telegram.json"),
    JSON.stringify({ language }),
  );
}

function runLauncher(args = []) {
  return spawnSync("bash", [LAUNCHER, ...args], {
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      HOME: join(workDir, "home"),
      CLAUDE_CONFIG_DIR: join(workDir, "claude"),
      TELEGRAM_STATE_DIR: stateDir,
    },
    encoding: "utf8",
  });
}

function readCall() {
  return JSON.parse(readFileSync(callFile, "utf8"));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-"));
  stateDir = join(workDir, "state");
  fakeBinDir = join(workDir, "bin");
  callFile = join(workDir, "claude-call.json");
  mkdirSync(stateDir);
  mkdirSync(fakeBinDir);
  mkdirSync(join(workDir, "home"));
  mkdirSync(join(workDir, "claude"));
  writeFileSync(
    join(fakeBinDir, "claude"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(callFile)}, JSON.stringify({ args: process.argv.slice(2), betterCcTelegram: process.env.BETTER_CC_TELEGRAM }));\n`,
  );
  chmodSync(join(fakeBinDir, "claude"), 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("telegram.sh", () => {
  it("stops and says to run the setup when it was not done, in en-us, without opening claude", () => {
    const result = runLauncher();

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing:\n {2}• bot token, pairing/u);
    expect(result.stderr).toMatch(/npm run setup/);
    expect(existsSync(callFile)).toBe(false);
  });

  it("stops and says to run the setup when it was not done, in pt-br, without opening claude", () => {
    writeLanguage("pt-br");

    const result = runLauncher();

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Falta:\n {2}• token do bot, pareamento/u);
    expect(result.stderr).toMatch(/npm run setup/);
    expect(existsSync(callFile)).toBe(false);
  });

  it("with setup done, opens claude with the channel, the name and the dev arguments", () => {
    writeSetupDone();

    const result = runLauncher(["--continue"]);

    expect(result.status).toBe(0);
    expect(readCall()).toEqual({
      args: [
        "--name",
        "telegram",
        "--settings",
        '{"enabledPlugins":{"telegram@better-claude-code-telegram":true}}',
        "--dangerously-load-development-channels",
        "plugin:telegram@better-claude-code-telegram",
        "--continue",
      ],
      betterCcTelegram: "1",
    });
  });

  it("notes when it opened claude, so the status line can say it is connecting", () => {
    writeSetupDone();
    const before = Date.now();

    expect(runLauncher().status).toBe(0);

    const { launchedAt } = JSON.parse(
      readFileSync(
        join(workDir, "claude", "better-claude-code-telegram", "launch.json"),
        "utf8",
      ),
    );

    expect(launchedAt).toBeGreaterThanOrEqual(before);
    expect(launchedAt).toBeLessThanOrEqual(Date.now());
  });

  it("does not note a launch when the setup check stops it", () => {
    expect(runLauncher().status).toBe(1);
    expect(
      existsSync(
        join(workDir, "claude", "better-claude-code-telegram", "launch.json"),
      ),
    ).toBe(false);
  });

  describe("with a request to fit the indicator into the status line of the user", () => {
    const mine = { type: "command", command: "~/bin/my-line.sh" };
    let appDir;
    let requestFile;

    beforeEach(() => {
      writeSetupDone();
      writeLanguage("pt-br");
      appDir = join(workDir, "claude", "better-claude-code-telegram");
      requestFile = join(appDir, "statusline-customize.json");
      writeFileSync(
        join(workDir, "claude", "settings.json"),
        JSON.stringify({ statusLine: mine }),
      );
      writeFileSync(requestFile, "{}");
    });

    it("hands the request to claude as the first prompt, before the channel, once", () => {
      const PT = MESSAGES["pt-br"];

      expect(runLauncher(["--continue"]).status).toBe(0);
      expect(readCall().args.slice(0, 4)).toEqual([
        "--name",
        "telegram",
        PT.statuslineCustomPrompt(
          join(workDir, "claude", "settings.json"),
          JSON.stringify(mine),
          statuslineCommand(),
          PT.statusConnected(PT.statusMain),
        ),
        "--settings",
      ]);
      expect(readCall().args.at(-1)).toBe("--continue");
      expect(existsSync(requestFile)).toBe(false);

      runLauncher();

      expect(readCall().args[2]).toBe("--settings");
    });

    it("keeps the request for later when the arguments may already carry a prompt or a value", () => {
      expect(runLauncher(["--model", "opus"]).status).toBe(0);
      expect(readCall().args[2]).toBe("--settings");
      expect(existsSync(requestFile)).toBe(true);
    });
  });

  it("refuses to open with the permission checks turned off, without opening claude", () => {
    writeSetupDone();

    const result = runLauncher([
      "--continue",
      "--dangerously-skip-permissions",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      MESSAGES["en-us"].permissionsSkipped("--dangerously-skip-permissions"),
    );
    expect(existsSync(callFile)).toBe(false);
  });

  it("refuses to open a second instance with the bot up", async () => {
    writeSetupDone();

    const bot = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000)",
      "server.ts",
    ]);

    try {
      writeFileSync(join(stateDir, "bot.pid"), String(bot.pid));

      const result = runLauncher();

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /A 'claude --telegram' instance is already open/,
      );
      expect(existsSync(callFile)).toBe(false);
    } finally {
      bot.kill();
    }
  });

  it("refuses to open a second instance with the bot up, in pt-br", async () => {
    writeSetupDone();
    writeLanguage("pt-br");

    const bot = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000)",
      "server.ts",
    ]);

    try {
      writeFileSync(join(stateDir, "bot.pid"), String(bot.pid));

      const result = runLauncher();

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /Já existe uma instância do 'claude --telegram' aberta/,
      );
      expect(existsSync(callFile)).toBe(false);
    } finally {
      bot.kill();
    }
  });
});
