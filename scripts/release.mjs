import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { messagesFor } from "../plugins/telegram-hooks/lib/messages.mjs";
import {
  defaultAppDir,
  readJsonFile,
  readLocale,
} from "../plugins/telegram-hooks/lib/state.mjs";

const SKIPPED_SUFFIXES = [".telegram.json", ".answer.json"];

function pendingAskIds(asksDir) {
  try {
    return readdirSync(asksDir)
      .filter(
        (name) =>
          name.endsWith(".json") &&
          !SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix)),
      )
      .map((name) => name.slice(0, -".json".length))
      .filter(
        (id) =>
          !existsSync(join(asksDir, `${id}.telegram.json`)) &&
          !existsSync(join(asksDir, `${id}.closed`)) &&
          !existsSync(join(asksDir, `${id}.answer.json`)),
      );
  } catch {
    return [];
  }
}

export function releasePendingAsks(appDir, sessionPrefix, now = Date.now()) {
  const asksDir = join(appDir, "asks");
  const released = [];

  for (const id of pendingAskIds(asksDir)) {
    const file = join(asksDir, `${id}.json`);
    const record = readJsonFile(file);

    if (
      typeof record?.id !== "string" ||
      typeof record.dueAt !== "number" ||
      record.dueAt <= now ||
      !String(record.sessionId ?? record.id).startsWith(sessionPrefix)
    ) {
      continue;
    }

    const temporary = `${file}.tmp`;

    writeFileSync(temporary, JSON.stringify({ ...record, dueAt: now }), {
      mode: 0o600,
    });
    renameSync(temporary, file);
    released.push(record);
  }

  return released;
}

function headersOf(record) {
  return (Array.isArray(record.questions) ? record.questions : [])
    .map((question) => question?.header ?? question?.question ?? "")
    .filter(Boolean)
    .join(", ");
}

function main(args) {
  const appDir = defaultAppDir();
  const messages = messagesFor(readLocale(appDir));
  const sessionPrefix = args[0]?.trim() ?? "";
  const released = releasePendingAsks(appDir, sessionPrefix);

  if (released.length === 0) {
    console.log(messages.nothingPending(sessionPrefix || null));
    return;
  }

  for (const record of released) {
    console.log(
      messages.questionReleased(
        record.instance ?? "telegram",
        headersOf(record),
      ),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
