import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PREVIOUS_STATUSLINE_FILE } from "../lib/state.mjs";
import {
  TELEGRAM_HEALTH_TTL_MS,
  TELEGRAM_LAUNCH_GRACE_MS,
  telegramSegment,
} from "../statusline.mjs";

const STATUSLINE = join(import.meta.dirname, "..", "statusline.mjs");
const NOW = 1_000_000_000;
const GREEN = "\u001B[32m";
const RED = "\u001B[31m";
const YELLOW = "\u001B[33m";
const RESET = "\u001B[0m";

let appDir;
let homeDir;

function writeConfig(config) {
  writeFileSync(
    join(appDir, "better-cc-telegram.json"),
    JSON.stringify(config),
  );
}

function writeHealth(health) {
  writeFileSync(join(appDir, "health.json"), JSON.stringify(health));
}

function writeLaunch(launchedAt) {
  writeFileSync(join(appDir, "launch.json"), JSON.stringify({ launchedAt }));
}

function envFor({ main, language }) {
  if (language) writeConfig({ language });

  return {
    BETTER_CC_TELEGRAM_DIR: appDir,
    BETTER_CC_TELEGRAM: main ? "1" : "",
  };
}

function plainSegment({ main, language, now = NOW }) {
  const segment = telegramSegment(envFor({ main, language }), now);

  return segment === null ? null : stripVTControlCharacters(segment);
}

function runScript({ main, language }) {
  if (language) writeConfig({ language });

  const result = spawnSync(process.execPath, [STATUSLINE], {
    input: "{}",
    env: {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
      BETTER_CC_TELEGRAM_DIR: appDir,
      BETTER_CC_TELEGRAM: main ? "1" : "",
    },
    encoding: "utf8",
  });

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  return stripVTControlCharacters(result.stdout);
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "bcct-state-"));
  homeDir = mkdtempSync(join(tmpdir(), "bcct-home-"));
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("telegramSegment in pt-br", () => {
  const language = "pt-br";

  it("returns null for the secondary and Telegram fora for the main without health.json", () => {
    expect(plainSegment({ main: false, language })).toBeNull();
    expect(plainSegment({ main: true, language })).toBe(
      "📱 (Principal) Telegram fora",
    );
  });

  it("shows conectado on both when the bot polls and the health is fresh", () => {
    writeHealth({ polling: true, checkedAt: NOW });

    expect(plainSegment({ main: false, language })).toBe(
      "📱 (Secundário) Telegram conectado",
    );
    expect(plainSegment({ main: true, language })).toBe(
      "📱 (Principal) Telegram conectado",
    );
  });

  it("shows fora on both when the health is fresh and the bot is not polling", () => {
    writeHealth({ polling: false, checkedAt: NOW });

    expect(plainSegment({ main: false, language })).toBe(
      "📱 (Secundário) Telegram fora",
    );
    expect(plainSegment({ main: true, language })).toBe(
      "📱 (Principal) Telegram fora",
    );
  });
});

describe("telegramSegment in en-us", () => {
  const language = "en-us";

  it("returns null for the secondary and down for the main without health.json", () => {
    expect(plainSegment({ main: false, language })).toBeNull();
    expect(plainSegment({ main: true, language })).toBe(
      "📱 (Main) Telegram down",
    );
  });

  it("shows connected on both when the bot polls and the health is fresh", () => {
    writeHealth({ polling: true, checkedAt: NOW });

    expect(plainSegment({ main: false, language })).toBe(
      "📱 (Secondary) Telegram connected",
    );
    expect(plainSegment({ main: true, language })).toBe(
      "📱 (Main) Telegram connected",
    );
  });

  it("shows down on both when the health is fresh and the bot is not polling", () => {
    writeHealth({ polling: false, checkedAt: NOW });

    expect(plainSegment({ main: false, language })).toBe(
      "📱 (Secondary) Telegram down",
    );
    expect(plainSegment({ main: true, language })).toBe(
      "📱 (Main) Telegram down",
    );
  });

  it("is the language used without any config", () => {
    writeHealth({ polling: true, checkedAt: NOW });

    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram connected");
  });

  it("is the language used when the config language is unknown", () => {
    writeHealth({ polling: true, checkedAt: NOW });

    expect(plainSegment({ main: true, language: "fr-fr" })).toBe(
      "📱 (Main) Telegram connected",
    );
  });
});

describe("telegramSegment health states", () => {
  it("exposes a TELEGRAM_HEALTH_TTL_MS of 15 seconds", () => {
    expect(TELEGRAM_HEALTH_TTL_MS).toBe(15_000);
  });

  it("returns null for the secondary and down for the main when the health is stale", () => {
    writeHealth({ polling: true, checkedAt: NOW - TELEGRAM_HEALTH_TTL_MS - 1 });

    expect(plainSegment({ main: false })).toBeNull();
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("treats a health exactly at the TTL as stale", () => {
    writeHealth({ polling: true, checkedAt: NOW - TELEGRAM_HEALTH_TTL_MS });

    expect(plainSegment({ main: false })).toBeNull();
  });

  it("treats a health one millisecond inside the TTL as fresh", () => {
    writeHealth({
      polling: true,
      checkedAt: NOW - TELEGRAM_HEALTH_TTL_MS + 1,
    });

    expect(plainSegment({ main: false })).toBe(
      "📱 (Secondary) Telegram connected",
    );
  });

  it("returns null for the secondary and down for the main when health.json is absent", () => {
    expect(plainSegment({ main: false })).toBeNull();
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("treats an invalid health.json as absent", () => {
    writeFileSync(join(appDir, "health.json"), "{not json");

    expect(plainSegment({ main: false })).toBeNull();
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("treats a non-object health.json as absent", () => {
    writeFileSync(join(appDir, "health.json"), "42");

    expect(plainSegment({ main: false })).toBeNull();
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("treats a health without checkedAt as stale", () => {
    writeHealth({ polling: true });

    expect(plainSegment({ main: false })).toBeNull();
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("shows down on both when polling is false even with a fresh health", () => {
    writeHealth({ polling: false, checkedAt: NOW });

    expect(plainSegment({ main: false })).toBe("📱 (Secondary) Telegram down");
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("exposes a TELEGRAM_LAUNCH_GRACE_MS of 60 seconds", () => {
    expect(TELEGRAM_LAUNCH_GRACE_MS).toBe(60_000);
  });

  it("shows connecting on the main while 'claude --telegram' was just opened and nothing answers yet", () => {
    writeLaunch(NOW - 1000);

    expect(plainSegment({ main: false })).toBeNull();
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram connecting…");
    expect(plainSegment({ main: true, language: "pt-br" })).toBe(
      "📱 (Principal) Telegram conectando…",
    );
  });

  it("shows connecting on both while the server is up and the bot is not polling yet, right after the launch", () => {
    writeLaunch(NOW - 1000);
    writeHealth({ polling: false, checkedAt: NOW });

    expect(plainSegment({ main: false })).toBe(
      "📱 (Secondary) Telegram connecting…",
    );
    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram connecting…");
  });

  it("goes back to down once the launch is older than the grace, so a real outage still shows", () => {
    writeLaunch(NOW - TELEGRAM_LAUNCH_GRACE_MS);
    writeHealth({ polling: false, checkedAt: NOW });

    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");

    writeLaunch(NOW - TELEGRAM_LAUNCH_GRACE_MS + 1);

    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram connecting…");
  });

  it("shows connected as soon as the bot polls, even right after the launch", () => {
    writeLaunch(NOW - 1000);
    writeHealth({ polling: true, checkedAt: NOW });

    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram connected");
  });

  it("ignores a launch file without a valid time", () => {
    writeFileSync(join(appDir, "launch.json"), "{not json");

    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");

    writeFileSync(join(appDir, "launch.json"), JSON.stringify({}));

    expect(plainSegment({ main: true })).toBe("📱 (Main) Telegram down");
  });

  it("wraps connecting in yellow", () => {
    writeLaunch(NOW - 1000);

    expect(telegramSegment(envFor({ main: true }), NOW)).toBe(
      `${YELLOW}📱 (Main) Telegram connecting…${RESET}`,
    );
  });

  it("wraps connected in green and down in red, closing with the reset code", () => {
    writeHealth({ polling: true, checkedAt: NOW });

    expect(telegramSegment(envFor({ main: true }), NOW)).toBe(
      `${GREEN}📱 (Main) Telegram connected${RESET}`,
    );

    writeHealth({ polling: false, checkedAt: NOW });

    expect(telegramSegment(envFor({ main: true }), NOW)).toBe(
      `${RED}📱 (Main) Telegram down${RESET}`,
    );
  });

  it("reads the health from better-claude-code-telegram under CLAUDE_CONFIG_DIR when BETTER_CC_TELEGRAM_DIR is empty", () => {
    const configDir = join(homeDir, ".claude");
    const defaultDir = join(configDir, "better-claude-code-telegram");

    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, "health.json"),
      JSON.stringify({ polling: true, checkedAt: NOW }),
    );

    expect(
      stripVTControlCharacters(
        telegramSegment(
          { BETTER_CC_TELEGRAM_DIR: "", CLAUDE_CONFIG_DIR: configDir },
          NOW,
        ),
      ),
    ).toBe("📱 (Secondary) Telegram connected");
  });
});

describe("statusline.mjs --after-previous", () => {
  function runAfterPrevious(previous, input = '{"model":"x"}') {
    if (previous) {
      writeFileSync(
        join(appDir, PREVIOUS_STATUSLINE_FILE),
        JSON.stringify(previous),
      );
    }

    const result = spawnSync(
      process.execPath,
      [STATUSLINE, "--after-previous"],
      {
        input,
        env: {
          ...process.env,
          HOME: homeDir,
          BETTER_CC_TELEGRAM_DIR: appDir,
          BETTER_CC_TELEGRAM: "1",
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);

    return stripVTControlCharacters(result.stdout);
  }

  it("runs the previous status line with the same input and adds ours at the end of its last line", () => {
    expect(
      runAfterPrevious({ type: "command", command: "cat; printf ' | mine'" }),
    ).toBe('{"model":"x"} | mine │ 📱 (Main) Telegram down');
  });

  it("keeps every row of the previous status line and adds ours to the last one", () => {
    expect(
      runAfterPrevious({ type: "command", command: "printf 'one\\ntwo\\n'" }),
    ).toBe("one\ntwo │ 📱 (Main) Telegram down");
  });

  it("shows only ours when the previous status line is gone or prints nothing", () => {
    expect(runAfterPrevious(null)).toBe("📱 (Main) Telegram down");
    expect(runAfterPrevious({ type: "command", command: "exit 3" })).toBe(
      "📱 (Main) Telegram down",
    );
  });
});

describe("statusline.mjs as a process", () => {
  it("prints the segment for the main instance without health.json", () => {
    expect(runScript({ main: true, language: "en-us" })).toBe(
      "📱 (Main) Telegram down",
    );
  });

  it("prints nothing for the secondary instance without health.json", () => {
    expect(runScript({ main: false })).toBe("");
  });

  it("prints the connected segment in pt-br with a fresh health", () => {
    writeHealth({ polling: true, checkedAt: Date.now() });

    expect(runScript({ main: false, language: "pt-br" })).toBe(
      "📱 (Secundário) Telegram conectado",
    );
  });

  it("prints nothing for the secondary instance with a stale health", () => {
    writeHealth({ polling: true, checkedAt: Date.now() - 60_000 });

    expect(runScript({ main: false })).toBe("");
  });
});
