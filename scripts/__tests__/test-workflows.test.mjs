import { describe, expect, it } from "vitest";

import {
  testWorkflows,
  vitestArguments,
  WORKFLOW_TESTS_DIR,
  WORKFLOWS_ROOT,
} from "../test-workflows.mjs";

function runWith({ present = true, result = { status: 0 } } = {}) {
  const calls = [];
  const lines = [];
  const checked = [];
  const code = testWorkflows({
    exists: (path) => {
      checked.push(path);

      return present;
    },
    run: (args) => {
      calls.push(args);

      return result;
    },
    log: (line) => lines.push(line),
  });

  return { code, calls, lines, checked };
}

describe("vitestArguments", () => {
  it("runs vitest once over the workflows folder, with that folder as the root", () => {
    expect(vitestArguments()).toEqual(["run", "--root", ".claude/workflows"]);
  });
});

describe("constants", () => {
  it("keeps the tests folder inside the workflows root", () => {
    expect(WORKFLOWS_ROOT).toBe(".claude/workflows");
    expect(WORKFLOW_TESTS_DIR).toBe(".claude/workflows/__tests__");
  });
});

describe("testWorkflows", () => {
  it("runs vitest when the tests folder exists and exits 0 when it passes", () => {
    const { code, calls, checked, lines } = runWith();

    expect(code).toBe(0);
    expect(checked).toEqual([".claude/workflows/__tests__"]);
    expect(calls).toEqual([["run", "--root", ".claude/workflows"]]);
    expect(lines).toEqual([]);
  });

  it("exits 1 when the tests fail", () => {
    const { code, calls } = runWith({ result: { status: 1 } });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("exits 1 when vitest was killed by a signal and has no status", () => {
    const { code } = runWith({ result: { status: null, signal: "SIGKILL" } });

    expect(code).toBe(1);
  });

  it("exits 1 and says why when vitest could not start", () => {
    const { code, lines } = runWith({
      result: { status: null, error: new Error("spawn ENOENT") },
    });

    expect(code).toBe(1);
    expect(lines).toEqual(["✗ vitest did not start: spawn ENOENT"]);
  });

  it("skips with a warning, without running vitest, when the folder does not exist", () => {
    const { code, calls, lines } = runWith({ present: false });

    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      "⚠ .claude/workflows/__tests__ does not exist in this clone: workflow tests skipped",
    ]);
  });
});
