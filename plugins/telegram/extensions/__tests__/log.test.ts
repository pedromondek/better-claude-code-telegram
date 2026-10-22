import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEALTH_FILE, LOG_FILE, createFileLog, writeHealth } from "../log.ts";

const FIXED = new Date("2026-10-17T22:00:00.000Z");

let appDir = "";

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "bcct-log-"));
});

afterEach(() => {
  rmSync(appDir, { recursive: true, force: true });
});

describe("LOG_FILE and HEALTH_FILE", () => {
  it("name the log better-cc-telegram.log and the health file health.json", (): void => {
    expect(LOG_FILE).toBe("better-cc-telegram.log");
    expect(HEALTH_FILE).toBe("health.json");
  });
});

describe("createFileLog", () => {
  it("echoes the message and appends it to better-cc-telegram.log with the time", (): void => {
    const echoed: string[] = [];
    const log = createFileLog(
      appDir,
      (message) => echoed.push(message),
      () => FIXED,
    );

    log("ask: question sent");
    log("ping: notice sent");

    expect(echoed).toEqual(["ask: question sent", "ping: notice sent"]);
    expect(readFileSync(join(appDir, "better-cc-telegram.log"), "utf8")).toBe(
      "2026-10-17T22:00:00.000Z ask: question sent\n2026-10-17T22:00:00.000Z ping: notice sent\n",
    );
  });

  it("creates the log private to the user", (): void => {
    const log = createFileLog(
      appDir,
      () => {},
      () => FIXED,
    );

    log("private");

    expect(statSync(join(appDir, "better-cc-telegram.log")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("truncates the file when it passes 1 MB", (): void => {
    writeFileSync(
      join(appDir, "better-cc-telegram.log"),
      "x".repeat(1024 * 1024 + 1),
    );
    const log = createFileLog(
      appDir,
      () => {},
      () => FIXED,
    );

    log("after truncating");

    expect(readFileSync(join(appDir, "better-cc-telegram.log"), "utf8")).toBe(
      "2026-10-17T22:00:00.000Z after truncating\n",
    );
  });

  it("keeps the file when it is exactly 1 MB", (): void => {
    writeFileSync(
      join(appDir, "better-cc-telegram.log"),
      "x".repeat(1024 * 1024),
    );
    const log = createFileLog(
      appDir,
      () => {},
      () => FIXED,
    );

    log("at the limit");

    const content = readFileSync(
      join(appDir, "better-cc-telegram.log"),
      "utf8",
    );

    expect(content.startsWith("xxx")).toBe(true);
    expect(content.endsWith("2026-10-17T22:00:00.000Z at the limit\n")).toBe(
      true,
    );
  });

  it("does not throw and still echoes when the folder does not exist", (): void => {
    const echoed: string[] = [];
    const log = createFileLog(join(appDir, "missing"), (message) =>
      echoed.push(message),
    );

    expect(() => log("no folder")).not.toThrow();
    expect(echoed).toEqual(["no folder"]);
  });
});

describe("writeHealth", () => {
  it("writes the pid, whether it is polling Telegram and the time", (): void => {
    writeHealth(appDir, true, 123);

    const written: unknown = JSON.parse(
      readFileSync(join(appDir, "health.json"), "utf8"),
    );

    expect(written).toEqual({
      pid: process.pid,
      polling: true,
      checkedAt: 123,
    });
  });

  it("creates the health file private to the user", (): void => {
    writeHealth(appDir, true, 123);

    expect(statSync(join(appDir, "health.json")).mode & 0o777).toBe(0o600);
  });

  it("writes polling false", (): void => {
    writeHealth(appDir, false, 456);

    const written: unknown = JSON.parse(
      readFileSync(join(appDir, "health.json"), "utf8"),
    );

    expect(written).toEqual({
      pid: process.pid,
      polling: false,
      checkedAt: 456,
    });
  });

  it("does not throw when the folder does not exist", (): void => {
    expect(() => writeHealth(join(appDir, "missing"), true, 1)).not.toThrow();
  });
});
