import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { extensionInstructions } from "../instructions.ts";
import { mermaidCommand } from "../mermaid-png.ts";

const RULE_OPENINGS = [
  "better-claude-code-telegram rules for this Telegram channel",
  "Who you talk to:",
  "Language:",
  "When Telegram is used:",
  "Both ways:",
  "Formatting on Telegram:",
  "Sending on Telegram:",
  "Telegram does not show the terminal conversation.",
  "AskUserQuestion mirror:",
  "Flows and drawings:",
  "Other Claude Code instances on this machine:",
  "This bot exists only to talk to the user.",
  "Never send a secret on Telegram:",
];

let appDir = "";

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(appDir, CONFIG_FILE), JSON.stringify(config));
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "bcct-instructions-"));
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

describe("extensionInstructions › folder", () => {
  it("reads the config from the default app folder when called without one, as the channel server does", (): void => {
    vi.stubEnv("BETTER_CC_TELEGRAM_DIR", appDir);
    writeConfig({ delayMinutes: 7 });

    expect(extensionInstructions()).toContain("more than 7 min");
  });
});

describe("extensionInstructions › layout", () => {
  it("gives each rule its own paragraph, in this order, separated by one blank line", (): void => {
    const paragraphs = extensionInstructions(appDir).split("\n\n");

    expect(paragraphs.some((paragraph) => paragraph.includes("\n"))).toBe(
      false,
    );
    expect(
      paragraphs.map((paragraph) =>
        RULE_OPENINGS.find((opening) => paragraph.startsWith(opening)),
      ),
    ).toEqual(RULE_OPENINGS);
  });
});

describe("extensionInstructions › channel rules", () => {
  it("limits the rules to the instance started with claude --telegram", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "They apply only to this instance, the one started with 'claude --telegram'.",
    );
  });

  it("treats a Telegram message like one typed in the terminal and answers it through reply", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "a message from Telegram counts exactly like a message typed in the terminal. Answer it through the reply tool",
    );
  });

  it("asks for short lines and tables as aligned columns in a markdownv2 code block", (): void => {
    const text = extensionInstructions(appDir);

    expect(text).toContain("never a wall of text. One idea per line");
    expect(text).toContain("Telegram does not render markdown tables");
    expect(text).toContain('with format: "markdownv2" in reply');
    expect(text).toContain("only ` and \\ inside them.");
  });

  it("asks for the context of an AskUserQuestion in the same message, since Telegram does not show the terminal", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "Before calling AskUserQuestion, write in the same message the context needed to answer it",
    );
  });

  it("keeps the bot only for talking to the user", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "Never use it to test another Telegram integration, and never use another Telegram bot to talk to the user.",
    );
  });
});

describe("extensionInstructions › current rules", () => {
  it("states the configured delay in every rule that depends on it", (): void => {
    writeConfig({ delayMinutes: 5 });

    const text = extensionInstructions(appDir);

    expect(text.split("more than 5 min").length - 1).toBe(3);
    expect(text).not.toContain("more than 4 min");
  });

  it("uses the 4 min default without config", (): void => {
    expect(extensionInstructions(appDir)).toContain("more than 4 min");
  });

  it("points to the mermaid extension command", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      `\`${mermaidCommand()} <file.mmd>\``,
    );
  });

  it("quotes the waiting notice and the reply header in the configured language", (): void => {
    writeConfig({ language: "pt-br" });

    const ptText = extensionInstructions(appDir);

    expect(ptText).toContain('"A instância [nome] do Claude"');
    expect(ptText).toContain('"↩️ Em resposta à mensagem do Claude"');

    writeConfig({ language: "en-us" });

    const enText = extensionInstructions(appDir);

    expect(enText).toContain('"The Claude instance [name]"');
    expect(enText).toContain(`"↩️ In reply to Claude's message"`);
  });
});

describe("extensionInstructions › language", () => {
  it("tells Claude to write on Telegram in Brazilian Portuguese when the setup chose pt-br", (): void => {
    writeConfig({ language: "pt-br" });

    expect(extensionInstructions(appDir)).toContain(
      "write every Telegram message to the user in Brazilian Portuguese",
    );
  });

  it("tells Claude to write on Telegram in English when the setup chose en-us or nothing", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "write every Telegram message to the user in English",
    );

    writeConfig({ language: "en-us" });

    expect(extensionInstructions(appDir)).toContain(
      "write every Telegram message to the user in English",
    );
  });
});

describe("extensionInstructions › sending rules", () => {
  it("forbids sending secrets on Telegram, which has no end-to-end encryption", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "Never send a secret on Telegram: no token, password, private key, API key or content of a .env file, not even in part, a screenshot or a file. Chats with a bot are not end-to-end encrypted.",
    );
  });

  it("asks for the instance and a short title on the first line of a relayed message", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "start with the instance name in brackets and a short title",
    );
  });

  it("asks to check every image and video before sending it", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "Open and check every image or video before sending it",
    );
  });

  it("keeps questions on AskUserQuestion buttons, never loose in the text", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "never as a loose question in the text",
    );
  });

  it("sends images in the order the text cites them", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "in the order the text cites them",
    );
  });

  it("marks what Claude noticed and the instance did not say with 👀", (): void => {
    expect(extensionInstructions(appDir)).toContain("starting with 👀");
  });

  it("explains that images arrive recompressed and exact bytes go zipped", (): void => {
    const text = extensionInstructions(appDir);

    expect(text).toContain("recompressed");
    expect(text).toContain(".zip");
  });
});
