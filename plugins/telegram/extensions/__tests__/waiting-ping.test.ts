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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { MESSAGES, type Messages } from "../i18n.ts";
import {
  conversationIsOnTelegram,
  createWaitingPing,
  formatWaitingPing,
  isWaitingPing,
  readPingText,
  readPingTimestamp,
  type WaitingPingChannel,
} from "../waiting-ping.ts";

const CHAT = "42";
const NOW = 1_000_000;
const PT = MESSAGES["pt-br"];
const EN = MESSAGES["en-us"];

interface SentPing {
  chatId: string;
  text: string;
  parseMode: string | undefined;
}

interface PingOptions {
  dueAt?: number;
  text?: string;
  instance?: string | null;
  released?: boolean;
}

interface SetupOptions {
  now?: number;
  messages?: () => Messages;
  fail?: boolean;
  failSend?: (chatId: string, sendNumber: number) => boolean;
  chats?: string[];
  onSend?: (ping: WaitingPingChannel) => void;
}

let appDir = "";

function pingsDir(): string {
  return join(appDir, "pings");
}

function writePing(
  sessionId: string,
  {
    dueAt = NOW,
    text = "Preciso do ok.",
    instance = null,
    released,
  }: PingOptions = {},
): void {
  mkdirSync(pingsDir(), { recursive: true });
  writeFileSync(
    join(pingsDir(), `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      createdAt: dueAt - 180_000,
      dueAt,
      text,
      instance,
      ...(released === undefined ? {} : { released }),
    }),
  );
}

function writeLanguage(language: string): void {
  writeFileSync(join(appDir, CONFIG_FILE), JSON.stringify({ language }));
}

function setup({
  now = NOW,
  messages,
  fail = false,
  failSend = (): boolean => false,
  chats = [CHAT],
  onSend,
}: SetupOptions = {}): {
  sent: SentPing[];
  logs: string[];
  ping: ReturnType<typeof createWaitingPing>;
} {
  const sent: SentPing[] = [];
  const logs: string[] = [];
  let sendNumber = 0;
  const ping = createWaitingPing({
    api: {
      sendMessage(
        chatId: string,
        text: string,
        options?: { parse_mode?: "HTML" },
      ): Promise<unknown> {
        sendNumber += 1;

        if (fail || failSend(chatId, sendNumber)) {
          return Promise.reject(new Error("boom"));
        }

        onSend?.(ping);
        sent.push({ chatId, text, parseMode: options?.parse_mode });

        return Promise.resolve();
      },
    },
    appDir,
    allowedChats: () => chats,
    log: (message) => logs.push(message),
    now: () => now,
    ...(messages ? { messages } : {}),
  });

  return { sent, logs, ping };
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "bcct-waiting-ping-"));
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

describe("formatWaitingPing", () => {
  it("says how long Claude has been waiting and carries the whole message in pt-br", (): void => {
    expect(
      formatWaitingPing(
        {
          sessionId: "s1",
          createdAt: 0,
          dueAt: 180_000,
          text: "Preciso do ok.",
        },
        PT,
      ),
    ).toBe(
      "⏳ O Claude está esperando você no terminal há mais de 3 min.\n\nÚltima mensagem dele:\n\nPreciso do ok.",
    );
  });

  it("names the instance in pt-br", (): void => {
    expect(
      formatWaitingPing(
        {
          sessionId: "s1",
          createdAt: 0,
          dueAt: 180_000,
          text: "Preciso do ok.",
          instance: "back-s3",
        },
        PT,
      ),
    ).toBe(
      "⏳ A instância [back-s3] do Claude está esperando você no terminal há mais de 3 min.\n\nÚltima mensagem dele:\n\nPreciso do ok.",
    );
  });

  it("says how long Claude has been waiting and carries the whole message in en-us", (): void => {
    expect(
      formatWaitingPing(
        {
          sessionId: "s1",
          createdAt: 0,
          dueAt: 180_000,
          text: "I need the ok.",
        },
        EN,
      ),
    ).toBe(
      "⏳ Claude has been waiting for you in the terminal for more than 3 min.\n\nLast message:\n\nI need the ok.",
    );
  });

  it("names the instance in en-us and formats short delays in seconds", (): void => {
    expect(
      formatWaitingPing(
        {
          sessionId: "s1",
          createdAt: 0,
          dueAt: 15_000,
          text: "I need the ok.",
          instance: "back-s3",
        },
        EN,
      ),
    ).toBe(
      "⏳ The Claude instance [back-s3] has been waiting for you in the terminal for more than 15 s.\n\nLast message:\n\nI need the ok.",
    );
  });
});

describe("conversationIsOnTelegram", () => {
  it("is true only when the dev's last message came from Telegram", (): void => {
    expect(conversationIsOnTelegram(null, null)).toBe(false);
    expect(conversationIsOnTelegram(10, 5)).toBe(true);
    expect(conversationIsOnTelegram(5, 10)).toBe(false);
    expect(conversationIsOnTelegram(5, null)).toBe(true);
  });

  it("is false when the Telegram message and the terminal prompt share the same instant", (): void => {
    expect(conversationIsOnTelegram(5, 5)).toBe(false);
  });

  it("is false without a Telegram message, whatever the prompt stamp holds", (): void => {
    expect(conversationIsOnTelegram(null, -1)).toBe(false);
  });
});

describe("isWaitingPing", () => {
  const valid = {
    sessionId: "s1",
    createdAt: 0,
    dueAt: 180_000,
    text: "Preciso do ok.",
  };

  it("accepts a notice with every field of the right type", (): void => {
    expect(isWaitingPing(valid)).toBe(true);
  });

  it("rejects a notice with any field of the wrong type", (): void => {
    expect(
      [
        { ...valid, sessionId: 1 },
        { ...valid, createdAt: "0" },
        { ...valid, dueAt: "180000" },
        { ...valid, text: null },
      ].map((value) => isWaitingPing(value)),
    ).toEqual([false, false, false, false]);
  });

  it("rejects a value that is not an object", (): void => {
    expect(
      [undefined, null, "s1", 42].map((value) => isWaitingPing(value)),
    ).toEqual([false, false, false, false]);
  });
});

describe("readPingTimestamp", () => {
  it("reads the number stored in the pings folder", (): void => {
    mkdirSync(pingsDir(), { recursive: true });
    writeFileSync(join(pingsDir(), "last-prompt"), "12345");

    expect(readPingTimestamp(appDir, "last-prompt")).toBe(12_345);
  });

  it("returns null when the stamp is missing or is not a number", (): void => {
    expect(readPingTimestamp(appDir, "last-prompt")).toBeNull();

    mkdirSync(pingsDir(), { recursive: true });
    writeFileSync(join(pingsDir(), "last-prompt"), "not a stamp");

    expect(readPingTimestamp(appDir, "last-prompt")).toBeNull();
  });
});

describe("readPingText", () => {
  it("reads the text stored in the pings folder as it is", (): void => {
    mkdirSync(pingsDir(), { recursive: true });
    writeFileSync(join(pingsDir(), "s1.sent"), "Nada aberto.\n");

    expect(readPingText(appDir, "s1.sent")).toBe("Nada aberto.\n");
  });

  it("returns null when the file is missing or cannot be read", (): void => {
    expect(readPingText(appDir, "s1.sent")).toBeNull();

    mkdirSync(join(pingsDir(), "s1.sent"), { recursive: true });

    expect(readPingText(appDir, "s1.sent")).toBeNull();
  });
});

describe("createWaitingPing", () => {
  it("only notifies after the deadline and deletes the sent notice", async (): Promise<void> => {
    writePing("s1", { dueAt: NOW + 1 });
    const early = setup();

    await early.ping.tick();
    expect(early.sent.length).toBe(0);

    const due = setup({ now: NOW + 1 });

    await due.ping.tick();
    expect(due.sent.length).toBe(1);
    expect(due.sent[0].chatId).toBe(CHAT);
    expect(due.sent[0].parseMode).toBe("HTML");
    expect(due.sent[0].text.endsWith("Preciso do ok.")).toBe(true);
    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(false);
  });

  it("splits a long message without losing text", async (): Promise<void> => {
    const longText = "linha\n".repeat(1500).trim();

    writePing("s1", { text: longText });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBeGreaterThan(1);
    expect(
      sent
        .map((message) => message.text)
        .join("\n")
        .includes(longText),
    ).toBe(true);
  });

  it("does not notify when the conversation is already on Telegram", async (): Promise<void> => {
    writePing("s1");
    writeFileSync(join(pingsDir(), "last-prompt"), String(NOW - 100));
    writeFileSync(join(pingsDir(), "last-inbound"), String(NOW - 50));
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(0);
    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(false);
  });

  it("cancels the pending notices and stamps last-inbound on a dev message from Telegram", (): void => {
    writePing("s1", { dueAt: NOW + 60_000 });
    writePing("s2", { dueAt: NOW + 60_000 });
    const { ping } = setup();

    ping.noteInbound();

    expect(readdirSync(pingsDir())).toEqual(["last-inbound"]);
  });

  it("does not cancel the notice of another instance on a Telegram message", (): void => {
    writePing("s1", { dueAt: NOW + 60_000 });
    writePing("s2", { dueAt: NOW + 60_000, instance: "back-s3" });
    const { ping } = setup();

    ping.noteInbound();

    expect(readdirSync(pingsDir()).toSorted()).toEqual([
      "last-inbound",
      "s2.json",
    ]);
  });

  it("sends the notice of another instance with its name, even with the conversation on Telegram", async (): Promise<void> => {
    writePing("s2", { instance: "back-s3" });
    writeFileSync(join(pingsDir(), "last-prompt"), String(NOW - 100));
    writeFileSync(join(pingsDir(), "last-inbound"), String(NOW - 50));
    const { sent, ping } = setup({ messages: () => PT });

    await ping.tick();

    expect(sent.length).toBe(1);
    expect(
      sent[0].text.startsWith(
        "⏳ A instância [back-s3] do Claude está esperando você no terminal há mais de 3 min.",
      ),
    ).toBe(true);
  });

  it("writes the pt-br text and log with messages set to pt-br", async (): Promise<void> => {
    writePing("s2", { instance: "back-s3" });
    const { sent, logs, ping } = setup({ messages: () => PT });

    await ping.tick();

    expect(sent[0].text).toBe(
      "⏳ A instância [back-s3] do Claude está esperando você no terminal há mais de 3 min.\n\nÚltima mensagem dele:\n\nPreciso do ok.",
    );
    expect(logs).toEqual(["ping: aviso de [back-s3] enviado"]);
  });

  it("writes the en-us text and log with messages set to en-us", async (): Promise<void> => {
    writePing("s1", { text: "I need the ok." });
    const { sent, logs, ping } = setup({ messages: () => EN });

    await ping.tick();

    expect(sent[0].text).toBe(
      "⏳ Claude has been waiting for you in the terminal for more than 3 min.\n\nLast message:\n\nI need the ok.",
    );
    expect(logs).toEqual(["ping: notice from [telegram] sent"]);
  });

  it("follows the language of the config when messages is not given", async (): Promise<void> => {
    writeLanguage("pt-br");
    writePing("s1");
    const { sent, logs, ping } = setup();

    await ping.tick();

    expect(sent[0].text).toBe(
      "⏳ O Claude está esperando você no terminal há mais de 3 min.\n\nÚltima mensagem dele:\n\nPreciso do ok.",
    );
    expect(logs).toEqual(["ping: aviso de [telegram] enviado"]);
  });

  it("falls back to en-us when there is no config and messages is not given", async (): Promise<void> => {
    writePing("s1", { instance: "back-s3" });
    const { sent, logs, ping } = setup();

    await ping.tick();

    expect(sent[0].text).toBe(
      "⏳ The Claude instance [back-s3] has been waiting for you in the terminal for more than 3 min.\n\nLast message:\n\nPreciso do ok.",
    );
    expect(logs).toEqual(["ping: notice from [back-s3] sent"]);
  });

  it("logs the send failure in the configured language and still deletes the notice", async (): Promise<void> => {
    writePing("s1");
    const english = setup({ fail: true });

    await english.ping.tick();

    expect(english.logs).toEqual([
      "ping: failed to notify the chat: Error: boom",
      "ping: notice from [telegram] sent",
    ]);
    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(false);

    writePing("s1");
    const portuguese = setup({ fail: true, messages: () => PT });

    await portuguese.ping.tick();

    expect(portuguese.logs).toEqual([
      "ping: falha ao avisar no chat: Error: boom",
      "ping: aviso de [telegram] enviado",
    ]);
  });

  it("does nothing while the pings folder does not exist", async (): Promise<void> => {
    const { sent, logs, ping } = setup();

    await ping.tick();

    expect(sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("removes a notice file that is not a valid notice, without sending it", async (): Promise<void> => {
    mkdirSync(pingsDir(), { recursive: true });
    writeFileSync(join(pingsDir(), "s1.json"), "{ not json");
    writeFileSync(
      join(pingsDir(), "s2.json"),
      JSON.stringify({ sessionId: "s2" }),
    );
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent).toEqual([]);
    expect(readdirSync(pingsDir())).toEqual([]);
  });

  it("keeps an unreadable notice of the dev's own instance out of the cancellation on a Telegram message", (): void => {
    mkdirSync(pingsDir(), { recursive: true });
    writeFileSync(join(pingsDir(), "s1.json"), "{ not json");
    const { ping } = setup();

    ping.noteInbound();

    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(true);
  });

  it("stamps last-inbound readable only by the owner", (): void => {
    writePing("s1", { dueAt: NOW + 60_000 });
    const { ping } = setup();

    ping.noteInbound();

    expect(statSync(join(pingsDir(), "last-inbound")).mode & 0o777).toBe(0o600);
  });

  it("keeps the timestamps of the pings folder when it sends a notice", async (): Promise<void> => {
    writePing("s1");
    writeFileSync(join(pingsDir(), "last-prompt"), String(NOW - 50));
    writeFileSync(join(pingsDir(), "last-inbound"), String(NOW - 100));
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
    expect(readdirSync(pingsDir()).toSorted()).toEqual([
      "last-inbound",
      "last-prompt",
      "s1.sent",
    ]);
  });

  it("does nothing when the pings path is not a folder", async (): Promise<void> => {
    writeFileSync(pingsDir(), "");
    const { sent, logs, ping } = setup();

    await ping.tick();

    expect(sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("goes on when a Telegram message cancels a notice while another one is being sent", async (): Promise<void> => {
    writePing("s1");
    writePing("s2");
    const { sent, ping } = setup({
      onSend: (channel) => channel.noteInbound(),
    });

    await ping.tick();

    expect(sent.length).toBe(1);
    expect(readdirSync(pingsDir()).toSorted()).toEqual([
      "last-inbound",
      "s1.sent",
    ]);
  });
});

describe("failure notices", () => {
  const FAILURE_TEXT = "⚠️ Claude stopped: your account is on hold";

  function writeFailure(
    sessionId: string,
    {
      dueAt = NOW,
      instance = null,
      released,
      text = FAILURE_TEXT,
    }: PingOptions = {},
  ): void {
    mkdirSync(pingsDir(), { recursive: true });
    writeFileSync(
      join(pingsDir(), `${sessionId}.notice.json`),
      JSON.stringify({
        sessionId,
        createdAt: dueAt,
        dueAt,
        text,
        instance,
        kind: "failure",
        ...(released === undefined ? {} : { released }),
      }),
    );
  }

  function writeQuietHours(start: string, end: string): void {
    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ quietHours: { start, end } }),
    );
  }

  it("sends the text of the notice as it is, with no waiting wording", (): void => {
    expect(
      formatWaitingPing(
        {
          sessionId: "s1",
          createdAt: 0,
          dueAt: 0,
          text: FAILURE_TEXT,
          kind: "failure",
        },
        EN,
      ),
    ).toBe(FAILURE_TEXT);
  });

  it("sends the title of the card in bold and escapes the rest of it", async (): Promise<void> => {
    writeFailure("s1", {
      instance: "proj#abcd",
      text: "🛑 **Claude stopped** · [proj#abcd]\n\nReason: the API rejected the request (<b>x</b> & y)\nBack: Nov 24, 9:00 AM (America/Sao_Paulo)\nNext: review the request and try again in the terminal",
    });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([
      "🛑 <b>Claude stopped</b> · [proj#abcd]\n\nReason: the API rejected the request (&lt;b&gt;x&lt;/b&gt; &amp; y)\nBack: Nov 24, 9:00 AM (America/Sao_Paulo)\nNext: review the request and try again in the terminal",
    ]);
    expect(sent[0].parseMode).toBe("HTML");
  });

  it("sends the card with its fields in one block quote", async (): Promise<void> => {
    writeFailure("s1", {
      text: "🪫 **Cota esgotada** · o Claude parou · [telegram]\n> 📋 **Motivo:** o limite de uso do seu plano foi atingido\n> 🕙 **Volta:** 25/11 às 10:00 (America/Sao_Paulo)\n> 👉 **Depois:** não continua sozinho, retome no terminal",
    });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([
      "🪫 <b>Cota esgotada</b> · o Claude parou · [telegram]\n<blockquote>📋 <b>Motivo:</b> o limite de uso do seu plano foi atingido\n🕙 <b>Volta:</b> 25/11 às 10:00 (America/Sao_Paulo)\n👉 <b>Depois:</b> não continua sozinho, retome no terminal</blockquote>",
    ]);
    expect(sent[0].parseMode).toBe("HTML");
  });

  it("sends a detail line in code raw inside the quote", async (): Promise<void> => {
    writeFailure("s1", {
      text: "🛑 **Claude parou**\n> 📋 **Motivo:** a API recusou o pedido\n> `API Error: 400 bad **campo**`",
    });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([
      "🛑 <b>Claude parou</b>\n<blockquote>📋 <b>Motivo:</b> a API recusou o pedido\n<code>API Error: 400 bad **campo**</code></blockquote>",
    ]);
  });

  it("sends the API error detail the Rust notice escaped as literal text, with no bold or code from it", async (): Promise<void> => {
    writeFailure("s1", {
      text: "🛑 **Claude stopped**\n\nReason: the API rejected the request (bad \\*\\*field\\*\\* \\`x\\` in C:\\\\tmp \\\\_)\nNext: review the request and try again in the terminal",
    });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([
      "🛑 <b>Claude stopped</b>\n\nReason: the API rejected the request (bad **field** `x` in C:\\tmp \\_)\nNext: review the request and try again in the terminal",
    ]);
    expect(sent[0].parseMode).toBe("HTML");
    expect(sent[0].text.match(/<\/?(b|code)>/g)).toEqual(["<b>", "</b>"]);
  });

  it("sends the title of the card in bold without an instance label", async (): Promise<void> => {
    writeFailure("s1", {
      text: "🛑 **O Claude parou**\n\nMotivo: sua conta está suspensa\nDepois: confira a situação da conta e retome no terminal",
    });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([
      "🛑 <b>O Claude parou</b>\n\nMotivo: sua conta está suspensa\nDepois: confira a situação da conta e retome no terminal",
    ]);
  });

  it("accepts the failure kind and rejects any other kind", (): void => {
    const base = { sessionId: "s1", createdAt: 0, dueAt: 0, text: "x" };

    expect(isWaitingPing({ ...base, kind: "failure" })).toBe(true);
    expect(isWaitingPing({ ...base })).toBe(true);
    expect(isWaitingPing({ ...base, kind: "other" })).toBe(false);
    expect(isWaitingPing({ ...base, kind: 3 })).toBe(false);
  });

  it("sends it right away and deletes it", async (): Promise<void> => {
    writeFailure("s1");
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([FAILURE_TEXT]);
    expect(sent[0].chatId).toBe(CHAT);
    expect(sent[0].parseMode).toBe("HTML");
    expect(existsSync(join(pingsDir(), "s1.notice.json"))).toBe(false);
  });

  it("sends it even with the conversation on Telegram", async (): Promise<void> => {
    writeFailure("s1");
    writeFileSync(join(pingsDir(), "last-prompt"), String(NOW - 100));
    writeFileSync(join(pingsDir(), "last-inbound"), String(NOW - 50));
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([FAILURE_TEXT]);
  });

  it("keeps it when a Telegram message cancels the waiting notices", (): void => {
    writeFailure("s1", { dueAt: NOW + 60_000 });
    writePing("s2", { dueAt: NOW + 60_000 });
    const { ping } = setup();

    ping.noteInbound();

    expect(readdirSync(pingsDir()).toSorted()).toEqual([
      "last-inbound",
      "s1.notice.json",
    ]);
  });

  it("holds it during the quiet hours and sends it once they end", async (): Promise<void> => {
    writeQuietHours("00:00", "23:59");
    writeFailure("s1");
    const quiet = setup({ now: new Date(2026, 0, 1, 12, 0).getTime() });

    await quiet.ping.tick();

    expect(quiet.sent).toEqual([]);
    expect(existsSync(join(pingsDir(), "s1.notice.json"))).toBe(true);

    const after = setup({ now: new Date(2026, 0, 1, 23, 59).getTime() });

    await after.ping.tick();

    expect(after.sent.map((message) => message.text)).toEqual([FAILURE_TEXT]);
    expect(existsSync(join(pingsDir(), "s1.notice.json"))).toBe(false);
  });

  it("sends a released notice during the quiet hours", async (): Promise<void> => {
    writeQuietHours("00:00", "23:59");
    writeFailure("s1", { released: true });
    const { sent, ping } = setup({
      now: new Date(2026, 0, 1, 12, 0).getTime(),
    });

    await ping.tick();

    expect(sent.map((message) => message.text)).toEqual([FAILURE_TEXT]);
    expect(existsSync(join(pingsDir(), "s1.notice.json"))).toBe(false);
  });

  it("holds a notice marked as not released during the quiet hours", async (): Promise<void> => {
    writeQuietHours("00:00", "23:59");
    writeFailure("s1", { released: false });
    const { sent, ping } = setup({
      now: new Date(2026, 0, 1, 12, 0).getTime(),
    });

    await ping.tick();

    expect(sent).toEqual([]);
    expect(existsSync(join(pingsDir(), "s1.notice.json"))).toBe(true);
  });

  it("counts it as held with the conversation on Telegram", (): void => {
    const { ping } = setup();

    writeFailure("s1", { dueAt: NOW - 1 });
    writePing("own", { dueAt: NOW - 1 });
    writeFileSync(join(pingsDir(), "last-inbound"), String(NOW - 10));

    expect(ping.held()).toBe(1);
  });
});

describe("released waiting notices", () => {
  const quietNoon = new Date(2026, 0, 1, 12, 0).getTime();

  function writeQuietHours(): void {
    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ quietHours: { start: "00:00", end: "23:59" } }),
    );
  }

  it("sends a released waiting notice during the quiet hours and deletes it", async (): Promise<void> => {
    writeQuietHours();
    writePing("s1", { dueAt: quietNoon, released: true });
    const { sent, ping } = setup({ now: quietNoon });

    await ping.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Preciso do ok.");
    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(false);
  });

  it("holds a waiting notice that is not released during the quiet hours", async (): Promise<void> => {
    writeQuietHours();
    writePing("s1", { dueAt: quietNoon });
    const { sent, ping } = setup({ now: quietNoon });

    await ping.tick();

    expect(sent).toEqual([]);
    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(true);
  });

  it("accepts a boolean released flag and rejects any other type", (): void => {
    const base = { sessionId: "s1", createdAt: 0, dueAt: 0, text: "x" };

    expect(isWaitingPing({ ...base, released: true })).toBe(true);
    expect(isWaitingPing({ ...base, released: false })).toBe(true);
    expect(isWaitingPing({ ...base, released: "yes" })).toBe(false);
    expect(isWaitingPing({ ...base, released: 1 })).toBe(false);
  });
});

describe("waiting notices held", () => {
  it("counts the due notices it would send now, leaving out the ones not due and the unreadable files", (): void => {
    const { ping } = setup();

    writePing("due-1", { dueAt: NOW - 1 });
    writePing("due-2", { dueAt: NOW, instance: "api" });
    writePing("later", { dueAt: NOW + 1 });
    writeFileSync(join(pingsDir(), "broken.json"), "{not json");

    expect(ping.held()).toBe(2);
  });

  it("leaves out the notice of this instance while the conversation is on Telegram", (): void => {
    const { ping } = setup();

    writePing("own", { dueAt: NOW - 1 });
    writePing("other", { dueAt: NOW - 1, instance: "api" });
    writePing("another", { dueAt: NOW - 1, instance: "web" });
    writeFileSync(join(pingsDir(), "last-inbound"), String(NOW - 10));

    expect(ping.held()).toBe(2);
  });

  it("counts a released notice whose due time has not come", (): void => {
    const { ping } = setup();

    writePing("released", { dueAt: NOW + 60_000, released: true });
    writePing("later", { dueAt: NOW + 60_000 });

    expect(ping.held()).toBe(1);
  });

  it("holds nothing without a pings folder", (): void => {
    expect(setup().ping.held()).toBe(0);
  });

  it("leaves out a notice equal to the last one sent for its session", (): void => {
    const { ping } = setup();

    writePing("same", { dueAt: NOW - 1, text: "Nada aberto." });
    writeFileSync(join(pingsDir(), "same.sent"), "Nada aberto.");
    writePing("other", { dueAt: NOW - 1, text: "Posso seguir?" });
    writeFileSync(join(pingsDir(), "other.sent"), "Nada aberto.");

    expect(ping.held()).toBe(1);
  });
});

describe("repeated waiting notices", () => {
  it("does not send again the text last sent for the same session and logs why", async (): Promise<void> => {
    writePing("s1", { text: "Nenhuma pergunta aberta no Telegram." });
    await setup().ping.tick();
    writePing("s1", { text: "Nenhuma pergunta aberta no Telegram." });
    const { sent, logs, ping } = setup({ messages: () => PT });

    await ping.tick();

    expect(sent).toEqual([]);
    expect(logs).toEqual([
      "ping: aviso de [telegram] igual ao último, não enviado",
    ]);
    expect(existsSync(join(pingsDir(), "s1.json"))).toBe(false);
  });

  it("names the instance of the repeated notice in en-us", async (): Promise<void> => {
    writePing("s1", { text: "Same.", instance: "api" });
    await setup().ping.tick();
    writePing("s1", { text: "Same.", instance: "api" });
    const { logs, ping } = setup({ messages: () => EN });

    await ping.tick();

    expect(logs).toEqual([
      "ping: notice from [api] same as the last one, not sent",
    ]);
  });

  describe("when a notice is split in chunks", () => {
    const LONG_TEXT = `${"l".repeat(99)}\n`.repeat(50).trim();

    it("does not remember a notice whose later chunk failed, so the same notice goes out again", async (): Promise<void> => {
      writePing("s1", { text: LONG_TEXT });

      const { sent, ping } = setup({
        failSend: (_chatId, sendNumber) => sendNumber === 2,
      });

      await ping.tick();

      expect(sent.length).toBe(1);
      expect(existsSync(join(pingsDir(), "s1.sent"))).toBe(false);

      writePing("s1", { text: LONG_TEXT });
      await ping.tick();

      expect(sent.length).toBe(1 + 2);
    });

    it("remembers a notice when one chat got every chunk even if another chat failed partway", async (): Promise<void> => {
      writePing("s1", { text: LONG_TEXT });

      const { sent, logs, ping } = setup({
        chats: ["111", CHAT],
        failSend: (chatId, sendNumber) => chatId === "111" && sendNumber === 2,
      });

      await ping.tick();

      expect(sent.filter((message) => message.chatId === CHAT).length).toBe(2);
      expect(readFileSync(join(pingsDir(), "s1.sent"), "utf8")).toBe(LONG_TEXT);

      writePing("s1", { text: LONG_TEXT });
      await ping.tick();

      expect(sent.length).toBe(1 + 2);
      expect(logs.at(-1)).toBe(EN.pingRepeated("telegram"));
    });

    it("remembers a notice only when a chat received every chunk of it", async (): Promise<void> => {
      writePing("s1", { text: LONG_TEXT });

      const { ping } = setup({ failSend: () => true });

      await ping.tick();

      expect(existsSync(join(pingsDir(), "s1.sent"))).toBe(false);
    });
  });

  it("sends a text that differs from the last one sent and remembers the new one", async (): Promise<void> => {
    writePing("s1", { text: "Primeira." });
    await setup().ping.tick();
    writePing("s1", { text: "Segunda." });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
    expect(sent[0].text.endsWith("Segunda.")).toBe(true);
    expect(readFileSync(join(pingsDir(), "s1.sent"), "utf8")).toBe("Segunda.");
  });

  it("sends the same text for another session", async (): Promise<void> => {
    writePing("s1", { text: "Igual." });
    await setup().ping.tick();
    writePing("s2", { text: "Igual." });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
  });

  it("sends the same text again once the mark of the session is gone", async (): Promise<void> => {
    writePing("s1", { text: "Igual." });
    await setup().ping.tick();
    rmSync(join(pingsDir(), "s1.sent"));
    writePing("s1", { text: "Igual." });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
  });

  it("keeps the mark of the last text readable only by the owner", async (): Promise<void> => {
    writePing("s1");
    await setup().ping.tick();

    expect(statSync(join(pingsDir(), "s1.sent")).mode & 0o777).toBe(0o600);
  });

  it("leaves no mark when no chat got the notice, so the same text goes out next time", async (): Promise<void> => {
    writePing("s1", { text: "Igual." });
    await setup({ fail: true }).ping.tick();

    expect(existsSync(join(pingsDir(), "s1.sent"))).toBe(false);

    writePing("s1", { text: "Igual." });
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
  });

  it("still sends the notice when the mark cannot be written", async (): Promise<void> => {
    writePing("s1", { text: "Igual." });
    mkdirSync(join(pingsDir(), "s1.sent"));
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
  });

  it("sends a failure notice every time, without a mark", async (): Promise<void> => {
    const failure = (): void => {
      mkdirSync(pingsDir(), { recursive: true });
      writeFileSync(
        join(pingsDir(), "s1.notice.json"),
        JSON.stringify({
          sessionId: "s1",
          createdAt: NOW,
          dueAt: NOW,
          text: "⚠️ Claude stopped",
          instance: null,
          kind: "failure",
        }),
      );
    };

    failure();
    await setup().ping.tick();
    failure();
    const { sent, ping } = setup();

    await ping.tick();

    expect(sent.length).toBe(1);
    expect(existsSync(join(pingsDir(), "s1.notice.sent"))).toBe(false);
  });
});
