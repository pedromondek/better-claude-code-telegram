import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { MESSAGES } from "../plugins/telegram-hooks/lib/messages.mjs";
import { REPO_ROOT, writeFixture } from "./fixture-support.mjs";
import { renderChoices } from "./select.mjs";
import {
  askDelay,
  askInbox,
  askLanguage,
  askStatuslineChoice,
  askTranscription,
  askYesNo,
  createPrompter,
  guardCancel,
} from "./setup.mjs";

const SELF = fileURLToPath(import.meta.url);
const START = "<<<";
const END = ">>>";
const COLOR_VARIABLES = [
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_DISABLE_COLORS",
  "TERM",
  "COLORTERM",
  "TMUX",
  "CI",
  "TERM_PROGRAM",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "WSL_DISTRO_NAME",
  "WT_SESSION",
];
const NAMED_KEYS = {
  up: "\u001B[A",
  down: "\u001B[B",
  right: "\u001B[C",
  left: "\u001B[D",
  home: "\u001B[H",
  end: "\u001B[F",
  delete: "\u001B[3~",
  insert: "\u001B[2~",
  pageup: "\u001B[5~",
  f5: "\u001B[15~",
  backspace: "\u007F",
  enter: "\r",
  newline: "\n",
  tab: "\t",
  "shift-tab": "\u001B[Z",
  "shift-left": "\u001B[1;2D",
  "shift-delete": "\u001B[3;2~",
  "alt-enter": "\u001B\r",
  "ctrl-up": "\u001B[1;5A",
  "ctrl-end": "\u001B[1;5F",
  "ctrl-left": "\u001B[1;5D",
  "ctrl-right": "\u001B[1;5C",
  "ctrl-delete": "\u001B[3;5~",
  "ctrl-shift-delete": "\u001B[3;6~",
  "ctrl-shift-left": "\u001B[1;6D",
  "ctrl-shift-backspace": "\u001B[127;6u",
  "ctrl-backspace": "\u001B[127;5u",
  "ctrl-alt-left": "\u001B[1;7D",
  "ctrl-alt-right": "\u001B[1;7C",
  "ctrl-alt-delete": "\u001B[3;7~",
  "alt-left": "\u001B[1;3D",
  "alt-delete": "\u001B[3;3~",
  "alt-backspace": "\u001B\u007F",
  "alt-ctrl-h": "\u001B\b",
  "alt-ctrl-a": "\u001B\u0001",
  "alt-ctrl-y": "\u001B\u0019",
  "alt-ctrl-undo": "\u001B\u001F",
  "ctrl-undo": "\u001F",
  "ctrl-redo": "\u001E",
  "ctrl-backslash": "\u001C",
  "ctrl-bracket": "\u001D",
};

function bytesOf(key) {
  if (NAMED_KEYS[key] !== undefined) return NAMED_KEYS[key];
  if (key.startsWith("ctrl-")) {
    return String.fromCodePoint(key.codePointAt(5) - 0x60);
  }
  if (key.startsWith("alt-")) return `\u001B${key.slice(4)}`;

  return key;
}

function errorOf(error) {
  return {
    message: error.message,
    cancelled: error.cancelled === true,
    interrupted: error.interrupted === true,
  };
}

async function settle(promise) {
  try {
    return { value: (await promise) ?? null };
  } catch (error) {
    return { error: errorOf(error) };
  }
}

async function withEnv(env, run) {
  const saved = {};

  for (const name of [...COLOR_VARIABLES, ...Object.keys(env)]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }

  Object.assign(process.env, env);

  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function tick() {
  return new Promise((done) => setImmediate(done));
}

const DRIVING = process.argv[2] === "--drive";

for (const stream of DRIVING ? [] : [process.stdout, process.stderr]) {
  Object.defineProperty(stream, "isTTY", { value: false, configurable: true });
}

const PLAIN = {};
const FORCED = { FORCE_COLOR: "1" };
const TERMINAL_COLORS = { TERM: "xterm-256color" };
const NO_COLORS = { TERM: "xterm-256color", NO_COLOR: "1" };
const CHOICES = [
  { label: "off", value: null },
  { label: "base", hint: "fastest", value: "base" },
  { label: "medium", hint: "most accurate", value: "medium" },
];

const renders = [
  [
    "chosen and hints in a column",
    CHOICES,
    1,
    "↑/↓ · Enter",
    undefined,
    NO_COLORS,
  ],
  ["painted", CHOICES, 2, "keys", undefined, TERMINAL_COLORS],
  [
    "previous away",
    [
      { label: "off", value: null },
      { label: "base", hint: "fastest", value: "base", previous: true },
    ],
    0,
    "k",
    undefined,
    TERMINAL_COLORS,
  ],
  [
    "previous chosen",
    [
      { label: "off", value: null },
      { label: "base", hint: "fastest", value: "base", previous: true },
    ],
    1,
    "k",
    undefined,
    TERMINAL_COLORS,
  ],
  [
    "cut short of the edge",
    CHOICES,
    2,
    "↑/↓ · Enter to confirm",
    12,
    NO_COLORS,
  ],
  [
    "emoji counts two columns",
    [{ label: "📱 phone line", value: 1 }],
    0,
    "k",
    9,
    NO_COLORS,
  ],
  [
    "headings",
    [
      { label: "off", value: null },
      { label: "Installed:", heading: true },
      { label: "base", value: "base" },
    ],
    2,
    "keys",
    undefined,
    TERMINAL_COLORS,
  ],
  [
    "heading cut and painted",
    [
      { label: "A very long heading", heading: true },
      { label: "x", value: 1 },
    ],
    1,
    "hint",
    8,
    TERMINAL_COLORS,
  ],
  [
    "cut inside the gap",
    [{ label: "abcd", hint: "zz", value: 1 }],
    0,
    "h",
    8,
    TERMINAL_COLORS,
  ],
  [
    "cut right after the gap",
    [{ label: "abcd", hint: "zz", value: 1 }],
    0,
    "h",
    10,
    TERMINAL_COLORS,
  ],
  [
    "cut inside the head",
    [
      { label: "abcdefgh", hint: "zz", value: 1, previous: true },
      { label: "x", value: 2 },
    ],
    1,
    "h",
    6,
    TERMINAL_COLORS,
  ],
  [
    "astral letters split by length",
    [
      { label: "𝐀𝐁", hint: "wide", value: 1 },
      { label: "abcdef", hint: "w", value: 2 },
    ],
    1,
    "h",
    9,
    TERMINAL_COLORS,
  ],
  ["one column", CHOICES, 0, "h", 1, NO_COLORS],
  ["no columns", CHOICES, 0, "h", 0, NO_COLORS],
  [
    "empty hint is no hint",
    [
      { label: "a", hint: "", value: 1 },
      { label: "bbb", hint: "x", value: 2 },
    ],
    0,
    "h",
    undefined,
    TERMINAL_COLORS,
  ],
  [
    "codes inside a label reopen the color",
    [
      { label: "a\u001B[22mb", hint: "x", value: 1 },
      { label: "c\u001B[39md", value: 2, previous: true },
    ],
    0,
    "h",
    undefined,
    TERMINAL_COLORS,
  ],
  [
    "only headings",
    [{ label: "H", heading: true }],
    0,
    "h",
    undefined,
    TERMINAL_COLORS,
  ],
  ["nothing to choose", [], 0, "h", 5, TERMINAL_COLORS],
].map(([name, choices, index, hint, columns, env]) => ({
  name,
  choices,
  index,
  hint,
  columns: columns ?? null,
  env,
}));

async function runRender(entry) {
  return withEnv(entry.env, async () => {
    const stream = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });

    stream.isTTY = true;
    stream.getColorDepth = (env = process.env) =>
      WriteStream.prototype.getColorDepth.call(null, env);

    return {
      ...entry,
      lines: renderChoices(
        {
          choices: entry.choices,
          index: entry.index,
          hint: entry.hint,
          columns: entry.columns ?? undefined,
        },
        stream,
      ),
    };
  });
}

function fakeTerminal(columns, outputTerminal) {
  const input = new PassThrough();
  const raw = [];
  const written = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk));
      done();
    },
  });

  input.isTTY = true;
  input.setRawMode = (mode) => {
    raw.push(mode);
    input.isRaw = mode;
  };
  output.isTTY = outputTerminal;
  output.columns = columns ?? undefined;
  output.getColorDepth = (env = process.env) =>
    WriteStream.prototype.getColorDepth.call(null, env);

  return { input, output, raw, written };
}

const sessions = [];

function session(name, kind, options) {
  sessions.push({
    name,
    kind,
    locale: options.locale ?? "en-us",
    text: options.text ?? "Model?",
    choices: options.choices ?? CHOICES,
    index: options.index ?? 0,
    columns: options.columns ?? 80,
    outputTerminal: options.outputTerminal ?? true,
    env: options.env ?? TERMINAL_COLORS,
    keys: options.keys,
  });
}

session("select starts on the given choice and Enter confirms it", "select", {
  index: 1,
  keys: ["enter"],
});
session("select skips headings and wraps at both ends", "select", {
  choices: [
    { label: "off", value: null },
    { label: "Installed:", heading: true },
    { label: "base", hint: "fastest", value: "base" },
    { label: "medium", value: "medium", previous: true },
  ],
  keys: [
    "up",
    "k",
    "down",
    "j",
    "j",
    "K",
    "J",
    "ctrl-k",
    "alt-j",
    "x",
    "left",
    "newline",
  ],
});
session("select redraws with the width of each moment", "select", {
  columns: 40,
  keys: ["down", { columns: 10 }, "down", { columns: 0 }, "up", "enter"],
});
session("select with a title of two lines", "select", {
  text: "First line.\nSecond line, a much longer one than the terminal?",
  columns: 10,
  keys: ["alt-enter"],
});
session("select cancels on Ctrl+C", "select", { keys: ["down", "ctrl-c"] });
session("select without colors", "select", {
  env: NO_COLORS,
  keys: ["down", "enter"],
});
session("select in portuguese", "select", {
  locale: "pt-br",
  keys: ["ctrl-c"],
});
session("line types, deletes and confirms", "line", {
  text: "Minutes? ",
  keys: ["a", "b", "backspace", "c", "ctrl-h", "d", "enter"],
});
session("line edits in the middle and moves around", "line", {
  text: "Minutes? ",
  keys: [
    "a",
    "b",
    "c",
    "left",
    "left",
    "x",
    "home",
    "right",
    "delete",
    "end",
    "ctrl-a",
    "ctrl-f",
    "ctrl-b",
    "ctrl-e",
    "shift-left",
    "shift-delete",
    "ctrl-d",
    "enter",
  ],
});
session("line deletes to the start and to the end", "line", {
  text: "Time: ",
  keys: [
    "1",
    "2",
    "3",
    "4",
    "left",
    "left",
    "ctrl-u",
    "backspace",
    "left",
    "right",
    "ctrl-k",
    "enter",
  ],
});
session("line with a prompt of two lines", "line", {
  text: "First line\nMinutes? ",
  columns: 12,
  keys: ["1", "2", "3", "left", "home", "ctrl-d", "enter"],
});
session("line with a prompt of two lines on a wide terminal", "line", {
  text: "A\n\nMinutes? ",
  columns: 0,
  keys: ["1", "backspace", "enter"],
});
session("line keeps the other keys out", "line", {
  text: "Time: ",
  keys: [
    "x",
    "up",
    "down",
    "f5",
    "insert",
    "pageup",
    "shift-tab",
    "alt-enter",
    "alt-x",
    "ctrl-g",
    "ctrl-up",
    "ctrl-end",
    "Y",
    "enter",
  ],
});
session("line wraps at the edge of the terminal", "line", {
  text: "Pick: ",
  columns: 10,
  keys: [
    "a",
    "b",
    "c",
    "d",
    "e",
    "left",
    "z",
    "end",
    "backspace",
    "backspace",
    "home",
    "enter",
  ],
});
session("line counts tabs, wide and invisible characters", "line", {
  text: "\u001B[1mName \u001B[22m\u001B[2m[default: x]\u001B[22m: ",
  keys: [
    "a",
    "tab",
    "😀",
    "中",
    "é",
    "́",
    "left",
    "left",
    "x",
    "home",
    "end",
    "enter",
  ],
});
session("line puts a wide character on the next row", "line", {
  text: "Abc: ",
  columns: 8,
  keys: ["a", "b", "中", "left", "left", "home", "end", "enter"],
});
session("line fills the row exactly", "line", {
  text: "Ab: ",
  columns: 6,
  keys: ["x", "y", "left", "z", "enter"],
});
session("line clears the screen", "line", {
  text: "Minutes? ",
  keys: ["4", "ctrl-l", "enter"],
});
session("line cancels on Ctrl+C after moving left", "line", {
  text: "Minutes? ",
  keys: ["a", "b", "left", "ctrl-c"],
});
session("line aborts on Ctrl+D with nothing typed", "line", {
  text: "Minutes? ",
  keys: ["ctrl-d"],
});
session("line aborts on Ctrl+D in portuguese", "line", {
  locale: "pt-br",
  text: "Minutos? ",
  keys: ["ctrl-d"],
});
session("line with a dumb terminal", "line", {
  text: "Minutes? ",
  env: { TERM: "dumb" },
  keys: ["7", "backspace", "8", "enter"],
});
session("line on a terminal without a terminal output", "line", {
  text: "Minutes? ",
  outputTerminal: false,
  keys: ["42\n"],
});
session("line deletes words to the left", "line", {
  text: "Q? ",
  keys: [
    "a",
    "b",
    " ",
    " ",
    "c",
    "-",
    "-",
    "ctrl-w",
    "ctrl-w",
    "alt-backspace",
    "alt-ctrl-h",
    "ctrl-w",
    "x",
    "enter",
  ],
});
session("line deletes a word and the spaces before it", "line", {
  text: "Q? ",
  keys: ["a", "_", "1", " ", " ", "left", "ctrl-w", "enter"],
});
session("line moves by words", "line", {
  text: "Q? ",
  keys: [
    "a",
    "b",
    " ",
    "-",
    "é",
    " ",
    " ",
    "c",
    "_",
    "9",
    "alt-b",
    "alt-B",
    "ctrl-left",
    "ctrl-alt-left",
    "alt-b",
    "alt-f",
    "alt-F",
    "ctrl-right",
    "ctrl-alt-right",
    "alt-f",
    "ctrl-shift-left",
    "alt-left",
    "x",
    "enter",
  ],
});
session("line moves over spaces alone", "line", {
  text: "Q? ",
  keys: ["a", " ", " ", "b", "left", "left", "left", "alt-f", "x", "enter"],
});
session("line deletes words to the right", "line", {
  text: "Q? ",
  keys: [
    "a",
    "b",
    " ",
    " ",
    "c",
    "d",
    " ",
    "e",
    " ",
    "f",
    " ",
    "g",
    " ",
    "h",
    "home",
    "alt-d",
    "alt-D",
    "ctrl-delete",
    "alt-delete",
    "ctrl-alt-delete",
    "enter",
  ],
});
session("line deletes symbols and spaces together to the right", "line", {
  text: "Q? ",
  keys: [
    "-",
    "-",
    " ",
    " ",
    "a",
    " ",
    " ",
    "b",
    "home",
    "alt-d",
    "alt-d",
    "alt-d",
    "alt-d",
    "enter",
  ],
});
session("line deletes the spaces alone to the right", "line", {
  text: "Q? ",
  keys: [" ", " ", "-", "a", "home", "alt-d", "enter"],
});
session("line deletes to the end with control and shift", "line", {
  text: "Q? ",
  keys: [
    "a",
    "b",
    "c",
    "left",
    "ctrl-shift-delete",
    "ctrl-shift-backspace",
    "ctrl-backspace",
    "enter",
  ],
});
session("line yanks what was deleted", "line", {
  text: "Q? ",
  keys: [
    "ctrl-y",
    "a",
    "b",
    "ctrl-u",
    "ctrl-u",
    "ctrl-y",
    "ctrl-y",
    "left",
    "ctrl-y",
    "ctrl-k",
    "ctrl-y",
    "enter",
  ],
});
session("line keeps one kill for the same text in a row", "line", {
  text: "Q? ",
  keys: ["a", "ctrl-u", "a", "ctrl-u", "ctrl-y", "alt-y", "enter"],
});
session("line yanks across the edge of the terminal", "line", {
  text: "Pick: ",
  columns: 10,
  keys: ["a", "b", "c", "ctrl-u", "a", "b", "c", "ctrl-y", "enter"],
});
session("line goes through the kills", "line", {
  text: "Q? ",
  keys: [
    "a",
    "ctrl-u",
    "b",
    "b",
    "ctrl-u",
    "c",
    "c",
    "c",
    "ctrl-u",
    "alt-y",
    "ctrl-y",
    "alt-y",
    "alt-Y",
    "alt-y",
    "alt-y",
    "x",
    "alt-y",
    "ctrl-y",
    "alt-ctrl-y",
    "alt-y",
    "ctrl-y",
    "up",
    "alt-y",
    "enter",
  ],
});
session("line yanks in the middle and goes through the kills", "line", {
  text: "Q? ",
  keys: [
    "a",
    "ctrl-u",
    "b",
    "b",
    "ctrl-u",
    "x",
    "y",
    "left",
    "ctrl-y",
    "alt-y",
    "alt-y",
    "enter",
  ],
});
session("line with only one kill has nothing to go through", "line", {
  text: "Q? ",
  keys: ["a", "ctrl-u", "ctrl-y", "alt-y", "enter"],
});
session("line keeps the last 32 kills", "line", {
  text: "Q? ",
  keys: [
    { repeat: 17, keys: ["a", "ctrl-u", "b", "b", "ctrl-u"] },
    "ctrl-y",
    { repeat: 33, keys: ["alt-y"] },
    "enter",
  ],
});
session("line undoes and redoes", "line", {
  text: "Q? ",
  keys: [
    "ctrl-undo",
    "ctrl-redo",
    "a",
    "b",
    "c",
    "left",
    "ctrl-undo",
    "ctrl-undo",
    "x",
    "ctrl-redo",
    "ctrl-undo",
    "ctrl-undo",
    "ctrl-undo",
    "ctrl-undo",
    "ctrl-redo",
    "ctrl-redo",
    "ctrl-redo",
    "ctrl-redo",
    "ctrl-redo",
    "ctrl-redo",
    "alt-ctrl-undo",
    "enter",
  ],
});
session("line undoes each kind of edit with its cursor", "line", {
  text: "Q? ",
  keys: [
    "a",
    "b",
    " ",
    "c",
    "d",
    "left",
    "backspace",
    "ctrl-undo",
    "delete",
    "ctrl-undo",
    "ctrl-w",
    "ctrl-undo",
    "alt-d",
    "ctrl-undo",
    "ctrl-u",
    "ctrl-undo",
    "ctrl-k",
    "ctrl-undo",
    "ctrl-y",
    "ctrl-undo",
    "home",
    "ctrl-u",
    "ctrl-undo",
    "end",
    "ctrl-k",
    "ctrl-undo",
    "enter",
  ],
});
session("line keeps the last 2048 edits to undo", "line", {
  text: "Q? ",
  keys: [
    { repeat: 1030, keys: ["a", "backspace"] },
    { repeat: 2060, keys: ["ctrl-undo"] },
    "enter",
  ],
});
session("line inserts the other control characters", "line", {
  text: "Q? ",
  keys: [
    "a",
    "ctrl-backslash",
    "ctrl-bracket",
    "left",
    "ctrl-n",
    "ctrl-p",
    "alt-ctrl-a",
    "b",
    "enter",
  ],
});
session("line treats an emoji as one piece of a word", "line", {
  text: "Q? ",
  keys: [
    "a",
    "😀",
    "😀",
    "b",
    "alt-b",
    "alt-b",
    "alt-f",
    "ctrl-w",
    "alt-d",
    "enter",
  ],
});
session("line moves by words across the edge of the terminal", "line", {
  text: "Pick: ",
  columns: 10,
  keys: ["a", "b", "c", " ", "d", "e", "alt-b", "alt-b", "alt-f", "enter"],
});
session("line deletes words across the edge of the terminal", "line", {
  text: "Pick: ",
  columns: 10,
  keys: [
    "a",
    "b",
    "c",
    " ",
    "d",
    "e",
    "ctrl-w",
    "alt-b",
    "alt-d",
    "x",
    "enter",
  ],
});
session("line redraws when the terminal changes size", "line", {
  text: "Pick: ",
  columns: 40,
  keys: [
    "a",
    "b",
    "c",
    { columns: 5 },
    "d",
    "left",
    { columns: 0 },
    "e",
    { columns: 30 },
    "enter",
  ],
});
session("line redraws on a dumb terminal when it changes size", "line", {
  text: "Pick: ",
  env: { TERM: "dumb" },
  keys: ["a", { columns: 3 }, "b", "enter"],
});
session("hidden types, deletes and confirms", "hidden", {
  text: "Token: ",
  keys: ["ab", "\u007F", "c\u001B[A", "\b", "d", "\r"],
});
session("hidden trims and stops at the first line break", "hidden", {
  text: "Token: ",
  keys: ["  12:AB  \nrest"],
});
session("hidden cancels on Ctrl+C", "hidden", {
  text: "Token: ",
  keys: ["ab\u0003"],
});
session("hidden deletes half of an emoji", "hidden", {
  text: "Token: ",
  keys: ["a😀", "\u007F", "\r"],
});
session("hidden with bytes split in two reads", "hidden", {
  text: "Token: ",
  keys: [Buffer.from([0xc3]), Buffer.from([0xa9, 0x0d])],
});

async function runSession(entry) {
  return withEnv(entry.env, async () => {
    const terminal = fakeTerminal(entry.columns, entry.outputTerminal);
    const prompter = createPrompter({
      input: terminal.input,
      output: terminal.output,
    });
    const messages = MESSAGES[entry.locale];
    const pending =
      entry.kind === "select"
        ? prompter.select(entry.text, entry.choices, entry.index, messages)
        : prompter[entry.kind](entry.text, messages);
    const outcome = settle(pending);
    const typed = entry.keys.flatMap((key) =>
      Array.isArray(key.keys)
        ? Array.from({ length: key.repeat }, () => key.keys).flat()
        : [key],
    );

    for (const key of typed) {
      await tick();
      await tick();

      if (typeof key === "object" && !Buffer.isBuffer(key)) {
        terminal.output.columns = key.columns || undefined;
        terminal.output.emit("resize");
        continue;
      }

      terminal.input.write(Buffer.isBuffer(key) ? key : bytesOf(key));
    }

    const settled = await outcome;
    const value =
      entry.kind === "select" && settled.error === undefined
        ? entry.choices.findIndex((choice) => choice.value === settled.value)
        : settled.value;
    const keys = entry.keys.map((key) =>
      Buffer.isBuffer(key) ? { bytes: [...key] } : key,
    );

    return {
      ...entry,
      keys,
      written: terminal.written.join(""),
      raw: terminal.raw,
      ...(settled.error ? { error: settled.error } : { value }),
    };
  });
}

const pipes = [
  [
    "every line arrives at once",
    "pt-br\n5\n123:FAKE\ny\n",
    ["line", "line", "hidden", "line"],
  ],
  ["input ends before the answer", "", ["hidden", "line"]],
  [
    "carriage returns and separators end lines",
    "a\r\nb\rc d \ne",
    ["line", "line", "line", "line", "line", "line", "line"],
  ],
  ["a separator at the very end", "x ", ["line", "line"]],
  ["a lone return at the end", "x\r", ["line", "line"]],
  [
    "invalid bytes become replacement characters",
    Buffer.from([0x61, 0xe2, 0x82, 0x0a, 0xff]),
    ["line", "line", "line"],
  ],
  ["hidden trims its line", "  token  \n", ["hidden"]],
].map(([name, input, calls]) => ({ name, input, calls }));

async function runPipe(entry) {
  const input = new PassThrough();
  const written = [];
  const output = { write: (chunk) => written.push(String(chunk)) };
  const messages = MESSAGES["en-us"];

  input.end(entry.input);

  const prompter = createPrompter({ input, output });
  const answers = [];

  for (const [position, method] of entry.calls.entries()) {
    answers.push(await settle(prompter[method](`Q${position}: `, messages)));
  }

  prompter.close();

  return {
    ...entry,
    input: Buffer.isBuffer(entry.input)
      ? { bytes: [...entry.input] }
      : entry.input,
    answers,
    written: written.join(""),
  };
}

function cancelledError(messages) {
  return Object.assign(new Error(messages.cancelled), { cancelled: true });
}

function viewOf(choice) {
  return {
    label: choice.label,
    hint: choice.hint ?? null,
    heading: Boolean(choice.heading),
    previous: Boolean(choice.previous),
  };
}

function fakeAsk(interactive, replies, messages) {
  const calls = [];
  const take = () => {
    const reply = replies.shift();

    if (reply === "cancel") throw cancelledError(messages);
    if (reply === "end") throw new Error(messages.cancelled);
    if (reply === "fail") throw new Error("network");

    return reply;
  };
  const typed = async () => take()?.text ?? "";

  return {
    calls,
    ask: {
      interactive,
      line: async (prompt) => {
        calls.push({ kind: "line", prompt });
        return typed();
      },
      hidden: async (prompt) => {
        calls.push({ kind: "hidden", prompt });
        return typed();
      },
      select: async (title, choices, index) => {
        calls.push({
          kind: "select",
          title,
          choices: choices.map(viewOf),
          index,
        });

        const reply = take() ?? "default";

        if (reply === "default") return choices[index].value;
        if (reply === "last") return choices.at(-1).value;

        return choices[reply.choose].value;
      },
      close: () => {},
    },
  };
}

async function captured(run, messages, env) {
  const errors = [];
  const original = console.error;

  console.error = (line) => errors.push(line);

  try {
    return await withEnv(env, async () => ({
      ...(await settle(run())),
      reports: errors,
    }));
  } finally {
    console.error = original;
  }
}

const guards = [
  [
    "asks whether to leave and asks again when going on",
    true,
    ["cancel", { choose: 0 }, { text: "ok" }],
  ],
  ["stops as interrupted when leaving", true, ["cancel", { choose: 1 }]],
  [
    "leaves when the question about leaving is cancelled too",
    true,
    ["cancel", "cancel"],
  ],
  ["lets any other error through", true, ["fail"]],
  ["lets the end of the input through", true, ["end"]],
  ["changes nothing without a terminal", false, ["cancel"]],
  [
    "asks again as many times as it takes",
    true,
    ["cancel", { choose: 0 }, "cancel", { choose: 0 }, { text: "7" }],
  ],
  [
    "leaves on the default of the question about leaving",
    true,
    ["cancel", "default"],
  ],
].flatMap(([name, interactive, replies]) =>
  ["line", "hidden", "select"].map((method) => ({
    name: `${method}: ${name}`,
    method,
    interactive,
    replies:
      method === "select"
        ? replies.map((reply) => (reply.text ? { choose: 2 } : reply))
        : replies,
    env: method === "line" ? FORCED : PLAIN,
  })),
);

async function runGuard(entry) {
  const messages = MESSAGES["en-us"];
  const { ask, calls } = fakeAsk(
    entry.interactive,
    structuredClone(entry.replies),
    messages,
  );
  const guarded = guardCancel(ask);
  const outcome = await captured(
    () =>
      entry.method === "select"
        ? guarded.select("Model?", CHOICES, 1, messages)
        : guarded[entry.method]("Minutes? ", messages),
    messages,
    entry.env,
  );
  const value =
    entry.method === "select" && outcome.error === undefined
      ? CHOICES.findIndex((choice) => choice.value === outcome.value)
      : outcome.value;

  return {
    ...entry,
    calls,
    ...(outcome.error ? { error: outcome.error } : { value }),
  };
}

const OTHER_DETAILS = {
  delay: (messages) => ({
    label: messages.custom,
    answer: "N",
    prompt: messages.delayCustomPrompt,
    hint: messages.delayCustomHint,
    parse: "delay",
  }),
  inbox: (messages) => ({
    label: messages.custom,
    answer: "N",
    prompt: messages.inboxCustomPrompt,
    hint: messages.inboxCustomHint,
    parse: "days",
  }),
};

const DOMAIN = {
  delay: (current, messages, ask, options) =>
    askDelay(current, messages, ask, options),
  inbox: (current, messages, ask, options) =>
    askInbox(current, messages, ask, options),
  language: (current, messages, ask, options) =>
    askLanguage(current, messages, ask, options),
  transcription: (current, messages, ask, options) =>
    askTranscription(current, messages, ask, options),
  statusline: (current, messages, ask, options) =>
    askStatuslineChoice(current, messages, ask, options),
};

const choiceCases = [];

function choiceCase(name, domain, current, options, runs) {
  for (const [mode, interactive, replies, env] of runs) {
    choiceCases.push({
      name: `${name} (${mode})`,
      domain,
      current,
      options,
      locale: options.locale ?? "en-us",
      interactive,
      replies,
      env: env ?? PLAIN,
    });
  }
}

choiceCase("delay saved among the usual ones", "delay", 5, {}, [
  ["enter", true, []],
  ["typed enter", false, []],
  ["typed alias", false, [{ text: " 10 " }]],
]);
choiceCase("delay chosen before and recommended", "delay", 4, { saved: true }, [
  ["enter", true, [], FORCED],
  [
    "typed invalid then valid",
    false,
    [{ text: "soon" }, { text: "2,5" }],
    FORCED,
  ],
]);
choiceCase(
  "delay saved outside the usual ones",
  "delay",
  2.5,
  { saved: true },
  [
    ["other", true, ["last", { text: "soon" }, { text: "0" }, { text: "4" }]],
    ["choose", true, [{ choose: 0 }]],
  ],
);
choiceCase("inbox kept forever", "inbox", null, { saved: true }, [
  ["enter", true, []],
  ["typed alias", false, [{ text: "NONE" }]],
  ["typed other", false, [{ text: "2.5" }, { text: "12" }]],
  ["other", true, ["last", { text: "x" }, { text: "3" }]],
]);
choiceCase(
  "language with its own default hint",
  "language",
  "pt-br",
  { saved: true, locale: "pt-br" },
  [
    ["enter", true, []],
    ["typed alias", false, [{ text: "EN_US" }]],
    ["typed invalid", false, [{ text: "fr" }, { text: "" }], FORCED],
  ],
);
choiceCase(
  "transcription with headings",
  "transcription",
  "base",
  { saved: true, installed: ["base", "small"] },
  [
    ["enter", true, []],
    ["typed", false, [{ text: "medium" }]],
    ["typed alias", false, [{ text: "nao" }]],
  ],
);
choiceCase(
  "statusline with numbers",
  "statusline",
  "mine",
  { customized: true },
  [
    ["choose", true, [{ choose: 1 }]],
    ["typed number", false, [{ text: "2" }]],
    ["cancelled", true, ["cancel"]],
    ["ended", false, ["end"]],
  ],
);

function specOf(entry, messages) {
  return withEnv(PLAIN, async () => {
    const seen = {};
    const ask = {
      interactive: true,
      select: async (title, choices, index) => {
        Object.assign(seen, { title, choices, index });
        return choices[index].value;
      },
      line: async () => "",
    };

    await DOMAIN[entry.domain](entry.current, messages, ask, entry.options);

    const other = OTHER_DETAILS[entry.domain]?.(messages) ?? null;
    const choices = other ? seen.choices.slice(0, -1) : seen.choices;

    return {
      title: seen.title,
      index: seen.index,
      choices: choices.map((choice) => ({
        label: choice.label,
        hint: choice.hint ?? null,
        heading: Boolean(choice.heading),
        previous: Boolean(choice.previous),
        answer: choice.answer ?? null,
        aliases: choice.aliases ?? [],
        value:
          typeof choice.value === "symbol"
            ? choice.value.description
            : (choice.value ?? null),
      })),
      other,
      defaultHint: entry.domain === "language" ? "language" : null,
    };
  });
}

async function runChoice(entry) {
  const messages = MESSAGES[entry.locale];
  const spec = await specOf(entry, messages);
  const { ask, calls } = fakeAsk(
    entry.interactive,
    structuredClone(entry.replies),
    messages,
  );
  const outcome = await captured(
    () => DOMAIN[entry.domain](entry.current, messages, ask, entry.options),
    messages,
    entry.env,
  );

  return { ...entry, spec, calls, ...outcome };
}

const yesNos = [
  ["defaults to no as a selection", true, false, [], PLAIN],
  ["defaults to yes as a selection", true, true, [{ choose: 1 }], FORCED],
  ["typed empty keeps the default", false, false, [], FORCED],
  ["typed yes in portuguese", false, false, [{ text: " Sim " }], PLAIN],
  ["typed yes in english", false, false, [{ text: "YES" }], PLAIN],
  ["typed anything else is no", false, true, [{ text: "nope" }], PLAIN],
  ["cancelled", true, true, ["cancel"], PLAIN],
].map(([name, interactive, defaultYes, replies, env]) => ({
  name,
  interactive,
  defaultYes,
  replies,
  env,
}));

async function runYesNo(entry) {
  const messages = MESSAGES["en-us"];
  const { ask, calls } = fakeAsk(
    entry.interactive,
    structuredClone(entry.replies),
    messages,
  );
  const outcome = await captured(
    () => askYesNo("Go on?", messages, entry.defaultYes, ask),
    messages,
    entry.env,
  );

  return { ...entry, calls, ...outcome };
}

const strips = [
  "plain",
  "\u001B[1mbold\u001B[22m",
  "\u001B[36m\u001B[1m❯ x\u001B[22m\u001B[39m",
  "a\u001B[12345mb",
  "\u001B[1;2;3m",
  "\u001B[;m",
  "\u001B[1;23456m",
  "\u001B]0;title\u0007after",
  "\u001B]8;;http://x\u001B\\link\u001B]8;;\u001B\\",
  "\u001B];a;\u009Cz",
  "\u009B31mred",
  "\u001B[?25l\u001B[?25h",
  "\u001B[#!x",
  "\u001B",
  "\u001B[",
  "\u001B[12",
  "\u001B[123",
  "\u001B(B",
  "\u001B[1;;2Hx",
  "\u001Bxyz",
  "\u001B]ab;\u001Bc",
  "\u001B]a\u0007",
  "\u001B];;\u0007",
  "\u001B]1;\u0007",
  "\u001B[1;12345m",
  "\u001B;;a",
  "\u001B;x",
  "\u001B;\u0007",
  "\u001B;-\u0007",
  "\u001B;-;/\u0007",
  "\u001B;-;\u0007",
  "\u001B;-;;a\u0007x",
].map((text) => ({ text, out: stripVTControlCharacters(text) }));

const ptys = [];

function pty(name, spec, keys, options = {}) {
  ptys.push({
    name,
    spec: { locale: "en-us", ...spec },
    keys,
    columns: options.columns ?? 40,
    rows: 24,
    redirect: options.redirect ?? false,
  });
}

const PTY_CHOICES = [
  { label: "off", value: 0 },
  { label: "base", hint: "fastest", value: 1, previous: true },
  { label: "Installed:", heading: true, value: 2 },
  { label: "medium", hint: "most accurate", value: 3 },
];

pty(
  "select moves and confirms",
  { kind: "select", text: "Model?", choices: PTY_CHOICES, index: 1 },
  ["\u001B[B", "j", "k", "\r"],
);
pty(
  "select cut and cancelled",
  { kind: "select", text: "Model?", choices: PTY_CHOICES, index: 0 },
  ["\u001B[B", "\u0003"],
  { columns: 12 },
);
pty("line edits and confirms", { kind: "line", text: "Minutes? " }, [
  "a",
  "b",
  "\u007F",
  "c",
  "\u001B[D",
  "x",
  "\u001B[H",
  "\u001B[3~",
  "\r",
]);
pty("line cancelled", { kind: "line", text: "Minutes? " }, ["4", "\u0003"]);
pty("line aborted", { kind: "line", text: "Minutes? " }, ["\u0004"]);
pty("hidden types and confirms", { kind: "hidden", text: "Token: " }, [
  "12",
  "\u007F",
  "3:x",
  "\r",
]);
pty("hidden cancelled", { kind: "hidden", text: "Token: " }, ["ab", "\u0003"]);
pty("guard asks to leave and goes on", { kind: "guard", text: "Minutes? " }, [
  "5",
  "\u0003",
  "\u001B[A",
  "\r",
  "7",
  "\r",
]);
pty("yes or no", { kind: "yesno", text: "Go on?" }, ["\u001B[B", "\r"]);
pty(
  "line without a terminal output",
  { kind: "line", text: "Minutes? " },
  ["42\r"],
  { redirect: true },
);
pty(
  "select without a terminal output",
  { kind: "select", text: "Model?", choices: PTY_CHOICES, index: 0 },
  ["\u001B[B", "\r"],
  { redirect: true },
);
pty(
  "select drops what came with the Enter",
  { kind: "select", text: "Model?", choices: PTY_CHOICES, index: 0 },
  ["\u001B[B\rjj"],
);
pty(
  "the next question starts without what came with the Enter",
  { kind: "selectline", text: "Model?", choices: PTY_CHOICES, index: 0 },
  ["\u001B[B\rjj", "5", "\r"],
);
pty(
  "a custom delay reports the invalid answer",
  { kind: "delay", current: 15 },
  ["\u001B[B", "\r", "x", "\r", "2", "\r"],
);
pty("line deletes words to the left", { kind: "line", text: "Q? " }, [
  "ab cd ef gh",
  "\u0017",
  "\u001B\u007F",
  "\u001B\b",
  "\r",
]);
pty("line moves by words", { kind: "line", text: "Q? " }, [
  "ab cd ef",
  "\u001Bb",
  "\u001BB",
  "\u001B[1;5D",
  "\u001Bf",
  "\u001BF",
  "\u001B[1;5C",
  "\u001B[1;7D",
  "\u001B[1;7C",
  "\u001B[1;6D",
  "\u001B[1;3D",
  "x",
  "\r",
]);
pty("line deletes words to the right", { kind: "line", text: "Q? " }, [
  "ab cd ef gh ij kl",
  "\u001B[H",
  "\u001Bd",
  "\u001BD",
  "\u001B[3;5~",
  "\u001B[3;3~",
  "\u001B[3;7~",
  "\u001B[3;6~",
  "\r",
]);
pty("line yanks and goes through the kills", { kind: "line", text: "Q? " }, [
  "ab",
  "\u0015",
  "cd",
  "\u0015",
  "\u0019",
  "\u001By",
  "\u001BY",
  "\u001B\u0019",
  "\u001By",
  "\r",
]);
pty("line undoes and redoes", { kind: "line", text: "Q? " }, [
  "a",
  "b",
  "\u001F",
  "\u001F",
  "\u001E",
  "\u001B\u001F",
  "\r",
]);
pty("line inserts and ignores control keys", { kind: "line", text: "Q? " }, [
  "a",
  "\u001C",
  "\u001D",
  "\u000E",
  "\u0010",
  "\u001B\u0001",
  "\u001B[127;6u",
  "\u001B[127;5u",
  "\r",
]);
pty(
  "line redraws when the terminal changes size",
  { kind: "line", text: "Pick: " },
  ["abc", { columns: 5 }, "d", { columns: 30 }, "\r"],
);
pty(
  "a change of size between two questions redraws nothing",
  {
    kind: "pausedline",
    text: "Model?",
    choices: PTY_CHOICES,
    index: 0,
    pause: 1500,
  },
  ["\r", { columns: 20 }, { pause: 2500 }, "5", "\r"],
);
async function drive(spec) {
  const messages = MESSAGES[spec.locale];
  const terminal = createPrompter();
  const outcome = async () => {
    if (spec.kind === "select") {
      return terminal.select(spec.text, spec.choices, spec.index, messages);
    }
    if (spec.kind === "guard")
      return guardCancel(terminal).line(spec.text, messages);
    if (spec.kind === "yesno")
      return askYesNo(spec.text, messages, true, terminal);
    if (spec.kind === "delay")
      return askDelay(spec.current, messages, terminal);
    if (spec.kind === "selectline") {
      const chosen = await terminal.select(
        spec.text,
        spec.choices,
        spec.index,
        messages,
      );

      return [chosen, await terminal.line("Minutes? ", messages)];
    }
    if (spec.kind === "pausedline") {
      const chosen = await terminal.select(
        spec.text,
        spec.choices,
        spec.index,
        messages,
      );

      await new Promise((done) => setTimeout(done, spec.pause));

      return [chosen, await terminal.line("Minutes? ", messages)];
    }

    return terminal[spec.kind](spec.text, messages);
  };

  process.stdout.write(START);

  const settled = await settle(outcome());

  terminal.close();
  process.stdout.write(`${END}${JSON.stringify(settled)}\n`);
}

function between(name, text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  const tail = text.slice(end + END.length);

  if (start < 0 || end < 0) {
    throw new Error(`${name}: no markers in ${JSON.stringify(text)}`);
  }

  return {
    output: text.slice(start + START.length, end),
    outcome: JSON.parse(tail.slice(0, tail.indexOf("\n")).trim()),
  };
}

function runPty(entry) {
  const folder = mkdtempSync(join(tmpdir(), "bcct-pty-"));
  const outFile = join(folder, "out");
  const recorder = spawnSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--manifest-path",
      join(REPO_ROOT, "rust", "Cargo.toml"),
      "--example",
      "pty_record",
    ],
    {
      input: JSON.stringify({
        argv: [process.execPath, SELF, "--drive"],
        env: { BCCT_DRIVE: JSON.stringify(entry.spec) },
        columns: entry.columns,
        rows: entry.rows,
        steps: entry.keys.map((key) => {
          if (key.columns !== undefined) return { resize: key.columns };
          if (key.pause !== undefined) return { pause: key.pause };

          return { key: [...Buffer.from(key)] };
        }),
        redirect: entry.redirect ? outFile : null,
      }),
      encoding: "utf8",
    },
  );

  if (recorder.status !== 0) {
    throw new Error(`${entry.name}: ${recorder.stderr}`);
  }

  const text = entry.redirect
    ? readFileSync(outFile, "utf8")
    : Buffer.from(JSON.parse(recorder.stdout).output).toString("utf8");

  rmSync(folder, { recursive: true, force: true });

  return { ...entry, ...between(entry.name, text) };
}

if (DRIVING) {
  await drive(JSON.parse(process.env.BCCT_DRIVE ?? "{}"));
} else {
  const sequential = async (entries, run) => {
    const out = [];

    for (const entry of entries) out.push(await run(entry));

    return out;
  };

  await writeFixture("setup-terminal.json", {
    renders: await sequential(renders, runRender),
    sessions: await sequential(sessions, runSession),
    pipes: await sequential(pipes, runPipe),
    guards: await sequential(guards, runGuard),
    choices: await sequential(choiceCases, runChoice),
    yesNos: await sequential(yesNos, runYesNo),
    strips,
    ptys: await sequential(ptys, runPty),
  });
}
