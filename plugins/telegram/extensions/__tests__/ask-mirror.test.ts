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

interface ForceReply {
  force_reply: true;
}

interface SendOptions {
  reply_markup?: Markup | ForceReply;
  parse_mode?: "HTML";
}

interface SentMessage {
  chatId: string;
  text: string;
  parseMode: string | undefined;
  keyboard: Markup["inline_keyboard"] | undefined;
  forceReply: boolean;
  messageId: number;
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
  released?: unknown;
}

interface SetupOptions {
  messages?: () => Messages;
  rejectSend?: (text: string, chatId: string) => boolean;
  failEdit?: boolean;
  failDelete?: boolean;
}

interface DeletedMessage {
  chatId: string;
  messageId: number;
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
  failDelete = false,
}: Pick<SetupOptions, "rejectSend" | "failEdit" | "failDelete">): {
  sent: SentMessage[];
  edits: EditedMarkup[];
  deleted: DeletedMessage[];
  api: {
    deleteMessage: (chatId: string, messageId: number) => Promise<unknown>;
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
  const deleted: DeletedMessage[] = [];
  let nextMessageId = 100;

  return {
    sent,
    edits,
    deleted,
    api: {
      deleteMessage: (chatId, messageId): Promise<unknown> => {
        if (failDelete) return Promise.reject(new Error("boom"));

        deleted.push({ chatId, messageId });

        return Promise.resolve(true);
      },
      sendMessage: (chatId, text, options): Promise<{ message_id: number }> => {
        if (rejectSend(text, chatId)) return Promise.reject(new Error("boom"));

        const markup = options?.reply_markup;

        nextMessageId += 1;
        sent.push({
          chatId,
          text,
          parseMode: options?.parse_mode,
          keyboard:
            markup && "inline_keyboard" in markup
              ? markup.inline_keyboard
              : undefined,
          forceReply:
            markup !== undefined &&
            "force_reply" in markup &&
            markup.force_reply,
          messageId: nextMessageId,
        });

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
  {
    dueAt = 0,
    context = null,
    instance = null,
    released = undefined,
  }: AskOptions = {},
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
      ...(released === undefined ? {} : { released }),
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

  it("keeps the question sent to the other chats when one chat refuses it", async (): Promise<void> => {
    const blockedChat = "222";
    const telegram = fakeApi({
      rejectSend: (_text, chatId) => chatId === blockedChat,
    });
    const logs: string[] = [];
    const mirror = createAskMirror({
      api: telegram.api,
      appDir,
      allowedChats: () => [blockedChat, CHAT],
      log: (message) => logs.push(message),
      messages: () => PT,
    });

    writeAsk([SINGLE], { context: "Comparei Postgres e Redis." });
    await mirror.tick();
    await mirror.tick();

    const tap = callback(`ask:${SHORT}:0:1`);

    await mirror.handleCallback(tap.ctx);

    expect(
      telegram.sent
        .filter((message) => message.keyboard !== undefined)
        .map((message) => message.chatId),
    ).toEqual([CHAT]);
    expect(logs.slice(0, 2)).toEqual([
      PT_TEXTS.logCycleFailed,
      PT.askSent(ASK_ID, "telegram"),
    ]);
    expect(tap.answers).toEqual([null]);
    expect(readAnswers()).toEqual({ "Qual banco?": "Redis" });
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

  it("sends a released question during quiet hours and keeps holding a due one not released", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ quietHours: { start: "14:00", end: "16:00" } }),
    );
    writeAsk([SINGLE], { dueAt: Date.now() - 1000 });
    await mirror.tick();

    expect(telegram.sent.length).toBe(0);

    writeAsk([SINGLE], { dueAt: Date.now(), released: true });
    await mirror.tick();

    expect(telegram.sent.map(({ text }) => text)).toEqual([
      expect.stringContaining("Qual banco?"),
    ]);
  });

  it("does not treat a released flag other than true as a release", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ quietHours: { start: "14:00", end: "16:00" } }),
    );
    writeAsk([SINGLE], { dueAt: Date.now(), released: "yes" });
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
    expect(
      await mirror.consumeText(CHAT, "MySQL", otherPromptId(telegram, 1)),
    ).toBe(true);
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

describe("questions held", () => {
  it("counts the unsent questions that are due, released or with the conversation on Telegram", (): void => {
    const { mirror } = setup();

    writeAskWithId("due-1", Date.now());
    writeAsk([SINGLE], { dueAt: Date.now() + 60_000, released: true });

    expect(mirror.held()).toBe(2);

    writeAsk([SINGLE], { dueAt: Date.now() + 60_000 });

    expect(mirror.held()).toBe(1);

    writeTimestamp("last-inbound", Date.now() - 1000);

    expect(mirror.held()).toBe(2);
  });

  it("leaves out the questions already sent, closed, expired or unreadable", async (): Promise<void> => {
    const { mirror } = setup();

    writeAskWithId("sent-1", Date.now());
    await mirror.tick();
    writeAskWithId("closed-1", Date.now());
    writeFileSync(join(asksDir(), "closed-1.closed"), "");
    writeAskWithId("old-1", Date.now() - 24 * 60 * 60 * 1000 - 1);
    writeFileSync(join(asksDir(), "broken-1.json"), "{not json");

    expect(mirror.held()).toBe(0);
  });

  it("holds nothing without an asks folder", (): void => {
    expect(setup().mirror.held()).toBe(0);
  });
});

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

  it("logs the failed cycle and sends again in the next one when the sent state cannot be saved", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup();

    writeAsk([SINGLE]);
    mkdirSync(sentStateFile());
    await mirror.tick();

    expect(telegram.sent.length).toBe(1);
    expect(logs).toEqual([
      PT.askCycleFailed(
        `Error: EISDIR: illegal operation on a directory, open '${sentStateFile()}'`,
      ),
    ]);

    rmSync(sentStateFile(), { recursive: true });
    await mirror.tick();

    expect(telegram.sent.length).toBe(2);
    expect(JSON.parse(readFileSync(sentStateFile(), "utf8"))).toMatchObject({
      shortId: SHORT,
      messages: [{ chatId: CHAT, questionIndex: 0, messageId: 102 }],
    });
    expect(logs.at(-1)).toBe(PT.askSent(ASK_ID, "telegram"));
  });
});

describe("clicks whose acknowledgment Telegram refuses", () => {
  it("still writes the answer of a valid click", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    const click = rejectingCallback(`ask:${SHORT}:0:1`);

    expect(await mirror.handleCallback(click.ctx)).toBe(true);
    expect(click.calls.count).toBe(1);
    expect(readAnswers()).toEqual({ "Qual banco?": "Redis" });
    expect(telegram.edits.at(-1)?.keyboard).toEqual([
      [{ text: "✅ Redis", callback_data: "ask:answered" }],
    ]);
  });

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
  it("goes to the ask whose prompt the reply quotes", async (): Promise<void> => {
    const { telegram, mirror } = setup();
    const older = "s1-1000";
    const newer = "s2-2000";

    writeAskWithId(older, Date.now() - 1000);
    writeAskWithId(newer, Date.now());
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${shortIdFor(older)}:0:o`).ctx);
    const olderPrompt = otherPromptId(telegram, 1);

    await mirror.handleCallback(callback(`ask:${shortIdFor(newer)}:0:o`).ctx);

    expect(await mirror.consumeText(CHAT, "MySQL", olderPrompt)).toBe(true);
    expect(existsSync(join(asksDir(), `${older}.answer.json`))).toBe(true);
    expect(existsSync(join(asksDir(), `${newer}.answer.json`))).toBe(false);
  });

  it("sends a loose text to the channel with one notice for the newest ask waiting", async (): Promise<void> => {
    const { telegram, mirror } = setup();
    const older = "s1-1000";
    const newer = "s2-2000";

    writeAskWithId(older, Date.now() - 1000);
    writeAskWithId(newer, Date.now());
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${shortIdFor(older)}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${shortIdFor(newer)}:0:o`).ctx);
    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore + 1);
    expect(telegram.sent.at(-1)?.text.startsWith("ℹ️")).toBe(true);
    expect(existsSync(join(asksDir(), `${newer}.answer.json`))).toBe(false);
    expect(existsSync(join(asksDir(), `${older}.answer.json`))).toBe(false);
  });
});

const SEASON: AskQuestion = {
  question: "Qual estação?",
  header: "Estação",
  options: [{ label: "Verão" }, { label: "Inverno" }],
};
const ANIMAL: AskQuestion = {
  question: "Qual animal?",
  header: "Animal",
  options: [{ label: "Cão" }, { label: "Gato" }],
};

function otherPromptId(
  telegram: ReturnType<typeof fakeApi>,
  questionNumber: number,
): number {
  const prompt = telegram.sent.findLast((message) =>
    new RegExp(`pergunta ${questionNumber}[ .]`).test(message.text),
  );

  return prompt?.messageId ?? -1;
}

describe("typed answer of a multiple choice question", () => {
  it("keeps the question open with the typed text marked until done", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(
      await mirror.consumeText(CHAT, " Mobile ", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(existsSync(answerFile())).toBe(false);
    expect(telegram.edits.at(-1)?.keyboard[2][0]).toEqual({
      text: "☑️ ✍️ Mobile",
      callback_data: `ask:${SHORT}:0:o`,
    });
    expect(telegram.edits.at(-1)?.keyboard[0][0].text).toBe("☑️ 1. Backend");

    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(readAnswers()).toEqual({
      "Quais camadas?": "Backend, Frontend, Mobile",
    });
  });

  it("keeps only the options still marked when one was unmarked after the typed text", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "Mobile", otherPromptId(telegram, 1));
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(readAnswers()).toEqual({ "Quais camadas?": "Frontend, Mobile" });
  });

  it("replaces the typed text when the other answer is written again", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "Mobile", otherPromptId(telegram, 1));
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "Infra", otherPromptId(telegram, 1));

    expect(telegram.edits.at(-1)?.keyboard[2][0].text).toBe("☑️ ✍️ Infra");

    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(readAnswers()).toEqual({ "Quais camadas?": "Infra" });
  });

  it("shows the replaced typed text in the prompt when Other is tapped again", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(telegram.sent.at(-1)?.text).not.toContain("🔁");

    await mirror.consumeText(CHAT, "Mobile", otherPromptId(telegram, 1));
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(telegram.sent.at(-1)?.text).toBe(
      "✍️ Escreva aqui a resposta da pergunta 1.\n🔁 Substitui a resposta escrita antes: “Mobile”.",
    );
  });

  it("ignores a typed text that is only spaces in a multiple choice", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "   ", otherPromptId(telegram, 1));
    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(existsSync(answerFile())).toBe(false);
  });

  it("answers a single choice question with the typed text alone", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "  MySQL  ", otherPromptId(telegram, 1));

    expect(readAnswers()).toEqual({ "Qual banco?": "MySQL" });
  });
});

describe("typed answer to the question it replies to", () => {
  it("asks for the typed answer as a forced reply, so Telegram quotes the question being answered", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(telegram.sent.at(-1)).toMatchObject({
      text: "✍️ Escreva aqui a resposta da pergunta 1 [Banco].",
      forceReply: true,
      keyboard: undefined,
    });
  });

  it("sends each reply to its own question when two wait for text, and none to the channel", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);

    expect(
      await mirror.consumeText(CHAT, "inverno", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(
      await mirror.consumeText(CHAT, "gato", otherPromptId(telegram, 2)),
    ).toBe(true);
    expect(readAnswers()).toEqual({
      "Qual estação?": "inverno",
      "Qual animal?": "gato",
    });
  });

  it("sends a reply to the question message to the channel, with a notice about the prompt", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);

    const seasonMessage = telegram.sent.find((message) =>
      message.text.includes("Qual estação?"),
    );

    expect(
      await mirror.consumeText(CHAT, "inverno", seasonMessage?.messageId),
    ).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(
      "ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta 1 [Estação] com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.",
    );
    expect(existsSync(answerFile())).toBe(false);

    await mirror.consumeText(CHAT, "gato", otherPromptId(telegram, 2));
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

    expect(readAnswers()).toEqual({
      "Qual estação?": "Inverno",
      "Qual animal?": "gato",
    });
  });

  it("sends the notice on every reply to the question message, Other tapped or not", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();

    const seasonMessage = telegram.sent.find((message) =>
      message.text.includes("Qual estação?"),
    );
    const notice =
      "ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta 1 [Estação] com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.";

    expect(
      await mirror.consumeText(CHAT, "inverno", seasonMessage?.messageId),
    ).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(notice);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "inverno", seasonMessage?.messageId);
    const sentBefore = telegram.sent.length;

    expect(
      await mirror.consumeText(CHAT, "inverno", seasonMessage?.messageId),
    ).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore + 1);
    expect(telegram.sent.at(-1)?.text).toBe(notice);
  });

  it("sends a reply to the message of an answered question to the channel without a notice", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

    const seasonMessage = telegram.sent.find((message) =>
      message.text.includes("Qual estação?"),
    );
    const sentBefore = telegram.sent.length;

    expect(
      await mirror.consumeText(CHAT, "verão", seasonMessage?.messageId),
    ).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore);
  });

  it("sends a loose text to the channel with one notice for the newest when two questions wait", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);

    expect(await mirror.consumeText(CHAT, "gato")).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(
      "ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta 2 [Animal] com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.",
    );

    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(CHAT, "inverno")).toBe(false);
    expect(
      telegram.sent
        .slice(sentBefore)
        .filter(({ text }) => text.startsWith("ℹ️")).length,
    ).toBe(1);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("sends a loose text with one notice, then none, when one question waits", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(CHAT, "gato")).toBe(false);
    expect(telegram.sent.slice(sentBefore).map(({ text }) => text)).toEqual([
      "ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta 2 [Animal] com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.",
    ]);
    expect(await mirror.consumeText(CHAT, "gato")).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore + 1);
  });

  it("answers with the quoted prompt after a loose text lost the wait only when Other is tapped again", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "oi");
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(
      await mirror.consumeText(CHAT, "MySQL", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(readAnswers()).toEqual({ "Qual banco?": "MySQL" });
  });

  it("warns and keeps the text off the channel when the reply quotes a request Telegram kept for an answered question", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);
    const prompt = otherPromptId(telegram, 1);

    expect(await mirror.consumeText(CHAT, "verão", prompt)).toBe(true);
    expect(telegram.sent.at(-1)?.text).toBe(
      "⚠️ A pergunta 1 [Estação] já foi respondida com Inverno; este texto não foi usado.",
    );
    expect(existsSync(answerFile())).toBe(false);
  });

  it("lets a reply to an unrelated message reach the channel when no question waits for text", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    expect(await mirror.consumeText(CHAT, "oi", 7)).toBe(false);
  });

  it("keeps one wait and one notice when Other is tapped twice on the same question", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(CHAT, "gato")).toBe(false);
    expect(await mirror.consumeText(CHAT, "gato")).toBe(false);
    expect(
      telegram.sent.slice(sentBefore).map(({ text }) => text.slice(0, 2)),
    ).toEqual(["ℹ️"]);
  });

  it("does not take a reply from another chat that carries the same message id", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(
      await mirror.consumeText("77", "MySQL", otherPromptId(telegram, 1)),
    ).toBe(false);
    expect(existsSync(answerFile())).toBe(false);
  });

  it("logs, without failing, when Telegram refuses the notice about the prompt", async (): Promise<void> => {
    const { mirror, logs } = setup({
      rejectSend: (text) => text.startsWith("ℹ️"),
    });

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);

    expect(await mirror.consumeText(CHAT, "gato")).toBe(false);
    expect(logs).toContain("ask: falha ao confirmar no chat: Error: boom");
  });

  it("logs, without failing, when Telegram refuses the warning about an answered question", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup({
      rejectSend: (text) => text.startsWith("⚠️"),
      failDelete: true,
    });

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

    expect(
      await mirror.consumeText(CHAT, "verão", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(logs).toContain("ask: falha ao confirmar no chat: Error: boom");
  });

  it("reads a sent state written without the typed answer lists as nothing waiting", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();

    const { awaitingOther, otherPrompts, ...older } = JSON.parse(
      readFileSync(sentStateFile(), "utf8"),
    ) as Record<string, unknown>;

    expect([awaitingOther, otherPrompts]).toEqual([[], []]);
    writeFileSync(
      sentStateFile(),
      JSON.stringify({ ...older, awaitingOther: 0 }),
    );

    expect(await mirror.consumeText(CHAT, "MySQL")).toBe(false);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const saved = JSON.parse(readFileSync(sentStateFile(), "utf8")) as {
      awaitingOther: unknown[];
      otherPrompts: { questionIndex: number }[];
    };

    expect(saved.awaitingOther).toEqual([0]);
    expect(saved.otherPrompts.map((prompt) => prompt.questionIndex)).toEqual([
      0,
    ]);
    expect(
      await mirror.consumeText(CHAT, "MySQL", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(readAnswers()).toEqual({ "Qual banco?": "MySQL" });
  });

  it("lets a reply to an unrelated message reach the channel without a notice while a question waits", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(CHAT, "oi", 7)).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore);
    expect(
      await mirror.consumeText(CHAT, "MySQL", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(readAnswers()).toEqual({ "Qual banco?": "MySQL" });
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
  awaitingOther: [],
  otherPrompts: [],
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
    const { telegram, mirror } = setup();

    writeAsk([SINGLE, MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(
      await mirror.consumeText(CHAT, "Mobile", otherPromptId(telegram, 2)),
    ).toBe(true);

    await mirror.handleCallback(callback(`ask:${SHORT}:1:d`).ctx);

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

    expect(
      await mirror.consumeText(CHAT, "MySQL", otherPromptId(telegram, 1)),
    ).toBe(true);
    expect(existsSync(answerFile())).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(
      "✍️ Escreva aqui a resposta da pergunta 1 [Banco].",
    );
  });
});

describe("questions waiting for text", () => {
  const noticeFor = (questionNumber: number, header: string): string =>
    `ℹ️ Isso foi como mensagem para o Claude. Para responder a pergunta ${questionNumber} [${header}] com texto, toque de novo em “✍️ Outra resposta” e responda citando o pedido.`;

  it("keeps waiting for the other question when a button answers one", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:1`).ctx);

    expect(await mirror.consumeText(CHAT, "solto")).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(noticeFor(2, "Animal"));
  });

  it("keeps waiting for the other question when a typed text marks a multiple choice", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI, SEASON]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "Mobile", otherPromptId(telegram, 1));

    expect(await mirror.consumeText(CHAT, "solto")).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(noticeFor(2, "Estação"));
  });

  it("marks nothing in a multiple choice for a typed text of spaces", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.consumeText(CHAT, "   ", otherPromptId(telegram, 1));

    expect(telegram.edits.at(-1)?.keyboard[2][0].text).toBe(PT.otherButton);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(readAnswers()).toEqual({ "Quais camadas?": "Backend" });
  });

  it("sends nothing to a chat that did not get the Other request and keeps it waiting", async (): Promise<void> => {
    const { telegram, mirror } = setup();
    const groupChat = "-100222222";

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(groupChat, "solto")).toBe(false);
    expect(telegram.sent).toHaveLength(sentBefore);

    expect(await mirror.consumeText(CHAT, "solto")).toBe(false);
    expect(telegram.sent.slice(sentBefore)).toMatchObject([
      { chatId: CHAT, text: noticeFor(1, "Banco") },
    ]);
  });

  it("sends the notice of the question whose Other request reached the chat", async (): Promise<void> => {
    const otherChat = 7;
    const telegram = fakeApi({});
    const mirror = createAskMirror({
      api: telegram.api,
      appDir,
      allowedChats: () => [CHAT, String(otherChat)],
      log: (): void => undefined,
      messages: () => PT,
    });

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`, otherChat).ctx);

    expect(await mirror.consumeText(CHAT, "solto")).toBe(false);
    expect(telegram.sent.at(-1)).toMatchObject({
      chatId: CHAT,
      text: noticeFor(2, "Animal"),
    });
  });

  it("sends the notice for the newest ask when two asks wait for text", async (): Promise<void> => {
    const { telegram, mirror } = setup();
    const newest = "s2-9000";

    writeAsk([SEASON]);
    writeAskWithId(newest, Date.now() + 1000);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${shortIdFor(newest)}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    expect(await mirror.consumeText(CHAT, "solto")).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(noticeFor(1, "Banco"));
  });

  it("counts a question at the age limit and one due at this very moment", (): void => {
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      vi.setSystemTime(new Date(2026, 10, 15, 12, 0));

      const { mirror } = setup();

      writeAskWithId("edge-1", Date.now() - 24 * 60 * 60 * 1000);
      writeAsk([SINGLE], { dueAt: Date.now() });

      expect(mirror.held()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Other requests left without a reply", () => {
  function closeInTerminal(): void {
    writeFileSync(join(asksDir(), `${ASK_ID}.closed`), "");
  }

  it("deletes the request when a button answers the question", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(telegram.deleted).toEqual([{ chatId: CHAT, messageId: request }]);
    expect(readAnswers()).toEqual({ "Qual banco?": "Postgres" });
  });

  it("deletes the previous request when Other is tapped again, and the new one once its reply is taken", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const first = otherPromptId(telegram, 1);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const second = otherPromptId(telegram, 1);

    expect(telegram.deleted).toEqual([{ chatId: CHAT, messageId: first }]);
    expect(await mirror.consumeText(CHAT, "MySQL", second)).toBe(true);
    expect(telegram.deleted).toEqual([
      { chatId: CHAT, messageId: first },
      { chatId: CHAT, messageId: second },
    ]);
    expect(readAnswers()).toEqual({ "Qual banco?": "MySQL" });
  });

  it("deletes the request replied to in a multiple choice as soon as the typed text is taken", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const replied = otherPromptId(telegram, 1);

    await mirror.consumeText(CHAT, "Mobile", replied);

    expect(telegram.deleted).toEqual([{ chatId: CHAT, messageId: replied }]);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const unanswered = otherPromptId(telegram, 1);

    await mirror.handleCallback(callback(`ask:${SHORT}:0:d`).ctx);

    expect(telegram.deleted).toEqual([
      { chatId: CHAT, messageId: replied },
      { chatId: CHAT, messageId: unanswered },
    ]);
    expect(readAnswers()).toEqual({ "Quais camadas?": "Mobile" });
  });

  it("keeps the requests of the other questions while one is answered", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(telegram.deleted).toEqual([]);
  });

  it("deletes the requests of the open questions when the terminal answers", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SEASON, ANIMAL]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const season = otherPromptId(telegram, 1);

    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);

    const animal = otherPromptId(telegram, 2);

    closeInTerminal();
    await mirror.tick();

    expect(telegram.deleted).toEqual([
      { chatId: CHAT, messageId: season },
      { chatId: CHAT, messageId: animal },
    ]);
    expect(readdirSync(asksDir())).toEqual([]);
  });

  it("deletes the request of a question that expired", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1);
    await mirror.tick();

    expect(telegram.deleted).toEqual([{ chatId: CHAT, messageId: request }]);
  });

  it("logs a request it could not delete and still records the answer", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup({ failDelete: true });

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:0:0`).ctx);

    expect(telegram.deleted).toEqual([]);
    expect(logs).toContain(PT.askDeleteFailed("Error: boom"));
    expect(readAnswers()).toEqual({ "Qual banco?": "Postgres" });
  });

  it("warns that the question is closed on a reply to a request that stayed, and sends the text to the channel", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    closeInTerminal();
    await mirror.tick();

    expect(await mirror.consumeText(CHAT, "teste 3", request)).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(PT.otherQuestionClosed(1, "Banco"));
    expect(readdirSync(asksDir())).toEqual([]);
  });

  it("warns that the question is closed on a second reply to a request Telegram kept after it answered", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    await mirror.consumeText(CHAT, "MySQL", request);

    expect(await mirror.consumeText(CHAT, "Oracle", request)).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(PT.otherQuestionClosed(1, "Banco"));

    closeInTerminal();
    await mirror.tick();

    expect(await mirror.consumeText(CHAT, "SQLite", request)).toBe(false);
    expect(telegram.sent.at(-1)?.text).toBe(PT.otherQuestionClosed(1, "Banco"));
  });

  it("forgets the requests of closed questions after the 48 hours Telegram allows deleting them", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    closeInTerminal();
    await mirror.tick();
    vi.setSystemTime(Date.now() + 48 * 60 * 60 * 1000);

    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText(CHAT, "tarde", request)).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore + 1);

    vi.setSystemTime(Date.now() + 1);

    expect(await mirror.consumeText(CHAT, "tarde", request)).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore + 1);
  });

  it("gives no notice for the same message id in another chat", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    closeInTerminal();
    await mirror.tick();

    const sentBefore = telegram.sent.length;

    expect(await mirror.consumeText("99", "outro chat", request)).toBe(false);
    expect(telegram.sent.length).toBe(sentBefore);
  });

  it("drops invalid and expired entries when it records a closed request", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });
    const file = join(appDir, "closed-other-requests.json");
    const valid = {
      chatId: CHAT,
      messageId: 7,
      questionNumber: 2,
      header: null,
      closedAt: Date.now(),
    };

    writeFileSync(
      file,
      JSON.stringify([
        null,
        5,
        "text",
        { ...valid, chatId: 12 },
        { ...valid, messageId: "7" },
        { ...valid, questionNumber: "2" },
        { ...valid, closedAt: String(Date.now()) },
        {
          ...valid,
          messageId: 8,
          closedAt: Date.now() - 48 * 60 * 60 * 1000 - 1,
        },
        valid,
      ]),
    );
    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    closeInTerminal();
    await mirror.tick();

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      valid,
      {
        chatId: CHAT,
        messageId: otherPromptId(telegram, 1),
        questionNumber: 1,
        header: "Banco",
        closedAt: Date.now(),
      },
    ]);
  });

  it("writes no record of closed requests when no request was open", async (): Promise<void> => {
    const { mirror } = setup();

    writeAsk([SINGLE]);
    await mirror.tick();
    closeInTerminal();
    await mirror.tick();

    expect(existsSync(join(appDir, "closed-other-requests.json"))).toBe(false);
  });

  it("keeps in the state of the ask only the requests of the other questions after a typed text is taken", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([MULTI, SEASON]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    await mirror.handleCallback(callback(`ask:${SHORT}:1:o`).ctx);
    await mirror.consumeText(CHAT, "Mobile", otherPromptId(telegram, 1));

    const state = JSON.parse(readFileSync(sentStateFile(), "utf8")) as {
      otherPrompts: { questionIndex: number; messageId: number }[];
    };

    expect(state.otherPrompts).toEqual([
      { chatId: CHAT, questionIndex: 1, messageId: otherPromptId(telegram, 2) },
    ]);
  });

  it("logs a notice about a closed question that could not be sent", async (): Promise<void> => {
    const { telegram, mirror, logs } = setup({
      failDelete: true,
      rejectSend: (text) => text === PT.otherQuestionClosed(1, "Banco"),
    });

    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);

    const request = otherPromptId(telegram, 1);

    closeInTerminal();
    await mirror.tick();

    expect(await mirror.consumeText(CHAT, "tarde", request)).toBe(false);
    expect(logs).toContain(PT.askConfirmFailed("Error: boom"));
  });

  it("sends a reply to an ask that was not sent yet to the channel without failing", async (): Promise<void> => {
    const { telegram, mirror } = setup();

    writeAsk([SINGLE]);

    expect(await mirror.consumeText(CHAT, "oi", 4242)).toBe(false);
    expect(telegram.sent).toEqual([]);
  });

  it("keeps the record of closed requests in the app folder, private to the user, and survives a broken one", async (): Promise<void> => {
    const { telegram, mirror } = setup({ failDelete: true });

    writeFileSync(join(appDir, "closed-other-requests.json"), "{broken");
    writeAsk([SINGLE]);
    await mirror.tick();
    await mirror.handleCallback(callback(`ask:${SHORT}:0:o`).ctx);
    closeInTerminal();
    await mirror.tick();

    const file = join(appDir, "closed-other-requests.json");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      {
        chatId: CHAT,
        messageId: otherPromptId(telegram, 1),
        questionNumber: 1,
        header: "Banco",
        closedAt: Date.now(),
      },
    ]);
  });
});
