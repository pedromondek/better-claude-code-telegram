import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createAskMirror, type AskMirror } from "./ask-mirror.ts";
import { defaultAppDir, readInboxRetentionDays, readLocale } from "./config.ts";
import { describeError, messagesFor, type Messages } from "./i18n.ts";
import { cleanInbox } from "./inbox-cleanup.ts";
import { createFileLog, writeHealth, type Log } from "./log.ts";
import { createPermissionDelay } from "./permission-delay.ts";
import { createQuietNotice } from "./quiet-notice.ts";
import { withReplyContext, type RepliedMessage } from "./reply-context.ts";
import { createTranscriber, formatTranscription } from "./transcription.ts";
import { createWaitingPing } from "./waiting-ping.ts";

type AskMirrorOptions = Parameters<typeof createAskMirror>[0];
type TranscriberOptions = Parameters<typeof createTranscriber>[0];

type ExtensionsOptions = Omit<
  AskMirrorOptions,
  "api" | "messages" | "appDir"
> & {
  api: AskMirrorOptions["api"] & TranscriberOptions["api"];
  stateDir: string;
  appDir?: string;
  fileUrl: (filePath: string) => string;
  isPolling: () => boolean;
};

export interface Extensions {
  start: () => void;
  log: Log;
  transcribe: (fileId: string, senderId: string) => Promise<string | null>;
  handleCallback: AskMirror["handleCallback"];
  consumeText: AskMirror["consumeText"];
  noteInbound: () => void;
  deferPermission: (requestId: string, send: () => void) => void;
  withReplyContext: (
    text: string,
    replied: RepliedMessage | undefined,
  ) => string;
}

const TICK_MS = 2000;
const INBOX_CLEANUP_MS = 60 * 60 * 1000;

export function createExtensions({
  isPolling,
  fileUrl,
  stateDir,
  appDir = defaultAppDir(),
  ...options
}: ExtensionsOptions): Extensions {
  const messages = (): Messages => messagesFor(readLocale(appDir));
  const log = createFileLog(appDir, options.log);
  const moduleOptions = { ...options, appDir, log, messages };
  const askMirror = createAskMirror(moduleOptions);
  const waitingPing = createWaitingPing(moduleOptions);
  const permissionDelay = createPermissionDelay(moduleOptions);
  const quietNotice = createQuietNotice({
    ...moduleOptions,
    held: () => ({
      questions: askMirror.held(),
      notices: waitingPing.held(),
      permissions: permissionDelay.held(),
    }),
  });
  const transcriber = createTranscriber({
    ...moduleOptions,
    stateDir,
    fileUrl,
  });

  function start(): void {
    for (const dir of ["asks", "pings"]) {
      mkdirSync(join(appDir, dir), { recursive: true, mode: 0o700 });
    }

    log(messages().extensionsStarted);

    const cleanup = (): void => {
      cleanInbox(stateDir, readInboxRetentionDays(appDir));
    };

    cleanup();
    setInterval(cleanup, INBOX_CLEANUP_MS).unref();

    const runModules = (): void => {
      askMirror
        .tick()
        .catch((error: unknown) =>
          log(messages().askCycleFailed(describeError(error))),
        );
      waitingPing
        .tick()
        .catch((error: unknown) =>
          log(messages().pingFailed(describeError(error))),
        );
      permissionDelay.tick();
    };

    setInterval(() => {
      writeHealth(appDir, isPolling());
      quietNotice
        .tick()
        .catch((error: unknown) =>
          log(messages().quietNoticeFailed(describeError(error))),
        )
        .finally(runModules);
    }, TICK_MS).unref();
  }

  async function transcribe(
    fileId: string,
    senderId: string,
  ): Promise<string | null> {
    const text = await transcriber(fileId, senderId);

    return text ? formatTranscription(text, messages()) : null;
  }

  return {
    start,
    log,
    transcribe,
    handleCallback: askMirror.handleCallback,
    consumeText: askMirror.consumeText,
    noteInbound: waitingPing.noteInbound,
    deferPermission: permissionDelay.defer,
    withReplyContext: (text, replied): string =>
      withReplyContext(text, replied, messages()),
  };
}
