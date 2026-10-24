import { styleText } from "node:util";
import { Worker } from "node:worker_threads";

const DEFAULT_HINT = /(\([a-z]\/n\) )?\[(?:default|padrão)[^\]]*\]/;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const SPINNER_STOP_TIMEOUT_MS = 1000;
const STOP = 0;
const STARTED = 1;
const STOPPED = 2;
const SPINNER_WORKER = `
const { writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { fd, frames, text, interval, state } = workerData;
const flags = new Int32Array(state);

if (Atomics.compareExchange(flags, ${STARTED}, 0, 1) === 0) {
  let frame = 1;

  while (Atomics.wait(flags, ${STOP}, 0, interval) === "timed-out") {
    writeSync(fd, "\\r" + frames[frame % frames.length] + text);
    frame += 1;
  }

  Atomics.store(flags, ${STOPPED}, 1);
  Atomics.notify(flags, ${STOPPED});
}
`;

function paint(format, text, stream = process.stdout) {
  return styleText(format, text, { stream });
}

export function stepHeading(index, total, title, icon) {
  const rule = paint("dim", "──");
  const highlight = (text) => paint(["magenta", "bold"], text);

  return `\n${rule} ${icon} ${highlight(String(index))}${paint("dim", `/${total}`)} ${highlight(title)} ${rule}`;
}

export function success(text) {
  return paint("green", `✔ ${text}`);
}

export function warn(text) {
  return paint("yellow", `⚠ ${text}`);
}

export function fail(text, stream = process.stderr) {
  return paint("red", `✘ ${text}`, stream);
}

export function skipped(text) {
  return paint("dim", `○ ${text}`);
}

export function section(text) {
  return paint(["blue", "bold"], text);
}

export function note(text) {
  return paint("dim", text);
}

export function info(text) {
  return paint("blue", text);
}

export function newValue(text) {
  return paint("green", text);
}

export function link(text) {
  return paint(["blue", "underline"], text);
}

export function code(text) {
  return paint("bold", text);
}

function charWidth(char) {
  return char.codePointAt(0) >= 0x1f000 ? 2 : 1;
}

function widthOf(text) {
  return [...text].reduce((width, char) => width + charWidth(char), 0);
}

export function cut(text, max) {
  if (widthOf(text) <= max) return text;

  let kept = "";
  let width = 0;

  for (const char of text) {
    if (width + charWidth(char) > max - 1) break;

    kept += char;
    width += charWidth(char);
  }

  return `${kept}…`;
}

function spin(output, frames, text) {
  const state = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const flags = new Int32Array(state);
  const worker = new Worker(SPINNER_WORKER, {
    eval: true,
    workerData: {
      fd: output.fd,
      frames,
      text,
      interval: SPINNER_INTERVAL_MS,
      state,
    },
  });

  worker.unref();

  return () => {
    Atomics.store(flags, STOP, 1);
    Atomics.notify(flags, STOP);

    if (Atomics.compareExchange(flags, STARTED, 0, 2) === 1) {
      Atomics.wait(flags, STOPPED, 0, SPINNER_STOP_TIMEOUT_MS);
    }
  };
}

export function pending(text, output = process.stdout) {
  const live = Boolean(output.isTTY);
  let stop = () => {};

  if (live) {
    const frames = SPINNER_FRAMES.map((frame) => paint("cyan", frame, output));
    const label = ` ${paint("dim", cut(text, (output.columns || Infinity) - 3), output)}`;

    output.write(`${frames[0]}${label}`);

    if (typeof output.fd === "number") stop = spin(output, frames, label);
  }

  return (line) => {
    stop();
    if (live) output.write("\r\u001B[2K");
    if (line !== undefined) output.write(`${line}\n`);
  };
}

export function question(prompt) {
  const match = DEFAULT_HINT.exec(prompt);

  if (!match) return paint("bold", prompt);

  const before = prompt.slice(0, match.index);
  const after = prompt.slice(match.index + match[0].length);

  return `${paint("bold", before)}${paint("dim", match[0])}${after}`;
}
