import fs, {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import {
  contextBeforeTool,
  delayMs,
  handleTelegramEvent,
  instanceLabel,
  permissionDecision,
  sessionNameFromTranscript,
  telegramActive,
} from "../plugins/telegram-hooks/hooks/telegram.mjs";

const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rust",
  "crates",
  "bcct",
  "tests",
  "fixtures",
  "hook.json",
);

const NOW = 1_700_000_000_123;
const ALIVE_PID = 4242;
const MIB = 1024 * 1024;
const TRANSCRIPT_FILE = "t/session.jsonl";
const TRANSCRIPT_PATH = `{root}/${TRANSCRIPT_FILE}`;

process.umask(0o022);

process.kill = (pid) => {
  if (pid !== (pid | 0)) throw new TypeError("invalid pid");
  if (pid === ALIVE_PID) return true;
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
};

const hookWrites = { active: false, paths: new Set() };
const plainWriteFileSync = fs.writeFileSync;

fs.writeFileSync = (path, ...rest) => {
  plainWriteFileSync(path, ...rest);

  if (hookWrites.active) hookWrites.paths.add(path);
};
syncBuiltinESMExports();

const QUESTIONS = [
  {
    question: "Which database?",
    header: "Database",
    multiSelect: false,
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "Redis", preview: "cache" },
    ],
  },
];

const ask = (extra = {}) => ({
  session_id: "s1",
  cwd: "/home/dev/my-project",
  tool_input: { questions: QUESTIONS },
  ...extra,
});

const withQuestions = (questions, extra = {}) =>
  ask({ tool_input: { questions }, ...extra });

const withQuestion = (question, extra = {}) => withQuestions([question], extra);

const stopInput = (message, extra = {}) => ({
  session_id: "s1",
  cwd: "/x/proj",
  last_assistant_message: message,
  ...extra,
});

const lines = (...entries) =>
  `${entries
    .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    .join("\n")}\n`;

const block = (type, extra = {}) => ({ type, ...extra });
const text = (value) => block("text", { text: value });
const assistant = (...blocks) => ({
  type: "assistant",
  message: { content: blocks },
});
const assistantText = (value) => assistant(text(value));
const user = () => ({ type: "user", message: { content: "do X" } });
const toolUse = assistant(block("tool_use", { name: "AskUserQuestion" }));

const scenarios = [];

function addScenario(name, mode, stdin, options = {}) {
  const active = options.active ?? "telegram";
  const env = {
    TELEGRAM_STATE_DIR: "{root}/state",
    BETTER_CC_TELEGRAM_DIR: "{root}/app",
  };

  if (active === "telegram") env.BETTER_CC_TELEGRAM = "1";

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }

  const files = { ...options.files };

  if (active === "bot") files["state/bot.pid"] = String(ALIVE_PID);

  scenarios.push({
    name,
    mode,
    stdin: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    env,
    files,
  });
}

const permission = (name, stdin, options) =>
  addScenario(name, "permission", stdin, options);

const withTranscript = (content, options = {}) => ({
  active: "bot",
  ...options,
  files: { [TRANSCRIPT_FILE]: content, ...options.files },
});

const transcriptAsk = (extra = {}) =>
  ask({ transcript_path: TRANSCRIPT_PATH, ...extra });

function recordFile(id, sessionId, extra = {}) {
  const record = { id, ...extra };

  if (sessionId !== undefined) record.sessionId = sessionId;

  return JSON.stringify(record);
}

for (const mode of ["permission", "prompt", "post", "stop"]) {
  addScenario(
    `gate: ${mode} does nothing without telegram or bot`,
    mode,
    ask(),
    {
      active: "none",
    },
  );
  addScenario(`gate: ${mode} does nothing with a dead bot pid`, mode, ask(), {
    active: "none",
    files: { "state/bot.pid": "4243" },
  });
  addScenario(
    `gate: ${mode} acts when the bot is alive`,
    mode,
    stopInput("ok?"),
    {
      active: "bot",
      files: {
        "app/asks/a.json": recordFile("a", "s1"),
        "app/pings/s1.json": "{}",
      },
    },
  );
  addScenario(
    `gate: ${mode} acts on the telegram instance`,
    mode,
    stopInput("ok?"),
    {
      files: {
        "app/asks/a.json": recordFile("a", "s1"),
        "app/pings/s1.json": "{}",
      },
    },
  );
}

addScenario("gate: unknown mode does nothing", "bogus", ask(), {
  files: { "app/asks/a.json": recordFile("a", null) },
});
addScenario("gate: mode is case sensitive", "PERMISSION", ask());
addScenario("gate: empty mode does nothing", "", ask());

for (const flag of ["0", "true", "", "11", " 1"]) {
  addScenario(
    `gate: flag ${JSON.stringify(flag)} is not the telegram instance`,
    "permission",
    ask(),
    {
      active: "none",
      env: { BETTER_CC_TELEGRAM: flag },
    },
  );
  addScenario(
    `gate: flag ${JSON.stringify(flag)} with a live bot`,
    "permission",
    ask(),
    {
      active: "bot",
      env: { BETTER_CC_TELEGRAM: flag },
    },
  );
}

for (const [label, pid] of [
  ["leading and trailing whitespace", " 4242\n"],
  ["hexadecimal", "0x1092"],
  ["exponent", "4.242e3"],
  ["fraction", "4242.5"],
  ["trailing text", "4242abc"],
  ["empty", ""],
  ["one", "1"],
  ["zero", "0"],
  ["negative", "-4242"],
  ["huge", "99999999999"],
  ["infinity", "Infinity"],
]) {
  addScenario(`gate: bot.pid ${label}`, "permission", ask(), {
    active: "none",
    files: { "state/bot.pid": pid },
  });
}

addScenario("gate: bot.pid is a directory", "permission", ask(), {
  active: "none",
  files: { "state/bot.pid/x": "1" },
});

addScenario(
  "folders: claude config dir drives both folders",
  "permission",
  ask(),
  {
    active: "none",
    env: {
      TELEGRAM_STATE_DIR: null,
      BETTER_CC_TELEGRAM_DIR: null,
      CLAUDE_CONFIG_DIR: "{root}/claude",
    },
    files: { "claude/channels/telegram/bot.pid": String(ALIVE_PID) },
  },
);
addScenario(
  "folders: home claude folder is the fallback",
  "permission",
  ask(),
  {
    active: "none",
    env: { TELEGRAM_STATE_DIR: null, BETTER_CC_TELEGRAM_DIR: null },
    files: { "home/.claude/channels/telegram/bot.pid": String(ALIVE_PID) },
  },
);
addScenario(
  "folders: telegram instance under the home fallback",
  "permission",
  ask(),
  {
    env: { TELEGRAM_STATE_DIR: null, BETTER_CC_TELEGRAM_DIR: null },
  },
);
addScenario("folders: empty variables count as unset", "permission", ask(), {
  active: "none",
  env: {
    TELEGRAM_STATE_DIR: "",
    BETTER_CC_TELEGRAM_DIR: "",
    CLAUDE_CONFIG_DIR: "",
  },
  files: { "home/.claude/channels/telegram/bot.pid": String(ALIVE_PID) },
});
addScenario(
  "folders: explicit folders win over the config dir",
  "permission",
  ask(),
  {
    active: "none",
    env: { CLAUDE_CONFIG_DIR: "{root}/claude" },
    files: {
      "state/bot.pid": String(ALIVE_PID),
      "claude/channels/telegram/bot.pid": "4243",
    },
  },
);
addScenario(
  "folders: app folder with dot segments is normalized",
  "permission",
  ask(),
  {
    env: { BETTER_CC_TELEGRAM_DIR: "{root}/app/./deep/../app2" },
  },
);
addScenario(
  "folders: app folder with a trailing slash",
  "post",
  { session_id: "s1" },
  {
    env: { BETTER_CC_TELEGRAM_DIR: "{root}/app/" },
    files: { "app/asks/a.json": recordFile("a", "s1") },
  },
);
addScenario("folders: app folder with repeated slashes", "permission", ask(), {
  env: { BETTER_CC_TELEGRAM_DIR: "{root}//app" },
});

for (const [label, input] of [
  ["empty stdin", ""],
  ["invalid json", "not json"],
  ["truncated json", '{"session_id":"s1"'],
  ["null", "null"],
  ["number", "5"],
  ["string", '"str"'],
  ["true", "true"],
  ["empty array", "[]"],
  ["array with an object", '[{"session_id":"s1"}]'],
  ["empty object", "{}"],
  ["session only", '{"session_id":"s1"}'],
  ["byte order mark", `﻿${JSON.stringify(ask())}`],
]) {
  for (const mode of ["permission", "stop", "post", "prompt"]) {
    addScenario(`input: ${label} on ${mode}`, mode, input, {
      files: { "app/asks/a.json": recordFile("a", null) },
    });
  }
}

addScenario("input: null while inactive stays silent", "permission", "null", {
  active: "none",
});

for (const [label, sessionId] of [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
  ["number", 5],
  ["float", 1.5],
  ["true", true],
  ["false", false],
  ["object", {}],
  ["array", ["s1"]],
  ["empty array", []],
  ["slashes", "s/../1"],
  ["spaces and dots", "a b.c"],
  ["unicode", "ünïcödé😀"],
  ["astral only", "😀😀😀😀😀"],
  ["long", "abcdefghijklmnopqrstuvwxyz0123456789"],
  ["dashes and underscores", "a-b_c"],
]) {
  const input = ask();

  if (sessionId === undefined) delete input.session_id;
  else input.session_id = sessionId;

  for (const mode of ["permission", "post", "prompt"]) {
    addScenario(`session: ${label} on ${mode}`, mode, input, {
      active: "bot",
      files: {
        "app/asks/a.json": recordFile("a", null),
        "app/asks/b.json": recordFile("b", "s1"),
        "app/pings/s1.json": "{}",
        "app/pings/session.json": "{}",
      },
    });
  }

  addScenario(
    `session: ${label} on stop`,
    "stop",
    { ...input, last_assistant_message: "waiting" },
    { active: "bot" },
  );
}

addScenario(
  "session: an emoji inside the first four code units",
  "permission",
  ask({ session_id: "a😀bcdef" }),
  { active: "bot" },
);
addScenario(
  "session: exactly four ascii characters",
  "permission",
  ask({ session_id: "abcd" }),
  { active: "bot" },
);
addScenario(
  "session: shorter than four characters",
  "permission",
  ask({ session_id: "ab" }),
  { active: "bot" },
);
addScenario(
  "session: empty string label",
  "permission",
  ask({ session_id: "" }),
  {
    active: "bot",
  },
);

for (const [label, cwd] of [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
  ["root", "/"],
  ["double root", "//"],
  ["trailing slash", "/a/b/"],
  ["several trailing slashes", "/a/b///"],
  ["relative", "relative"],
  ["relative nested", "a/b"],
  ["dot dot", "/a/.."],
  ["dot", "."],
  ["plain", "/home/dev/my-project"],
  ["unicode", "/home/dev/pröjeto-😀"],
  ["spaces", "/home/dev/my project"],
  ["zero", 0],
  ["false", false],
  ["number", 5],
  ["true", true],
  ["object", {}],
  ["array", []],
  ["empty array is truthy", [""]],
]) {
  const input = ask();

  if (cwd === undefined) delete input.cwd;
  else input.cwd = cwd;

  permission(`cwd: ${label} with the bot`, input, { active: "bot" });
  permission(`cwd: ${label} on the telegram instance`, input);
  addScenario(
    `cwd: ${label} on stop`,
    "stop",
    { ...input, last_assistant_message: "waiting" },
    { active: "bot" },
  );
}

for (const [label, toolInput] of [
  ["absent", undefined],
  ["null", null],
  ["string", "text"],
  ["number", 5],
  ["array", [1]],
  ["empty object", {}],
  ["questions null", { questions: null }],
  ["questions string", { questions: "x" }],
  ["questions object", { questions: {} }],
  ["questions empty", { questions: [] }],
  ["questions number", { questions: 3 }],
]) {
  const input = ask();

  if (toolInput === undefined) delete input.tool_input;
  else input.tool_input = toolInput;

  permission(`tool_input: ${label}`, input);
}

permission(
  "tool_input: unrelated extra keys are ignored",
  ask({
    tool_input: { questions: QUESTIONS, extra: 1, answers: { stale: true } },
  }),
);

for (const [label, question] of [
  ["null", null],
  ["number", 5],
  ["string", "plain"],
  ["true", true],
  ["array", [1, 2]],
  ["empty object", {}],
  ["only a question", { question: "Q?" }],
  ["question null", { question: null }],
  ["question number", { question: 7 }],
  ["question float", { question: 0.1 }],
  ["question huge", { question: 1e21 }],
  ["question tiny", { question: 1e-7 }],
  ["question true", { question: true }],
  ["question false", { question: false }],
  ["question empty string", { question: "" }],
  ["question array", { question: [1, [2, null], "a", true] }],
  ["question empty array", { question: [] }],
  ["question object", { question: { a: 1 } }],
  ["question nested array of objects", { question: [{}, [{}]] }],
  [
    "question with escapes",
    { question: 'q "quoted" \\ \n \t \u0001 \u007f \u{2028} </script>' },
  ],
  ["header null", { question: "Q", header: null }],
  ["header string", { question: "Q", header: "H" }],
  ["header number", { question: "Q", header: 12 }],
  ["header false", { question: "Q", header: false }],
  ["header empty", { question: "Q", header: "" }],
  ["header array", { question: "Q", header: [1, "a", null] }],
  ["header object", { question: "Q", header: { b: 1, a: { d: 2, c: 3 } } }],
  [
    "header integer keys",
    {
      question: "Q",
      header: {
        b: 1,
        2: "two",
        10: "ten",
        1: "one",
        "01": "x",
        "-1": "y",
        4294967294: "max",
        4294967295: "over",
      },
    },
  ],
  ["multiSelect true", { question: "Q", multiSelect: true }],
  ["multiSelect false", { question: "Q", multiSelect: false }],
  ["multiSelect null", { question: "Q", multiSelect: null }],
  ["multiSelect zero", { question: "Q", multiSelect: 0 }],
  ["multiSelect one", { question: "Q", multiSelect: 1 }],
  ["multiSelect negative", { question: "Q", multiSelect: -3 }],
  ["multiSelect fraction", { question: "Q", multiSelect: 0.5 }],
  ["multiSelect empty string", { question: "Q", multiSelect: "" }],
  ["multiSelect zero string", { question: "Q", multiSelect: "0" }],
  ["multiSelect false string", { question: "Q", multiSelect: "false" }],
  ["multiSelect empty array", { question: "Q", multiSelect: [] }],
  ["multiSelect empty object", { question: "Q", multiSelect: {} }],
  ["options null", { question: "Q", options: null }],
  ["options empty", { question: "Q", options: [] }],
  ["options string", { question: "Q", options: "abc" }],
  ["options object", { question: "Q", options: {} }],
  ["options number", { question: "Q", options: 3 }],
  ["options false", { question: "Q", options: false }],
  ["options true", { question: "Q", options: true }],
  ["options zero", { question: "Q", options: 0 }],
  ["options null element", { question: "Q", options: [{ label: "a" }, null] }],
  ["options number element", { question: "Q", options: [5] }],
  ["options string element", { question: "Q", options: ["abc"] }],
  ["options array element", { question: "Q", options: [[1]] }],
  ["options empty object element", { question: "Q", options: [{}] }],
  ["option label number", { question: "Q", options: [{ label: 3 }] }],
  ["option label null", { question: "Q", options: [{ label: null }] }],
  ["option label array", { question: "Q", options: [{ label: ["a", "b"] }] }],
  ["option label object", { question: "Q", options: [{ label: {} }] }],
  [
    "option label big integer",
    { question: "Q", options: [{ label: 12345678901234567168 }] },
  ],
  [
    "option description null",
    { question: "Q", options: [{ label: "a", description: null }] },
  ],
  [
    "option description object",
    { question: "Q", options: [{ label: "a", description: { z: 1, 3: 2 } }] },
  ],
  [
    "option preview number",
    { question: "Q", options: [{ label: "a", preview: 0 }] },
  ],
  [
    "option preview array",
    { question: "Q", options: [{ label: "a", preview: [[], {}] }] },
  ],
  [
    "option extra keys dropped",
    { question: "Q", options: [{ label: "a", extra: 1 }] },
  ],
]) {
  permission(`question: ${label}`, withQuestion(question));
}

permission(
  "question: second question throws after the first is fine",
  withQuestions([{ question: "A" }, null]),
);
permission(
  "question: several questions keep their order",
  withQuestions([
    { question: "A", options: [{ label: "1" }, { label: "2" }] },
    { question: "B", header: "H", multiSelect: true },
    { question: "C", options: [] },
  ]),
);

for (const [label, raw] of [
  [
    "duplicate keys keep the first position",
    '{"session_id":"s1","tool_input":{"questions":[{"question":"A","header":1,"header":2}]}}',
  ],
  [
    "float forms",
    '{"session_id":"s1","tool_input":{"questions":[{"question":"A","header":[1.0,1E2,-0,-0.0,0.10,1e0,2.5e-3,123456789012345678901234567890,0.000001,0.0000001,1e21,1e20,5e-324,1.7976931348623157e308,4294967296,-12.50]}]}}',
  ],
  [
    "unicode escapes",
    '{"session_id":"s1","tool_input":{"questions":[{"question":"\\u00e9\\ud83d\\ude00\\u0000\\u001f","header":"\\/"}]}}',
  ],
  [
    "proto key",
    '{"session_id":"s1","tool_input":{"questions":[{"question":"A","header":{"__proto__":{"x":1},"y":2}}]}}',
  ],
  [
    "whitespace around",
    ' \n\t{"session_id" : "s1" , "tool_input":{"questions":[{"question":"A"}]}}\r\n ',
  ],
  [
    "trailing garbage",
    '{"session_id":"s1","tool_input":{"questions":[{"question":"A"}]}} x',
  ],
  [
    "nested depth",
    `{"session_id":"s1","tool_input":{"questions":[{"question":"A","header":${"[".repeat(60)}1${"]".repeat(60)}}]}}`,
  ],
]) {
  permission(`raw input: ${label}`, raw);
}

permission(
  "session: id mixes the session and the time",
  ask({ session_id: "s/../1" }),
);

const DELAY_CONFIGS = [
  ["no config", undefined],
  ["minutes 5", '{"delayMinutes":5}'],
  ["minutes fraction", '{"delayMinutes":0.5}'],
  ["minutes string", '{"delayMinutes":"3"}'],
  ["minutes zero", '{"delayMinutes":0}'],
  ["minutes negative", '{"delayMinutes":-2}'],
  ["minutes true", '{"delayMinutes":true}'],
  ["minutes array", '{"delayMinutes":[2]}'],
  ["minutes object", '{"delayMinutes":{}}'],
  ["minutes null", '{"delayMinutes":null}'],
  ["minutes overflow", '{"delayMinutes":1e305}'],
  ["minutes big", '{"delayMinutes":1e18}'],
  ["config array", "[1]"],
  ["config broken", "{broken"],
  ["config null", "null"],
];

for (const [label, config] of DELAY_CONFIGS) {
  for (const delay of [
    undefined,
    "5000",
    "0",
    "-1",
    "abc",
    "",
    "  ",
    " 1500.5 ",
    "1e3",
    "0x10",
    "Infinity",
    "1e21",
  ]) {
    const files =
      config === undefined ? {} : { "app/better-cc-telegram.json": config };
    const env =
      delay === undefined ? {} : { BETTER_CC_TELEGRAM_DELAY_MS: delay };

    permission(`delay: ${label} with env ${JSON.stringify(delay)}`, ask(), {
      files,
      env,
    });
  }

  addScenario(`delay: ${label} on stop`, "stop", stopInput("waiting"), {
    files:
      config === undefined ? {} : { "app/better-cc-telegram.json": config },
  });
}

permission("transcript: absent path", ask(), { active: "bot" });
permission("transcript: missing file", transcriptAsk(), { active: "bot" });
permission(
  "transcript: empty path",
  ask({ transcript_path: "" }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: fraction path",
  ask({ transcript_path: 1.5 }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: negative path",
  ask({ transcript_path: -1 }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: array path",
  ask({ transcript_path: [TRANSCRIPT_PATH] }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: object path",
  ask({ transcript_path: {} }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: true path",
  ask({ transcript_path: true }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: directory path",
  ask({ transcript_path: "{root}/t" }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission(
  "transcript: path with a null byte",
  ask({ transcript_path: "{root}/t\u0000x" }),
  withTranscript(lines(assistantText("x"), toolUse)),
);
permission("transcript: empty file", transcriptAsk(), withTranscript(""));
permission(
  "transcript: blank lines only",
  transcriptAsk(),
  withTranscript("\n \n\t\n \n﻿\n"),
);
permission(
  "transcript: broken lines only",
  transcriptAsk(),
  withTranscript("{broken\n[1,\nnope\n"),
);

permission(
  "transcript: joins text since the last user entry",
  transcriptAsk(),
  withTranscript(
    lines(
      assistantText("old"),
      user(),
      assistantText("Part 1."),
      { type: "attachment" },
      assistantText("Part 2."),
      toolUse,
    ),
  ),
);
permission(
  "transcript: tool result is a user entry",
  transcriptAsk(),
  withTranscript(
    lines(
      assistantText("before"),
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      assistantText("After the result."),
      toolUse,
    ),
  ),
);
permission(
  "transcript: user as the very last entry",
  transcriptAsk(),
  withTranscript(lines(assistantText("before"), user())),
);
permission(
  "transcript: no user entry at all",
  transcriptAsk(),
  withTranscript(lines(assistantText("one"), assistantText("two"), toolUse)),
);
permission(
  "transcript: several text blocks in one entry",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      assistant(text("a"), block("thinking", { thinking: "x" }), text("b")),
      assistant(text("c")),
      toolUse,
    ),
  ),
);
permission(
  "transcript: thinking and tool blocks only",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      assistant(block("thinking", { thinking: "x", text: "ignored" })),
      toolUse,
    ),
  ),
);
permission(
  "transcript: text is trimmed with the javascript whitespace set",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      assistantText("\u{a0}\u{feff} padded \u{2028}\u{3000}\n"),
      assistantText("\u0085edge​"),
    ),
  ),
);
permission(
  "transcript: blank text blocks are dropped",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      assistantText(""),
      assistantText("   \n\t"),
      assistantText("  "),
    ),
  ),
);
permission(
  "transcript: text block without text or with null text",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      assistant(block("text")),
      assistant(text(null)),
      assistantText("kept"),
    ),
  ),
);
permission(
  "transcript: text block with number text throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text(5)))),
);
permission(
  "transcript: text block with true text throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text(true)))),
);
permission(
  "transcript: text block with false text throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text(false)))),
);
permission(
  "transcript: text block with array text throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text([])))),
);
permission(
  "transcript: text block with object text throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text({})))),
);
permission(
  "transcript: text block with zero text throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text(0)))),
);
permission(
  "transcript: non text block with odd text is ignored",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      assistant(
        block("thinking", { text: 5 }),
        block("tool_use", { text: {} }),
      ),
      assistantText("fine"),
    ),
  ),
);
permission(
  "transcript: null block throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(null))),
);
permission(
  "transcript: null block after a text block still throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistant(text("a"), null))),
);
permission(
  "transcript: primitive blocks are ignored",
  transcriptAsk(),
  withTranscript(
    lines(user(), assistant(5, "text", [1], true), assistantText("fine")),
  ),
);
permission(
  "transcript: bad block before the last user entry is never examined",
  transcriptAsk(),
  withTranscript(
    lines(assistant(null), assistant(text(5)), user(), assistantText("fine")),
  ),
);
permission(
  "transcript: bad block in an entry after the user entry throws",
  transcriptAsk(),
  withTranscript(lines(user(), assistantText("fine"), assistant(text(5)))),
);
permission(
  "transcript: assistant message shapes",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      { type: "assistant" },
      { type: "assistant", message: null },
      { type: "assistant", message: "text" },
      { type: "assistant", message: 5 },
      { type: "assistant", message: [] },
      { type: "assistant", message: {} },
      { type: "assistant", message: { content: "text" } },
      { type: "assistant", message: { content: null } },
      { type: "assistant", message: { content: { type: "text", text: "x" } } },
      { type: "assistant", message: { content: [] } },
      assistantText("only this"),
    ),
  ),
);
permission(
  "transcript: odd entries between messages",
  transcriptAsk(),
  withTranscript(
    lines(
      user(),
      "null",
      "5",
      '"text"',
      "[1]",
      "true",
      "{}",
      { type: "system", message: { content: [text("not assistant")] } },
      { type: "Assistant", message: { content: [text("wrong case")] } },
      assistantText("kept"),
    ),
  ),
);
permission(
  "transcript: user type must match exactly",
  transcriptAsk(),
  withTranscript(
    lines(
      assistantText("early"),
      { type: "User" },
      { type: "user " },
      assistantText("late"),
    ),
  ),
);
permission(
  "transcript: windows line endings",
  transcriptAsk(),
  withTranscript(
    `${JSON.stringify(user())}\r\n${JSON.stringify(assistantText("crlf"))}\r\n`,
  ),
);
permission(
  "transcript: last line without a newline",
  transcriptAsk(),
  withTranscript(
    `${JSON.stringify(user())}\n${JSON.stringify(assistantText("tail"))}`,
  ),
);
permission(
  "transcript: broken lines are skipped",
  transcriptAsk(),
  withTranscript(
    `${JSON.stringify(user())}\n{truncated\n${JSON.stringify(assistantText("kept"))}\n[1,2\n`,
  ),
);
permission(
  "transcript: line with unicode whitespace around the json fails to parse",
  transcriptAsk(),
  withTranscript(
    `${JSON.stringify(user())}\n ${JSON.stringify(assistantText("nbsp"))}\n${JSON.stringify(assistantText("plain"))}\n`,
  ),
);
permission(
  "transcript: unicode text survives",
  transcriptAsk(),
  withTranscript(lines(user(), assistantText('olá 😀 \u0001 "q" \\ \u{2028}'))),
);
permission(
  "transcript: invalid utf8 becomes replacement characters",
  transcriptAsk(),
  withTranscript({
    bytes: Array.from(
      Buffer.concat([
        Buffer.from(
          `${JSON.stringify(user())}\n{"type":"assistant","message":{"content":[{"type":"text","text":"bad `,
        ),
        Buffer.from([0xff, 0xc3]),
        Buffer.from(' byte"}]}}\n'),
      ]),
    ),
  }),
);
permission(
  "transcript: only the last four mebibytes are read",
  transcriptAsk(),
  withTranscript({
    head: lines(assistantText("early text beyond the tail")),
    pad: 5 * MIB,
    content: lines(assistantText("late text")),
  }),
);
permission(
  "transcript: multibyte padding cuts a character at the tail start",
  transcriptAsk(),
  withTranscript({
    head: lines(assistantText("early")),
    pad: 5 * MIB,
    padUnit: "é",
    content: lines(assistantText("late")),
  }),
);
permission(
  "transcript: padding exactly at the tail size",
  transcriptAsk(),
  withTranscript({
    head: lines(assistantText("early")),
    pad: 4 * MIB - 40,
    content: lines(assistantText("late")),
  }),
);
permission(
  "transcript: telegram instance still reads the context",
  transcriptAsk(),
  withTranscript(lines(user(), assistantText("ctx")), { active: "telegram" }),
);

const TITLES = [
  ["agent name", { type: "agent-name", agentName: "back-s3" }],
  ["custom title", { type: "custom-title", customTitle: "my title" }],
  ["ai title", { type: "ai-title", aiTitle: "Automatic title" }],
];

for (const [label, entry] of TITLES) {
  permission(
    `title: ${label} alone`,
    transcriptAsk(),
    withTranscript(lines(entry)),
  );
}

permission(
  "title: agent name wins over the others",
  transcriptAsk(),
  withTranscript(lines(TITLES[2][1], TITLES[1][1], TITLES[0][1])),
);
permission(
  "title: custom title wins over the ai title",
  transcriptAsk(),
  withTranscript(lines(TITLES[2][1], TITLES[1][1])),
);
permission(
  "title: the latest entry wins",
  transcriptAsk(),
  withTranscript(
    lines(
      { type: "agent-name", agentName: "first" },
      { type: "agent-name", agentName: "second" },
    ),
  ),
);
permission(
  "title: falsy fields are skipped to an earlier entry",
  transcriptAsk(),
  withTranscript(
    lines(
      { type: "agent-name", agentName: "earlier" },
      { type: "agent-name", agentName: "" },
      { type: "agent-name", agentName: null },
      { type: "agent-name", agentName: 0 },
      { type: "agent-name" },
    ),
  ),
);
permission(
  "title: all falsy falls through to the next kind",
  transcriptAsk(),
  withTranscript(
    lines(
      { type: "agent-name", agentName: "" },
      { type: "custom-title", customTitle: false },
      { type: "ai-title", aiTitle: "ai" },
    ),
  ),
);
permission(
  "title: all falsy falls back to the folder",
  transcriptAsk(),
  withTranscript(
    lines(
      { type: "agent-name", agentName: "" },
      { type: "custom-title", customTitle: null },
      { type: "ai-title", aiTitle: 0 },
    ),
  ),
);
permission(
  "title: wrong field name is ignored",
  transcriptAsk(),
  withTranscript(
    lines(
      { type: "agent-name", customTitle: "x" },
      { type: "ai-title", agentName: "y" },
    ),
  ),
);

for (const [label, value] of [
  ["number", 5],
  ["float", 1.5],
  ["true", true],
  ["object", { a: 1, 2: "b" }],
  ["array", ["a", 1]],
  ["empty array", []],
  ["whitespace string", "   "],
  ["huge number", 1e21],
]) {
  permission(
    `title: ${label} value is kept raw`,
    transcriptAsk(),
    withTranscript(lines({ type: "ai-title", aiTitle: value })),
  );
}

permission(
  "title: non object entries are ignored",
  transcriptAsk(),
  withTranscript(
    lines("null", "5", '"agent-name"', "[1]", {
      type: "ai-title",
      aiTitle: "ok",
    }),
  ),
);
permission(
  "title: telegram instance has no label",
  transcriptAsk(),
  withTranscript(lines(TITLES[0][1]), { active: "telegram" }),
);
permission(
  "title: found even after the user boundary",
  transcriptAsk(),
  withTranscript(lines(TITLES[0][1], user(), assistantText("ctx"))),
);

addScenario(
  "stop: writes the waiting ping",
  "stop",
  stopInput("  I need the ok.  "),
  { active: "bot" },
);
addScenario(
  "stop: telegram instance has no label",
  "stop",
  stopInput("I need the ok."),
);
addScenario(
  "stop: title from the transcript",
  "stop",
  stopInput("hello", { transcript_path: TRANSCRIPT_PATH }),
  withTranscript(lines(TITLES[0][1])),
);
addScenario(
  "stop: cwd with a number throws without a label",
  "stop",
  stopInput("hello", { cwd: 5 }),
  { active: "bot" },
);
addScenario(
  "stop: cwd with a number is fine on telegram",
  "stop",
  stopInput("hello", { cwd: 5 }),
);

for (const [label, message] of [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
  ["spaces", "   "],
  ["unicode spaces", "  ﻿"],
  ["number", 5],
  ["true", true],
  ["array", ["a"]],
  ["object", { a: 1 }],
  ["multiline", "line one\nline two\n"],
  ["unicode padded", "\u{2028} hi \u{3000}"],
  ["escapes", 'q "x" \\ \u0001 \u007f'],
  ["emoji", "😀"],
]) {
  const input = stopInput(message);

  if (message === undefined) delete input.last_assistant_message;

  addScenario(`stop: message ${label}`, "stop", input, { active: "bot" });
}

addScenario(
  "stop: overwrites an existing ping and keeps its mode",
  "stop",
  stopInput("new"),
  {
    active: "bot",
    files: {
      "app/pings/s1.json": {
        content: "old content that is much longer than the new one",
        mode: 0o640,
      },
    },
  },
);
addScenario("stop: ping path is a directory", "stop", stopInput("new"), {
  active: "bot",
  files: { "app/pings/s1.json/x": "1" },
});
addScenario("stop: pings folder is a file", "stop", stopInput("new"), {
  active: "bot",
  files: { "app/pings": "file" },
});
addScenario("stop: app folder is a file", "stop", stopInput("new"), {
  active: "bot",
  files: { app: "file" },
});
addScenario(
  "stop: existing pings folder keeps its mode",
  "stop",
  stopInput("new"),
  {
    active: "bot",
    files: { "app/pings/other.json": "{}" },
  },
);
addScenario(
  "stop: other sessions pings are untouched",
  "stop",
  stopInput("new"),
  {
    active: "bot",
    files: { "app/pings/s2.json": '{"sessionId":"s2"}' },
  },
);
addScenario(
  "stop: message is ignored when blank and an old ping stays",
  "stop",
  stopInput(" "),
  {
    active: "bot",
    files: { "app/pings/s1.json": "old" },
  },
);

addScenario(
  "prompt: removes the ping of the session",
  "prompt",
  { session_id: "s1" },
  {
    active: "bot",
    files: { "app/pings/s1.json": "{}", "app/pings/s2.json": "{}" },
  },
);
addScenario(
  "prompt: nothing to remove",
  "prompt",
  { session_id: "s1" },
  { active: "bot" },
);
addScenario("prompt: telegram instance writes the last prompt time", "prompt", {
  session_id: "tg",
});
addScenario(
  "prompt: last prompt keeps an existing mode",
  "prompt",
  { session_id: "tg" },
  {
    files: {
      "app/pings/last-prompt": { content: "123456789012345", mode: 0o640 },
    },
  },
);
addScenario(
  "prompt: bot instance does not write the time",
  "prompt",
  { session_id: "s1" },
  { active: "bot" },
);
addScenario(
  "prompt: ping path is a directory",
  "prompt",
  { session_id: "s1" },
  {
    active: "bot",
    files: {
      "app/pings/s1.json/x": "1",
      "app/asks/a.json": recordFile("a", "s1"),
    },
  },
);
addScenario(
  "prompt: ping path is a directory on telegram",
  "prompt",
  { session_id: "s1" },
  {
    files: {
      "app/pings/s1.json/x": "1",
      "app/asks/a.json": recordFile("a", "s1"),
    },
  },
);
addScenario(
  "prompt: pings folder is a file",
  "prompt",
  { session_id: "s1" },
  {
    active: "bot",
    files: { "app/pings": "file", "app/asks/a.json": recordFile("a", "s1") },
  },
);
addScenario(
  "prompt: last prompt path is a directory",
  "prompt",
  { session_id: "tg" },
  {
    files: {
      "app/pings/last-prompt/x": "1",
      "app/asks/a.json": recordFile("a", "tg"),
    },
  },
);
addScenario(
  "prompt: closes the asks of the session",
  "prompt",
  { session_id: "s1" },
  {
    active: "bot",
    files: {
      "app/asks/a.json": recordFile("a", "s1"),
      "app/asks/b.json": recordFile("b", "s2"),
    },
  },
);
addScenario(
  "prompt: session without id uses the shared ping name",
  "prompt",
  {},
  {
    active: "bot",
    files: { "app/pings/session.json": "{}" },
  },
);

for (const [label, prompt] of [
  [
    "a message from another Claude session",
    'Another Claude session sent a message:\n<cross-session-message from="x">hi</cross-session-message>',
  ],
  ["a cross-session idle notice", "[Cross-session idle notice] peer is idle"],
  ["a cross-session delivery notice", "[Cross-session delivery notice] held"],
  [
    "a Telegram channel message",
    '<channel source="plugin:telegram:telegram" chat_id="1">hello</channel>',
  ],
  [
    "a padded Telegram channel message",
    '\n \t\u{a0}\u{feff}<channel source="plugin:telegram:telegram">hello</channel>',
  ],
  ["typed text", "do X"],
  [
    "text that only quotes a channel tag",
    'read <channel source="plugin:telegram">',
  ],
  [
    "text that starts like a notice in lower case",
    "[cross-session idle notice]",
  ],
  ["text with the prefix cut short", "Another Claude session sent a message"],
  ["an empty prompt", ""],
  ["a blank prompt", "  \n "],
  ["a number", 5],
  ["null", null],
  ["an object", { text: "[Cross-session idle notice]" }],
  ["an array", ["[Cross-session idle notice]"]],
]) {
  for (const active of ["telegram", "bot"]) {
    addScenario(
      `prompt on ${active}: prompt with ${label}`,
      "prompt",
      { session_id: "tg", prompt },
      {
        ...(active === "bot" ? { active: "bot" } : {}),
        files: {
          "app/pings/tg.json": "{}",
          "app/asks/a.json": recordFile("a", "tg"),
        },
      },
    );
  }
}

const CLOSE_INPUT = { session_id: "s1" };

for (const mode of ["post", "prompt"]) {
  const close = (name, options, input = CLOSE_INPUT) =>
    addScenario(`close ${mode}: ${name}`, mode, input, {
      active: "bot",
      ...options,
    });

  close("no asks folder", {});
  close("empty asks folder", { files: { "app/asks/": { dir: true } } });
  close("same, other and null sessions", {
    files: {
      "app/asks/same.json": recordFile("same", "s1"),
      "app/asks/other.json": recordFile("other", "s2"),
      "app/asks/null.json": recordFile("null", null),
      "app/asks/absent.json": recordFile("absent", undefined),
    },
  });
  close("session id types never match a string", {
    files: {
      "app/asks/num.json": recordFile("num", 1),
      "app/asks/bool.json": recordFile("bool", true),
      "app/asks/obj.json": recordFile("obj", {}),
      "app/asks/arr.json": recordFile("arr", ["s1"]),
      "app/asks/empty.json": recordFile("empty", ""),
    },
  });
  close(
    "input without session only closes null sessions",
    {
      files: {
        "app/asks/same.json": recordFile("same", "s1"),
        "app/asks/null.json": recordFile("null", null),
        "app/asks/empty.json": recordFile("empty", ""),
      },
    },
    {},
  );
  close(
    "input with a null session id",
    {
      files: {
        "app/asks/same.json": recordFile("same", "session"),
        "app/asks/null.json": recordFile("null", null),
      },
    },
    { session_id: null },
  );
  close(
    "empty session id matches an empty record session",
    {
      files: {
        "app/asks/empty.json": recordFile("empty", ""),
        "app/asks/same.json": recordFile("same", "s1"),
      },
    },
    { session_id: "" },
  );
  close(
    "numeric session id aborts the whole event",
    {
      files: { "app/asks/same.json": recordFile("same", 5) },
    },
    { session_id: 5 },
  );
  close("skips telegram and answer files", {
    files: {
      "app/asks/a.telegram.json": recordFile("a-telegram", "s1"),
      "app/asks/a.answer.json": recordFile("a-answer", "s1"),
      "app/asks/b.json": recordFile("b", "s1"),
      "app/asks/c.closed": "",
      "app/asks/d.txt": recordFile("d", "s1"),
      "app/asks/json": recordFile("json", "s1"),
      "app/asks/e.JSON": recordFile("e", "s1"),
    },
  });
  close("names that merely contain the skipped suffix", {
    files: {
      "app/asks/x.telegram.json.json": recordFile("x1", "s1"),
      "app/asks/x.answer.jsonx.json": recordFile("x2", "s1"),
      "app/asks/telegram.json": recordFile("x3", "s1"),
      "app/asks/.telegram.json": recordFile("x4", "s1"),
    },
  });
  close("broken and odd records", {
    files: {
      "app/asks/a.json": "{broken",
      "app/asks/b.json": "[1,2]",
      "app/asks/c.json": "null",
      "app/asks/d.json": "5",
      "app/asks/e.json": '"id"',
      "app/asks/f.json": "{}",
      "app/asks/g.json": '{"id":5,"sessionId":"s1"}',
      "app/asks/h.json": '{"id":null,"sessionId":"s1"}',
      "app/asks/i.json": '{"id":["i"],"sessionId":"s1"}',
      "app/asks/j.json": "",
      "app/asks/k.json": recordFile("k", "s1"),
    },
  });
  close("record that is a directory", {
    files: {
      "app/asks/dir.json/x": "1",
      "app/asks/ok.json": recordFile("ok", "s1"),
    },
  });
  close("existing closed file keeps its mode", {
    files: {
      "app/asks/a.json": recordFile("a", "s1"),
      "app/asks/a.closed": { content: "old", mode: 0o640 },
    },
  });
  close("record id differs from the file name", {
    files: { "app/asks/file-name.json": recordFile("other-id", "s1") },
  });
  close("two files with the same id", {
    files: {
      "app/asks/a.json": recordFile("same-id", "s1"),
      "app/asks/b.json": recordFile("same-id", null),
    },
  });
  close("unicode and spaced ids", {
    files: {
      "app/asks/u.json": recordFile("ünï 😀 x", "s1"),
      "app/asks/s.json": recordFile("with space", "s1"),
      "app/asks/e.json": recordFile("", "s1"),
    },
  });
  close("record with a utf8 byte order mark is not parsed", {
    files: { "app/asks/a.json": `﻿${recordFile("a", "s1")}` },
  });
  close("record with invalid utf8 still parses", {
    files: {
      "app/asks/a.json": {
        bytes: Array.from(
          Buffer.concat([
            Buffer.from('{"id":"a","note":"'),
            Buffer.from([0xff]),
            Buffer.from('","sessionId":"s1"}'),
          ]),
        ),
      },
    },
  });
  close("id climbing into the parent folder", {
    files: { "app/asks/a.json": recordFile("../escaped", "s1") },
  });
  close("id with a dot segment", {
    files: { "app/asks/a.json": recordFile("./dotted", "s1") },
  });
  close("id with a nested existing folder", {
    files: {
      "app/asks/a.json": recordFile("sub/inner", "s1"),
      "app/asks/sub/keep": "1",
    },
  });
  close("id with a missing folder aborts the loop", {
    files: {
      "app/asks/a.json": recordFile("missing/inner", "s1"),
      "app/asks/b.json": recordFile("b", "s1"),
    },
  });
  close("id with a missing folder after a good one", {
    files: {
      "app/asks/a.json": recordFile("a", "s1"),
      "app/asks/b.json": recordFile("missing/inner", "s1"),
      "app/asks/c.json": recordFile("c", "s1"),
    },
  });
  close("absolute looking id stays inside the asks folder", {
    files: { "app/asks/a.json": recordFile("/abs", "s1") },
  });
  close("id that resolves to a dot dot pair", {
    files: {
      "app/asks/sub/keep": "1",
      "app/asks/a.json": recordFile("sub/../via", "s1"),
    },
  });
  close("id that is a directory name", {
    files: {
      "app/asks/a.json": recordFile("here", "s1"),
      "app/asks/here.closed/x": "1",
    },
  });
  close("closing leaves the answer and telegram files alone", {
    files: {
      "app/asks/a.json": recordFile("a", "s1"),
      "app/asks/a.answer.json": '{"answers":{"Q":"A"}}',
      "app/asks/a.telegram.json": '{"messageId":1}',
    },
  });
  close("telegram instance closes too", {
    active: "telegram",
    files: { "app/asks/a.json": recordFile("a", "s1") },
  });
  close("asks path is a file", { files: { "app/asks": "file" } });
  close("many records are all closed in name order", {
    files: Object.fromEntries(
      ["b", "a", "c", "B", "_", "1", "é"].map((id) => [
        `app/asks/${id}.json`,
        recordFile(id, "s1"),
      ]),
    ),
  });
}

permission("write: creates the asks folder with private modes", ask());
permission("write: existing asks folder keeps its mode", ask(), {
  files: { "app/asks/other.json": recordFile("other", "x") },
});
permission("write: asks path is a file", ask(), {
  files: { "app/asks": "file" },
});
permission("write: app path is a file", ask(), { files: { app: "file" } });
permission("write: existing record keeps its mode and is rewritten", ask(), {
  files: {
    "app/asks/s1-1700000000123.json": {
      content:
        "old content that is much longer than the new record would ever be, really",
      mode: 0o640,
    },
  },
});
permission("write: record path is a directory", ask(), {
  files: { "app/asks/s1-1700000000123.json/x": "1" },
});
permission("write: leaves other records alone", ask(), {
  files: {
    "app/asks/s1-1.json": recordFile("s1-1", "s1"),
    "app/asks/s1-1.closed": "",
  },
});
permission("write: state folder is irrelevant to the record", ask(), {
  active: "bot",
  files: { "state/other": "x" },
});

const GATE_PIDS = [
  ["alive", "4242"],
  ["alive with newline", "4242\n"],
  ["alive with spaces", "  4242  "],
  ["alive hex", "0x1092"],
  ["alive octal", "0o10222"],
  ["alive binary", "0b1000010010010"],
  ["alive exponent", "4.242e3"],
  ["dead", "4243"],
  ["two", "2"],
  ["one", "1"],
  ["zero", "0"],
  ["negative", "-7"],
  ["fraction", "2.5"],
  ["trailing junk", "12abc"],
  ["empty", ""],
  ["whitespace", " \n"],
  ["junk", "abc"],
  ["infinity", "Infinity"],
  ["nan", "NaN"],
  ["huge", "99999999999"],
  ["int32 max", "2147483647"],
  ["int32 overflow", "2147483648"],
  ["float huge", "1e21"],
  ["plus sign", "+4242"],
  ["two lines", "4242\n4243"],
  ["unicode space", " 4242 "],
];

const gate = [];

for (const [label, pid] of GATE_PIDS) {
  gate.push({ name: `pid ${label}`, env: {}, files: { "state/bot.pid": pid } });
}

gate.push({ name: "no pid file", env: {}, files: {} });
gate.push({ name: "flag only", env: { BETTER_CC_TELEGRAM: "1" }, files: {} });
gate.push({
  name: "flag skips the pid",
  env: { BETTER_CC_TELEGRAM: "1" },
  files: { "state/bot.pid": "4242" },
});
gate.push({
  name: "flag zero reads the pid",
  env: { BETTER_CC_TELEGRAM: "0" },
  files: { "state/bot.pid": "4242" },
});
gate.push({
  name: "state dir falls back to the claude dir",
  env: { TELEGRAM_STATE_DIR: null, CLAUDE_CONFIG_DIR: "{root}/claude" },
  files: { "claude/channels/telegram/bot.pid": "4242" },
});
gate.push({
  name: "state dir falls back to the home",
  env: { TELEGRAM_STATE_DIR: null },
  files: { "home/.claude/channels/telegram/bot.pid": "4242" },
});
gate.push({
  name: "pid file is a directory",
  env: {},
  files: { "state/bot.pid/x": "1" },
});

const delays = [];

for (const [, config] of DELAY_CONFIGS) {
  for (const env of [
    undefined,
    "5000",
    "0",
    "-1",
    "abc",
    "",
    "   ",
    "1e3",
    "0x10",
    "Infinity",
    "1.5",
    "  7  ",
  ]) {
    delays.push({ env: env ?? null, config: config ?? "{}" });
  }
}

delays.push({ env: null, config: '{"delayMinutes":[[3]]}' });
delays.push({ env: null, config: '{"delayMinutes":["4"]}' });
delays.push({ env: null, config: '{"delayMinutes":[1,2]}' });
delays.push({ env: null, config: '{"delayMinutes":[true]}' });
delays.push({ env: null, config: '{"delayMinutes":[null]}' });
delays.push({ env: null, config: '{"delayMinutes":" 0x10 "}' });
delays.push({ env: null, config: '{"delayMinutes":"1e2"}' });
delays.push({ env: null, config: '{"delayMinutes":"abc"}' });
delays.push({ env: null, config: '{"delayMinutes":false}' });

const transcripts = [
  "",
  "\n",
  lines(user(), assistantText("a"), assistantText("b")),
  lines(assistantText("a"), user(), assistantText("b")),
  lines(assistantText("a"), user()),
  lines(user(), assistant(null)),
  lines(assistant(null), user()),
  lines(user(), assistant(text(5))),
  lines(user(), assistant(text("  "), text(null), block("text"))),
  lines(user(), assistant(text("x"), text("y")), assistantText("z")),
  lines(user(), { type: "assistant", message: { content: "text" } }),
  lines(user(), "null", "[]", "{}", "5"),
  "{broken\n" + lines(user(), assistantText("kept")),
  lines(TITLES[0][1], TITLES[1][1], TITLES[2][1]),
  lines(TITLES[1][1], TITLES[2][1]),
  lines(TITLES[2][1]),
  lines({ type: "agent-name", agentName: "" }),
  lines(
    { type: "agent-name", agentName: 5 },
    { type: "agent-name", agentName: 0 },
  ),
  lines({ type: "ai-title", aiTitle: { b: 1, 1: 2 } }),
  lines({ type: "ai-title", aiTitle: [1, "x"] }),
];

const inputsForLabel = [
  { cwd: "/a/proj", session_id: "abcdef" },
  { session_id: "abcdef" },
  { cwd: "", session_id: "abcdef" },
  { cwd: "/", session_id: "ab" },
  { cwd: "/a/b/", session_id: "a😀bcd" },
  { cwd: 5, session_id: "abcdef" },
  { cwd: "/a/b" },
  { cwd: "/a/b", session_id: null },
  { cwd: "/a/b", session_id: 123456 },
  { cwd: "/a/b", session_id: {} },
  { cwd: "/a/b", session_id: ["xy", "z"] },
  { cwd: "/a/b", session_id: true },
  { cwd: "/a/b", session_id: 1.5e300 },
  { cwd: [], session_id: "abcd" },
  { cwd: 0, session_id: "abcd" },
  { cwd: "x", session_id: "" },
];

function plain(value) {
  return value === undefined ? null : value;
}

function attempt(run) {
  try {
    return { threw: false, value: run() };
  } catch {
    return { threw: true, value: undefined };
  }
}

const contexts = transcripts.map((source, index) => {
  const { threw, value } = attempt(() => contextBeforeTool(source));

  return { text: index, threw, out: threw ? null : value };
});

const names = transcripts.map((source, index) => ({
  text: index,
  out: JSON.stringify(sessionNameFromTranscript(source)),
}));

const instances = [];

for (const [index, source] of transcripts.entries()) {
  for (const input of inputsForLabel) {
    for (const flag of [undefined, "1"]) {
      const env = flag === undefined ? {} : { BETTER_CC_TELEGRAM: flag };
      const { threw, value } = attempt(() => instanceLabel(input, env, source));

      instances.push({
        text: index,
        input: JSON.stringify(input),
        telegram: flag === "1",
        threw,
        out: threw ? null : JSON.stringify(plain(value)),
      });
    }
  }
}

const decisionInputs = [
  ['{"questions":[{"question":"Q?"}]}', '{"Q?":"A"}'],
  ['{"questions":[]}', "{}"],
  ['{"questions":[1],"a":1}', '{"x":1}'],
  ['{"answers":"stale","questions":[]}', '{"x":1}'],
  ['{"b":1,"answers":2,"a":3}', '{"x":1}'],
  ['{"z":1,"2":"two","1":"one","y":2}', '{"10":1,"9":2,"b":3,"a":4}'],
  ['{"q":1}', '["a","b"]'],
  ['{"q":1}', "[]"],
  ['{"q":1}', "{}"],
  ['{"q":1}', '[{"a":1},[2,3],"x",null,true]'],
  [
    '{"q":1}',
    '{"n":[1.0,1E2,-0,0.1,1e21,1e-7,1e20,123456789012345678901234567890,0.000001,5e-324,4294967296,-12.50]}',
  ],
  ['{"q":1}', '{"s":"a\\"b\\\\c\\n\\t\\u0001\\u007f\\u2028é😀</script>"}'],
  ['{"q":1}', '{"a":{"b":{"c":[{"d":null}]}}}'],
  ['{"q":1}', '{"__proto__":{"x":1},"y":2}'],
  ['{"__proto__":{"x":1},"q":1}', '{"y":2}'],
  ['{"q":{"n":-0,"m":2.50,"k":1e0}}', '{"x":1}'],
  [
    '{"4294967294":"max","4294967295":"over","01":"z","1":"a","-1":"n","+1":"p","1.5":"f"}',
    '{"x":1}',
  ],
  ['{"a":1,"a":2,"b":3,"a":4}', '{"a":5,"a":6}'],
  ['{"q":1}', '{"":""}'],
  ['{"q":1}', '{"k":"\\ud83d\\ude00"}'],
];

const decisions = decisionInputs.map(([toolInput, answers]) => ({
  toolInput,
  answers,
  out: JSON.stringify(
    permissionDecision(JSON.parse(toolInput), JSON.parse(answers)),
  ),
}));

function substitute(value, root) {
  return typeof value === "string" ? value.replaceAll("{root}", root) : value;
}

function bodyOf(spec) {
  if (typeof spec === "string") return Buffer.from(spec);
  if (spec.bytes !== undefined) return Buffer.from(spec.bytes);

  const unit = spec.padUnit ?? "a";
  const padding = spec.pad
    ? `${unit.repeat(Math.floor(spec.pad / Buffer.byteLength(unit)))}\n`
    : "";

  return Buffer.from(`${spec.head ?? ""}${padding}${spec.content ?? ""}`);
}

function ensureFolder(root, folder) {
  let current = root;

  for (const part of relative(root, folder).split("/").filter(Boolean)) {
    current = join(current, part);

    try {
      lstatSync(current);
    } catch {
      mkdirSync(current);
      chmodSync(current, 0o750);
    }
  }
}

function materialize(root, files) {
  const hidden = new Set();

  for (const [path, spec] of Object.entries(files)) {
    const target = join(root, path);

    if (path.endsWith("/")) {
      ensureFolder(root, target);
      continue;
    }

    ensureFolder(root, dirname(target));

    const content = typeof spec === "string" ? substitute(spec, root) : spec;
    const normalized =
      typeof content === "object" && content.content !== undefined
        ? { ...content, content: substitute(content.content, root) }
        : content;

    writeFileSync(target, bodyOf(normalized));
    chmodSync(
      target,
      typeof spec === "object" && spec.mode ? spec.mode : 0o600,
    );

    if (typeof spec === "object" && spec.pad) hidden.add(path);
  }

  return hidden;
}

function snapshot(root, hidden) {
  const out = {};

  function walk(folder) {
    for (const name of readdirSync(folder).toSorted()) {
      const full = join(folder, name);
      const path = relative(root, full);
      const stats = lstatSync(full);
      const mode = (stats.mode & 0o777).toString(8);

      if (stats.isDirectory()) {
        out[`${path}/`] = { mode };
        walk(full);
      } else if (!hidden.has(path)) {
        out[path] = { content: readFileSync(full).toString("utf8"), mode };
      }
    }
  }

  walk(root);

  return out;
}

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "bcct-fixture-"));
  const previousHome = process.env.HOME;

  process.env.HOME = join(root, "home");

  try {
    return run(root);
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

function resolveEnv(env, root) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, substitute(value, root)]),
  );
}

function parseInput(stdin) {
  try {
    return JSON.parse(stdin);
  } catch {
    return {};
  }
}

function runScenario(scenario) {
  return withRoot((root) => {
    const hidden = materialize(root, scenario.files);
    const env = resolveEnv(scenario.env, root);
    const input = parseInput(substitute(scenario.stdin, root));

    hookWrites.paths.clear();
    hookWrites.active = true;

    const { threw, value } = attempt(() =>
      handleTelegramEvent(scenario.mode, input, env, NOW),
    );

    hookWrites.active = false;

    return {
      ...scenario,
      threw,
      returned: threw ? null : JSON.stringify(value ?? null),
      after: snapshot(root, hidden),
      written: [...hookWrites.paths]
        .map((path) => relative(root, path))
        .toSorted(),
    };
  });
}

function runGate(entry) {
  return withRoot((root) => {
    materialize(root, entry.files);

    const calls = [];
    const env = resolveEnv(
      { TELEGRAM_STATE_DIR: "{root}/state", ...entry.env },
      root,
    );
    const out = telegramActive(env, (pid) => {
      calls.push(pid);
      return pid === ALIVE_PID;
    });

    return { ...entry, out, calls };
  });
}

function runDelay(entry) {
  const env =
    entry.env === null ? {} : { BETTER_CC_TELEGRAM_DELAY_MS: entry.env };

  return { ...entry, out: String(delayMs(env, parseInput(entry.config))) };
}

const fixture = {
  now: NOW,
  alivePid: ALIVE_PID,
  scenarios: scenarios.map(runScenario),
  gate: gate.map(runGate),
  delays: delays.map(runDelay),
  texts: transcripts,
  contexts,
  names,
  instances,
  decisions,
};

function escapeLineSeparators(source) {
  return source.replaceAll(
    /[\u{2028}\u{2029}]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16)}`,
  );
}

const formatted = await format(JSON.stringify(fixture), { parser: "json" });

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, escapeLineSeparators(formatted));
