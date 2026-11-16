import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isQuietTime,
  readLocale,
  readQuietHours,
  type QuietHours,
} from "./config.ts";
import {
  describeError,
  messagesFor,
  type HeldCounts,
  type Messages,
} from "./i18n.ts";
import type { Log } from "./log.ts";

export type { HeldCounts } from "./i18n.ts";

export const QUIET_NOTICE_FILE = "quiet-notice";

interface QuietNoticeOptions {
  api: { sendMessage(chatId: string, text: string): Promise<unknown> };
  appDir: string;
  allowedChats: () => string[];
  log: Log;
  held: () => HeldCounts;
  messages?: () => Messages;
  now?: () => number;
}

export interface QuietNotice {
  tick: () => Promise<void>;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);

  return hours * 60 + minutes;
}

export function quietPeriodStart(date: Date, quietHours: QuietHours): string {
  const current = date.getHours() * 60 + date.getMinutes();
  const startedYesterday =
    minutesOf(quietHours.start) > minutesOf(quietHours.end) &&
    current < minutesOf(quietHours.start);
  const day = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - (startedYesterday ? 1 : 0),
  );

  return `${day.getFullYear()}-${twoDigits(day.getMonth() + 1)}-${twoDigits(day.getDate())}T${quietHours.start}`;
}

export function createQuietNotice({
  api,
  appDir,
  allowedChats,
  log,
  held,
  messages = (): Messages => messagesFor(readLocale(appDir)),
  now = Date.now,
}: QuietNoticeOptions): QuietNotice {
  const stateFile = join(appDir, "pings", QUIET_NOTICE_FILE);

  function toldPeriod(): string {
    try {
      return readFileSync(stateFile, "utf8");
    } catch {
      return "";
    }
  }

  function remember(period: string): boolean {
    try {
      writeFileSync(stateFile, period, { mode: 0o600 });

      return true;
    } catch (error) {
      log(messages().quietNoticeFailed(describeError(error)));

      return false;
    }
  }

  async function send(text: string): Promise<void> {
    await Promise.all(
      allowedChats().map((chatId) =>
        api
          .sendMessage(chatId, text)
          .catch((error: unknown) =>
            log(messages().quietNoticeFailed(describeError(error))),
          ),
      ),
    );
  }

  async function tick(): Promise<void> {
    const date = new Date(now());
    const quietHours = readQuietHours(appDir);
    const told = toldPeriod();

    if (quietHours && isQuietTime(date, quietHours)) {
      const period = quietPeriodStart(date, quietHours);

      if (told === period || !remember(period)) return;

      await send(messages().quietStarted(quietHours.end));

      return;
    }

    if (told === "" || !remember("")) return;

    const counts = held();

    if (counts.questions + counts.notices + counts.permissions === 0) return;

    await send(messages().quietEnded(counts));
  }

  return { tick };
}
