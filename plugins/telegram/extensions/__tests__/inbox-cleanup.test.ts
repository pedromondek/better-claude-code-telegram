import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanInbox } from "../inbox-cleanup.ts";

const fs = vi.hoisted(() => ({ goneAfterCheck: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();

  return {
    ...actual,
    readdirSync: vi.fn<typeof actual.readdirSync>(actual.readdirSync),
    statSync: ((path: string): Fs.Stats => {
      const stats = actual.statSync(path);

      if (path === fs.goneAfterCheck) actual.rmSync(path);

      return stats;
    }) as typeof actual.statSync,
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12);

let stateDir = "";

function inbox(): string {
  return join(stateDir, "inbox");
}

function receive(name: string, ageDays: number): void {
  const file = join(inbox(), name);
  const modified = new Date(NOW - ageDays * DAY_MS);

  writeFileSync(file, "x");
  utimesSync(file, modified, modified);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bcct-inbox-"));
  mkdirSync(inbox());
});

afterEach(() => {
  fs.goneAfterCheck = "";
  rmSync(stateDir, { recursive: true, force: true });
});

describe("cleanInbox", () => {
  it("deletes the received files older than the retention and keeps the newer ones", (): void => {
    receive("old-photo.jpg", 8);
    receive("old-doc.pdf", 7.5);
    receive("new-photo.jpg", 2);

    expect(cleanInbox(stateDir, 7, NOW)).toBe(2);
    expect(readdirSync(inbox())).toEqual(["new-photo.jpg"]);
  });

  it("keeps the file received exactly at the limit of the retention", (): void => {
    receive("limit-photo.jpg", 7);

    expect(cleanInbox(stateDir, 7, NOW)).toBe(0);
    expect(readdirSync(inbox())).toEqual(["limit-photo.jpg"]);
  });

  it("goes on cleaning when a file is removed by someone else right after its check", (): void => {
    receive("gone.jpg", 8);
    receive("old-photo.jpg", 8);
    fs.goneAfterCheck = join(inbox(), "gone.jpg");
    vi.mocked(readdirSync).mockReturnValueOnce([
      "gone.jpg",
      "old-photo.jpg",
    ] as unknown as ReturnType<typeof readdirSync>);

    cleanInbox(stateDir, 7, NOW);

    expect(readdirSync(inbox())).toEqual([]);
  });

  it("keeps everything when the retention is off", (): void => {
    receive("old-photo.jpg", 400);

    expect(cleanInbox(stateDir, null, NOW)).toBe(0);
    expect(readdirSync(inbox())).toEqual(["old-photo.jpg"]);
  });

  it("leaves folders inside the inbox alone", (): void => {
    mkdirSync(join(inbox(), "album"));
    const old = new Date(NOW - 30 * DAY_MS);

    utimesSync(join(inbox(), "album"), old, old);

    expect(cleanInbox(stateDir, 7, NOW)).toBe(0);
    expect(readdirSync(inbox())).toEqual(["album"]);
  });

  it("does nothing when the inbox does not exist yet", (): void => {
    rmSync(inbox(), { recursive: true });

    expect(cleanInbox(stateDir, 7, NOW)).toBe(0);
  });
});
