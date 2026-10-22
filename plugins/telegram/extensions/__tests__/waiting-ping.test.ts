import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
}

interface SetupOptions {
  now?: number;
  messages?: () => Messages;
  fail?: boolean;
  onSend?: (ping: WaitingPingChannel) => void;
}

let appDir = "";

function pingsDir(): string {
  return join(appDir, "pings");
}

function writePing(
  sessionId: string,
  { dueAt = NOW, text = "Preciso do ok.", instance = null }: PingOptions = {},
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
  onSend,
}: SetupOptions = {}): {
  sent: SentPing[];
  logs: string[];
  ping: ReturnType<typeof createWaitingPing>;
} {
  const sent: SentPing[] = [];
  const logs: string[] = [];
  const ping = createWaitingPing({
    api: {
      sendMessage(
        chatId: string,
        text: string,
        options?: { parse_mode?: "HTML" },
      ): Promise<unknown> {
        if (fail) return Promise.reject(new Error("boom"));

        onSend?.(ping);
        sent.push({ chatId, text, parseMode: options?.parse_mode });

        return Promise.resolve();
      },
    },
    appDir,
    allowedChats: () => [CHAT],
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
    expect(readdirSync(pingsDir())).toEqual(["last-inbound"]);
  });
});
