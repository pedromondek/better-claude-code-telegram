import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HUSKY_HOOK_ARGS } from "./support/husky-hook.mjs";

const PROGRESS = join(import.meta.dirname, "..", "lib", "progress.sh");
const LABEL = "typecheck...";
const SLOW_TICK_SECONDS = 30;

const hasUtilLinuxScript =
  spawnSync("script", ["--version"], { encoding: "utf8" }).stdout?.includes(
    "util-linux",
  ) ?? false;

let workDir;

const COUNT_LINE = "(3/10) 30% [======              ] 100%";

function stepScript(childExitCode, seconds, count) {
  const path = join(workDir, "step.sh");
  const progressFile = join(workDir, "progress");
  const step = count
    ? `(printf '%s\\n' '${count}' > "${progressFile}"; sleep ${seconds}; exit ${childExitCode}) &`
    : `(sleep ${seconds}; exit ${childExitCode}) &`;
  writeFileSync(
    path,
    [
      `. "${PROGRESS}"`,
      step,
      count
        ? `if wait_step "$!" "${LABEL}" "${progressFile}"; then code=0; else code=$?; fi`
        : `if wait_step "$!" "${LABEL}"; then code=0; else code=$?; fi`,
      `echo "code=$code"`,
    ].join("\n"),
  );

  return path;
}

function runPiped(childExitCode, { seconds = 0.5, env = {}, count } = {}) {
  return spawnSync(
    "sh",
    [...HUSKY_HOOK_ARGS, stepScript(childExitCode, seconds, count)],
    { encoding: "utf8", env: { ...process.env, ...env } },
  ).stdout;
}

function runInTerminal(
  childExitCode,
  { seconds = 1, columns = 80, count } = {},
) {
  return spawnSync(
    "script",
    [
      "-qec",
      `stty cols ${columns}; sh -e ${stepScript(childExitCode, seconds, count)}`,
      "/dev/null",
    ],
    { encoding: "utf8" },
  ).stdout;
}

const CLEAR_LINE = "\u001b[2K";

function frames(raw) {
  return raw
    .split(/\r?\n/)
    .flatMap((line) => line.split("\r"))
    .map((frame) => frame.replaceAll(CLEAR_LINE, ""))
    .filter((frame) => frame !== "");
}

function screen(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.split("\r").at(-1).replaceAll(CLEAR_LINE, ""))
    .filter((line) => line !== "");
}

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bcct-progress-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("wait_step", () => {
  describe("exit code of the step", () => {
    it("returns 0 when the step passes", () => {
      expect(runPiped(0)).toMatch(/^code=0$/m);
    });

    it("returns the code of the step when it fails", () => {
      expect(runPiped(3)).toMatch(/^code=3$/m);
    });
  });

  describe("result of the step", () => {
    function run(lines) {
      return spawnSync("sh", ["-c", [`. "${PROGRESS}"`, ...lines].join("\n")], {
        encoding: "utf8",
      }).stdout;
    }

    it("keeps the total time of the step in seconds", () => {
      const output = run([
        "(sleep 1.2) &",
        'wait_step "$!" "step..." >/dev/null',
        'echo "elapsed=$progress_elapsed"',
      ]);

      expect(output).toMatch(/^elapsed=[12]$/m);
    });

    it("with a progress file, returns the final count and the total time, without estimate, after a space", () => {
      const file = join(workDir, "progress");
      writeFileSync(file, "20 20\n");

      expect(run([`progress_result "${file}" 42`])).toBe(
        ` (20/20) 100% [${"=".repeat(20)}] 100% • 42s`,
      );
    });

    it("with the step stopped halfway, shows how far it got, without estimate", () => {
      const file = join(workDir, "progress");
      writeFileSync(file, "5 20\n");

      expect(run([`progress_result "${file}" 30`])).toBe(
        ` (5/20) 25% [${"=".repeat(5)}${" ".repeat(15)}] 100% • 30s`,
      );
    });

    it("without a progress file, returns nothing", () => {
      expect(run([`progress_result "${join(workDir, "none")}" 30`])).toBe("");
    });
  });

  describe("output without a terminal", () => {
    it("announces the step in a single line when it ends before the first notice", () => {
      const output = runPiped(0);

      expect(occurrences(output, LABEL)).toBe(1);
      expect(output).not.toContain("\r");
    });

    it("returns as soon as the step ends, without waiting for the next notice", () => {
      const started = Date.now();
      runPiped(0, {
        seconds: 0.2,
        env: { PROGRESS_TICK_SECONDS: String(SLOW_TICK_SECONDS) },
      });

      expect(Date.now() - started).toBeLessThan((SLOW_TICK_SECONDS * 1000) / 2);
    });

    it("tells on a new line, at every interval, that the step is still running and for how long", () => {
      const output = runPiped(0, {
        seconds: 2.5,
        env: { PROGRESS_HEARTBEAT_SECONDS: "1" },
      });

      expect(output).toMatch(/^→ typecheck\.\.\.$/m);
      expect(output).toMatch(/^… typecheck\.\.\. 1s$/m);
      expect(output).toMatch(/^… typecheck\.\.\. 2s$/m);
      expect(output).not.toContain("\r");
    });

    it("with a progress file, every notice shows done/total, the percentage, the bar, the time and the estimated time left", () => {
      const output = runPiped(0, {
        seconds: 1.5,
        env: { PROGRESS_HEARTBEAT_SECONDS: "1" },
        count: "3 10",
      });

      expect(output.split("\n")).toContain(
        `… ${LABEL} ${COUNT_LINE} • 1s / ~2s left`,
      );
    });
  });

  describe("count line", () => {
    function countLine(...args) {
      return spawnSync(
        "sh",
        ["-c", `. "${PROGRESS}"; progress_count_line "$@"`, "sh", ...args],
        { encoding: "utf8" },
      ).stdout;
    }

    it("shows done/total, the percentage, the bar, the time and the time left estimated from the pace so far", () => {
      expect(countLine("10", "20", "60")).toBe(
        `(10/20) 50% [${"=".repeat(10)}${" ".repeat(10)}] 100% • 1m00s / ~1m00s left`,
      );
    });

    it("does not estimate the time left before the first item ends", () => {
      expect(countLine("0", "20", "5")).toBe(
        `(0/20) 0% [${" ".repeat(20)}] 100% • 5s`,
      );
    });

    it("fills the bar and does not estimate the time left when every item ended", () => {
      expect(countLine("20", "20", "42")).toBe(
        `(20/20) 100% [${"=".repeat(20)}] 100% • 42s`,
      );
    });

    it("caps a count above the total at the total", () => {
      expect(countLine("25", "20", "42")).toBe(
        `(20/20) 100% [${"=".repeat(20)}] 100% • 42s`,
      );
    });

    it("rounds the percentage and the bar down, so 100% only shows at the end", () => {
      expect(countLine("199", "200", "10")).toMatch(
        /^\(199\/200\) 99% \[={19} \]/,
      );
    });

    it("turns more than a minute into minutes and seconds", () => {
      expect(countLine("1", "2", "125")).toMatch(/ • 2m05s \/ ~2m05s left$/);
    });

    it("without estimate, shows only the time even with items missing", () => {
      expect(countLine("10", "20", "60", "no-estimate")).toBe(
        `(10/20) 50% [${"=".repeat(10)}${" ".repeat(10)}] 100% • 1m00s`,
      );
    });

    it.each([
      ["without a total", ["3", "0", "5"]],
      ["with a count that is not a number", ["a", "10", "5"]],
      ["with a total that is not a number", ["3", "x", "5"]],
      ["empty", ["", "", "5"]],
    ])("shows nothing with a count %s", (_label, args) => {
      expect(countLine(...args)).toBe("");
    });
  });

  describe.skipIf(!hasUtilLinuxScript)("output in a terminal", () => {
    it("animates the step with its time while it runs and leaves a single line when it ends", () => {
      const output = runInTerminal(0);
      const live = frames(output).filter(
        (frame) => frame.includes(LABEL) && !frame.startsWith("→"),
      );

      expect(live.length).toBeGreaterThanOrEqual(2);
      expect(live.at(-1)).toMatch(/^[|/\\-] typecheck\.\.\. \d\d:\d\d$/);
      expect(screen(output).filter((line) => line.includes(LABEL))).toEqual([
        `→ ${LABEL}`,
      ]);
    });

    it("cuts every frame at the terminal width, so the line never wraps into a new line on every frame", () => {
      const columns = 12;
      const live = frames(runInTerminal(0, { columns })).filter(
        (frame) => !frame.startsWith("→") && !frame.startsWith("code="),
      );

      expect(live.length).toBeGreaterThanOrEqual(2);
      expect(
        live.filter((frame) => Array.from(frame).length >= columns),
      ).toEqual([]);
    });

    it("returns the code of the step when it fails", () => {
      expect(runInTerminal(3)).toMatch(/^code=3\r?$/m);
    });

    it("with a progress file, animates done/total, the percentage and the bar after the time", () => {
      const output = runInTerminal(0, { count: "3 10", columns: 120 });
      const live = frames(output).filter(
        (frame) => frame.includes(LABEL) && !frame.startsWith("→"),
      );

      expect(live.length).toBeGreaterThanOrEqual(2);
      expect(
        live.at(-1).startsWith(`${live.at(-1)[0]} ${LABEL} ${COUNT_LINE} • `),
      ).toBe(true);
      expect(live.at(-1)).toMatch(/^[|/\\-] .* • \d+s( \/ ~\d+s left)?$/);
      expect(screen(output).filter((line) => line.includes(LABEL))).toEqual([
        `→ ${LABEL}`,
      ]);
    });
  });
});
