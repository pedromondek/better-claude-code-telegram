import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MESSAGES } from "../../plugins/telegram-hooks/lib/messages.mjs";
import {
  DEFAULT_DELAY_MINUTES,
  MERMAID_UNINSTALL_COMMAND,
  huggingFaceCacheDir,
  guardCancel,
  offerUndo,
  BCCT_PLUGIN_ID,
  CHANNEL_PLUGIN_ID,
  HOOKS_PLUGIN_ID,
  MARKETPLACE_NAME,
  PLUGIN_IDS,
  SETUP_COMMAND,
  SETUP_SECTIONS,
  SHELL_MARKER,
  buildAccess,
  checkSetup,
  createPrompter,
  createTelegramApi,
  ensureRequirements,
  envDenyRule,
  findPairingCandidate,
  formatQuietHours,
  installerFor,
  installShellFunction,
  isPaired,
  lastUpdateId,
  missingSetupSteps,
  nodeVersionOk,
  pairingCode,
  pairingLink,
  parseDelayMinutes,
  parseEnvToken,
  parseLocale,
  parseQuietHours,
  parseSetupSections,
  parseTranscriptionModel,
  rcLoadsShellFile,
  currentState,
  readSettings,
  shellRcFiles,
  skippedPermissions,
  sourceLine,
  statuslineAfterCommand,
  statuslineCommand,
  suggestedLocale,
  telegramApiRoot,
  telegramInstanceRunning,
  telegramStateDir,
  uninstall,
  withEnvDenied,
  withoutEnvDenied,
  withoutShellBlock,
  withShellBlock,
  withStatusline,
  writeJsonAtomic,
  askDelay,
  askInbox,
  askLanguage,
  askQuietHours,
  askStatuslineChoice,
  askTranscription,
  askRemoveModels,
  askYesNo,
  parseTime,
  pluginPlan,
} from "../setup.mjs";
import { createJournal } from "../journal.mjs";
import { fail, info, newValue, note, skipped, success, warn } from "../ui.mjs";

const TOKEN = "123456:SECRET-TOKEN";
const ROOT_DIR = join(import.meta.dirname, "..", "..");
const SETUP = join(ROOT_DIR, "scripts", "setup.mjs");
const CONFIG_NAME = "better-cc-telegram.json";
const SECTIONS_LIST =
  "language, plugin, token, pairing, delay, quiet-hours, transcription, inbox, statusline";

let workDir;
let stateDir;
let appDir;
let homeDir;
let configDir;

function fetchAnswering(body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { json: async () => body };
  };
  return { fetchImpl, calls };
}

function privateMessage(updateId, from) {
  return { update_id: updateId, message: { chat: { type: "private" }, from } };
}

function runSetup(args, input, env = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    input,
    env: {
      PATH: process.env.PATH,
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: configDir,
      TELEGRAM_STATE_DIR: stateDir,
      BETTER_CC_TELEGRAM_DIR: appDir,
      LANG: "C",
      ...env,
    },
    encoding: "utf8",
  });
}

function writeConfig(config) {
  writeFileSync(join(appDir, CONFIG_NAME), JSON.stringify(config));
}

function readConfig() {
  return JSON.parse(readFileSync(join(appDir, CONFIG_NAME), "utf8"));
}

function writeSetupDone({ token = true, paired = true } = {}) {
  if (token) {
    writeFileSync(join(stateDir, ".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n");
  }

  if (paired) {
    writeFileSync(
      join(stateDir, "access.json"),
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["42"] }),
    );
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-"));
  stateDir = join(workDir, "state");
  appDir = join(workDir, "app");
  homeDir = join(workDir, "home");
  configDir = join(workDir, "claude");
  mkdirSync(stateDir);
  mkdirSync(appDir);
  mkdirSync(homeDir);
  mkdirSync(configDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("constants", () => {
  it("MARKETPLACE_NAME, the plugin ids and SETUP_COMMAND name the repo plugins and the setup script", () => {
    expect(MARKETPLACE_NAME).toBe("better-claude-code-telegram");
    expect(CHANNEL_PLUGIN_ID).toBe("telegram@better-claude-code-telegram");
    expect(HOOKS_PLUGIN_ID).toBe("telegram-hooks@better-claude-code-telegram");
    expect(BCCT_PLUGIN_ID).toBe("bcct@better-claude-code-telegram");
    expect(SETUP_COMMAND).toBe("npm run setup");
  });

  it("names every plugin of the marketplace, and only them", () => {
    const marketplace = JSON.parse(
      readFileSync(
        join(ROOT_DIR, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
    );

    expect(
      marketplace.plugins.map(({ name }) => `${name}@${marketplace.name}`),
    ).toEqual([CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID, BCCT_PLUGIN_ID]);
  });
});

describe("telegramStateDir", () => {
  it("returns TELEGRAM_STATE_DIR when set, like the plugin", () => {
    expect(telegramStateDir({ TELEGRAM_STATE_DIR: "/state" })).toBe("/state");
  });

  it("starts from CLAUDE_CONFIG_DIR when set", () => {
    expect(telegramStateDir({ CLAUDE_CONFIG_DIR: "/config" })).toBe(
      "/config/channels/telegram",
    );
  });

  it("treats an empty variable as absent, like the launcher shell", () => {
    expect(
      telegramStateDir({
        TELEGRAM_STATE_DIR: "",
        CLAUDE_CONFIG_DIR: "/config",
      }),
    ).toBe("/config/channels/telegram");
    expect(
      telegramStateDir({
        TELEGRAM_STATE_DIR: "",
        CLAUDE_CONFIG_DIR: "",
      }).endsWith("/.claude/channels/telegram"),
    ).toBe(true);
  });
});

describe("parseSetupSections", () => {
  it("returns every step in order when called without arguments", () => {
    expect(parseSetupSections([])).toEqual(SETUP_SECTIONS);
  });

  it("lists the steps as language, plugin, token, pairing, delay, quiet-hours, transcription, inbox, statusline", () => {
    expect(SETUP_SECTIONS.join(", ")).toBe(SECTIONS_LIST);
  });

  it("returns only the requested steps, always in setup order", () => {
    expect(parseSetupSections(["quiet-hours", "Delay"])).toEqual([
      "delay",
      "quiet-hours",
    ]);
  });

  it("rejects an unknown step and lists the valid ones in en-us by default", () => {
    expect(() => parseSetupSections(["delay", "modelo"])).toThrow(
      `Unknown step:\n  • modelo\nUse one or more of these (none runs them all):\n  • ${SECTIONS_LIST}`,
    );
  });

  it("rejects an unknown step in pt-br when given the pt-br catalog", () => {
    expect(() =>
      parseSetupSections(["delay", "modelo"], MESSAGES["pt-br"]),
    ).toThrow(
      `Etapa desconhecida:\n  • modelo\nUse uma ou mais destas (sem nenhuma, roda todas):\n  • ${SECTIONS_LIST}`,
    );
  });

  it("maps every step to its own setup:<step> script in package.json", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(ROOT_DIR, "package.json"), "utf8"),
    );

    expect(scripts.setup).toBe(
      "node -r ./scripts/require-node.cjs scripts/setup.mjs",
    );

    for (const section of SETUP_SECTIONS) {
      expect(scripts[`setup:${section}`]).toBe(
        `node -r ./scripts/require-node.cjs scripts/setup.mjs ${section}`,
      );
    }
  });
});

describe("parseLocale", () => {
  it("accepts a known locale case-insensitively, with underscore or hyphen", () => {
    expect(parseLocale("pt-br", "en-us")).toBe("pt-br");
    expect(parseLocale("PT_BR", "en-us")).toBe("pt-br");
    expect(parseLocale("  en-US  ", "pt-br")).toBe("en-us");
  });

  it("keeps the current locale on an empty or unknown answer", () => {
    expect(parseLocale("", "pt-br")).toBe("pt-br");
    expect(parseLocale("fr-fr", "en-us")).toBe("en-us");
    expect(parseLocale("pt", "en-us")).toBe("en-us");
  });
});

describe("suggestedLocale", () => {
  it("turns LANG=pt_BR.UTF-8 into pt-br", () => {
    expect(suggestedLocale({ LANG: "pt_BR.UTF-8" })).toBe("pt-br");
  });

  it("turns LANG=en_US.UTF-8 into en-us", () => {
    expect(suggestedLocale({ LANG: "en_US.UTF-8" })).toBe("en-us");
  });

  it("prefers LC_ALL, then LC_MESSAGES, over LANG, skipping empty ones", () => {
    expect(
      suggestedLocale({ LC_ALL: "pt_BR.UTF-8", LANG: "en_US.UTF-8" }),
    ).toBe("pt-br");
    expect(
      suggestedLocale({ LC_MESSAGES: "pt_BR.UTF-8", LANG: "en_US.UTF-8" }),
    ).toBe("pt-br");
    expect(suggestedLocale({ LC_ALL: "", LANG: "pt_BR.UTF-8" })).toBe("pt-br");
  });

  it("falls back to en-us for an unknown or missing locale", () => {
    expect(suggestedLocale({ LANG: "fr_FR.UTF-8" })).toBe("en-us");
    expect(suggestedLocale({ LANG: "C" })).toBe("en-us");
    expect(suggestedLocale({})).toBe("en-us");
  });
});

describe("parseTranscriptionModel", () => {
  it("keeps the current on Enter, turns off on 'não' and accepts only known models", () => {
    expect(parseTranscriptionModel("", "small")).toBe("small");
    expect(parseTranscriptionModel("não", "small")).toBeNull();
    expect(parseTranscriptionModel("Medium", "small")).toBe("medium");
    expect(parseTranscriptionModel("large", "small")).toBe("small");
    expect(parseTranscriptionModel("", null)).toBeNull();
  });

  it("turns off on the en-us answers no, none and off", () => {
    expect(parseTranscriptionModel("no", "small")).toBeNull();
    expect(parseTranscriptionModel("None", "small")).toBeNull();
    expect(parseTranscriptionModel("OFF", "small")).toBeNull();
  });
});

describe("parseQuietHours and formatQuietHours", () => {
  const current = { start: "22:00", end: "08:00" };

  it("keeps the current on Enter and turns off on 'não'", () => {
    expect(parseQuietHours("", current)).toEqual(current);
    expect(parseQuietHours("não", current)).toBeNull();
    expect(parseQuietHours("NENHUM", current)).toBeNull();
  });

  it("turns off on the en-us answers no, none, off and 0", () => {
    expect(parseQuietHours("no", current)).toBeNull();
    expect(parseQuietHours("None", current)).toBeNull();
    expect(parseQuietHours("OFF", current)).toBeNull();
    expect(parseQuietHours("0", current)).toBeNull();
  });

  it("accepts the interval with or without spaces", () => {
    expect(parseQuietHours("23:30 - 07:15", null)).toEqual({
      start: "23:30",
      end: "07:15",
    });
  });

  it("rejects an invalid time or equal start and end, keeping the current", () => {
    expect(parseQuietHours("25:00-08:00", current)).toEqual(current);
    expect(parseQuietHours("8-22", current)).toEqual(current);
    expect(parseQuietHours("08:00-08:00", current)).toEqual(current);
  });

  it("formats the interval to show in the setup", () => {
    expect(formatQuietHours(current)).toBe("22:00-08:00");
    expect(formatQuietHours(null)).toBe("");
  });
});

describe("parseDelayMinutes", () => {
  it("keeps the suggested value on Enter", () => {
    expect(parseDelayMinutes("", 3)).toBe(3);
    expect(parseDelayMinutes("   ", 7)).toBe(7);
  });

  it("accepts integers and decimals with comma or dot", () => {
    expect(parseDelayMinutes("5", 3)).toBe(5);
    expect(parseDelayMinutes("1,5", 3)).toBe(1.5);
    expect(parseDelayMinutes("0.5", 3)).toBe(0.5);
  });

  it("rejects zero, negative and text, keeping the suggested value", () => {
    expect(parseDelayMinutes("0", 3)).toBe(3);
    expect(parseDelayMinutes("-2", 3)).toBe(3);
    expect(parseDelayMinutes("abc", 3)).toBe(3);
  });
});

describe("parseEnvToken", () => {
  it("reads the token from the TELEGRAM_BOT_TOKEN line", () => {
    expect(parseEnvToken(`OTHER=1\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`)).toBe(TOKEN);
  });

  it("returns null without the token line", () => {
    expect(parseEnvToken("OTHER=1\n")).toBeNull();
  });
});

describe("sourceLine and rcLoadsShellFile", () => {
  it("builds the line that only loads the file when it exists", () => {
    expect(sourceLine("/repo/shell.sh")).toBe(
      '[ -f "/repo/shell.sh" ] && . "/repo/shell.sh"',
    );
  });

  it("recognizes an rc that already loads the file", () => {
    expect(
      rcLoadsShellFile(
        `alias x=y\n${sourceLine("/repo/shell.sh")}\n`,
        "/repo/shell.sh",
      ),
    ).toBe(true);
    expect(rcLoadsShellFile("alias x=y\n", "/repo/shell.sh")).toBe(false);
  });
});

describe("skippedPermissions", () => {
  it("finds every way to turn the permission checks off", () => {
    for (const args of [
      ["--dangerously-skip-permissions"],
      ["--allow-dangerously-skip-permissions"],
      ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=bypassPermissions"],
    ]) {
      expect(skippedPermissions(["--continue", ...args], {})).toBe(
        args.join(" "),
      );
    }

    expect(
      skippedPermissions([], {
        permissions: { defaultMode: "bypassPermissions" },
      }),
    ).toBe("defaultMode bypassPermissions");
  });

  it("lets the modes that still ask or refuse through", () => {
    for (const mode of ["auto", "dontAsk", "acceptEdits", "plan", "manual"]) {
      expect(
        skippedPermissions(["--permission-mode", mode], {
          permissions: { defaultMode: mode },
        }),
      ).toBeNull();
    }
  });
});

describe("nodeVersionOk", () => {
  it("accepts Node 24.11 or newer and refuses anything older", () => {
    for (const version of ["24.11.0", "24.20.0", "25.0.0"]) {
      expect(nodeVersionOk(version)).toBe(true);
    }

    for (const version of ["24.10.9", "22.12.0", "18.0.0"]) {
      expect(nodeVersionOk(version)).toBe(false);
    }
  });
});

describe("installerFor", () => {
  it("uses the official installers with a fixed version and says where each binary lands", () => {
    expect(installerFor("claude", "/h")).toEqual({
      command: "curl -fsSL https://claude.ai/install.sh | bash -s 2.1.303",
      binDir: "/h/.local/bin",
    });
    expect(installerFor("bun", "/h")).toEqual({
      command: 'curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"',
      binDir: "/h/.bun/bin",
    });
    expect(installerFor("uv", "/h")).toEqual({
      command: "curl -LsSf https://astral.sh/uv/0.13.1/install.sh | sh",
      binDir: "/h/.local/bin",
    });
  });
});

describe("ensureRequirements", () => {
  const messages = MESSAGES["en-us"];
  let installed;
  let logged;

  function deps(overrides = {}) {
    return {
      home: "/h",
      env: { PATH: "/usr/bin" },
      hasCommand: (tool) => installed.includes(tool),
      confirm: async () => true,
      runInstaller: (command) => {
        if (command.includes("bun.sh")) installed.push("bun");

        return 0;
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    installed = ["claude"];
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line) => logged.push(line));
  });

  it("asks nothing when every tool is there", async () => {
    installed.push("bun");
    const confirm = vi.fn();

    await ensureRequirements(["claude", "bun"], messages, deps({ confirm }));

    expect(confirm).not.toHaveBeenCalled();
  });

  it("installs a missing tool once the user agrees, showing the command, and puts its folder on the PATH", async () => {
    const prompts = [];
    const options = deps({
      confirm: async (prompt) => {
        prompts.push(prompt);

        return true;
      },
    });

    await ensureRequirements(["claude", "bun"], messages, options);

    expect(prompts).toEqual([
      messages.installToolPrompt("bun", installerFor("bun", "/h").command),
    ]);
    expect(options.env.PATH).toBe("/h/.bun/bin:/usr/bin");
    expect(logged).toEqual([
      success(messages.toolInstalled("bun", "/h/.bun/bin")),
    ]);
  });

  it("stops as a declined choice, with the commands to run by hand, when the user declines", async () => {
    const runInstaller = vi.fn();

    await expect(
      ensureRequirements(
        ["claude", "bun", "uv"],
        messages,
        deps({ confirm: async () => false, runInstaller }),
      ),
    ).rejects.toMatchObject({
      message: messages.toolsDeclined("bun, uv"),
      declined: true,
      hint: messages.byHand,
      commands: [
        installerFor("bun", "/h").command,
        installerFor("uv", "/h").command,
      ],
    });
    expect(runInstaller).not.toHaveBeenCalled();
    expect(MESSAGES["pt-br"].toolsDeclined("bun")).toBe(
      "Nada foi instalado; bun continua faltando no PATH.",
    );
  });

  it("stops when the installer fails", async () => {
    await expect(
      ensureRequirements(["bun"], messages, deps({ runInstaller: () => 1 })),
    ).rejects.toThrow(messages.installFailed("bun"));
  });

  it("stops when the tool is still not found after installing", async () => {
    await expect(
      ensureRequirements(["bun"], messages, deps({ runInstaller: () => 0 })),
    ).rejects.toThrow(messages.toolStillMissing("bun", "/h/.bun/bin"));
  });
});

describe("shellRcFiles", () => {
  function exists(...files) {
    return (file) => files.includes(file);
  }

  it("writes to .zshrc for zsh and to .bashrc for bash, creating it when missing", () => {
    expect(
      shellRcFiles({ home: "/h", shell: "/bin/zsh", exists: exists() }),
    ).toEqual({ primary: "/h/.zshrc", others: [], unsupported: null });
    expect(
      shellRcFiles({ home: "/h", shell: "/usr/bin/bash", exists: exists() }),
    ).toEqual({ primary: "/h/.bashrc", others: [], unsupported: null });
  });

  it("uses .bash_profile for bash on macOS when it exists", () => {
    expect(
      shellRcFiles({
        home: "/h",
        shell: "/bin/bash",
        platform: "darwin",
        exists: exists("/h/.bash_profile"),
      }).primary,
    ).toBe("/h/.bash_profile");
    expect(
      shellRcFiles({
        home: "/h",
        shell: "/bin/bash",
        platform: "darwin",
        exists: exists(),
      }).primary,
    ).toBe("/h/.bashrc");
  });

  it("also writes to the other bash or zsh file only when it already exists", () => {
    expect(
      shellRcFiles({
        home: "/h",
        shell: "/bin/zsh",
        exists: exists("/h/.zshrc", "/h/.bashrc"),
      }).others,
    ).toEqual(["/h/.bashrc"]);
  });

  it("treats a missing SHELL as bash", () => {
    expect(
      shellRcFiles({ home: "/h", shell: "", exists: exists() }).primary,
    ).toBe("/h/.bashrc");
  });

  it("points out a shell that cannot load the function, still covering the bash and zsh files that exist", () => {
    expect(
      shellRcFiles({
        home: "/h",
        shell: "/usr/bin/fish",
        exists: exists("/h/.bashrc"),
      }),
    ).toEqual({ primary: null, others: ["/h/.bashrc"], unsupported: "fish" });
  });
});

describe("withShellBlock", () => {
  const block = `${SHELL_MARKER}\n${sourceLine("/repo/shell.sh")}\n`;

  it("appends the marked line after a blank line, keeping what is there", () => {
    expect(withShellBlock("alias x=y\n", "/repo/shell.sh")).toBe(
      `alias x=y\n\n${block}`,
    );
    expect(withShellBlock("alias x=y", "/repo/shell.sh")).toBe(
      `alias x=y\n\n${block}`,
    );
  });

  it("writes only the marked line to an empty file", () => {
    expect(withShellBlock("", "/repo/shell.sh")).toBe(block);
  });

  it("returns null when the file already loads the function", () => {
    expect(withShellBlock(`x\n${block}`, "/repo/shell.sh")).toBeNull();
  });

  it("appends the marked line when the line that loads the file is commented out", () => {
    const line = sourceLine("/repo/shell.sh");

    expect(withShellBlock(`x=1\n# ${line}\n`, "/repo/shell.sh")).toBe(
      `x=1\n# ${line}\n\n${block}`,
    );
    expect(withShellBlock(`  #${line}`, "/repo/shell.sh")).toBe(
      `  #${line}\n\n${block}`,
    );
    expect(withShellBlock(`# old\n  ${line}\n`, "/repo/shell.sh")).toBeNull();
    expect(
      withShellBlock(`${line}\n# /repo/shell.sh`, "/repo/shell.sh"),
    ).toBeNull();
  });
});

describe("withoutShellBlock", () => {
  const block = `${SHELL_MARKER}\n${sourceLine("/repo/shell.sh")}\n`;

  it("removes the marked line and the blank line the setup added before it", () => {
    expect(withoutShellBlock(`alias x=y\n\n${block}`, "/repo/shell.sh")).toBe(
      "alias x=y\n",
    );
    expect(withoutShellBlock(block, "/repo/shell.sh")).toBe("");
  });

  it("also removes a line that loads the file without the marker", () => {
    expect(
      withoutShellBlock(
        `a\n${sourceLine("/repo/shell.sh")}\nb\n`,
        "/repo/shell.sh",
      ),
    ).toBe("a\nb\n");
  });

  it("returns null when the file does not load the function", () => {
    expect(withoutShellBlock("alias x=y\n", "/repo/shell.sh")).toBeNull();
  });
});

describe("envDenyRule, withEnvDenied and withoutEnvDenied", () => {
  it("writes the rule from the home folder when the file is under it, and absolute otherwise", () => {
    expect(
      envDenyRule("/home/dev/.claude/channels/telegram/.env", "/home/dev"),
    ).toBe("Read(~/.claude/channels/telegram/.env)");
    expect(envDenyRule("/srv/telegram/.env", "/home/dev")).toBe(
      "Read(//srv/telegram/.env)",
    );
  });

  it("writes the rule in the POSIX form Claude Code matches on Windows", () => {
    const win32 = (envFile, home) => envDenyRule(envFile, home, "win32");

    expect(
      win32("C:\\Users\\x\\.claude\\channels\\telegram\\.env", "C:\\Users\\x"),
    ).toBe("Read(~/.claude/channels/telegram/.env)");
    expect(win32("D:\\state\\.env", "C:\\Users\\x")).toBe(
      "Read(//d/state/.env)",
    );
    expect(win32("c:/Users/x/.env", "C:\\Users\\x")).toBe("Read(~/.env)");
    expect(win32("state\\.env", "C:\\Users\\x")).toBe("Read(/state/.env)");
    expect(win32("1:\\state\\.env", "")).toBe("Read(/1:/state/.env)");
    expect(win32("", "")).toBe("Read(/)");
  });

  it("keeps the backslashes and the drive outside Windows", () => {
    expect(envDenyRule("C:\\x\\.env", "C:", "linux")).toBe(
      "Read(/C:\\x\\.env)",
    );
    expect(envDenyRule("/home/dev/.env", "/home/dev", "darwin")).toBe(
      "Read(~/.env)",
    );
  });

  it("adds the rule once, keeping the other permissions", () => {
    const settings = {
      theme: "dark",
      permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf *)"] },
    };
    const denied = withEnvDenied(settings, "Read(~/x/.env)");

    expect(denied).toEqual({
      theme: "dark",
      permissions: {
        allow: ["Bash(ls)"],
        deny: ["Bash(rm -rf *)", "Read(~/x/.env)"],
      },
    });
    expect(withEnvDenied(denied, "Read(~/x/.env)")).toBeNull();
    expect(withEnvDenied({}, "Read(~/x/.env)")).toEqual({
      permissions: { deny: ["Read(~/x/.env)"] },
    });
  });

  it("removes only the rule, and the empty permissions it leaves behind", () => {
    expect(
      withoutEnvDenied(
        { permissions: { deny: ["Bash(rm -rf *)", "Read(~/x/.env)"] } },
        "Read(~/x/.env)",
      ),
    ).toEqual({ permissions: { deny: ["Bash(rm -rf *)"] } });
    expect(
      withoutEnvDenied(
        { theme: "dark", permissions: { deny: ["Read(~/x/.env)"] } },
        "Read(~/x/.env)",
      ),
    ).toEqual({ theme: "dark" });
    expect(withoutEnvDenied({ theme: "dark" }, "Read(~/x/.env)")).toBeNull();
  });
});

describe("uninstall", () => {
  const messages = MESSAGES["en-us"];
  const shellFile = "/repo/shell.sh";
  const block = `${SHELL_MARKER}\n${sourceLine(shellFile)}\n`;
  let settingsFile;
  let claudeCalls;
  let logged;

  function run(overrides = {}) {
    return uninstall(
      {
        stateDir,
        appDir,
        home: homeDir,
        settingsFile,
        shellFile,
        hasClaude: () => true,
        runClaudeCommand: (args) => {
          claudeCalls.push(args);

          return 0;
        },
        confirm: async () => false,
        isRunning: () => null,
        hfCacheDir: join(workDir, "hf"),
        hasMermaid: () => false,
        listInstalled: () => ({
          plugins: PLUGIN_IDS.join("\n"),
          marketplaces: MARKETPLACE_NAME,
        }),
        ...overrides,
      },
      messages,
    );
  }

  it("warns that the status line Claude customized still calls the indicator", async () => {
    writeFileSync(
      join(appDir, CONFIG_NAME),
      JSON.stringify({ statuslineCustomized: true }),
    );

    await run();

    expect(logged).toContain(
      warn(messages.statuslineCustomLeft(statuslineCommand())),
    );
    expect(MESSAGES["pt-br"].statuslineCustomLeft('node "/s.mjs"')).toBe(
      'A sua statusline ainda chama o indicador do Telegram, que o Claude juntou a ela. Peça ao Claude para tirar esta chamada:\n  node "/s.mjs"',
    );
  });

  it("skips, without calling claude, the plugins and the marketplace that are not there", async () => {
    await run({
      listInstalled: () => ({
        plugins: [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID].join("\n"),
        marketplaces: "",
      }),
    });

    expect(claudeCalls).toEqual([
      ["plugin", "uninstall", CHANNEL_PLUGIN_ID, "--scope", "user"],
      ["plugin", "uninstall", HOOKS_PLUGIN_ID, "--scope", "user"],
    ]);
    expect(logged).toEqual(
      expect.arrayContaining([
        success(messages.pluginRemoved(HOOKS_PLUGIN_ID)),
        skipped(messages.pluginNotInstalled(BCCT_PLUGIN_ID)),
        skipped(messages.marketplaceNotRegistered(MARKETPLACE_NAME)),
      ]),
    );
    expect([
      MESSAGES["pt-br"].pluginNotInstalled("x"),
      MESSAGES["pt-br"].marketplaceNotRegistered("m"),
    ]).toEqual([
      "Plugin 'x' não estava instalado.",
      "Marketplace 'm' não estava registrado.",
    ]);
  });

  function writeTranscription() {
    const venvFile = join(appDir, "whisper", "venv", "bin", "python");
    const baseModel = join(
      workDir,
      "hf",
      "models--Systran--faster-whisper-base",
      "model.bin",
    );
    const otherModel = join(workDir, "hf", "models--someone--else", "x.bin");

    for (const file of [venvFile, baseModel, otherModel]) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "x");
    }

    return { otherModel };
  }

  it("asks about the local transcription and removes its Python environment and downloaded models only", async () => {
    const { otherModel } = writeTranscription();
    const prompts = [];

    await run({
      confirm: async (prompt) => {
        prompts.push(prompt);

        return prompt === messages.deleteTranscriptionPrompt;
      },
    });

    expect(prompts[0]).toBe(messages.deleteTranscriptionPrompt);
    expect(logged).toContain(
      messages.transcriptionFound(
        [
          join(appDir, "whisper"),
          join(workDir, "hf", "models--Systran--faster-whisper-base"),
        ].join("\n  • "),
      ),
    );
    expect(existsSync(join(appDir, "whisper"))).toBe(false);
    expect(
      existsSync(join(workDir, "hf", "models--Systran--faster-whisper-base")),
    ).toBe(false);
    expect(existsSync(otherModel)).toBe(true);
    expect(logged).toContain(success(messages.transcriptionRemoved));
  });

  it("keeps the transcription when not confirmed, and does not ask when there is none", async () => {
    writeTranscription();
    const prompts = [];
    const confirm = async (prompt) => {
      prompts.push(prompt);

      return false;
    };

    await run({ confirm });

    expect(existsSync(join(appDir, "whisper"))).toBe(true);
    expect(logged).toContain(messages.transcriptionKept);

    rmSync(join(appDir, "whisper"), { recursive: true });
    rmSync(join(workDir, "hf"), { recursive: true });
    prompts.length = 0;

    await run({ confirm });

    expect(prompts).not.toContain(messages.deleteTranscriptionPrompt);
  });

  it("asks about mmdc, saying the setup did not install it, and removes it with npm only when confirmed", async () => {
    const removeMermaid = vi.fn(() => 0);
    const prompts = [];

    await run({
      hasMermaid: () => true,
      removeMermaid,
      confirm: async (prompt) => {
        prompts.push(prompt);

        return prompt === messages.deleteMermaidPrompt;
      },
    });

    expect(prompts).toContain(messages.deleteMermaidPrompt);
    expect(removeMermaid).toHaveBeenCalledTimes(1);
    expect(logged).toContain(success(messages.mermaidRemoved));

    removeMermaid.mockClear();
    await run({ hasMermaid: () => true, removeMermaid });

    expect(removeMermaid).not.toHaveBeenCalled();
  });

  it("explains how to remove mmdc by hand when npm cannot", async () => {
    await run({
      hasMermaid: () => true,
      removeMermaid: () => 1,
      confirm: async (prompt) => prompt === messages.deleteMermaidPrompt,
    });

    expect(logged).toContain(
      warn(messages.mermaidNotRemoved(MERMAID_UNINSTALL_COMMAND)),
    );
  });

  beforeEach(() => {
    settingsFile = join(configDir, "settings.json");
    claudeCalls = [];
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line) => logged.push(line));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      logged.push(String(chunk).replace(/\n$/u, ""));

      return true;
    });
  });

  it("removes the marked lines, our status line, our deny rule and the plugins, keeping the rest", async () => {
    writeFileSync(join(homeDir, ".bashrc"), `alias x=y\n\n${block}`);
    writeFileSync(join(homeDir, ".zshrc"), block);
    writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: "dark",
        statusLine: { type: "command", command: statuslineCommand() },
        permissions: {
          deny: [
            "Bash(rm -rf *)",
            envDenyRule(join(stateDir, ".env"), homeDir),
          ],
        },
      }),
    );

    await run();

    expect(readFileSync(join(homeDir, ".bashrc"), "utf8")).toBe("alias x=y\n");
    expect(readFileSync(join(homeDir, ".zshrc"), "utf8")).toBe("");
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      theme: "dark",
      permissions: { deny: ["Bash(rm -rf *)"] },
    });
    expect(claudeCalls).toEqual([
      ["plugin", "uninstall", CHANNEL_PLUGIN_ID, "--scope", "user"],
      ["plugin", "uninstall", HOOKS_PLUGIN_ID, "--scope", "user"],
      ["plugin", "uninstall", BCCT_PLUGIN_ID, "--scope", "user"],
      ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
    ]);
    expect(logged).toEqual([
      success(messages.rcNoLongerLoads(join(homeDir, ".bashrc"))),
      success(messages.rcNoLongerLoads(join(homeDir, ".zshrc"))),
      success(messages.statuslineRemoved(settingsFile)),
      success(messages.envRuleRemoved(settingsFile)),
      success(messages.pluginRemoved(CHANNEL_PLUGIN_ID)),
      success(messages.pluginRemoved(HOOKS_PLUGIN_ID)),
      success(messages.pluginRemoved(BCCT_PLUGIN_ID)),
      success(messages.marketplaceRemoved(MARKETPLACE_NAME)),
      messages.stateKept(stateDir, appDir),
      `\n${success(messages.uninstallDone)}`,
    ]);
    expect(readdirSync(workDir)).toEqual(
      expect.arrayContaining(["state", "app"]),
    );
  });

  it("puts back the status line that ours was running after, and forgets the saved copy", async () => {
    const previous = { type: "command", command: "mine", padding: 1 };
    writeFileSync(
      settingsFile,
      JSON.stringify({
        statusLine: { type: "command", command: statuslineAfterCommand() },
      }),
    );
    writeFileSync(
      join(appDir, "statusline-previous.json"),
      JSON.stringify(previous),
    );

    await run();

    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      statusLine: previous,
    });
    expect(readdirSync(appDir)).not.toContain("statusline-previous.json");
    expect(logged).toContain(
      success(messages.statuslineRestored(settingsFile)),
    );
  });

  it("keeps a status line that is not ours", async () => {
    const original = JSON.stringify({
      statusLine: { type: "command", command: "mine" },
    });
    writeFileSync(settingsFile, original);

    await run();

    expect(readFileSync(settingsFile, "utf8")).toBe(original);
    expect(logged).not.toContain(
      success(messages.statuslineRemoved(settingsFile)),
    );
  });

  it("deletes the channel and the app folders only when confirmed, asking about both", async () => {
    const prompts = [];

    await run({
      confirm: async (prompt) => {
        prompts.push(prompt);

        return true;
      },
    });

    expect(prompts).toEqual([messages.deleteStatePrompt(stateDir, appDir)]);
    expect(readdirSync(workDir)).not.toContain("state");
    expect(readdirSync(workDir)).not.toContain("app");
    expect(logged).toContain(success(messages.stateDeleted(stateDir, appDir)));
  });

  it("says a plugin or the marketplace could not be removed, and goes on", async () => {
    await run({ runClaudeCommand: () => 1 });

    expect(logged).toEqual(
      expect.arrayContaining([
        warn(messages.pluginNotRemoved(CHANNEL_PLUGIN_ID)),
        warn(messages.pluginNotRemoved(HOOKS_PLUGIN_ID)),
        warn(messages.pluginNotRemoved(BCCT_PLUGIN_ID)),
        warn(messages.marketplaceNotRemoved(MARKETPLACE_NAME)),
        `\n${success(messages.uninstallDone)}`,
      ]),
    );
  });

  it("explains how to remove the plugins by hand when claude is missing", async () => {
    await run({ hasClaude: () => false });

    expect(claudeCalls).toEqual([]);
    expect(logged).toContain(
      warn(
        messages.claudeMissingForUninstall(
          [
            `claude plugin uninstall ${CHANNEL_PLUGIN_ID}`,
            `claude plugin uninstall ${HOOKS_PLUGIN_ID}`,
            `claude plugin uninstall ${BCCT_PLUGIN_ID}`,
            `claude plugin marketplace remove ${MARKETPLACE_NAME}`,
          ]
            .map((command) => `  ${command}`)
            .join("\n"),
        ),
      ),
    );
  });

  it("changes nothing while the Telegram instance is open", async () => {
    writeFileSync(join(homeDir, ".bashrc"), block);

    await expect(run({ isRunning: () => "4242" })).rejects.toThrow(
      messages.closeInstanceBeforeUninstall,
    );
    expect(readFileSync(join(homeDir, ".bashrc"), "utf8")).toBe(block);
    expect(claudeCalls).toEqual([]);
  });

  it("changes nothing when settings.json is invalid", async () => {
    writeFileSync(join(homeDir, ".bashrc"), block);
    writeFileSync(settingsFile, "{ broken");

    await expect(run()).rejects.toThrow(messages.settingsInvalid(settingsFile));
    expect(readFileSync(join(homeDir, ".bashrc"), "utf8")).toBe(block);
    expect(claudeCalls).toEqual([]);
  });
});

describe("installShellFunction", () => {
  it("creates the rc of the shell with the marked line and does not repeat it on a second run", () => {
    const messages = MESSAGES["en-us"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const rcFile = join(homeDir, ".zshrc");
    const options = { home: homeDir, shell: "/bin/zsh", platform: "linux" };

    installShellFunction(options, messages, "/repo/shell.sh");
    installShellFunction(options, messages, "/repo/shell.sh");

    expect(readFileSync(rcFile, "utf8")).toBe(
      `${SHELL_MARKER}\n${sourceLine("/repo/shell.sh")}\n`,
    );
    expect(log.mock.calls.flat()).toEqual([
      success(messages.rcNowLoads(rcFile)),
      skipped(messages.rcAlreadyLoads(rcFile)),
    ]);
  });

  it("warns how to open the Telegram instance when the shell cannot load the function", () => {
    const messages = MESSAGES["pt-br"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    installShellFunction(
      { home: homeDir, shell: "/usr/bin/fish", platform: "linux" },
      messages,
      "/repo/shell.sh",
    );

    expect(readdirSync(homeDir)).toEqual([]);
    expect(log.mock.calls.flat()).toEqual([
      warn(messages.shellUnsupported("fish", sourceLine("/repo/shell.sh"))),
    ]);
  });
});

describe("statuslineCommand and withStatusline", () => {
  it("statuslineCommand runs the hooks plugin statusline with node by default", () => {
    expect(statuslineCommand()).toBe(
      `node "${join(ROOT_DIR, "plugins", "telegram-hooks", "statusline.mjs")}"`,
    );
  });

  it("statuslineCommand uses the given file", () => {
    expect(statuslineCommand("/x/statusline.mjs")).toBe(
      'node "/x/statusline.mjs"',
    );
  });

  it("withStatusline adds the statusLine and keeps the other settings", () => {
    expect(withStatusline({ theme: "dark" }, "node x")).toEqual({
      theme: "dark",
      statusLine: { type: "command", command: "node x" },
    });
    expect(withStatusline({}, "node x")).toEqual({
      statusLine: { type: "command", command: "node x" },
    });
  });

  it("withStatusline returns null and does not overwrite an existing statusLine", () => {
    const settings = { statusLine: { type: "command", command: "mine" } };

    expect(withStatusline(settings, "node x")).toBeNull();
    expect(settings.statusLine.command).toBe("mine");
  });
});

describe("isPaired", () => {
  it("counts as paired only with at least one account on the allowlist", () => {
    expect(isPaired({ allowFrom: ["1"] })).toBe(true);
    expect(isPaired({ allowFrom: [] })).toBe(false);
    expect(isPaired(null)).toBe(false);
  });
});

describe("buildAccess", () => {
  it("creates the allowlist with the paired account from scratch", () => {
    expect(buildAccess(null, "42")).toEqual({
      dmPolicy: "allowlist",
      allowFrom: ["42"],
      groups: {},
      pending: {},
    });
  });

  it("keeps the rest of the config, clears pending and groups and leaves only the paired account", () => {
    const current = {
      dmPolicy: "pairing",
      allowFrom: ["7", "42"],
      groups: { "-1": { requireMention: true, allowFrom: [] } },
      pending: { abc: {} },
      ackReaction: "eyes",
    };

    expect(buildAccess(current, "99")).toEqual({
      ...current,
      dmPolicy: "allowlist",
      allowFrom: ["99"],
      groups: {},
      pending: {},
    });
  });
});

describe("pairingCode and pairingLink", () => {
  it("makes an 8-character hex code from random bytes", () => {
    expect(pairingCode(() => Buffer.from([0xab, 0xcd, 0xef, 0x01]))).toBe(
      "abcdef01",
    );
    expect(pairingCode()).toMatch(/^[0-9a-f]{8}$/);
    expect(pairingCode()).not.toBe(pairingCode());
  });

  it("links to the bot with the code as the start payload", () => {
    expect(pairingLink("e2e_bot", "abcdef01")).toBe(
      "https://t.me/e2e_bot?start=abcdef01",
    );
  });
});

describe("findPairingCandidate", () => {
  const CODE = "abcdef01";

  function privateText(updateId, from, text) {
    const update = privateMessage(updateId, from);

    update.message.text = text;

    return update;
  }

  it("picks the private message that carries the code through the start link, with the sender @", () => {
    const updates = [
      { update_id: 1, message: { chat: { type: "group" }, from: { id: 9 } } },
      privateText(2, { id: 42, username: "dev" }, `/start ${CODE}`),
    ];

    expect(findPairingCandidate(updates, CODE)).toEqual({
      userId: "42",
      label: "@dev",
      updateId: 2,
    });
  });

  it("accepts the code typed alone, and uses the first name when the sender has no @", () => {
    expect(
      findPairingCandidate(
        [privateText(3, { id: 7, first_name: "Ana" }, `  ${CODE}  `)],
        CODE,
      ).label,
    ).toBe("Ana");
  });

  it("ignores a stranger who writes to the bot without the code", () => {
    const updates = [
      privateText(4, { id: 13, username: "stranger" }, "/start"),
      privateText(5, { id: 13, username: "stranger" }, "hi"),
      privateText(6, { id: 42, username: "dev" }, `/start ${CODE}`),
    ];

    expect(findPairingCandidate(updates, CODE).userId).toBe("42");
    expect(findPairingCandidate(updates.slice(0, 2), CODE)).toBeNull();
  });

  it("returns null without a private message", () => {
    expect(
      findPairingCandidate([{ update_id: 1, callback_query: {} }], CODE),
    ).toBeNull();
  });
});

describe("lastUpdateId", () => {
  it("returns the highest update_id, or -1 without updates", () => {
    expect(
      lastUpdateId([{ update_id: 5 }, { update_id: 9 }, { update_id: 7 }]),
    ).toBe(9);
    expect(lastUpdateId([])).toBe(-1);
  });
});

describe("createTelegramApi", () => {
  it("calls the bot method with JSON params and returns the result", async () => {
    const telegram = fetchAnswering({
      ok: true,
      result: { username: "bcct_bot" },
    });

    const result = await createTelegramApi(TOKEN, telegram.fetchImpl)("getMe", {
      a: 1,
    });

    expect(result).toEqual({ username: "bcct_bot" });
    expect(telegram.calls).toEqual([
      { url: `https://api.telegram.org/bot${TOKEN}/getMe`, body: { a: 1 } },
    ]);
  });

  it("translates the Telegram refusal in en-us by default, without exposing the token", async () => {
    const telegram = fetchAnswering({ ok: false, description: "Unauthorized" });

    const error = await createTelegramApi(
      TOKEN,
      telegram.fetchImpl,
    )("getMe").catch((caught) => caught);

    expect(error.message).toBe("Telegram refused getMe:\n  • Unauthorized");
    expect(error.message.includes(TOKEN)).toBe(false);
  });

  it("translates the Telegram refusal in pt-br with the pt-br catalog", async () => {
    const telegram = fetchAnswering({ ok: false, description: "Unauthorized" });

    const error = await createTelegramApi(
      TOKEN,
      telegram.fetchImpl,
      MESSAGES["pt-br"],
    )("getMe").catch((caught) => caught);

    expect(error.message).toBe("O Telegram recusou getMe:\n  • Unauthorized");
  });

  it("uses the no-description text when Telegram gives none", async () => {
    const telegram = fetchAnswering({ ok: false });

    await expect(
      createTelegramApi(TOKEN, telegram.fetchImpl)("getMe"),
    ).rejects.toThrow("Telegram refused getMe:\n  • no description");
  });

  it("replaces a network failure with a message without the token URL, in en-us", async () => {
    const failingFetch = async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    };

    const error = await createTelegramApi(
      TOKEN,
      failingFetch,
    )("getMe").catch((caught) => caught);

    expect(error.message).toBe("Network failure calling Telegram (getMe).");
    expect(error.message.includes(TOKEN)).toBe(false);
  });

  it("replaces a network failure with a message without the token URL, in pt-br", async () => {
    const failingFetch = async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    };

    const error = await createTelegramApi(
      TOKEN,
      failingFetch,
      MESSAGES["pt-br"],
    )("getMe").catch((caught) => caught);

    expect(error.message).toBe("Falha de rede ao chamar o Telegram (getMe).");
    expect(error.message.includes(TOKEN)).toBe(false);
  });

  it("calls the given API root instead of Telegram", async () => {
    const telegram = fetchAnswering({ ok: true, result: true });

    await createTelegramApi(
      TOKEN,
      telegram.fetchImpl,
      MESSAGES["en-us"],
      "http://127.0.0.1:9999",
    )("getMe");

    expect(telegram.calls[0].url).toBe(
      `http://127.0.0.1:9999/bot${TOKEN}/getMe`,
    );
  });
});

describe("telegramApiRoot", () => {
  it("returns BETTER_CC_TELEGRAM_API_ROOT when set, like the channel server", () => {
    expect(
      telegramApiRoot({ BETTER_CC_TELEGRAM_API_ROOT: "http://127.0.0.1:9999" }),
    ).toBe("http://127.0.0.1:9999");
  });

  it("falls back to Telegram when the variable is missing or empty", () => {
    expect(telegramApiRoot({})).toBe("https://api.telegram.org");
    expect(telegramApiRoot({ BETTER_CC_TELEGRAM_API_ROOT: "" })).toBe(
      "https://api.telegram.org",
    );
  });
});

describe("readSettings and writeJsonAtomic", () => {
  it("reads a missing settings.json as empty and refuses one that is not a JSON object", () => {
    const settingsFile = join(configDir, "settings.json");
    const messages = MESSAGES["pt-br"];

    expect(readSettings(settingsFile, messages)).toEqual({});

    for (const text of ["{ broken", "[]", "null", '"text"']) {
      writeFileSync(settingsFile, text);

      expect(() => readSettings(settingsFile, messages)).toThrow(
        messages.settingsInvalid(settingsFile),
      );
    }
  });

  it("creates a new file private to the user", () => {
    const settingsFile = join(configDir, "settings.json");

    writeJsonAtomic(settingsFile, { theme: "dark" });

    expect(readFileSync(settingsFile, "utf8")).toBe(
      `${JSON.stringify({ theme: "dark" }, null, 2)}\n`,
    );
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked settings.json and keeps the link", () => {
    const realFile = join(workDir, "dotfiles-settings.json");
    const settingsFile = join(configDir, "settings.json");
    writeFileSync(realFile, "{}");
    symlinkSync(realFile, settingsFile);

    writeJsonAtomic(settingsFile, { theme: "dark" });

    expect(lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(realFile, "utf8"))).toEqual({
      theme: "dark",
    });
  });
});

describe("createPrompter without a terminal", () => {
  function pipedPrompter(text) {
    const input = new PassThrough();
    const written = [];
    const output = { write: (chunk) => written.push(String(chunk)) };

    input.end(text);

    return { prompter: createPrompter({ input, output }), written };
  }

  it("answers each question with the next piped line, even when every line arrives at once", async () => {
    const { prompter, written } = pipedPrompter("pt-br\n5\n123:FAKE\ny\n");
    const messages = MESSAGES["en-us"];

    expect(await prompter.line("Language? ", messages)).toBe("pt-br");
    expect(await prompter.line("Minutes? ", messages)).toBe("5");
    expect(await prompter.hidden("Token: ", messages)).toBe("123:FAKE");
    expect(await prompter.line("Statusline? ", messages)).toBe("y");
    prompter.close();

    expect(written.join("")).toBe("Language? Minutes? Token: \nStatusline? ");
  });

  it("cancels in the language of the setup when the input ends before the answer", async () => {
    const { prompter } = pipedPrompter("");

    await expect(prompter.hidden("Token: ", MESSAGES["pt-br"])).rejects.toThrow(
      MESSAGES["pt-br"].cancelled,
    );
    await expect(prompter.line("Minutes? ", MESSAGES["en-us"])).rejects.toThrow(
      MESSAGES["en-us"].cancelled,
    );
  });
});

describe("createPrompter on a terminal", () => {
  function terminalPrompter() {
    const input = new PassThrough();
    const output = new PassThrough();

    input.isTTY = true;
    input.setRawMode = () => {};
    output.isTTY = true;
    output.columns = 80;
    output.resume();

    return { prompter: createPrompter({ input, output }), input };
  }

  it("aborts in the language of the setup on Ctrl+D with nothing typed", async () => {
    for (const locale of ["en-us", "pt-br"]) {
      const { prompter, input } = terminalPrompter();
      const answer = prompter.line("Minutes? ", MESSAGES[locale]);

      input.write("\u0004");

      await expect(answer).rejects.toThrow(MESSAGES[locale].aborted);
    }

    expect([MESSAGES["en-us"].aborted, MESSAGES["pt-br"].aborted]).toEqual([
      "Aborted with Ctrl+D",
      "Interrompido com Ctrl+D",
    ]);
  });

  it("cancels on Ctrl+C and answers the typed line on Enter", async () => {
    const cancelled = terminalPrompter();
    const stopped = cancelled.prompter.line("Minutes? ", MESSAGES["pt-br"]);

    cancelled.input.write("\u0003");

    await expect(stopped).rejects.toThrow(MESSAGES["pt-br"].cancelled);

    const typed = terminalPrompter();
    const answer = typed.prompter.line("Minutes? ", MESSAGES["en-us"]);

    typed.input.write("4\r");

    await expect(answer).resolves.toBe("4");
  });
});

describe("questions as a selection on the terminal", () => {
  const EN = MESSAGES["en-us"];

  function terminal({ pick = (choices, index) => choices[index].value } = {}) {
    const typed = [];
    const ask = {
      interactive: true,
      select: vi.fn(async (_title, choices, index) => pick(choices, index)),
      line: vi.fn(async () => typed.shift() ?? ""),
    };

    return { ask, typed };
  }

  const pickOther = (choices) => choices.at(-1).value;
  const labels = (ask) => ask.select.mock.calls[0][1].map(({ label }) => label);

  it("offers the usual delays with the saved one chosen, and returns it on Enter", async () => {
    const { ask } = terminal();

    await expect(askDelay(5, EN, ask)).resolves.toBe(5);
    expect(labels(ask)).toEqual([
      "1 min",
      "3 min",
      `4 min (${EN.recommended})`,
      "5 min",
      "10 min",
      "15 min",
      EN.custom,
    ]);
    expect(ask.select.mock.calls[0][2]).toBe(3);
    expect([EN.custom, MESSAGES["pt-br"].custom]).toEqual([
      "Custom",
      "Customizado",
    ]);
  });

  it("suggests 4 minutes on a fresh setup", async () => {
    const { ask } = terminal();

    await expect(askDelay(DEFAULT_DELAY_MINUTES, EN, ask)).resolves.toBe(4);
    expect(labels(ask)[ask.select.mock.calls[0][2]]).toBe(
      `4 min (${EN.recommended})`,
    );
    expect(MESSAGES["pt-br"].recommended).toBe("Recomendado");
  });

  it("keeps a saved delay that is not among the usual ones, in order", async () => {
    const { ask } = terminal();

    await expect(askDelay(2.5, EN, ask)).resolves.toBe(2.5);
    expect(labels(ask).slice(0, 3)).toEqual(["1 min", "2.5 min", "3 min"]);
    expect(ask.select.mock.calls[0][2]).toBe(1);
  });

  it("asks another delay again until it is a number of minutes greater than 0", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ask, typed } = terminal({ pick: pickOther });
    typed.push("soon", "0", "4");

    await expect(askDelay(3, EN, ask)).resolves.toBe(4);
    expect(error.mock.calls.flat()).toEqual([
      fail(EN.invalidAnswer("soon", EN.delayCustomHint)),
      fail(EN.invalidAnswer("0", EN.delayCustomHint)),
    ]);
  });

  it("offers the usual days for received files, never deleting, and validates another value", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ask, typed } = terminal({ pick: pickOther });
    typed.push("2.5", "10");

    await expect(askInbox(7, EN, ask)).resolves.toBe(10);
    expect(labels(ask)).toEqual([
      EN.inboxDaysLabel(1),
      EN.inboxDaysLabel(3),
      EN.inboxDaysLabel(7),
      EN.inboxDaysLabel(14),
      EN.inboxDaysLabel(30),
      EN.inboxForeverLabel,
      EN.custom,
    ]);
    expect(ask.select.mock.calls[0][2]).toBe(2);
  });

  it("starts on never deleting when received files are kept forever", async () => {
    const { ask } = terminal();

    await expect(askInbox(null, EN, ask)).resolves.toBeNull();
    expect(ask.select.mock.calls[0][2]).toBe(5);
  });

  it("suggests quiet hours outside business hours, all night, at night and in the small hours, each with the hours beside it, off by default", async () => {
    const { ask } = terminal();

    await expect(askQuietHours(null, EN, ask)).resolves.toBeNull();
    expect(ask.select.mock.calls[0][2]).toBe(0);
    expect(ask.select.mock.calls[0][1]).toEqual([
      expect.objectContaining({ label: EN.quietOffLabel, value: null }),
      expect.objectContaining({
        label: EN.quietPresets.outsideWork,
        hint: "18:00-08:00",
        value: { start: "18:00", end: "08:00" },
      }),
      expect.objectContaining({
        label: EN.quietPresets.fullNight,
        hint: "18:00-07:00",
        value: { start: "18:00", end: "07:00" },
      }),
      expect.objectContaining({
        label: EN.quietPresets.night,
        hint: "22:00-07:00",
        value: { start: "22:00", end: "07:00" },
      }),
      expect.objectContaining({
        label: EN.quietPresets.lateNight,
        hint: "00:00-07:00",
        value: { start: "00:00", end: "07:00" },
      }),
      expect.objectContaining({ label: EN.custom }),
    ]);
    expect(MESSAGES["pt-br"].quietPresets).toEqual({
      outsideWork: "Fora do horário comercial",
      fullNight: "Noite completa",
      night: "Noite",
      lateNight: "Madrugada",
    });
  });

  it("keeps saved quiet hours of its own as a choice, chosen", async () => {
    const saved = { start: "23:30", end: "06:30" };
    const { ask } = terminal();

    await expect(askQuietHours(saved, EN, ask)).resolves.toEqual(saved);
    expect(labels(ask)[1]).toBe("23:30-06:30");
    expect(ask.select.mock.calls[0][2]).toBe(1);
  });

  it("asks other quiet hours in two parts, the start and then the end, until each is a valid time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ask, typed } = terminal({ pick: pickOther });
    typed.push("25:00", "22:30", "22:30", "6:00");

    await expect(askQuietHours(null, EN, ask)).resolves.toEqual({
      start: "22:30",
      end: "06:00",
    });
    expect(ask.line.mock.calls.map(([prompt]) => prompt)).toEqual([
      EN.quietStartPrompt,
      EN.quietStartPrompt,
      EN.quietEndPrompt,
      EN.quietEndPrompt,
    ]);
    expect(error.mock.calls.flat()).toEqual([
      fail(EN.invalidAnswer("25:00", EN.timeHint)),
      fail(EN.invalidAnswer("22:30", EN.quietEndHint("22:30"))),
    ]);
  });

  it("offers turning the transcription off and each model with its explanation", async () => {
    const { ask } = terminal();

    await expect(askTranscription("small", EN, ask)).resolves.toBe("small");
    expect(ask.select.mock.calls[0][1]).toEqual([
      expect.objectContaining({ label: EN.transcriptionOffLabel, value: null }),
      expect.objectContaining({
        label: "base",
        hint: EN.transcriptionModels.base,
      }),
      expect.objectContaining({
        label: "small",
        hint: EN.transcriptionModels.small,
      }),
      expect.objectContaining({
        label: "medium",
        hint: EN.transcriptionModels.medium,
      }),
    ]);
    expect(ask.select.mock.calls[0][2]).toBe(2);
  });

  it("marks the value chosen in an earlier setup, and nothing on a fresh one", async () => {
    const earlier = terminal();
    const fresh = terminal();

    await askDelay(5, EN, earlier.ask, { saved: true });
    await askDelay(5, EN, fresh.ask);

    const choices = earlier.ask.select.mock.calls[0][1];

    expect(choices[3]).toMatchObject({
      label: `5 min (${EN.previousChoice})`,
      previous: true,
    });
    expect(choices.filter(({ previous }) => previous)).toHaveLength(1);
    expect(labels(fresh.ask)[3]).toBe("5 min");
    expect(MESSAGES["pt-br"].previousChoice).toBe("escolhido anteriormente");
  });

  it("joins the marks of a choice, such as recommended and chosen before", async () => {
    const { ask } = terminal();

    await askDelay(4, EN, ask, { saved: true });

    expect(labels(ask)[2]).toBe(
      `4 min (${EN.recommended}, ${EN.previousChoice})`,
    );
  });

  it("separates the installed models from the ones to download, with uninstall below off", async () => {
    const { ask } = terminal();

    await askTranscription("base", EN, ask, {
      saved: true,
      installed: ["base", "small"],
    });

    const choices = ask.select.mock.calls[0][1];

    expect(labels(ask)).toEqual([
      EN.transcriptionOffLabel,
      EN.transcriptionUninstall,
      EN.transcriptionInstalledHeading,
      `base (${EN.previousChoice})`,
      "small",
      EN.transcriptionAvailableHeading,
      "medium",
    ]);
    expect(choices.filter(({ heading }) => heading)).toHaveLength(2);
    expect(ask.select.mock.calls[0][2]).toBe(3);
    expect([
      MESSAGES["pt-br"].transcriptionInstalledHeading,
      MESSAGES["pt-br"].transcriptionAvailableHeading,
      MESSAGES["pt-br"].transcriptionUninstall,
    ]).toEqual(["Instalados:", "Para baixar:", "Desinstalar"]);
  });

  it("offers no uninstall and no groups when no model is installed", async () => {
    const { ask } = terminal();

    await askTranscription(null, EN, ask);

    expect(labels(ask)).toEqual([
      EN.transcriptionOffLabel,
      "base",
      "small",
      "medium",
    ]);
  });

  it("marks off as chosen before in the quiet hours and the received files", async () => {
    const quiet = terminal();
    const inbox = terminal();

    await askQuietHours(null, EN, quiet.ask, { saved: true });
    await askInbox(null, EN, inbox.ask, { saved: true });

    expect(labels(quiet.ask)[0]).toBe(
      `${EN.quietOffLabel} (${EN.previousChoice})`,
    );
    expect(labels(inbox.ask)[5]).toBe(
      `${EN.inboxForeverLabel} (${EN.previousChoice})`,
    );
  });

  it("marks the language chosen before", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", undefined);
    vi.stubEnv("WT_SESSION", undefined);
    const { ask } = terminal();

    await askLanguage("pt-br", EN, ask, { saved: true });

    expect(labels(ask)[1]).toBe(
      `🇧🇷 Português Brasileiro / Brazilian Portuguese (pt-br) (${EN.previousChoice})`,
    );
  });

  it("offers each language with its flag and its name in both languages, with its code", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", undefined);
    vi.stubEnv("WT_SESSION", undefined);
    const { ask } = terminal();

    await expect(askLanguage("pt-br", EN, ask)).resolves.toBe("pt-br");
    expect(labels(ask)).toEqual([
      "🇺🇸 English / Inglês (en-us)",
      "🇧🇷 Português Brasileiro / Brazilian Portuguese (pt-br)",
    ]);
    expect(ask.select.mock.calls[0][2]).toBe(1);
  });

  it("leaves the flags out where Windows draws them as letters", async () => {
    for (const [name, value] of [
      ["WSL_DISTRO_NAME", "Ubuntu"],
      ["WT_SESSION", "abc"],
    ]) {
      vi.unstubAllEnvs();
      vi.stubEnv("WSL_DISTRO_NAME", undefined);
      vi.stubEnv("WT_SESSION", undefined);
      vi.stubEnv(name, value);
      const { ask } = terminal();

      await askLanguage("pt-br", EN, ask);

      expect(labels(ask)).toEqual([
        "English / Inglês (en-us)",
        "Português Brasileiro / Brazilian Portuguese (pt-br)",
      ]);
    }
  });

  it("offers what to do with a status line of someone else, keeping it by default", async () => {
    const { ask } = terminal();

    await expect(askStatuslineChoice("mine", EN, ask)).resolves.toBe("keep");
    expect(ask.select.mock.calls[0][0]).toContain(
      EN.statuslineChoiceQuestion("mine", EN.statusConnected(EN.statusMain)),
    );
    expect(ask.select.mock.calls[0][1]).toEqual(
      ["after", "replace", "custom", "keep"].map((choice) =>
        expect.objectContaining({
          label: EN.statuslineChoices[choice],
          hint: EN.statuslineChoiceHints[choice],
        }),
      ),
    );
    expect(MESSAGES["pt-br"].statuslineChoiceQuestion("x", "y")).toBe(
      "Você já tem uma statusline (x).\nOnde mostrar o indicador do Telegram (y)?",
    );
  });

  it("names the keep option after the indicator Claude already fitted into the status line", async () => {
    const { ask } = terminal();

    await askStatuslineChoice("mine", EN, ask, { customized: true });

    expect(ask.select.mock.calls[0][1].at(-1)).toMatchObject({
      label: EN.statuslineChoices.keepCustom,
      hint: EN.statuslineChoiceHints.keep,
    });
  });

  it("offers to remove the other installed models, all of them or one at a time, keeping them by default", async () => {
    const { ask } = terminal();

    await expect(
      askRemoveModels(["base", "medium"], "base", EN, ask),
    ).resolves.toEqual([]);
    expect(labels(ask)).toEqual([
      EN.removeModelsKeep,
      EN.removeModelsAll("base, medium"),
      `${EN.removeModel("base")} (${EN.modelInUse})`,
      EN.removeModel("medium"),
    ]);
    expect(ask.select.mock.calls[0][2]).toBe(0);
    expect(ask.select.mock.calls[0][0]).toContain(EN.removeModelsQuestion);
  });

  it("offers only keeping or removing it when one other model is installed", async () => {
    const { ask } = terminal({ pick: (choices) => choices[1].value });

    await expect(askRemoveModels(["base"], null, EN, ask)).resolves.toEqual([
      "base",
    ]);
    expect(labels(ask)).toEqual([EN.removeModelsKeep, EN.removeModel("base")]);
  });

  it("asks yes or no as a selection with the default chosen", async () => {
    const { ask } = terminal();

    await expect(askYesNo("Go?", EN, false, ask)).resolves.toBe(false);
    expect(labels(ask)).toEqual([EN.yes, EN.no]);
    expect(ask.select.mock.calls[0][2]).toBe(1);
  });
});

describe("guardCancel", () => {
  const EN = MESSAGES["en-us"];
  const cancelled = () =>
    Object.assign(new Error(EN.cancelled), { cancelled: true });

  function terminal(leave) {
    const answers = [cancelled(), "ok"];
    const ask = {
      interactive: true,
      line: vi.fn(async () => {
        const answer = answers.shift();

        if (answer instanceof Error) throw answer;

        return answer;
      }),
      hidden: vi.fn(),
      select: vi.fn(async () => leave),
    };

    return ask;
  }

  it("asks whether to leave on Ctrl+C and asks the same question again when going on", async () => {
    const ask = terminal(false);

    await expect(guardCancel(ask).line("Minutes? ", EN)).resolves.toBe("ok");
    expect(ask.line).toHaveBeenCalledTimes(2);
    expect(ask.select.mock.calls[0][1].map(({ label }) => label)).toEqual([
      EN.continueSetup,
      EN.exitSetup,
    ]);
    expect(ask.select.mock.calls[0][0]).toContain(EN.exitPrompt);
  });

  it("stops the setup as interrupted when leaving", async () => {
    const ask = terminal(true);

    await expect(guardCancel(ask).line("Minutes? ", EN)).rejects.toMatchObject({
      message: EN.interrupted,
      interrupted: true,
    });
  });

  it("leaves when Ctrl+C is pressed again on the question about leaving", async () => {
    const ask = terminal(false);
    ask.select = vi.fn(async () => {
      throw cancelled();
    });

    await expect(guardCancel(ask).line("Minutes? ", EN)).rejects.toMatchObject({
      interrupted: true,
    });
  });

  it("lets any other error through and changes nothing without a terminal", async () => {
    const ask = terminal(false);
    ask.line = vi.fn(async () => {
      throw new Error("network");
    });
    const piped = { interactive: false, line: vi.fn() };

    await expect(guardCancel(ask).line("Minutes? ", EN)).rejects.toThrow(
      "network",
    );
    expect(ask.select).not.toHaveBeenCalled();
    expect(guardCancel(piped)).toBe(piped);
  });
});

describe("offerUndo", () => {
  const EN = MESSAGES["en-us"];
  let logged;

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line) => logged.push(line));
  });

  function journalWithChanges() {
    const journal = createJournal();
    const envFile = join(workDir, ".env");
    const removePlugin = vi.fn();

    journal.trackFile(envFile);
    writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=x\n");
    journal.record("pluginInstalled", HOOKS_PLUGIN_ID, removePlugin);

    return { journal, envFile, removePlugin };
  }

  it("says nothing was changed and asks nothing when the setup did nothing yet", async () => {
    const ask = { select: vi.fn() };

    await offerUndo(createJournal(), EN, ask, { interrupted: true });

    expect(ask.select).not.toHaveBeenCalled();
    expect(logged).toEqual([EN.nothingChanged]);
  });

  it("lists what the setup did and undoes all of it, suggesting undo after an interruption", async () => {
    const { journal, envFile, removePlugin } = journalWithChanges();
    const ask = { select: vi.fn(async () => true) };

    await offerUndo(journal, EN, ask, { interrupted: true });

    expect(logged[0]).toBe(
      EN.doneSoFar(
        [
          EN.changeKinds.fileCreated(envFile),
          EN.changeKinds.pluginInstalled(HOOKS_PLUGIN_ID),
        ].join("\n  • "),
      ),
    );
    expect(ask.select.mock.calls[0][1].map(({ label }) => label)).toEqual([
      EN.undoAll,
      EN.keepDone,
    ]);
    expect(ask.select.mock.calls[0][2]).toBe(0);
    expect(existsSync(envFile)).toBe(false);
    expect(removePlugin).toHaveBeenCalledTimes(1);
    expect(logged.slice(1)).toEqual([
      success(EN.undoneItem(EN.changeKinds.pluginInstalled(HOOKS_PLUGIN_ID))),
      success(EN.undoneItem(EN.changeKinds.fileCreated(envFile))),
      success(EN.undone),
    ]);
    expect(MESSAGES["pt-br"].undoneItem("criou x")).toBe(
      "Desfeito:\n  • criou x",
    );
    expect(MESSAGES["pt-br"].undoing("criou x")).toBe("Desfazendo: criou x…");
  });

  it("keeps everything when asked to, suggesting to keep after an error", async () => {
    const { journal, envFile, removePlugin } = journalWithChanges();
    const ask = { select: vi.fn(async () => false) };

    await offerUndo(journal, EN, ask, { interrupted: false });

    expect(ask.select.mock.calls[0][2]).toBe(1);
    expect(existsSync(envFile)).toBe(true);
    expect(removePlugin).not.toHaveBeenCalled();
    expect(logged.at(-1)).toBe(EN.keptDone("npm run setup"));
  });

  it("keeps everything when Ctrl+C is pressed on that question too", async () => {
    const { journal, envFile } = journalWithChanges();
    const ask = {
      select: vi.fn(async () => {
        throw new Error(EN.cancelled);
      }),
    };

    await offerUndo(journal, EN, ask, { interrupted: true });

    expect(existsSync(envFile)).toBe(true);
    expect(logged.at(-1)).toBe(EN.keptDone("npm run setup"));
  });

  it("lists the options it changed in the configuration and in settings.json", async () => {
    const journal = createJournal();
    const configFile = join(appDir, CONFIG_NAME);
    const settingsFile = join(configDir, "settings.json");

    writeFileSync(configFile, JSON.stringify({ delayMinutes: 3 }));
    writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: "dark",
        enabledPlugins: { [CHANNEL_PLUGIN_ID]: true },
      }),
    );
    journal.trackFile(configFile);
    journal.trackFile(settingsFile);
    writeFileSync(
      configFile,
      JSON.stringify({
        delayMinutes: 4,
        quietHours: { start: "22:00", end: "07:00" },
        transcription: null,
      }),
    );
    writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: "dark",
        statusLine: { type: "command", command: statuslineCommand() },
        permissions: { deny: [envDenyRule(join(stateDir, ".env"))] },
        enabledPlugins: {
          [CHANNEL_PLUGIN_ID]: false,
          [HOOKS_PLUGIN_ID]: true,
        },
      }),
    );

    await offerUndo(
      journal,
      EN,
      { select: async () => false },
      { interrupted: true, stateDir },
    );

    const option = (icon, label, before, after) =>
      EN.changedSetting(
        info(`${icon} ${label}`),
        note(before),
        newValue(after),
      );

    expect(logged[0]).toBe(
      EN.doneSoFar(
        [
          [
            EN.changeKinds.fileChanged(configFile),
            option("⏳", EN.stepTitles.delay, "3 min", "4 min"),
            option(
              "🌙",
              EN.stepTitles["quiet-hours"],
              EN.notSet,
              "22:00-07:00",
            ),
            option(
              "🎤",
              EN.stepTitles.transcription,
              EN.notSet,
              EN.transcriptionOffLabel,
            ),
          ].join("\n    – "),
          [
            EN.changeKinds.fileChanged(settingsFile),
            option(
              "📊",
              EN.settingsKeys.statusLine,
              EN.healthDetail.statusline.none,
              EN.healthDetail.statusline.ours,
            ),
            option("🔒", EN.settingsKeys.permissions, EN.ruleOff, EN.ruleOn),
            option(
              "🧩",
              EN.pluginSetting(CHANNEL_PLUGIN_ID),
              EN.pluginOn,
              EN.pluginOff,
            ),
            option(
              "🧩",
              EN.pluginSetting(HOOKS_PLUGIN_ID),
              EN.notSet,
              EN.pluginOn,
            ),
          ].join("\n    – "),
        ].join("\n  • "),
      ),
    );
  });

  it("paints each changed option with its step icon: the topic blue, the old value gray and the new one green", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);
    const journal = createJournal();
    const configFile = join(appDir, CONFIG_NAME);

    journal.trackFile(configFile);
    writeFileSync(configFile, JSON.stringify({ language: "pt-br" }));

    await offerUndo(
      journal,
      EN,
      { select: async () => false },
      { interrupted: true, stateDir },
    );

    expect(logged[0]).toContain(
      `– \u001B[34m🌐 ${EN.stepTitles.language}\u001B[39m: \u001B[2m${EN.notSet}\u001B[22m → \u001B[32mpt-br\u001B[39m`,
    );
  });

  it("says what it could not undo, such as a tool the setup installed", async () => {
    const journal = createJournal();
    journal.record("toolInstalled", "bun (/h/.bun/bin)", null);

    await offerUndo(
      journal,
      EN,
      { select: async () => true },
      { interrupted: true },
    );

    expect(logged.at(-1)).toBe(
      warn(EN.undoLeft(EN.changeKinds.toolInstalled("bun (/h/.bun/bin)"))),
    );
  });
});

describe("huggingFaceCacheDir", () => {
  it("follows HF_HUB_CACHE, then HF_HOME, then XDG_CACHE_HOME, then ~/.cache", () => {
    expect(
      huggingFaceCacheDir({ HF_HUB_CACHE: "/hub", HF_HOME: "/x" }, "/h"),
    ).toBe("/hub");
    expect(huggingFaceCacheDir({ HF_HOME: "/hf" }, "/h")).toBe("/hf/hub");
    expect(huggingFaceCacheDir({ XDG_CACHE_HOME: "/c" }, "/h")).toBe(
      "/c/huggingface/hub",
    );
    expect(huggingFaceCacheDir({}, "/h")).toBe("/h/.cache/huggingface/hub");
  });
});

describe("pluginPlan", () => {
  const EN = MESSAGES["en-us"];
  const paths = { rootDir: "/repo", shellFile: "/repo/shell.sh" };

  it("lists the marketplace, every plugin and every rc file still missing, each with the command to do it by hand", () => {
    expect(
      pluginPlan(
        {
          marketplaces: "",
          plugins: `${HOOKS_PLUGIN_ID}\n`,
          rcFiles: ["/h/.zshrc"],
        },
        EN,
        paths,
      ),
    ).toEqual([
      {
        description: EN.planMarketplace(MARKETPLACE_NAME),
        command: "claude plugin marketplace add /repo",
      },
      {
        description: EN.planPlugin(CHANNEL_PLUGIN_ID),
        command: `claude plugin install ${CHANNEL_PLUGIN_ID} --scope user`,
      },
      {
        description: EN.planPlugin(BCCT_PLUGIN_ID),
        command: `claude plugin install ${BCCT_PLUGIN_ID} --scope user`,
      },
      {
        description: EN.planShellLine("/h/.zshrc"),
        command: `echo '${sourceLine("/repo/shell.sh")}' >> "/h/.zshrc"`,
      },
    ]);
  });

  it("leaves out the plugins that were not chosen", () => {
    expect(
      pluginPlan(
        {
          marketplaces: `${MARKETPLACE_NAME}\n`,
          plugins: "",
          rcFiles: [],
          pluginIds: [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID],
        },
        EN,
        paths,
      ).map(({ description }) => description),
    ).toEqual([
      EN.planPlugin(CHANNEL_PLUGIN_ID),
      EN.planPlugin(HOOKS_PLUGIN_ID),
    ]);
  });

  it("is empty when everything is already in place", () => {
    expect(
      pluginPlan(
        {
          marketplaces: `${MARKETPLACE_NAME}\n`,
          plugins: `${CHANNEL_PLUGIN_ID}\n${HOOKS_PLUGIN_ID}\n${BCCT_PLUGIN_ID}\n`,
          rcFiles: [],
        },
        EN,
        paths,
      ),
    ).toEqual([]);
  });
});

describe("parseTime", () => {
  it("accepts HH:MM and H:MM within the day, and nothing else", () => {
    expect(parseTime("06:00")).toBe("06:00");
    expect(parseTime(" 6:05 ")).toBe("06:05");
    expect(parseTime("23:59")).toBe("23:59");

    for (const text of ["24:00", "12:60", "12", "noon", "", "1:2"]) {
      expect(typeof parseTime(text)).toBe("symbol");
    }
  });
});

describe("missingSetupSteps", () => {
  it("points out the missing token and pairing", () => {
    expect(missingSetupSteps(stateDir)).toEqual(["token", "pairing"]);

    writeSetupDone({ paired: false });
    expect(missingSetupSteps(stateDir)).toEqual(["pairing"]);

    writeSetupDone();
    expect(missingSetupSteps(stateDir)).toEqual([]);
  });
});

describe("checkSetup", () => {
  const folders = () => ({
    appDir,
    env: { LANG: "C" },
    settingsFile: join(configDir, "settings.json"),
  });

  it("returns 1 and prints the en-us not-configured message when setup is missing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const isRunning = vi.fn();

    expect(checkSetup(stateDir, isRunning, folders())).toBe(1);
    expect(error).toHaveBeenCalledWith(
      fail(
        "'claude --telegram' is not set up yet. Missing:\n  • bot token, pairing\nRun 'npm run setup' first.",
      ),
    );
    expect(isRunning).not.toHaveBeenCalled();
  });

  it("prints the not-configured message in pt-br when the config says pt-br", () => {
    writeConfig({ language: "pt-br" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkSetup(stateDir, () => null, folders())).toBe(1);
    expect(error).toHaveBeenCalledWith(
      fail(
        "O 'claude --telegram' ainda não está configurado. Falta:\n  • token do bot, pareamento\nRode 'npm run setup' antes.",
      ),
    );
  });

  it("returns 1 with the already-open message when isRunning gives a pid", () => {
    writeSetupDone();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const isRunning = vi.fn(() => "4242");

    expect(checkSetup(stateDir, isRunning, folders())).toBe(1);
    expect(isRunning).toHaveBeenCalledWith(stateDir);
    expect(error).toHaveBeenCalledWith(
      fail(
        "A 'claude --telegram' instance is already open (bot in process 4242). Close it before opening another one.",
      ),
    );
  });

  it("prints the already-open message in pt-br when the config says pt-br", () => {
    writeSetupDone();
    writeConfig({ language: "pt-br" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkSetup(stateDir, () => "4242", folders())).toBe(1);
    expect(error).toHaveBeenCalledWith(
      fail(
        "Já existe uma instância do 'claude --telegram' aberta (bot no processo 4242). Feche-a antes de abrir outra.",
      ),
    );
  });

  it("refuses to open when more than one Telegram account can talk to the bot", () => {
    writeSetupDone();
    writeFileSync(
      join(stateDir, "access.json"),
      JSON.stringify({ dmPolicy: "allowlist", allowFrom: ["42", "13"] }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const isRunning = vi.fn();

    expect(checkSetup(stateDir, isRunning, folders())).toBe(1);
    expect(error).toHaveBeenCalledWith(
      fail(MESSAGES["en-us"].tooManyAccounts(2, "npm run setup:pairing")),
    );
    expect(isRunning).not.toHaveBeenCalled();
  });

  it("refuses to open with the permission checks turned off, by flag or by the user settings", () => {
    writeSetupDone();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const settingsFile = join(configDir, "settings.json");

    expect(
      checkSetup(stateDir, () => null, {
        ...folders(),
        args: ["--continue", "--permission-mode=bypassPermissions"],
        settingsFile,
      }),
    ).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      fail(
        MESSAGES["en-us"].permissionsSkipped(
          "--permission-mode=bypassPermissions",
        ),
      ),
    );

    writeFileSync(
      settingsFile,
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
    );

    expect(
      checkSetup(stateDir, () => null, { ...folders(), settingsFile }),
    ).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      fail(
        MESSAGES["en-us"].permissionsSkipped(
          `defaultMode bypassPermissions (${settingsFile})`,
        ),
      ),
    );
  });

  it("returns 0 in silence with setup done and no instance running", () => {
    writeSetupDone();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkSetup(stateDir, () => null, folders())).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("telegramInstanceRunning", () => {
  it("returns null without a bot.pid file", () => {
    expect(telegramInstanceRunning(stateDir)).toBeNull();
  });

  it("returns null when the pid belongs to a process that is not server.ts", () => {
    writeFileSync(join(stateDir, "bot.pid"), String(process.pid));

    expect(telegramInstanceRunning(stateDir)).toBeNull();
  });

  it("returns the pid when the process is running server.ts", () => {
    const bot = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000)",
      "server.ts",
    ]);

    try {
      writeFileSync(join(stateDir, "bot.pid"), String(bot.pid));

      expect(telegramInstanceRunning(stateDir)).toBe(String(bot.pid));
    } finally {
      bot.kill();
    }
  });
});

describe("setup by step", () => {
  it("language pt-br saves language and keeps the rest of the config", () => {
    writeConfig({
      delayMinutes: 7,
      quietHours: { start: "22:00", end: "08:00" },
    });

    const result = runSetup(["language"], "pt-br\n");

    expect(result.status).toBe(0);
    expect(readConfig()).toEqual({
      delayMinutes: 7,
      quietHours: { start: "22:00", end: "08:00" },
      language: "pt-br",
    });
    expect(result.stdout).toContain("Idioma pt-br salvo em");
  });

  it("language keeps the current on Enter and en-us is the default without config", () => {
    const first = runSetup(["language"], "\n");

    expect(first.status).toBe(0);
    expect(readConfig()).toEqual({ language: "en-us" });
    expect(first.stdout).toContain("Language en-us saved in");

    writeConfig({ language: "pt-br", delayMinutes: 2 });

    expect(runSetup(["language"], "\n").status).toBe(0);
    expect(readConfig()).toEqual({ language: "pt-br", delayMinutes: 2 });
  });

  it("language says an unknown answer is not valid and asks again, Enter then keeping the current", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["language"], "klingon\n\n");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      fail(MESSAGES["pt-br"].invalidAnswer("klingon", "en-us, pt-br")),
    );
    expect(readConfig()).toEqual({ language: "pt-br" });
  });

  it("an answer that is never valid cancels when the input ends, changing nothing", () => {
    writeConfig({ delayMinutes: 7 });

    const result = runSetup(["delay"], "soon\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MESSAGES["en-us"].cancelled);
    expect(readConfig()).toEqual({ delayMinutes: 7 });
  });

  it("delay accepts another number of minutes typed without a terminal", () => {
    expect(runSetup(["delay"], "2.5\n").status).toBe(0);
    expect(readConfig()).toEqual({ delayMinutes: 2.5 });
  });

  it("delay changes only the wait time and keeps the rest of the config", () => {
    writeConfig({
      quietHours: { start: "22:00", end: "08:00" },
      transcription: { model: "small" },
    });

    const result = runSetup(["delay"], "5\n");

    expect(result.status).toBe(0);
    expect(readConfig()).toEqual({
      quietHours: { start: "22:00", end: "08:00" },
      transcription: { model: "small" },
      delayMinutes: 5,
    });
    expect(result.stdout).toContain("Delay of 5 min saved in");
  });

  it("a step run before any language was chosen speaks the language of the system, without saving it", () => {
    const result = runSetup(["delay"], "5\n", { LANG: "pt_BR.UTF-8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Espera de 5 min salva em");
    expect(readConfig()).toEqual({ delayMinutes: 5 });
  });

  it("delay prints in pt-br when the config says pt-br", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["delay"], "5\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Espera de 5 min salva em");
  });

  it("starts by saying that Enter keeps the default, and every question shows its default, in the language of the setup", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["delay", "statusline"], "\n\n");

    expect(
      result.stdout.startsWith(`${MESSAGES["pt-br"].enterKeepsDefault}\n`),
    ).toBe(true);
    expect(result.stdout).toContain("[padrão: 4]: ");
    expect(result.stdout).toContain("(s/n) [padrão: n] ");
  });

  it("opens each step with its number and title in the language of the setup", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["delay", "inbox"], "\n\n");

    expect(result.stdout).toContain("\n── ⏳ 1/2 Tempo de espera ──\n");
    expect(result.stdout).toContain("\n── 📥 2/2 Arquivos recebidos ──\n");
    expect(result.stdout).toContain("✔ Espera de 4 min salva em");
  });

  it("says that Enter keeps the default in both languages before one is chosen", () => {
    const result = runSetup(["delay"], "\n");

    expect(
      result.stdout.startsWith(
        "[en-us] Press Enter on an empty answer to keep the default or the existing setting. / [pt-br] Confirmar (Enter) vazio confirma o padrão ou mantém a configuração existente.\n",
      ),
    ).toBe(true);
    expect(result.stdout).toContain("[default: 4]: ");
  });

  it("asks the language with its default in both languages", () => {
    writeConfig({ language: "pt-br" });

    expect(runSetup(["language"], "\n").stdout).toContain(
      "Language / Idioma (en-us, pt-br) [default / padrão: pt-br]: ",
    );
  });

  it("quiet-hours changes only the silence, and Enter keeps the current", () => {
    writeConfig({ delayMinutes: 7 });

    expect(runSetup(["quiet-hours"], "23:00-07:00\n").status).toBe(0);
    expect(readConfig()).toEqual({
      delayMinutes: 7,
      quietHours: { start: "23:00", end: "07:00" },
    });

    expect(runSetup(["quiet-hours"], "\n").status).toBe(0);
    expect(readConfig().quietHours).toEqual({
      start: "23:00",
      end: "07:00",
    });
  });

  it("quiet-hours turns off with the en-us answer 'off'", () => {
    writeConfig({ quietHours: { start: "22:00", end: "08:00" } });

    expect(runSetup(["quiet-hours"], "off\n").status).toBe(0);
    expect(readConfig().quietHours).toBeNull();
  });

  it("transcription with 'não' turns off without installing anything, in pt-br", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["transcription"], "não\n");

    expect(result.status).toBe(0);
    expect(readConfig()).toEqual({ language: "pt-br", transcription: null });
    expect(result.stdout).toMatch(/Transcrição desligada/);
  });

  it("transcription with 'no' turns off without installing anything, in en-us", () => {
    const result = runSetup(["transcription"], "no\n");

    expect(result.status).toBe(0);
    expect(readConfig()).toEqual({ transcription: null });
    expect(result.stdout).toMatch(/Transcription off/);
  });

  it("says each setting was kept, without saving it again, when Enter keeps the saved value", () => {
    const EN = MESSAGES["en-us"];
    const configFile = join(appDir, CONFIG_NAME);
    writeConfig({
      language: "en-us",
      delayMinutes: 4,
      quietHours: { start: "22:00", end: "07:00" },
      transcription: null,
      inboxRetentionDays: 7,
    });
    const before = readFileSync(configFile, "utf8");
    const modified = statSync(configFile).mtimeMs;

    const result = runSetup(
      ["language", "delay", "quiet-hours", "transcription", "inbox"],
      "\n".repeat(5),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(skipped(EN.languageKept("en-us")));
    expect(result.stdout).toContain(skipped(EN.delayKept(4)));
    expect(result.stdout).toContain(skipped(EN.quietKept("22:00-07:00")));
    expect(result.stdout).toContain(skipped(EN.transcriptionKeptOff));
    expect(result.stdout).toContain(skipped(EN.inboxKept(EN.inboxDays(7))));
    expect(result.stdout).not.toContain("saved in");
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect(statSync(configFile).mtimeMs).toBe(modified);
  });

  it("says quiet hours that stay off were kept", () => {
    writeConfig({ quietHours: null });

    const result = runSetup(["quiet-hours"], "\n");

    expect(result.stdout).toContain(
      skipped(MESSAGES["en-us"].quietKept(MESSAGES["en-us"].quietOff)),
    );
  });

  it("keeps a transcription model that is already installed without downloading it again", () => {
    const python = join(appDir, "whisper", "venv", "bin", "python");
    const downloads = join(workDir, "downloads.log");
    mkdirSync(join(python, ".."), { recursive: true });
    mkdirSync(
      join(
        homeDir,
        ".cache",
        "huggingface",
        "hub",
        "models--Systran--faster-whisper-base",
      ),
      { recursive: true },
    );
    writeFileSync(
      python,
      `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho download >> "${downloads}"\n`,
    );
    chmodSync(python, 0o755);
    writeConfig({ transcription: { model: "base" } });

    const result = runSetup(["transcription"], "\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      skipped(MESSAGES["en-us"].transcriptionModelKept("base")),
    );
    expect(existsSync(downloads)).toBe(false);
  });

  describe("removing the other transcription models after a switch", () => {
    const EN = MESSAGES["en-us"];
    const hub = () => join(homeDir, ".cache", "huggingface", "hub");
    const modelDir = (model) =>
      join(hub(), `models--Systran--faster-whisper-${model}`);

    function installModels(...models) {
      const python = join(appDir, "whisper", "venv", "bin", "python");
      mkdirSync(join(python, ".."), { recursive: true });
      writeFileSync(python, `#!/bin/sh\nexit 0\n`);
      chmodSync(python, 0o755);

      for (const model of models)
        mkdirSync(modelDir(model), { recursive: true });
    }

    it("uninstalling the only installed model removes it and turns the transcription off, without asking which", () => {
      installModels("base");
      writeConfig({ transcription: { model: "base" } });

      const result = runSetup(["transcription"], "uninstall\n");

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(EN.removeModelsQuestion);
      expect(existsSync(modelDir("base"))).toBe(false);
      expect(existsSync(join(appDir, "whisper"))).toBe(false);
      expect(readConfig().transcription).toBeNull();
      expect(result.stdout).toContain(success(EN.modelsRemoved("base")));
      expect(result.stdout).toContain(success(EN.transcriptionDisabled));
    });

    it("uninstalling with several installed asks which, and all of them turns the transcription off", () => {
      installModels("base", "small", "medium");
      writeConfig({ transcription: { model: "base" } });

      const result = runSetup(["transcription"], "uninstall\nall\n");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `${EN.removeModelsQuestion} (keep, all, base, small, medium) [default: keep]: `,
      );
      expect(
        ["base", "small", "medium"].some((model) =>
          existsSync(modelDir(model)),
        ),
      ).toBe(false);
      expect(readConfig().transcription).toBeNull();
      expect(result.stdout).toContain(
        success(EN.modelsRemoved("base\n  • small\n  • medium")),
      );
    });

    it("removing only a model not in use keeps the transcription on, and Enter removes nothing", () => {
      installModels("base", "small");
      writeConfig({ transcription: { model: "base" } });

      expect(runSetup(["transcription"], "uninstall\nsmall\n").status).toBe(0);
      expect(existsSync(modelDir("small"))).toBe(false);
      expect(existsSync(modelDir("base"))).toBe(true);
      expect(readConfig().transcription).toEqual({ model: "base" });

      installModels("small");

      expect(runSetup(["transcription"], "uninstall\n\n").status).toBe(0);
      expect(existsSync(modelDir("small"))).toBe(true);
      expect(readConfig().transcription).toEqual({ model: "base" });
    });

    it("removing the model in use turns the transcription off", () => {
      installModels("base", "small");
      writeConfig({ transcription: { model: "base" } });

      expect(runSetup(["transcription"], "uninstall\nbase\n").status).toBe(0);
      expect(existsSync(modelDir("base"))).toBe(false);
      expect(existsSync(modelDir("small"))).toBe(true);
      expect(readConfig().transcription).toBeNull();
    });

    it("after switching to an installed model, asks which of the others to uninstall", () => {
      installModels("base", "small", "medium");
      writeConfig({ transcription: { model: "base" } });

      const result = runSetup(["transcription"], "small\nbase\n");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `${EN.removeModelsQuestion} (keep, all, base, medium) [default: keep]: `,
      );
      expect(existsSync(modelDir("base"))).toBe(false);
      expect(existsSync(modelDir("medium"))).toBe(true);
      expect(existsSync(modelDir("small"))).toBe(true);
      expect(readConfig().transcription).toEqual({ model: "small" });
      expect(result.stdout).toContain(success(EN.modelsRemoved("base")));
    });

    it("after switching, Enter keeps the other models", () => {
      installModels("base", "small");
      writeConfig({ transcription: { model: "base" } });

      const result = runSetup(["transcription"], "small\n\n");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `${EN.removeModelsQuestion} (keep, base) [default: keep]: `,
      );
      expect(existsSync(modelDir("base"))).toBe(true);
      expect(readConfig().transcription).toEqual({ model: "small" });
    });

    it("marks the model used until now when asking after a switch", async () => {
      const ask = {
        interactive: true,
        select: vi.fn(async () => []),
      };

      await askRemoveModels(["base", "medium"], "base", EN, ask, {
        tag: EN.modelUsedUntilNow,
      });

      expect(ask.select.mock.calls[0][1][2].label).toBe(
        `${EN.removeModel("base")} (${EN.modelUsedUntilNow})`,
      );
      expect(MESSAGES["pt-br"].modelUsedUntilNow).toBe("usado até agora");
    });
  });

  it("keeps the output of the model download out of the way and shows it with the error when the download fails", () => {
    const python = join(appDir, "whisper", "venv", "bin", "python");
    mkdirSync(join(python, ".."), { recursive: true });
    writeFileSync(
      python,
      `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho "progress 50%"\necho "boom: no network" >&2\nexit 3\n`,
    );
    chmodSync(python, 0o755);
    writeConfig({ transcription: { model: "base" } });

    const result = runSetup(["transcription"], "small\n");

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("progress 50%");
    expect(result.stderr).toContain(
      `${MESSAGES["en-us"].failed(MESSAGES["en-us"].modelDownload)}\nprogress 50%\nboom: no network`,
    );
  });

  it("switches to a transcription model that is already installed without downloading it", () => {
    const python = join(appDir, "whisper", "venv", "bin", "python");
    const downloads = join(workDir, "downloads.log");
    mkdirSync(join(python, ".."), { recursive: true });
    mkdirSync(
      join(
        homeDir,
        ".cache",
        "huggingface",
        "hub",
        "models--Systran--faster-whisper-small",
      ),
      { recursive: true },
    );
    writeFileSync(
      python,
      `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho download >> "${downloads}"\n`,
    );
    chmodSync(python, 0o755);
    writeConfig({ transcription: { model: "base" } });

    const result = runSetup(["transcription"], "small\n");

    expect(result.status).toBe(0);
    expect(readConfig().transcription).toEqual({ model: "small" });
    expect(result.stdout).toContain(
      success(MESSAGES["en-us"].transcriptionSwitched("small")),
    );
    expect(result.stdout).not.toContain(
      MESSAGES["en-us"].downloadingModel("small"),
    );
    expect(existsSync(downloads)).toBe(false);
  });

  it("opens the transcription with its title and what it is for", () => {
    const messages = MESSAGES["pt-br"];
    writeConfig({ language: "pt-br" });

    const result = runSetup(["transcription"], "não\n");

    expect(result.stdout).toContain(
      `── 🎤 1/1 Transcrição de áudio ──\n${messages.transcriptionPurpose}\n`,
    );
    expect(messages.transcriptionPurpose).toBe(
      "Transforma em texto, aqui na sua máquina, os áudios que você manda pelo Telegram, para o Claude ler o que você falou.",
    );
    expect(MESSAGES["en-us"].stepTitles.transcription).toBe(
      "Audio transcription",
    );
  });

  it("transcription explains each model in a few words and suggests base on a fresh setup", () => {
    const messages = MESSAGES["pt-br"];
    writeConfig({ language: "pt-br" });

    const result = runSetup(["transcription"], "não\n");

    expect(result.stdout).toContain(
      `${messages.transcriptionQuestion} (off, base, small, medium) [padrão: base]: `,
    );
    expect(messages.transcriptionModels).toEqual({
      base: "a mais rápida, usa menos RAM, boa para fala clara, ~150 MB de armazenamento",
      small: "mais precisa, mais lenta, usa mais RAM, ~490 MB de armazenamento",
      medium:
        "a mais precisa, bem mais lenta, usa muito mais RAM, ~1,5 GB de armazenamento",
    });
  });

  it("downloads the transcription model without the raw output of the script, and says it is installed", () => {
    const python = join(appDir, "whisper", "venv", "bin", "python");
    mkdirSync(join(python, ".."), { recursive: true });
    writeFileSync(
      python,
      `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho '{"ok": true}'\n`,
    );
    chmodSync(python, 0o755);

    const result = runSetup(["transcription"], "base\n");

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('{"ok": true}');
    expect(result.stdout).toContain(
      success(MESSAGES["en-us"].transcriptionReady("base")),
    );
    expect(MESSAGES["pt-br"].transcriptionReady("base")).toBe(
      "Instalado:\n  • modelo base da transcrição local",
    );
  });

  it("explains the status line indicator with an example when asking to show it", () => {
    const messages = MESSAGES["pt-br"];
    writeConfig({ language: "pt-br" });

    const result = runSetup(["statusline"], "n\n");

    expect(result.stdout).toContain(
      messages.statuslinePrompt(messages.statusConnected(messages.statusMain)),
    );
    expect(
      messages.statuslinePrompt(messages.statusConnected(messages.statusMain)),
    ).toBe(
      "O rodapé do Claude Code (statusline) pode mostrar se o Telegram está conectado, assim:\n  • 📱 (Principal) Telegram conectado\nMostrar?",
    );
  });

  it("statusline with 'y' writes the statusLine into settings.json and keeps the rest", () => {
    const settingsFile = join(configDir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ theme: "dark" }));

    const result = runSetup(["statusline"], "y\n");

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      theme: "dark",
      statusLine: { type: "command", command: statuslineCommand() },
    });
    expect(result.stdout).toContain(`Status line set in ${settingsFile}.`);
  });

  it("statusline creates settings.json when it does not exist", () => {
    const settingsFile = join(configDir, "settings.json");

    expect(runSetup(["statusline"], "y\n").status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      statusLine: { type: "command", command: statuslineCommand() },
    });
  });

  it("statusline with 'n' or Enter leaves settings.json untouched", () => {
    const settingsFile = join(configDir, "settings.json");
    const original = `${JSON.stringify({ theme: "dark" })}\n`;
    writeFileSync(settingsFile, original);

    const declined = runSetup(["statusline"], "n\n");

    expect(declined.status).toBe(0);
    expect(declined.stdout).toContain("Status line left unchanged.");
    expect(readFileSync(settingsFile, "utf8")).toBe(original);

    expect(runSetup(["statusline"], "\n").status).toBe(0);
    expect(readFileSync(settingsFile, "utf8")).toBe(original);
  });

  it("statusline with a status line of someone else asks what to do, and Enter keeps it as a skipped step", () => {
    const settingsFile = join(configDir, "settings.json");
    const original = `${JSON.stringify({ statusLine: { type: "command", command: "mine" } })}\n`;
    writeFileSync(settingsFile, original);

    const result = runSetup(["statusline"], "\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `${MESSAGES["en-us"].statuslineChoiceQuestion("mine", MESSAGES["en-us"].statusConnected(MESSAGES["en-us"].statusMain))} (after, replace, custom, keep) [default: keep]: `,
    );
    expect(readFileSync(settingsFile, "utf8")).toBe(original);
    expect(result.stdout).toContain(skipped(MESSAGES["en-us"].statuslineKept));
    expect(result.stdout).not.toContain("⚠");
    expect(MESSAGES["pt-br"].statuslineKept).toBe(
      "Statusline mantida:\n  • a sua continua, sem o indicador do Telegram",
    );
  });

  describe("asking Claude to fit the indicator into a status line of someone else", () => {
    const PT = MESSAGES["pt-br"];
    const EN = MESSAGES["en-us"];
    const mine = { type: "command", command: "~/bin/my-line.sh" };
    let settingsFile;
    let requestFile;

    beforeEach(() => {
      settingsFile = join(configDir, "settings.json");
      requestFile = join(appDir, "statusline-customize.json");
      writeFileSync(settingsFile, `${JSON.stringify({ statusLine: mine })}\n`);
      writeConfig({ language: "en-us" });
    });

    it("'3' leaves settings.json as it is and notes the request for the next claude --telegram", () => {
      const original = readFileSync(settingsFile, "utf8");

      const result = runSetup(["statusline"], "3\n");

      expect(result.status).toBe(0);
      expect(readFileSync(settingsFile, "utf8")).toBe(original);
      expect(existsSync(requestFile)).toBe(true);
      expect(statSync(requestFile).mode & 0o777).toBe(0o600);
      expect(result.stdout).toContain(success(EN.statuslineCustomRequested));
      expect([
        PT.statuslineChoices.custom,
        PT.statuslineChoiceHints.custom,
        PT.statuslineCustomRequested,
      ]).toEqual([
        "Pedir ao Claude para customizar com a minha",
        "no próximo 'claude --telegram', o Claude junta o indicador à sua do jeito que você quiser",
        "Pedido anotado:\n  • no próximo 'claude --telegram', o Claude pergunta como juntar o indicador à sua statusline",
      ]);
    });

    it("--statusline-prompt --take hands the request over once, in the language of the setup, and remembers it was done", () => {
      writeConfig({ language: "pt-br" });
      runSetup(["--set", "statusline", "custom"], "");

      const taken = runSetup(["--statusline-prompt", "--take"], "");

      expect(taken.status).toBe(0);
      expect(taken.stdout).toBe(
        `${PT.statuslineCustomPrompt(settingsFile, JSON.stringify(mine), statuslineCommand(), PT.statusConnected(PT.statusMain))}\n`,
      );
      expect(existsSync(requestFile)).toBe(false);
      expect(readConfig().statuslineCustomized).toBe(true);
      expect(runSetup(["--statusline-prompt", "--take"], "").stdout).toBe("");
      expect(
        PT.statuslineCustomPrompt(
          "/c/settings.json",
          '{"x":1}',
          'node "/s.mjs"',
          "📱 ok",
        ),
      ).toBe(
        [
          "O setup do better-claude-code-telegram pediu que você junte o indicador do Telegram à minha statusline.",
          "",
          "Minha statusline hoje (statusLine em /c/settings.json):",
          '  {"x":1}',
          "",
          "O indicador é este comando:",
          '  node "/s.mjs"',
          "Ele imprime o estado do Telegram com cor ANSI (por exemplo 📱 ok) ou nada, e não lê a entrada.",
          "",
          "Faça assim:",
          "  • antes de mudar algo, pergunte como eu quero juntar os dois (onde fica o indicador, separador, cor)",
          "  • mude só a minha statusline, para ela chamar também o indicador",
          "  • se o arquivo do indicador não existir mais, a statusline continua funcionando sem ele",
          "  • no fim, mostre o que mudou",
        ].join("\n"),
      );
    });

    it("--statusline-prompt without --take prints the request for /bcct:statusline, with no note needed", () => {
      const result = runSetup(["--statusline-prompt"], "");

      expect(result.stdout).toBe(
        `${EN.statuslineCustomPrompt(settingsFile, JSON.stringify(mine), statuslineCommand(), EN.statusConnected(EN.statusMain))}\n`,
      );
      expect(existsSync(requestFile)).toBe(false);
    });

    it("drops the request without handing it over when the status line is no longer someone else's", () => {
      runSetup(["--set", "statusline", "custom"], "");
      writeFileSync(settingsFile, "{}\n");

      const taken = runSetup(["--statusline-prompt", "--take"], "");

      expect(taken.stdout).toBe("");
      expect(existsSync(requestFile)).toBe(false);
      expect(readConfig().statuslineCustomized).toBeUndefined();
    });

    it("once Claude fitted the indicator, keeping says the indicator is there instead of saying it is not", () => {
      runSetup(["--set", "statusline", "custom"], "");
      runSetup(["--statusline-prompt", "--take"], "");

      const kept = runSetup(["statusline"], "\n");

      expect(kept.status).toBe(0);
      expect(kept.stdout).toContain(skipped(EN.statuslineCustomKept));
      expect(kept.stdout).not.toContain(EN.statuslineKept);
      expect(readConfig().statuslineCustomized).toBe(true);
      expect([
        PT.statuslineCustomKept,
        PT.statuslineChoices.keepCustom,
      ]).toEqual([
        "Statusline mantida:\n  • a sua, com o indicador que o Claude juntou",
        "Manter a sua (já com o indicador)",
      ]);
    });

    it("refuses custom when there is no status line of someone else to fit it into", () => {
      writeFileSync(settingsFile, "{}\n");

      const result = runSetup(["--set", "statusline", "custom"], "");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(EN.statuslineCustomNeedsOwn);
      expect(existsSync(requestFile)).toBe(false);
    });

    it("shows the request as pending and then as done, and forgets both when another choice is made", () => {
      runSetup(["--set", "statusline", "custom"], "");

      expect(currentState(stateDir, appDir, settingsFile).statusline).toBe(
        "custom-pending",
      );

      runSetup(["--statusline-prompt", "--take"], "");

      expect(currentState(stateDir, appDir, settingsFile).statusline).toBe(
        "custom",
      );

      expect([
        PT.healthDetail.statusline.custom,
        PT.healthDetail.statusline["custom-pending"],
      ]).toEqual([
        "a sua, com o indicador que o Claude juntou",
        "o Claude junta o indicador à sua no próximo 'claude --telegram'",
      ]);

      runSetup(["--set", "statusline", "after"], "");

      expect(readConfig().statuslineCustomized).toBeUndefined();
      expect(currentState(stateDir, appDir, settingsFile).statusline).toBe(
        "ours-after",
      );
    });
  });

  it("statusline '1' runs ours after the status line of someone else, keeping the previous one privately", () => {
    const settingsFile = join(configDir, "settings.json");
    const previous = { type: "command", command: "mine", padding: 1 };
    writeFileSync(settingsFile, JSON.stringify({ statusLine: previous }));

    const result = runSetup(["statusline"], "1\n");
    const previousFile = join(appDir, "statusline-previous.json");

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).statusLine).toEqual({
      type: "command",
      command: statuslineAfterCommand(),
    });
    expect(JSON.parse(readFileSync(previousFile, "utf8"))).toEqual(previous);
    expect(statSync(previousFile).mode & 0o777).toBe(0o600);
    expect(result.stdout).toContain(
      MESSAGES["en-us"].statuslineChained(settingsFile),
    );
  });

  it("statusline '2' replaces the status line of someone else after a private backup of settings.json", () => {
    const settingsFile = join(configDir, "settings.json");
    const original = JSON.stringify({
      theme: "dark",
      statusLine: { type: "command", command: "mine" },
    });
    writeFileSync(settingsFile, original);

    const result = runSetup(["statusline"], "2\n");
    const backup = readdirSync(configDir).find((name) =>
      name.startsWith("settings.json.bak."),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      theme: "dark",
      statusLine: { type: "command", command: statuslineCommand() },
    });
    expect(readFileSync(join(configDir, backup), "utf8")).toBe(original);
    expect(statSync(join(configDir, backup)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(
        readFileSync(join(appDir, "statusline-previous.json"), "utf8"),
      ),
    ).toEqual({ type: "command", command: "mine" });
    expect(result.stdout).toContain(
      MESSAGES["en-us"].statuslineReplaced(
        settingsFile,
        join(configDir, backup),
      ),
    );
  });

  it("statusline that is already ours asks whether to keep or remove it, and Enter keeps it untouched", () => {
    const EN = MESSAGES["en-us"];
    const PT = MESSAGES["pt-br"];
    const settingsFile = join(configDir, "settings.json");
    const original = JSON.stringify({
      statusLine: { type: "command", command: statuslineAfterCommand() },
    });
    writeFileSync(settingsFile, original);
    writeFileSync(
      join(appDir, "statusline-previous.json"),
      JSON.stringify({ type: "command", command: "mine" }),
    );

    const result = runSetup(["statusline"], "\n");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `${EN.statuslineOursQuestion(EN.statusConnected(EN.statusMain))} (keep, remove) [default: keep]: `,
    );
    expect(readFileSync(settingsFile, "utf8")).toBe(original);
    expect(result.stdout).toContain(skipped(EN.statuslineOursKept));
    expect([
      PT.statuslineOursQuestion(PT.statusConnected(PT.statusMain)),
      PT.statuslineOursChoices.keep,
      PT.statuslineOursChoices.remove,
      PT.statuslineOursHints.keep,
      PT.statuslineOursHints.restore,
      PT.statuslineOursHints.remove,
      PT.statuslineOursKept,
    ]).toEqual([
      "O indicador do Telegram (📱 (Principal) Telegram conectado) já está na sua statusline. O que fazer com ele?",
      "Manter",
      "Remover",
      "nada muda",
      "a sua statusline anterior volta",
      "o rodapé fica sem statusline",
      "Statusline mantida com o indicador do Telegram.",
    ]);
  });

  it("statusline '2' removes ours and brings back the status line it ran after", () => {
    const settingsFile = join(configDir, "settings.json");
    const previousFile = join(appDir, "statusline-previous.json");
    const previous = { type: "command", command: "mine", padding: 1 };
    writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: "dark",
        statusLine: { type: "command", command: statuslineAfterCommand() },
      }),
    );
    writeFileSync(previousFile, JSON.stringify(previous));

    const result = runSetup(["statusline"], "2\n");

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      theme: "dark",
      statusLine: previous,
    });
    expect(existsSync(previousFile)).toBe(false);
    expect(result.stdout).toContain(
      success(MESSAGES["en-us"].statuslineRestored(settingsFile)),
    );
  });

  it("statusline 'remove' takes ours out when there was no status line before it", () => {
    const settingsFile = join(configDir, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        theme: "dark",
        statusLine: { type: "command", command: statuslineCommand() },
      }),
    );

    const result = runSetup(["statusline"], "remove\n");

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8"))).toEqual({
      theme: "dark",
    });
    expect(result.stdout).toContain(
      success(MESSAGES["en-us"].statuslineRemoved(settingsFile)),
    );
  });

  it("statusline refuses an invalid settings.json before asking, and leaves it untouched", () => {
    const settingsFile = join(configDir, "settings.json");
    const original = '{ "theme": "dark", ';
    writeFileSync(settingsFile, original);

    const result = runSetup(["statusline"], "y\n");

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(
      MESSAGES["en-us"].statuslinePrompt(
        MESSAGES["en-us"].statusConnected(MESSAGES["en-us"].statusMain),
      ),
    );
    expect(result.stderr).toContain(
      MESSAGES["en-us"].settingsInvalid(settingsFile),
    );
    expect(readFileSync(settingsFile, "utf8")).toBe(original);
  });

  it("statusline keeps the mode of settings.json and leaves no temporary file", () => {
    const settingsFile = join(configDir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ theme: "dark" }));
    chmodSync(settingsFile, 0o640);

    expect(runSetup(["statusline"], "y\n").status).toBe(0);
    expect(statSync(settingsFile).mode & 0o777).toBe(0o640);
    expect(readdirSync(configDir)).toEqual(["settings.json"]);
  });

  it("statusline accepts 's' as yes in pt-br", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["statusline"], "s\n");
    const settingsFile = join(configDir, "settings.json");

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).statusLine).toEqual({
      type: "command",
      command: statuslineCommand(),
    });
    expect(result.stdout).toContain(
      `Statusline configurada em ${settingsFile}.`,
    );
  });

  it("--set says a value that did not change was kept, without writing it again", () => {
    const EN = MESSAGES["en-us"];
    const configFile = join(appDir, CONFIG_NAME);
    writeConfig({
      language: "en-us",
      delayMinutes: 4,
      quietHours: null,
      transcription: null,
      inboxRetentionDays: 7,
    });
    const modified = statSync(configFile).mtimeMs;
    const outputs = [
      ["language", "en-us"],
      ["delay", "4"],
      ["quiet-hours", "off"],
      ["transcription", "off"],
      ["inbox", "7"],
    ].map(([step, value]) => runSetup(["--set", step, value], "").stdout);

    expect(outputs).toEqual([
      `${skipped(EN.languageKept("en-us"))}\n`,
      `${skipped(EN.delayKept(4))}\n`,
      `${skipped(EN.quietKept(EN.quietOff))}\n`,
      `${skipped(EN.transcriptionKeptOff)}\n`,
      `${skipped(EN.inboxKept(EN.inboxDays(7)))}\n`,
    ]);
    expect(statSync(configFile).mtimeMs).toBe(modified);
  });

  it("--set saves a step without asking anything, in the language of the setup", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["--set", "delay", "5"], "");

    expect(result.status).toBe(0);
    expect(readConfig()).toEqual({ language: "pt-br", delayMinutes: 5 });
    expect(result.stdout).toContain("Espera de 5 min salva em");
  });

  it("--set accepts the language, the quiet hours and turning the transcription off", () => {
    expect(runSetup(["--set", "language", "pt-br"], "").status).toBe(0);
    expect(runSetup(["--set", "quiet-hours", "23:00-07:00"], "").status).toBe(
      0,
    );
    expect(runSetup(["--set", "transcription", "off"], "").status).toBe(0);

    expect(readConfig()).toEqual({
      language: "pt-br",
      quietHours: { start: "23:00", end: "07:00" },
      transcription: null,
    });

    expect(runSetup(["--set", "quiet-hours", "off"], "").status).toBe(0);
    expect(readConfig().quietHours).toBeNull();
  });

  it("--set refuses an invalid value and says what it accepts, changing nothing", () => {
    const result = runSetup(["--set", "delay", "soon"], "");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      MESSAGES["en-us"].invalidSetting(
        "delay",
        "soon",
        MESSAGES["en-us"].settingHints.delay,
      ),
    );
    expect(existsSync(join(appDir, CONFIG_NAME))).toBe(false);
  });

  it("--set refuses a step it cannot set without the terminal", () => {
    const result = runSetup(["--set", "token", "123:abc"], "");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      MESSAGES["en-us"].notSettable(
        "token",
        "language, delay, quiet-hours, transcription, inbox, statusline",
      ),
    );
    expect(result.stdout).not.toContain("123:abc");
  });

  it("--set statusline turns ours on, runs it after someone else's, and off brings theirs back", () => {
    const settingsFile = join(configDir, "settings.json");

    expect(runSetup(["--set", "statusline", "on"], "").status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).statusLine).toEqual({
      type: "command",
      command: statuslineCommand(),
    });

    writeFileSync(
      settingsFile,
      JSON.stringify({ statusLine: { type: "command", command: "mine" } }),
    );

    expect(runSetup(["--set", "statusline", "after"], "").status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).statusLine).toEqual({
      type: "command",
      command: statuslineAfterCommand(),
    });

    expect(runSetup(["--set", "statusline", "off"], "").status).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile, "utf8")).statusLine).toEqual({
      type: "command",
      command: "mine",
    });
  });

  it("--show prints the current state as JSON, with no secret", () => {
    writeSetupDone();
    writeConfig({ language: "pt-br", delayMinutes: 5 });

    const result = runSetup(["--show"], "");

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      language: "pt-br",
      delayMinutes: 5,
      quietHours: null,
      transcription: null,
      inboxRetentionDays: 7,
      statusline: "none",
      token: true,
      pairedAccounts: 1,
    });
    expect(result.stdout).not.toContain("FAKE");
  });

  it("inbox asks how many days to keep received files, 7 by default, and 'off' keeps them forever", () => {
    const first = runSetup(["inbox"], "\n");

    expect(first.status).toBe(0);
    expect(first.stdout).toContain(
      `${MESSAGES["en-us"].inboxQuestion} (1, 3, 7, 14, 30, off, N) [default: 7]: `,
    );
    expect(readConfig()).toEqual({ inboxRetentionDays: 7 });

    expect(runSetup(["inbox"], "3\n").status).toBe(0);
    expect(readConfig()).toEqual({ inboxRetentionDays: 3 });

    expect(runSetup(["inbox"], "off\n").status).toBe(0);
    expect(readConfig()).toEqual({ inboxRetentionDays: null });

    expect(runSetup(["inbox"], "soon\n0\n\n").status).toBe(0);
    expect(readConfig()).toEqual({ inboxRetentionDays: null });

    expect(runSetup(["inbox"], "10\n").status).toBe(0);
    expect(readConfig()).toEqual({ inboxRetentionDays: 10 });
  });

  it("--set inbox saves the days or off, and refuses anything else", () => {
    expect(runSetup(["--set", "inbox", "14"], "").status).toBe(0);
    expect(readConfig()).toEqual({ inboxRetentionDays: 14 });

    expect(runSetup(["--set", "inbox", "off"], "").status).toBe(0);
    expect(readConfig()).toEqual({ inboxRetentionDays: null });

    expect(runSetup(["--set", "inbox", "0"], "").status).toBe(1);
  });

  it("an unknown step exits 1 with the list of valid steps", () => {
    const result = runSetup(["modelo"], "");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Unknown step:\n  • modelo\nUse one or more of these (none runs them all):\n  • ${SECTIONS_LIST}`,
    );
  });

  it("--check exits 1 and says to run the setup when something is missing, in en-us", () => {
    const result = runSetup(["--check"], "");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Missing:\n {2}• bot token, pairing/u);
    expect(result.stderr).toMatch(/npm run setup/);
  });

  it("--check speaks the language of the system before the setup chose one", () => {
    const result = runSetup(["--check"], "", { LANG: "pt_BR.UTF-8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      MESSAGES["pt-br"].notConfigured(
        `${MESSAGES["pt-br"].stepLabels.token}, ${MESSAGES["pt-br"].stepLabels.pairing}`,
        "npm run setup",
      ),
    );
  });

  it("--check exits 1 and says to run the setup when something is missing, in pt-br", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["--check"], "");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Falta:\n {2}• token do bot, pareamento/u);
    expect(result.stderr).toMatch(/npm run setup/);
  });

  it("--check exits 0 in silence with setup done", () => {
    writeSetupDone();

    const result = runSetup(["--check"], "");

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("pairing without a saved token asks for the token step", () => {
    const result = runSetup(["pairing"], "");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "No saved token. Run this first:\n  npm run setup -- token",
    );
  });

  it("pairing without a saved token asks for the token step in pt-br", () => {
    writeConfig({ language: "pt-br" });

    const result = runSetup(["pairing"], "");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Nenhum token salvo. Rode antes:\n  npm run setup -- token",
    );
  });
});
