import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  CDP_TIMEOUT_MS,
  CHROMIUM_ARGS,
  CLOSE_TIMEOUT_MS,
  cdpClient,
  inSeconds,
  launchBrowser,
  withTimeout,
  type SocketLike,
} from "../cdp.ts";

type Listener = (event: { data?: unknown }) => void;
type Responder = (
  message: Record<string, unknown>,
) => Record<string, unknown> | null;

class FakeSocket implements SocketLike {
  static last: FakeSocket | null = null;
  static respond: Responder = () => ({ result: {} });
  static fail = false;

  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.emit(FakeSocket.fail ? "error" : "open", {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    const reply = FakeSocket.respond(message);

    this.sent.push(message);

    if (reply) {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ id: message.id, ...reply }),
        });
      });
    }
  }

  close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface FakeChild extends EventEmitter {
  pid?: number;
  stderr: PassThrough;
  kill: Mock<() => boolean>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;

  child.stderr = new PassThrough();
  child.kill = vi.fn<() => boolean>();

  return child;
}

afterEach(() => {
  FakeSocket.last = null;
  FakeSocket.respond = (): Record<string, unknown> => ({ result: {} });
  FakeSocket.fail = false;
});

describe("cdpClient", () => {
  it("numbers each command, sends it with its session and resolves with its result", async (): Promise<void> => {
    const socket = new FakeSocket("ws://x");

    FakeSocket.respond = ({ method }): Record<string, unknown> => ({
      result: { echoed: method },
    });

    const client = cdpClient(socket);

    await expect(
      client.send("Page.navigate", { url: "about:blank" }, "s1"),
    ).resolves.toEqual({ echoed: "Page.navigate" });
    await expect(client.send("Page.enable")).resolves.toEqual({
      echoed: "Page.enable",
    });
    expect(socket.sent).toEqual([
      {
        id: 1,
        method: "Page.navigate",
        params: { url: "about:blank" },
        sessionId: "s1",
      },
      { id: 2, method: "Page.enable", params: {} },
    ]);
  });

  it("resolves with an empty result when the answer brings none", async (): Promise<void> => {
    FakeSocket.respond = (): Record<string, unknown> => ({});

    await expect(
      cdpClient(new FakeSocket("ws://x")).send("Page.enable"),
    ).resolves.toEqual({});
  });

  it("rejects with the method and the message of a failed command", async (): Promise<void> => {
    FakeSocket.respond = (): Record<string, unknown> => ({
      error: { message: "No node found" },
    });

    await expect(
      cdpClient(new FakeSocket("ws://x")).send("DOM.focus"),
    ).rejects.toThrow("DOM.focus: No node found");
  });

  it("delivers an event only to the waiter of the same session, once", async (): Promise<void> => {
    const socket = new FakeSocket("ws://x");
    const client = cdpClient(socket);
    const otherSession = vi.fn<(params: unknown) => void>();
    const loaded = client.once("Page.loadEventFired", "s1");

    const otherWaiter = client
      .once("Page.loadEventFired", "s2")
      .then(otherSession);
    socket.emit("message", {
      data: JSON.stringify({
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
        sessionId: "s1",
      }),
    });
    socket.emit("message", {
      data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "s1" }),
    });

    await expect(loaded).resolves.toEqual({ timestamp: 1 });
    await expect(
      Promise.race([
        otherWaiter.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).resolves.toBe("pending");
    expect(otherSession).not.toHaveBeenCalled();
  });

  it("resolves an event without params as empty", async (): Promise<void> => {
    const socket = new FakeSocket("ws://x");
    const loaded = cdpClient(socket).once("Page.loadEventFired");

    socket.emit("message", {
      data: JSON.stringify({ method: "Page.loadEventFired" }),
    });

    await expect(loaded).resolves.toEqual({});
  });

  it("ignores an answer to no pending command and a message that is not an object", async (): Promise<void> => {
    const socket = new FakeSocket("ws://x");
    const client = cdpClient(socket);

    socket.emit("message", { data: JSON.stringify({ id: 99, result: {} }) });
    socket.emit("message", { data: "[1]" });

    await expect(client.send("Page.enable")).resolves.toEqual({});
  });

  it("resolves with an empty result when the answer brings a result that is not an object", async (): Promise<void> => {
    FakeSocket.respond = (): Record<string, unknown> => ({ result: "text" });

    await expect(
      cdpClient(new FakeSocket("ws://x")).send("Page.enable"),
    ).resolves.toEqual({});
  });

  it("ignores a message that is JSON null or a plain value", (): void => {
    const socket = new FakeSocket("ws://x");

    cdpClient(socket);

    expect(() => {
      socket.emit("message", { data: "null" });
      socket.emit("message", { data: "5" });
    }).not.toThrow();
  });

  it("keeps a waiter pending while only events of another name arrive", async (): Promise<void> => {
    const socket = new FakeSocket("ws://x");
    const loaded = cdpClient(socket).once("Page.loadEventFired", "s1");

    socket.emit("message", {
      data: JSON.stringify({ method: "Page.frameNavigated", sessionId: "s1" }),
    });

    await expect(
      Promise.race([loaded, Promise.resolve("still waiting")]),
    ).resolves.toBe("still waiting");

    socket.emit("message", {
      data: JSON.stringify({
        method: "Page.loadEventFired",
        params: { timestamp: 2 },
        sessionId: "s1",
      }),
    });

    await expect(loaded).resolves.toEqual({ timestamp: 2 });
  });

  it("rejects the pending commands when the browser closes the connection", async (): Promise<void> => {
    FakeSocket.respond = (): null => null;

    const socket = new FakeSocket("ws://x");
    const pending = cdpClient(socket).send("Page.navigate");

    socket.close();

    await expect(pending).rejects.toThrow("Page.navigate: the browser closed");
  });
});

describe("withTimeout", () => {
  it("gives up after the time with the message and keeps the value of a promise in time", async (): Promise<void> => {
    await expect(
      withTimeout(new Promise(() => undefined), 10, "too slow"),
    ).rejects.toThrow("too slow");
    await expect(withTimeout(Promise.resolve(7), 10, "too slow")).resolves.toBe(
      7,
    );
  });

  it("clears its timer once the promise settles", async (): Promise<void> => {
    vi.useFakeTimers();

    try {
      const value = withTimeout(Promise.resolve(1), 1000, "x");

      await vi.advanceTimersByTimeAsync(0);
      await expect(value).resolves.toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits 30 s for each command and writes the time in seconds", (): void => {
    expect(CDP_TIMEOUT_MS).toBe(30_000);
    expect(inSeconds(30_000)).toBe("30 s");
    expect(inSeconds(10)).toBe("0.01 s");
  });

  it("gives up a command the browser never answers", async (): Promise<void> => {
    FakeSocket.respond = (): null => null;

    await expect(
      cdpClient(new FakeSocket("ws://x"), 10).send("Page.navigate"),
    ).rejects.toThrow("Page.navigate: no answer in 0.01 s");
  });
});

describe("launchBrowser", () => {
  function launch(
    child: FakeChild,
    options: Parameters<typeof launchBrowser>[1] = {},
  ): ReturnType<typeof launchBrowser> {
    return launchBrowser("/cache/chrome", {
      spawnProcess: (command, args) => {
        launched.push([command, ...args]);

        return child;
      },
      Socket: FakeSocket,
      timeoutMs: 1000,
      closeTimeoutMs: 20,
      ...options,
    });
  }

  function exitOnBrowserClose(child: FakeChild): void {
    FakeSocket.respond = ({ method }): Record<string, unknown> => {
      if (method === "Browser.close") {
        queueMicrotask(() => {
          child.emit("exit", 0);
        });
      }

      return { result: {} };
    };
  }

  function profileOf(): string {
    return String(
      launched[0]
        .find((arg) => arg.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length),
    );
  }

  it("writes the pid of the Chromium in a profile named after this process", async (): Promise<void> => {
    const child = fakeChild();

    child.pid = 4321;

    const browser = launch(child);

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    expect(
      basename(profileOf()).startsWith(`bcct-capture-${process.pid}-`),
    ).toBe(true);
    expect(readFileSync(join(profileOf(), "chromium.pid"), "utf8")).toBe(
      "4321",
    );

    await opened.close();
  });

  it("writes no pid file when the Chromium has no pid", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child);

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    expect(existsSync(join(profileOf(), "chromium.pid"))).toBe(false);

    await opened.close();
  });

  it("gives up a page command after the command time of the launch", async (): Promise<void> => {
    FakeSocket.respond = (): null => null;

    const child = fakeChild();
    const browser = launch(child, { commandTimeoutMs: 10 });

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    await expect(opened.newPage()).rejects.toThrow(
      "Target.createTarget: no answer in 0.01 s",
    );

    await opened.close();
  });

  let launched: string[][] = [];

  afterEach(() => {
    launched = [];
  });

  it("starts the Chromium headless with its own profile and connects to the address it prints", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child);

    child.stderr.write("[warn] something\n");
    child.stderr.write(
      "DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n",
    );

    const opened = await browser;
    const [[command, ...args]] = launched;
    const profile = args.find((arg) => arg.startsWith("--user-data-dir="));

    expect(command).toBe("/cache/chrome");
    expect(args).toEqual(expect.arrayContaining([...CHROMIUM_ARGS]));
    expect(CHROMIUM_ARGS).toEqual([
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ]);
    expect(FakeSocket.last?.url).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc",
    );
    expect(existsSync(String(profile?.slice("--user-data-dir=".length)))).toBe(
      true,
    );

    await opened.close();

    expect(FakeSocket.last?.closed).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(String(profile?.slice("--user-data-dir=".length)))).toBe(
      false,
    );
  });

  it("opens a page in its own target and sends its commands and events through its session", async (): Promise<void> => {
    FakeSocket.respond = ({ method }): Record<string, unknown> => ({
      result:
        method === "Target.createTarget"
          ? { targetId: "t1" }
          : method === "Target.attachToTarget"
            ? { sessionId: "s9" }
            : {},
    });

    const child = fakeChild();
    const browser = launch(child);

    child.stderr.write("DevTools listening on ws://h/b\n");

    const page = await (await browser).newPage();
    const loaded = page.once("Page.loadEventFired");

    await page.send("Page.enable");
    FakeSocket.last?.emit("message", {
      data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "s9" }),
    });

    await expect(loaded).resolves.toEqual({});
    expect(
      FakeSocket.last?.sent.map(({ method, params, sessionId }) => ({
        method,
        params,
        sessionId,
      })),
    ).toEqual([
      {
        method: "Target.createTarget",
        params: { url: "about:blank" },
        sessionId: undefined,
      },
      {
        method: "Target.attachToTarget",
        params: { targetId: "t1", flatten: true },
        sessionId: undefined,
      },
      { method: "Page.enable", params: {}, sessionId: "s9" },
    ]);
  });

  it("fails and stops the Chromium when it exits before printing its address", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child);

    child.emit("exit", 1);

    await expect(browser).rejects.toThrow(
      "Chromium stopped before opening its DevTools address",
    );
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for the timeout once the address is printed", async (): Promise<void> => {
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const child = fakeChild();
    const browser = launch(child);

    child.stderr.write("DevTools listening on ws://h/b\n");
    await browser;

    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("fails with its own message when the Chromium has no stderr and exits", async (): Promise<void> => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn<() => boolean>(),
    }) as unknown as FakeChild;
    const browser = launch(child);

    child.emit("exit", 1);

    await expect(browser).rejects.toThrow(
      "Chromium stopped before opening its DevTools address",
    );
  });

  it("rejects with the same Error the Chromium reports", async (): Promise<void> => {
    const child = fakeChild();
    const failure = new Error("ENOENT");
    const browser = launch(child);

    child.emit("error", failure);

    await expect(browser).rejects.toBe(failure);
  });

  it("wraps a reported failure that is not an Error", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child);

    child.emit("error", "spawn failed");

    await expect(browser).rejects.toBeInstanceOf(Error);
    await expect(browser).rejects.toHaveProperty("message", "spawn failed");
  });

  it("names the profile folder after the capture and closes twice without failing", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child);

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;
    const profile = String(
      launched[0]
        .find((arg) => arg.startsWith("--user-data-dir="))
        ?.slice("--user-data-dir=".length),
    );

    expect(basename(profile).startsWith("bcct-capture-")).toBe(true);

    await opened.close();
    await expect(opened.close()).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(
      FakeSocket.last?.sent.filter(({ method }) => method === "Browser.close"),
    ).toHaveLength(1);
  });

  it("closes the Chromium through Browser.close and removes the profile once it exits", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child, { closeTimeoutMs: 5000 });

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    exitOnBrowserClose(child);
    await opened.close();

    expect(FakeSocket.last?.sent.map(({ method }) => method)).toEqual([
      "Browser.close",
    ]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(FakeSocket.last?.closed).toBe(true);
    expect(existsSync(profileOf())).toBe(false);
  });

  it("waits for the exit of the Chromium when Browser.close answers an error", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child, { closeTimeoutMs: 5000 });

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    FakeSocket.respond = (): Record<string, unknown> => {
      queueMicrotask(() => {
        child.emit("exit", 0);
      });

      return { error: { message: "Browser.close is not allowed" } };
    };
    await opened.close();

    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(profileOf())).toBe(false);
  });

  it("kills the Chromium that does not exit within the close time", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child, { closeTimeoutMs: 10 });

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    await opened.close();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(FakeSocket.last?.closed).toBe(true);
    expect(existsSync(profileOf())).toBe(false);
  });

  it("waits 5 s for the Chromium to close", (): void => {
    expect(CLOSE_TIMEOUT_MS).toBe(5000);
  });

  it("stops the Chromium and removes its profile when the launch is aborted", async (): Promise<void> => {
    const child = fakeChild();
    const launching = new AbortController();

    child.kill.mockImplementation((): boolean => {
      child.emit("exit", null);

      return true;
    });

    const browser = launch(child, { signal: launching.signal });

    launching.abort();

    expect(child.kill).toHaveBeenCalled();
    expect(existsSync(profileOf())).toBe(false);
    await expect(browser).rejects.toThrow(
      "Chromium stopped before opening its DevTools address",
    );
  });

  it("leaves the Chromium running when the abort comes after the launch", async (): Promise<void> => {
    const child = fakeChild();
    const launching = new AbortController();
    const browser = launch(child, { signal: launching.signal });

    child.stderr.write("DevTools listening on ws://h/b\n");

    const opened = await browser;

    launching.abort();

    expect(child.kill).not.toHaveBeenCalled();
    expect(existsSync(profileOf())).toBe(true);

    await opened.close();
  });

  it("fails and stops the Chromium when it cannot start", async (): Promise<void> => {
    const child = fakeChild();
    const browser = launch(child);

    child.emit("error", new Error("ENOENT"));

    await expect(browser).rejects.toThrow("ENOENT");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails and stops the Chromium when the address takes too long", async (): Promise<void> => {
    const child = fakeChild();

    await expect(launch(child, { timeoutMs: 10 })).rejects.toThrow(
      "Chromium took more than 10 ms to open its DevTools address",
    );
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails and stops the Chromium when the connection to its address fails", async (): Promise<void> => {
    FakeSocket.fail = true;

    const child = fakeChild();
    const browser = launch(child);

    child.stderr.write("DevTools listening on ws://h/b\n");

    await expect(browser).rejects.toThrow("could not connect to ws://h/b");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("launchBrowser › default process", () => {
  let dir = "";

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts the Chromium with no input and no output, and reads its address from stderr", async (): Promise<void> => {
    dir = mkdtempSync(join(tmpdir(), "bcct-fake-chromium-"));

    const chromium = join(dir, "chromium");

    writeFileSync(
      chromium,
      [
        "#!/bin/sh",
        '[ "$(readlink /proc/$$/fd/0)" = /dev/null ] || exit 1',
        '[ "$(readlink /proc/$$/fd/1)" = /dev/null ] || exit 1',
        'echo "DevTools listening on ws://h/b" >&2',
        "exec sleep 30",
      ].join("\n"),
      { mode: 0o755 },
    );

    const browser = await launchBrowser(chromium, {
      Socket: FakeSocket,
      timeoutMs: 5000,
      closeTimeoutMs: 10,
    });

    expect(FakeSocket.last?.url).toBe("ws://h/b");
    await browser.close();
  });
});
