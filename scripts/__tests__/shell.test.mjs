import { spawnSync } from "node:child_process";
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

const SHELL_FILE = join(import.meta.dirname, "..", "shell.sh");

const hasZsh =
  spawnSync("zsh", ["--version"], { stdio: "ignore" }).status === 0;

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

function runInShell(shell, claudeArgs) {
  return spawnSync(shell, ["-c", `. "${SHELL_FILE}"; claude ${claudeArgs}`], {
    cwd: workDir,
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
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(callFile)}, JSON.stringify({ args: process.argv.slice(2), betterCcTelegram: process.env.BETTER_CC_TELEGRAM ?? null }));\n`,
  );
  chmodSync(join(fakeBinDir, "claude"), 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function defineShellCases(shell) {
  it("claude --telegram --continue calls the launcher with --continue and without --telegram", () => {
    writeSetupDone();

    const result = runInShell(shell, "--telegram --continue");

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

  it("claude --telegram goes through the launcher setup check and does not open claude when setup is missing", () => {
    const result = runInShell(shell, "--telegram --continue");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing:\n {2}• bot token, pairing/u);
    expect(existsSync(callFile)).toBe(false);
  });

  it("claude without --telegram calls the real claude with the arguments intact", () => {
    const result = runInShell(shell, "--continue --model opus 'two words'");

    expect(result.status).toBe(0);
    expect(readCall()).toEqual({
      args: ["--continue", "--model", "opus", "two words"],
      betterCcTelegram: null,
    });
  });
}

describe("shell.sh loaded by bash", () => {
  defineShellCases("bash");
});

describe.skipIf(!hasZsh)(
  "shell.sh loaded by zsh (skipped when zsh is not installed)",
  () => {
    defineShellCases("zsh");
  },
);
