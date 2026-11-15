import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MESSAGES, messagesFor } from "../lib/messages.mjs";
import { NPM_PACKAGE, SETUP_COMMAND } from "../lib/package.constants.mjs";
import {
  CONFIG_FILE,
  DEFAULT_DELAY_MINUTES,
  DEFAULT_LOCALE,
  HEALTH_FILE,
  LOCALES,
  defaultAppDir,
  readConfig,
  readJsonFile,
  readLocale,
  telegramStateDir,
} from "../lib/state.mjs";

let workDir;

describe("the npm package", () => {
  it("is the name in the root package.json, and the setup runs it through npx", () => {
    const { name } = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
    );

    expect(NPM_PACKAGE).toBe(name);
    expect(SETUP_COMMAND).toBe(`npx ${name}`);
  });
});

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "object" && entry !== null
      ? flatten(entry, `${prefix}${key}.`)
      : [[`${prefix}${key}`, entry]],
  );
}

function sampleArgs(arity) {
  return Array.from({ length: arity }, (_, index) => `arg${index + 1}`);
}

function writeConfigFile(content) {
  writeFileSync(join(workDir, CONFIG_FILE), content);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-state-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("MESSAGES parity", () => {
  const enEntries = flatten(MESSAGES["en-us"]);
  const ptEntries = flatten(MESSAGES["pt-br"]);

  it("exposes exactly the LOCALES", () => {
    expect(Object.keys(MESSAGES).toSorted()).toEqual([...LOCALES].toSorted());
  });

  it("has the same keys in en-us and pt-br, nested ones such as stepLabels included", () => {
    expect(ptEntries.map(([key]) => key)).toEqual(
      enEntries.map(([key]) => key),
    );
    expect(enEntries.map(([key]) => key)).toContain("stepLabels.token");
    expect(enEntries.map(([key]) => key)).toContain("stepLabels.pairing");
  });

  it("has the same type for every key in en-us and pt-br", () => {
    const typesOf = (entries) =>
      Object.fromEntries(entries.map(([key, value]) => [key, typeof value]));

    expect(typesOf(ptEntries)).toEqual(typesOf(enEntries));
  });

  it("has functions with the same arity in en-us and pt-br", () => {
    const aritiesOf = (entries) =>
      Object.fromEntries(
        entries
          .filter(([, value]) => typeof value === "function")
          .map(([key, value]) => [key, value.length]),
      );

    expect(aritiesOf(ptEntries)).toEqual(aritiesOf(enEntries));
  });

  it.each(LOCALES)("has no empty string or empty result in %s", (locale) => {
    const invalid = flatten(MESSAGES[locale])
      .map(([key, value]) => [
        key,
        typeof value === "function"
          ? value(...sampleArgs(value.length))
          : value,
      ])
      .filter(
        ([, result]) => typeof result !== "string" || result.trim() === "",
      )
      .map(([key]) => key);

    expect(invalid).toEqual([]);
  });

  it.each(LOCALES)(
    "interpolates the arguments of every function in %s",
    (locale) => {
      const ignoring = flatten(MESSAGES[locale])
        .filter(
          ([key, value]) => typeof value === "function" && key !== "yesNoHint",
        )
        .filter(([, value]) => {
          const args = sampleArgs(value.length);
          const result = value(...args);

          return !args.some((arg) => result.includes(arg));
        })
        .map(([key]) => key);

      expect(ignoring).toEqual([]);
    },
  );

  it("renders the yes or no hint with the default spelled out in each locale", () => {
    expect(MESSAGES["en-us"].yesNoHint(true)).toBe("(y/n) [default: y]");
    expect(MESSAGES["en-us"].yesNoHint(false)).toBe("(y/n) [default: n]");
    expect(MESSAGES["pt-br"].yesNoHint(true)).toBe("(s/n) [padrão: s]");
    expect(MESSAGES["pt-br"].yesNoHint(false)).toBe("(s/n) [padrão: n]");
  });

  it("puts the pairing link and the code each on a line of its own, easy to copy", () => {
    expect(
      MESSAGES["pt-br"].sendPairingCode(
        "bot",
        "c0de",
        "https://t.me/bot?start=c0de",
      ),
    ).toBe(
      [
        "Para parear, abra este link e toque em Iniciar:",
        "  • https://t.me/bot?start=c0de",
        "Ou mande este código para @bot:",
        "  • c0de",
        "Aguardando até 3 min. Só a mensagem com esse código pareia.",
      ].join("\n"),
    );
  });

  it("says the token does not show in the terminal while it is typed", () => {
    expect(MESSAGES["pt-br"].tokenPrompt).toBe(
      "Token do bot (do @BotFather; não aparece no terminal): ",
    );
  });
});

describe("messagesFor", () => {
  it("returns the messages of a valid locale", () => {
    expect(messagesFor("pt-br")).toBe(MESSAGES["pt-br"]);
    expect(messagesFor("en-us")).toBe(MESSAGES["en-us"]);
  });

  it("falls back to en-us on an invalid locale", () => {
    expect(messagesFor("fr-fr")).toBe(MESSAGES["en-us"]);
    expect(messagesFor("")).toBe(MESSAGES["en-us"]);
    expect(messagesFor(undefined)).toBe(MESSAGES["en-us"]);
    expect(messagesFor(null)).toBe(MESSAGES["en-us"]);
    expect(messagesFor(42)).toBe(MESSAGES["en-us"]);
  });
});

describe("state constants", () => {
  it("exposes the file names, the default delay and the locales", () => {
    expect(CONFIG_FILE).toBe("better-cc-telegram.json");
    expect(HEALTH_FILE).toBe("health.json");
    expect(DEFAULT_DELAY_MINUTES).toBe(4);
    expect(LOCALES).toEqual(["en-us", "pt-br"]);
    expect(DEFAULT_LOCALE).toBe("en-us");
  });
});

describe("telegramStateDir", () => {
  it("prefers TELEGRAM_STATE_DIR", () => {
    expect(
      telegramStateDir({
        TELEGRAM_STATE_DIR: "/tmp/bcct-explicit",
        CLAUDE_CONFIG_DIR: "/tmp/bcct-config",
      }),
    ).toBe("/tmp/bcct-explicit");
  });

  it("falls back to CLAUDE_CONFIG_DIR/channels/telegram", () => {
    expect(telegramStateDir({ CLAUDE_CONFIG_DIR: "/tmp/bcct-config" })).toBe(
      join("/tmp/bcct-config", "channels", "telegram"),
    );
  });

  it("treats an empty TELEGRAM_STATE_DIR as absent", () => {
    expect(
      telegramStateDir({
        TELEGRAM_STATE_DIR: "",
        CLAUDE_CONFIG_DIR: "/tmp/bcct-config",
      }),
    ).toBe(join("/tmp/bcct-config", "channels", "telegram"));
  });

  it("treats an empty CLAUDE_CONFIG_DIR as absent and uses the home .claude", () => {
    const dir = telegramStateDir({ CLAUDE_CONFIG_DIR: "" });

    expect(dir.endsWith(join(".claude", "channels", "telegram"))).toBe(true);
  });
});

describe("defaultAppDir", () => {
  it("prefers BETTER_CC_TELEGRAM_DIR", () => {
    expect(
      defaultAppDir({
        BETTER_CC_TELEGRAM_DIR: "/tmp/bcct-app",
        CLAUDE_CONFIG_DIR: "/tmp/bcct-config",
      }),
    ).toBe("/tmp/bcct-app");
  });

  it("falls back to CLAUDE_CONFIG_DIR/better-claude-code-telegram, never to TELEGRAM_STATE_DIR", () => {
    expect(
      defaultAppDir({
        TELEGRAM_STATE_DIR: "/tmp/bcct-channel",
        CLAUDE_CONFIG_DIR: "/tmp/bcct-config",
      }),
    ).toBe(join("/tmp/bcct-config", "better-claude-code-telegram"));
  });

  it("treats empty variables as absent and uses the home .claude", () => {
    const dir = defaultAppDir({
      BETTER_CC_TELEGRAM_DIR: "",
      CLAUDE_CONFIG_DIR: "",
    });

    expect(dir.endsWith(join(".claude", "better-claude-code-telegram"))).toBe(
      true,
    );
  });
});

describe("readJsonFile", () => {
  it("returns the parsed content of a valid file", () => {
    writeConfigFile('{"a":1}');

    expect(readJsonFile(join(workDir, CONFIG_FILE))).toEqual({ a: 1 });
  });

  it("returns null for a missing file and for invalid JSON", () => {
    expect(readJsonFile(join(workDir, "missing.json"))).toBeNull();

    writeConfigFile("{not json");

    expect(readJsonFile(join(workDir, CONFIG_FILE))).toBeNull();
  });
});

describe("readConfig", () => {
  it("returns the config object", () => {
    writeConfigFile('{"language":"pt-br","delayMinutes":5}');

    expect(readConfig(workDir)).toEqual({ language: "pt-br", delayMinutes: 5 });
  });

  it("returns an empty object without the file", () => {
    expect(readConfig(workDir)).toEqual({});
  });

  it("returns an empty object for invalid JSON", () => {
    writeConfigFile("{not json");

    expect(readConfig(workDir)).toEqual({});
  });

  it("returns an empty object when the JSON is not an object", () => {
    for (const content of ["null", "0", '""', "false", "[]", '["x"]']) {
      writeConfigFile(content);

      expect(readConfig(workDir)).toEqual({});
    }
  });
});

describe("readLocale", () => {
  it("returns the language of the config when it is a known locale", () => {
    writeConfigFile('{"language":"pt-br"}');

    expect(readLocale(workDir)).toBe("pt-br");
  });

  it("returns en-us without config, with an unknown language or a non-string one", () => {
    expect(readLocale(workDir)).toBe("en-us");

    writeConfigFile('{"language":"fr-fr"}');

    expect(readLocale(workDir)).toBe("en-us");

    writeConfigFile('{"language":5}');

    expect(readLocale(workDir)).toBe("en-us");
  });

  it("returns en-us for invalid JSON", () => {
    writeConfigFile("{not json");

    expect(readLocale(workDir)).toBe("en-us");
  });
});
