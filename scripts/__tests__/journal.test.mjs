import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJournal } from "../journal.mjs";

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-journal-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("createJournal", () => {
  it("starts empty", () => {
    const journal = createJournal();

    expect(journal.changes()).toEqual([]);
    expect(journal.undoAll()).toEqual([]);
  });

  it("brings a changed file back with its content and mode, and deletes a created one", () => {
    const journal = createJournal();
    const changed = join(workDir, "settings.json");
    const created = join(workDir, ".env");

    writeFileSync(changed, "before");
    chmodSync(changed, 0o640);

    journal.trackFile(changed);
    writeFileSync(changed, "after");
    chmodSync(changed, 0o600);
    journal.trackFile(created);
    writeFileSync(created, "token");

    expect(journal.changes()).toEqual([
      { kind: "fileChanged", target: changed },
      { kind: "fileCreated", target: created },
    ]);
    expect(journal.undoAll()).toEqual([]);
    expect(readFileSync(changed, "utf8")).toBe("before");
    expect(statSync(changed).mode & 0o777).toBe(0o640);
    expect(existsSync(created)).toBe(false);
  });

  it("keeps the first state of a file written many times", () => {
    const journal = createJournal();
    const file = join(workDir, "config.json");

    writeFileSync(file, "first");
    journal.trackFile(file);
    writeFileSync(file, "second");
    journal.trackFile(file);
    writeFileSync(file, "third");

    expect(journal.changes()).toHaveLength(1);

    journal.undoAll();

    expect(readFileSync(file, "utf8")).toBe("first");
  });

  it("removes a folder only when this run created it", () => {
    const journal = createJournal();
    const existing = join(workDir, "existing");
    const created = join(workDir, "created");

    mkdirSync(existing);
    journal.trackDir(existing);
    journal.trackDir(created);
    mkdirSync(created);
    writeFileSync(join(created, "file"), "x");

    expect(journal.changes()).toEqual([
      { kind: "dirCreated", target: created },
    ]);

    journal.undoAll();

    expect(existsSync(existing)).toBe(true);
    expect(existsSync(created)).toBe(false);
  });

  it("removes the parent folders created along with a folder, and nothing above them", () => {
    const journal = createJournal();
    const dir = join(workDir, "home", ".claude", "app");

    journal.trackDir(dir);
    mkdirSync(dir, { recursive: true });

    expect(journal.changes()).toEqual([
      { kind: "dirCreated", target: join(workDir, "home") },
    ]);

    journal.undoAll();

    expect(existsSync(join(workDir, "home"))).toBe(false);
    expect(existsSync(workDir)).toBe(true);
  });

  it("keeps the content a file had before the run, null when the run created it", () => {
    const journal = createJournal();
    const changed = join(workDir, "config.json");
    const created = join(workDir, "new.json");

    writeFileSync(changed, '{"a":1}');
    journal.trackFile(changed);
    writeFileSync(changed, '{"a":2}');
    journal.trackFile(created);

    expect(journal.original(changed)).toBe('{"a":1}');
    expect(journal.original(created)).toBeNull();
  });

  it("undoes in the reverse order and reports what it could not undo, once", () => {
    const journal = createJournal();
    const order = [];

    journal.record("pluginInstalled", "a", () => order.push("a"));
    journal.record("pluginInstalled", "b", () => {
      throw new Error("boom");
    });
    journal.record("toolInstalled", "bun", null);
    journal.record("marketplaceAdded", "m", () => order.push("m"));

    expect(journal.undoAll()).toEqual([
      { kind: "toolInstalled", target: "bun" },
      { kind: "pluginInstalled", target: "b" },
    ]);
    expect(order).toEqual(["m", "a"]);
    expect(journal.changes()).toEqual([]);
  });

  it("tells when it starts and finishes undoing each change, newest first", () => {
    const journal = createJournal();
    const events = [];

    journal.record("pluginInstalled", "a", () => events.push("undo a"));
    journal.record("pluginInstalled", "b", () => {
      throw new Error("boom");
    });

    journal.undoAll({
      onStart: ({ target }) => events.push(`start ${target}`),
      onDone: ({ target }, ok) => events.push(`done ${target} ${ok}`),
    });

    expect(events).toEqual([
      "start b",
      "done b false",
      "start a",
      "undo a",
      "done a true",
    ]);
  });

  it("does not stop undoing when one step fails", () => {
    const journal = createJournal();
    const undo = vi.fn();

    journal.record("pluginInstalled", "a", undo);
    journal.record("pluginInstalled", "b", () => {
      throw new Error("boom");
    });

    journal.undoAll();

    expect(undo).toHaveBeenCalledTimes(1);
  });
});
