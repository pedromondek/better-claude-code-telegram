import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const INBOX_FOLDER = "inbox";

const DAY_MS = 24 * 60 * 60 * 1000;

export function inboxDir(stateDir: string): string {
  return join(stateDir, INBOX_FOLDER);
}

export function cleanInbox(
  stateDir: string,
  retentionDays: number | null,
  now: number = Date.now(),
): number {
  if (retentionDays === null) return 0;

  const inbox = inboxDir(stateDir);
  const oldest = now - retentionDays * DAY_MS;
  let removed = 0;

  try {
    for (const name of readdirSync(inbox)) {
      const file = join(inbox, name);
      const stats = statSync(file);

      if (stats.isFile() && stats.mtimeMs < oldest) {
        rmSync(file, { force: true });
        removed += 1;
      }
    }
  } catch {}

  return removed;
}
