import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUST_DIR = join(import.meta.dirname, "..", "..", "rust");
const TESTS_DIR = join(RUST_DIR, "crates", "bcct", "tests");
const TERMINAL_CALL = /\bpty::record\(/u;
const TOP_LEVEL_FUNCTION = /^((?:#\[[^\n]*\]\n)*)fn (\w+)/gmu;
const NAMED_TEST = /test\(=(\w+)\)/gu;

function config() {
  return readFileSync(join(RUST_DIR, ".config", "nextest.toml"), "utf8");
}

function topLevelFunctions(source) {
  const starts = [...source.matchAll(TOP_LEVEL_FUNCTION)];

  return starts.map((start, index) => ({
    name: start[2],
    isTest: start[1].includes("#[test]") && !start[1].includes("#[ignore"),
    body: source.slice(start.index, starts[index + 1]?.index),
  }));
}

function callsAny(body, names) {
  return [...names].some((name) => new RegExp(`\\b${name}\\(`, "u").test(body));
}

function testsOpeningATerminal(source) {
  const functions = topLevelFunctions(source);
  const opening = new Set(
    functions
      .filter(({ body }) => TERMINAL_CALL.test(body))
      .map(({ name }) => name),
  );
  let grown = true;

  while (grown) {
    const callers = functions.filter(
      ({ name, body }) => !opening.has(name) && callsAny(body, opening),
    );

    for (const { name } of callers) opening.add(name);
    grown = callers.length > 0;
  }

  return functions
    .filter(({ name, isTest }) => isTest && opening.has(name))
    .map(({ name }) => name)
    .toSorted();
}

describe("nextest-config", () => {
  it("runs the tests that open a terminal one at a time in the terminal group", () => {
    expect(config()).toContain(
      "[test-groups]\nterminal = { max-threads = 1 }\n",
    );
    expect(config().match(/test-group = 'terminal'/gu)).toHaveLength(2);
    expect(config()).toContain(
      "[[profile.default.overrides]]\nfilter = 'binary_id(bcct::setup_terminal_pty)'\ntest-group = 'terminal'\n",
    );
    expect(config()).toContain("binary_id(bcct::setup_run) & (");
  });

  it("puts every test of setup_run that opens a terminal in the group, and only those", () => {
    const source = readFileSync(join(TESTS_DIR, "setup_run.rs"), "utf8");
    const grouped = [...config().matchAll(NAMED_TEST)]
      .map((match) => match[1])
      .toSorted();

    expect(grouped).toContain(
      "gives_the_terminal_back_on_ctrl_z_and_goes_on_asking_after_fg",
    );
    expect(grouped).toEqual(testsOpeningATerminal(source));
  });

  it("finds a test that reaches the terminal through a helper, and skips the ignored drivers", () => {
    const source = [
      "fn opens(spec: &Value) -> String {",
      "    pty::record(&run)",
      "}",
      "",
      "#[test]",
      "fn through_the_helper() {",
      "    opens(&spec);",
      "}",
      "",
      "#[test]",
      '#[ignore = "runs inside the terminal"]',
      "fn driver() {",
      "    pty::record(&run);",
      "}",
      "",
      "#[test]",
      "fn without_a_terminal() {",
      "    reopens(&spec);",
      "}",
      "",
    ].join("\n");

    expect(testsOpeningATerminal(source)).toEqual(["through_the_helper"]);
  });
});
