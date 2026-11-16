import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { MESSAGES, type Messages } from "../i18n.ts";
import { createExtensions } from "../index.ts";
import { HEALTH_FILE, type Log } from "../log.ts";
import type * as TranscriptionModule from "../transcription.ts";

const EN = MESSAGES["en-us"];

interface ModuleOptions {
  appDir: string;
  log: Log;
  messages: () => Messages;
  allowedChats: () => string[];
  stateDir?: string;
  fileUrl?: (filePath: string) => string;
}

const modules = vi.hoisted(() => ({
  received: new Map<string, unknown>(),
  askTick: vi.fn<() => Promise<void>>(),
  pingTick: vi.fn<() => Promise<void>>(),
  permissionTick: vi.fn<() => void>(),
  quietTick: vi.fn<() => Promise<void>>(),
  askHeld: vi.fn<() => number>(),
  pingHeld: vi.fn<() => number>(),
  permissionHeld: vi.fn<() => number>(),
  handleCallback: vi.fn<() => Promise<boolean>>(),
  consumeText: vi.fn<() => Promise<boolean>>(),
  noteInbound: vi.fn<() => void>(),
  defer: vi.fn<() => void>(),
  transcriber: vi.fn<() => Promise<string | null>>(),
}));

type Module = Record<string, unknown>;

vi.mock("../ask-mirror.ts", () => ({
  createAskMirror: (options: unknown): Module => {
    modules.received.set("askMirror", options);

    return {
      tick: modules.askTick,
      held: modules.askHeld,
      handleCallback: modules.handleCallback,
      consumeText: modules.consumeText,
    };
  },
}));

vi.mock("../waiting-ping.ts", () => ({
  createWaitingPing: (options: unknown): Module => {
    modules.received.set("waitingPing", options);

    return {
      tick: modules.pingTick,
      held: modules.pingHeld,
      noteInbound: modules.noteInbound,
    };
  },
}));

vi.mock("../permission-delay.ts", () => ({
  createPermissionDelay: (options: unknown): Module => {
    modules.received.set("permissionDelay", options);

    return {
      tick: modules.permissionTick,
      held: modules.permissionHeld,
      defer: modules.defer,
    };
  },
}));

vi.mock("../quiet-notice.ts", () => ({
  createQuietNotice: (options: unknown): Module => {
    modules.received.set("quietNotice", options);

    return { tick: modules.quietTick };
  },
}));

vi.mock("../transcription.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof TranscriptionModule>()),
  createTranscriber: (options: unknown): typeof modules.transcriber => {
    modules.received.set("transcriber", options);

    return modules.transcriber;
  },
}));

function receivedBy(name: string): ModuleOptions {
  return modules.received.get(name) as ModuleOptions;
}

let stateDir = "";
let appDir = "";
let polling = true;
let echoed: string[] = [];

function build(
  folders: { appDir?: string } = { appDir },
): ReturnType<typeof createExtensions> {
  return createExtensions({
    ...folders,
    api: {
      sendMessage: () => Promise.resolve({ message_id: 1 }),
      editMessageReplyMarkup: () => Promise.resolve(),
      getFile: () => Promise.resolve({}),
      sendChatAction: () => Promise.resolve(),
    },
    stateDir,
    allowedChats: () => ["42"],
    isPolling: () => polling,
    fileUrl: (filePath) => `http://fake/${filePath}`,
    log: (message) => echoed.push(message),
  });
}

function health(): unknown {
  return JSON.parse(readFileSync(join(appDir, HEALTH_FILE), "utf8"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  stateDir = mkdtempSync(join(tmpdir(), "bcct-extensions-channel-"));
  appDir = mkdtempSync(join(tmpdir(), "bcct-extensions-app-"));
  polling = true;
  echoed = [];
  modules.received.clear();
  modules.askTick.mockResolvedValue();
  modules.pingTick.mockResolvedValue();
  modules.quietTick.mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
});

describe("createExtensions", () => {
  it("on start creates the asks and pings folders in the app folder, private to the user, and logs that it started", () => {
    build().start();

    for (const dir of ["asks", "pings"]) {
      expect(statSync(join(appDir, dir)).mode & 0o777).toBe(0o700);
    }
    expect(echoed).toEqual([EN.extensionsStarted]);
  });

  it("keeps every file of its own out of the channel folder, where the bot token lives", async () => {
    const extensions = build();

    extensions.start();
    extensions.log("hello");
    await vi.advanceTimersByTimeAsync(2000);

    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("on start also creates the app folder when it does not exist yet", () => {
    const newAppDir = join(appDir, "first-run", "app");

    build({ appDir: newAppDir }).start();

    expect(statSync(join(newAppDir, "asks")).isDirectory()).toBe(true);
    expect(statSync(join(newAppDir, "pings")).isDirectory()).toBe(true);
  });

  it("hands each module the app folder, the allowlist, the file log and the messages of the setup", () => {
    const extensions = build();

    for (const name of [
      "askMirror",
      "waitingPing",
      "permissionDelay",
      "transcriber",
    ]) {
      const options = receivedBy(name);

      expect(options.appDir).toBe(appDir);
      expect(options.allowedChats()).toEqual(["42"]);
      expect(options.log).toBe(extensions.log);
      expect(options.messages()).toBe(EN);
    }
  });

  it("hands the transcriber the channel folder and the file URL of Telegram", () => {
    build();

    const options = receivedBy("transcriber");

    expect(options.stateDir).toBe(stateDir);
    expect(options.fileUrl?.("voice/a.oga")).toBe("http://fake/voice/a.oga");
  });

  it("uses the default app folder when none is given", () => {
    vi.stubEnv("BETTER_CC_TELEGRAM_DIR", appDir);

    build({}).start();

    expect(statSync(join(appDir, "asks")).isDirectory()).toBe(true);
  });

  it("cleans the inbox of the channel on start and every hour, with the retention of the setup", () => {
    const inbox = join(stateDir, "inbox");
    const receiveOld = (name: string): void => {
      const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      writeFileSync(join(inbox, name), "x");
      utimesSync(join(inbox, name), old, old);
    };

    mkdirSync(inbox);
    writeFileSync(
      join(appDir, CONFIG_FILE),
      JSON.stringify({ inboxRetentionDays: 1 }),
    );
    receiveOld("first.jpg");

    const intervals = vi.spyOn(globalThis, "setInterval");

    build().start();

    expect(readdirSync(inbox)).toEqual([]);

    const [cleanupEveryHour] =
      intervals.mock.calls.find(([, delay]) => delay === 60 * 60 * 1000) ?? [];

    expect(cleanupEveryHour).toBeTypeOf("function");

    receiveOld("second.jpg");

    if (typeof cleanupEveryHour === "function") cleanupEveryHour();

    expect(readdirSync(inbox)).toEqual([]);
  });

  it("every two seconds writes the health of the polling and runs one cycle of each module", async () => {
    build().start();

    expect(existsSync(join(appDir, HEALTH_FILE))).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);

    expect(health()).toMatchObject({ polling: true, pid: process.pid });
    expect(modules.askTick).toHaveBeenCalledTimes(1);
    expect(modules.pingTick).toHaveBeenCalledTimes(1);
    expect(modules.permissionTick).toHaveBeenCalledTimes(1);

    polling = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(health()).toMatchObject({ polling: false });
    expect(modules.askTick).toHaveBeenCalledTimes(2);
  });

  it("runs the quiet notice first, so its summary reaches Telegram before the held items", async () => {
    const order: string[] = [];
    let finishQuiet = (): void => {};

    modules.quietTick.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push("quiet");
          finishQuiet = resolve;
        }),
    );
    modules.askTick.mockImplementation(() => {
      order.push("ask");

      return Promise.resolve();
    });
    modules.pingTick.mockImplementation(() => {
      order.push("ping");

      return Promise.resolve();
    });
    modules.permissionTick.mockImplementation(() => {
      order.push("permission");
    });
    build().start();

    await vi.advanceTimersByTimeAsync(2000);

    expect(order).toEqual(["quiet"]);

    finishQuiet();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(["quiet", "ask", "ping", "permission"]);
  });

  it("hands the quiet notice what the mirror, the pings and the permission delay hold", () => {
    modules.askHeld.mockReturnValue(2);
    modules.pingHeld.mockReturnValue(1);
    modules.permissionHeld.mockReturnValue(3);
    build();

    const options = receivedBy("quietNotice") as ModuleOptions & {
      held: () => unknown;
    };

    expect(options.held()).toEqual({
      questions: 2,
      notices: 1,
      permissions: 3,
    });
    expect(options.appDir).toBe(appDir);
    expect(options.allowedChats()).toEqual(["42"]);
  });

  it("logs a failed quiet notice and still runs the other cycles", async () => {
    modules.quietTick.mockRejectedValue(new Error("quiet boom"));
    build().start();

    await vi.advanceTimersByTimeAsync(2000);

    expect(echoed).toContain(EN.quietNoticeFailed("Error: quiet boom"));
    expect(modules.askTick).toHaveBeenCalledTimes(1);
    expect(modules.permissionTick).toHaveBeenCalledTimes(1);
  });

  it("logs a failed cycle of the mirror or of the pings and keeps going", async () => {
    modules.askTick.mockRejectedValue(new Error("ask boom"));
    modules.pingTick.mockRejectedValue(new Error("ping boom"));
    build().start();

    await vi.advanceTimersByTimeAsync(2000);

    expect(echoed).toEqual([
      EN.extensionsStarted,
      EN.askCycleFailed("Error: ask boom"),
      EN.pingFailed("Error: ping boom"),
    ]);
    expect(modules.permissionTick).toHaveBeenCalledTimes(1);
  });

  it("formats a transcription in the language of the setup and passes a missing one on as null", async () => {
    const extensions = build();

    modules.transcriber.mockResolvedValueOnce("Oi, Claude.");
    expect(await extensions.transcribe("file-1", "42")).toBe(
      EN.transcriptionText("Oi, Claude."),
    );

    modules.transcriber.mockResolvedValueOnce(null);
    expect(await extensions.transcribe("file-2", "42")).toBeNull();
  });

  it("hands the plugin the callback, text, inbound and permission handlers of the modules", () => {
    const extensions = build();

    expect(extensions.handleCallback).toBe(modules.handleCallback);
    expect(extensions.consumeText).toBe(modules.consumeText);
    expect(extensions.noteInbound).toBe(modules.noteInbound);
    expect(extensions.deferPermission).toBe(modules.defer);
  });

  it("adds the replied message to a reply in the language of the setup", () => {
    const extensions = build();

    expect(extensions.withReplyContext("ok", undefined)).toBe("ok");
    expect(
      extensions.withReplyContext("ok", {
        text: "Qual banco?",
        from: { is_bot: true },
      }),
    ).toBe(`${EN.replyHeader(true)}:\n«Qual banco?»\n\nok`);
  });

  it("logs to the file of the app folder and to the given log", () => {
    const extensions = build();

    extensions.log("hello");

    expect(echoed).toEqual(["hello"]);
    expect(
      readFileSync(join(appDir, "better-cc-telegram.log"), "utf8"),
    ).toContain("hello");
  });
});
