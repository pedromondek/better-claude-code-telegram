import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MESSAGES } from "../../plugins/telegram-hooks/lib/messages.mjs";
import {
  BCCT_PLUGIN_ID,
  CHANNEL_PLUGIN_ID,
  HOOKS_PLUGIN_ID,
  MARKETPLACE_NAME,
  SHELL_MARKER,
  sourceLine,
  statuslineCommand,
} from "../setup.mjs";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const SETUP = join(ROOT_DIR, "scripts", "setup.mjs");
const SHELL_FILE = join(ROOT_DIR, "scripts", "shell.sh");
const TOKEN = "123456:E2E-FAKE-TOKEN";
const DEV_ID = 42;
const STRANGER_ID = 13;
const PT = MESSAGES["pt-br"];

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CLAUDE_STATE;
let state = { marketplaces: [], plugins: [] };
try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const command = args.slice(0, 3).join(" ");
if (command === "plugin marketplace list") console.log(state.marketplaces.join("\\n"));
if (command === "plugin marketplace add") {
  state.marketplaces.push("${MARKETPLACE_NAME}");
  console.log("✔ Successfully added marketplace: ${MARKETPLACE_NAME} (declared in user settings)");
}
if (args[1] === "install" && args[2] === process.env.FAKE_CLAUDE_FAIL) {
  console.error("Plugin not found in marketplace");
  process.exit(1);
}
if (args[1] === "install") console.log("✔ Successfully installed plugin: " + args[2] + " (scope: user)");
if (command === "plugin marketplace remove") state.marketplaces = [];
if (args.slice(0, 2).join(" ") === "plugin list") console.log(state.plugins.join("\\n"));
if (args[1] === "install") state.plugins.push(args[2]);
if (args[1] === "uninstall") state.plugins = state.plugins.filter((id) => id !== args[2]);
writeFileSync(stateFile, JSON.stringify(state));
if (["install", "enable", "disable", "uninstall"].includes(args[1])) {
  const settingsFile = require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsFile, "utf8")); } catch {}
  const enabled = { ...settings.enabledPlugins };
  if (args[1] === "uninstall") delete enabled[args[2]];
  else enabled[args[2]] = args[1] !== "disable";
  if (Object.keys(enabled).length === 0) delete settings.enabledPlugins;
  else settings.enabledPlugins = enabled;
  writeFileSync(settingsFile, JSON.stringify(settings));
}
`;

let workDir;
let homeDir;
let configDir;
let stateDir;
let appDir;
let binDir;
let telegram;

function privateUpdate(updateId, from, text) {
  return {
    update_id: updateId,
    message: { chat: { type: "private" }, from, text },
  };
}

function createFakeTelegram() {
  const calls = [];
  const fake = { calls, code: null, canJoinGroups: false };
  const pending = [
    privateUpdate(6, { id: STRANGER_ID, username: "stranger" }, "/start"),
  ];
  let codeSent = null;
  let nextUpdateId = 7;

  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const method = (request.url ?? "").split("/").pop() ?? "";
      const params = body ? JSON.parse(body) : {};
      let result = true;

      calls.push({ method, params, url: request.url });

      if (method === "getMe") {
        result = { username: "e2e_bot", can_join_groups: fake.canJoinGroups };
      }
      if (method === "getWebhookInfo") result = { url: "" };
      if (method === "getChat") {
        result = { id: Number(params.chat_id), username: "dev" };
      }
      if (method === "getUpdates") {
        if (fake.code && codeSent !== fake.code) {
          codeSent = fake.code;
          pending.push(
            privateUpdate(
              nextUpdateId++,
              { id: DEV_ID, username: "dev" },
              `/start ${fake.code}`,
            ),
          );
        }

        result =
          params.offset === -1
            ? []
            : pending.filter((update) => update.update_id >= params.offset);
      }

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result }));
    });
  });

  fake.server = server;

  return fake;
}

function runSetup(args, input, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SETUP, ...args], {
      env: {
        ...extraEnv,
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: configDir,
        SHELL: "/bin/zsh",
        LANG: "C",
        BETTER_CC_TELEGRAM_API_ROOT: `http://127.0.0.1:${telegram.server.address().port}`,
        FAKE_CLAUDE_LOG: join(workDir, "claude.log"),
        FAKE_CLAUDE_STATE: join(workDir, "claude.json"),
      },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      telegram.code ??= /\?start=([0-9a-f]{8})/.exec(stdout)?.[1] ?? null;
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function claudeCalls() {
  const log = join(workDir, "claude.log");

  if (!existsSync(log)) return [];

  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-setup-e2e-"));
  homeDir = join(workDir, "home");
  configDir = join(homeDir, ".claude");
  stateDir = join(configDir, "channels", "telegram");
  appDir = join(configDir, "better-claude-code-telegram");
  binDir = join(workDir, "bin");
  mkdirSync(homeDir);
  mkdirSync(binDir);
  writeFileSync(join(binDir, "claude"), FAKE_CLAUDE);
  writeFileSync(join(binDir, "bun"), "#!/bin/sh\nexit 0\n");
  symlinkSync(process.execPath, join(binDir, "node"));
  chmodSync(join(binDir, "claude"), 0o755);
  chmodSync(join(binDir, "bun"), 0o755);

  telegram = createFakeTelegram();
  await new Promise((resolveListen) =>
    telegram.server.listen(0, "127.0.0.1", resolveListen),
  );
});

afterEach(async () => {
  await new Promise((resolveClose) => telegram.server.close(resolveClose));
  rmSync(workDir, { recursive: true, force: true });
});

describe("setup from a fresh machine", () => {
  const answers = [
    "pt-br",
    "s",
    "s",
    TOKEN,
    "s",
    "5",
    "23:00-07:00",
    "não",
    "10",
    "s",
    "",
  ].join("\n");

  it("asks the language first and goes on in it to the end", async () => {
    const result = await runSetup([], answers);

    expect(result.status).toBe(0);
    expect(
      result.stdout.startsWith(
        `[en-us] ${MESSAGES["en-us"].enterKeepsDefault} / [pt-br] ${PT.enterKeepsDefault}\n\n── 🌐 1/10 Language / Idioma ──\nLanguage / Idioma (en-us, pt-br)`,
      ),
    ).toBe(true);
    expect(result.stdout).toContain(PT.pairedWith("@dev"));
    expect(result.stdout.trimEnd().endsWith(PT.doneAll)).toBe(true);
  });

  it("marks the pairing step with the link icon", async () => {
    const result = await runSetup([], answers);

    expect(result.stdout).toContain(`── 🔗 4/10 ${PT.stepTitles.pairing} ──`);
  });

  it("ends the whole setup with the health checks, before saying it is done", async () => {
    const result = await runSetup([], answers);
    const health = result.stdout.indexOf(
      `── 🩺 10/10 ${PT.stepTitles.health} ──`,
    );

    expect(result.status).toBe(0);
    expect(health).toBeGreaterThan(-1);
    expect(
      result.stdout.indexOf(`✔ ${PT.healthLabels.token}:`),
    ).toBeGreaterThan(health);
    expect(
      result.stdout.indexOf(`✔ ${PT.healthLabels.pairing}:`),
    ).toBeGreaterThan(health);
    expect(result.stdout).not.toContain("✘");
    expect(result.stdout.lastIndexOf(PT.doneAll)).toBeGreaterThan(health);
  });

  it("runs the health checks only at the end of the whole setup", async () => {
    await runSetup([], answers);

    const step = await runSetup(["delay"], "\n");

    expect(step.stdout).not.toContain(PT.stepTitles.health);
  });

  it("saves the token, the pairing and the config privately, and never prints the token", async () => {
    const result = await runSetup([], answers);

    expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe(
      `TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
    );
    expect(statSync(join(stateDir, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(readJson(join(stateDir, "access.json")).allowFrom).toEqual([
      String(DEV_ID),
    ]);
    expect(readJson(join(appDir, "better-cc-telegram.json"))).toEqual({
      language: "pt-br",
      delayMinutes: 5,
      quietHours: { start: "23:00", end: "07:00" },
      transcription: null,
      inboxRetentionDays: 10,
    });
    expect(readdirSync(stateDir).toSorted()).toEqual([".env", "access.json"]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(TOKEN);
  });

  it("blocks Claude from reading the file that holds the token", async () => {
    const result = await runSetup([], answers);
    const rule = "Read(~/.claude/channels/telegram/.env)";

    expect(readJson(join(configDir, "settings.json")).permissions).toEqual({
      deny: [rule],
    });
    expect(result.stdout).toContain(
      PT.envProtected(join(stateDir, ".env"), join(configDir, "settings.json")),
    );
  });

  it("registers this repository as the marketplace, installs the three plugins and keeps the channel off outside the launcher", async () => {
    await runSetup([], answers);

    expect(claudeCalls()).toEqual([
      ["plugin", "marketplace", "list"],
      ["plugin", "list"],
      ["plugin", "marketplace", "add", ROOT_DIR],
      ["plugin", "install", CHANNEL_PLUGIN_ID, "--scope", "user"],
      ["plugin", "install", HOOKS_PLUGIN_ID, "--scope", "user"],
      ["plugin", "install", BCCT_PLUGIN_ID, "--scope", "user"],
      ["plugin", "disable", CHANNEL_PLUGIN_ID, "--scope", "user"],
      ["plugin", "list"],
    ]);
  });

  it("sums up what it found before asking anything about the plugins, required and optional apart", async () => {
    const fresh = await runSetup([], answers);
    const summary = fresh.stdout.indexOf(
      [
        `○ ${PT.pluginsChecked}`,
        `  ○ ${PT.marketplaceMissing}`,
        `  ○ ${PT.requiredPlugins(0, 2)}`,
        `  ○ ${PT.optionalPlugins(0, 1)}`,
      ].join("\n"),
    );

    expect(summary).toBeGreaterThan(-1);
    expect(fresh.stdout.indexOf(PT.bcctPrompt)).toBeGreaterThan(summary);

    const again = await runSetup([], "\n".repeat(9));

    expect(again.stdout).toContain(
      [
        `✔ ${PT.pluginsChecked}`,
        `  ✔ ${PT.marketplaceFound}`,
        `  ✔ ${PT.requiredPlugins(2, 2)}`,
        `  ✔ ${PT.optionalPlugins(1, 1)}`,
      ].join("\n"),
    );
    expect([
      PT.pluginsChecked,
      PT.marketplaceFound,
      PT.marketplaceMissing,
      PT.requiredPlugins(2, 2),
      PT.optionalPlugins(0, 1),
      PT.bcctPrompt,
    ]).toEqual([
      "Conferido:",
      "Marketplace registrado",
      "Marketplace ainda não registrado",
      "2 de 2 plugins obrigatórios instalados",
      "0 de 1 plugin opcional instalado",
      "(opcional) Adicionar também ao Claude Code os comandos /bcct: (etapas do setup e health de dentro da sessão)?",
    ]);
  });

  it("asks to go ahead with the required plugins first and only then about the optional commands", async () => {
    const result = await runSetup([], answers);
    const planPrompt = result.stdout.indexOf(PT.planPrompt);

    expect(planPrompt).toBeGreaterThan(-1);
    expect(result.stdout.indexOf(PT.bcctPrompt)).toBeGreaterThan(planPrompt);
    expect(result.stdout).not.toContain(PT.planPlugin(BCCT_PLUGIN_ID));
    expect(result.stdout).toContain(`✔ ${PT.pluginAdded(BCCT_PLUGIN_ID)}`);
  });

  it("checks green with the required plugins in place, even when the optional one is missing", async () => {
    await runSetup([], answers.replace("pt-br\ns\ns\n", "pt-br\ns\nn\n"));

    const again = await runSetup([], "\n".repeat(10));

    expect(again.stdout).toContain(
      [
        `✔ ${PT.pluginsChecked}`,
        `  ✔ ${PT.marketplaceFound}`,
        `  ✔ ${PT.requiredPlugins(2, 2)}`,
        `  ○ ${PT.optionalPlugins(0, 1)}`,
      ].join("\n"),
    );
  });

  it("says the plugins it just installed are enabled, without calling them already enabled", async () => {
    const fresh = await runSetup([], answers);

    expect(fresh.stdout).toContain(`✔ ${PT.pluginEnabled(HOOKS_PLUGIN_ID)}`);
    expect(fresh.stdout).toContain(`✔ ${PT.pluginEnabled(BCCT_PLUGIN_ID)}`);
    expect(fresh.stdout).not.toContain(
      PT.pluginAlreadyEnabled(HOOKS_PLUGIN_ID),
    );

    const again = await runSetup([], "\n".repeat(9));

    expect(again.stdout).toContain(
      `○ ${PT.pluginAlreadyEnabled(HOOKS_PLUGIN_ID)}`,
    );
  });

  it("speaks for claude with its own lines instead of showing the output of claude", async () => {
    const result = await runSetup([], answers);

    expect(result.stdout).not.toContain("Successfully");
    expect(result.stdout).toContain(
      `✔ ${PT.marketplaceAdded(MARKETPLACE_NAME)}`,
    );
    expect(result.stdout).toContain(`✔ ${PT.pluginAdded(CHANNEL_PLUGIN_ID)}`);
    expect(result.stdout).toContain(`✔ ${PT.pluginAdded(BCCT_PLUGIN_ID)}`);
  });

  it("leaves out the lines that say what is running when the output is not a terminal", async () => {
    const result = await runSetup([], answers);

    for (const running of [
      PT.pluginsChecking,
      PT.marketplaceAdding(MARKETPLACE_NAME),
      PT.pluginInstalling(CHANNEL_PLUGIN_ID),
      PT.pluginEnabling(HOOKS_PLUGIN_ID),
      PT.pluginDisabling(CHANNEL_PLUGIN_ID),
    ]) {
      expect(result.stdout).not.toContain(running);
    }
    expect(result.stdout).not.toContain("\u001B[2K");
  });

  it("shows what claude said when one of its commands fails", async () => {
    const result = await runSetup([], answers, {
      FAKE_CLAUDE_FAIL: HOOKS_PLUGIN_ID,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `claude plugin install ${HOOKS_PLUGIN_ID} --scope user`,
    );
    expect(result.stderr).toContain("Plugin not found in marketplace");
  });

  it("asks whether to add the /bcct: commands to Claude Code, and leaves them out when declined", async () => {
    const declined = answers.replace("pt-br\ns\ns\n", "pt-br\ns\nn\n");
    const result = await runSetup([], declined);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PT.bcctPrompt);
    expect(result.stdout).not.toContain(PT.planPlugin(BCCT_PLUGIN_ID));
    expect(
      claudeCalls().filter((args) => args.includes(BCCT_PLUGIN_ID)),
    ).toEqual([]);
  });

  it("asks whether to keep or remove the /bcct: commands once they are installed, and Enter keeps them", async () => {
    await runSetup([], answers);
    const before = claudeCalls().length;

    const kept = await runSetup(["plugin"], "\n");

    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain(
      `${PT.bcctInstalledQuestion} (keep, remove) [padrão: keep]: `,
    );
    expect(kept.stdout).not.toContain(PT.bcctPrompt);
    expect(
      claudeCalls()
        .slice(before)
        .filter((args) => args[1] === "uninstall"),
    ).toEqual([]);
    expect([
      PT.bcctInstalledQuestion,
      PT.bcctChoices.keep,
      PT.bcctChoices.remove,
      PT.bcctHints.keep,
      PT.bcctHints.remove,
    ]).toEqual([
      "(opcional) Os comandos /bcct: já estão no Claude Code. O que fazer com eles?",
      "Manter",
      "Remover",
      "nada muda",
      "os comandos /bcct: deixam o Claude Code; o setup continua no terminal",
    ]);
  });

  it("removes the /bcct: commands when asked, keeping the required plugins", async () => {
    await runSetup([], answers);
    const before = claudeCalls().length;

    const removed = await runSetup(["plugin"], "remove\n");
    const calls = claudeCalls().slice(before);

    expect(removed.status).toBe(0);
    expect(calls).toContainEqual([
      "plugin",
      "uninstall",
      BCCT_PLUGIN_ID,
      "--scope",
      "user",
    ]);
    expect(calls.filter((args) => args[1] === "uninstall")).toHaveLength(1);
    expect(removed.stdout).toContain(`✔ ${PT.pluginRemoved(BCCT_PLUGIN_ID)}`);
    expect(
      readJson(join(configDir, "settings.json")).enabledPlugins,
    ).not.toHaveProperty(BCCT_PLUGIN_ID);
    expect(PT.changeKinds.pluginRemoved(BCCT_PLUGIN_ID)).toBe(
      `removeu o plugin '${BCCT_PLUGIN_ID}'`,
    );

    const again = await runSetup(["plugin"], "\n");

    expect(again.stdout).toContain(PT.bcctPrompt);
  });

  it("creates the rc of the shell with the launcher line and sets the status line", async () => {
    await runSetup([], answers);

    expect(readFileSync(join(homeDir, ".zshrc"), "utf8")).toBe(
      `${SHELL_MARKER}\n${sourceLine(SHELL_FILE)}\n`,
    );
    expect(readJson(join(configDir, "settings.json")).statusLine).toEqual({
      type: "command",
      command: statuslineCommand(),
    });
  });

  it("pairs only the account that sends the code shown in the terminal, ignoring a stranger, and greets it", async () => {
    const result = await runSetup([], answers);

    expect(
      telegram.calls.every(({ url }) => url.startsWith(`/bot${TOKEN}/`)),
    ).toBe(true);
    expect(result.stdout).toContain(
      PT.sendPairingCode(
        "e2e_bot",
        telegram.code,
        `https://t.me/e2e_bot?start=${telegram.code}`,
      ),
    );
    expect(
      telegram.calls.filter(({ method }) => method === "sendMessage"),
    ).toEqual([
      expect.objectContaining({
        params: { chat_id: String(DEV_ID), text: PT.pairedChatMessage },
      }),
    ]);
    expect(readJson(join(stateDir, "access.json")).allowFrom).toEqual([
      String(DEV_ID),
    ]);
  });

  it("warns how to keep the bot out of groups only when it can join them", async () => {
    const quiet = await runSetup([], answers);

    expect(quiet.stdout).not.toContain(PT.groupsWarning("e2e_bot"));

    telegram.canJoinGroups = true;
    rmSync(join(stateDir, "access.json"));
    telegram.code = null;

    const warned = await runSetup(["token"], `${TOKEN}\n`);

    expect(warned.status).toBe(0);
    expect(warned.stdout).toContain(PT.groupsWarning("e2e_bot"));
  });

  it("offers to install a missing requirement and stops with the command to run by hand when declined", async () => {
    rmSync(join(binDir, "bun"));

    const result = await runSetup([], "pt-br\nn\n");

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      PT.installToolPrompt(
        "bun",
        'curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"',
      ),
    );
    expect(result.stderr).not.toContain("✘");
    expect(result.stdout).toContain(
      [
        `✔ ${PT.toolsDeclined("bun")}`,
        PT.byHand,
        'curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"',
      ].join("\n"),
    );
    expect(claudeCalls()).toEqual([]);
  });

  it("shows what the plugin step will install and asks before touching anything", async () => {
    const result = await runSetup([], answers);
    const plan = result.stdout.indexOf(PT.planHeader);

    expect(plan).toBeGreaterThan(-1);
    expect(result.stdout.slice(plan)).toContain(
      PT.planPlugin(CHANNEL_PLUGIN_ID),
    );
    expect(result.stdout.slice(plan)).toContain(
      PT.planShellLine(join(homeDir, ".zshrc")),
    );
    expect(result.stdout.indexOf(PT.planPrompt)).toBeGreaterThan(plan);
  });

  it("declining the plugin step installs nothing and stops with the commands to run by hand", async () => {
    const result = await runSetup([], "pt-br\nn\n");

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(PT.bcctPrompt);
    expect(claudeCalls()).toEqual([
      ["plugin", "marketplace", "list"],
      ["plugin", "list"],
    ]);
    expect(existsSync(join(homeDir, ".zshrc"))).toBe(false);
    expect(result.stderr).not.toContain("✘");
    expect(result.stdout).toContain(
      [
        `✔ ${PT.nothingInstalled}`,
        PT.byHand,
        `claude plugin marketplace add ${ROOT_DIR}`,
        `claude plugin install ${CHANNEL_PLUGIN_ID} --scope user`,
      ].join("\n"),
    );
    expect([PT.nothingInstalled, PT.byHand]).toEqual([
      "Nada foi instalado.",
      "Para fazer à mão, rode:",
    ]);
  });

  it("lets the launcher through once the setup is done", async () => {
    await runSetup([], answers);

    expect((await runSetup(["--check"], "")).status).toBe(0);
  });

  it("running the whole setup again with Enter on every question keeps every saved value", async () => {
    await runSetup([], answers);
    const files = [
      join(stateDir, ".env"),
      join(stateDir, "access.json"),
      join(appDir, "better-cc-telegram.json"),
      join(configDir, "settings.json"),
      join(homeDir, ".zshrc"),
    ];
    const before = files.map((file) => readFileSync(file, "utf8"));
    const messagesSent = telegram.calls.filter(
      ({ method }) => method === "sendMessage",
    ).length;

    const again = await runSetup([], "\n".repeat(9));

    expect(again.status).toBe(0);
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
    expect(again.stdout).toContain(PT.useSavedBot("e2e_bot"));
    expect(again.stdout).not.toContain(PT.tokenPrompt);
    expect(again.stdout).not.toContain(telegram.code);
    expect(
      telegram.calls.filter(({ method }) => method === "sendMessage"),
    ).toHaveLength(messagesSent);
    expect(again.stdout.trimEnd().endsWith(PT.doneAll)).toBe(true);
  });

  it("marks what was already in place as skipped, naming the paired account", async () => {
    await runSetup([], answers);

    const again = await runSetup([], "\n".repeat(9));

    expect(again.stdout).toContain(
      `○ ${PT.alreadyPaired(`@dev (id ${DEV_ID})`)}`,
    );
    expect(again.stdout).toContain(`○ ${PT.pluginInstalled(BCCT_PLUGIN_ID)}`);
    expect(again.stdout).toContain(
      `○ ${PT.marketplaceRegistered(MARKETPLACE_NAME)}`,
    );
    expect(again.stdout).toContain(
      `○ ${PT.rcAlreadyLoads(join(homeDir, ".zshrc"))}`,
    );
    expect(again.stdout).toContain(`○ ${PT.statuslineOursKept}`);
    expect(again.stdout).toContain(
      `○ ${PT.envAlreadyProtected(join(stateDir, ".env"), join(configDir, "settings.json"))}`,
    );
    expect(again.stdout).not.toContain(PT.bcctPrompt);
    expect(again.stdout).not.toContain(PT.planPrompt);
  });

  it("asks in the whole setup whether to keep the paired account or pair another one", async () => {
    await runSetup([], answers);
    const greetings = () =>
      telegram.calls.filter(({ method }) => method === "sendMessage").length;
    const greeted = greetings();

    const kept = await runSetup([], "\n".repeat(9));

    expect(kept.stdout).toContain(
      PT.pairingChoiceQuestion(`@dev (id ${DEV_ID})`),
    );
    expect(greetings()).toBe(greeted);

    telegram.code = null;
    const replaced = await runSetup([], `\n\n\nreplace\ns\n${"\n".repeat(6)}`);

    expect(replaced.status).toBe(0);
    expect(replaced.stdout).toContain(
      PT.sendPairingCode(
        "e2e_bot",
        telegram.code,
        `https://t.me/e2e_bot?start=${telegram.code}`,
      ),
    );
    expect(greetings()).toBe(greeted + 1);
    expect(readJson(join(stateDir, "access.json")).allowFrom).toEqual([
      String(DEV_ID),
    ]);
  });

  it("presents the deny of the token file as a security rule", async () => {
    const result = await runSetup([], answers);

    expect(result.stdout).toContain(
      `✔ ${PT.envProtected(join(stateDir, ".env"), join(configDir, "settings.json"))}`,
    );
    expect(
      PT.envProtected("/s/.env", "/c/settings.json").startsWith(
        "Adicionada regra de segurança:",
      ),
    ).toBe(true);
    expect(
      MESSAGES["en-us"]
        .envProtected("/s/.env", "/c/settings.json")
        .startsWith("Security rule added:"),
    ).toBe(true);
  });

  it("running the plugin step again changes nothing", async () => {
    await runSetup([], answers);
    const before = claudeCalls().length;

    const again = await runSetup(["plugin"], "\n");

    expect(again.status).toBe(0);
    expect(claudeCalls().slice(before)).toEqual([
      ["plugin", "marketplace", "list"],
      ["plugin", "list"],
    ]);
    expect(again.stdout).toContain(
      `○ ${PT.pluginAlreadyDisabledOutside(CHANNEL_PLUGIN_ID)}`,
    );
    expect(again.stdout).toContain(
      `○ ${PT.pluginAlreadyEnabled(HOOKS_PLUGIN_ID)}`,
    );
    expect(again.stdout).toContain(
      `○ ${PT.pluginAlreadyEnabled(BCCT_PLUGIN_ID)}`,
    );
    expect(again.stdout).not.toContain(PT.pluginEnabled(HOOKS_PLUGIN_ID));
    expect(again.stdout).toContain(PT.rcAlreadyLoads(join(homeDir, ".zshrc")));
    expect(readFileSync(join(homeDir, ".zshrc"), "utf8")).toBe(
      `${SHELL_MARKER}\n${sourceLine(SHELL_FILE)}\n`,
    );
  });

  it("uninstall undoes the shell line, the status line and the plugins, keeping the state when not confirmed", async () => {
    await runSetup([], answers);
    const before = claudeCalls().length;

    const removed = await runSetup(["--uninstall"], "n\n");

    expect(removed.status).toBe(0);
    expect(readFileSync(join(homeDir, ".zshrc"), "utf8")).toBe("");
    expect(readJson(join(configDir, "settings.json"))).toEqual({});
    expect(claudeCalls().slice(before)).toEqual([
      ["plugin", "list"],
      ["plugin", "marketplace", "list"],
      ["plugin", "uninstall", CHANNEL_PLUGIN_ID, "--scope", "user"],
      ["plugin", "uninstall", HOOKS_PLUGIN_ID, "--scope", "user"],
      ["plugin", "uninstall", BCCT_PLUGIN_ID, "--scope", "user"],
      ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
    ]);
    expect(existsSync(join(stateDir, ".env"))).toBe(true);
    expect(removed.stdout.trimEnd().endsWith(PT.uninstallDone)).toBe(true);
  });
});
