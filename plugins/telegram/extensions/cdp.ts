import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { CHROMIUM_PID_FILE, tempPrefix } from "./capture-leftovers.ts";

type CdpResult = Record<string, unknown>;

export interface SocketLike {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (
    type: "open" | "error" | "close" | "message",
    listener: (event: { data?: unknown }) => void,
  ) => void;
}

export interface CdpClient {
  send: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<CdpResult>;
  once: (event: string, sessionId?: string) => Promise<CdpResult>;
}

export interface CdpPage {
  send: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<CdpResult>;
  once: (event: string) => Promise<CdpResult>;
}

export interface Browser {
  newPage: () => Promise<CdpPage>;
  close: () => void;
}

interface ChildLike {
  pid?: number;
  stderr: Readable | null;
  kill: () => boolean;
  once: (event: "exit" | "error", listener: (error?: unknown) => void) => void;
}

interface LaunchOptions {
  spawnProcess?: (command: string, args: string[]) => ChildLike;
  Socket?: new (url: string) => SocketLike;
  timeoutMs?: number;
  commandTimeoutMs?: number;
}

interface PendingCommand {
  method: string;
  resolve: (result: CdpResult) => void;
  reject: (error: Error) => void;
}

interface EventWaiter {
  event: string;
  sessionId: string | undefined;
  resolve: (params: CdpResult) => void;
}

export const CHROMIUM_ARGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--mute-audio",
  "about:blank",
] as const;

const DEVTOOLS_ADDRESS = /^DevTools listening on (ws:\/\/\S+)/m;
const LAUNCH_TIMEOUT_MS = 15_000;

export const CDP_TIMEOUT_MS = 30_000;

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function inSeconds(milliseconds: number): string {
  return `${milliseconds / 1000} s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): CdpResult {
  return isRecord(value) ? value : {};
}

export function cdpClient(
  socket: SocketLike,
  timeoutMs: number = CDP_TIMEOUT_MS,
): CdpClient {
  const pending = new Map<number, PendingCommand>();
  const waiters: EventWaiter[] = [];
  let lastId = 0;

  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));

    if (!isRecord(message)) return;

    const command = pending.get(Number(message.id));

    if (command) {
      if (isRecord(message.error)) {
        command.reject(
          new Error(`${command.method}: ${String(message.error.message)}`),
        );
      } else {
        command.resolve(recordOf(message.result));
      }

      return;
    }

    const index = waiters.findIndex(
      (waiter) =>
        waiter.event === message.method &&
        waiter.sessionId === message.sessionId,
    );

    if (index >= 0)
      waiters.splice(index, 1)[0].resolve(recordOf(message.params));
  });
  socket.addEventListener("close", () => {
    for (const command of pending.values()) {
      command.reject(new Error(`${command.method}: the browser closed`));
    }
  });

  return {
    send(method, params = {}, sessionId): Promise<CdpResult> {
      lastId += 1;

      const id = lastId;

      return withTimeout(
        new Promise<CdpResult>((resolve, reject) => {
          pending.set(id, { method, resolve, reject });
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        }),
        timeoutMs,
        `${method}: no answer in ${inSeconds(timeoutMs)}`,
      );
    },
    once(event, sessionId): Promise<CdpResult> {
      return new Promise<CdpResult>((resolve) => {
        waiters.push({ event, sessionId, resolve });
      });
    },
  };
}

function devtoolsAddress(child: ChildLike, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Chromium took more than ${timeoutMs} ms to open its DevTools address`,
        ),
      );
    }, timeoutMs);
    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      finish();
    };

    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += String(chunk);

      const address = DEVTOOLS_ADDRESS.exec(output)?.[1];

      if (address) settle(() => resolve(address));
    });
    child.once("exit", () => {
      settle(() =>
        reject(
          new Error("Chromium stopped before opening its DevTools address"),
        ),
      );
    });
    child.once("error", (error) => {
      settle(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    });
  });
}

function openSocket(
  Socket: new (url: string) => SocketLike,
  address: string,
): Promise<SocketLike> {
  return new Promise<SocketLike>((resolve, reject) => {
    const socket = new Socket(address);

    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => {
      reject(new Error(`could not connect to ${address}`));
    });
  });
}

export async function launchBrowser(
  chromium: string,
  {
    spawnProcess = (command, args): ChildLike =>
      spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }),
    Socket = WebSocket,
    timeoutMs = LAUNCH_TIMEOUT_MS,
    commandTimeoutMs = CDP_TIMEOUT_MS,
  }: LaunchOptions = {},
): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), tempPrefix("capture")));
  const child = spawnProcess(chromium, [
    ...CHROMIUM_ARGS,
    `--user-data-dir=${profile}`,
  ]);

  if (child.pid !== undefined) {
    writeFileSync(join(profile, CHROMIUM_PID_FILE), String(child.pid));
  }
  const stop = (): void => {
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    const socket = await openSocket(
      Socket,
      await devtoolsAddress(child, timeoutMs),
    );
    const client = cdpClient(socket, commandTimeoutMs);

    return {
      async newPage(): Promise<CdpPage> {
        const { targetId } = await client.send("Target.createTarget", {
          url: "about:blank",
        });
        const { sessionId } = await client.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const session = String(sessionId);

        return {
          send: (method, params): Promise<CdpResult> =>
            client.send(method, params, session),
          once: (event): Promise<CdpResult> => client.once(event, session),
        };
      },
      close(): void {
        socket.close();
        stop();
      },
    };
  } catch (error) {
    stop();

    throw error;
  }
}
