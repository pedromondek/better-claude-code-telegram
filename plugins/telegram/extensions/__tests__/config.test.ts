import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE,
  DEFAULT_INBOX_RETENTION_DAYS,
  DELAY_KINDS,
  defaultAppDir,
  formatDelay,
  isQuietTime,
  kindMinutes,
  readConfig,
  readDelayMinutes,
  readInboxRetentionDays,
  readLocale,
  readQuietHours,
  readTranscriptionSetting,
  readVisuals,
  VISUAL_MODES,
  type DelayKind,
  type Visuals,
} from "../config.ts";

interface DelayCase {
  name: string;
  config: unknown;
  env: string | null;
  expected: Record<DelayKind, number>;
}

const DELAY_CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "delays.json"), "utf8"),
) as DelayCase[];

interface VisualCase {
  name: string;
  config: unknown;
  expected: Visuals;
}

const VISUAL_CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "visuals.json"), "utf8"),
) as VisualCase[];

function at(hours: number, minutes = 0): Date {
  return new Date(2026, 9, 17, hours, minutes);
}

let appDir = "";

function writeConfig(content: unknown): void {
  writeFileSync(join(appDir, CONFIG_FILE), JSON.stringify(content));
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "bcct-config-"));
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

describe("CONFIG_FILE", () => {
  it("is better-cc-telegram.json", (): void => {
    expect(CONFIG_FILE).toBe("better-cc-telegram.json");
  });
});

describe("defaultAppDir", () => {
  it("uses BETTER_CC_TELEGRAM_DIR when set, over CLAUDE_CONFIG_DIR", (): void => {
    expect(
      defaultAppDir({
        BETTER_CC_TELEGRAM_DIR: "/tmp/app-sample",
        CLAUDE_CONFIG_DIR: "/tmp/claude-sample",
      }),
    ).toBe("/tmp/app-sample");
  });

  it("falls back to better-claude-code-telegram under CLAUDE_CONFIG_DIR", (): void => {
    expect(defaultAppDir({ CLAUDE_CONFIG_DIR: "/tmp/claude-sample" })).toBe(
      join("/tmp/claude-sample", "better-claude-code-telegram"),
    );
  });

  it("falls back to better-claude-code-telegram under ~/.claude without any variable", (): void => {
    expect(defaultAppDir({})).toBe(
      join(homedir(), ".claude", "better-claude-code-telegram"),
    );
  });

  it("never follows TELEGRAM_STATE_DIR, the folder that holds the bot token", (): void => {
    expect(defaultAppDir({ TELEGRAM_STATE_DIR: "/tmp/state-sample" })).toBe(
      join(homedir(), ".claude", "better-claude-code-telegram"),
    );
  });

  it("treats empty variables as unset", (): void => {
    expect(
      defaultAppDir({
        BETTER_CC_TELEGRAM_DIR: "",
        CLAUDE_CONFIG_DIR: "/tmp/claude-sample",
      }),
    ).toBe(join("/tmp/claude-sample", "better-claude-code-telegram"));
    expect(
      defaultAppDir({ BETTER_CC_TELEGRAM_DIR: "", CLAUDE_CONFIG_DIR: "" }),
    ).toBe(join(homedir(), ".claude", "better-claude-code-telegram"));
  });
});

describe("readConfig", () => {
  it("returns the parsed object from better-cc-telegram.json", (): void => {
    writeConfig({ delayMinutes: 10, language: "pt-br" });

    expect(readConfig(appDir)).toEqual({
      delayMinutes: 10,
      language: "pt-br",
    });
  });

  it("returns an empty object when the file is missing", (): void => {
    expect(readConfig(appDir)).toEqual({});
  });

  it("returns an empty object when the JSON is invalid", (): void => {
    writeFileSync(join(appDir, CONFIG_FILE), "{not json");

    expect(readConfig(appDir)).toEqual({});
  });

  it("returns an empty object when the JSON is not an object", (): void => {
    const results = ["42", '"text"', "null", "true", "[]", '["x"]'].map(
      (content) => {
        writeFileSync(join(appDir, CONFIG_FILE), content);

        return readConfig(appDir);
      },
    );

    expect(results).toEqual([{}, {}, {}, {}, {}, {}]);
  });
});

describe("readLocale", () => {
  it("returns the language of the config when valid", (): void => {
    writeConfig({ language: "pt-br" });
    expect(readLocale(appDir)).toBe("pt-br");

    writeConfig({ language: "en-us" });
    expect(readLocale(appDir)).toBe("en-us");
  });

  it("falls back to en-us when the language is invalid", (): void => {
    writeConfig({ language: "fr-fr" });
    expect(readLocale(appDir)).toBe("en-us");

    writeConfig({ language: 7 });
    expect(readLocale(appDir)).toBe("en-us");

    writeConfig({ language: "PT-BR" });
    expect(readLocale(appDir)).toBe("en-us");
  });

  it("falls back to en-us when the language or the config is absent", (): void => {
    expect(readLocale(appDir)).toBe("en-us");

    writeConfig({ delayMinutes: 5 });
    expect(readLocale(appDir)).toBe("en-us");
  });
});

describe("readDelayMinutes › per kind, the contract shared with the bcct binary", () => {
  it("names the three kinds the binary and the channel read", (): void => {
    expect(DELAY_KINDS).toEqual(["questions", "permissions", "waiting"]);
  });

  it.each(DELAY_CASES)("$name", ({ config, env, expected }): void => {
    writeConfig(config);

    const environment =
      env === null ? {} : { BETTER_CC_TELEGRAM_DELAY_MS: env };

    expect(
      Object.fromEntries(
        DELAY_KINDS.map((kind) => [
          kind,
          readDelayMinutes(appDir, environment, kind) * 60_000,
        ]),
      ),
    ).toEqual(expected);
  });
});

describe("kindMinutes", () => {
  it("takes only a finite number of minutes, 0 or more, for the kind asked", (): void => {
    const of = (questions: unknown): number | null =>
      kindMinutes({ delays: { questions } }, "questions");

    expect(of(0)).toBe(0);
    expect(of(2.5)).toBe(2.5);
    expect(of(-1)).toBeNull();
    expect(of("5")).toBeNull();
    expect(of(Number.NaN)).toBeNull();
    expect(of(Infinity)).toBeNull();
    expect(of(null)).toBeNull();
  });

  it("returns null without a kind, even with a delay saved under the key undefined", (): void => {
    expect(kindMinutes({ delays: { undefined: 5 } }, undefined)).toBeNull();
    expect(kindMinutes({ delays: [5] }, "questions")).toBeNull();
    expect(kindMinutes({ delays: 5 }, "questions")).toBeNull();
  });
});

describe("readDelayMinutes", () => {
  it("uses 4 min without config", (): void => {
    expect(readDelayMinutes(appDir, {})).toBe(4);
  });

  it("reads delayMinutes from better-cc-telegram.json", (): void => {
    writeConfig({ delayMinutes: 10 });

    expect(readDelayMinutes(appDir, {})).toBe(10);
  });

  it("ignores an invalid config and lets BETTER_CC_TELEGRAM_DELAY_MS win", (): void => {
    writeConfig({ delayMinutes: -2 });

    expect(readDelayMinutes(appDir, {})).toBe(4);
    expect(
      readDelayMinutes(appDir, { BETTER_CC_TELEGRAM_DELAY_MS: "15000" }),
    ).toBe(0.25);
  });

  it("treats an empty or blank BETTER_CC_TELEGRAM_DELAY_MS as unset", (): void => {
    writeConfig({ delayMinutes: 10 });

    expect(readDelayMinutes(appDir, { BETTER_CC_TELEGRAM_DELAY_MS: "" })).toBe(
      10,
    );
    expect(
      readDelayMinutes(appDir, { BETTER_CC_TELEGRAM_DELAY_MS: "  " }),
    ).toBe(10);
    expect(readDelayMinutes(appDir, { BETTER_CC_TELEGRAM_DELAY_MS: "0" })).toBe(
      0,
    );
  });

  it("ignores a negative BETTER_CC_TELEGRAM_DELAY_MS", (): void => {
    writeConfig({ delayMinutes: 10 });

    expect(
      readDelayMinutes(appDir, { BETTER_CC_TELEGRAM_DELAY_MS: "-5000" }),
    ).toBe(10);
  });

  it("sends right away when the config asks for zero minutes", (): void => {
    writeConfig({ delayMinutes: 0 });

    expect(readDelayMinutes(appDir, {})).toBe(0);
  });
});

describe("formatDelay", () => {
  it("shows a minute or more in minutes plus the seconds left, and less than a minute in seconds", (): void => {
    expect(formatDelay(3)).toBe("3 min");
    expect(formatDelay(2.5)).toBe("2 min 30 s");
    expect(formatDelay(1.25)).toBe("1 min 15 s");
    expect(formatDelay(0.25)).toBe("15 s");
    expect(formatDelay(0.99)).toBe("59 s");
    expect(formatDelay(0.999)).toBe("1 min");
  });

  it("shows one minute as min and no delay in seconds", (): void => {
    expect(formatDelay(1)).toBe("1 min");
    expect(formatDelay(0)).toBe("0 s");
  });
});

describe("readQuietHours", () => {
  it("reads the interval from better-cc-telegram.json and rejects an invalid time", (): void => {
    expect(readQuietHours(appDir)).toBeNull();

    writeConfig({ quietHours: { start: "22:00", end: "08:00" } });
    expect(readQuietHours(appDir)).toEqual({
      start: "22:00",
      end: "08:00",
    });

    writeConfig({ quietHours: { start: "25:00", end: "08:00" } });
    expect(readQuietHours(appDir)).toBeNull();

    writeConfig({ quietHours: { start: "22:00", end: "24:00" } });
    expect(readQuietHours(appDir)).toBeNull();
  });

  it("rejects a time that is not a string, even one that reads as a time", (): void => {
    writeConfig({ quietHours: { start: ["22:00"], end: "08:00" } });
    expect(readQuietHours(appDir)).toBeNull();

    writeConfig({ quietHours: { start: "22:00", end: ["08:00"] } });
    expect(readQuietHours(appDir)).toBeNull();
  });
});

describe("readVisuals › the contract shared with the bcct binary", () => {
  it("names the three modes the setup saves", (): void => {
    expect(VISUAL_MODES).toEqual(["off", "prints", "video"]);
  });

  it.each(VISUAL_CASES)("$name", ({ config, expected }): void => {
    writeConfig(config);

    expect(readVisuals(appDir)).toEqual(expected);
  });

  it("keeps the illustrations off and the review on when the config is missing", (): void => {
    expect(readVisuals(join(appDir, "missing"))).toEqual({
      visuals: "off",
      review: true,
    });
  });
});

describe("readTranscriptionSetting", () => {
  it("returns the model of the transcription object and null otherwise", (): void => {
    expect(readTranscriptionSetting(appDir)).toBeNull();

    writeConfig({ transcription: { model: "small" } });
    expect(readTranscriptionSetting(appDir)).toBe("small");

    writeConfig({ transcription: null });
    expect(readTranscriptionSetting(appDir)).toBeNull();
  });
});

describe("readInboxRetentionDays", () => {
  it("keeps received files 7 days by default and follows the setup", (): void => {
    expect(DEFAULT_INBOX_RETENTION_DAYS).toBe(7);
    expect(readInboxRetentionDays(appDir)).toBe(7);

    writeConfig({ inboxRetentionDays: 3 });
    expect(readInboxRetentionDays(appDir)).toBe(3);
  });

  it("keeps them forever when the setup turned the cleanup off", (): void => {
    writeConfig({ inboxRetentionDays: null });

    expect(readInboxRetentionDays(appDir)).toBeNull();
  });

  it("falls back to the default on a value that is not a positive number", (): void => {
    for (const value of [0, -2, "3", true]) {
      writeConfig({ inboxRetentionDays: value });

      expect(readInboxRetentionDays(appDir)).toBe(7);
    }
  });
});

describe("isQuietTime", () => {
  const overnight = { start: "22:00", end: "08:00" };
  const daytime = { start: "12:00", end: "13:30" };

  it("handles an interval that crosses midnight", (): void => {
    expect(isQuietTime(at(22), overnight)).toBe(true);
    expect(isQuietTime(at(23), overnight)).toBe(true);
    expect(isQuietTime(at(3), overnight)).toBe(true);
    expect(isQuietTime(at(8), overnight)).toBe(false);
    expect(isQuietTime(at(21, 59), overnight)).toBe(false);
  });

  it("handles a same-day interval with the end excluded", (): void => {
    expect(isQuietTime(at(11, 59), daytime)).toBe(false);
    expect(isQuietTime(at(12), daytime)).toBe(true);
    expect(isQuietTime(at(13, 29), daytime)).toBe(true);
    expect(isQuietTime(at(13, 30), daytime)).toBe(false);
  });

  it("never silences without an interval or with start equal to end", (): void => {
    expect(isQuietTime(at(3), null)).toBe(false);
    expect(isQuietTime(at(3), { start: "08:00", end: "08:00" })).toBe(false);
  });
});
