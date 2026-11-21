import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { commandExists, runCommand } from "../command.ts";

describe("commandExists", () => {
  it("finds a command on the PATH and refuses a missing one", (): void => {
    expect(commandExists("sh")).toBe(true);
    expect(commandExists("bcct-no-such-command")).toBe(false);
  });

  it("asks where on Windows instead of the shell", (): void => {
    expect(commandExists("sh", "win32")).toBe(false);
  });

  it("runs where with the command name and no output on Windows", (): void => {
    const bin = mkdtempSync(join(tmpdir(), "bcct-where-"));

    writeFileSync(
      join(bin, "where"),
      [
        "#!/bin/sh",
        '[ "$1" = "ffmpeg" ] || exit 1',
        '[ "$(readlink /proc/$$/fd/1)" = /dev/null ] || exit 1',
        "echo found",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);

    try {
      expect(commandExists("ffmpeg", "win32")).toBe(true);
      expect(commandExists("other", "win32")).toBe(false);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("runCommand", () => {
  it("returns the exit code of the command", (): void => {
    expect(runCommand("sh", ["-c", "exit 0"])).toBe(0);
    expect(runCommand("sh", ["-c", "exit 3"])).toBe(3);
  });

  it("gives the command no input, hides its output and shows its errors on the terminal of the script", (): void => {
    const stdioOfTheCommand = [
      '[ "$(readlink /proc/$$/fd/0)" = /dev/null ]',
      '[ "$(readlink /proc/$$/fd/1)" = /dev/null ]',
      '[ "$(readlink /proc/$$/fd/2)" = "$(readlink /proc/$PPID/fd/2)" ]',
    ].join(" && ");

    expect(runCommand("sh", ["-c", stdioOfTheCommand])).toBe(0);
  });
});
