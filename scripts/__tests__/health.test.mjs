import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MESSAGES } from "../../plugins/telegram-hooks/lib/messages.mjs";
import {
  HEALTH_GROUPS,
  formatHealth,
  parseHealthGroups,
  printingProgress,
  runHealth,
} from "../health.mjs";
import { TELEGRAM_LAUNCH_GRACE_MS } from "../../plugins/telegram-hooks/statusline.mjs";
import { section } from "../ui.mjs";
import {
  BCCT_PLUGIN_ID,
  CHANNEL_PLUGIN_ID,
  HOOKS_PLUGIN_ID,
  SHELL_MARKER,
  envDenyRule,
  sourceLine,
  statuslineCommand,
} from "../setup.mjs";

const HEALTH = join(import.meta.dirname, "..", "health.mjs");
const EN = MESSAGES["en-us"];
const NOW = 1_000_000;

let workDir;
let stateDir;
let appDir;
let homeDir;
let settingsFile;

function healthyDeps(overrides = {}) {
  return {
    stateDir,
    appDir,
    home: homeDir,
    shell: "/bin/bash",
    settingsFile,
    shellFile: "/repo/shell.sh",
    nodeVersion: "24.20.0",
    hasCommand: () => true,
    claudeOutput: () =>
      `${CHANNEL_PLUGIN_ID}\n${HOOKS_PLUGIN_ID}\n${BCCT_PLUGIN_ID}\n`,
    callTelegram: async () => ({
      username: "e2e_bot",
      can_join_groups: false,
    }),
    pythonWorks: () => true,
    describeAccounts: async () => "@dev (id 42)",
    uid: 1000,
    now: NOW,
    ...overrides,
  };
}

function writeAccess(access) {
  writeFileSync(
    join(stateDir, "access.json"),
    JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: ["42"],
      groups: {},
      pending: {},
      ...access,
    }),
  );
}

function writeHealthyMachine() {
  writeFileSync(join(stateDir, ".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n");
  writeAccess({});
  writeFileSync(
    join(homeDir, ".bashrc"),
    `${SHELL_MARKER}\n${sourceLine("/repo/shell.sh")}\n`,
  );
  writeFileSync(
    settingsFile,
    JSON.stringify({
      statusLine: { type: "command", command: statuslineCommand() },
      permissions: { deny: [envDenyRule(join(stateDir, ".env"), homeDir)] },
    }),
  );
  writeFileSync(
    join(appDir, "better-cc-telegram.json"),
    JSON.stringify({ language: "en-us", transcription: { model: "small" } }),
  );
  writeFileSync(
    join(appDir, "health.json"),
    JSON.stringify({ polling: true, checkedAt: NOW - 1000 }),
  );
}

function byCheck(results) {
  return Object.fromEntries(results.map((result) => [result.check, result]));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-health-"));
  stateDir = join(workDir, "state");
  appDir = join(workDir, "app");
  homeDir = join(workDir, "home");
  settingsFile = join(workDir, "settings.json");
  for (const dir of [stateDir, appDir, homeDir]) mkdirSync(dir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("parseHealthGroups", () => {
  it("runs every group for all, tudo or nothing, and only the named ones otherwise", () => {
    expect(parseHealthGroups([], EN)).toEqual(HEALTH_GROUPS);
    expect(parseHealthGroups(["all"], EN)).toEqual(HEALTH_GROUPS);
    expect(parseHealthGroups(["tudo"], EN)).toEqual(HEALTH_GROUPS);
    expect(parseHealthGroups(["security", "install"], EN)).toEqual([
      "install",
      "security",
    ]);
  });

  it("refuses an unknown group and lists the valid ones", () => {
    expect(() => parseHealthGroups(["speed"], EN)).toThrow(
      EN.unknownHealthGroups("speed", HEALTH_GROUPS.join(", ")),
    );
  });
});

describe("runHealth", () => {
  it("passes every check on a healthy machine, without ever showing the token", async () => {
    writeHealthyMachine();

    const results = await runHealth(HEALTH_GROUPS, EN, healthyDeps());

    expect(results.filter((result) => result.status !== "ok")).toEqual([]);
    expect(Object.keys(byCheck(results))).toEqual([
      "node",
      "claude",
      "bun",
      "plugins",
      "shell",
      "token",
      "groups",
      "pairing",
      "polling",
      "user",
      "protection",
      "config",
      "transcription",
      "mermaid",
      "statusline",
    ]);
    expect(byCheck(results).token.detail).toBe(EN.healthDetail.bot("e2e_bot"));
    expect(JSON.stringify(results)).not.toContain("FAKE");
  });

  it("runs only the checks of the groups asked", async () => {
    writeHealthyMachine();

    const results = await runHealth(["security"], EN, healthyDeps());

    expect(results.map((result) => result.check)).toEqual([
      "user",
      "protection",
      "config",
    ]);
  });

  it("does not fail without the /bcct: commands, which are optional", async () => {
    const results = byCheck(
      await runHealth(
        ["install"],
        EN,
        healthyDeps({
          claudeOutput: () => `${CHANNEL_PLUGIN_ID}\n${HOOKS_PLUGIN_ID}\n`,
        }),
      ),
    );

    expect(results.plugins.status).toBe("ok");
  });

  it("fails what is missing and explains how to fix it", async () => {
    writeFileSync(
      join(stateDir, "access.json"),
      JSON.stringify({ allowFrom: ["42", "13"] }),
    );
    writeFileSync(settingsFile, "{ broken");

    const results = byCheck(
      await runHealth(
        HEALTH_GROUPS,
        EN,
        healthyDeps({
          nodeVersion: "22.0.0",
          hasCommand: (tool) => tool !== "bun",
          claudeOutput: () => `${CHANNEL_PLUGIN_ID}\n`,
        }),
      ),
    );

    expect(results.node).toMatchObject({
      status: "fail",
      detail: EN.nodeTooOld("22.0.0", "24.11"),
    });
    expect(results.bun.status).toBe("fail");
    expect(results.plugins).toMatchObject({
      status: "fail",
      detail: EN.healthDetail.notInstalled(HOOKS_PLUGIN_ID),
    });
    expect(results.shell.status).toBe("fail");
    expect(results.token).toMatchObject({
      status: "fail",
      detail: EN.healthDetail.noToken,
    });
    expect(results.pairing).toMatchObject({
      status: "fail",
      detail: EN.tooManyAccounts(2, "npm run setup:pairing"),
    });
    expect(results.protection.status).toBe("fail");
    expect(results.config).toMatchObject({
      status: "fail",
      detail: EN.settingsInvalid(settingsFile),
    });
  });

  it("fails the pairing unless only one account is allowed, strangers are dropped and nothing is pending", async () => {
    writeHealthyMachine();

    const cases = [
      [{ dmPolicy: "pairing" }, EN.healthDetail.notAllowlist("pairing")],
      [
        { pending: { abc123: { senderId: "13" } } },
        EN.healthDetail.pendingPairings(1),
      ],
      [
        { groups: { "-100": { requireMention: true } } },
        EN.healthDetail.groupsAllowed(1),
      ],
    ];

    for (const [access, detail] of cases) {
      writeAccess(access);

      expect(
        byCheck(await runHealth(["telegram"], EN, healthyDeps())).pairing,
      ).toMatchObject({ status: "fail", detail });
    }
  });

  it("fails when the bot can be added to groups, and says how to turn it off", async () => {
    writeHealthyMachine();

    const results = byCheck(
      await runHealth(
        ["telegram"],
        EN,
        healthyDeps({
          callTelegram: async () => ({
            username: "e2e_bot",
            can_join_groups: true,
          }),
        }),
      ),
    );

    expect(results.groups).toMatchObject({
      status: "fail",
      detail: EN.groupsWarning("e2e_bot"),
    });
  });

  it("fails when running as root", async () => {
    writeHealthyMachine();

    const results = byCheck(
      await runHealth(["security"], EN, healthyDeps({ uid: 0 })),
    );

    expect(results.user).toMatchObject({
      status: "fail",
      detail: EN.healthDetail.root,
    });
  });

  it("fails the token when Telegram refuses it, without the token in the detail", async () => {
    writeHealthyMachine();

    const results = byCheck(
      await runHealth(
        ["telegram"],
        EN,
        healthyDeps({
          callTelegram: async () => {
            throw new Error(EN.telegramRefused("getMe", "Unauthorized"));
          },
        }),
      ),
    );

    expect(results.token).toMatchObject({
      status: "fail",
      detail: EN.telegramRefused("getMe", "Unauthorized"),
    });
  });

  it("marks optional things that are off as off, not as failures", async () => {
    writeHealthyMachine();
    writeFileSync(join(appDir, "better-cc-telegram.json"), "{}");
    writeFileSync(settingsFile, "{}");
    rmSync(join(appDir, "health.json"));

    const results = byCheck(
      await runHealth(
        HEALTH_GROUPS,
        EN,
        healthyDeps({ hasCommand: (tool) => tool !== "mmdc" }),
      ),
    );

    expect(results.polling).toMatchObject({
      status: "off",
      detail: EN.healthDetail.notOpen,
    });
    expect(results.transcription.status).toBe("off");
    expect(results.mermaid.status).toBe("off");
    expect(results.statusline.status).toBe("off");
  });

  it("says the connection is coming up right after 'claude --telegram' opens, without failing, and down once the grace is over", async () => {
    writeHealthyMachine();
    writeFileSync(
      join(appDir, "health.json"),
      JSON.stringify({ polling: false, checkedAt: NOW - 1000 }),
    );
    writeFileSync(
      join(appDir, "launch.json"),
      JSON.stringify({ launchedAt: NOW - 1000 }),
    );

    const starting = byCheck(await runHealth(["telegram"], EN, healthyDeps()));

    expect(starting.polling).toMatchObject({
      status: "off",
      detail: EN.healthDetail.connecting,
    });

    rmSync(join(appDir, "health.json"));

    const notUpYet = byCheck(await runHealth(["telegram"], EN, healthyDeps()));

    expect(notUpYet.polling).toMatchObject({
      status: "off",
      detail: EN.healthDetail.connecting,
    });

    writeFileSync(
      join(appDir, "health.json"),
      JSON.stringify({ polling: false, checkedAt: NOW - 1000 }),
    );
    writeFileSync(
      join(appDir, "launch.json"),
      JSON.stringify({ launchedAt: NOW - TELEGRAM_LAUNCH_GRACE_MS }),
    );

    const later = byCheck(await runHealth(["telegram"], EN, healthyDeps()));

    expect(later.polling).toMatchObject({
      status: "fail",
      detail: EN.healthDetail.down,
    });
    expect(MESSAGES["pt-br"].healthDetail.connecting).toBe(
      "conectando; o 'claude --telegram' acabou de abrir",
    );
  });

  it("counts the status line Claude customized with the indicator as on, and a pending request as off", async () => {
    writeHealthyMachine();
    writeFileSync(
      settingsFile,
      JSON.stringify({ statusLine: { type: "command", command: "mine" } }),
    );
    writeFileSync(
      join(appDir, "better-cc-telegram.json"),
      JSON.stringify({ statuslineCustomized: true }),
    );

    const customized = byCheck(await runHealth(["extras"], EN, healthyDeps()));

    expect(customized.statusline).toMatchObject({
      status: "ok",
      detail: EN.healthDetail.statusline.custom,
    });

    writeFileSync(join(appDir, "better-cc-telegram.json"), "{}");
    writeFileSync(join(appDir, "statusline-customize.json"), "{}");

    const pending = byCheck(await runHealth(["extras"], EN, healthyDeps()));

    expect(pending.statusline).toMatchObject({
      status: "off",
      detail: EN.healthDetail.statusline["custom-pending"],
    });
  });

  it("fails a transcription that is on but whose Python environment is broken", async () => {
    writeHealthyMachine();

    const results = byCheck(
      await runHealth(
        ["extras"],
        EN,
        healthyDeps({ pythonWorks: () => false }),
      ),
    );

    expect(results.transcription).toMatchObject({
      status: "fail",
      detail: EN.healthDetail.broken("npm run setup:transcription"),
    });
  });
});

describe("health security and pairing details", () => {
  it("checks running as root in the security group, with a clear label", async () => {
    const results = await runHealth(HEALTH_GROUPS, EN, healthyDeps());
    const user = results.find(({ check }) => check === "user");

    expect(user).toMatchObject({
      group: "security",
      status: "ok",
      detail: EN.healthDetail.regularUser,
    });
    expect(MESSAGES["pt-br"].healthLabels.user).toBe("Execução como root");
    expect(MESSAGES["pt-br"].healthDetail.regularUser).toBe(
      "não, roda como usuário comum (o recomendado)",
    );
  });

  it("names the paired account", async () => {
    writeHealthyMachine();

    const results = await runHealth(["telegram"], EN, healthyDeps());

    expect(results.find(({ check }) => check === "pairing")).toMatchObject({
      status: "ok",
      detail: EN.healthDetail.paired("@dev (id 42)"),
    });
    expect(MESSAGES["pt-br"].healthDetail.paired("@dev (id 42)")).toBe(
      "pareado com uma conta (@dev (id 42))",
    );
  });

  it("prints the title of each group in its own color, apart from what is off", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);
    const written = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk));
        done();
      },
    });

    printingProgress(EN, output).onGroup("install");

    expect(written).toEqual([`${section(EN.healthGroupTitles.install)}\n`]);
    expect(section("Install")).toBe(
      "\u001B[34m\u001B[1mInstall\u001B[22m\u001B[39m",
    );
  });
});

describe("health labels and progress", () => {
  it("has a label for every check in both languages", async () => {
    const results = await runHealth(HEALTH_GROUPS, EN, healthyDeps());

    for (const locale of ["en-us", "pt-br"]) {
      expect(
        results
          .map(({ check }) => check)
          .filter((check) => !MESSAGES[locale].healthLabels[check]),
      ).toEqual([]);
    }
    expect(formatHealth(results, MESSAGES["pt-br"])).not.toContain("undefined");
  });

  it("reports each group as it starts and each check as soon as its group is done", async () => {
    const events = [];

    const results = await runHealth(["install", "telegram"], EN, {
      ...healthyDeps(),
      onGroup: (group) => events.push(`group:${group}`),
      onResult: ({ check }) => events.push(check),
    });

    expect(events[0]).toBe("group:install");
    expect(events.indexOf("group:telegram")).toBeGreaterThan(
      events.indexOf("shell"),
    );
    expect(events.indexOf("token")).toBeGreaterThan(
      events.indexOf("group:telegram"),
    );
    expect(events.filter((event) => !event.startsWith("group:"))).toEqual(
      results.map(({ check }) => check),
    );
    expect(MESSAGES["pt-br"].healthGroupTitles).toEqual({
      install: "Instalação",
      telegram: "Telegram",
      security: "Segurança",
      extras: "Extras",
    });
  });

  it("runs one check at a time, telling when each starts and when it is done", async () => {
    const events = [];
    let telegramCalls = 0;
    writeHealthyMachine();

    await runHealth(["install", "telegram"], EN, {
      ...healthyDeps({
        claudeOutput: () => {
          events.push("claude plugin list");
          return `${CHANNEL_PLUGIN_ID}\n${HOOKS_PLUGIN_ID}\n`;
        },
        callTelegram: async () => {
          telegramCalls += 1;
          events.push("getMe");
          return { username: "e2e_bot", can_join_groups: false };
        },
      }),
      onStart: ({ check }) => events.push(`start:${check}`),
      onResult: ({ check }) => events.push(`done:${check}`),
    });

    expect(events.slice(0, 7)).toEqual([
      "start:node",
      "done:node",
      "start:claude",
      "done:claude",
      "start:bun",
      "done:bun",
      "start:plugins",
    ]);
    expect(events.indexOf("claude plugin list")).toBe(7);
    expect(events.indexOf("getMe")).toBeGreaterThan(
      events.indexOf("start:token"),
    );
    expect(events.indexOf("getMe")).toBeLessThan(events.indexOf("done:token"));
    expect(telegramCalls).toBe(1);
  });

  it("prints each check in place of the line that said it was running", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const written = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        written.push(String(chunk));
        done();
      },
    });

    output.isTTY = true;
    output.columns = 80;
    output.getColorDepth = () => 1;
    writeHealthyMachine();

    await runHealth(["install"], EN, {
      ...healthyDeps(),
      ...printingProgress(EN, output),
    });

    expect(written.join("")).toContain(
      `⠋ ${EN.healthLabels.node}…\r\u001B[2K✔ ${EN.healthLabels.node}: ${EN.healthDetail.version("24.20.0")}\n`,
    );
  });
});

describe("formatHealth", () => {
  const results = [
    { check: "node", status: "ok", detail: "24.20.0" },
    { check: "plugins", status: "fail", detail: "missing" },
    { check: "mermaid", status: "off", detail: "not installed" },
  ];

  it("marks each check by its status so the list reads well in a pipe", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);

    expect(formatHealth(results, EN)).toBe(
      [
        `✔ ${EN.healthLabels.node}: 24.20.0`,
        `✘ ${EN.healthLabels.plugins}: missing`,
        `○ ${EN.healthLabels.mermaid}: not installed`,
      ].join("\n"),
    );
  });

  it("paints ok green, a failure red and what is off dimmed", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);

    expect(formatHealth(results, EN).split("\n")).toEqual([
      `\u001B[32m✔ ${EN.healthLabels.node}: 24.20.0\u001B[39m`,
      `\u001B[31m✘ ${EN.healthLabels.plugins}: missing\u001B[39m`,
      `\u001B[2m○ ${EN.healthLabels.mermaid}: not installed\u001B[22m`,
    ]);
  });
});

describe("health.mjs as a process", () => {
  it("prints JSON with --json and exits 1 when a check fails", () => {
    const result = spawnSync(process.execPath, [HEALTH, "--json", "security"], {
      env: {
        PATH: process.env.PATH,
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
        TELEGRAM_STATE_DIR: stateDir,
        BETTER_CC_TELEGRAM_DIR: appDir,
        LANG: "C",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(
      JSON.parse(result.stdout).map(({ check, status }) => [check, status]),
    ).toEqual([
      ["user", "ok"],
      ["protection", "fail"],
      ["config", "ok"],
    ]);
  });
});
