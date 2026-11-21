import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOG_FILE = "better-cc-telegram.log";
export const HEALTH_FILE = "health.json";

export type Log = (message: string) => void;

const MAX_LOG_BYTES = 1024 * 1024;

export function createFileLog(
  appDir: string,
  echo: Log,
  now: () => Date = (): Date => new Date(),
): Log {
  const file = join(appDir, LOG_FILE);

  return function log(message: string): void {
    echo(message);

    try {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;

      const line = `${now().toISOString()} ${message}\n`;
      const privateFile = { mode: 0o600 };

      if (size > MAX_LOG_BYTES) {
        writeFileSync(file, line, privateFile);
      } else {
        appendFileSync(file, line, privateFile);
      }
    } catch {}
  };
}

export function writeHealth(
  appDir: string,
  polling: boolean,
  now: number = Date.now(),
): void {
  try {
    writeFileSync(
      join(appDir, HEALTH_FILE),
      JSON.stringify({ pid: process.pid, polling, checkedAt: now }),
      { mode: 0o600 },
    );
  } catch {}
}
