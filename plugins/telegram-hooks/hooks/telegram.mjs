#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DELAY_MINUTES,
  defaultAppDir,
  readConfig,
  telegramStateDir,
} from "../lib/state.mjs";

const DEFAULT_DELAY_MS = DEFAULT_DELAY_MINUTES * 60_000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const LAST_PROMPT_FILE = "last-prompt";
const ANSWER_POLL_MS = 1000;
const SKIPPED_SUFFIXES = [".telegram.json", ".answer.json"];
const NOT_TYPED_PROMPT_PREFIXES = [
  "Another Claude session sent a message:",
  "<cross-session-message ",
  "[Cross-session ",
  '<channel source="plugin:telegram',
];

export function typedAtTerminal(prompt) {
  if (typeof prompt !== "string") return true;

  const start = prompt.trimStart();

  return !NOT_TYPED_PROMPT_PREFIXES.some((prefix) => start.startsWith(prefix));
}

async function readHookInput() {
  const chunks = [];

  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export function delayMs(env, config = readConfig(defaultAppDir(env))) {
  const rawDelay = env.BETTER_CC_TELEGRAM_DELAY_MS?.trim() ?? "";
  const fromEnv = Number(rawDelay);

  if (rawDelay !== "" && Number.isFinite(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }

  const minutes = Number(config?.delayMinutes);

  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60_000
    : DEFAULT_DELAY_MS;
}

function safeFileName(rawName) {
  return rawName.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}

export function telegramBotAlive(env, isAlive = processAlive) {
  try {
    const pid = Number(
      readFileSync(join(telegramStateDir(env), "bot.pid"), "utf8"),
    );

    return Number.isInteger(pid) && pid > 1 && isAlive(pid);
  } catch {
    return false;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function telegramActive(env, isAlive = processAlive) {
  return env.BETTER_CC_TELEGRAM === "1" || telegramBotAlive(env, isAlive);
}

function parseTranscript(transcriptText) {
  return transcriptText
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
}

export function contextBeforeTool(transcriptText) {
  const texts = [];

  for (const entry of parseTranscript(transcriptText).toReversed()) {
    if (entry?.type === "user") break;

    const content = entry?.type === "assistant" ? entry.message?.content : null;

    if (!Array.isArray(content)) continue;

    const blockTexts = content
      .filter((block) => block.type === "text" && block.text?.trim())
      .map((block) => block.text.trim());

    texts.unshift(...blockTexts);
  }

  return texts.length > 0 ? texts.join("\n\n") : null;
}

export function sessionNameFromTranscript(transcriptText) {
  const entries = parseTranscript(transcriptText);
  const latest = (type, field) =>
    entries.findLast((entry) => entry?.type === type && entry[field])?.[field];

  return (
    latest("agent-name", "agentName") ??
    latest("custom-title", "customTitle") ??
    latest("ai-title", "aiTitle") ??
    null
  );
}

export function instanceLabel(input, env, transcriptText) {
  if (env.BETTER_CC_TELEGRAM === "1") return null;

  const name = sessionNameFromTranscript(transcriptText);

  if (name) return name;

  const folder = input.cwd ? basename(input.cwd) : "claude";

  return `${folder}#${String(input.session_id ?? "").slice(0, 4)}`;
}

function readTranscriptTail(transcriptPath) {
  try {
    const buffer = readFileSync(transcriptPath);
    const tail = buffer.subarray(
      Math.max(0, buffer.length - TRANSCRIPT_TAIL_BYTES),
    );

    return tail.toString("utf8");
  } catch {
    return "";
  }
}

export function askIdFor(input, now) {
  return safeFileName(`${input.session_id ?? "session"}-${now}`);
}

export function buildAskRecord(
  input,
  env,
  now,
  { context = null, instance = null } = {},
) {
  const questions = input.tool_input?.questions;

  if (!Array.isArray(questions) || questions.length === 0) return null;

  return {
    id: askIdFor(input, now),
    sessionId: input.session_id ?? null,
    createdAt: now,
    dueAt: now + delayMs(env),
    instance,
    context,
    questions: questions.map((question) => ({
      question: String(question.question ?? ""),
      header: question.header,
      multiSelect: Boolean(question.multiSelect),
      options: (question.options ?? []).map((option) => ({
        label: String(option.label ?? ""),
        description: option.description,
        preview: option.preview,
      })),
    })),
  };
}

export function buildWaitingPing(input, env, now, instance = null) {
  const text = input.last_assistant_message;

  if (typeof text !== "string" || text.trim() === "") return null;

  return {
    sessionId: input.session_id ?? "session",
    createdAt: now,
    dueAt: now + delayMs(env),
    text: text.trim(),
    instance,
  };
}

export function permissionDecision(toolInput, answers) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedInput: { ...toolInput, answers },
      },
    },
  };
}

function readRecords(asksDir) {
  try {
    return readdirSync(asksDir)
      .filter(
        (name) =>
          name.endsWith(".json") &&
          !SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix)),
      )
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(asksDir, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((record) => typeof record?.id === "string");
  } catch {
    return [];
  }
}

function markClosed(asksDir, shouldClose) {
  for (const record of readRecords(asksDir)) {
    if (shouldClose(record)) {
      writeFileSync(join(asksDir, `${record.id}.closed`), "");
    }
  }
}

export async function waitForAnswer(
  asksDir,
  id,
  { pollMs = ANSWER_POLL_MS, wait = sleep } = {},
) {
  const answerFile = join(asksDir, `${id}.answer.json`);
  const closedFile = join(asksDir, `${id}.closed`);
  const recordFile = join(asksDir, `${id}.json`);

  while (true) {
    if (existsSync(closedFile) || !existsSync(recordFile)) return null;

    if (existsSync(answerFile)) {
      try {
        const { answers } = JSON.parse(readFileSync(answerFile, "utf8"));

        if (answers && typeof answers === "object") return answers;
      } catch {}
    }

    await wait(pollMs);
  }
}

export function handleTelegramEvent(mode, input, env, now) {
  if (!telegramActive(env)) return null;

  const appDir = defaultAppDir(env);
  const asksDir = join(appDir, "asks");
  const pingsDir = join(appDir, "pings");
  const pingFile = join(
    pingsDir,
    `${safeFileName(input.session_id ?? "session")}.json`,
  );
  const transcript = () =>
    input.transcript_path ? readTranscriptTail(input.transcript_path) : "";
  const sameSession = (record) =>
    record.sessionId === null ||
    record.sessionId === (input.session_id ?? null);

  if (mode === "permission") {
    const transcriptText = transcript();
    const record = buildAskRecord(input, env, now, {
      context: contextBeforeTool(transcriptText),
      instance: instanceLabel(input, env, transcriptText),
    });

    if (!record) return null;

    mkdirSync(asksDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(asksDir, `${record.id}.json`), JSON.stringify(record), {
      mode: 0o600,
    });
    return record;
  }

  if (mode === "stop") {
    const ping = buildWaitingPing(
      input,
      env,
      now,
      instanceLabel(input, env, transcript()),
    );

    if (!ping) return null;

    mkdirSync(pingsDir, { recursive: true, mode: 0o700 });
    writeFileSync(pingFile, JSON.stringify(ping), { mode: 0o600 });
    return null;
  }

  if (mode === "prompt" && !typedAtTerminal(input.prompt)) return null;

  if (mode === "prompt") {
    mkdirSync(pingsDir, { recursive: true, mode: 0o700 });
    rmSync(pingFile, { force: true });

    if (env.BETTER_CC_TELEGRAM === "1") {
      writeFileSync(join(pingsDir, LAST_PROMPT_FILE), String(now), {
        mode: 0o600,
      });
    }
  }

  if (mode === "post" || mode === "prompt") markClosed(asksDir, sameSession);

  return null;
}

async function main() {
  try {
    const mode = process.argv[2];
    const input = await readHookInput();
    const record = handleTelegramEvent(mode, input, process.env, Date.now());

    if (mode !== "permission" || !record) return;

    const answers = await waitForAnswer(
      join(defaultAppDir(process.env), "asks"),
      record.id,
    );

    if (answers) {
      process.stdout.write(
        JSON.stringify(permissionDecision(input.tool_input, answers)),
      );
    }
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
