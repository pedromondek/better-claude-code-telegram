import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { releasePendingAsks } from "../release.mjs";

const RELEASE = join(import.meta.dirname, "..", "release.mjs");
const NOW = 1_800_000_000_000;

let workDir;
let appDir;

function asksDir() {
  return join(appDir, "asks");
}

function writeAsk(
  id,
  { sessionId = "s1", dueAt = NOW + 60_000, instance = "api" } = {},
) {
  mkdirSync(asksDir(), { recursive: true });
  writeFileSync(
    join(asksDir(), `${id}.json`),
    JSON.stringify({
      id,
      sessionId,
      createdAt: NOW - 1000,
      dueAt,
      instance,
      context: null,
      questions: [{ question: "Qual banco?", header: "Banco", options: [] }],
    }),
  );
}

function readDueAt(id) {
  return JSON.parse(readFileSync(join(asksDir(), `${id}.json`), "utf8")).dueAt;
}

function runRelease(args = [], language = null) {
  if (language) {
    writeFileSync(
      join(appDir, "better-cc-telegram.json"),
      JSON.stringify({ language }),
    );
  }

  return spawnSync(process.execPath, [RELEASE, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: join(workDir, "home"),
      CLAUDE_CONFIG_DIR: join(workDir, "claude"),
      TELEGRAM_STATE_DIR: join(workDir, "channel"),
      BETTER_CC_TELEGRAM_DIR: appDir,
    },
    encoding: "utf8",
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-release-"));
  appDir = join(workDir, "app");
  mkdirSync(appDir);
  mkdirSync(join(workDir, "home"));
  mkdirSync(join(workDir, "claude"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("releasePendingAsks", () => {
  it("moves the dueAt of a pending question to now and returns it", () => {
    writeAsk("s1-1");

    const released = releasePendingAsks(appDir, "", NOW);

    expect(released.map((ask) => ask.id)).toEqual(["s1-1"]);
    expect(readDueAt("s1-1")).toBe(NOW);
  });

  it("keeps the file readable only by the user", () => {
    writeAsk("s1-1");

    releasePendingAsks(appDir, "", NOW);

    expect(statSync(join(asksDir(), "s1-1.json")).mode & 0o777).toBe(0o600);
  });

  it("only releases the questions of the sessions that start with the prefix", () => {
    writeAsk("abc-1", { sessionId: "abc" });
    writeAsk("xyz-1", { sessionId: "xyz" });

    const released = releasePendingAsks(appDir, "ab", NOW);

    expect(released.map((ask) => ask.id)).toEqual(["abc-1"]);
    expect(readDueAt("xyz-1")).toBe(NOW + 60_000);
  });

  it("skips a question that is already due, already sent, closed or answered", () => {
    writeAsk("due-1", { dueAt: NOW - 1 });
    writeAsk("sent-1");
    writeFileSync(join(asksDir(), "sent-1.telegram.json"), "{}");
    writeAsk("closed-1");
    writeFileSync(join(asksDir(), "closed-1.closed"), "");
    writeAsk("answered-1");
    writeFileSync(join(asksDir(), "answered-1.answer.json"), "{}");

    expect(releasePendingAsks(appDir, "", NOW)).toEqual([]);
    expect(readDueAt("sent-1")).toBe(NOW + 60_000);
  });

  it("ignores invalid records and a missing asks folder", () => {
    expect(releasePendingAsks(appDir, "", NOW)).toEqual([]);

    mkdirSync(asksDir(), { recursive: true });
    writeFileSync(join(asksDir(), "broken.json"), "{not json");

    expect(releasePendingAsks(appDir, "", NOW)).toEqual([]);
  });
});

describe("release.mjs as a command", () => {
  it("lists what it released in English by default", () => {
    writeAsk("s1-1");

    const result = runRelease();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Released the question from [api]: Banco");
  });

  it("lists what it released in Brazilian Portuguese when the setup chose pt-br", () => {
    writeAsk("s1-1");

    expect(runRelease([], "pt-br").stdout).toContain(
      "Pergunta de [api] solta: Banco",
    );
  });

  it("says nothing is pending, naming the prefix, in the configured language", () => {
    expect(runRelease(["abc"]).stdout).toContain(
      "No pending question from session abc.",
    );
    expect(runRelease([], "pt-br").stdout).toContain(
      "Nenhuma pergunta pendente.",
    );
  });
});
