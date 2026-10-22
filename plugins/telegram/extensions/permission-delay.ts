import {
  isQuietTime,
  readDelayMinutes,
  readLocale,
  readQuietHours,
} from "./config.ts";
import { messagesFor, type Messages } from "./i18n.ts";
import type { Log } from "./log.ts";
import {
  LAST_PROMPT_FILE,
  conversationOnTelegram,
  readPingTimestamp,
} from "./waiting-ping.ts";

export const LAST_ACTIVITY_FILE = "last-activity";

interface PendingPermission {
  createdAt: number;
  send: () => void;
}

interface PermissionDelayOptions {
  appDir: string;
  now?: () => number;
  log?: Log;
  messages?: () => Messages;
}

export interface PermissionDelay {
  defer: (requestId: string, send: () => void) => void;
  tick: () => void;
  pendingCount: () => number;
}

export function resolvedInTerminal(
  createdAt: number,
  lastActivityAt: number | null,
  lastPromptAt: number | null,
): boolean {
  return Math.max(lastActivityAt ?? 0, lastPromptAt ?? 0) > createdAt;
}

export function createPermissionDelay({
  appDir,
  now = Date.now,
  log = (): void => {},
  messages = (): Messages => messagesFor(readLocale(appDir)),
}: PermissionDelayOptions): PermissionDelay {
  const pending = new Map<string, PendingPermission>();

  function defer(requestId: string, send: () => void): void {
    const onTelegram = conversationOnTelegram(appDir);

    if (onTelegram && !isQuietTime(new Date(now()), readQuietHours(appDir))) {
      send();
      log(messages().permissionSentNow(requestId));

      return;
    }

    pending.set(requestId, { createdAt: now(), send });
  }

  function tick(): void {
    const current = now();
    const delayMs = readDelayMinutes(appDir) * 60_000;
    const quiet = isQuietTime(new Date(current), readQuietHours(appDir));
    const lastActivityAt = readPingTimestamp(appDir, LAST_ACTIVITY_FILE);
    const lastPromptAt = readPingTimestamp(appDir, LAST_PROMPT_FILE);

    for (const [requestId, permission] of pending) {
      if (
        resolvedInTerminal(permission.createdAt, lastActivityAt, lastPromptAt)
      ) {
        pending.delete(requestId);
        log(messages().permissionResolvedInTerminal(requestId));
        continue;
      }

      if (current - permission.createdAt < delayMs || quiet) continue;

      pending.delete(requestId);
      permission.send();
      log(messages().permissionSent(requestId));
    }
  }

  return { defer, tick, pendingCount: (): number => pending.size };
}
