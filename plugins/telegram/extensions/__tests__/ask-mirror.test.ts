import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shortIdFor, type AskQuestion } from "../ask-format.ts";
import { createAskMirror, type CallbackContext } from "../ask-mirror.ts";
import { CONFIG_FILE } from "../config.ts";
import { MESSAGES, type Messages } from "../i18n.ts";

const CHAT = "42";
const ASK_ID = "s1-1000";
const SHORT = shortIdFor(ASK_ID);
const PT = MESSAGES["pt-br"];
const EN = MESSAGES["en-us"];

const SINGLE: AskQuestion = {
  question: "Qual banco?",
  header: "Banco",
  options: [{ label: "Postgres" }, { label: "Redis" }],
};
const MULTI: AskQuestion = {
  question: "Quais camadas?",
  multiSelect: true,
  options: [{ label: "Backend" }, { label: "Frontend" }],
};

interface Markup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

interface SendOptions {
  reply_markup?: Markup;
  parse_mode?: "HTML";
}

interface SentMessage {
  chatId: string;
  text: string;
  parseMode: string | undefined;
  keyboard: Markup["inline_keyboard"] | undefined;
}

interface EditedMarkup {
  chatId: string;
  messageId: number;
  keyboard: Markup["inline_keyboard"];
}

interface AskOptions {
  dueAt?: number;
  context?: string | null;
  instance?: string | null;
}

interface SetupOptions {
  messages?: () => Messages;
  rejectSend?: (text: string) => boolean;
  failEdit?: boolean;
}

interface TextCase {
  name: string;
  messages: (() => Messages) | undefined;
  language: string | null;
  texts: {
    context: string;
    title: string;
    done: string;
    other: string;
    terminal: string;
    delivered: string;
    writeOther: string;
    notAuthorized: string;
    closed: string;
    alreadyAnswered: string;
    logSent: string;
    logTerminal: string;
    logDelivered: string;
    logEditFailed: string;
    logConfirmFailed: string;
    logCycleFailed: string;
  };
}

const PT_TEXTS: TextCase["texts"] = {
  context:
    "📝 Contexto (o que o Claude escreveu no terminal antes da pergunta):\n\nComparei Postgres e Redis.",
  title: "❓ Pergunta aberta no terminal de [back-s3]",
  done: "✅ Concluir",
  other: "✍️ Outra resposta (escrever)",
  terminal: "✅ Respondida no terminal",
  delivered:
    "✅ Respostas entregues: a pergunta do terminal foi respondida com elas.",
  writeOther: "✍️ Escreva aqui a resposta da pergunta 1 [Banco].",
  notAuthorized: "Não autorizado.",
  closed: "Essa pergunta já foi encerrada.",
  alreadyAnswered: "Essa pergunta já foi respondida.",
  logSent: "ask: pergunta s1-1000 de [back-s3] enviada ao Telegram",
  logTerminal: "ask: pergunta s1-1000 respondida no terminal",
  logDelivered: "ask: respostas da pergunta s1-1000 entregues pelo Telegram",
  logEditFailed: "ask: falha ao editar botões: Error: boom",
  logConfirmFailed: "ask: falha ao confirmar no chat: Error: boom",
  logCycleFailed: "ask: falha no ciclo do espelho: Error: boom",
};

const EN_TEXTS: TextCase["texts"] = {
  context:
    "📝 Context (what Claude wrote in the terminal before the question):\n\nComparei Postgres e Redis.",
  title: "❓ Question open in the terminal from [back-s3]",
  done: "✅ Done",
  other: "✍️ Other answer (type it)",
  terminal: "✅ Answered in the terminal",
  delivered:
    "✅ Answers delivered: the terminal question was answered with them.",
  writeOther: "✍️ Type here the answer to question 1 [Banco].",
  notAuthorized: "Not authorized.",
  closed: "This question is already closed.",
  alreadyAnswered: "This question was already answered.",
  logSent: "ask: question s1-1000 from [back-s3] sent to Telegram",
  logTerminal: "ask: question s1-1000 answered in the terminal",
  logDelivered: "ask: answers to question s1-1000 delivered through Telegram",
  logEditFailed: "ask: failed to edit the buttons: Error: boom",
  logConfirmFailed: "ask: failed to confirm in the chat: Error: boom",
  logCycleFailed: "ask: mirror cycle failed: Error: boom",
};

const TEXT_CASES: TextCase[] = [
  {
    name: "messages set to pt-br",
    messages: () => PT,
    language: null,
    texts: PT_TEXTS,
  },
  {
    name: "messages set to en-us",
    messages: () => EN,
    language: null,
    texts: EN_TEXTS,
  },
  {
    name: "pt-br in the config and no messages option",
    messages: undefined,
    language: "pt-br",
    texts: PT_TEXTS,
  },
  {
    name: "no config and no messages option",
    messages: undefined,
    language: null,
    texts: EN_TEXTS,
  },
];

let appDir = "";

function asksDir(): string {
  return join(appDir, "asks");
}

function answerFile(): string {
  return join(asksDir(), `${ASK_ID}.answer.json`);
}

function readAnswers(): unknown {
  const parsed: unknown = JSON.parse(readFileSync(answerFile(), "utf8"));

  return typeof parsed === "object" && parsed !== null && "answers" in parsed
    ? parsed.answers
    : null;
}

function fakeApi({
  rejectSend = (): boolean => false,
  failEdit = false,
}: Pick<SetupOptions, "rejectSend" | "failEdit">): {
  sent: SentMessage[];
  edits: EditedMarkup[];
  api: {
    sendMessage: (
      chatId: string,
      text: string,
      options?: SendOptions,
    ) => Promise<{ message_id: number }>;
    editMessageReplyMarkup: (
      chatId: string,
      messageId: number,
      options: { reply_markup: Markup },
    ) => Promise<unknown>;
  };
} {
  const sent: SentMessage[] = [];
  const edits: EditedMarkup[] = [];
  let nextMessageId = 100;

  return {
    sent,
    edits,
    api: {
      sendMessage: (chatId, text, options): Promise<{ message_id: number }> => {
        if (rejectSend(text)) return Promise.reject(new Error("boom"));

        sent.push({
          chatId,
          text,
          parseMode: options?.parse_mode,
          keyboard: options?.reply_markup?.inline_keyboard,
        });
        nextMessageId += 1;

        return Promise.resolve({ message_id: nextMessageId });
      },
      editMessageReplyMarkup: (
        chatId,
        messageId,
        options,
      ): Promise<unknown> => {
        if (failEdit) return Promise.reject(new Error("boom"));

        edits.push({
          chatId,
          messageId,
          keyboard: options.reply_markup.inline_keyboard,
        });

        return Promise.resolve();
      },
    },
  };
}

function writeAsk(
  questions: AskQuestion[],
  { dueAt = 0, context = null, instance = null }: AskOptions = {},
): void {
  mkdirSync(asksDir(), { recursive: true });
  writeFileSync(
    join(asksDir(), `${ASK_ID}.json`),
    JSON.stringify({
      id: ASK_ID,
      sessionId: "s1",
      createdAt: Date.now(),
      dueAt,
      instance,
      context,
      questions,
    }),
  );
}

function writeTimestamp(name: string, value: number): void {
  mkdirSync(join(appDir, "pings"), { recursive: true });
  writeFileSync(join(appDir, "pings", name), String(value));
}

function writeLanguage(language: string): void {
  writeFileSync(join(appDir, CONFIG_FILE), JSON.stringify({ language }));
}

function callback(
  data: string,
  fromId = Number(CHAT),
): { answers: (string | null)[]; ctx: CallbackContext } {
  const answers: (string | null)[] = [];

  return {
    answers,
    ctx: {
      callbackQuery: { data },
      from: { id: fromId, username: "dev" },
      chat: { id: fromId },
      answerCallbackQuery: (options): Promise<unknown> => {
        answers.push(options?.text ?? null);

        return Promise.resolve();
      },
    },
  };
}

function setup({
  messages = (): Messages => PT,
  ...apiOptions
}: SetupOptions = {}): {
  telegram: ReturnType<typeof fakeApi>;
  mirror: ReturnType<typeof createAskMirror>;
  logs: string[];
} {
  const telegram = fakeApi(apiOptions);
  const logs: string[] = [];
  const mirror = createAskMirror({
    api: telegram.api,
    appDir,
    allowedChats: () => [CHAT],
    log: (message) => logs.push(message),
    messages,
  });

  return { telegram, mirror, logs };
}

function setupFollowingConfig(
  apiOptions: SetupOptions = {},
): ReturnType<typeof setup> {
  const telegram = fakeApi(apiOptions);
  const logs: string[] = [];
  const mirror = createAskMirror({
    api: telegram.api,
    appDir,
    allowedChats: () => [CHAT],
    log: (message) => logs.push(message),
  });

  return { telegram, mirror, logs };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 17, 15, 0));
  appDir = mkdtempSync(join(tmpdir(), "bcct-ask-mirror-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(appDir, { recursive: true, force: true });
});

describe("question sending", () => {
  it("only sends after the deadline, one message per question, as HTML", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE, MULTI], { dueAt: Date.now() + 60_000 });
    await mirror.tick();
    expect(telegram.sent.length).toBe(0);

    writeAsk([SINGLE, MULTI], { dueAt: 0 });
    await mirror.tick();
    await mirror.tick();

    expect(telegram.sent.length).toBe(2);
    expect(telegram.sent[0].chatId).toBe(CHAT);
    expect(telegram.sent[0].parseMode).toBe("HTML");
    expect(
      telegram.sent[0].text.startsWith("❓ Pergunta aberta no terminal (1/2)"),
    ).toBe(true);
    expect(telegram.sent[1].keyboard?.at(-1)?.[0].text).toBe("✅ Concluir");
  });

  it("sends before the deadline when the last message came from Telegram", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeTimestamp("last-prompt", Date.now() - 2000);
    writeTimestamp("last-inbound", Date.now() - 1000);
    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    await mirror.tick();

    expect(telegram.sent.length).toBe(1);
  });

  it("waits for the deadline when the terminal prompt is newer than the last Telegram message", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeTimestamp("last-inbound", Date.now() - 2000);
    writeTimestamp("last-prompt", Date.now() - 1000);
    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    await mirror.tick();

    expect(telegram.sent.length).toBe(0);
  });

  it("waits for the deadline when the last Telegram message timestamp is not a number", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    mkdirSync(join(appDir, "pings"), { recursive: true });
    writeFileSync(join(appDir, "pings", "last-inbound"), "not a timestamp");
    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    await mirror.tick();

    expect(telegram.sent.length).toBe(0);
  });

  it("holds the question during quiet hours even when the conversation is on Telegram", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ quietHours: { start: "14:00", end: "16:00" } }),
    );
    writeTimestamp("last-inbound", Date.now() - 1000);
    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    await mirror.tick();

    expect(telegram.sent.length).toBe(0);
  });

  it("sends the context first, without buttons, and identifies the instance", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE], {
      context: "Comparei Postgres e Redis.",
      instance: "back-s3",
    });
    await mirror.tick();

    expect(telegram.sent.length).toBe(2);
    expect(telegram.sent[0].text).toBe(
      "📝 Contexto (o que o Claude escreveu no terminal antes da pergunta):\n\nComparei Postgres e Redis.",
    );
    expect(telegram.sent[0].keyboard).toBeUndefined();
    expect(
      telegram.sent[1].text.startsWith(
        "❓ Pergunta aberta no terminal de [back-s3]",
      ),
    ).toBe(true);
  });

  it("splits a long question and puts the buttons only on the last part", async (): Promise<void> => {
    const { telegram, mirror } = setup();
    const longPreview = "linha da prévia\n".repeat(600);

    writeAsk([
      { question: "Q?", options: [{ label: "A", preview: longPreview }] },
    ]);
    await mirror.tick();

    expect(telegram.sent.length).toBeGreaterThan(1);
    expect(
      telegram.sent.slice(0, -1).every((message) => !message.keyboard),
    ).toBe(true);
    expect(telegram.sent.at(-1)?.keyboard).not.toBeUndefined();
    expect(
      telegram.sent
        .map((message) => message.text)
        .join("\n")
        .split("linha da prévia").length - 1,
    ).toBe(600);
  });
});

describe("answer through Telegram", () => {
  it("a single option writes the answer in the terminal format and confirms", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    expect(await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx)).toBe(
      true,
    );

    expect(telegram.edits.at(-1)?.keyboard).toEqual([
      [{ text: "✅ Redis", callback_data: "ask:answered" }],
    ]);
    expect(readAnswers()).toEqual({ "Qual banco?": "Redis" });
    expect(telegram.sent.at(-1)?.text).toBe(
      "✅ Respostas entregues: a pergunta do terminal foi respondida com elas.",
    );
  });

  it("multiple choice marks, unmarks and only finishes with a selection", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();

    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);
    expect(existsSync(answerFile())).toBe(false);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);
    expect(telegram.edits.at(-1)?.keyboard[1][0].text).toBe("☑️ 2. Frontend");

    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(readAnswers()).toEqual({ "Quais camadas?": "Backend, Frontend" });
  });

  it("the other answer asks for the text and uses the next message", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(telegram.sent.at(-1)?.text).toBe(
      "✍️ Escreva aqui a resposta da pergunta 1 [Banco].",
    );
    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(true);
    expect(readAnswers()).toEqual({ "Qual banco?": "MySQL" });
    expect(await mirror.consumeText(CHAT, "conversa normal")).toBe(false);
  });

  it("only writes the answer with every question answered and ignores the second tap", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    const second = callback(`ask:${SHORT}:0:1`);

    await mirror.handleCallback(second.ctx);

    expect(second.answers).toEqual(["Essa pergunta já foi respondida."]);
    expect(existsSync(answerFile())).toBe(false);
  });
});

describe("answer through the terminal", () => {
  it("swaps the buttons of the open questions and cleans everything", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
    await mirror.tick();

    expect(telegram.edits.at(-1)?.keyboard).toEqual([
      [{ text: "✅ Respondida no terminal", callback_data: "ask:answered" }],
    ]);
    expect(readdirSync(asksDir())).toEqual([]);
  });

  it("sends nothing to Telegram if it closed before the deadline", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
    await mirror.tick();

    expect(telegram.sent.length).toBe(0);
    expect(readdirSync(asksDir())).toEqual([]);
  });

  it("after the Telegram answer, closing cleans up without touching the buttons", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    const editsAfterAnswer = telegram.edits.length;

    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
    await mirror.tick();

    expect(telegram.edits.length).toBe(editsAfterAnswer);
    expect(readdirSync(asksDir())).toEqual([]);
  });
});

describe("click security", () => {
  it("refuses a click from someone outside the allowlist", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    const stranger = callback(`ask:${SHORT}:0:0`, 7);

    expect(await mirror.handleCallback(stranger.ctx)).toBe(true);
    expect(stranger.answers).toEqual(["Não autorizado."]);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("leaves the permission buttons to the plugin", async (): Promise<void> => {
    const { mirror } = setup();

    expect(await mirror.handleCallback(callback("perm:allow:abcde").ctx)).toBe(
      false,
    );
  });
});

for (const { name, messages, language, texts } of TEXT_CASES) {
  describe(`texts with ${name}`, () => {
    const build = (apiOptions: SetupOptions = {}): ReturnType<typeof setup> => {
      if (language) writeLanguage(language);

      return messages
        ? setup({ ...apiOptions, messages })
        : setupFollowingConfig(apiOptions);
    };

    it("sends the context, the question title and the button labels", async (): Promise<void> => {
      const { telegram, mirror, logs } = build();

      writeAsk([SINGLE, MULTI], {
        context: "Comparei Postgres e Redis.",
        instance: "back-s3",
      });
      await mirror.tick();

      expect(telegram.sent[0].text).toBe(texts.context);
      expect(telegram.sent[1].text.startsWith(texts.title)).toBe(true);
      expect(telegram.sent[1].keyboard?.at(-1)?.[0].text).toBe(texts.other);
      expect(telegram.sent[2].keyboard?.at(-2)?.[0].text).toBe(texts.other);
      expect(telegram.sent[2].keyboard?.at(-1)?.[0].text).toBe(texts.done);
      expect(logs).toEqual([texts.logSent]);
    });

    it("confirms the delivery in the chat and in the log", async (): Promise<void> => {
      const { telegram, mirror, logs } = build();

      writeAsk([SINGLE], { instance: "back-s3" });
      await mirror.tick();
      await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

      expect(telegram.sent.at(-1)?.text).toBe(texts.delivered);
      expect(logs).toEqual([texts.logSent, texts.logDelivered]);
    });

    it("asks for the other answer text", async (): Promise<void> => {
      const { telegram, mirror } = build();

      writeAsk([SINGLE], { instance: "back-s3" });
      await mirror.tick();
      await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

      expect(telegram.sent.at(-1)?.text).toBe(texts.writeOther);
    });

    it("answers the callback with the not authorized, closed and already answered texts", async (): Promise<void> => {
      const { mirror } = build();

      writeAsk([SINGLE, MULTI], { instance: "back-s3" });
      await mirror.tick();

      const stranger = callback(`ask:${SHORT}:0:0`, 7);
      const unknown = callback("ask:deadbeef:0:0");
      const first = callback(`ask:${SHORT}:0:0`);
      const second = callback(`ask:${SHORT}:0:1`);

      await mirror.handleCallback(stranger.ctx);
      await mirror.handleCallback(unknown.ctx);
      await mirror.handleCallback(first.ctx);
      await mirror.handleCallback(second.ctx);

      expect(stranger.answers).toEqual([texts.notAuthorized]);
      expect(unknown.answers).toEqual([texts.closed]);
      expect(second.answers).toEqual([texts.alreadyAnswered]);
    });

    it("marks the open question as answered in the terminal and logs it", async (): Promise<void> => {
      const { telegram, mirror, logs } = build();

      writeAsk([SINGLE], { instance: "back-s3" });
      await mirror.tick();
      writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
      await mirror.tick();

      expect(telegram.edits.at(-1)?.keyboard).toEqual([
        [{ text: texts.terminal, callback_data: "ask:answered" }],
      ]);
      expect(logs).toEqual([texts.logSent, texts.logTerminal]);
    });

    it("logs a failed button edit", async (): Promise<void> => {
      const { mirror, logs } = build({ failEdit: true });

      writeAsk([SINGLE], { instance: "back-s3" });
      await mirror.tick();
      await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

      expect(logs).toContain(texts.logEditFailed);
    });

    it("logs a failed delivery confirmation", async (): Promise<void> => {
      const { mirror, logs } = build({
        rejectSend: (text) => text.startsWith("✅"),
      });

      writeAsk([SINGLE], { instance: "back-s3" });
      await mirror.tick();
      await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

      expect(logs).toContain(texts.logConfirmFailed);
    });

    it("logs a failed mirror cycle", async (): Promise<void> => {
      const { mirror, logs } = build({ rejectSend: () => true });

      writeAsk([SINGLE], { instance: "back-s3" });
      await mirror.tick();

      expect(logs).toEqual([texts.logCycleFailed]);
    });
  });
}

function rejectingCallback(
  data: string,
  fromId = Number(CHAT),
): { calls: { count: number }; ctx: CallbackContext } {
  const calls = { count: 0 };

  return {
    calls,
    ctx: {
      callbackQuery: { data },
      from: { id: fromId, username: "dev" },
      chat: { id: fromId },
      answerCallbackQuery: (): Promise<unknown> => {
        calls.count += 1;

        return Promise.reject(new Error("query too old"));
      },
    },
  };
}

function writeAskWithId(id: string, createdAt: number): void {
  mkdirSync(asksDir(), { recursive: true });
  writeFileSync(
    join(asksDir(), `${id}.json`),
    JSON.stringify({
      id,
      sessionId: id.split("-")[0],
      createdAt,
      dueAt: 0,
      instance: null,
      context: null,
      questions: [SINGLE],
    }),
  );
}

describe("mirror cycle edges", () => {
  it("does nothing while the asks folder does not exist", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup();

    await mirror.tick();

    expect(telegram.sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("removes an ask file that is not a valid record", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    mkdirSync(asksDir(), { recursive: true });
    writeFileSync(join(asksDir(), `${ASK_ID}.json`), "{ not json");
    await mirror.tick();

    expect(telegram.sent).toEqual([]);
    expect(readdirSync(asksDir())).toEqual([]);
  });

  it("drops a question older than a day, with its answer file, without sending it", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    writeFileSync(answerFile(), "{}");
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    await mirror.tick();

    expect(telegram.sent).toEqual([]);
    expect(readdirSync(asksDir())).toEqual([]);
  });
});

describe("clicks whose acknowledgment Telegram refuses", () => {
  it("handles a click on an answered button", async (): Promise<void> => {
    const { mirror } = setup();
    const click = rejectingCallback("ask:answered");

    expect(await mirror.handleCallback(click.ctx)).toBe(true);
    expect(click.calls.count).toBe(1);
  });

  it("still refuses a stranger", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    const stranger = rejectingCallback(`ask:${SHORT}:0:0`, 7);

    expect(await mirror.handleCallback(stranger.ctx)).toBe(true);
    expect(stranger.calls.count).toBe(1);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("still says the question is closed when its ask is gone", async (): Promise<void> => {
    const { mirror } = setup();
    const click = rejectingCallback(`ask:${SHORT}:0:0`);

    expect(await mirror.handleCallback(click.ctx)).toBe(true);
    expect(click.calls.count).toBe(1);
  });

  it("still ignores a second tap on an answered question", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    const second = rejectingCallback(`ask:${SHORT}:0:1`);

    expect(await mirror.handleCallback(second.ctx)).toBe(true);
    expect(second.calls.count).toBe(1);
    expect(existsSync(answerFile())).toBe(false);
  });
});

describe("typed answer with more than one open question", () => {
  it("goes to the newest question waiting for a typed answer", async (): Promise<void> => {
    const { mirror } = setup();
    const older = "s1-1000";
    const newer = "s2-2000";

    writeAskWithId(older, Date.now() - 1000);
    writeAskWithId(newer, Date.now());
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${shortIdFor(older)}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${shortIdFor(newer)}:0:o`).ctx);

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(true);
    expect(existsSync(join(asksDir(), `${newer}.answer.json`))).toBe(true);
    expect(existsSync(join(asksDir(), `${older}.answer.json`))).toBe(false);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function sentStateFile(): string {
  return join(asksDir(), `${ASK_ID}.telegram.json`);
}

function fileMode(file: string): number {
  return statSync(file).mode & 0o777;
}

const VALID_SENT_STATE = {
  shortId: SHORT,
  messages: [],
  progress: { answers: {}, selections: {} },
  awaitingOther: null,
  completed: false,
};

const MALFORMED_SENT_STATES: { name: string; content: unknown }[] = [
  { name: "a number", content: 5 },
  { name: "null", content: null },
  { name: "an empty object", content: {} },
  {
    name: "no short id",
    content: { ...VALID_SENT_STATE, shortId: undefined },
  },
  {
    name: "messages that are not a list",
    content: { ...VALID_SENT_STATE, messages: {} },
  },
  { name: "a null progress", content: { ...VALID_SENT_STATE, progress: null } },
  {
    name: "a progress that is not an object",
    content: { ...VALID_SENT_STATE, progress: 5 },
  },
];

describe("sent state on disk", () => {
  it("records which message carries each question, readable only by the owner", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();

    expect(JSON.parse(readFileSync(sentStateFile(), "utf8"))).toEqual({
      ...VALID_SENT_STATE,
      messages: [
        { chatId: CHAT, questionIndex: 0, messageId: 101 },
        { chatId: CHAT, questionIndex: 1, messageId: 102 },
      ],
    });
    expect(fileMode(sentStateFile())).toBe(0o600);
  });

  for (const { name, content } of MALFORMED_SENT_STATES) {
    it(`sends the question again when the sent state holds ${name}`, async (): Promise<void> => {
      const { telegram, mirror } = setup();

      writeAsk([SINGLE]);
      writeFileSync(sentStateFile(), JSON.stringify(content));
      await mirror.tick();

      expect(telegram.sent.length).toBe(1);
      expect(JSON.parse(readFileSync(sentStateFile(), "utf8"))).toMatchObject({
        shortId: SHORT,
        messages: [{ chatId: CHAT, questionIndex: 0, messageId: 101 }],
      });
    });
  }

  it("keeps the sent state and the answer file across later cycles", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    const sentAfterAnswer = telegram.sent.length;

    await mirror.tick();
    await mirror.tick();

    expect(telegram.sent.length).toBe(sentAfterAnswer);
    expect(readAnswers()).toEqual({ "Qual banco?": "Postgres" });
    expect(fileMode(answerFile())).toBe(0o600);
  });

  it("after the Telegram answer, closing neither sends again nor logs a terminal answer", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    await mirror.tick();
    const sentAfterAnswer = telegram.sent.length;

    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
    await mirror.tick();

    expect(telegram.sent.length).toBe(sentAfterAnswer);
    expect(logs).toEqual([
      "ask: pergunta s1-1000 de [telegram] enviada ao Telegram",
      "ask: respostas da pergunta s1-1000 entregues pelo Telegram",
    ]);
  });
});

describe("mirror cycle timing", () => {
  it("does nothing in a cycle that starts while another one runs", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await Promise.all([mirror.tick(), mirror.tick()]);
    await mirror.tick();

    expect(telegram.sent.length).toBe(1);
  });

  it("sends a question that reaches its deadline right now", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE], { dueAt: Date.now() });
    await mirror.tick();

    expect(telegram.sent.length).toBe(1);
  });

  it("still sends a question exactly one day old", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    vi.setSystemTime(Date.now() + DAY_MS);
    await mirror.tick();

    expect(telegram.sent.length).toBe(1);
  });

  it("drops a question older than a day that has no answer file, without errors", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup();

    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });
    vi.setSystemTime(Date.now() + DAY_MS + 1);
    await mirror.tick();

    expect(telegram.sent).toEqual([]);
    expect(logs).toEqual([]);
    expect(readdirSync(asksDir())).toEqual([]);
  });

  it("does nothing while the asks path is not a folder", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup();

    writeFileSync(asksDir(), "");
    await mirror.tick();

    expect(telegram.sent).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe("files in the asks folder", () => {
  it("leaves a stray file and a JSON file whose name is not an ask id alone", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup();

    writeAsk([SINGLE]);
    writeFileSync(join(asksDir(), "notes.txt"), "");
    writeFileSync(join(asksDir(), "my.notes.json"), "{}");
    writeFileSync(join(asksDir(), `${ASK_ID}.json.bak`), "");
    await mirror.tick();
    await mirror.tick();

    expect(telegram.sent.length).toBe(1);
    expect(logs).toEqual([
      "ask: pergunta s1-1000 de [telegram] enviada ao Telegram",
    ]);
    expect(readdirSync(asksDir()).toSorted()).toEqual([
      "my.notes.json",
      "notes.txt",
      `${ASK_ID}.json`,
      `${ASK_ID}.json.bak`,
      `${ASK_ID}.telegram.json`,
    ]);
  });

  it("never deletes a file it did not create, even one named after a stray file", async (): Promise<void> => {
    const { mirror, logs } = setup();

    mkdirSync(asksDir(), { recursive: true });
    writeFileSync(join(asksDir(), "notes.json12345"), "");
    writeFileSync(join(asksDir(), "notes.json.closed"), "");
    await mirror.tick();

    expect(logs).toEqual([]);
    expect(readdirSync(asksDir()).toSorted()).toEqual([
      "notes.json.closed",
      "notes.json12345",
    ]);
  });
});

describe("buttons of each question", () => {
  it("swaps only the buttons of the answered question", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(telegram.edits).toEqual([
      {
        chatId: CHAT,
        messageId: 101,
        keyboard: [[{ text: "✅ Postgres", callback_data: "ask:answered" }]],
      },
    ]);
  });

  it("an answer in the terminal swaps only the buttons of the questions still open", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
    await mirror.tick();

    expect(telegram.edits.slice(1)).toEqual([
      {
        chatId: CHAT,
        messageId: 102,
        keyboard: [
          [
            {
              text: "✅ Respondida no terminal",
              callback_data: "ask:answered",
            },
          ],
        ],
      },
    ]);
  });
});

describe("clicks the mirror takes", () => {
  it("takes the other, done and multiple choice clicks", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();

    expect(await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx)).toBe(
      true,
    );
    expect(await mirror.handleCallback(callback(`ask:${SHORT}:1:d`).ctx)).toBe(
      true,
    );
    expect(await mirror.handleCallback(callback(`ask:${SHORT}:1:0`).ctx)).toBe(
      true,
    );
    expect(await mirror.handleCallback(callback(`ask:${SHORT}:1:d`).ctx)).toBe(
      true,
    );
  });

  it("acknowledges and ignores an option the question does not have", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    const click = callback(`ask:${SHORT}:0:2`);

    expect(await mirror.handleCallback(click.ctx)).toBe(true);
    expect(click.answers).toEqual([null]);
    expect(telegram.edits).toEqual([]);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("says a question index beyond the ask is closed", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    const click = callback(`ask:${SHORT}:3:0`);

    expect(await mirror.handleCallback(click.ctx)).toBe(true);
    expect(click.answers).toEqual(["Essa pergunta já foi encerrada."]);
  });

  it("says a question not sent yet is closed", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });

    const click = callback(`ask:${SHORT}:0:0`);

    expect(await mirror.handleCallback(click.ctx)).toBe(true);
    expect(click.answers).toEqual(["Essa pergunta já foi encerrada."]);
  });

  it("leaves a click without callback data to the plugin", async (): Promise<void> => {
    const { mirror } = setup();
    const answers: (string | null)[] = [];

    expect(
      await mirror.handleCallback({
        from: { id: Number(CHAT) },
        answerCallbackQuery: (options): Promise<unknown> => {
          answers.push(options?.text ?? null);

          return Promise.resolve();
        },
      }),
    ).toBe(false);
    expect(answers).toEqual([]);
  });

  it("refuses a click without a sender", async (): Promise<void> => {
    const { mirror } = setup();
    const answers: (string | null)[] = [];

    writeAsk([SINGLE]);
    await mirror.tick();

    expect(
      await mirror.handleCallback({
        callbackQuery: { data: `ask:${SHORT}:0:0` },
        answerCallbackQuery: (options): Promise<unknown> => {
          answers.push(options?.text ?? null);

          return Promise.resolve();
        },
      }),
    ).toBe(true);
    expect(answers).toEqual(["Não autorizado."]);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("refuses a click without a sender whatever entries the allowlist holds", async (): Promise<void> => {
    const telegram = fakeApi({});
    const mirror = createAskMirror({
      api: telegram.api,
      appDir,
      allowedChats: () => [CHAT, "", "undefined"],
      log: (): void => undefined,
      messages: () => PT,
    });
    const answers: (string | null)[] = [];

    writeAsk([SINGLE]);
    await mirror.tick();

    expect(
      await mirror.handleCallback({
        callbackQuery: { data: `ask:${SHORT}:0:0` },
        answerCallbackQuery: (options): Promise<unknown> => {
          answers.push(options?.text ?? null);

          return Promise.resolve();
        },
      }),
    ).toBe(true);
    expect(answers).toEqual(["Não autorizado."]);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("confirms the delivery to the sender when the click has no chat", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback({
      callbackQuery: { data: `ask:${SHORT}:0:0` },
      from: { id: Number(CHAT) },
      answerCallbackQuery: (): Promise<unknown> => Promise.resolve(),
    });

    expect(telegram.sent.at(-1)).toMatchObject({
      chatId: CHAT,
      text: "✅ Respostas entregues: a pergunta do terminal foi respondida com elas.",
    });
  });
});

describe("typed answers the mirror takes", () => {
  it("ignores a typed message while the question waits for buttons", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(false);
  });

  it("ignores a typed message for a question not sent yet", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(false);
  });

  it("ignores a typed answer whose question record became unreadable", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    writeFileSync(join(asksDir(), `${ASK_ID}.json`), "{ not json");

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(false);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("a button answer to the question waiting for a typed one ends the wait", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(false);
  });

  it("a button answer to another question keeps the wait for the typed one", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(await mirror.consumeText(CHAT, "Mobile")).toBe(true);
    expect(readAnswers()).toEqual({
      "Qual banco?": "Postgres",
      "Quais camadas?": "Mobile",
    });
  });

  it("a typed answer after the terminal answered writes nothing for the terminal", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(true);
    expect(existsSync(answerFile())).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(
      "✍️ Escreva aqui a resposta da pergunta 1 [Banco].",
    );
  });
});
