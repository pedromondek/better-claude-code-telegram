import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderChoices, selectOnTerminal } from "../select.mjs";

const CHOICES = [
  { label: "off", value: null },
  { label: "base", hint: "fastest", value: "base" },
  { label: "medium", hint: "most accurate", value: "medium" },
];

function fakeTerminal(columns = 80) {
  const input = new PassThrough();
  const written = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });

  input.isTTY = true;
  input.setRawMode = vi.fn();
  output.columns = columns;

  return { input, output, written };
}

function select(terminal, index = 1, title = "Model?") {
  return selectOnTerminal({
    title,
    choices: CHOICES,
    index,
    hint: "↑/↓ · Enter",
    cancelled: "Cancelled.",
    input: terminal.input,
    output: terminal.output,
  });
}

beforeEach(() => {
  vi.stubEnv("NO_COLOR", "1");
  vi.stubEnv("FORCE_COLOR", undefined);
});

describe("renderChoices", () => {
  it("points at the chosen line and lines up the hints", () => {
    expect(
      renderChoices({ choices: CHOICES, index: 1, hint: "↑/↓ · Enter" }),
    ).toEqual([
      "  off",
      "❯ base    fastest",
      "  medium  most accurate",
      "↑/↓ · Enter",
    ]);
  });

  it("paints the chosen line and dims the hints", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);

    const lines = renderChoices({ choices: CHOICES, index: 2, hint: "keys" });

    expect(lines[2]).toBe(
      "\u001B[36m\u001B[1m❯ medium\u001B[22m\u001B[39m  \u001B[2mmost accurate\u001B[22m",
    );
    expect(lines[3]).toBe("\u001B[2mkeys\u001B[22m");
    expect(stripVTControlCharacters(lines[0])).toBe("  off");
  });

  it("paints the choice made before in green while the pointer is elsewhere", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);

    const choices = [
      { label: "off", value: null },
      { label: "base", hint: "fastest", value: "base", previous: true },
    ];
    const away = renderChoices({ choices, index: 0, hint: "k" });
    const on = renderChoices({ choices, index: 1, hint: "k" });

    expect(away[1]).toBe(
      "\u001B[32m  base\u001B[39m  \u001B[2mfastest\u001B[22m",
    );
    expect(on[1]).toBe(
      "\u001B[36m\u001B[1m❯ base\u001B[22m\u001B[39m  \u001B[2mfastest\u001B[22m",
    );
  });

  it("cuts every line short of the edge so none of them can wrap", () => {
    const lines = renderChoices({
      choices: CHOICES,
      index: 2,
      hint: "↑/↓ · Enter to confirm",
      columns: 12,
    });

    expect(lines).toEqual([
      "  off",
      "  base    …",
      "❯ medium  …",
      "↑/↓ · Ente…",
    ]);
    expect(lines.every((line) => [...line].length <= 11)).toBe(true);
  });

  it("counts an emoji as two columns when cutting", () => {
    expect(
      renderChoices({
        choices: [{ label: "📱 phone line", value: 1 }],
        index: 0,
        hint: "k",
        columns: 9,
      })[0],
    ).toBe("❯ 📱 ph…");
  });
});

describe("selectOnTerminal", () => {
  it("starts on the given choice and Enter confirms it", async () => {
    const terminal = fakeTerminal();
    const answer = select(terminal, 1);

    terminal.input.write("\r");

    await expect(answer).resolves.toBe("base");
    expect(terminal.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("shows headings without a pointer and skips them when moving", async () => {
    const terminal = fakeTerminal();
    const choices = [
      { label: "off", value: null },
      { label: "Installed:", heading: true },
      { label: "base", value: "base" },
    ];
    const answer = selectOnTerminal({
      title: "Model?",
      choices,
      index: 0,
      hint: "keys",
      cancelled: "Cancelled.",
      input: terminal.input,
      output: terminal.output,
    });

    terminal.input.write("\u001B[B");
    terminal.input.write("\r");

    await expect(answer).resolves.toBe("base");
    expect(renderChoices({ choices, index: 2, hint: "keys" })).toEqual([
      "  off",
      "Installed:",
      "❯ base",
      "keys",
    ]);
  });

  it("moves with the arrows and with j and k, wrapping at both ends", async () => {
    const terminal = fakeTerminal();
    const answer = select(terminal, 0);

    terminal.input.write("\u001B[A");
    terminal.input.write("k");
    terminal.input.write("\u001B[B");
    terminal.input.write("j");
    terminal.input.write("\u001B[B");
    terminal.input.write("\r");

    await expect(answer).resolves.toBe("base");
  });

  it("writes the title once and redraws only the choices, leaving the answer below the title", async () => {
    const terminal = fakeTerminal();
    const answer = select(terminal, 0);

    terminal.input.write("\u001B[B");
    terminal.input.write("\r");
    await answer;

    const output = terminal.written.join("");

    expect(output.startsWith("\u001B[?25lModel?\n")).toBe(true);
    expect(output.split("Model?")).toHaveLength(2);
    expect(output).toContain("\u001B[4A\r\u001B[0J");
    expect(output.endsWith("\u001B[4A\r\u001B[0J❯ base\n\u001B[?25h")).toBe(
      true,
    );
  });

  it("redraws the same number of lines whatever the title and the width", async () => {
    for (const [columns, title] of [
      [10, "Model?"],
      [80, "First line.\nSecond line, a much longer one than the terminal?"],
    ]) {
      const terminal = fakeTerminal(columns);
      const answer = select(terminal, 0, title);

      terminal.input.write("\r");
      await answer;

      expect(terminal.written.join("")).toContain("\u001B[4A\r\u001B[0J");
    }
  });

  it("cancels on Ctrl+C, giving the terminal back as it was", async () => {
    const terminal = fakeTerminal();
    const answer = select(terminal, 0);

    terminal.input.write("\u0003");

    await expect(answer).rejects.toMatchObject({
      message: "Cancelled.",
      cancelled: true,
    });
    expect(terminal.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(terminal.written.join("").endsWith("\u001B[?25h")).toBe(true);
    expect(terminal.input.listenerCount("keypress")).toBe(0);
  });
});
