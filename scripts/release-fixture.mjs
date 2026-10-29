import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  FIXED_CLOCK,
  NOW,
  REPO_ROOT,
  materialize,
  placeholders,
  resolveEnv,
  snapshot,
  withRoot,
  writeFixture,
} from "./fixture-support.mjs";

const RELEASE = join(REPO_ROOT, "scripts", "release.mjs");
const CONFIG = "app/better-cc-telegram.json";
const PT_BR = { [CONFIG]: JSON.stringify({ language: "pt-br" }) };
const DUE = NOW + 60_000;

const scenarios = [];

function add(name, options = {}) {
  const env = {
    HOME: "{root}/home",
    BETTER_CC_TELEGRAM_DIR: "{root}/app",
  };

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }

  scenarios.push({
    name,
    args: options.args ?? [],
    env,
    files: options.files ?? {},
  });
}

const record = (id, extra = {}) =>
  JSON.stringify({
    id,
    sessionId: `${id}-session`,
    instance: `proj [${id}]`,
    dueAt: DUE,
    questions: [{ question: `${id}?`, header: `H-${id}` }],
    ...extra,
  });
const ask = (id, extra) => ({ [`app/asks/${id}.json`]: record(id, extra) });

add("nothing: no asks folder");
add("nothing: no asks folder with a prefix", { args: ["abc"] });
add("nothing: no asks folder in pt-br", { files: PT_BR });
add("nothing: no asks folder with a prefix in pt-br", {
  args: ["abc"],
  files: PT_BR,
});
add("nothing: empty asks folder", { files: { "app/asks/": "" } });
add("nothing: asks is a file", { files: { "app/asks": "x" } });
add("nothing: blank prefix counts as none", { args: ["   "] });
add("nothing: empty prefix counts as none", { args: [""] });
add("nothing: padded prefix is trimmed", { args: ["  ab \n"] });

add("release: one pending question", { files: ask("a") });
add("release: one pending question in pt-br", {
  files: { ...ask("a"), ...PT_BR },
});
add("release: several in name order", {
  files: { ...ask("c"), ...ask("a"), ...ask("b"), ...ask("B"), ...ask("_") },
});
add("release: extra arguments are ignored", {
  args: ["a-se", "more"],
  files: ask("a"),
});

add("skip: already sent, closed or answered", {
  files: {
    ...ask("sent"),
    "app/asks/sent.telegram.json": "{}",
    ...ask("closed"),
    "app/asks/closed.closed": "",
    ...ask("answered"),
    "app/asks/answered.answer.json": "{}",
    ...ask("open"),
  },
});
add("skip: other files and folders", {
  files: {
    "app/asks/notes.txt": record("notes"),
    "app/asks/folder.json/": "",
    "app/asks/x.json.tmp": record("x"),
    "app/asks/.json": record(""),
    "app/asks/y.JSON": record("y"),
    ...ask("open"),
  },
});
add("skip: a hidden id still counts", {
  files: { "app/asks/.json": record("") },
});
add("skip: the empty id is skipped when its marker exists", {
  files: { "app/asks/.json": record(""), "app/asks/.closed": "" },
});

for (const [label, prefix] of Object.entries({
  "matching prefix": "a-se",
  "full session": "a-session",
  "longer than the session": "a-session-x",
  "other prefix": "b",
  "case differs": "A",
  "padded matching prefix": "  a-se  ",
})) {
  add(`prefix: ${label}`, { args: [prefix], files: ask("a") });
}

for (const [label, sessionId, prefix] of [
  ["null session uses the id", null, "a"],
  ["null session uses the id, other prefix", null, "x"],
  ["number session", 123, "12"],
  ["float session", 1.5, "1.5"],
  ["object session", { a: 1 }, "[object"],
  ["array session", ["ab", "c"], "ab,c"],
  ["nested array session", [["x", null], 1], "x,,1"],
  ["true session", true, "tr"],
  ["false session", false, "fa"],
  ["empty session with empty prefix", "", ""],
  ["empty session with a prefix", "", "a"],
  ["unicode session", "sessão-😀", "sessão-😀"],
]) {
  add(`session: ${label}`, {
    args: [prefix],
    files: ask("a", { sessionId }),
  });
}

add("session: missing session uses the id", {
  args: ["a"],
  files: { "app/asks/a.json": JSON.stringify({ id: "a", dueAt: DUE }) },
});

for (const [label, dueAt] of Object.entries({
  "exactly now": NOW,
  "one ms ago": NOW - 1,
  "one ms ahead": NOW + 1,
  "half ms ahead": NOW + 0.5,
  huge: 1e300,
  negative: -5,
  string: String(DUE),
  null: null,
  array: [DUE],
  bool: true,
})) {
  add(`dueAt: ${label}`, { files: ask("a", { dueAt }) });
}

add("dueAt: missing", {
  files: { "app/asks/a.json": JSON.stringify({ id: "a" }) },
});

for (const [label, id] of Object.entries({
  number: 5,
  null: null,
  array: ["a"],
  "empty string": "",
  "other than the file": "other",
})) {
  add(`id: ${label}`, { files: ask("a", { id }) });
}

add("id: missing", {
  files: { "app/asks/a.json": JSON.stringify({ dueAt: DUE }) },
});

for (const [label, text] of Object.entries({
  array: JSON.stringify([{ id: "a", dueAt: DUE }]),
  null: "null",
  string: JSON.stringify("a"),
  broken: "{",
  empty: "",
  bom: `\u{feff}${record("a")}`,
})) {
  add(`record: ${label}`, { files: { "app/asks/a.json": text, ...ask("b") } });
}

add("record: invalid utf8 keeps a replacement character", {
  files: {
    "app/asks/a.json": {
      bytes: [
        ...Buffer.from(`{"id":"a","dueAt":${DUE},"note":"`),
        0xff,
        0xfe,
        ...Buffer.from('"}'),
      ],
    },
  },
});
add("record: a lone surrogate becomes the replacement character", {
  files: {
    "app/asks/a.json": `{"id":"a","dueAt":${DUE},"note":"\\ud83d x"}`,
  },
});
add("record: key order, integer keys and dueAt keep their place", {
  files: {
    "app/asks/a.json": `{"z":1,"dueAt":${DUE},"id":"a","2":"two","1":"one","b":{"y":1,"0":2}}`,
  },
});
add("record: duplicate keys keep the first place and the last value", {
  files: {
    "app/asks/a.json": `{"id":"x","dueAt":1,"id":"a","q":1,"dueAt":${DUE}}`,
  },
});
add("record: numbers print like JSON.stringify", {
  files: {
    "app/asks/a.json": `{"id":"a","dueAt":${DUE},"n":[1.0,1E2,-0,0.10,1e21,1e-7,123456789012345678901234567890,5e-324]}`,
  },
});
add("record: strings print like JSON.stringify", {
  files: {
    "app/asks/a.json": `{"id":"a","dueAt":${DUE},"s":"a\\"b\\\\c\\n\\t\\u0001\\u007f\\u2028é😀</script>\\/"}`,
  },
});
add("record: whitespace and a proto key", {
  files: {
    "app/asks/a.json": `\n {"__proto__":{"x":1}, "id" : "a" ,\t"dueAt": ${DUE} }\n`,
  },
});

const questionSets = {
  "not an array": { header: "H" },
  "empty array": [],
  "header wins": [{ header: "H", question: "Q" }],
  "question without header": [{ question: "Q" }],
  "null header falls back": [{ header: null, question: "Q" }],
  "empty header is dropped": [{ header: "", question: "Q" }],
  "zero header is dropped": [{ header: 0, question: "Q" }],
  "false header is dropped": [{ header: false, question: "Q" }],
  "true header": [{ header: true }],
  "number header": [{ header: 1.5 }],
  "array header": [{ header: ["a", ["b", null]] }],
  "empty array header": [{ header: [] }, { header: "H" }],
  "object header": [{ header: {} }],
  "neither header nor question": [{}],
  "non object questions": [null, "text", 5, ["x"], true],
  several: [
    { header: "One" },
    { question: "Two?" },
    { header: "Three", question: "ignored" },
  ],
};

for (const [label, questions] of Object.entries(questionSets)) {
  add(`headers: ${label}`, { files: ask("a", { questions }) });
}

add("headers: missing questions", {
  files: { "app/asks/a.json": JSON.stringify({ id: "a", dueAt: DUE }) },
});

for (const [label, instance] of Object.entries({
  null: null,
  empty: "",
  number: 7,
  object: { a: 1 },
  array: ["a", "b"],
  false: false,
  unicode: "projeto [ãé]",
})) {
  add(`instance: ${label}`, { files: ask("a", { instance }) });
}

add("instance: missing", {
  files: {
    "app/asks/a.json": JSON.stringify({ id: "a", dueAt: DUE, questions: [] }),
  },
});

add("folder: claude config dir when the app dir is unset", {
  env: { BETTER_CC_TELEGRAM_DIR: null, CLAUDE_CONFIG_DIR: "{root}/cfg" },
  files: {
    "cfg/better-claude-code-telegram/asks/a.json": record("a"),
    "cfg/better-claude-code-telegram/better-cc-telegram.json": JSON.stringify({
      language: "pt-br",
    }),
  },
});
add("folder: the home claude folder when nothing is set", {
  env: { BETTER_CC_TELEGRAM_DIR: "" },
  files: {
    "home/.claude/better-claude-code-telegram/asks/a.json": record("a"),
  },
});
add("folder: the app dir is normalized like path.join", {
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/x/../app/" },
  files: ask("a"),
});
add("mode: a public record becomes private", {
  files: { "app/asks/a.json": { content: record("a"), mode: 0o644 } },
});
add("locale: unknown language falls back to en-us", {
  files: { ...ask("a"), [CONFIG]: JSON.stringify({ language: "fr" }) },
});

function runScenario(scenario) {
  return withRoot((root) => {
    materialize(root, scenario.files);

    const result = spawnSync(
      process.execPath,
      [FIXED_CLOCK, RELEASE, ...scenario.args],
      { cwd: root, env: resolveEnv(scenario.env, root) },
    );

    return {
      ...scenario,
      status: result.status,
      stdout: placeholders(result.stdout.toString("utf8"), root),
      stderr: placeholders(result.stderr.toString("utf8"), root),
      after: snapshot(root),
    };
  });
}

await writeFixture("release.json", {
  now: NOW,
  scenarios: scenarios.map(runScenario),
});
