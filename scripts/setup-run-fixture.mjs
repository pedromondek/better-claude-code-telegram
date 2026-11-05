import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPO_ROOT,
  materialize,
  placeholders,
  snapshot,
  writeFixture,
} from "./fixture-support.mjs";

const SELF = fileURLToPath(import.meta.url);
const SETUP = join(REPO_ROOT, "scripts", "setup.mjs");
const SETUP_URL = new URL("./setup.mjs", import.meta.url).href;
const QUESTIONS_FLAG = "--questions";
const SIGNAL_FLAG = "--signal-probe";
const SIGNAL_DELAY_MS = 1500;
const FIXTURE_FILE = join(
  REPO_ROOT,
  "rust",
  "crates",
  "bcct",
  "tests",
  "fixtures",
  "setup-run.json",
);
const HIDDEN_EXPORTS = [
  "askOurStatusline",
  "askInstalledCommands",
  "askPairingChoice",
  "UNINSTALL",
];
const TOOLS = ["sh", "ps", "mkdir", "chmod", "cat", "rm", "sleep"];
const TOKEN = "123456:E2E-FAKE-TOKEN";
const DEV_ID = 42;
const STRANGER_ID = 13;
const CHANNEL = "telegram@better-claude-code-telegram";
const HOOKS = "telegram-hooks@better-claude-code-telegram";
const COMMANDS = "bcct@better-claude-code-telegram";
const MARKETPLACE = "better-claude-code-telegram";
const CONFIG =
  "home/.claude/better-claude-code-telegram/better-cc-telegram.json";
const SETTINGS = "home/.claude/settings.json";
const STATE = "home/.claude/channels/telegram";
const APP = "home/.claude/better-claude-code-telegram";
const HUB = "home/.cache/huggingface/hub";
const PYTHON = `${APP}/whisper/venv/bin/python`;
const WORKING_PYTHON = { content: "#!/bin/sh\nexit 0\n", mode: 0o755 };
const DOWNLOADING_PYTHON = {
  content: `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho "{root}" >> "{root}/work/downloads.log"\n`,
  mode: 0o755,
};
const BROKEN_DOWNLOAD_PYTHON = {
  content: `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho "progress 50%"\necho "boom: no network" >&2\nexit 3\n`,
  mode: 0o755,
};

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CLAUDE_STATE;
let state = { marketplaces: [], plugins: [] };
try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const command = args.slice(0, 3).join(" ");
if (command === "plugin marketplace list") console.log(state.marketplaces.join("\\n"));
if (command === "plugin marketplace add") {
  state.marketplaces.push("${MARKETPLACE}");
  console.log("✔ Successfully added marketplace: ${MARKETPLACE} (declared in user settings)");
}
if (args[1] === "install" && args[2] === process.env.FAKE_CLAUDE_FAIL) {
  console.error("Plugin not found in marketplace");
  process.exit(1);
}
if (args[1] === "uninstall" && args[2] === process.env.FAKE_CLAUDE_FAIL) process.exit(1);
if (command === "plugin marketplace remove" && process.env.FAKE_CLAUDE_FAIL === "marketplace") process.exit(1);
if (args[1] === "install") console.log("✔ Successfully installed plugin: " + args[2] + " (scope: user)");
if (command === "plugin marketplace remove") state.marketplaces = [];
if (args.slice(0, 2).join(" ") === "plugin list") console.log(state.plugins.join("\\n"));
if (args[1] === "install") state.plugins.push(args[2]);
if (args[1] === "uninstall") state.plugins = state.plugins.filter((id) => id !== args[2]);
writeFileSync(stateFile, JSON.stringify(state));
if (["install", "enable", "disable", "uninstall"].includes(args[1])) {
  const settingsFile = require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsFile, "utf8")); } catch {}
  const enabled = { ...settings.enabledPlugins };
  if (args[1] === "uninstall") delete enabled[args[2]];
  else enabled[args[2]] = args[1] !== "disable";
  if (Object.keys(enabled).length === 0) delete settings.enabledPlugins;
  else settings.enabledPlugins = enabled;
  require("node:fs").mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(settings));
}
`;

const FRESH_ANSWERS = [
  "pt-br",
  "s",
  "s",
  TOKEN,
  "s",
  "5",
  "23:00-07:00",
  "não",
  "10",
  "s",
  "",
].join("\n");

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const config = (value) => ({ [CONFIG]: pretty(value) });
const settings = (value) => ({ [SETTINGS]: pretty(value) });
const mine = { type: "command", command: "~/bin/my-line.sh", padding: 1 };
const ours = {
  type: "command",
  command: 'node "{repo}/plugins/telegram-hooks/statusline.mjs"',
};
const oursAfter = {
  type: "command",
  command:
    'node "{repo}/plugins/telegram-hooks/statusline.mjs" --after-previous',
};
const previous = { [`${APP}/statusline-previous.json`]: JSON.stringify(mine) };
const models = (...names) =>
  Object.fromEntries(
    names.map((name) => [
      `${HUB}/models--Systran--faster-whisper-${name}/`,
      "",
    ]),
  );
const saved = (extra = {}) => ({
  [`${STATE}/.env`]: `TELEGRAM_BOT_TOKEN=${TOKEN}\n`,
  ...extra,
});
const paired = (ids = ["42"]) => ({
  [`${STATE}/access.json`]: pretty({ dmPolicy: "allowlist", allowFrom: ids }),
});
const fakeUv = {
  uv: {
    content: `#!/bin/sh\necho "uv $*" >> "{root}/work/tools.log"\nif [ "$1" = "venv" ]; then mkdir -p "$2/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$2/bin/python"; chmod 755 "$2/bin/python"; fi\n`,
    mode: 0o755,
  },
};
const fakePython = {
  python3: {
    content: `#!/bin/sh\necho "python3 $*" >> "{root}/work/tools.log"\nmkdir -p "$3/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/python"; printf '#!/bin/sh\\nexit 0\\n' > "$3/bin/pip"; chmod 755 "$3/bin/python" "$3/bin/pip"\n`,
    mode: 0o755,
  },
};
const failingPython = {
  python3: { content: "#!/bin/sh\nexit 1\n", mode: 0o755 },
};
const fakeInstaller = {
  curl: { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
  bash: {
    content: `#!/bin/sh\nmkdir -p "$HOME/.bun/bin"\nprintf '#!/bin/sh\\nexit 0\\n' > "$HOME/.bun/bin/bun"\nchmod 755 "$HOME/.bun/bin/bun"\n`,
    mode: 0o755,
  },
};
const brokenInstaller = {
  curl: { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
  bash: { content: "#!/bin/sh\nexit 7\n", mode: 0o755 },
};
const uselessInstaller = {
  curl: { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
  bash: { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
};
const mermaid = (status) => ({
  mmdc: { content: "#!/bin/sh\nexit 0\n", mode: 0o755 },
  npm: {
    content: `#!/bin/sh\necho "npm $*" >> "{root}/work/tools.log"\nexit ${status}\n`,
    mode: 0o755,
  },
});
const installed = {
  marketplaces: [MARKETPLACE],
  plugins: [CHANNEL, HOOKS, COMMANDS],
};
const enabled = {
  enabledPlugins: { [CHANNEL]: false, [HOOKS]: true, [COMMANDS]: true },
};

function one(name, args, input, extra = {}) {
  const { env, ...rest } = extra;

  return { name, runs: [{ args, input, env: env ?? {} }], ...rest };
}

function sequence(name, runs, extra = {}) {
  return {
    name,
    runs: runs.map(([args, input, env]) => ({
      args,
      input,
      env: env ?? {},
    })),
    ...extra,
  };
}

const STEPS = [
  one(
    "language in pt-br keeps the rest of the config",
    ["language"],
    "pt-br\n",
    {
      files: config({
        delayMinutes: 7,
        quietHours: { start: "22:00", end: "08:00" },
      }),
    },
  ),
  one("language with Enter on a fresh machine", ["language"], "\n"),
  one("language with Enter keeps the saved one", ["language"], "\n", {
    files: config({ language: "pt-br", delayMinutes: 2 }),
  }),
  one("language accepts the code with an underscore", ["language"], "pt_br\n"),
  one(
    "language refuses an unknown answer and asks again",
    ["language"],
    "klingon\n\n",
    {
      files: config({ language: "pt-br" }),
    },
  ),
  one("language with an invalid saved one", ["language"], "\n", {
    files: config({ language: "klingon" }),
  }),
  one("language in the language of the system", ["language"], "\n", {
    env: { LANG: "pt_BR.UTF-8" },
  }),
  one("delay ends with the input", ["delay"], "soon\n", {
    files: config({ delayMinutes: 7 }),
  }),
  one("delay with a fraction", ["delay"], "2.5\n"),
  one("delay with Enter", ["delay"], "\n"),
  one("delay in the language of the system", ["delay"], "5\n", {
    env: { LANG: "pt_BR.UTF-8" },
  }),
  one("delay keeps the rest of the config", ["delay"], "5\n", {
    files: config({
      quietHours: { start: "22:00", end: "08:00" },
      transcription: { model: "small" },
    }),
  }),
  one("delay saved in pt-br", ["delay"], "5\n", {
    files: config({ language: "pt-br" }),
  }),
  one("delay with a saved fraction", ["delay"], "\n", {
    files: config({ delayMinutes: 2.5 }),
  }),
  one("delay with a saved text", ["delay"], "\n", {
    files: config({ delayMinutes: "7" }),
  }),
  one("delay with a saved invalid value", ["delay"], "\n", {
    files: config({ delayMinutes: "soon" }),
  }),
  one("delay with a saved null", ["delay"], "\n", {
    files: config({ delayMinutes: null }),
  }),
  one("two steps number their headings", ["delay", "inbox"], "\n\n", {
    files: config({ language: "pt-br" }),
  }),
  one("steps run in the order of the setup", ["  INBOX ", "delay", ""], "\n\n"),
  one("the default shows in every question", ["delay", "statusline"], "\n\n", {
    files: config({ language: "pt-br" }),
  }),
  one("quiet hours typed", ["quiet-hours"], "23:00-07:00\n", {
    files: config({ delayMinutes: 7 }),
  }),
  one("quiet hours with Enter keep the saved ones", ["quiet-hours"], "\n", {
    files: config({ quietHours: { start: "23:00", end: "07:00" } }),
  }),
  one("quiet hours off", ["quiet-hours"], "off\n", {
    files: config({ quietHours: { start: "22:00", end: "08:00" } }),
  }),
  one("quiet hours that stay off", ["quiet-hours"], "\n", {
    files: config({ quietHours: null }),
  }),
  one("quiet hours from a preset", ["quiet-hours"], "22:00-07:00\n"),
  one(
    "quiet hours with spaces around the dash",
    ["quiet-hours"],
    "23:00 - 07:00\n",
  ),
  one(
    "quiet hours refuse what is not a range",
    ["quiet-hours"],
    "soon\n25:00-07:00\n23:60-07:00\n07:00-07:00\n23:00\n10:0-11:00\n1a:00-07:00\n23:00-07:0a\n24:00-07:00\n\n",
  ),
  one("quiet hours with a saved invalid range", ["quiet-hours"], "\n", {
    files: config({ quietHours: { start: "99:00", end: "07:00" } }),
  }),
  one("quiet hours saved without a part", ["quiet-hours"], "\n", {
    files: config({ quietHours: { start: "22:00" } }),
  }),
  one("transcription off in pt-br", ["transcription"], "não\n", {
    files: config({ language: "pt-br" }),
  }),
  one("transcription off in en-us", ["transcription"], "no\n"),
  one("transcription kept off", ["transcription"], "\n", {
    files: config({ transcription: null }),
  }),
  one("transcription kept with the installed model", ["transcription"], "\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base"),
      [PYTHON]: DOWNLOADING_PYTHON,
    },
  }),
  one("uninstalling the only model", ["transcription"], "uninstall\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one("uninstalling all the models", ["transcription"], "uninstall\nall\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base", "small", "medium"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one(
    "uninstalling a model not in use",
    ["transcription"],
    "uninstall\nsmall\n",
    {
      files: {
        ...config({ transcription: { model: "base" } }),
        ...models("base", "small"),
        [PYTHON]: WORKING_PYTHON,
      },
    },
  ),
  one("uninstalling nothing with Enter", ["transcription"], "uninstall\n\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base", "small"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one("uninstalling the model in use", ["transcription"], "uninstall\nbase\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base", "small"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one(
    "uninstalling with nothing saved",
    ["transcription"],
    "uninstall\nmedium\n",
    {
      files: { ...models("small", "medium"), [PYTHON]: WORKING_PYTHON },
    },
  ),
  one("switching and removing another", ["transcription"], "small\nbase\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base", "small", "medium"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one("switching and keeping the others", ["transcription"], "small\n\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("base", "small"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one("a failed download shows what it said", ["transcription"], "small\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      [PYTHON]: BROKEN_DOWNLOAD_PYTHON,
    },
  }),
  one("switching to a model already there", ["transcription"], "small\n", {
    files: {
      ...config({ transcription: { model: "base" } }),
      ...models("small"),
      [PYTHON]: DOWNLOADING_PYTHON,
    },
  }),
  one("downloading a model", ["transcription"], "base\n", {
    files: { [PYTHON]: DOWNLOADING_PYTHON },
  }),
  one("an environment made with uv", ["transcription"], "base\n", {
    bin: fakeUv,
  }),
  one("an environment made with python3", ["transcription"], "base\n", {
    bin: fakePython,
  }),
  one("an environment that python3 cannot make", ["transcription"], "base\n", {
    bin: failingPython,
  }),
  one(
    "uv declined when nothing can make the environment",
    ["transcription"],
    "base\nn\n",
  ),
  one(
    "uv installed when nothing can make the environment",
    ["transcription"],
    "base\ns\n",
    {
      files: { "work/uv": fakeUv.uv.content },
      bin: {
        curl: {
          content: `#!/bin/sh\necho 'mkdir -p "$HOME/.local/bin"; cat "{root}/work/uv" > "$HOME/.local/bin/uv"; chmod 755 "$HOME/.local/bin/uv"'\n`,
          mode: 0o755,
        },
      },
    },
  ),
  one("inbox with Enter on a fresh machine", ["inbox"], "\n"),
  one("inbox with a preset", ["inbox"], "3\n"),
  one("inbox off", ["inbox"], "off\n"),
  one("inbox refuses and then keeps", ["inbox"], "soon\n0\n\n", {
    files: config({ inboxRetentionDays: null }),
  }),
  one("inbox with another number", ["inbox"], "10\n"),
  one("inbox kept", ["inbox"], "\n", {
    files: config({ inboxRetentionDays: 7 }),
  }),
  one("inbox saved value outside the presets", ["inbox"], "\n", {
    files: config({ inboxRetentionDays: 2.5 }),
  }),
  one("inbox with a saved invalid value", ["inbox"], "\n", {
    files: config({ inboxRetentionDays: -1 }),
  }),
  one(
    "everything kept with Enter",
    ["language", "delay", "quiet-hours", "transcription", "inbox"],
    "\n\n\n\n\n",
    {
      files: config({
        language: "en-us",
        delayMinutes: 4,
        quietHours: { start: "22:00", end: "07:00" },
        transcription: null,
        inboxRetentionDays: 7,
      }),
    },
  ),
  one("an unknown step", ["modelo"], ""),
  one("several unknown steps", ["modelo", "delay", "--nope"], ""),
  one("an unknown step in pt-br", ["modelo"], "", {
    files: config({ language: "pt-br" }),
  }),
  one("--dry-run is not a step", ["--dry-run"], ""),
  one("--help is not a step", ["--help"], ""),
  one("pairing without a token", ["pairing"], ""),
  one("pairing without a token in pt-br", ["pairing"], "", {
    files: config({ language: "pt-br" }),
  }),
  one("a config that is a list", ["delay"], "\n", {
    files: { [CONFIG]: "[1]\n" },
  }),
];

const STATUSLINE_SCENARIOS = [
  one("asks with the example and declines", ["statusline"], "n\n", {
    files: config({ language: "pt-br" }),
  }),
  one("yes keeps the rest", ["statusline"], "y\n", {
    files: settings({ theme: "dark" }),
  }),
  one("yes creates the file", ["statusline"], "y\n"),
  one("Enter leaves it untouched", ["statusline"], "\n", {
    files: settings({ theme: "dark" }),
  }),
  one("someone else's kept with Enter", ["statusline"], "\n", {
    files: settings({ statusLine: mine }),
  }),
  one("someone else's without a command", ["statusline"], "\n", {
    files: settings({ statusLine: { type: "static" } }),
  }),
  one("someone else's with a long command", ["statusline"], "\n", {
    files: settings({
      statusLine: { type: "command", command: "x".repeat(70) },
    }),
  }),
  one("'3' notes the request", ["statusline"], "3\n", {
    files: settings({ statusLine: mine }),
  }),
  one("'1' runs after someone else's", ["statusline"], "1\n", {
    files: settings({ statusLine: mine }),
  }),
  one("'after' by name", ["statusline"], "after\n", {
    files: settings({ statusLine: mine }),
  }),
  one("'2' replaces someone else's", ["statusline"], "2\n", {
    files: settings({ theme: "dark", statusLine: mine }),
  }),
  one("'4' keeps it", ["statusline"], "4\n", {
    files: settings({ statusLine: mine }),
  }),
  one("ours kept with Enter, one to restore", ["statusline"], "\n", {
    files: { ...settings({ statusLine: oursAfter }), ...previous },
  }),
  one("ours kept with Enter, nothing to restore", ["statusline"], "\n", {
    files: settings({ statusLine: ours }),
  }),
  one("'2' removes ours and restores", ["statusline"], "2\n", {
    files: {
      ...settings({ theme: "dark", statusLine: oursAfter }),
      ...previous,
    },
  }),
  one("'remove' takes ours out", ["statusline"], "remove\n", {
    files: settings({ theme: "dark", statusLine: ours }),
  }),
  one("an invalid file refuses before asking", ["statusline"], "y\n", {
    files: { [SETTINGS]: '{ "theme": "dark", ' },
  }),
  one("keeps the mode of the file", ["statusline"], "y\n", {
    files: { [SETTINGS]: { content: pretty({ theme: "dark" }), mode: 0o640 } },
  }),
  one("'s' is yes in pt-br", ["statusline"], "s\n", {
    files: config({ language: "pt-br" }),
  }),
  sequence(
    "the request is handed over once",
    [
      [["--set", "statusline", "custom"], ""],
      [["--statusline-prompt", "--take"], ""],
      [["--statusline-prompt", "--take"], ""],
      [["--show"], ""],
      [["statusline"], "\n"],
    ],
    {
      files: {
        ...settings({ statusLine: mine }),
        ...config({ language: "pt-br" }),
      },
    },
  ),
  one("the request without taking it", ["--statusline-prompt"], "", {
    files: settings({ statusLine: mine }),
  }),
  one(
    "no request without a status line of someone else",
    ["--statusline-prompt"],
    "",
  ),
  sequence(
    "the request dropped when the status line changed",
    [
      [["--set", "statusline", "custom"], ""],
      [["--set", "statusline", "off"], ""],
      [["--show"], ""],
    ],
    { files: settings({ statusLine: mine }) },
  ),
  one(
    "custom refused without someone else's",
    ["--set", "statusline", "custom"],
    "",
    {
      files: settings({}),
    },
  ),
  sequence(
    "another choice forgets the customization",
    [
      [["--set", "statusline", "custom"], ""],
      [["--show"], ""],
      [["--statusline-prompt", "--take"], ""],
      [["--show"], ""],
      [["--set", "statusline", "after"], ""],
      [["--show"], ""],
    ],
    { files: settings({ statusLine: mine }) },
  ),
  one(
    "replacing forgets the customization",
    ["--set", "statusline", "replace"],
    "",
    {
      files: {
        ...settings({ statusLine: mine }),
        ...config({ statuslineCustomized: true }),
      },
    },
  ),
  one(
    "on with nothing there forgets the customization",
    ["--set", "statusline", "on"],
    "",
    {
      files: config({ statuslineCustomized: true }),
    },
  ),
  one("custom keep names the indicator", ["statusline"], "\n", {
    files: {
      ...settings({ statusLine: mine }),
      ...config({ statuslineCustomized: true }),
    },
  }),
];

const SET = [
  one("--set delay in pt-br", ["--set", "delay", "5"], "", {
    files: config({ language: "pt-br" }),
  }),
  one("--set delay with a comma", ["--set", "delay", "2,5"], ""),
  sequence("--set several", [
    [["--set", "language", "pt-br"], ""],
    [["--set", "quiet-hours", "23:00-07:00"], ""],
    [["--set", "transcription", "off"], ""],
    [["--set", "quiet-hours", "off"], ""],
  ]),
  sequence(
    "--set keeps what did not change",
    [
      [["--set", "language", "en-us"], ""],
      [["--set", "delay", "4"], ""],
      [["--set", "quiet-hours", "off"], ""],
      [["--set", "transcription", "off"], ""],
      [["--set", "inbox", "7"], ""],
      [["--set", "inbox", "off"], ""],
    ],
    {
      files: config({
        language: "en-us",
        delayMinutes: 4,
        quietHours: null,
        transcription: null,
        inboxRetentionDays: 7,
      }),
    },
  ),
  one(
    "--set language keeps in the language asked",
    ["--set", "language", "PT_BR"],
    "",
    {
      files: config({ language: "pt-br" }),
    },
  ),
  one("--set an invalid delay", ["--set", "delay", "soon"], ""),
  one("--set an invalid language", ["--set", "language", "klingon"], ""),
  one("--set invalid quiet hours", ["--set", "quiet-hours", "soon"], ""),
  one("--set empty quiet hours", ["--set", "quiet-hours", ""], ""),
  one("--set an invalid transcription", ["--set", "transcription", "huge"], ""),
  one("--set an invalid inbox", ["--set", "inbox", "0"], ""),
  one("--set an invalid statusline", ["--set", "statusline", "huge"], ""),
  one("--set a step it cannot set", ["--set", "token", "123:abc"], ""),
  one("--set without a step", ["--set"], ""),
  one("--set language without a value", ["--set", "language"], ""),
  sequence("--set statusline on, after and off", [
    [["--set", "statusline", " ON "], ""],
    [["--set", "statusline", "on"], ""],
  ]),
  one("--set statusline after", ["--set", "statusline", "after"], "", {
    files: settings({ statusLine: mine }),
  }),
  one("--set statusline off without ours", ["--set", "statusline", "off"], "", {
    files: settings({ statusLine: mine }),
  }),
  one(
    "--set statusline replace with nothing there",
    ["--set", "statusline", "replace"],
    "",
  ),
  one(
    "--set transcription with a model",
    ["--set", "transcription", "small"],
    "",
    {
      files: { ...models("small"), [PYTHON]: WORKING_PYTHON },
    },
  ),
  one("--set transcription kept", ["--set", "transcription", "small"], "", {
    files: {
      ...config({ transcription: { model: "small" } }),
      ...models("small"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one("--set inbox days", ["--set", "inbox", "14"], ""),
  one("--set inbox off", ["--set", "inbox", "off"], ""),
  one("--show on a fresh machine", ["--show"], ""),
  one("--show with everything", ["--show"], "", {
    files: {
      ...saved(),
      ...paired(),
      ...settings({ statusLine: ours }),
      ...config({
        language: "pt-br",
        delayMinutes: 5,
        quietHours: { start: "22:00", end: "07:00" },
        transcription: { model: "small" },
        inboxRetentionDays: null,
      }),
    },
  }),
  one("--show with ours after", ["--show"], "", {
    files: settings({ statusLine: oursAfter }),
  }),
  one("--show with someone else's", ["--show"], "", {
    files: settings({ statusLine: mine }),
  }),
  one("--show with odd values", ["--show"], "", {
    files: {
      ...config({
        delayMinutes: "soon",
        transcription: "small",
        quietHours: "x",
      }),
      [`${STATE}/.env`]: "TELEGRAM_BOT_TOKEN= \n",
      [`${STATE}/access.json`]: pretty({ allowFrom: "ab" }),
    },
  }),
  one("--check with something missing", ["--check"], ""),
  one("--check in the language of the system", ["--check"], "", {
    env: { LANG: "pt_BR.UTF-8" },
  }),
  one("--check in pt-br", ["--check"], "", {
    files: config({ language: "pt-br" }),
  }),
  one("--check with the setup done", ["--check"], "", {
    files: { ...saved(), ...paired() },
  }),
  one("--check with too many accounts", ["--check"], "", {
    files: { ...saved(), ...paired(["1", "2"]) },
  }),
  one(
    "--check with a flag that skips permissions",
    ["--check", "--dangerously-skip-permissions"],
    "",
    {
      files: { ...saved(), ...paired() },
    },
  ),
  one("--check with settings that skip permissions", ["--check"], "", {
    files: {
      ...saved(),
      ...paired(),
      ...settings({ permissions: { defaultMode: "bypassPermissions" } }),
    },
  }),
  one("--check with the instance open", ["--check"], "", {
    botAlive: true,
    files: { ...saved(), ...paired(), [`${STATE}/bot.pid`]: "{pid}\n" },
  }),
  one("--mark-launch", ["--mark-launch"], ""),
];

const PLUGINS = [
  one("a fresh machine", ["plugin"], "s\ns\n"),
  one("without the optional commands", ["plugin"], "s\nn\n"),
  sequence("again changes nothing", [
    [["plugin"], "s\ns\n"],
    [["plugin"], "\n"],
  ]),
  sequence("the commands removed and offered again", [
    [["plugin"], "s\ns\n"],
    [["plugin"], "remove\n"],
    [["plugin"], "n\n"],
  ]),
  one("a tool declined", ["plugin"], "n\n", { noBun: true }),
  one("a tool installed", ["plugin"], "s\ns\ns\n", {
    noBun: true,
    bin: fakeInstaller,
  }),
  one("an installer that fails", ["plugin"], "s\n", {
    noBun: true,
    bin: brokenInstaller,
  }),
  one("an installer that leaves nothing", ["plugin"], "s\n", {
    noBun: true,
    bin: uselessInstaller,
  }),
  one("the plan declined", ["plugin"], "n\n"),
  one("the plan in pt-br", ["plugin"], "n\n", {
    files: config({ language: "pt-br" }),
  }),
  one("a plugin that fails", ["plugin"], "s\ns\n", {
    env: { FAKE_CLAUDE_FAIL: HOOKS },
  }),
  one("a shell the setup does not know", ["plugin"], "s\ns\n", {
    env: { SHELL: "/bin/fish" },
  }),
  one("a shell the setup does not know, with an rc", ["plugin"], "s\ns\n", {
    env: { SHELL: "/bin/fish" },
    files: { "home/.bashrc": "# mine\n" },
  }),
  one("bash with both rc files", ["plugin"], "s\ns\n", {
    env: { SHELL: "/bin/bash" },
    files: { "home/.bashrc": "# mine", "home/.zshrc": "# other\n" },
  }),
  one("already installed and enabled", ["plugin"], "\n", {
    claude: installed,
    files: {
      ...settings(enabled),
      "home/.zshrc":
        '[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n',
    },
  }),
  one("settings.json invalid at the plugin step", ["plugin"], "s\ns\n", {
    files: { [SETTINGS]: "{" },
  }),
];

const TELEGRAM = [
  one("the whole setup from a fresh machine", [], FRESH_ANSWERS, {
    telegram: {},
  }),
  sequence(
    "the whole setup twice",
    [
      [[], FRESH_ANSWERS],
      [[], "\n".repeat(10)],
    ],
    { telegram: {} },
  ),
  sequence(
    "the paired account replaced",
    [
      [[], FRESH_ANSWERS],
      [[], `\n\n\nreplace\ns\n${"\n".repeat(6)}`],
    ],
    { telegram: {} },
  ),
  one("the token step alone", ["token"], `${TOKEN}\n`, {
    telegram: { canJoinGroups: true },
  }),
  one("the token step on a fresh machine in pt-br", ["token"], `${TOKEN}\n`, {
    files: config({ language: "pt-br" }),
    telegram: {},
  }),
  one("the token refused", ["token"], `${TOKEN}\n`, {
    telegram: { refuse: { getMe: "Unauthorized" } },
  }),
  one("the token refused without saying why", ["token"], `${TOKEN}\n`, {
    telegram: { refuse: { getMe: null } },
  }),
  one("the network down at the token", ["token"], `${TOKEN}\n`, {
    telegram: { down: true },
  }),
  one("an invalid settings.json after the token", ["token"], `${TOKEN}\n`, {
    files: { [SETTINGS]: "{" },
    telegram: {},
  }),
  one("the rule already there", ["token"], `${TOKEN}\n`, {
    files: settings({
      permissions: { deny: ["Read(~/.claude/channels/telegram/.env)"] },
    }),
    telegram: {},
  }),
  one("the pairing alone", ["pairing"], "s\n", {
    files: saved(),
    telegram: {},
  }),
  one("the pairing declined", ["pairing"], "n\n", {
    files: saved(),
    telegram: {},
  }),
  one("the pairing with a webhook", ["pairing"], "", {
    files: saved(),
    telegram: { webhook: "https://example.invalid/hook" },
  }),
  one("the pairing with the instance open", ["pairing"], "", {
    botAlive: true,
    files: saved({ [`${STATE}/bot.pid`]: "{pid}\n" }),
    telegram: {},
  }),
  one("the pairing kept", ["pairing"], "\n", {
    files: saved(paired()),
    telegram: {},
  }),
  one("the pairing kept by another word", ["pairing"], "não\n", {
    files: saved(paired()),
    telegram: {},
  }),
  one("the pairing replaced by another word", ["pairing"], "sim\ns\n", {
    files: saved(paired()),
    telegram: {},
  }),
  one("the pairing refused", ["pairing"], "", {
    files: saved(),
    telegram: { refuse: { getMe: "Unauthorized" } },
  }),
  one("both token and pairing", ["token", "pairing"], `${TOKEN}\ns\n`, {
    telegram: {},
  }),
  one("the saved bot declined", [], `\n\nn\n${TOKEN}\n\n\n\n\n\n\n\n`, {
    claude: installed,
    files: {
      ...saved(paired()),
      ...settings(enabled),
      ...config({ language: "en-us", transcription: null }),
      "home/.zshrc":
        '[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n',
    },
    telegram: {},
  }),
  one("the health finds a failure at the end", [], `\n\n\n\n\n\n\n\n\n\n`, {
    claude: installed,
    files: {
      ...saved(paired(["1", "2"])),
      ...settings(enabled),
      ...config({ language: "en-us", transcription: null }),
      "home/.zshrc":
        '[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n',
    },
    telegram: {},
  }),
  one(
    "a deny that is not a list stops the token step",
    ["token"],
    `${TOKEN}\n`,
    {
      files: settings({ permissions: { deny: 5 } }),
      telegram: {},
    },
  ),
  one(
    "the health stops when the bot answers nothing",
    [],
    `\n\n\n\n\n\n\n\n\n`,
    {
      claude: installed,
      files: {
        ...saved(paired()),
        ...settings(enabled),
        ...config({ language: "en-us", transcription: null }),
        "home/.zshrc":
          '[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n',
      },
      telegram: { meEmptyAfter: 1 },
    },
  ),
];

const UNINSTALL = [
  sequence(
    "undoes everything and keeps the state",
    [
      [[], FRESH_ANSWERS],
      [["--uninstall"], "n\n"],
    ],
    { telegram: {} },
  ),
  sequence(
    "deletes the state when confirmed, in pt-br",
    [
      [[], FRESH_ANSWERS],
      [["--uninstall"], "s\n"],
    ],
    { telegram: {} },
  ),
  one("nothing to undo", ["--uninstall"], "\n", {
    claude: { marketplaces: [], plugins: [] },
  }),
  one("the marketplace and a plugin not there", ["--uninstall"], "\n", {
    claude: { marketplaces: [], plugins: [CHANNEL] },
  }),
  one("without claude", ["--uninstall"], "\n", { claude: false }),
  one("the instance open", ["--uninstall"], "", {
    botAlive: true,
    files: { [`${STATE}/bot.pid`]: "{pid}\n", ...settings({ theme: "dark" }) },
  }),
  one("settings.json invalid", ["--uninstall"], "", {
    files: { [SETTINGS]: "{", "home/.zshrc": "x\n" },
  }),
  one("a plugin that cannot be removed", ["--uninstall"], "\n", {
    claude: installed,
    env: { FAKE_CLAUDE_FAIL: HOOKS },
  }),
  one("the marketplace that cannot be removed", ["--uninstall"], "\n", {
    claude: installed,
    env: { FAKE_CLAUDE_FAIL: "marketplace" },
  }),
  one("the customized status line warned", ["--uninstall"], "\n", {
    files: config({ statuslineCustomized: true }),
  }),
  one("restores someone else's status line", ["--uninstall"], "\n", {
    files: {
      ...settings({ theme: "dark", statusLine: oursAfter }),
      ...previous,
    },
  }),
  one("keeps someone else's status line and rules", ["--uninstall"], "\n", {
    files: settings({
      statusLine: mine,
      permissions: {
        allow: ["x"],
        deny: ["y", "Read(~/.claude/channels/telegram/.env)"],
      },
    }),
  }),
  one("removes only our rule", ["--uninstall"], "\n", {
    files: settings({
      permissions: { deny: ["Read(~/.claude/channels/telegram/.env)"] },
    }),
  }),
  one("the transcription removed", ["--uninstall"], "s\n\n", {
    files: {
      ...models("base", "small"),
      [PYTHON]: WORKING_PYTHON,
    },
  }),
  one("the transcription kept", ["--uninstall"], "n\n\n", {
    files: { ...models("base"), [PYTHON]: WORKING_PYTHON },
  }),
  one("mermaid removed", ["--uninstall"], "s\n\n", { bin: mermaid(0) }),
  one("mermaid that npm cannot remove", ["--uninstall"], "s\n\n", {
    bin: mermaid(1),
  }),
  one("mermaid kept", ["--uninstall"], "n\n\n", { bin: mermaid(0) }),
  one("the input ends at a question", ["--uninstall"], ""),
  one(
    "the input ends at the question about the transcription",
    ["--uninstall"],
    "",
    {
      files: models("base"),
    },
  ),
  one("the input ends at the question about mermaid", ["--uninstall"], "", {
    bin: mermaid(0),
  }),
  one("the rc files cleaned", ["--uninstall"], "\n", {
    files: {
      "home/.bashrc": `# before\n\n# Added by better-claude-code-telegram setup\n[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n# after\n`,
      "home/.zshrc": `# Added by better-claude-code-telegram setup\n[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n`,
      "home/.bash_profile": `# mine\n`,
    },
  }),
];

const GROUPS = {
  steps: STEPS,
  statusline: STATUSLINE_SCENARIOS,
  set: SET,
  plugins: PLUGINS,
  telegram: TELEGRAM,
  uninstall: UNINSTALL,
};

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const CTRL_C = "\u0003";
const ENTER = "\r";
const TO_CUSTOM = [DOWN, DOWN, DOWN, DOWN];
const STRICT_SETTINGS = { [SETTINGS]: "{" };
const WAITING_TEXT = "Waiting for the message with the code";

const TERMINAL = [
  { name: "a step answered with Enter", args: ["delay"], keys: [ENTER] },
  {
    name: "the language moved with an arrow",
    args: ["language"],
    keys: [DOWN, ENTER],
  },
  {
    name: "the language without the flags on WSL",
    args: ["language"],
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    keys: [ENTER],
  },
  {
    name: "the language without the flags on Windows Terminal",
    args: ["language"],
    env: { WT_SESSION: "abc" },
    keys: [ENTER],
  },
  {
    name: "Ctrl+C asks whether to leave and leaving ends it",
    args: ["delay"],
    keys: [CTRL_C, ENTER],
  },
  {
    name: "Ctrl+C and going on asks again",
    args: ["delay"],
    keys: [CTRL_C, UP, ENTER, ENTER],
  },
  {
    name: "Ctrl+C on the question about leaving leaves",
    args: ["delay"],
    keys: [CTRL_C, CTRL_C],
  },
  {
    name: "leaving after a change suggests undoing it",
    args: ["delay", "inbox"],
    keys: [ENTER, CTRL_C, ENTER, ENTER],
  },
  {
    name: "leaving after a change and keeping it",
    args: ["delay", "inbox"],
    keys: [ENTER, CTRL_C, ENTER, DOWN, ENTER],
  },
  {
    name: "Ctrl+C on the question about undoing keeps",
    args: ["delay", "inbox"],
    keys: [ENTER, CTRL_C, ENTER, CTRL_C],
  },
  {
    name: "an error suggests keeping what was done",
    args: ["delay", "statusline"],
    files: STRICT_SETTINGS,
    keys: [ENTER, ENTER],
  },
  {
    name: "an error and undoing what was done",
    args: ["delay", "statusline"],
    files: STRICT_SETTINGS,
    keys: [ENTER, UP, ENTER],
  },
  {
    name: "undoing lists a changed option and restores the file",
    args: ["delay", "inbox"],
    files: config({ delayMinutes: 5, language: "en-us" }),
    keys: [UP, ENTER, CTRL_C, ENTER, ENTER],
  },
  {
    name: "a delay typed after a wrong one",
    args: ["delay"],
    keys: [...TO_CUSTOM, ENTER, "soon\r", "3\r"],
  },
  {
    name: "Ctrl+C at a typed question",
    args: ["delay"],
    keys: [...TO_CUSTOM, ENTER, CTRL_C, ENTER],
  },
  {
    name: "Ctrl+C at a typed question and going on",
    args: ["delay"],
    keys: [...TO_CUSTOM, ENTER, CTRL_C, UP, ENTER, "7\r"],
  },
  { name: "an unknown step", args: ["modelo"], keys: [] },
  {
    name: "the keep option names the indicator Claude fitted",
    args: ["statusline"],
    files: {
      ...settings({ statusLine: mine }),
      ...config({ statuslineCustomized: true }),
    },
    keys: [ENTER],
  },
  {
    name: "a narrow terminal cuts the line of the spinner",
    args: ["plugin"],
    columns: 40,
    keys: [DOWN, ENTER],
  },
  {
    name: "the transcription made and undone",
    args: ["transcription", "statusline"],
    bin: fakeUv,
    files: STRICT_SETTINGS,
    keys: [ENTER, UP, ENTER],
  },
  {
    name: "the received files saved and undone",
    args: ["inbox", "statusline"],
    files: { ...STRICT_SETTINGS, ...config({ delayMinutes: 5 }) },
    keys: [ENTER, UP, ENTER],
  },
  {
    name: "a tool declined stops with the commands",
    args: ["plugin"],
    noBun: true,
    keys: [DOWN, ENTER],
  },
  {
    name: "the plan declined stops with the commands",
    args: ["plugin"],
    keys: [DOWN, ENTER],
  },
  {
    name: "the plugins installed and undone",
    args: ["plugin", "transcription"],
    keys: [ENTER, ENTER, ENTER, DOWN, ENTER, UP, ENTER],
  },
  {
    name: "a tool installed cannot be undone and is listed as left",
    args: ["plugin", "transcription"],
    noBun: true,
    bin: fakeInstaller,
    keys: [ENTER, ENTER, ENTER, ENTER, DOWN, ENTER, UP, ENTER],
  },
  {
    name: "a change that cannot be described ends with its error",
    args: ["token", "transcription"],
    telegram: {},
    bin: {
      uv: {
        content: `#!/bin/sh\nprintf '{"permissions":{"deny":5}}' > "{root}/home/.claude/settings.json"\nexit 1\n`,
        mode: 0o755,
      },
    },
    keys: [`${TOKEN}\r`, ENTER],
  },
  {
    name: "the token typed in secret",
    args: ["token"],
    telegram: {},
    keys: [`${TOKEN}\r`],
  },
  {
    name: "Ctrl+C at the token and leaving",
    args: ["token"],
    telegram: {},
    keys: [CTRL_C, ENTER],
  },
  {
    name: "the pairing interrupted while it waits",
    args: ["pairing"],
    files: saved(),
    telegram: { holdUpdates: true },
    keys: [{ when: WAITING_TEXT, key: CTRL_C }],
  },
  {
    name: "the token saved and the pairing interrupted, undoing it",
    args: ["token", "pairing"],
    telegram: { holdUpdates: true },
    keys: [`${TOKEN}\r`, { when: WAITING_TEXT, key: CTRL_C }, ENTER],
  },
  {
    name: "Ctrl+C in the uninstall is a plain cancel",
    args: ["--uninstall"],
    claude: { marketplaces: [], plugins: [] },
    keys: [CTRL_C],
  },
  {
    name: "the uninstall answered on the terminal",
    args: ["--uninstall"],
    claude: { marketplaces: [], plugins: [] },
    keys: [ENTER],
  },
  {
    name: "--set asks about a tool on the terminal",
    args: ["--set", "transcription", "base"],
    keys: [DOWN, ENTER],
  },
];

function stripSpinner(text) {
  let out = "";
  let rest = text;

  for (;;) {
    const start = rest.indexOf("\r\u001B[36m");

    if (start < 0) return out + rest;

    const end = rest.indexOf("\u001B[22m", start);

    out += rest.slice(0, start);
    rest = rest.slice(end + "\u001B[22m".length);
  }
}

function recorded(spec) {
  return new Promise((resolveRecord, rejectRecord) => {
    const recorder = spawn(
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
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";

    recorder.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    recorder.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    recorder.on("close", (status) => {
      if (status === 0) {
        resolveRecord(Buffer.from(JSON.parse(stdout).output).toString("utf8"));
      } else {
        rejectRecord(new Error(`${spec.name}: ${stderr}`));
      }
    });
    recorder.stdin.end(JSON.stringify(spec));
  });
}

const SIGNAL_CASES = [
  {
    name: "SIGTERM at a question of the setup",
    signal: "SIGTERM",
    args: ["delay"],
  },
  {
    name: "SIGTERM at a question of --set",
    signal: "SIGTERM",
    args: ["--set", "transcription", "base"],
  },
  {
    name: "SIGTERM at a question of the uninstall",
    signal: "SIGTERM",
    args: ["--uninstall"],
    claude: { marketplaces: [], plugins: [] },
  },
  {
    name: "SIGINT from outside at a question of the uninstall",
    signal: "SIGINT",
    args: ["--uninstall"],
    claude: { marketplaces: [], plugins: [] },
  },
];

function signalProbe(signal, args) {
  const child = spawn(process.execPath, [SETUP, ...args], { stdio: "inherit" });

  setTimeout(() => child.kill(signal), SIGNAL_DELAY_MS);
  child.on("close", (code, received) => {
    const modes = spawnSync("stty", ["-a"], {
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
    }).stdout;

    process.stdout.write(
      `[signal=${received}][code=${code}][modes]${modes}[/modes]`,
    );
  });
}

async function runSignalCase(entry) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-run-")));

  try {
    prepared(root, { ...entry, withStty: true });

    const raw = await recorded({
      name: entry.name,
      argv: [process.execPath, SELF, SIGNAL_FLAG, entry.signal, ...entry.args],
      env: {
        PATH: join(root, "bin"),
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
        SHELL: "/bin/zsh",
        LANG: "C",
        BETTER_CC_TELEGRAM_API_ROOT: "http://127.0.0.1:1",
        FAKE_CLAUDE_LOG: join(root, "work", "claude.log"),
        FAKE_CLAUDE_STATE: join(root, "work", "claude.json"),
      },
      columns: 200,
      rows: 50,
      steps: [],
      redirect: null,
    });
    const flow = raw.slice(0, raw.indexOf("[signal="));
    const modes = raw.slice(raw.indexOf("[modes]"), raw.indexOf("[/modes]"));

    return {
      ...entry,
      received: /\[signal=(\w+)\]/.exec(raw)?.[1] ?? null,
      code: /\[code=(\w+)\]/.exec(raw)?.[1] ?? null,
      cursorLeftHidden:
        flow.lastIndexOf("\u001B[?25l") > flow.lastIndexOf("\u001B[?25h"),
      asked: flow.includes("\u001B[?25l"),
      cooked: modes.split(/\s+/).includes("icanon"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runTerminal(scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-run-")));
  const telegram = scenario.telegram
    ? await startTelegram(scenario.telegram)
    : null;

  try {
    prepared(root, { ...scenario, withStty: true });
    materialize(root, scenario.files ?? {});

    const raw = await recorded({
      name: scenario.name,
      argv: [
        "sh",
        "-c",
        `trap : INT; printf '<<<'; "$0" "$@"; echo "[exit=$?]"`,
        process.execPath,
        SETUP,
        ...scenario.args,
      ],
      env: {
        PATH: join(root, "bin"),
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
        SHELL: "/bin/zsh",
        LANG: "C",
        BETTER_CC_TELEGRAM_API_ROOT: telegram
          ? `http://127.0.0.1:${telegram.server.address().port}`
          : "http://127.0.0.1:1",
        FAKE_CLAUDE_LOG: join(root, "work", "claude.log"),
        FAKE_CLAUDE_STATE: join(root, "work", "claude.json"),
        ...scenario.env,
      },
      columns: scenario.columns ?? 200,
      rows: 50,
      steps: scenario.keys.map((key) =>
        typeof key === "string"
          ? { key: [...Buffer.from(key)] }
          : { when: key.when, key: [...Buffer.from(key.key)] },
      ),
      redirect: null,
    });
    const code = /\?start=([0-9a-f]{8})/.exec(raw)?.[1] ?? null;

    rmSync(join(root, "bin"), { recursive: true });

    return {
      ...scenario,
      output: normalized(stripSpinner(raw), root, { code }),
      after: Object.fromEntries(
        Object.entries(snapshot(root))
          .filter(([path]) => path.startsWith("home"))
          .map(([path, entry]) => [
            normalized(path, root, { code }),
            entry.content === undefined
              ? entry
              : {
                  ...entry,
                  content: normalized(entry.content, root, { code }),
                },
          ]),
      ),
    };
  } finally {
    if (telegram) {
      telegram.server.closeAllConnections();
      await new Promise((done) => telegram.server.close(done));
    }

    rmSync(root, { recursive: true, force: true });
  }
}

function resolved(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  }).stdout.trim();
}

function privateUpdate(updateId, from, text) {
  return {
    update_id: updateId,
    message: { chat: { type: "private" }, from, text },
  };
}

async function codeSeen(fake) {
  while (!fake.code) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
}

function startTelegram(options) {
  const fake = { calls: [], code: null };
  const pending = [
    privateUpdate(6, { id: STRANGER_ID, username: "stranger" }, "/start"),
  ];
  let codeSent = null;
  let nextUpdateId = 7;

  fake.server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", async () => {
      const method = (request.url ?? "").split("/").pop() ?? "";
      const params = body ? JSON.parse(body) : {};
      let result = true;

      fake.calls.push({ method, params });

      if (options.refuse && method in options.refuse) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify(
            options.refuse[method] === null
              ? { ok: false }
              : { ok: false, description: options.refuse[method] },
          ),
        );
        return;
      }

      if (method === "getMe") {
        const answered = fake.calls.filter(
          (call) => call.method === "getMe",
        ).length;

        if (answered > (options.meEmptyAfter ?? Infinity)) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true }));
          return;
        }

        result = {
          username: "e2e_bot",
          can_join_groups: options.canJoinGroups === true,
        };
      }
      if (
        method === "getUpdates" &&
        options.holdUpdates &&
        params.offset !== -1
      ) {
        return;
      }

      if (method === "getUpdates" && params.offset !== -1) {
        await codeSeen(fake);
      }

      if (method === "getWebhookInfo") result = { url: options.webhook ?? "" };
      if (method === "getChat") {
        result = { id: Number(params.chat_id), username: "dev" };
      }
      if (method === "getUpdates") {
        if (fake.code && codeSent !== fake.code) {
          codeSent = fake.code;
          pending.push(
            privateUpdate(
              nextUpdateId++,
              { id: DEV_ID, username: "dev" },
              `/start ${fake.code}`,
            ),
          );
        }

        result =
          params.offset === -1
            ? []
            : pending.filter((update) => update.update_id >= params.offset);
      }

      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result }));
    });
  });

  return new Promise((resolveListen) => {
    fake.server.listen(0, "127.0.0.1", () => resolveListen(fake));
  });
}

function normalized(text, root, facts) {
  let out = placeholders(text, root).replaceAll(
    process.versions.node,
    "{node}",
  );

  if (facts.code) out = out.replaceAll(facts.code, "{code}");
  if (facts.pid) out = out.replaceAll(facts.pid, "{pid}");

  return out
    .replaceAll(/\.bak\.\d+/g, ".bak.{now}")
    .replaceAll(/"requestedAt":"[^"]*"/g, '"requestedAt":"{iso}"')
    .replaceAll(/"launchedAt":\d+/g, '"launchedAt":"{now}"');
}

function runOnce(run, root, telegram, facts) {
  if (telegram) telegram.code = null;

  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SETUP, ...run.args], {
      env: {
        PATH: join(root, "bin"),
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
        SHELL: "/bin/zsh",
        LANG: "C",
        BETTER_CC_TELEGRAM_API_ROOT: telegram
          ? `http://127.0.0.1:${telegram.server.address().port}`
          : "http://127.0.0.1:1",
        FAKE_CLAUDE_LOG: join(root, "work", "claude.log"),
        FAKE_CLAUDE_STATE: join(root, "work", "claude.json"),
        ...run.env,
      },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);

      const code = /\?start=([0-9a-f]{8})/.exec(stdout)?.[1] ?? null;

      if (code && telegram) {
        telegram.code = code;
        facts.code = code;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status) => {
      resolveRun({
        status,
        stdout: normalized(stdout, root, facts),
        stderr: normalized(stderr, root, facts),
      });
    });
    child.stdin.end(run.input);
  });
}

function prepared(root, scenario) {
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work"));

  for (const tool of [
    ...TOOLS,
    "node",
    ...(scenario.withStty ? ["stty"] : []),
  ]) {
    symlinkSync(resolved(tool), join(root, "bin", tool));
  }

  materialize(root, {
    "home/.claude/": "",
    ...(scenario.claude === false
      ? {}
      : { "bin/claude": { content: FAKE_CLAUDE, mode: 0o755 } }),
    ...(scenario.noBun
      ? {}
      : { "bin/bun": { content: "#!/bin/sh\nexit 0\n", mode: 0o755 } }),
    ...Object.fromEntries(
      Object.entries(scenario.bin ?? {}).map(([name, spec]) => [
        `bin/${name}`,
        spec,
      ]),
    ),
    ...(scenario.claude && scenario.claude !== false
      ? { "work/claude.json": JSON.stringify(scenario.claude) }
      : {}),
  });
}

function withBot(root, scenario) {
  if (!scenario.botAlive) return { files: scenario.files ?? {}, facts: {} };

  const helper = spawn("sh", ["-c", "sleep 600; :", "server.ts"], {
    stdio: "ignore",
  });
  const pid = String(helper.pid);
  const files = Object.fromEntries(
    Object.entries(scenario.files ?? {}).map(([path, spec]) => [
      path,
      typeof spec === "string" ? spec.replaceAll("{pid}", pid) : spec,
    ]),
  );

  return { files, facts: { pid }, helper };
}

async function waitForArgs(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const args = spawnSync("ps", ["-p", pid, "-o", "args="], {
      encoding: "utf8",
    }).stdout;

    if (args.includes("server.ts")) return;

    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }

  throw new Error("the helper never showed up");
}

async function runScenario(scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-run-")));
  const { files, facts, helper } = withBot(root, scenario);
  const telegram =
    scenario.telegram && !scenario.telegram.down
      ? await startTelegram(scenario.telegram)
      : null;

  try {
    if (helper) await waitForArgs(facts.pid);

    prepared(root, scenario);
    materialize(root, files);

    const results = [];

    for (const run of scenario.runs) {
      results.push(await runOnce(run, root, telegram, facts));
    }

    rmSync(join(root, "bin"), { recursive: true });

    const log = join(root, "work", "claude.log");
    const tools = join(root, "work", "tools.log");
    const tree = Object.fromEntries(
      Object.entries(snapshot(root))
        .filter(([path]) => path.startsWith("home"))
        .map(([path, entry]) => [
          normalized(path, root, facts),
          entry.content === undefined
            ? entry
            : { ...entry, content: normalized(entry.content, root, facts) },
        ]),
    );

    return {
      ...scenario,
      results,
      claudeCalls: existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(normalized(line, root, facts)))
        : [],
      toolCalls: existsSync(tools)
        ? normalized(readFileSync(tools, "utf8"), root, facts)
        : "",
      telegramCalls: telegram
        ? JSON.parse(normalized(JSON.stringify(telegram.calls), root, facts))
        : [],
      after: tree,
    };
  } finally {
    helper?.kill();
    if (telegram) await new Promise((done) => telegram.server.close(done));
    rmSync(root, { recursive: true, force: true });
  }
}

const QUESTION_CASES = [
  { ask: "delay", current: 5, replies: [] },
  { ask: "delay", current: 4, saved: true, replies: [] },
  { ask: "delay", current: 2.5, replies: [] },
  { ask: "delay", current: 3, replies: ["last", "soon", "0", "4"] },
  { ask: "delay", current: 4, piped: true, replies: ["soon", "2,5"] },
  { ask: "delay", current: 4, piped: true, replies: [""] },
  { ask: "delay", current: 4, piped: true, replies: ["5"] },
  { ask: "delay", current: 4, piped: true, replies: ["n"] },
  { ask: "inbox", current: 7, replies: [] },
  { ask: "inbox", current: null, replies: [] },
  { ask: "inbox", current: null, saved: true, replies: [] },
  { ask: "inbox", current: 2.5, replies: [] },
  { ask: "inbox", current: 7, replies: ["last", "soon", "0", "10"] },
  { ask: "inbox", current: 7, replies: ["last", "2.5", "-3", "1e3", "6"] },
  { ask: "inbox", current: 7, piped: true, replies: ["nenhum"] },
  { ask: "inbox", current: 7, piped: true, replies: ["0", "12"] },
  { ask: "inbox", current: 7, piped: true, replies: ["off"] },
  { ask: "quiet", current: null, replies: [] },
  { ask: "quiet", current: null, saved: true, replies: [] },
  { ask: "quiet", current: { start: "23:00", end: "07:00" }, replies: [] },
  {
    ask: "quiet",
    current: { start: "22:00", end: "07:00" },
    saved: true,
    replies: [],
  },
  {
    ask: "quiet",
    current: null,
    replies: ["last", "soon", "25:00", "9:05", "9:05", "x", "18:30"],
  },
  { ask: "quiet", current: null, replies: ["last"] },
  { ask: "quiet", current: null, replies: ["last", "09:00"] },
  { ask: "quiet", current: null, piped: true, replies: ["23:00-07:00"] },
  { ask: "quiet", current: null, piped: true, replies: ["0"] },
  { ask: "quiet", current: null, piped: true, replies: ["18:00-07:00"] },
  { ask: "quiet", current: null, piped: true, replies: ["nope", ""] },
  { ask: "transcription", current: "base", replies: [] },
  { ask: "transcription", current: "small", saved: true, replies: [] },
  { ask: "transcription", current: null, saved: true, replies: [] },
  {
    ask: "transcription",
    current: "base",
    installed: ["base", "medium"],
    saved: true,
    replies: [],
  },
  {
    ask: "transcription",
    current: "medium",
    installed: ["base", "small", "medium"],
    replies: [],
  },
  { ask: "transcription", current: "base", installed: ["base"], replies: [1] },
  {
    ask: "transcription",
    current: "base",
    installed: ["small"],
    piped: true,
    replies: ["uninstall"],
  },
  {
    ask: "transcription",
    current: "base",
    piped: true,
    replies: ["huge", "small"],
  },
  { ask: "transcription", current: "base", piped: true, replies: ["none"] },
  { ask: "language", current: "en-us", replies: [] },
  { ask: "language", current: "pt-br", saved: true, replies: [] },
  { ask: "language", current: "en-us", noFlags: true, replies: [] },
  { ask: "language", current: "en-us", piped: true, replies: ["pt_br"] },
  { ask: "language", current: "pt-br", piped: true, replies: ["x", ""] },
  { ask: "statusline", preview: "mine", replies: [] },
  { ask: "statusline", preview: "mine", customized: true, replies: [] },
  { ask: "statusline", preview: "mine", replies: [0] },
  { ask: "statusline", preview: "mine", replies: [1] },
  { ask: "statusline", preview: "mine", replies: [2] },
  { ask: "statusline", preview: "mine", piped: true, replies: ["1"] },
  { ask: "statusline", preview: "mine", piped: true, replies: ["replace"] },
  { ask: "statusline", preview: "mine", piped: true, replies: [""] },
  { ask: "ours", restores: true, replies: [] },
  { ask: "ours", restores: false, replies: [1] },
  { ask: "ours", restores: false, piped: true, replies: ["2"] },
  { ask: "ours", restores: true, piped: true, replies: [""] },
  { ask: "commands", replies: [] },
  { ask: "commands", replies: [1] },
  { ask: "commands", piped: true, replies: ["remove"] },
  { ask: "commands", piped: true, replies: ["1"] },
  { ask: "pairing", accounts: "@dev (id 42)", replies: [] },
  { ask: "pairing", accounts: "@dev (id 42)", replies: [1] },
  { ask: "pairing", accounts: "id 42", piped: true, replies: ["não"] },
  { ask: "pairing", accounts: "id 42", piped: true, replies: ["sim"] },
  { ask: "pairing", accounts: "id 42", piped: true, replies: ["replace"] },
  { ask: "remove", others: ["base", "medium"], previous: "base", replies: [] },
  {
    ask: "remove",
    others: ["base", "medium"],
    previous: "base",
    tag: "used",
    replies: [1],
  },
  { ask: "remove", others: ["base", "medium"], previous: null, replies: [3] },
  { ask: "remove", others: ["small"], previous: "small", replies: [1] },
  {
    ask: "remove",
    others: ["small"],
    previous: null,
    piped: true,
    replies: ["n"],
  },
  {
    ask: "remove",
    others: ["base", "small"],
    previous: null,
    piped: true,
    replies: ["all"],
  },
];

async function runQuestions() {
  const hidden = HIDDEN_EXPORTS.join(", ");

  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);

      return url === SETUP_URL
        ? {
            ...loaded,
            source: `${String(loaded.source)}\nexport { ${hidden} };\n`,
          }
        : loaded;
    },
  });

  const setup = await import(SETUP_URL);
  const { MESSAGES } =
    await import("../plugins/telegram-hooks/lib/messages.mjs");
  const out = [];
  const errors = [];
  const realError = console.error;

  console.error = (line) => errors.push(line);

  for (const entry of QUESTION_CASES) {
    for (const locale of ["en-us", "pt-br"]) {
      errors.length = 0;

      const messages = MESSAGES[locale];
      const calls = [];
      const replies = [...entry.replies];
      const ask = {
        interactive: !entry.piped,
        line: async (prompt, activeMessages) => {
          calls.push({ line: prompt });

          if (replies.length === 0) throw new Error(activeMessages.cancelled);

          return replies.shift();
        },
        select: async (title, choices, index) => {
          calls.push({
            title,
            index,
            choices: choices.map((choice) => ({
              label: choice.label,
              hint: choice.hint,
              heading: choice.heading === true,
              previous: choice.previous === true,
            })),
          });

          const reply = replies.shift() ?? "default";
          const picked =
            reply === "default"
              ? index
              : reply === "last"
                ? choices.length - 1
                : reply;

          return choices[picked].value;
        },
      };
      const options = { saved: entry.saved ?? false };
      let value;

      try {
        if (entry.ask === "delay") {
          value = await setup.askDelay(entry.current, messages, ask, options);
        } else if (entry.ask === "inbox") {
          value = await setup.askInbox(entry.current, messages, ask, options);
        } else if (entry.ask === "quiet") {
          value = await setup.askQuietHours(
            entry.current,
            messages,
            ask,
            options,
          );
        } else if (entry.ask === "transcription") {
          value = await setup.askTranscription(entry.current, messages, ask, {
            ...options,
            installed: entry.installed ?? [],
          });
        } else if (entry.ask === "language") {
          if (entry.noFlags) process.env.WSL_DISTRO_NAME = "x";

          value = await setup.askLanguage(
            entry.current,
            messages,
            ask,
            options,
          );
          delete process.env.WSL_DISTRO_NAME;
        } else if (entry.ask === "statusline") {
          value = await setup.askStatuslineChoice(
            entry.preview,
            messages,
            ask,
            {
              customized: entry.customized ?? false,
            },
          );
        } else if (entry.ask === "ours") {
          value = await setup.askOurStatusline(entry.restores, messages, ask);
        } else if (entry.ask === "commands") {
          value = await setup.askInstalledCommands(messages, ask);
        } else if (entry.ask === "pairing") {
          value = await setup.askPairingChoice(entry.accounts, messages, ask);
        } else {
          value = await setup.askRemoveModels(
            entry.others,
            entry.previous,
            messages,
            ask,
            entry.tag ? { tag: entry.tag } : {},
          );
        }
      } catch (error) {
        value = { error: error.message };
      }

      out.push({
        ...entry,
        locale,
        calls,
        errors: [...errors],
        value:
          value === setup.UNINSTALL
            ? "<uninstall>"
            : value === undefined
              ? null
              : value,
      });
    }
  }

  console.error = realError;
  process.stdout.write(JSON.stringify(out));
}

function previousFixture() {
  return existsSync(FIXTURE_FILE)
    ? JSON.parse(readFileSync(FIXTURE_FILE, "utf8"))
    : {};
}

async function main() {
  process.umask(0o022);

  const only = process.argv[2];
  const existing = previousFixture();
  const wanted = (part) => only === undefined || only === part;
  const processes = existing.processes ?? {};

  for (const [group, scenarios] of Object.entries(GROUPS)) {
    if (wanted(group) || wanted("processes")) {
      processes[group] = [];

      for (const scenario of scenarios) {
        processes[group].push(await runScenario(scenario));
      }
    }
  }

  let { questions, terminal, signals } = existing;

  if (wanted("questions")) {
    const run = spawnSync(process.execPath, [SELF, QUESTIONS_FLAG], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });

    if (run.status !== 0) throw new Error(run.stderr);

    questions = JSON.parse(run.stdout);
  }

  const written = () =>
    writeFixture("setup-run.json", {
      fakeClaude: FAKE_CLAUDE,
      token: TOKEN,
      processes,
      questions,
      terminal,
      signals,
    });

  await written();

  if (wanted("terminal")) {
    terminal = [];

    for (const scenario of TERMINAL) terminal.push(await runTerminal(scenario));

    await written();
  }

  if (wanted("signals")) {
    signals = [];

    for (const entry of SIGNAL_CASES) signals.push(await runSignalCase(entry));

    await written();
  }
}

if (process.argv[2] === QUESTIONS_FLAG) {
  await runQuestions();
} else if (process.argv[2] === SIGNAL_FLAG) {
  signalProbe(process.argv[3], process.argv.slice(4));
} else {
  await main();
}
