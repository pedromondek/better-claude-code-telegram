import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { readLocale, readTranscriptionSetting } from "./config.ts";
import { describeError, messagesFor, type Messages } from "./i18n.ts";
import type { Log } from "./log.ts";

export const TRANSCRIBE_SCRIPT = join(import.meta.dirname, "transcribe.py");
export const TRANSCRIPTION_MODELS = ["base", "small", "medium"] as const;

export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

const TRANSCRIBE_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);

type RunPython = (
  python: string,
  args: string[],
) => Promise<{ stdout: string }>;

interface TranscriberApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
  sendMessage(chatId: string, text: string): Promise<unknown>;
  sendChatAction(chatId: string, action: "typing"): Promise<unknown>;
}

interface TranscriberOptions {
  api: TranscriberApi;
  stateDir: string;
  appDir: string;
  allowedChats: () => string[];
  fileUrl: (filePath: string) => string;
  log: Log;
  fetchImpl?: typeof fetch;
  runPython?: RunPython;
  messages?: () => Messages;
}

export type Transcriber = (
  fileId: string,
  senderId: string,
) => Promise<string | null>;

export function whisperPython(appDir: string): string {
  return join(appDir, "whisper", "venv", "bin", "python");
}

function isTranscriptionModel(value: unknown): value is TranscriptionModel {
  return TRANSCRIPTION_MODELS.some((model) => model === value);
}

export function readTranscriptionModel(
  appDir: string,
): TranscriptionModel | null {
  const model = readTranscriptionSetting(appDir);

  return isTranscriptionModel(model) ? model : null;
}

export function formatTranscription(text: string, messages: Messages): string {
  return messages.transcriptionText(text);
}

function transcriptText(stdout: string): string {
  const output: unknown = JSON.parse(stdout);
  const text: unknown =
    output instanceof Object ? Reflect.get(output, "text") : null;

  return typeof text === "string" ? text.trim() : "";
}

const defaultRunPython: RunPython = (python, args) =>
  execFileAsync(python, args, {
    timeout: TRANSCRIBE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });

export function createTranscriber({
  api,
  stateDir,
  appDir,
  allowedChats,
  fileUrl,
  log,
  fetchImpl = fetch,
  runPython = defaultRunPython,
  messages = (): Messages => messagesFor(readLocale(appDir)),
}: TranscriberOptions): Transcriber {
  const inboxDir = join(stateDir, "inbox");

  try {
    for (const name of readdirSync(inboxDir)) {
      if (/^voice-\d+\.ogg$/.test(name)) {
        rmSync(join(inboxDir, name), { force: true });
      }
    }
  } catch {}

  async function download(fileId: string): Promise<string | null> {
    const file = await api.getFile(fileId);

    if (!file.file_path) return null;

    const response = await fetchImpl(fileUrl(file.file_path));

    if (!response.ok) return null;

    const target = join(inboxDir, `voice-${Date.now()}.ogg`);

    mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    writeFileSync(target, Buffer.from(await response.arrayBuffer()), {
      mode: 0o600,
    });

    return target;
  }

  return async function transcribe(
    fileId: string,
    senderId: string,
  ): Promise<string | null> {
    const model = readTranscriptionModel(appDir);
    const python = whisperPython(appDir);

    if (!model || !allowedChats().includes(senderId) || !existsSync(python)) {
      return null;
    }

    const text = messages();
    let audioPath: string | null = null;

    try {
      await api.sendChatAction(senderId, "typing").catch(() => undefined);
      audioPath = await download(fileId);

      if (!audioPath) throw new Error(text.audioUnavailable);

      const { stdout } = await runPython(python, [
        TRANSCRIBE_SCRIPT,
        "--model",
        model,
        "--language",
        text.whisperLanguage,
        audioPath,
      ]);
      const transcript = transcriptText(stdout);

      if (!transcript) throw new Error(text.emptyTranscription);

      log(text.transcribed(model, transcript));

      return transcript;
    } catch (error) {
      log(text.transcriptionFailed(describeError(error)));
      await api
        .sendMessage(senderId, text.transcriptionFailedChat)
        .catch(() => undefined);

      return null;
    } finally {
      if (audioPath) rmSync(audioPath, { force: true });
    }
  };
}
