import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { playwrightChromium } from "./browser.ts";
import { cleanLeftovers, tempPrefix } from "./capture-leftovers.ts";
import { launchBrowser, type Browser, type CdpPage } from "./cdp.ts";
import { commandExists, runCommand } from "./command.ts";
import { defaultAppDir, readLocale } from "./config.ts";
import { describeError, messagesFor, type Messages } from "./i18n.ts";
import { captureShot, type Viewport } from "./page-actions.ts";
import { boardHtml } from "./page-board.ts";
import {
  parseCaptureSpec,
  SpecError,
  type Board,
  type CaptureSpec,
} from "./page-spec.ts";
import { FfmpegError, recordVideo } from "./page-video.ts";

export const CAPTURE_SCRIPT = fileURLToPath(import.meta.url);
export const BOARD_VIEWPORT: Viewport = { width: 1200, height: 100, scale: 2 };
export const FFMPEG = "ffmpeg";

export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

type StopSignal = keyof typeof SIGNAL_EXIT_CODES;

interface SignalSource {
  once: (signal: StopSignal, listener: () => void) => unknown;
  off: (signal: StopSignal, listener: () => void) => unknown;
}

interface CaptureOptions {
  messages?: Messages;
  chromium?: () => string | null;
  hasFfmpeg?: () => boolean;
  runFfmpeg?: (args: string[]) => number | null;
  launch?: (
    chromium: string,
    options: { signal: AbortSignal },
  ) => Promise<Browser>;
  cleanTemp?: () => unknown;
  signals?: SignalSource;
  exit?: (code: number) => void;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function captureCommand(): string {
  return `bun "${CAPTURE_SCRIPT}"`;
}

function readSpec(input: string, messages: Messages): CaptureSpec | string {
  const specPath = resolve(input);

  try {
    return parseCaptureSpec(readFileSync(specPath).toString(), specPath);
  } catch (error) {
    return error instanceof SpecError
      ? messages.captureInvalidSpec(error.message)
      : messages.captureFailed(describeError(error));
  }
}

async function captureBoard(
  page: CdpPage,
  board: Board,
  images: Map<string, string[]>,
  out: string,
): Promise<string[]> {
  const boardDir = mkdtempSync(join(tmpdir(), tempPrefix("board")));
  const html = join(boardDir, `${board.name}.html`);

  writeFileSync(html, boardHtml(board, images));

  try {
    return await captureShot(
      page,
      BOARD_VIEWPORT,
      {
        name: board.name,
        url: pathToFileURL(html).href,
        css: null,
        steps: [],
        outline: [],
        clip: null,
        fullPage: true,
      },
      out,
    );
  } finally {
    rmSync(boardDir, { recursive: true, force: true });
  }
}

async function captureAll(
  page: CdpPage,
  spec: CaptureSpec,
  runFfmpeg: (args: string[]) => number | null,
  out: (line: string) => void,
): Promise<void> {
  const viewport = {
    width: spec.width,
    height: spec.height,
    scale: spec.scale,
  };
  const images = new Map<string, string[]>();
  const report = (paths: string[]): void => {
    for (const path of paths) out(path);
  };

  for (const shot of spec.shots) {
    const paths = await captureShot(page, viewport, shot, spec.out);

    images.set(shot.name, paths);
    report(paths);
  }

  for (const video of spec.videos) {
    report(await recordVideo(page, viewport, video, spec.out, { runFfmpeg }));
  }

  if (spec.board !== null) {
    report(await captureBoard(page, spec.board, images, spec.out));
  }
}

export async function capturePage(
  input: string | undefined,
  {
    messages = messagesFor(readLocale(defaultAppDir())),
    chromium = playwrightChromium,
    hasFfmpeg = commandExists.bind(null, FFMPEG),
    runFfmpeg = runCommand.bind(null, FFMPEG),
    launch = launchBrowser,
    cleanTemp = cleanLeftovers,
    signals = process,
    exit = process.exit.bind(process),
    out = console.log.bind(console),
    err = console.error.bind(console),
  }: CaptureOptions = {},
): Promise<number> {
  if (!input) {
    err(messages.captureUsage(captureCommand()));

    return 1;
  }

  const spec = readSpec(input, messages);

  if (typeof spec === "string") {
    err(spec);

    return 1;
  }

  const executable = chromium();

  if (executable === null) {
    err(messages.captureMissingChromium);

    return 1;
  }

  if (spec.videos.length > 0 && !hasFfmpeg()) {
    err(messages.captureMissingFfmpeg);

    return 1;
  }

  let browser: Browser | null = null;
  const launching = new AbortController();
  const stops = (Object.keys(SIGNAL_EXIT_CODES) as StopSignal[]).map(
    (signal) => {
      const exitWithSignal = (): void => {
        exit(SIGNAL_EXIT_CODES[signal]);
      };
      const stop = (): void => {
        launching.abort();
        Promise.resolve(browser?.close()).then(exitWithSignal, exitWithSignal);
      };

      signals.once(signal, stop);

      return (): unknown => signals.off(signal, stop);
    },
  );

  try {
    cleanTemp();
    mkdirSync(spec.out, { recursive: true });
    browser = await launch(executable, { signal: launching.signal });
    await captureAll(await browser.newPage(), spec, runFfmpeg, out);

    return 0;
  } catch (error) {
    err(
      error instanceof FfmpegError
        ? messages.captureFfmpegFailed(error.outputPath)
        : messages.captureFailed(describeError(error)),
    );

    return 1;
  } finally {
    await browser?.close();

    for (const release of stops) release();
  }
}

export async function runAsScript(argv: string[]): Promise<void> {
  if (argv[1] === CAPTURE_SCRIPT) process.exitCode = await capturePage(argv[2]);
}

await runAsScript(process.argv);
