import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { CHANNEL_GUIDE_SKILL, extensionInstructions } from "../instructions.ts";

const SERVER_FILE = join(import.meta.dirname, "..", "..", "server.ts");
const CLAUDE_CODE_INSTRUCTIONS_LIMIT = 4096;

const RULE_OPENINGS = [
  "better-claude-code-telegram rules for this Telegram channel",
  "Never send a secret on Telegram:",
  "This bot exists only to talk to the user:",
  "Who you talk to:",
  "AskUserQuestion:",
  "Waiting:",
  "Formatting on Telegram:",
  "Channel guide:",
  "Other instances:",
];

let appDir = "";

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(appDir, CONFIG_FILE), JSON.stringify(config));
}

function serverInstructions(extensionText: string): string {
  const source = ts.createSourceFile(
    SERVER_FILE,
    readFileSync(SERVER_FILE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "instructions" &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      ts.isArrayLiteralExpression(node.initializer.expression.expression)
    ) {
      const separator = node.initializer.arguments[0];
      const parts = node.initializer.expression.expression.elements.map(
        (element) =>
          ts.isStringLiteralLike(element) ? element.text : extensionText,
      );

      found.push(
        parts.join(ts.isStringLiteralLike(separator) ? separator.text : ""),
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  expect(found).toHaveLength(1);

  return found[0];
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

describe("extensionInstructions › size", () => {
  it("joins the upstream text and the extension rules by line breaks in the server instructions", (): void => {
    const text = serverInstructions("EXTENSION RULES");

    expect(
      text.startsWith("The sender reads Telegram, not this session."),
    ).toBe(true);
    expect(text.endsWith("\n\nEXTENSION RULES")).toBe(true);
  });

  it("keeps the server instructions within 4096 characters with the longest settings per language", (): void => {
    const lengths = ["en-us", "pt-br"].flatMap((language) =>
      [true, false].map((visualReview) => {
        writeConfig({
          language,
          delayMinutes: 99_999,
          visuals: "video",
          visualReview,
        });

        return serverInstructions(extensionInstructions(appDir)).length;
      }),
    );

    expect(
      lengths.filter((length) => length > CLAUDE_CODE_INSTRUCTIONS_LIMIT),
    ).toEqual([]);
  });
});

describe("extensionInstructions › channel rules", () => {
  it("limits the rules to the instance started with claude --telegram", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "only for the instance started with 'claude --telegram'.",
    );
  });

  it("treats a Telegram message like one typed in the terminal and answers it through reply", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "a Telegram message counts as one typed in the terminal. Answer it with the reply tool",
    );
  });

  it("asks for short lines and a title first on Telegram", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "never a wall of text; one idea per line, a blank line between sections, the task name and a short title first.",
    );
  });

  it("sends a decision through AskUserQuestion buttons with its context in the same message", (): void => {
    const text = extensionInstructions(appDir);

    expect(text).toContain(
      "AskUserQuestion: decisions go through it, never as a loose question in the text.",
    );
    expect(text).toContain(
      "Telegram does not show the terminal, so put in the same message the context needed to answer",
    );
    expect(text).toContain(
      "context and question are mirrored there; an answer given there returns as the normal result.",
    );
  });

  it("keeps the bot only for talking to the user", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "This bot exists only to talk to the user: never test another Telegram integration with it, never reach the user through another bot.",
    );
  });

  it("forbids sending secrets on Telegram, which has no end-to-end encryption", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "Never send a secret on Telegram: no token, password, private key, API key or .env content, not even in part, a screenshot or a file. Bot chats are not end-to-end encrypted; if asked there, say it stays in the terminal.",
    );
  });
});

describe("extensionInstructions › channel guide", () => {
  it("names the channel guide skill of the telegram plugin", (): void => {
    expect(CHANNEL_GUIDE_SKILL).toBe("telegram:channel-guide");
  });

  it("loads the channel guide before a decision question, a table, an image, a video or a drawing", (): void => {
    expect(extensionInstructions(appDir).split("\n\n")).toContain(
      "Channel guide: before a decision question, a table, an image, a video or a drawing, load the telegram:channel-guide skill.",
    );
  });

  it("leaves the illustrations out while the setup keeps them off", (): void => {
    writeConfig({ visuals: "off", visualReview: true });

    expect(extensionInstructions(appDir)).not.toContain("Illustrations");
  });

  it("shows every visual idea as a screenshot when the setup turned the prints on", (): void => {
    writeConfig({ visuals: "prints" });

    expect(extensionInstructions(appDir)).toContain(
      "load the telegram:channel-guide skill. Illustrations are on: show every visual idea as a screenshot before building it. Check each one before sending.",
    );
  });

  it("adds the movement as a video and skips the review when the setup chose so", (): void => {
    writeConfig({ visuals: "video", visualReview: false });

    expect(extensionInstructions(appDir)).toContain(
      "load the telegram:channel-guide skill. Illustrations are on: show every visual idea as a screenshot, and movement as a video, before building it. Send each one without reviewing it.",
    );
  });
});

describe("extensionInstructions › other instances", () => {
  it("forwards a Telegram answer to the waiting instance through SendMessage", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "goes at once to that instance by SendMessage (ListAgents by name), then is confirmed on Telegram.",
    );
  });

  it("starts a relayed message with the instance name and a short title, marking notices with 👀", (): void => {
    const text = extensionInstructions(appDir);

    expect(text).toContain(
      "What an instance asks you to send starts with [<name>] and a short title (e.g. [api] Phase 2)",
    );
    expect(text).toContain(
      "what you noticed that it did not say goes on its own line starting with 👀.",
    );
  });

  it("reports every active instance when the user asks for progress", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "Asked for progress, report every active instance in its own section, asking them by SendMessage when what you know is stale.",
    );
  });
});

describe("extensionInstructions › current rules", () => {
  it("states the configured delay in every rule that depends on it", (): void => {
    writeConfig({ delayMinutes: 5 });

    const text = extensionInstructions(appDir);

    expect(text.split("more than 5 min").length - 1).toBe(2);
    expect(text).not.toContain("more than 4 min");
  });

  it("states the question delay in the AskUserQuestion rule and the notice delay in the Waiting rule", (): void => {
    writeConfig({ delayMinutes: 4, delays: { questions: 0, waiting: 10 } });

    const paragraphs = extensionInstructions(appDir).split("\n\n");
    const rule = (opening: string): string =>
      paragraphs.find((paragraph) => paragraph.startsWith(opening)) ?? "";

    expect(rule("AskUserQuestion:")).toContain("After more than 0 s without");
    expect(rule("Waiting:")).toContain("after more than 10 min of terminal");
  });

  it("uses the 4 min default without config", (): void => {
    expect(extensionInstructions(appDir)).toContain("more than 4 min");
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
      "in Brazilian Portuguese (the setup language), whatever the terminal language.",
    );
  });

  it("tells Claude to write on Telegram in English when the setup chose en-us or nothing", (): void => {
    expect(extensionInstructions(appDir)).toContain(
      "in English (the setup language), whatever the terminal language.",
    );

    writeConfig({ language: "en-us" });

    expect(extensionInstructions(appDir)).toContain(
      "in English (the setup language), whatever the terminal language.",
    );
  });
});
