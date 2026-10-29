import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { WriteStream } from "node:tty";
import { dirname, join, relative } from "node:path";
import { format } from "node:util";

import {
  FIXED_CLOCK,
  NOW,
  REPO_ROOT,
  attempt,
  materialize,
  placeholders,
  resolveEnv,
  snapshot,
  withProcessEnv,
  withRoot,
  writeFixture,
} from "./fixture-support.mjs";
import {
  checkSetup,
  claudeSettingsFile,
  defaultAppDir,
  markLaunch,
  missingSetupSteps,
  skippedPermissions,
  statuslineAfterCommand,
  statuslineCommand,
  statuslinePrompt,
  telegramInstanceRunning,
  telegramStateDir,
} from "./setup.mjs";

const LAUNCHER = join(REPO_ROOT, "scripts", "telegram.sh");
const NODE_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const ENV_FILE = "state/.env";
const ACCESS_FILE = "state/access.json";
const SETTINGS_FILE = "claude/settings.json";
const APP = "claude/better-claude-code-telegram";
const CONFIG_FILE = `${APP}/better-cc-telegram.json`;
const REQUEST_FILE = `${APP}/statusline-customize.json`;
const FAKE_CLAUDE = [
  "#!/bin/sh",
  'here="$(dirname "$0")/.."',
  'printf \'%s\\0\' "$@" > "$here/claude-args"',
  'printf \'%s|%s\' "${BETTER_CC_TELEGRAM-unset}" "${EXTRA-unset}" > "$here/claude-env"',
  "printf 'claude out\\n'",
  "printf 'claude err\\n' >&2",
  'exit "${FAKE_EXIT:-0}"',
  "",
].join("\n");

process.umask(0o022);
Object.defineProperty(process.stderr, "isTTY", {
  value: false,
  configurable: true,
});

const writes = { active: false, paths: new Set() };
const plainWriteFileSync = fs.writeFileSync;

fs.writeFileSync = (path, ...rest) => {
  plainWriteFileSync(path, ...rest);

  if (writes.active) writes.paths.add(path);
};
syncBuiltinESMExports();

function tracked(run) {
  writes.paths.clear();
  writes.active = true;

  try {
    return run();
  } finally {
    writes.active = false;
  }
}

function writtenPaths(root) {
  return [...writes.paths].map((path) => relative(root, path)).toSorted();
}

const json = (value) => JSON.stringify(value);
const TOKEN = { [ENV_FILE]: "TELEGRAM_BOT_TOKEN=123:FAKE\n" };
const PAIRED = {
  [ACCESS_FILE]: json({ dmPolicy: "allowlist", allowFrom: ["42"] }),
};
const READY = { ...TOKEN, ...PAIRED };
const BASE_ENV = {
  HOME: "{root}/home",
  CLAUDE_CONFIG_DIR: "{root}/claude",
  TELEGRAM_STATE_DIR: "{root}/state",
};

function envWith(extra = {}) {
  const env = { ...BASE_ENV };

  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }

  return env;
}

const envTexts = [
  "",
  "TELEGRAM_BOT_TOKEN=abc",
  "TELEGRAM_BOT_TOKEN=abc\n",
  "TELEGRAM_BOT_TOKEN=  abc  \r\n",
  "TELEGRAM_BOT_TOKEN=",
  "TELEGRAM_BOT_TOKEN=   \n",
  "TELEGRAM_BOT_TOKEN=   \nTELEGRAM_BOT_TOKEN=abc\n",
  "OTHER=1\nTELEGRAM_BOT_TOKEN=abc\n",
  " TELEGRAM_BOT_TOKEN=abc",
  "telegram_bot_token=abc",
  "TELEGRAM_BOT_TOKEN =abc",
  "export TELEGRAM_BOT_TOKEN=abc",
  "X=1\rTELEGRAM_BOT_TOKEN=abc",
  "X=1\u{2028}TELEGRAM_BOT_TOKEN=abc",
  "X=1\u{2029}TELEGRAM_BOT_TOKEN=abc\u{2029}",
  "TELEGRAM_BOT_TOKEN=\u{a0}\u{feff}",
  "TELEGRAM_BOT_TOKEN=\u{85}",
  "\u{feff}TELEGRAM_BOT_TOKEN=abc",
  "TELEGRAM_BOT_TOKEN=\r\nTELEGRAM_BOT_TOKEN=abc",
  "TELEGRAM_BOT_TOKEN==",
  null,
];
const accessTexts = [
  json({ allowFrom: ["42"] }),
  json({ allowFrom: [] }),
  json({ allowFrom: [null] }),
  json({ allowFrom: "42" }),
  json({ allowFrom: { 0: "42" } }),
  json({}),
  json([["42"]]),
  "null",
  "{",
  "",
  null,
];

const missing = [];

for (const envText of envTexts) {
  for (const accessText of accessTexts) {
    const files = {};

    if (envText !== null) files[ENV_FILE] = envText;
    if (accessText !== null) files[ACCESS_FILE] = accessText;

    missing.push({ files });
  }
}

const permissionArgs = [
  [],
  ["--dangerously-skip-permissions"],
  ["--allow-dangerously-skip-permissions"],
  ["--permission-mode=bypassPermissions"],
  ["--permission-mode", "bypassPermissions"],
  ["--permission-mode"],
  ["--permission-mode", "plan"],
  ["--permission-mode=plan"],
  ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"],
  ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"],
  ["-c", "--permission-mode", "bypassPermissions"],
  ["bypassPermissions", "--permission-mode"],
  ["--DANGEROUSLY-SKIP-PERMISSIONS"],
  [" --dangerously-skip-permissions"],
  ["--permission-mode", "bypasspermissions"],
  ["--permission-mode", "--permission-mode", "bypassPermissions"],
];
const permissionSettings = [
  null,
  { permissions: { defaultMode: "bypassPermissions" } },
  { permissions: { defaultMode: "plan" } },
  { permissions: { defaultMode: ["bypassPermissions"] } },
  { permissions: "bypassPermissions" },
  { permissions: null },
  { defaultMode: "bypassPermissions" },
  [],
  "bypassPermissions",
  5,
];

const permissions = permissionArgs.flatMap((args) =>
  permissionSettings.map((settings) => ({
    args,
    settings,
    out: skippedPermissions(args, settings),
  })),
);

const pidTexts = [
  null,
  "",
  "  \n",
  "abc",
  "{server}",
  " {server}\n",
  "{plain}",
  "{dead}",
  "{server} {plain}",
  "{plain},{server}",
  "{plain} {plain}",
  "-{server}",
  "{server}x",
  "0",
];

function startHelper(name) {
  return spawn("sh", ["-c", "sleep 600; :", name], { stdio: "ignore" });
}

function deadPid() {
  return spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
}

const server = startHelper("server.ts");
const plain = startHelper("other.ts");
const helpers = { server: String(server.pid), plain: String(plain.pid) };

await new Promise((resolveWait) => setTimeout(resolveWait, 300));

function withPids(text) {
  return text
    .replaceAll("{server}", helpers.server)
    .replaceAll("{plain}", helpers.plain)
    .replaceAll("{dead}", helpers.dead);
}

function withoutPids(text) {
  return text
    .replaceAll(helpers.server, "{server}")
    .replaceAll(helpers.plain, "{plain}");
}

helpers.dead = deadPid();

const running = pidTexts.map((pidText) =>
  withRoot((root) => {
    if (pidText !== null) {
      materialize(root, { "state/bot.pid": withPids(pidText) });
    }

    const out = telegramInstanceRunning(join(root, "state"));

    return { pidText, out: out === null ? null : withoutPids(out) };
  }),
);

const checks = [];

function check(name, options = {}) {
  checks.push({
    name,
    env: envWith(options.env),
    args: options.args ?? [],
    files: options.files ?? READY,
    running: options.running ?? null,
  });
}

check("nothing set up", { files: {} });
check("only the token is missing", { files: PAIRED });
check("only the pairing is missing", { files: TOKEN });
check("nothing set up in pt-br", {
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
});
check("the system language suggests pt-br", {
  files: {},
  env: { LANG: "pt_BR.UTF-8" },
});
check("an unknown config language falls back to the system", {
  files: { [CONFIG_FILE]: json({ language: "fr" }) },
  env: { LANG: "pt_BR.UTF-8" },
});
check("the config language wins over the system", {
  files: { [CONFIG_FILE]: json({ language: "en-us" }) },
  env: { LANG: "pt_BR.UTF-8" },
});
check("LC_ALL wins over LANG", {
  files: {},
  env: { LC_ALL: "en_US.UTF-8", LANG: "pt_BR.UTF-8" },
});
check("an empty LC_ALL falls to LC_MESSAGES", {
  files: {},
  env: { LC_ALL: "", LC_MESSAGES: "pt_BR", LANG: "en_US" },
});
check("LC_MESSAGES wins over LANG", {
  files: {},
  env: { LC_MESSAGES: "en", LANG: "pt_BR" },
});
check("the system language is case insensitive", {
  files: {},
  env: { LANG: "PT-BR" },
});
check("a short system language is not enough", {
  files: {},
  env: { LANG: "pt" },
});
check("a longer system language still matches", {
  files: {},
  env: { LANG: "pt_br_x" },
});
check("a padded system language does not match", {
  files: {},
  env: { LANG: " pt_BR" },
});
check("ready opens");
check("ready with arguments opens", { args: ["--continue", "hello"] });
check("two accounts", {
  files: { ...TOKEN, [ACCESS_FILE]: json({ allowFrom: ["1", "2"] }) },
});
check("three accounts in pt-br", {
  files: {
    ...TOKEN,
    [ACCESS_FILE]: json({ allowFrom: ["1", "2", "3"] }),
    [CONFIG_FILE]: json({ language: "pt-br" }),
  },
});

for (const args of permissionArgs.slice(1, 6)) {
  check(`skip flag ${json(args)}`, { args });
}

check("skip flag in pt-br", {
  args: ["--dangerously-skip-permissions"],
  files: { ...READY, [CONFIG_FILE]: json({ language: "pt-br" }) },
});
check("bypass in the settings", {
  files: {
    ...READY,
    [SETTINGS_FILE]: json({
      permissions: { defaultMode: "bypassPermissions" },
    }),
  },
});
check("bypass in the home settings", {
  env: { CLAUDE_CONFIG_DIR: null },
  files: {
    ...READY,
    "home/.claude/settings.json": json({
      permissions: { defaultMode: "bypassPermissions" },
    }),
  },
});
check("bypass in settings under a dotted claude dir", {
  env: { CLAUDE_CONFIG_DIR: "{root}/claude/./x/.." },
  files: {
    ...READY,
    [SETTINGS_FILE]: json({
      permissions: { defaultMode: "bypassPermissions" },
    }),
  },
});
check("an empty claude dir uses the home settings", {
  env: { CLAUDE_CONFIG_DIR: "" },
  files: {
    ...READY,
    "home/.claude/settings.json": json({
      permissions: { defaultMode: "bypassPermissions" },
    }),
  },
});
check("the flags win over the settings", {
  args: ["--permission-mode=bypassPermissions"],
  files: {
    ...READY,
    [SETTINGS_FILE]: json({
      permissions: { defaultMode: "bypassPermissions" },
    }),
  },
});
check("broken settings do not stop it", {
  files: { ...READY, [SETTINGS_FILE]: "{" },
});
check("plan mode in the settings", {
  files: {
    ...READY,
    [SETTINGS_FILE]: json({ permissions: { defaultMode: "plan" } }),
  },
});
check("an instance already running", { running: "4242" });
check("an instance already running in pt-br", {
  running: "4242",
  files: { ...READY, [CONFIG_FILE]: json({ language: "pt-br" }) },
});
check("an instance pid kept as text", { running: "0042 7" });
check("missing setup comes before the running instance", {
  files: TOKEN,
  running: "4242",
});
check("too many accounts comes before the skip flag", {
  args: ["--dangerously-skip-permissions"],
  files: { ...TOKEN, [ACCESS_FILE]: json({ allowFrom: ["1", "2"] }) },
});
check("the skip flag comes before the running instance", {
  args: ["--dangerously-skip-permissions"],
  running: "4242",
});

for (const force of ["1", "", "true", "2", "3", "0", "false", "yes"]) {
  check(`FORCE_COLOR=${json(force)}`, {
    files: {},
    env: { FORCE_COLOR: force },
  });
}

function runCheck(entry) {
  return withRoot((root) => {
    materialize(root, entry.files);

    const env = resolveEnv(entry.env, root);
    const lines = [];
    const original = console.error;

    console.error = (...args) => lines.push(`${format(...args)}\n`);

    try {
      const code = withProcessEnv(env, () =>
        checkSetup(telegramStateDir(env), () => entry.running, {
          appDir: defaultAppDir(env),
          env,
          args: entry.args,
          settingsFile: claudeSettingsFile(env),
        }),
      );

      return { ...entry, code, stderr: placeholders(lines.join(""), root) };
    } finally {
      console.error = original;
    }
  });
}

const marks = [
  { name: "creates the nested app folder", files: {} },
  { name: "keeps an existing app folder", files: { [`${APP}/`]: "" } },
  {
    name: "replaces a public launch file",
    files: { [`${APP}/launch.json`]: { content: "old", mode: 0o644 } },
  },
  {
    name: "replaces a private launch file",
    files: { [`${APP}/launch.json`]: json({ launchedAt: 1 }) },
  },
  { name: "fails when the app folder is a file", files: { [APP]: "x" } },
].map((entry) =>
  withRoot((root) => {
    materialize(root, entry.files);

    const { threw } = tracked(() =>
      attempt(() => markLaunch(join(root, APP), NOW)),
    );

    return {
      ...entry,
      threw,
      after: snapshot(root),
      written: writtenPaths(root),
    };
  }),
);

const hideRepo = (text) => text.replaceAll(REPO_ROOT, "{repo}");
const ours = {
  statusLine: { type: "command", command: hideRepo(statuslineCommand()) },
};
const oursAfter = {
  statusLine: { type: "command", command: hideRepo(statuslineAfterCommand()) },
};
const mine = { statusLine: { type: "command", command: "~/bin/my-line.sh" } };
const REQUEST = {
  [REQUEST_FILE]: json({ requestedAt: "2026-01-01T00:00:00.000Z" }),
};

const prompts = [];

function prompt(name, options = {}) {
  prompts.push({
    name,
    take: options.take ?? true,
    env: envWith(options.env),
    files: options.files ?? {
      ...REQUEST,
      [SETTINGS_FILE]: json(mine),
    },
  });
}

prompt("no request leaves everything", {
  files: { [SETTINGS_FILE]: json(mine) },
});
prompt("a request with a status line of yours");
prompt("a request in pt-br from the config", {
  files: {
    ...REQUEST,
    [SETTINGS_FILE]: json(mine),
    [CONFIG_FILE]: json({ language: "pt-br", delayMinutes: 3 }),
  },
});
prompt("a request in pt-br from the system", { env: { LANG: "pt_BR.UTF-8" } });
prompt("a request replaces statuslineCustomized in place", {
  files: {
    ...REQUEST,
    [SETTINGS_FILE]: json(mine),
    [CONFIG_FILE]: json({ statuslineCustomized: false, language: "en-us" }),
  },
});
prompt("a request keeps the config order and numbers", {
  files: {
    ...REQUEST,
    [SETTINGS_FILE]: json(mine),
    [CONFIG_FILE]:
      '{"z":1.0,"2":"two","quietHours":{"start":"22:00","end":"07:00"},"list":[1,[],{}],"empty":{},"1":null}',
  },
});
prompt("a request over a broken config", {
  files: { ...REQUEST, [SETTINGS_FILE]: json(mine), [CONFIG_FILE]: "{" },
});
prompt("a request over an array config", {
  files: { ...REQUEST, [SETTINGS_FILE]: json(mine), [CONFIG_FILE]: "[1]" },
});
prompt("a request over a public config", {
  files: {
    ...REQUEST,
    [SETTINGS_FILE]: json(mine),
    [CONFIG_FILE]: { content: json({ language: "en-us" }), mode: 0o644 },
  },
});
prompt("a request with our status line is dropped", {
  files: { ...REQUEST, [SETTINGS_FILE]: json(ours) },
});
prompt("a request with ours after yours is dropped", {
  files: { ...REQUEST, [SETTINGS_FILE]: json(oursAfter) },
});
prompt("a request without settings is dropped", { files: REQUEST });
prompt("a request with broken settings is dropped", {
  files: { ...REQUEST, [SETTINGS_FILE]: "{" },
});

for (const [label, statusLine] of Object.entries({
  null: null,
  false: false,
  zero: 0,
  "empty string": "",
  string: "x",
  true: true,
  "empty object": {},
  "number command": { command: 5 },
  "ordered fields": {
    padding: 0,
    command: 'a "b" é \u{2028}',
    type: "command",
    1: 1,
  },
  array: [ours.statusLine],
})) {
  prompt(`status line ${label}`, {
    files: { ...REQUEST, [SETTINGS_FILE]: json({ statusLine }) },
  });
}

prompt("settings that are an array are none", {
  files: { ...REQUEST, [SETTINGS_FILE]: json([mine]) },
});
prompt("without take it only builds the prompt", { take: false });
prompt("without take and without a request it still builds the prompt", {
  take: false,
  files: { [SETTINGS_FILE]: json(mine) },
});
prompt("without take ours is still none of yours", {
  take: false,
  files: { [SETTINGS_FILE]: json(ours) },
});
prompt("a request that is a folder throws", {
  files: { [`${REQUEST_FILE}/`]: "", [SETTINGS_FILE]: json(mine) },
});
prompt("a config that is a folder throws after dropping the request", {
  files: { ...REQUEST, [SETTINGS_FILE]: json(mine), [`${CONFIG_FILE}/`]: "" },
});
prompt("the settings path is normalized", {
  env: { CLAUDE_CONFIG_DIR: "{root}/claude/./" },
});
prompt("the home settings when the claude dir is unset", {
  env: { CLAUDE_CONFIG_DIR: null, BETTER_CC_TELEGRAM_DIR: `{root}/${APP}` },
  files: { ...REQUEST, "home/.claude/settings.json": json(mine) },
});

function runPrompt(entry) {
  return withRoot((root) => {
    materialize(root, entry.files);

    const env = resolveEnv(entry.env, root);
    const { threw, value } = withProcessEnv(env, () =>
      tracked(() =>
        attempt(() =>
          statuslinePrompt(
            { take: entry.take },
            defaultAppDir(env),
            claudeSettingsFile(env),
          ),
        ),
      ),
    );

    return {
      ...entry,
      threw,
      out: threw ? null : placeholders(value, root),
      after: snapshot(root),
      written: writtenPaths(root).filter((path) => !path.startsWith("..")),
    };
  });
}

const colorEnvs = [
  {},
  { TERM: "xterm" },
  { TERM: "xterm-256color" },
  { TERM: "dumb" },
  { TERM: "DUMB" },
  { TERM: "vt100" },
  { TERM: "vt220" },
  { TERM: "vt52" },
  { TERM: "linux" },
  { TERM: "screen" },
  { TERM: "screen.xterm" },
  { TERM: "tmux" },
  { TERM: "rxvt" },
  { TERM: "cons25" },
  { TERM: "con80x25" },
  { TERM: "con80" },
  { TERM: "conx1" },
  { TERM: "my-ansi-term" },
  { TERM: "direct" },
  { TERM: "truecolor" },
  { TERM: "eterm" },
  { TERM: "Eterm" },
  { TERM: "KONSOLE" },
  { TERM: "\u{212a}onsole" },
  { TERM: "st" },
  { TERM: "putty" },
  { TERM: "mosh" },
  { TERM: "xterm-kitty" },
  { TERM: "kitty" },
  { TERM: "foot" },
  { TERM: "unknown" },
  { TERM: "" },
  { TERM: "constructor" },
  { TERM: "toString" },
  { TERM: "__proto__" },
  { TERM: "hasOwnProperty", COLORTERM: "1" },
  { TERM: "valueOf" },
  { TERM: "isPrototypeOf" },
  { TERM: "propertyIsEnumerable" },
  { TERM: "toLocaleString" },
  { TERM: "__defineGetter__" },
  { TERM: "__defineSetter__" },
  { TERM: "__lookupGetter__" },
  { TERM: "__lookupSetter__" },
  { TERM: "Constructor" },
  { COLORTERM: "truecolor" },
  { COLORTERM: "24bit" },
  { COLORTERM: "1" },
  { COLORTERM: "" },
  { TERM: "unknown", COLORTERM: "yes" },
  { TMUX: "/tmp/tmux" },
  { TMUX: "" },
  { TMUX: "1", TERM: "dumb" },
  { TF_BUILD: "", AGENT_NAME: "" },
  { TF_BUILD: "1" },
  { CI: "" },
  { CI: "1", TERM: "xterm" },
  { CI: "1", GITHUB_ACTIONS: "" },
  { CI: "1", GITLAB_CI: "1" },
  { CI: "1", TRAVIS: "1" },
  { CI: "1", APPVEYOR: "1" },
  { CI: "1", BUILDKITE: "1" },
  { CI: "1", CIRCLECI: "1" },
  { CI: "1", DRONE: "1" },
  { CI: "1", GITEA_ACTIONS: "1" },
  { CI: "1", CI_NAME: "codeship" },
  { CI: "1", CI_NAME: "other" },
  { TEAMCITY_VERSION: "9.1.0" },
  { TEAMCITY_VERSION: "9.0.1" },
  { TEAMCITY_VERSION: "9.01.0" },
  { TEAMCITY_VERSION: "9.00.1" },
  { TEAMCITY_VERSION: "10.0" },
  { TEAMCITY_VERSION: "2023.1" },
  { TEAMCITY_VERSION: "8.1.0" },
  { TEAMCITY_VERSION: "9." },
  { TEAMCITY_VERSION: "9.1" },
  { TEAMCITY_VERSION: "1.0" },
  { TEAMCITY_VERSION: "" },
  { TEAMCITY_VERSION: "x10." },
  { TERM_PROGRAM: "iTerm.app" },
  { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.4" },
  { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "2.1" },
  { TERM_PROGRAM: "HyperTerm" },
  { TERM_PROGRAM: "MacTerm" },
  { TERM_PROGRAM: "Apple_Terminal" },
  { TERM_PROGRAM: "vscode" },
  { TERM_PROGRAM: "vscode", TERM: "xterm-256color" },
  { NO_COLOR: "1", TERM: "xterm" },
  { NO_COLOR: "", TERM: "xterm" },
  { NODE_DISABLE_COLORS: "1", TERM: "xterm" },
  { NODE_DISABLE_COLORS: "", TERM: "xterm" },
  { NO_COLOR: "1", TMUX: "1" },
  { FORCE_COLOR: "1" },
  { FORCE_COLOR: "" },
  { FORCE_COLOR: "true" },
  { FORCE_COLOR: "2" },
  { FORCE_COLOR: "3" },
  { FORCE_COLOR: "0" },
  { FORCE_COLOR: "false" },
  { FORCE_COLOR: "4" },
  { FORCE_COLOR: "TRUE" },
  { FORCE_COLOR: " 1" },
  { FORCE_COLOR: "0", TERM: "xterm" },
  { FORCE_COLOR: "1", NO_COLOR: "1" },
  { FORCE_COLOR: "1", TERM: "dumb" },
];

const colors = colorEnvs.map((env) => ({
  env,
  colors: WriteStream.prototype.getColorDepth.call(null, env) > 2,
}));

const launches = [];

function launch(name, options = {}) {
  launches.push({
    name,
    args: options.args ?? [],
    env: envWith(options.env),
    files: {
      "bin/claude": { content: FAKE_CLAUDE, mode: 0o755 },
      ...(options.files ?? READY),
    },
  });
}

const REQUEST_MINE = { ...READY, ...REQUEST, [SETTINGS_FILE]: json(mine) };

launch("not set up stops before claude", { files: {} });
launch("not set up in pt-br", {
  files: { [CONFIG_FILE]: json({ language: "pt-br" }) },
});
launch("not set up with the system in pt-br", {
  files: {},
  env: { LANG: "pt_BR.UTF-8" },
});
launch("only the pairing is missing", { files: TOKEN });
launch("two accounts stop it", {
  files: { ...TOKEN, [ACCESS_FILE]: json({ allowFrom: ["1", "2"] }) },
});
launch("the skip flag stops it", { args: ["--dangerously-skip-permissions"] });
launch("the permission mode pair stops it", {
  args: ["-c", "--permission-mode", "bypassPermissions"],
});
launch("bypass in the settings stops it", {
  files: {
    ...READY,
    [SETTINGS_FILE]: json({
      permissions: { defaultMode: "bypassPermissions" },
    }),
  },
});
launch("FORCE_COLOR paints the refusal red", {
  files: {},
  env: { FORCE_COLOR: "1" },
});
launch("FORCE_COLOR=0 keeps it plain", {
  files: {},
  env: { FORCE_COLOR: "0" },
});
launch("a running instance stops it", {
  files: { ...READY, "state/bot.pid": "{server}" },
});
launch("ready opens claude");
launch("ready passes the arguments after the channel", {
  args: ["--continue", "--model", "opus"],
});
launch("odd arguments pass untouched", {
  args: ["a b", "", "é 😀", '--x="y"', "-", "--", "$HOME", "*"],
});
launch("the environment reaches claude", { env: { EXTRA: "kept" } });
launch("claude exit code comes back", { env: { FAKE_EXIT: "7" } });
launch("the request becomes the first prompt", { files: REQUEST_MINE });
launch("the request goes with flags only", {
  args: ["--continue", "-", "--"],
  files: REQUEST_MINE,
});
launch("a prompt argument keeps the request", {
  args: ["--continue", "hello"],
  files: REQUEST_MINE,
});
launch("an empty argument keeps the request", {
  args: [""],
  files: REQUEST_MINE,
});
launch("the request in pt-br", {
  files: { ...REQUEST_MINE, [CONFIG_FILE]: json({ language: "pt-br" }) },
});
launch("the request with our status line is dropped", {
  files: { ...READY, ...REQUEST, [SETTINGS_FILE]: json(ours) },
});
launch("the request without a status line is dropped", {
  files: { ...READY, ...REQUEST },
});
launch("the home folders when nothing is set", {
  env: { CLAUDE_CONFIG_DIR: null, TELEGRAM_STATE_DIR: null },
  files: {
    "home/.claude/channels/telegram/.env": "TELEGRAM_BOT_TOKEN=1\n",
    "home/.claude/channels/telegram/access.json": json({ allowFrom: ["1"] }),
  },
});
launch("an explicit app folder", {
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/app" },
  files: {
    ...READY,
    "app/statusline-customize.json": "{}",
    [SETTINGS_FILE]: json(mine),
  },
});

function runLaunch(entry) {
  return withRoot((root) => {
    materialize(root, entry.files);

    const env = {
      ...resolveEnv(entry.env, root),
      PATH: `${root}/bin:${NODE_PATH}`,
      NODE_OPTIONS: FIXED_CLOCK,
    };

    for (const [path, spec] of Object.entries(entry.files)) {
      if (typeof spec === "string" && spec.includes("{server}")) {
        fs.writeFileSync(join(root, path), withPids(spec));
      }
    }

    const result = spawnSync("bash", [LAUNCHER, ...entry.args], {
      cwd: root,
      env,
    });
    const after = snapshot(root);

    for (const value of Object.values(after)) {
      if (value.content !== undefined)
        value.content = withoutPids(value.content);
    }

    return {
      ...entry,
      status: result.status,
      stdout: placeholders(result.stdout.toString("utf8"), root),
      stderr: withoutPids(placeholders(result.stderr.toString("utf8"), root)),
      after,
    };
  });
}

try {
  await writeFixture("launch.json", {
    now: NOW,
    missing: missing.map((entry) =>
      withRoot((root) => {
        materialize(root, entry.files);

        return { ...entry, out: missingSetupSteps(join(root, "state")) };
      }),
    ),
    permissions,
    running,
    checks: checks.map(runCheck),
    marks,
    prompts: prompts.map(runPrompt),
    colors,
    launches: launches.map(runLaunch),
  });
} finally {
  server.kill();
  plain.kill();
}
