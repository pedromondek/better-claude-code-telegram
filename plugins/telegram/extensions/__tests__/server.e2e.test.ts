import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { shortIdFor } from "../ask-format.ts";
import { MESSAGES } from "../i18n.ts";

const PLUGIN_DIR = join(import.meta.dirname, "..", "..");
const TOKEN = "123:FAKE";
const DEV_ID = 42;
const CHAT_ID = String(DEV_ID);
const DEV = { id: DEV_ID, is_bot: false, first_name: "Dev", username: "dev" };
const BOT = {
  id: 1,
  is_bot: true,
  first_name: "Bot",
  username: "fake_test_bot",
};
const CHAT = { id: DEV_ID, type: "private" };
const ASK_ID = "s1-1000";
const HANDLED_METHODS = new Set([
  "getMe",
  "deleteWebhook",
  "getUpdates",
  "sendMessage",
  "sendChatAction",
  "setMyCommands",
  "answerCallbackQuery",
  "editMessageReplyMarkup",
  "editMessageText",
  "sendPhoto",
  "sendAnimation",
  "sendDocument",
  "deleteMessage",
  "getFile",
]);
const FILE_DOWNLOAD = "FILE_DOWNLOAD";
const VOICE_FILE_PATH = "voice/file_0.oga";
const TRANSCRIPT = "transcribed words";
const SENT_MESSAGE_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendAnimation",
  "sendDocument",
]);

const hasBun =
  spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const hasDeps = existsSync(join(PLUGIN_DIR, "node_modules", "grammy"));
const canRun = hasBun && hasDeps;
const skipNote = canRun
  ? ""
  : " [skipped: needs bun and the plugin dependencies, run bun install in plugins/telegram]";

interface TelegramCall {
  method: string;
  params: Record<string, unknown>;
  messageId?: number;
}

interface FakeTelegram {
  server: Server;
  calls: TelegramCall[];
  unhandled: string[];
  push: (update: Record<string, unknown>) => void;
}

interface Fork {
  stateDir: string;
  appDir: string;
  homeDir: string;
  telegram: FakeTelegram;
  child: ChildProcess;
  mcpMessages: Record<string, unknown>[];
  sentMessages: () => TelegramCall[];
  send: (message: Record<string, unknown>) => void;
  stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);

  return isRecord(parsed) ? parsed : {};
}

function createFakeTelegram(): FakeTelegram {
  const calls: TelegramCall[] = [];
  const unhandled: string[] = [];
  const updates: Record<string, unknown>[] = [];
  let nextUpdateId = 1;
  let nextMessageId = 1000;

  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk: Buffer | string) => {
      body += String(chunk);
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      (async (): Promise<void> => {
        if ((request.url ?? "").startsWith("/file/")) {
          calls.push({ method: FILE_DOWNLOAD, params: {} });
          response.setHeader("content-type", "application/octet-stream");
          response.end("ogg");

          return;
        }

        const method = (request.url ?? "").split("/").pop() ?? "";
        const isJson = (request.headers["content-type"] ?? "").includes("json");
        const params = body && isJson ? parseRecord(body) : {};
        let result: unknown = true;

        calls.push({ method, params });

        if (!HANDLED_METHODS.has(method)) {
          unhandled.push(method);
          response.statusCode = 500;
          response.end(JSON.stringify({ ok: false, description: method }));

          return;
        }

        if (method === "getMe") result = BOT;

        if (method === "getFile") {
          result = {
            file_id: params.file_id,
            file_unique_id: "voice-unique",
            file_path: VOICE_FILE_PATH,
          };
        }

        if (method === "getUpdates") {
          const deadline = Date.now() + 300;

          while (updates.length === 0 && Date.now() < deadline) {
            await sleep(20);
          }

          result = updates.splice(0);
        }

        if (SENT_MESSAGE_METHODS.has(method)) {
          nextMessageId += 1;
          calls[calls.length - 1].messageId = nextMessageId;
          result = {
            message_id: nextMessageId,
            date: 0,
            chat: CHAT,
            from: BOT,
            text: params.text,
          };
        }

        response.end(JSON.stringify({ ok: true, result }));
      })().catch((error: unknown) => {
        unhandled.push(String(error));
        response.statusCode = 500;
        response.end(JSON.stringify({ ok: false, description: String(error) }));
      });
    });
  });

  return {
    server,
    calls,
    unhandled,
    push(update): void {
      updates.push({ update_id: nextUpdateId, ...update });
      nextUpdateId += 1;
    },
  };
}

async function waitFor<T>(
  check: () => T | null | undefined | false,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = check();

    if (value) return value;

    await sleep(50);
  }

  throw new Error(`Timed out waiting for: ${description}`);
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return parseRecord(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function startFork(
  config: Record<string, unknown> | null,
): Promise<Fork> {
  const stateDir = mkdtempSync(join(tmpdir(), "bcct-state-"));
  const homeDir = mkdtempSync(join(tmpdir(), "bcct-home-"));
  const appDir = join(homeDir, ".claude", "better-claude-code-telegram");

  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(stateDir, "access.json"),
    JSON.stringify({
      dmPolicy: "allowlist",
      allowFrom: [CHAT_ID],
      groups: {},
      pending: {},
    }),
  );

  if (config) {
    writeFileSync(
      join(appDir, "better-cc-telegram.json"),
      JSON.stringify(config),
    );
  }

  const telegram = createFakeTelegram();

  await new Promise<void>((resolve) => {
    telegram.server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = telegram.server.address() as AddressInfo;
  const child = spawn("bun", ["server.ts"], {
    cwd: PLUGIN_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      BETTER_CC_TELEGRAM: "1",
      TELEGRAM_STATE_DIR: stateDir,
      BETTER_CC_TELEGRAM_DIR: appDir,
      TELEGRAM_BOT_TOKEN: TOKEN,
      BETTER_CC_TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const mcpMessages: Record<string, unknown>[] = [];
  let buffer = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;

    const lines = buffer.split("\n");

    buffer = lines.pop() ?? "";

    for (const line of lines.filter(Boolean)) {
      mcpMessages.push(parseRecord(line));
    }
  });

  const send = (message: Record<string, unknown>): void => {
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  await waitFor(
    () => mcpMessages.find((message) => message.id === 1),
    "initialize",
  );
  send({ method: "notifications/initialized" });
  await waitFor(
    () => readJsonFile(join(appDir, "health.json"))?.polling,
    "the fork to mark the bot as polling",
  );

  return {
    stateDir,
    appDir,
    homeDir,
    telegram,
    child,
    mcpMessages,
    sentMessages: (): TelegramCall[] =>
      telegram.calls.filter((call) => call.method === "sendMessage"),
    send,
    async stop(): Promise<void> {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        telegram.server.close(() => {
          resolve();
        });
      });
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

function writeAsk(
  stateDir: string,
  id = ASK_ID,
  titles = ["Which database?"],
): void {
  mkdirSync(join(stateDir, "asks"), { recursive: true });
  writeFileSync(
    join(stateDir, "asks", `${id}.json`),
    JSON.stringify({
      id,
      sessionId: "s1",
      createdAt: Date.now(),
      dueAt: 0,
      instance: "back-s3",
      context: "I compared the databases.",
      questions: titles.map((question) => ({
        question,
        options: [{ label: "Postgres" }, { label: "Redis" }],
      })),
    }),
  );
}

function pushDevReply(fork: Fork, text: string, repliedText: string): void {
  fork.telegram.push({
    message: {
      message_id: 7,
      date: Math.floor(Date.now() / 1000),
      chat: CHAT,
      from: DEV,
      text,
      reply_to_message: {
        message_id: 6,
        date: 0,
        chat: CHAT,
        from: BOT,
        text: repliedText,
      },
    },
  });
}

function channelContents(fork: Fork): unknown[] {
  return fork.mcpMessages
    .filter((message) => message.method === "notifications/claude/channel")
    .map((message) =>
      isRecord(message.params) ? message.params.content : null,
    );
}

function pushVoice(fork: Fork, chat: Record<string, unknown>): void {
  fork.telegram.push({
    message: {
      message_id: 50,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: DEV,
      voice: {
        file_id: "voice-1",
        file_unique_id: "voice-unique",
        duration: 2,
        mime_type: "audio/ogg",
        file_size: 3,
      },
    },
  });
}

function pushDevText(fork: Fork, text: string): void {
  fork.telegram.push({
    message: {
      message_id: 51,
      date: Math.floor(Date.now() / 1000),
      chat: CHAT,
      from: DEV,
      text,
    },
  });
}

function writeFakeWhisper(fork: Fork): () => number {
  const binDir = join(fork.appDir, "whisper", "venv", "bin");
  const marker = join(fork.homeDir, "whisper-calls");

  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "python"),
    `#!/bin/sh\necho call >> '${marker}'\necho '{"text": "${TRANSCRIPT}"}'\n`,
    { mode: 0o755 },
  );

  return (): number =>
    existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
      : 0;
}

async function waitForChannelContent(fork: Fork): Promise<unknown> {
  const notification = await waitFor(
    () =>
      fork.mcpMessages.find(
        (message) => message.method === "notifications/claude/channel",
      ),
    "the channel notification",
  );

  return isRecord(notification.params) ? notification.params.content : null;
}

describe.skipIf(!canRun)(
  `Telegram fork end to end in pt-br (server.ts against a fake Telegram API)${skipNote}`,
  () => {
    let fork: Fork;

    beforeAll(async (): Promise<void> => {
      fork = await startFork({ language: "pt-br" });
    }, 60_000);

    afterAll(async (): Promise<void> => {
      await fork?.stop();
    });

    it("keeps the config, the questions, the pings and the health out of the folder of the bot token", (): void => {
      expect(readdirSync(fork.stateDir).toSorted()).toEqual([
        "access.json",
        "bot.pid",
      ]);
      expect(readdirSync(fork.appDir)).toEqual(
        expect.arrayContaining(["asks", "pings", "health.json"]),
      );
    });

    it("sends a gif and an mp4 as animations and a png as a photo", async (): Promise<void> => {
      const folder = mkdtempSync(join(tmpdir(), "bcct-files-"));
      const files = ["demo.gif", "demo.mp4", "print.png"].map((name) => {
        const path = join(folder, name);

        writeFileSync(path, "x");

        return path;
      });
      const before = fork.telegram.calls.length;

      fork.send({
        id: 20,
        method: "tools/call",
        params: {
          name: "reply",
          arguments: { chat_id: CHAT_ID, text: "arquivos", files },
        },
      });
      await waitFor(
        () => fork.mcpMessages.find((message) => message.id === 20),
        "the reply result",
      );
      rmSync(folder, { recursive: true, force: true });

      expect(
        fork.telegram.calls
          .slice(before)
          .map(({ method }) => method)
          .filter((method) => SENT_MESSAGE_METHODS.has(method)),
      ).toEqual(["sendMessage", "sendAnimation", "sendAnimation", "sendPhoto"]);
      expect(fork.telegram.unhandled).toEqual([]);
    });

    it("tells Claude in the reply tool that a gif and an mp4 go as animations", async (): Promise<void> => {
      fork.send({ id: 21, method: "tools/list" });

      const tools = JSON.stringify(
        await waitFor(
          () => fork.mcpMessages.find((message) => message.id === 21),
          "the tools list",
        ),
      );

      expect(tools).toContain(
        ".jpg/.jpeg/.png/.webp send as photos (inline preview), .gif and .mp4 as animations; other types as documents.",
      );
    });

    it("tells Claude to write to the user in the language of the config", (): void => {
      const initialize = fork.mcpMessages.find((message) => message.id === 1);
      const result = isRecord(initialize?.result) ? initialize.result : {};

      expect(String(result.instructions)).toContain(
        `in ${MESSAGES["pt-br"].languageName} (the setup language)`,
      );
    });

    it("mirrors the AskUserQuestion and records the button answer", async (): Promise<void> => {
      writeAsk(fork.appDir);

      const question = await waitFor(
        () => fork.sentMessages().find((call) => call.params.reply_markup),
        "the question with buttons",
      );

      expect(question.params.parse_mode).toBe("HTML");
      expect(question.params.chat_id).toBe(CHAT_ID);
      expect(
        String(question.params.text).startsWith(
          "❓ Pergunta aberta no terminal de [back-s3]",
        ),
      ).toBe(true);

      fork.telegram.push({
        callback_query: {
          id: "cb1",
          from: DEV,
          chat_instance: "x",
          data: `ask:${shortIdFor(ASK_ID)}:0:1`,
          message: { message_id: 1, date: 0, chat: CHAT, text: "question" },
        },
      });

      const answers = await waitFor(
        () =>
          readJsonFile(join(fork.appDir, "asks", `${ASK_ID}.answer.json`))
            ?.answers,
        "the answer file",
      );

      expect(answers).toEqual({ "Which database?": "Redis" });
    });

    it("takes the dev reply to the Other prompt as the typed answer, keeping it off the channel", async (): Promise<void> => {
      const otherAskId = "s2-2000";
      const sentBefore = fork.sentMessages().length;

      writeAsk(fork.appDir, otherAskId, ["Which database?", "Which cache?"]);
      await waitFor(
        () =>
          fork
            .sentMessages()
            .slice(sentBefore)
            .filter((call) => call.params.reply_markup)
            .at(1),
        "the two new questions with buttons",
      );

      for (const questionIndex of [0, 1]) {
        fork.telegram.push({
          callback_query: {
            id: `cb-other-${questionIndex}`,
            from: DEV,
            chat_instance: "x",
            data: `ask:${shortIdFor(otherAskId)}:${questionIndex}:o`,
            message: { message_id: 1, date: 0, chat: CHAT, text: "question" },
          },
        });
      }

      const prompt = await waitFor(
        () =>
          fork
            .sentMessages()
            .find((call) =>
              String(call.params.text).startsWith(
                "✍️ Escreva aqui a resposta da pergunta 1",
              ),
            ),
        "the prompt of the first other answer",
      );

      const secondPrompt = await waitFor(
        () =>
          fork
            .sentMessages()
            .find((call) =>
              String(call.params.text).startsWith(
                "✍️ Escreva aqui a resposta da pergunta 2",
              ),
            ),
        "the prompt of the second other answer",
      );

      fork.telegram.push({
        message: {
          message_id: 40,
          date: Math.floor(Date.now() / 1000),
          chat: CHAT,
          from: DEV,
          text: "MySQL",
          reply_to_message: {
            message_id: prompt.messageId,
            date: 0,
            chat: CHAT,
            from: BOT,
            text: String(prompt.params.text),
          },
        },
      });

      fork.telegram.push({
        message: {
          message_id: 41,
          date: Math.floor(Date.now() / 1000),
          chat: CHAT,
          from: DEV,
          text: "Memcached",
          reply_to_message: {
            message_id: secondPrompt.messageId,
            date: 0,
            chat: CHAT,
            from: BOT,
            text: String(secondPrompt.params.text),
          },
        },
      });

      const answers = await waitFor(
        () =>
          readJsonFile(join(fork.appDir, "asks", `${otherAskId}.answer.json`))
            ?.answers,
        "the typed answer file",
      );

      expect(answers).toEqual({
        "Which database?": "MySQL",
        "Which cache?": "Memcached",
      });
      expect(
        fork.mcpMessages.some((message) =>
          JSON.stringify(message).includes("MySQL"),
        ),
      ).toBe(false);
    });

    it("delivers to Claude the dev message with the text it replied to", async (): Promise<void> => {
      pushDevReply(fork, "pode seguir", "Preciso do ok.");

      expect(await waitForChannelContent(fork)).toBe(
        "↩️ Em resposta à mensagem do Claude:\n«Preciso do ok.»\n\npode seguir",
      );
    });

    it("sends the permission request right away while the conversation is on Telegram", async (): Promise<void> => {
      fork.send({
        method: "notifications/claude/channel/permission_request",
        params: {
          request_id: "abcde",
          tool_name: "Bash",
          description: "lists files",
          input_preview: "{}",
        },
      });

      const request = await waitFor(
        () =>
          fork
            .sentMessages()
            .find((call) => call.params.text === "🔐 Permission: Bash"),
        "the permission request",
      );

      expect(request.params.chat_id).toBe(CHAT_ID);
    });

    it("sends the waiting notice of another instance", async (): Promise<void> => {
      mkdirSync(join(fork.appDir, "pings"), { recursive: true });
      writeFileSync(
        join(fork.appDir, "pings", "s9.json"),
        JSON.stringify({
          sessionId: "s9",
          createdAt: Date.now() - 180_000,
          dueAt: Date.now(),
          text: "Preciso que você aprove o plano.",
          instance: "front-s3",
        }),
      );

      const ping = await waitFor(
        () =>
          fork
            .sentMessages()
            .find((call) => String(call.params.text).includes("[front-s3]")),
        "the waiting notice",
      );

      expect(String(ping.params.text)).toContain(
        "A instância [front-s3] do Claude está esperando você no terminal há mais de",
      );
      expect(String(ping.params.text)).toContain(
        "Preciso que você aprove o plano.",
      );
    });

    it("deletes the Other request when a button answers the question, so Telegram stops quoting it", async (): Promise<void> => {
      const askId = "s3-3000";
      const sentBefore = fork.sentMessages().length;
      const tap = (data: string): void => {
        fork.telegram.push({
          callback_query: {
            id: `cb-${data}`,
            from: DEV,
            chat_instance: "x",
            data,
            message: { message_id: 1, date: 0, chat: CHAT, text: "question" },
          },
        });
      };

      writeAsk(fork.appDir, askId, ["Which queue?"]);
      await waitFor(
        () =>
          fork
            .sentMessages()
            .slice(sentBefore)
            .find((call) => call.params.reply_markup),
        "the new question with buttons",
      );
      tap(`ask:${shortIdFor(askId)}:0:o`);

      const request = await waitFor(
        () =>
          fork
            .sentMessages()
            .slice(sentBefore)
            .find((call) =>
              String(call.params.text).startsWith(
                "✍️ Escreva aqui a resposta da pergunta 1",
              ),
            ),
        "the Other request",
      );

      tap(`ask:${shortIdFor(askId)}:0:0`);

      const deleted = await waitFor(
        () =>
          fork.telegram.calls.find(
            (call) =>
              call.method === "deleteMessage" &&
              call.params.message_id === request.messageId,
          ),
        "the deletion of the Other request",
      );

      expect(deleted.params.chat_id).toBe(CHAT_ID);
    });

    it("answers every Telegram API method the test expects and nothing else", (): void => {
      expect(fork.telegram.unhandled).toEqual([]);
    });
  },
);

describe.skipIf(!canRun)(
  `Telegram fork end to end in en-us (config without language)${skipNote}`,
  () => {
    let fork: Fork;

    beforeAll(async (): Promise<void> => {
      fork = await startFork(null);
    }, 60_000);

    afterAll(async (): Promise<void> => {
      await fork?.stop();
    });

    it("mirrors the question in English and delivers the answer in English", async (): Promise<void> => {
      writeAsk(fork.appDir);

      const question = await waitFor(
        () => fork.sentMessages().find((call) => call.params.reply_markup),
        "the question with buttons",
      );

      expect(
        String(question.params.text).startsWith(
          "❓ Question open in the terminal from [back-s3]",
        ),
      ).toBe(true);

      fork.telegram.push({
        callback_query: {
          id: "cb1",
          from: DEV,
          chat_instance: "x",
          data: `ask:${shortIdFor(ASK_ID)}:0:1`,
          message: { message_id: 1, date: 0, chat: CHAT, text: "question" },
        },
      });

      const answers = await waitFor(
        () =>
          readJsonFile(join(fork.appDir, "asks", `${ASK_ID}.answer.json`))
            ?.answers,
        "the answer file",
      );

      expect(answers).toEqual({ "Which database?": "Redis" });

      await waitFor(
        () =>
          fork
            .sentMessages()
            .find(
              (call) =>
                call.params.text ===
                "✅ Answers delivered: the terminal question was answered with them.",
            ),
        "the English delivery confirmation",
      );
    });

    it("delivers the dev reply with the English header", async (): Promise<void> => {
      pushDevReply(fork, "go ahead", "I need the ok.");

      expect(await waitForChannelContent(fork)).toBe(
        "↩️ In reply to Claude's message:\n«I need the ok.»\n\ngo ahead",
      );
    });

    it("answers every Telegram API method the test expects and nothing else", (): void => {
      expect(fork.telegram.unhandled).toEqual([]);
    });
  },
);

describe.skipIf(!canRun)(
  `Telegram fork end to end with voice transcription${skipNote}`,
  () => {
    let fork: Fork;
    let whisperCalls: () => number;

    beforeAll(async (): Promise<void> => {
      fork = await startFork({ transcription: { model: "base" } });
      whisperCalls = writeFakeWhisper(fork);
    }, 60_000);

    afterAll(async (): Promise<void> => {
      await fork?.stop();
    });

    it("transcribes a dev voice message and delivers the transcript to Claude", async (): Promise<void> => {
      pushVoice(fork, CHAT);

      expect(await waitForChannelContent(fork)).toBe(
        MESSAGES["en-us"].transcriptionText(TRANSCRIPT),
      );
      expect(whisperCalls()).toBe(1);
      expect(
        fork.telegram.calls.filter((call) => call.method === FILE_DOWNLOAD),
      ).toHaveLength(1);
    });

    it("drops a voice from a group missing from access.json without downloading it", async (): Promise<void> => {
      const callsBefore = fork.telegram.calls.length;
      const contentsBefore = channelContents(fork).length;

      pushVoice(fork, { id: -100777, type: "supergroup", title: "Team" });
      pushDevText(fork, "sync");
      await waitFor(
        () => channelContents(fork).includes("sync"),
        "the dev text sent after the group voice",
      );

      expect(
        fork.telegram.calls
          .slice(callsBefore)
          .map(({ method }) => method)
          .filter((method) => method === "getFile" || method === FILE_DOWNLOAD),
      ).toEqual([]);
      expect(whisperCalls()).toBe(1);
      expect(channelContents(fork).slice(contentsBefore)).toEqual(["sync"]);
    });

    it("delivers the voice as an attachment when whisper is not installed", async (): Promise<void> => {
      const contentsBefore = channelContents(fork).length;

      rmSync(join(fork.appDir, "whisper"), { recursive: true, force: true });
      pushVoice(fork, CHAT);

      const notification = await waitFor(
        () =>
          fork.mcpMessages
            .filter(
              (message) => message.method === "notifications/claude/channel",
            )
            .at(contentsBefore),
        "the voice delivered as an attachment",
      );
      const params = isRecord(notification.params) ? notification.params : {};

      expect(params.content).toBe("(voice message)");
      expect(params.meta).toMatchObject({
        attachment_kind: "voice",
        attachment_file_id: "voice-1",
      });
      expect(whisperCalls()).toBe(1);
    });

    it("answers every Telegram API method the test expects and nothing else", (): void => {
      expect(fork.telegram.unhandled).toEqual([]);
    });
  },
);

describe.skipIf(!canRun)(
  `Telegram fork end to end with a held permission request${skipNote}`,
  () => {
    let fork: Fork;

    beforeAll(async (): Promise<void> => {
      fork = await startFork({ delays: { permissions: 0.05 } });
    }, 60_000);

    afterAll(async (): Promise<void> => {
      await fork?.stop();
    });

    it("sends the held request only to the accounts in access.json when it goes out", async (): Promise<void> => {
      const permissionText = "🔐 Permission: Write";

      fork.send({
        method: "notifications/claude/channel/permission_request",
        params: {
          request_id: "fghij",
          tool_name: "Write",
          description: "writes a file",
          input_preview: "{}",
        },
      });
      fork.send({ id: 30, method: "tools/list" });
      await waitFor(
        () => fork.mcpMessages.find((message) => message.id === 30),
        "the tools list answered after the permission request",
      );

      expect(
        fork
          .sentMessages()
          .filter((call) => call.params.text === permissionText),
      ).toEqual([]);

      writeFileSync(
        join(fork.stateDir, "access.json"),
        JSON.stringify({
          dmPolicy: "allowlist",
          allowFrom: ["77"],
          groups: {},
          pending: {},
        }),
      );

      const request = await waitFor(
        () =>
          fork
            .sentMessages()
            .find((call) => call.params.text === permissionText),
        "the held permission request",
      );

      expect(request.params.chat_id).toBe("77");
      expect(
        fork
          .sentMessages()
          .filter((call) => call.params.text === permissionText)
          .map((call) => call.params.chat_id),
      ).toEqual(["77"]);
    });
  },
);

describe.skipIf(!canRun)(
  `Telegram fork outside claude --telegram${skipNote}`,
  () => {
    it("exits without touching the poller in bot.pid when BETTER_CC_TELEGRAM is not 1", async (): Promise<void> => {
      const stateDir = mkdtempSync(join(tmpdir(), "bcct-state-"));
      const homeDir = mkdtempSync(join(tmpdir(), "bcct-home-"));
      const poller = spawn("bash", ["-c", 'exec -a "bun server.ts" sleep 30']);

      try {
        writeFileSync(join(stateDir, "bot.pid"), String(poller.pid));

        const run = spawnSync("bun", ["server.ts"], {
          cwd: PLUGIN_DIR,
          env: {
            PATH: process.env.PATH,
            HOME: homeDir,
            TELEGRAM_STATE_DIR: stateDir,
            TELEGRAM_BOT_TOKEN: TOKEN,
          },
          encoding: "utf8",
          input: "",
          timeout: 20_000,
        });

        await sleep(200);

        expect(run.status).toBe(0);
        expect(run.stderr).toContain("only runs inside 'claude --telegram'");
        expect(readFileSync(join(stateDir, "bot.pid"), "utf8")).toBe(
          String(poller.pid),
        );
        expect(poller.signalCode).toBeNull();
        expect(poller.exitCode).toBeNull();
      } finally {
        poller.kill();
        rmSync(stateDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  },
);
