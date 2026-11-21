import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import {
  code,
  fail,
  info,
  link,
  newValue,
  note,
  pending,
  question,
  skipped,
  stepHeading,
  success,
  warn,
} from "../ui.mjs";

function fakeOutput(isTTY, columns = 80) {
  const written = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });

  output.isTTY = isTTY;
  output.columns = columns;
  output.getColorDepth = () => 1;

  return { output, written };
}

describe("link and code", () => {
  it("paints a link blue and underlined, and a code bold", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);

    expect(link("https://t.me/x")).toBe(
      "\u001B[34m\u001B[4mhttps://t.me/x\u001B[24m\u001B[39m",
    );
    expect(code("c0de")).toBe("\u001B[1mc0de\u001B[22m");
  });

  it("keeps them as they are without colors", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);

    expect(link("https://t.me/x")).toBe("https://t.me/x");
    expect(code("c0de")).toBe("c0de");
  });
});

describe("info and newValue", () => {
  it("paints an instruction or a topic blue, and a value just set green", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);

    expect(info("To do it by hand, run:")).toBe(
      "\u001B[34mTo do it by hand, run:\u001B[39m",
    );
    expect(newValue("pt-br")).toBe("\u001B[32mpt-br\u001B[39m");
  });

  it("keeps them as they are without colors", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);

    expect(info("To do it by hand, run:")).toBe("To do it by hand, run:");
    expect(newValue("pt-br")).toBe("pt-br");
  });
});

function fileOutput() {
  const dir = mkdtempSync(join(tmpdir(), "ui-spinner-"));
  const file = join(dir, "terminal");
  const fd = openSync(file, "w");
  const output = new Writable({
    write(chunk, _encoding, done) {
      writeSync(fd, chunk);
      done();
    },
  });

  output.isTTY = true;
  output.columns = 80;
  output.fd = fd;
  output.getColorDepth = () => 1;

  return {
    output,
    read: () => readFileSync(file, "utf8"),
    close: () => {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SPINNER_FRAME = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu;

function block(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function blockUntil(reached, limit) {
  const deadline = Date.now() + limit;

  while (!reached() && Date.now() < deadline) block(20);
}

function framesIn(text) {
  return new Set(text.match(SPINNER_FRAME)).size;
}

describe("pending", () => {
  it("shows what is running on a terminal after a spinner and replaces it with the result", () => {
    vi.stubEnv("NO_COLOR", "1");
    const { output, written } = fakeOutput(true);

    const done = pending("Installing the plugin…", output);

    expect(written.join("")).toBe("⠋ Installing the plugin…");

    done("✔ Plugin installed.");

    expect(written.join("")).toBe(
      "⠋ Installing the plugin…\r\u001B[2K✔ Plugin installed.\n",
    );
  });

  it("only clears the line when there is no result to show", () => {
    vi.stubEnv("NO_COLOR", "1");
    const { output, written } = fakeOutput(true);

    pending("Checking…", output)();

    expect(written.join("")).toBe("⠋ Checking…\r\u001B[2K");
  });

  it("cuts what is running so it never wraps, counting the spinner", () => {
    vi.stubEnv("NO_COLOR", "1");
    const { output, written } = fakeOutput(true, 12);

    pending("Checking the installed plugins…", output);

    expect(written.join("")).toBe("⠋ Checking…");
  });

  it("keeps the spinner turning while synchronous work blocks, and stops it before the result", () => {
    vi.stubEnv("NO_COLOR", "1");
    const terminal = fileOutput();

    try {
      const done = pending("Installing…", terminal.output);

      blockUntil(() => framesIn(terminal.read()) > 2, 5000);
      done("✔ Installed.");

      const written = terminal.read();

      block(250);

      expect(terminal.read()).toBe(written);
      expect(written.startsWith("⠋ Installing…")).toBe(true);
      expect(written.endsWith("\r\u001B[2K✔ Installed.\n")).toBe(true);
      expect(framesIn(written)).toBeGreaterThan(2);
    } finally {
      terminal.close();
    }
  });

  it("writes nothing more after work that ends before the spinner starts", () => {
    vi.stubEnv("NO_COLOR", "1");
    const terminal = fileOutput();

    try {
      pending("Checking…", terminal.output)("✔ Checked.");
      block(250);

      expect(terminal.read()).toBe("⠋ Checking…\r\u001B[2K✔ Checked.\n");
    } finally {
      terminal.close();
    }
  });

  it("writes only the result outside a terminal", () => {
    const { output, written } = fakeOutput(false);

    const done = pending("Installing…", output);

    done("✔ Plugin installed.");

    expect(written.join("")).toBe("✔ Plugin installed.\n");
  });
});

describe("ui without colors", () => {
  it("keeps the markers so the output still reads well in a pipe", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", undefined);

    expect(stepHeading(1, 9, "Idioma", "🌐")).toBe("\n── 🌐 1/9 Idioma ──");
    expect(success("Salvo.")).toBe("✔ Salvo.");
    expect(warn("Cuidado.")).toBe("⚠ Cuidado.");
    expect(fail("Falhou.")).toBe("✘ Falhou.");
    expect(note("Dica.")).toBe("Dica.");
    expect(skipped("Desligado.")).toBe("○ Desligado.");
    expect(question("Minutos [padrão: 3]: ")).toBe("Minutos [padrão: 3]: ");
  });
});

describe("ui with colors", () => {
  it("colors each kind of line and dims the default of a question", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    vi.stubEnv("NO_COLOR", undefined);

    expect(success("Salvo.")).toBe("\u001B[32m✔ Salvo.\u001B[39m");
    expect(warn("Cuidado.")).toBe("\u001B[33m⚠ Cuidado.\u001B[39m");
    expect(fail("Falhou.")).toBe("\u001B[31m✘ Falhou.\u001B[39m");
    expect(note("Dica.")).toBe("\u001B[2mDica.\u001B[22m");
    expect(skipped("Desligado.")).toBe("\u001B[2m○ Desligado.\u001B[22m");
    expect(stepHeading(1, 9, "Idioma", "🌐")).toBe(
      "\n\u001B[2m──\u001B[22m 🌐 \u001B[35m\u001B[1m1\u001B[22m\u001B[39m\u001B[2m/9\u001B[22m \u001B[35m\u001B[1mIdioma\u001B[22m\u001B[39m \u001B[2m──\u001B[22m",
    );
    expect(question("Mostrar? (s/n) [padrão: n] ")).toBe(
      "\u001B[1mMostrar? \u001B[22m\u001B[2m(s/n) [padrão: n]\u001B[22m ",
    );
    expect(stripVTControlCharacters(question("Minutos [default: 3]: "))).toBe(
      "Minutos [default: 3]: ",
    );
  });
});
