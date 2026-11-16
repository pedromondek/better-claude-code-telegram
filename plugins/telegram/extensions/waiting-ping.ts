import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  formatDelay,
  isQuietTime,
  readLocale,
  readQuietHours,
} from "./config.ts";
import { describeError, messagesFor, type Messages } from "./i18n.ts";
import type { Log } from "./log.ts";
import { toTelegramHtmlChunks } from "./telegram-html.ts";

export interface WaitingPing {
  sessionId: string;
  createdAt: number;
  dueAt: number;
  text: string;
  instance?: string | null;
}

interface PingApi {
  sendMessage(
    chatId: string,
    text: string,
    options?: { parse_mode?: "HTML" },
  ): Promise<unknown>;
}

interface WaitingPingOptions {
  api: PingApi;
  appDir: string;
  allowedChats: () => string[];
  log: Log;
  now?: () => number;
  messages?: () => Messages;
}

export interface WaitingPingChannel {
  tick: () => Promise<void>;
  noteInbound: () => void;
  held: () => number;
}

export const LAST_PROMPT_FILE = "last-prompt";
export const LAST_INBOUND_FILE = "last-inbound";

export function formatWaitingPing(
  ping: WaitingPing,
  messages: Messages,
): string {
  const delay = formatDelay((ping.dueAt - ping.createdAt) / 60_000);

  return messages.waitingPing(
    messages.waitingWho(ping.instance ?? null),
    delay,
    ping.text,
  );
}

export function isWaitingPing(value: unknown): value is WaitingPing {
  if (typeof value !== "object" || value === null) return false;

  const ping = value as Partial<WaitingPing>;

  return (
    typeof ping.sessionId === "string" &&
    typeof ping.dueAt === "number" &&
    typeof ping.createdAt === "number" &&
    typeof ping.text === "string"
  );
}

export function conversationIsOnTelegram(
  lastInboundAt: number | null,
  lastPromptAt: number | null,
): boolean {
  return lastInboundAt !== null && lastInboundAt > (lastPromptAt ?? 0);
}

export function readPingTimestamp(appDir: string, name: string): number | null {
  try {
    const value = Number(readFileSync(join(appDir, "pings", name)).toString());

    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function conversationOnTelegram(appDir: string): boolean {
  return conversationIsOnTelegram(
    readPingTimestamp(appDir, LAST_INBOUND_FILE),
    readPingTimestamp(appDir, LAST_PROMPT_FILE),
  );
}

export function createWaitingPing({
  api,
  appDir,
  allowedChats,
  log,
  now = Date.now,
  messages = (): Messages => messagesFor(readLocale(appDir)),
}: WaitingPingOptions): WaitingPingChannel {
  const pingsDir = join(appDir, "pings");

  function pingFiles(): string[] {
    try {
      return readdirSync(pingsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  }

  function readPing(name: string): WaitingPing | null {
    try {
      const ping: unknown = JSON.parse(
        readFileSync(join(pingsDir, name)).toString(),
      );

      return isWaitingPing(ping) ? ping : null;
    } catch {
      return null;
    }
  }

  function discardPing(name: string): void {
    rmSync(join(pingsDir, name), { force: true });
  }

  function noteInbound(): void {
    try {
      mkdirSync(pingsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(pingsDir, LAST_INBOUND_FILE), String(now()), {
        mode: 0o600,
      });
    } catch {}

    for (const name of pingFiles()) {
      const ping = readPing(name);

      if (ping !== null && !ping.instance) discardPing(name);
    }
  }

  async function tick(): Promise<void> {
    const quiet = isQuietTime(new Date(now()), readQuietHours(appDir));
    const onTelegram = conversationOnTelegram(appDir);

    for (const name of pingFiles()) {
      const ping = readPing(name);

      if (ping !== null && (now() < ping.dueAt || quiet)) continue;

      discardPing(name);

      if (ping === null || (onTelegram && !ping.instance)) continue;

      const text = messages();

      for (const chatId of allowedChats()) {
        for (const chunk of toTelegramHtmlChunks(
          formatWaitingPing(ping, text),
        )) {
          await api
            .sendMessage(chatId, chunk, { parse_mode: "HTML" })
            .catch((error: unknown) =>
              log(text.pingFailed(describeError(error))),
            );
        }
      }

      log(text.pingSent(ping.instance ?? "telegram"));
    }
  }

  function held(): number {
    const onTelegram = conversationOnTelegram(appDir);

    return pingFiles()
      .map(readPing)
      .filter(
        (ping) =>
          ping !== null &&
          now() >= ping.dueAt &&
          ((ping.instance ?? "") !== "" || !onTelegram),
      ).length;
  }

  return { tick, noteInbound, held };
}
