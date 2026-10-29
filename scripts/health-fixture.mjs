import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FIXED_CLOCK,
  NOW,
  REPO_ROOT,
  materialize,
  placeholders,
  resolveEnv,
  snapshot,
  writeFixture,
} from "./fixture-support.mjs";
import {
  BCCT_PLUGIN_ID,
  CHANNEL_PLUGIN_ID,
  HOOKS_PLUGIN_ID,
  SHELL_MARKER,
} from "./setup.mjs";

const HEALTH = join(REPO_ROOT, "scripts", "health.mjs");
const NODE_VERSION = process.versions.node;
const SYSTEM_PATH = "/usr/bin:/bin";
const ENV_FILE = "state/.env";
const ACCESS_FILE = "state/access.json";
const SETTINGS_FILE = "claude/settings.json";
const CONFIG_FILE = "app/better-cc-telegram.json";
const HEALTH_FILE = "app/health.json";
const LAUNCH_FILE = "app/launch.json";
const REQUEST_FILE = "app/statusline-customize.json";
const PYTHON = "app/whisper/venv/bin/python";
const SHELL_FILE = "{repo}/scripts/shell.sh";
const OUR_STATUSLINE = 'node "{repo}/plugins/telegram-hooks/statusline.mjs"';
const SPINNER_FRAMES = new Set([
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
]);
const CYAN = "\u001B[36m";
const NODE_WARNING =
  /^\(node:\d+\) (Warning: [^\n]*)\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/m;

process.umask(0o022);

const json = (value) => JSON.stringify(value);
const executable = (lines) => ({
  content: ["#!/bin/sh", ...lines, ""].join("\n"),
  mode: 0o755,
});
const claudeScript = ({ slow = false, exit = 0 } = {}) =>
  executable([
    'here="$(dirname "$0")/.."',
    ...(slow ? ["sleep 0.5"] : []),
    'printf \'%s\\n\' "$*" >> "$here/claude-calls"',
    '[ -f "$here/plugins.txt" ] && cat "$here/plugins.txt"',
    `exit ${exit}`,
  ]);
const pythonScript = (exit) =>
  executable(['printf \'%s\\n\' "$@" > "$0-args"', `exit ${exit}`]);
const nodeScript = (version) =>
  executable([`printf 'v%s\\n' ${shellQuote(version)}`]);

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

const ALL_PLUGINS = `${CHANNEL_PLUGIN_ID}\n${HOOKS_PLUGIN_ID}\n${BCCT_PLUGIN_ID}\n`;
const SOURCE_BLOCK = `${SHELL_MARKER}\n[ -f "${SHELL_FILE}" ] && . "${SHELL_FILE}"\n`;
const reply = (body, status = 200) => ({ status, body: json(body) });
const raw = (body, status = 200) => ({ status, body });
const BOT = { username: "e2e_bot", can_join_groups: false };
const GET_ME = reply({ ok: true, result: BOT });
const GET_CHAT = reply({
  ok: true,
  result: { id: 42, username: "dev", first_name: "Dev" },
});
const DROP = { drop: true };

function access(extra = {}) {
  return json({
    dmPolicy: "allowlist",
    allowFrom: ["42"],
    groups: {},
    pending: {},
    ...extra,
  });
}

function settings(extra = {}) {
  return json({
    statusLine: { type: "command", command: OUR_STATUSLINE },
    permissions: { deny: ["Read(/{root}/state/.env)"] },
    ...extra,
  });
}

const HEALTHY = {
  "bin/claude": claudeScript(),
  "bin/bun": executable(["exit 0"]),
  "bin/mmdc": executable(["exit 0"]),
  "plugins.txt": ALL_PLUGINS,
  [ENV_FILE]: "TELEGRAM_BOT_TOKEN=123:FAKE\n",
  [ACCESS_FILE]: access(),
  "home/.bashrc": SOURCE_BLOCK,
  [SETTINGS_FILE]: settings(),
  [CONFIG_FILE]: json({ language: "en-us", transcription: { model: "small" } }),
  [HEALTH_FILE]: '{"polling":true,"checkedAt":{now-1000}}',
  [PYTHON]: pythonScript(0),
};

const BASE_ENV = {
  HOME: "{root}/home",
  CLAUDE_CONFIG_DIR: "{root}/claude",
  TELEGRAM_STATE_DIR: "{root}/state",
  BETTER_CC_TELEGRAM_DIR: "{root}/app",
  BETTER_CC_TELEGRAM_API_ROOT: "{api}",
  SHELL: "/bin/bash",
  PATH: `{root}/bin:${SYSTEM_PATH}`,
};

function merged(base, extra = {}) {
  const out = { ...base };

  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }

  return out;
}

const scenarios = [];

function add(name, options = {}) {
  const nodeVersion = options.nodeVersion ?? NODE_VERSION;

  scenarios.push({
    name,
    args: options.args ?? [],
    env: merged(BASE_ENV, options.env),
    files: merged(
      { ...HEALTHY, "bin/node": nodeScript(nodeVersion) },
      options.files,
    ),
    replies: options.replies ?? [GET_ME, GET_CHAT],
    api: options.api ?? "fake",
    uid: options.uid ?? null,
    nodeVersion,
    process: options.process ?? true,
  });
}

add("a healthy machine passes every check");
add("a healthy machine as json", { args: ["--json"] });
for (const args of [
  ["all"],
  ["tudo"],
  ["ALL"],
  [" Tudo "],
  ["install", "all"],
  [""],
  ["  "],
  ["install"],
  ["telegram"],
  ["security"],
  ["extras"],
  ["security", "install"],
  ["install", "install"],
  ["EXTRAS", " security "],
  ["--json", "security"],
  ["security", "--json"],
  ["--json", "--json", "extras"],
]) {
  add(`groups ${json(args)}`, { args });
}
for (const args of [
  ["speed"],
  ["speed", "fast"],
  ["install", "speed"],
  ["speed", "speed"],
  ["--JSON"],
  ["--json", "speed"],
  ["-j"],
  ["Ínstall"],
]) {
  add(`unknown groups ${json(args)}`, { args });
}
add("unknown groups in pt-br", {
  args: ["rapidez"],
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
});
add("unknown groups painted red on stderr", {
  args: ["speed"],
  env: { FORCE_COLOR: "1" },
});

for (const version of [
  "24.11.0",
  "24.10.9",
  "25.0.0",
  "24",
  "23.99.0",
  "24.11",
  "100.0.0",
  "24.x",
  "24.11.0-pre",
  "v24.20.0",
  "0.0.0",
  "24.011.0",
  "024.11.0",
  "1e2.0",
]) {
  add(`node ${version}`, { args: ["install"], nodeVersion: version });
}
add("node too old in pt-br", {
  args: ["install"],
  nodeVersion: "22.0.0",
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
});

add("claude missing", { args: ["install"], files: { "bin/claude": null } });
add("bun missing", { args: ["install"], files: { "bin/bun": null } });
add("everything missing", {
  args: ["install", "extras"],
  files: { "bin/claude": null, "bin/bun": null, "bin/mmdc": null },
});
add("only the channel plugin", {
  args: ["install"],
  files: { "plugins.txt": `${CHANNEL_PLUGIN_ID}\n` },
});
add("only the hooks plugin", {
  args: ["install"],
  files: { "plugins.txt": `${HOOKS_PLUGIN_ID}\n` },
});
add("no plugin listed", { args: ["install"], files: { "plugins.txt": null } });
add("plugins inside other text", {
  args: ["install"],
  files: {
    "plugins.txt": `  ❯ ${CHANNEL_PLUGIN_ID} (1.0)\n    ${HOOKS_PLUGIN_ID}x\n`,
  },
});
add("claude that fails still lists the plugins", {
  args: ["install"],
  files: { "bin/claude": claudeScript({ exit: 3 }) },
});
add("plugins missing in pt-br", {
  args: ["install"],
  files: {
    "plugins.txt": null,
    [CONFIG_FILE]: json({ language: "pt-br" }),
  },
});

const ZSH_BLOCK = { "home/.zshrc": SOURCE_BLOCK };

add("zsh loads it", {
  args: ["install"],
  env: { SHELL: "/bin/zsh" },
  files: { "home/.bashrc": null, ...ZSH_BLOCK },
});
add("zsh without a zshrc but bash loads it", {
  args: ["install"],
  env: { SHELL: "/usr/bin/zsh" },
});
add("zsh with neither", {
  args: ["install"],
  env: { SHELL: "/bin/zsh" },
  files: { "home/.bashrc": null },
});
add("bash with neither", {
  args: ["install"],
  files: { "home/.bashrc": null },
});
add("bash with a zshrc that loads it", {
  args: ["install"],
  files: { "home/.bashrc": "# nothing\n", ...ZSH_BLOCK },
});
add("bash with a bashrc that does not load it", {
  args: ["install"],
  files: { "home/.bashrc": "alias x=y\n" },
});
add("fish is not supported", {
  args: ["install"],
  env: { SHELL: "/usr/bin/fish" },
  files: { "home/.bashrc": null },
});
add("fish is not supported in pt-br", {
  args: ["install"],
  env: { SHELL: "/usr/bin/fish" },
  files: { "home/.bashrc": null, [CONFIG_FILE]: json({ language: "pt-br" }) },
});
add("fish with a bashrc that loads it", {
  args: ["install"],
  env: { SHELL: "/usr/bin/fish" },
});
add("no SHELL means bash", { args: ["install"], env: { SHELL: null } });
add("an empty SHELL means bash", { args: ["install"], env: { SHELL: "" } });
add("a bare shell name", {
  args: ["install"],
  env: { SHELL: "zsh" },
  files: ZSH_BLOCK,
});
add("a shell with a trailing slash", {
  args: ["install"],
  env: { SHELL: "/bin/zsh//" },
  files: { "home/.bashrc": null, ...ZSH_BLOCK },
});
add("a shell that is only a slash", {
  args: ["install"],
  env: { SHELL: "/" },
  files: { "home/.bashrc": null },
});
add("a shell named dot dot", {
  args: ["install"],
  env: { SHELL: "/bin/.." },
  files: { "home/.bashrc": null },
});
add("a bashrc that is a folder", {
  args: ["install"],
  env: { SHELL: "/bin/zsh" },
  files: { "home/.bashrc": null, "home/.bashrc/": "" },
});
add("the shell file only mentioned in a comment", {
  args: ["install"],
  files: { "home/.bashrc": `# see ${SHELL_FILE}\n` },
});
add("a zshrc with invalid utf-8 before a bashrc that loads it", {
  args: ["install"],
  env: { SHELL: "/bin/zsh" },
  files: { "home/.zshrc": { bytes: [0xff, 0x0a, 0x23, 0xfe, 0x0a] } },
});
add("a home with a trailing slash", {
  args: ["install"],
  env: { HOME: "{root}/home/" },
});
add("no HOME stops the install checks", {
  args: ["install"],
  env: { HOME: null },
  process: false,
});
add("no HOME stops the run as json", {
  args: ["--json"],
  env: { HOME: null },
  process: false,
});
add("no HOME still checks the security", {
  args: ["security"],
  env: { HOME: null },
  process: false,
});
add("a shell name with escape codes painted", {
  args: ["install"],
  env: { SHELL: "/bin/fi\u001B[22msh\u001B[22m", FORCE_COLOR: "1" },
  files: { "home/.bashrc": null },
});

add("no token", { args: ["telegram"], files: { [ENV_FILE]: null } });
add("no token in pt-br", {
  args: ["telegram"],
  files: { [ENV_FILE]: null, [CONFIG_FILE]: json({ language: "pt-br" }) },
});
add("a blank token", {
  args: ["telegram"],
  files: { [ENV_FILE]: "TELEGRAM_BOT_TOKEN=   \n" },
});
add("the token after other lines", {
  args: ["telegram"],
  files: { [ENV_FILE]: "A=1\r\nTELEGRAM_BOT_TOKEN= 123:FAKE \r\n" },
});
add("a token file that is a folder", {
  args: ["telegram"],
  files: { [ENV_FILE]: null, [`${ENV_FILE}/`]: "" },
});

for (const [label, token] of Object.entries({
  "a space": "12 3:A b",
  unicode: "123:é😀",
  "a tab": "12\t3:A",
  "a fragment": "123:A#frag/x",
  "a query": "1?q x'é\"<>`{}^|[]\\",
  "a backslash": "1\\2:A",
  "a dot dot segment": "1/../2",
  "a dot segment": "1/./2",
  "an encoded dot dot segment": "1/%2e%2E/2",
  "a mixed dot dot segment": "1/.%2e/2",
  "a trailing dot dot": "1/..",
  "dot dot past the root": "1/../../../x",
  "path characters": '1"<>`{}^|[]~!$&()*+,;=:@%zz',
  "control characters": "1\u0001\u007F2",
})) {
  add(`a token with ${label}`, {
    args: ["telegram"],
    files: { [ENV_FILE]: `TELEGRAM_BOT_TOKEN=${token}\n` },
  });
}

for (const [label, root] of Object.entries({
  "a trailing slash": "{api}/",
  "a prefix": "{api}/prefix",
  "a prefix and dot dot": "{api}/p/..",
  "a query": "{api}?x=1",
  "a fragment": "{api}#x",
  "spaces around": "  {api}  ",
  "a tab inside": "{api}/a\tb",
  "a non url": "not a url",
  "an ftp url": "ftp://127.0.0.1:1",
})) {
  add(`an api root with ${label}`, {
    args: ["telegram"],
    env: { BETTER_CC_TELEGRAM_API_ROOT: root },
  });
}

const telegramReplies = {
  "the bot can join groups": [
    reply({ ok: true, result: { ...BOT, can_join_groups: true } }),
    GET_CHAT,
  ],
  "a truthy can_join_groups": [
    reply({ ok: true, result: { ...BOT, can_join_groups: "no" } }),
    GET_CHAT,
  ],
  "a zero can_join_groups": [
    reply({ ok: true, result: { ...BOT, can_join_groups: 0 } }),
    GET_CHAT,
  ],
  "Telegram refuses the token": [
    reply({ ok: false, error_code: 401, description: "Unauthorized" }, 401),
    GET_CHAT,
  ],
  "a refusal without description": [reply({ ok: false }), GET_CHAT],
  "a refusal with a null description": [
    reply({ ok: false, description: null }),
    GET_CHAT,
  ],
  "a refusal with a number description": [
    reply({ ok: false, description: 5.5 }),
    GET_CHAT,
  ],
  "a refusal with an object description": [
    reply({ ok: false, description: { a: 1 } }),
    GET_CHAT,
  ],
  "a refusal with a list description": [
    reply({ ok: false, description: ["a", null, ["b", 2]] }),
    GET_CHAT,
  ],
  "a refusal with a false ok": [
    reply({ ok: 0, description: "zero" }),
    GET_CHAT,
  ],
  "a string ok counts as ok": [reply({ ok: "false", result: BOT }), GET_CHAT],
  "a body that is not json": [raw("<html>"), GET_CHAT],
  "an empty body": [raw(""), GET_CHAT],
  "a null body": [raw("null"), GET_CHAT],
  "a text body": [raw('"text"'), GET_CHAT],
  "a list body": [raw("[1]"), GET_CHAT],
  "a number body": [raw("7"), GET_CHAT],
  "a body with a byte order mark": [
    raw(`\u{feff}${json({ ok: true, result: BOT })}`),
    GET_CHAT,
  ],
  "a body with invalid utf-8": [
    {
      status: 200,
      bytes: [
        ...Buffer.from('{"ok":true,"result":{"username":"a'),
        0xff,
        ...Buffer.from('b"}}'),
      ],
    },
    GET_CHAT,
  ],
  "a body with a lone surrogate": [
    raw('{"ok":true,"result":{"username":"a\\ud800b"}}'),
    GET_CHAT,
  ],
  "a server error with a refusal": [
    reply({ ok: false, description: "Internal" }, 500),
    GET_CHAT,
  ],
  "a dropped connection": [DROP, GET_CHAT],
  "a result that is a number": [reply({ ok: true, result: 5 }), GET_CHAT],
  "a result without a username": [reply({ ok: true, result: {} }), GET_CHAT],
  "a username that is a number": [
    reply({ ok: true, result: { username: 7 } }),
    GET_CHAT,
  ],
  "a username with escape codes": [
    reply({
      ok: true,
      result: { username: "a\u001B[39mb", can_join_groups: true },
    }),
    GET_CHAT,
  ],
  "a result without the bot is a crash": [reply({ ok: true }), GET_CHAT],
  "a null result is a crash": [reply({ ok: true, result: null }), GET_CHAT],
};

for (const [label, replies] of Object.entries(telegramReplies)) {
  add(label, { args: ["telegram"], replies });
}
add("a username with escape codes painted", {
  args: ["telegram"],
  env: { FORCE_COLOR: "1" },
  replies: telegramReplies["a username with escape codes"],
});
add("a crash in pt-br as json", {
  args: ["--json", "telegram"],
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
  replies: [reply({ ok: true }), GET_CHAT],
});
add("a crash painted red", {
  args: ["telegram"],
  env: { FORCE_COLOR: "1" },
  replies: [reply({ ok: true }), GET_CHAT],
});
add("a refused connection", { args: ["telegram"], api: "refused" });
add("a refused connection in pt-br", {
  args: ["telegram"],
  api: "refused",
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
});
add("a refused connection for the account after the bot", {
  args: ["telegram"],
  replies: [GET_ME, DROP],
});

for (const [label, chat] of Object.entries({
  "only a first name": { first_name: "Dev" },
  "an empty username": { username: "", first_name: "Dev" },
  "a zero username": { username: 0, first_name: 5 },
  "no names": { id: 42 },
  "empty names": { username: "", first_name: "" },
  "a list username": { username: ["a", "b"] },
})) {
  add(`the account with ${label}`, {
    args: ["telegram"],
    replies: [GET_ME, reply({ ok: true, result: chat })],
  });
}
for (const [label, replyToChat] of Object.entries({
  "a refused account": reply({ ok: false, description: "chat not found" }),
  "a null account": reply({ ok: true, result: null }),
  "an account without result": reply({ ok: true }),
  "an account that is text": reply({ ok: true, result: "dev" }),
  "an account body that is not json": raw("oops"),
  "a null account body": raw("null"),
})) {
  add(label, { args: ["telegram"], replies: [GET_ME, replyToChat] });
}

for (const [label, allowFrom] of Object.entries({
  "a number id": [42],
  "a null id": [null],
  "an object id": [{ a: 1 }],
  "a quoted id": ['4"2'],
  "a one character text": "7",
  "a two character text": "42",
  "an emoji text": "😀",
  "an empty list": [],
  "a number": 5,
  "an object with index keys": { 0: "42" },
  "two accounts": ["1", "2"],
  "three accounts": ["1", "2", "3"],
  "a null list": null,
})) {
  add(`allowFrom ${label}`, {
    args: ["telegram"],
    files: { [ACCESS_FILE]: access({ allowFrom }) },
  });
  add(`allowFrom ${label} without a token`, {
    args: ["telegram"],
    files: { [ACCESS_FILE]: access({ allowFrom }), [ENV_FILE]: null },
  });
}
add("too many accounts in pt-br", {
  args: ["telegram"],
  files: {
    [ACCESS_FILE]: access({ allowFrom: ["1", "2"] }),
    [CONFIG_FILE]: json({ language: "pt-br" }),
  },
});

for (const [label, text] of Object.entries({
  missing: null,
  null: "null",
  "a number": "5",
  "a list": "[]",
  "a text": '"abc"',
  broken: "{",
  "without allowFrom": json({ dmPolicy: "allowlist" }),
})) {
  add(`access ${label}`, {
    args: ["telegram"],
    files: { [ACCESS_FILE]: text },
  });
}

for (const [label, extra] of Object.entries({
  "no dmPolicy": { dmPolicy: undefined },
  "a pairing dmPolicy": { dmPolicy: "pairing" },
  "a disabled dmPolicy": { dmPolicy: "disabled" },
  "a number dmPolicy": { dmPolicy: 5 },
  "a null dmPolicy": { dmPolicy: null },
  "a list dmPolicy": { dmPolicy: ["allowlist"] },
  "one pending": { pending: { abc: { senderId: "13" } } },
  "two pending": { pending: { a: 1, b: 2 } },
  "a pending list": { pending: [1, 2, 3] },
  "a pending text": { pending: "ab" },
  "a pending emoji": { pending: "😀" },
  "a pending number": { pending: 5 },
  "a null pending": { pending: null },
  "one group": { groups: { "-100": { requireMention: true } } },
  "a groups text": { groups: "abc" },
  "an empty groups list": { groups: [] },
  "pending before groups": { pending: { a: 1 }, groups: { b: 1 } },
  "policy before pending": { dmPolicy: "pairing", pending: { a: 1 } },
})) {
  add(`pairing with ${label}`, {
    args: ["telegram"],
    files: { [ACCESS_FILE]: access(extra) },
  });
}
add("pairing with a pending pairing in pt-br", {
  args: ["telegram"],
  files: {
    [ACCESS_FILE]: access({ pending: { a: 1 }, groups: { b: 1, c: 2 } }),
    [CONFIG_FILE]: json({ language: "pt-br" }),
  },
});

const polling = {
  "connected and fresh": ['{"polling":true,"checkedAt":{now-1000}}', null],
  "fresh but not polling": ['{"polling":false,"checkedAt":{now-1000}}', null],
  "fresh, not polling, just launched": [
    '{"polling":false,"checkedAt":{now-1000}}',
    '{"launchedAt":{now-1000}}',
  ],
  "stale and just launched": [
    '{"polling":true,"checkedAt":{now-60000}}',
    '{"launchedAt":{now-1000}}',
  ],
  "stale and launched long ago": [
    '{"polling":true,"checkedAt":{now-60000}}',
    '{"launchedAt":{now-120000}}',
  ],
  "no health and no launch": [null, null],
  "no health, just launched": [null, '{"launchedAt":{now-1000}}'],
  "a null health": ["null", null],
  "a number health": ["5", null],
  "a broken health": ["{", '{"launchedAt":"x"}'],
  "a text checkedAt": ['{"polling":true,"checkedAt":"{now-1000}"}', null],
  "a null checkedAt": ['{"polling":true,"checkedAt":null}', null],
  "a list checkedAt": ['{"polling":true,"checkedAt":[{now-1000}]}', null],
  "a future checkedAt": ['{"polling":true,"checkedAt":{now+100000}}', null],
  "a truthy polling": ['{"polling":"yes","checkedAt":{now-1000}}', null],
  "a zero polling": [
    '{"polling":0,"checkedAt":{now-1000}}',
    '{"launchedAt":[{now-1000}]}',
  ],
  "a null launch": [null, "null"],
};

for (const [label, [health, launch]] of Object.entries(polling)) {
  add(`polling ${label}`, {
    args: ["telegram"],
    files: { [HEALTH_FILE]: health, [LAUNCH_FILE]: launch },
  });
}
for (const [label, [health, launch]] of Object.entries({
  "checked just within the limit": [
    '{"polling":true,"checkedAt":{now-14999}}',
    null,
  ],
  "checked at the limit": ['{"polling":true,"checkedAt":{now-15000}}', null],
  "launched just within the grace": [null, '{"launchedAt":{now-59999}}'],
  "launched at the grace": [null, '{"launchedAt":{now-60000}}'],
})) {
  add(`polling ${label}`, {
    args: ["telegram"],
    files: { [HEALTH_FILE]: health, [LAUNCH_FILE]: launch },
    process: false,
  });
}
add("polling down in pt-br", {
  args: ["telegram"],
  files: {
    [HEALTH_FILE]: '{"polling":false,"checkedAt":{now-1000}}',
    [CONFIG_FILE]: json({ language: "pt-br" }),
  },
});

add("running as root", { args: ["security"], uid: 0, process: false });
add("running as root in pt-br", {
  args: ["security"],
  uid: 0,
  process: false,
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
});
add("running as root as json", {
  args: ["--json"],
  uid: 0,
  process: false,
});

for (const [label, permissions] of Object.entries({
  "no deny list": {},
  "a deny list without the rule": { deny: ["Read(~/x)"] },
  "a deny text with the rule": {
    deny: "x Read(/{root}/state/.env) y",
  },
  "a deny text without the rule": { deny: "Read(~/x)" },
  "a null deny list": { deny: null },
  "a deny list with the rule twice": {
    deny: ["Read(/{root}/state/.env)", "Read(/{root}/state/.env)"],
  },
})) {
  add(`protection with ${label}`, {
    args: ["security"],
    files: { [SETTINGS_FILE]: settings({ permissions }) },
  });
}
for (const [label, deny] of Object.entries({
  "an object deny is a crash": { a: 1 },
  "a number deny is a crash": 5,
  "a boolean deny is a crash": true,
})) {
  add(label, {
    args: ["security"],
    files: { [SETTINGS_FILE]: settings({ permissions: { deny } }) },
  });
}
add("a protection crash as json", {
  args: ["--json"],
  files: { [SETTINGS_FILE]: settings({ permissions: { deny: {} } }) },
});
for (const [label, text] of Object.entries({
  "permissions that are text": json({ permissions: "deny" }),
  "permissions that are a list": json({ permissions: [] }),
  "settings that are a list": json([1]),
  "settings that are null": "null",
  "settings that are text": '"x"',
  "broken settings": "{ broken",
  "settings with a byte order mark": `\u{feff}${settings()}`,
  "no settings": null,
})) {
  add(label, {
    args: ["security", "extras"],
    files: { [SETTINGS_FILE]: text },
  });
}
add("settings that are a folder", {
  args: ["security", "extras"],
  files: { [SETTINGS_FILE]: null, [`${SETTINGS_FILE}/`]: "" },
});
add("broken settings in pt-br", {
  args: ["security"],
  files: {
    [SETTINGS_FILE]: "{",
    [CONFIG_FILE]: json({ language: "pt-br" }),
  },
});
add("the token under the home is protected with a tilde", {
  args: ["security"],
  env: { TELEGRAM_STATE_DIR: "{root}/home/.claude/channels/telegram" },
  files: {
    [ENV_FILE]: null,
    "home/.claude/channels/telegram/.env": "TELEGRAM_BOT_TOKEN=123:FAKE\n",
    [SETTINGS_FILE]: settings({
      permissions: { deny: ["Read(~/.claude/channels/telegram/.env)"] },
    }),
  },
});
add("a home with a trailing slash does not use the tilde", {
  args: ["security"],
  env: {
    HOME: "{root}/home/",
    TELEGRAM_STATE_DIR: "{root}/home/.claude/channels/telegram",
  },
  files: {
    [SETTINGS_FILE]: settings({
      permissions: { deny: ["Read(~/.claude/channels/telegram/.env)"] },
    }),
  },
});
add("a dotted state folder is normalized in the rule", {
  args: ["security"],
  env: { TELEGRAM_STATE_DIR: "{root}/x/../state/." },
});
add("the settings in the home when the claude folder is unset", {
  args: ["security", "extras"],
  env: { CLAUDE_CONFIG_DIR: null },
  files: {
    [SETTINGS_FILE]: null,
    "home/.claude/settings.json": settings(),
  },
});
add("an empty claude folder uses the home", {
  args: ["security"],
  env: { CLAUDE_CONFIG_DIR: "" },
  files: { [SETTINGS_FILE]: null, "home/.claude/settings.json": "{" },
});
add("the app and state folders follow the claude folder", {
  args: ["telegram", "security"],
  env: { TELEGRAM_STATE_DIR: null, BETTER_CC_TELEGRAM_DIR: null },
  files: {
    "claude/channels/telegram/.env": "TELEGRAM_BOT_TOKEN=123:FAKE\n",
    "claude/channels/telegram/access.json": access(),
    "claude/better-claude-code-telegram/better-cc-telegram.json": json({
      language: "pt-br",
    }),
  },
});

for (const [label, text] of Object.entries({
  "a broken config": "{",
  "a null config": "null",
  "a number config": "5",
  "a list config": "[1]",
  "no config": null,
  "an empty config": "",
})) {
  add(`config: ${label}`, {
    args: ["security", "extras"],
    files: { [CONFIG_FILE]: text },
  });
}
add("config: a folder", {
  args: ["security"],
  files: { [CONFIG_FILE]: null, [`${CONFIG_FILE}/`]: "" },
});
add("config: a dotted app folder in the message", {
  args: ["security"],
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/./app/" },
  files: { [CONFIG_FILE]: "{" },
});

for (const [label, transcription] of Object.entries({
  "no model": {},
  "an empty model": { model: "" },
  "a number model": { model: 5 },
  "a true model": { model: true },
  "an empty list model": { model: [] },
  "an object model": { model: {} },
  "a null transcription": null,
  "a text transcription": "small",
})) {
  add(`transcription with ${label}`, {
    args: ["extras"],
    files: { [CONFIG_FILE]: json({ transcription }) },
  });
}
add("transcription off without a config", {
  args: ["extras"],
  files: { [CONFIG_FILE]: null },
});
add("transcription with a broken python", {
  args: ["extras"],
  files: { [PYTHON]: pythonScript(1) },
});
add("transcription without python", {
  args: ["extras"],
  files: { [PYTHON]: null },
});
add("transcription with a python that cannot run", {
  args: ["extras"],
  files: { [PYTHON]: { content: "#!/bin/sh\nexit 0\n", mode: 0o600 } },
});
add("transcription broken in pt-br", {
  args: ["extras"],
  files: {
    [PYTHON]: pythonScript(1),
    [CONFIG_FILE]: json({
      language: "pt-br",
      transcription: { model: "base" },
    }),
  },
});
add("mermaid missing", { args: ["extras"], files: { "bin/mmdc": null } });

const MINE = { type: "command", command: "~/bin/mine.sh" };

for (const [label, options] of Object.entries({
  "ours after yours": {
    settings: { statusLine: { command: `${OUR_STATUSLINE} --after-previous` } },
  },
  "another status line": { settings: { statusLine: MINE } },
  "no status line": { settings: {} },
  "a false status line": { settings: { statusLine: false } },
  "a text status line": { settings: { statusLine: "x" } },
  "a number command": { settings: { statusLine: { command: 5 } } },
  "customized by Claude": {
    settings: { statusLine: MINE },
    config: { statuslineCustomized: true },
  },
  "customized as text": {
    settings: { statusLine: MINE },
    config: { statuslineCustomized: "true" },
  },
  "a pending request": {
    settings: { statusLine: MINE },
    request: true,
  },
  "a pending request over a customized one": {
    settings: { statusLine: MINE },
    config: { statuslineCustomized: true },
    request: true,
  },
  "a request with ours": { settings: {}, request: true, ours: true },
})) {
  const statusSettings = options.ours
    ? settings()
    : json({ permissions: { deny: [] }, ...options.settings });

  add(`statusline: ${label}`, {
    args: ["extras"],
    files: {
      [SETTINGS_FILE]: statusSettings,
      [CONFIG_FILE]: json(options.config ?? {}),
      [REQUEST_FILE]: options.request ? "{}" : null,
    },
  });
}
add("statusline: a request that is a folder", {
  args: ["extras"],
  files: {
    [SETTINGS_FILE]: json({ statusLine: MINE }),
    [`${REQUEST_FILE}/`]: "",
  },
});
add("statusline: all of them in pt-br", {
  args: ["extras"],
  files: {
    [SETTINGS_FILE]: json({ statusLine: MINE }),
    [CONFIG_FILE]: json({ language: "pt-br", statuslineCustomized: true }),
  },
});

const LOCALES = {
  "a pt-br config": { files: { [CONFIG_FILE]: json({ language: "pt-br" }) } },
  "a pt-br system": { env: { LANG: "pt_BR.UTF-8" } },
  "an unknown config language and a pt-br system": {
    env: { LC_ALL: "pt_BR" },
    files: { [CONFIG_FILE]: json({ language: "fr" }) },
  },
  "an en-us config over a pt-br system": {
    env: { LANG: "pt_BR" },
    files: { [CONFIG_FILE]: json({ language: "en-us" }) },
  },
};

for (const [label, options] of Object.entries(LOCALES)) {
  add(`locale from ${label}`, options);
  add(`locale from ${label} as json`, { ...options, args: ["--json"] });
}

const BROKEN = {
  "bin/bun": null,
  "plugins.txt": null,
  [ENV_FILE]: null,
  [HEALTH_FILE]: null,
  [SETTINGS_FILE]: "{",
  [PYTHON]: pythonScript(1),
  "bin/mmdc": null,
};

add("everything broken", { files: BROKEN });
add("everything broken in pt-br", {
  files: { ...BROKEN, [CONFIG_FILE]: json({ language: "pt-br" }) },
});
add("everything broken as json", { args: ["--json"], files: BROKEN });

for (const [label, env] of Object.entries({
  "FORCE_COLOR=1": { FORCE_COLOR: "1" },
  "FORCE_COLOR=3": { FORCE_COLOR: "3" },
  "FORCE_COLOR=0": { FORCE_COLOR: "0" },
  "FORCE_COLOR empty": { FORCE_COLOR: "" },
  "NO_COLOR without FORCE_COLOR": { NO_COLOR: "1" },
  "FORCE_COLOR=1 with NO_COLOR": { FORCE_COLOR: "1", NO_COLOR: "1" },
  "FORCE_COLOR=1 with TERM=dumb": { FORCE_COLOR: "1", TERM: "dumb" },
})) {
  add(`colors with ${label}`, { files: BROKEN, env });
  add(`colors with ${label} as json`, { args: ["--json"], files: BROKEN, env });
}

const urls = [
  ["http://a", "t", ".."],
  ["http://a", "t", "."],
  ["http://a", "t", "%2E"],
  ["http://a", "t", "x/.%2E"],
  ["http://a", "t", "x/%2e."],
  ["http://a/p", "../t", "m"],
  ["  http://a", "t", "m"],
  ["\u0001http://a", "t", "m \u0001"],
  ["http://a", "t", "m?"],
  ["http://a", "t?", "m"],
  ["http://a", "t", "m#x"],
  ["http://a\\b", "t", "m"],
  ["http://a?q", "t", "m"],
  ["http://a#f", "t", "m"],
  ["http://a", "t\n\r\t", "m"],
  ["http://a", "é😀 \u007F\u0000", "m"],
  ["http://a", "t?'`{}^ é\"<>\u007F", "m"],
  ["http://a:8080/x//y", "t", "m"],
].map(([root, token, method]) => {
  const parsed = new URL(`${root}/bot${token}/${method}`);

  return {
    root,
    token,
    method,
    url: `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`,
  };
});

const ttyScenarios = [];

function addTty(name, options = {}) {
  ttyScenarios.push({
    name,
    args: options.args ?? [],
    columns: options.columns ?? null,
    env: merged(BASE_ENV, { TERM: "xterm-256color", ...options.env }),
    files: merged(
      { ...HEALTHY, "bin/node": nodeScript(NODE_VERSION) },
      options.files,
    ),
    replies: options.replies ?? [GET_ME, GET_CHAT],
  });
}

addTty("a terminal shows the spinner and paints it", {
  args: ["install"],
  files: { "bin/claude": claudeScript({ slow: true }) },
});
addTty("a terminal without colors", {
  env: { NO_COLOR: "1" },
  files: { "bin/claude": claudeScript({ slow: true }) },
});
addTty("a narrow terminal cuts the label", {
  args: ["install"],
  columns: 9,
  files: { "bin/claude": claudeScript({ slow: true }) },
});
addTty("a terminal narrower than the spinner", {
  args: ["install"],
  columns: 2,
});
addTty("a terminal with an emoji label in pt-br", {
  args: ["extras"],
  columns: 16,
  files: { [CONFIG_FILE]: json({ language: "pt-br", transcription: {} }) },
});
addTty("a terminal with a crash", {
  args: ["telegram"],
  replies: [reply({ ok: true }), GET_CHAT],
});
addTty("a terminal with json", { args: ["--json", "install"] });
addTty("a terminal with an unknown group", { args: ["speed"] });

function timed(files, now) {
  return Object.fromEntries(
    Object.entries(files).map(([path, spec]) => {
      const fill = (text) =>
        text.replaceAll(/\{now([+-]\d+)?\}/g, (_, offset) =>
          String(now + Number(offset ?? 0)),
        );

      if (typeof spec === "string") return [path, fill(spec)];
      if (spec.content !== undefined) {
        return [path, { ...spec, content: fill(spec.content) }];
      }

      return [path, spec];
    }),
  );
}

const telegram = { replies: [], requests: [] };
const server = createServer((request, response) => {
  const chunks = [];

  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const index = telegram.requests.length;

    telegram.requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"] ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    const answer = telegram.replies[index] ?? reply({ ok: false }, 500);

    if (answer.drop) {
      request.socket.destroy();
      return;
    }

    response.writeHead(answer.status, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      answer.bytes === undefined
        ? Buffer.from(answer.body)
        : Buffer.from(answer.bytes),
    );
  });
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));

const API = `http://127.0.0.1:${server.address().port}`;
const closed = createServer();

await new Promise((done) => closed.listen(0, "127.0.0.1", done));

const REFUSED = `http://127.0.0.1:${closed.address().port}`;

await new Promise((done) => closed.close(done));

function run(command, args, options) {
  return new Promise((done) => {
    const child = spawn(command, args, { ...options, stdio: "pipe" });
    const stdout = [];
    const stderr = [];

    child.stdin.end();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      done({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

function overrides(scenario) {
  const code = [
    scenario.uid === null ? "" : `process.getuid=()=>${scenario.uid};`,
    scenario.nodeVersion === NODE_VERSION
      ? ""
      : `Object.defineProperty(process.versions,"node",{value:${json(scenario.nodeVersion)}});`,
  ].join("");

  return code === ""
    ? []
    : [`--import=data:text/javascript,${encodeURIComponent(code)}`];
}

function apiEnv(env, scenario) {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value.replaceAll("{api}", scenario.api === "refused" ? REFUSED : API),
    ]),
  );
}

async function inRoot(work) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-fixture-")));

  try {
    return await work(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function prepare(scenario, root) {
  materialize(root, timed(scenario.files, NOW));
  telegram.replies = scenario.replies;
  telegram.requests = [];

  return apiEnv(resolveEnv(scenario.env, root), scenario);
}

function runScenario(scenario) {
  return inRoot(async (root) => {
    const env = prepare(scenario, root);
    const result = await run(
      process.execPath,
      [FIXED_CLOCK, ...overrides(scenario), HEALTH, ...scenario.args],
      { cwd: root, env },
    );

    const warning = NODE_WARNING.exec(result.stderr);

    return {
      ...scenario,
      status: result.status,
      stdout: placeholders(result.stdout, root),
      stderr: placeholders(result.stderr.replace(NODE_WARNING, ""), root),
      nodeWarning: warning === null ? null : warning[1],
      requests: telegram.requests,
      after: snapshot(root),
    };
  });
}

export function normalizeTerminal(text) {
  const parts = text.replaceAll("\r\n", "\n").split("\r");
  let repainted = 0;
  let out = parts[0];

  for (const part of parts.slice(1)) {
    const frame = part.startsWith(CYAN) ? part.slice(CYAN.length) : part;

    if (SPINNER_FRAMES.has([...frame][0]) && !part.includes("\n")) {
      repainted += 1;
    } else {
      out += `\r${part}`;
    }
  }

  return { out, repainted: repainted > 0 };
}

function runTty(scenario) {
  return inRoot(async (root) => {
    const env = prepare(scenario, root);
    const command = [
      ...(scenario.columns === null ? [] : [`stty cols ${scenario.columns};`]),
      [process.execPath, FIXED_CLOCK, HEALTH, ...scenario.args]
        .map(shellQuote)
        .join(" "),
    ].join(" ");
    const result = await run("script", ["-qec", command, "/dev/null"], {
      cwd: root,
      env,
    });
    const terminal = normalizeTerminal(placeholders(result.stdout, root));

    return {
      ...scenario,
      status: result.status,
      terminal: terminal.out,
      repainted: terminal.repainted,
      requests: telegram.requests,
    };
  });
}

const results = [];

for (const scenario of scenarios) results.push(await runScenario(scenario));

const ttyResults = [];

for (const scenario of ttyScenarios) ttyResults.push(await runTty(scenario));

await new Promise((done) => server.close(done));

await writeFixture("health.json", {
  now: NOW,
  nodeVersion: NODE_VERSION,
  scenarios: results,
  tty: ttyResults,
  urls,
});
