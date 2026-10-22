import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_FILE } from "../config.ts";
import { MESSAGES, type Messages } from "../i18n.ts";
import {
  createPermissionDelay,
  resolvedInTerminal,
  type PermissionDelay,
} from "../permission-delay.ts";

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const DEFAULT_DELAY = 240_000;
const PT = MESSAGES["pt-br"];
const EN = MESSAGES["en-us"];

let appDir = "";
let clock = NOW;

function writeStamp(name: string, value: number): void {
  mkdirSync(join(appDir, "pings"), { recursive: true });
  writeFileSync(join(appDir, "pings", name), String(value));
}

function writeConfig(content: unknown): void {
  writeFileSync(join(appDir, CONFIG_FILE), JSON.stringify(content));
}

function setup(messages?: () => Messages): {
  sent: string[];
  logs: string[];
  delay: PermissionDelay;
  defer: (id: string) => void;
} {
  const sent: string[] = [];
  const logs: string[] = [];
  const delay = createPermissionDelay({
    appDir,
    now: () => clock,
    log: (message) => logs.push(message),
    ...(messages ? { messages } : {}),
  });

  return {
    sent,
    logs,
    delay,
    defer: (id) => delay.defer(id, () => sent.push(id)),
  };
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "bcct-permission-delay-"));
  clock = NOW;
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

describe("resolvedInTerminal", () => {
  it("is true when there was terminal activity or typing after the request", (): void => {
    expect(resolvedInTerminal(100, null, null)).toBe(false);
    expect(resolvedInTerminal(100, 101, null)).toBe(true);
    expect(resolvedInTerminal(100, null, 150)).toBe(true);
    expect(resolvedInTerminal(100, 99, 50)).toBe(false);
  });

  it("is false when the terminal activity happened at the same instant as the request", (): void => {
    expect(resolvedInTerminal(100, 100, null)).toBe(false);
    expect(resolvedInTerminal(100, null, 100)).toBe(false);
  });
});

describe("createPermissionDelay", () => {
  it("only sends after the configured time", (): void => {
    const { sent, delay, defer } = setup();

    defer("abcde");
    clock = NOW + DEFAULT_DELAY - 1;
    delay.tick();
    expect(sent).toEqual([]);

    clock = NOW + DEFAULT_DELAY;
    delay.tick();
    expect(sent).toEqual(["abcde"]);
    expect(delay.pendingCount()).toBe(0);
  });

  it("discards the request resolved in the terminal before the deadline", (): void => {
    const { sent, delay, defer } = setup();

    defer("abcde");
    writeStamp("last-activity", NOW + 10);
    clock = NOW + DEFAULT_DELAY;
    delay.tick();

    expect(sent).toEqual([]);
    expect(delay.pendingCount()).toBe(0);
  });

  it("sends right away when the conversation is already on Telegram", (): void => {
    writeStamp("last-prompt", NOW - 100);
    writeStamp("last-inbound", NOW - 50);
    const { sent, defer } = setup();

    defer("abcde");

    expect(sent).toEqual(["abcde"]);
  });

  it("holds during quiet hours and sends afterwards", (): void => {
    writeConfig({ quietHours: { start: "15:00", end: "16:00" } });
    const { sent, delay, defer } = setup();

    defer("abcde");
    clock = NOW + DEFAULT_DELAY;
    delay.tick();
    expect(sent).toEqual([]);

    clock = new Date(2026, 9, 17, 16, 0).getTime();
    delay.tick();
    expect(sent).toEqual(["abcde"]);
  });

  it("uses the delayMinutes of the config as the deadline", (): void => {
    writeConfig({ delayMinutes: 1 });
    const { sent, delay, defer } = setup();

    defer("abcde");
    clock = NOW + 59_999;
    delay.tick();
    expect(sent).toEqual([]);

    clock = NOW + 60_000;
    delay.tick();
    expect(sent).toEqual(["abcde"]);
  });
});

describe("createPermissionDelay log in pt-br", () => {
  it("logs the deferred send, sent now and resolved in the terminal with messages set to pt-br", (): void => {
    const deferred = setup(() => PT);

    deferred.defer("abcde");
    clock = NOW + DEFAULT_DELAY;
    deferred.delay.tick();
    expect(deferred.logs).toEqual(["permissão abcde: enviada ao Telegram"]);

    const resolved = setup(() => PT);

    resolved.defer("fghij");
    writeStamp("last-activity", clock + 10);
    resolved.delay.tick();
    expect(resolved.logs).toEqual([
      "permissão fghij: resolvida no terminal, não enviada",
    ]);

    writeStamp("last-prompt", clock - 100);
    writeStamp("last-inbound", clock - 50);
    const now = setup(() => PT);

    now.defer("klmno");
    expect(now.logs).toEqual([
      "permissão klmno: enviada na hora (conversa no Telegram)",
    ]);
  });

  it("follows the language of the config when messages is not given", (): void => {
    writeConfig({ language: "pt-br" });
    const { logs, delay, defer } = setup();

    defer("abcde");
    clock = NOW + DEFAULT_DELAY;
    delay.tick();

    expect(logs).toEqual(["permissão abcde: enviada ao Telegram"]);
  });
});

describe("createPermissionDelay log in en-us", () => {
  it("logs the deferred send, sent now and resolved in the terminal with messages set to en-us", (): void => {
    const deferred = setup(() => EN);

    deferred.defer("abcde");
    clock = NOW + DEFAULT_DELAY;
    deferred.delay.tick();
    expect(deferred.logs).toEqual(["permission abcde: sent to Telegram"]);

    const resolved = setup(() => EN);

    resolved.defer("fghij");
    writeStamp("last-activity", clock + 10);
    resolved.delay.tick();
    expect(resolved.logs).toEqual([
      "permission fghij: resolved in the terminal, not sent",
    ]);

    writeStamp("last-prompt", clock - 100);
    writeStamp("last-inbound", clock - 50);
    const now = setup(() => EN);

    now.defer("klmno");
    expect(now.logs).toEqual([
      "permission klmno: sent right away (conversation on Telegram)",
    ]);
  });

  it("falls back to en-us when there is no config and messages is not given", (): void => {
    const { logs, delay, defer } = setup();

    defer("abcde");
    clock = NOW + DEFAULT_DELAY;
    delay.tick();

    expect(logs).toEqual(["permission abcde: sent to Telegram"]);
  });
});
