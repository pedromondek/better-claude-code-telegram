import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP_URL = new URL("./setup.mjs", import.meta.url).href;
const MESSAGES_URL = new URL(
  "../plugins/telegram-hooks/lib/messages.mjs",
  import.meta.url,
).href;
const UI_URL = new URL("./ui.mjs", import.meta.url).href;
const GENERATOR = fileURLToPath(import.meta.url);
const FIXTURE_ASK = "bcctFixtureAsk";
const ASKERS = [
  "askYesNo",
  "askInstalledCommands",
  "askTranscription",
  "askRemoveModels",
  "askInbox",
];
const EXPOSED = [
  "journal",
  "UNINSTALL",
  "confirmPluginStep",
  "ensurePlugins",
  "ensureTranscription",
  "applyTranscription",
  "ensureInbox",
  "keptSetting",
  "reportStop",
];
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

function exposed(source) {
  let out = source;

  for (const name of ASKERS) {
    const pattern = new RegExp(
      `\\n((?:export )?(?:async )?function) ${name}\\(`,
      "g",
    );
    const matches = out.match(pattern) ?? [];

    if (matches.length !== 1) throw new Error(`cannot wrap ${name}`);

    out = out.replace(pattern, `\n$1 unusedOriginal${name}(`);
    out += `\nfunction ${name}(...args) { return globalThis.${FIXTURE_ASK}(${JSON.stringify(name)}, args); }`;
  }

  return `${out}\nexport { ${EXPOSED.join(", ")} };\n`;
}

function describeAsk(name, args) {
  switch (name) {
    case "askYesNo":
      return { name, prompt: args[0], defaultYes: args[2] ?? true };
    case "askInstalledCommands":
      return { name };
    case "askTranscription":
      return {
        name,
        current: args[0],
        saved: args[3]?.saved ?? false,
        installed: args[3]?.installed ?? [],
      };
    case "askRemoveModels":
      return {
        name,
        others: args[0],
        previous: args[1],
        tag: args[4]?.tag ?? args[2].modelInUse,
      };
    default:
      return { name, current: args[0], saved: args[3]?.saved ?? false };
  }
}

async function child(scenarioFile, resultFile) {
  const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"));

  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);

      return url === SETUP_URL
        ? { ...loaded, source: exposed(String(loaded.source)) }
        : loaded;
    },
  });

  const setup = await import(SETUP_URL);
  const { messagesFor } = await import(MESSAGES_URL);
  const { success } = await import(UI_URL);
  const messages = messagesFor(scenario.locale);
  const asks = [];
  const answers = [...scenario.answers];
  const journal = [];
  const undos = [];

  globalThis[FIXTURE_ASK] = (name, args) => {
    asks.push(describeAsk(name, args));

    if (answers.length === 0) throw new Error(`no answer for ${name}`);

    const answer = answers.shift();

    return Promise.resolve(
      answer !== null && answer.uninstall === true ? setup.UNINSTALL : answer,
    );
  };

  for (const method of ["record", "trackDir", "trackFile"]) {
    const original = setup.journal[method];

    setup.journal[method] = (...args) => {
      if (method === "record") {
        journal.push({
          call: method,
          kind: args[0],
          target: args[1],
          undo: typeof args[2] === "function",
        });
        undos.push(args[2]);
      } else {
        journal.push({ call: method, path: args[0] });
      }

      return original(...args);
    };
  }

  const appDir = process.env.BETTER_CC_TELEGRAM_DIR;
  const stateDir = process.env.TELEGRAM_STATE_DIR;
  const ops = {
    requirements: () => setup.ensureRequirements(scenario.input, messages),
    pluginCheck: () => setup.confirmPluginStep(messages),
    pluginEnsure: () => setup.ensurePlugins(messages, scenario.input),
    transcription: () => setup.ensureTranscription(appDir, messages),
    applyTranscription: () =>
      setup.applyTranscription(appDir, scenario.input, messages),
    inbox: () => setup.ensureInbox(appDir, messages),
    kept: () =>
      setup.keptSetting(
        scenario.input.step,
        scenario.input.value,
        appDir,
        messages,
      ),
    uninstall: () => setup.uninstall({ stateDir, appDir }, messages),
    report: () =>
      setup.reportStop(
        Object.assign(new Error(scenario.input.message), {
          declined: true,
          hint: messages.byHand,
          commands: scenario.input.commands,
        }),
      ),
  };
  const result = { value: null, error: null };

  try {
    const value = await ops[scenario.op]();

    result.value = value === undefined ? null : value;
  } catch (error) {
    result.error = {
      message: error.message,
      declined: error.declined === true,
      hint: error.hint ?? null,
      commands: error.commands ?? null,
    };
  }

  const callsFile = join(process.env.HOME, "..", "claude-calls");
  const callsBefore = readOrEmpty(callsFile);

  for (const undo of undos) {
    try {
      undo?.();
    } catch {}
  }

  const callsAfter = readOrEmpty(callsFile);

  if (callsAfter !== callsBefore) writeFileSync(callsFile, callsBefore);

  result.undoCalls = callsAfter
    .slice(callsBefore.length)
    .split("\n")
    .filter(Boolean);
  result.asks = asks;
  result.journal = journal;
  result.path = process.env.PATH;
  result.tail = `${messages.stateKept(stateDir, appDir)}\n\n${success(messages.uninstallDone)}\n`;
  writeFileSync(resultFile, JSON.stringify(result));
}

function readOrEmpty(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[2] === "--child") {
  await child(process.argv[3], process.argv[4]);
} else {
  await parent();
}

async function parent() {
  const { REPO_ROOT, materialize, placeholders, snapshot, writeFixture } =
    await import("./fixture-support.mjs");
  const setup = await import(SETUP_URL);
  const { MESSAGES } = await import(MESSAGES_URL);
  const {
    BCCT_PLUGIN_ID,
    CHANNEL_PLUGIN_ID,
    HOOKS_PLUGIN_ID,
    MARKETPLACE_NAME,
    PLUGIN_IDS,
    SHELL_MARKER,
  } = setup;
  const shellFile = join(REPO_ROOT, "scripts", "shell.sh");
  const loadsShell = `${SHELL_MARKER}\n[ -f "{repo}/scripts/shell.sh" ] && . "{repo}/scripts/shell.sh"\n`;
  const KEEP = Symbol("keep");

  process.umask(0o022);

  const json = (value) => JSON.stringify(value);
  const executable = (lines) => ({
    content: ["#!/bin/sh", "PATH=/usr/bin:/bin", ...lines, ""].join("\n"),
    mode: 0o755,
  });
  const script = (lines) => ["PATH=/usr/bin:/bin", ...lines, ""].join("\n");
  const CLAUDE = executable([
    'printf \'%s\\n\' "$*" >> "{root}/claude-calls"',
    'case "$*" in',
    '  "plugin list") cat "{root}/plugins.txt" 2>/dev/null ;;',
    '  "plugin marketplace list") cat "{root}/marketplaces.txt" 2>/dev/null ;;',
    "esac",
    'if grep -qxF -- "$*" "{root}/claude-fail.txt" 2>/dev/null; then',
    '  echo "claude said: $*"',
    '  echo "claude complained" >&2',
    "  exit 1",
    "fi",
    'if grep -qxF -- "$*" "{root}/claude-mute.txt" 2>/dev/null; then',
    '  echo "   "',
    "  exit 1",
    "fi",
    "exit 0",
  ]);
  const CURL = executable([
    'printf \'%s\\n\' "$*" >> "{root}/curl-calls"',
    'case "$*" in',
    '  *claude.ai/install.sh*) cat "{root}/installers/claude.sh" ;;',
    '  *bun.sh/install*) cat "{root}/installers/bun.sh" ;;',
    '  *astral.sh/uv/*) cat "{root}/installers/uv.sh" ;;',
    "esac",
  ]);
  const installer = (name, binDir, { exit = 0, creates = true } = {}) =>
    script([
      `echo "installing ${name} $*"`,
      ...(creates
        ? [
            `mkdir -p "${binDir}"`,
            `cp "{root}/templates/${name}" "${binDir}/${name}"`,
            `chmod 755 "${binDir}/${name}"`,
          ]
        : []),
      `echo "installer of ${name} done" >&2`,
      `exit ${exit}`,
    ]);
  const PYTHON = ({ works = true, download = 0, creates = true } = {}) =>
    executable([
      'printf \'%s\\n\' "$*" >> "{root}/python-calls"',
      `if [ "$1" = "-c" ]; then exit ${works ? 0 : 1}; fi`,
      'echo "progress 50%"',
      ...(download === 0
        ? creates
          ? [
              '[ -n "$HF_HUB_CACHE" ] && mkdir -p "$HF_HUB_CACHE/models--Systran--faster-whisper-$4"',
            ]
          : []
        : ['echo "boom: no network" >&2']),
      `exit ${download}`,
    ]);
  const UV = ({ venv = 0, pip = 0 } = {}) =>
    executable([
      'printf \'%s\\n\' "$*" >> "{root}/uv-calls"',
      'if [ "$1" = "venv" ]; then',
      ...(venv === 0
        ? [
            '  mkdir -p "$2/bin"',
            '  cp "{root}/templates/python" "$2/bin/python"',
            '  chmod 755 "$2/bin/python"',
            "  exit 0",
          ]
        : ['  echo "uv: no python3 found" >&2', `  exit ${venv}`]),
      "fi",
      ...(pip === 0 ? [] : ['echo "pip: resolution failed"']),
      `exit ${pip}`,
    ]);
  const PYTHON3 = ({ venv = 0 } = {}) =>
    executable([
      'printf \'%s\\n\' "$*" >> "{root}/python3-calls"',
      ...(venv === 0
        ? [
            'mkdir -p "$3/bin"',
            'cp "{root}/templates/python" "$3/bin/python"',
            'cp "{root}/templates/pip" "$3/bin/pip"',
            'chmod 755 "$3/bin/python" "$3/bin/pip"',
            "exit 0",
          ]
        : ['echo "venv: ensurepip is not available" >&2', `exit ${venv}`]),
    ]);
  const PIP = (exit = 0) =>
    executable([
      'printf \'%s\\n\' "$*" >> "{root}/pip-calls"',
      ...(exit === 0 ? [] : ['echo "pip: no matching distribution" >&2']),
      `exit ${exit}`,
    ]);
  const NPM = (exit = 0) =>
    executable(['printf \'%s\\n\' "$*" >> "{root}/npm-calls"', `exit ${exit}`]);
  const TEMPLATE = executable(["exit 0"]);
  const INSTALLERS = {
    "installers/claude.sh": installer("claude", "{root}/home/.local/bin"),
    "installers/bun.sh": installer("bun", "{root}/home/.bun/bin"),
    "installers/uv.sh": installer("uv", "{root}/home/.local/bin"),
    "templates/claude": TEMPLATE,
    "templates/bun": TEMPLATE,
    "templates/uv": UV(),
  };
  const BASE_ENV = {
    HOME: "{root}/home",
    CLAUDE_CONFIG_DIR: "{root}/claude",
    TELEGRAM_STATE_DIR: "{root}/state",
    BETTER_CC_TELEGRAM_DIR: "{root}/app",
    HF_HUB_CACHE: "{root}/hub",
    SHELL: "/bin/bash",
    PATH: "{root}/bin:{sys}",
    LANG: "C",
  };
  const BASE_FILES = {
    "home/": {},
    "state/": {},
    "app/": {},
    "claude/": {},
    "bin/curl": CURL,
    ...INSTALLERS,
  };
  const ALL = PLUGIN_IDS.join("\n");
  const REQUIRED = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID];
  const model = (name) => `hub/models--Systran--faster-whisper-${name}/`;
  const venvPython = "app/whisper/venv/bin/python";
  const config = (value) => ({ "app/better-cc-telegram.json": json(value) });

  function merged(base, extra = {}) {
    const out = { ...base };

    for (const [key, value] of Object.entries(extra)) {
      if (value === null) delete out[key];
      else out[key] = value;
    }

    return out;
  }

  const scenarios = [];

  function add(name, op, options = {}) {
    scenarios.push({
      name,
      op,
      locale: options.locale ?? "en-us",
      colorize: options.colorize ?? false,
      tty: options.tty ?? null,
      input: options.input ?? null,
      answers: options.answers ?? [],
      env: merged(
        merged(BASE_ENV, options.colorize ? { FORCE_COLOR: "1" } : {}),
        options.env,
      ),
      files: merged(BASE_FILES, options.files),
    });
  }

  const present = {
    "bin/claude": CLAUDE,
    "bin/bun": TEMPLATE,
  };

  add("requirements asks nothing when every tool is there", "requirements", {
    input: ["claude", "bun"],
    files: present,
  });
  add("requirements installs a missing bun once agreed", "requirements", {
    input: ["claude", "bun"],
    answers: [true],
    files: { "bin/claude": CLAUDE },
  });
  add(
    "requirements installs claude and bun one after the other",
    "requirements",
    { input: ["claude", "bun"], answers: [true, true] },
  );
  add(
    "requirements declines every missing tool and lists the commands",
    "requirements",
    { input: ["claude", "bun", "uv"], answers: [false, false, false] },
  );
  add(
    "requirements installs what was accepted and then stops on the declined one",
    "requirements",
    { input: ["claude", "bun"], answers: [false, true] },
  );
  add("requirements stops when the installer fails", "requirements", {
    input: ["bun"],
    answers: [true],
    files: {
      "installers/bun.sh": installer("bun", "{root}/home/.bun/bin", {
        exit: 1,
      }),
    },
  });
  add(
    "requirements stops when the tool is still missing after installing",
    "requirements",
    {
      input: ["bun"],
      answers: [true],
      files: {
        "installers/bun.sh": installer("bun", "{root}/home/.bun/bin", {
          creates: false,
        }),
      },
    },
  );
  add(
    "requirements without curl ends with the tool still missing",
    "requirements",
    { input: ["bun"], answers: [true], files: { "bin/curl": null } },
  );
  add("requirements installs uv in pt-br with colors", "requirements", {
    input: ["uv"],
    answers: [true],
    locale: "pt-br",
    colorize: true,
  });
  add("requirements declines in pt-br with colors", "requirements", {
    input: ["claude", "bun"],
    answers: [false, false],
    locale: "pt-br",
    colorize: true,
  });
  add("requirements of an empty list does nothing", "requirements", {
    input: [],
  });
  add(
    "requirements decides what is missing before installing anything",
    "requirements",
    {
      input: ["claude", "bun"],
      answers: [true, false],
      files: {
        "installers/claude.sh": script([
          'mkdir -p "{root}/home/.local/bin"',
          'cp "{root}/templates/claude" "{root}/home/.local/bin/claude"',
          'cp "{root}/templates/bun" "{root}/home/.local/bin/bun"',
          'chmod 755 "{root}/home/.local/bin/claude" "{root}/home/.local/bin/bun"',
        ]),
      },
    },
  );

  const lists = (plugins, marketplaces) => ({
    "bin/claude": CLAUDE,
    "plugins.txt": plugins,
    "marketplaces.txt": marketplaces,
  });

  add(
    "plugin check on a fresh machine plans everything and adds bcct",
    "pluginCheck",
    { answers: [true, true], files: lists("", "") },
  );
  add("plugin check declined plan stops with the commands", "pluginCheck", {
    answers: [false],
    files: lists("", ""),
  });
  add(
    "plugin check with everything installed keeps the commands",
    "pluginCheck",
    {
      answers: ["keep"],
      files: {
        ...lists(ALL, `${MARKETPLACE_NAME}\n`),
        "home/.bashrc": loadsShell,
      },
    },
  );
  add(
    "plugin check with everything installed removes the commands",
    "pluginCheck",
    {
      answers: ["remove"],
      files: {
        ...lists(ALL, `${MARKETPLACE_NAME}\n`),
        "home/.bashrc": loadsShell,
      },
    },
  );
  add("plugin check without bcct says no to it", "pluginCheck", {
    answers: [false],
    files: {
      ...lists(REQUIRED.join("\n"), MARKETPLACE_NAME),
      "home/.bashrc": `alias x=y\n${loadsShell}`,
    },
  });
  add("plugin check on zsh plans the zshrc and the bashrc", "pluginCheck", {
    answers: [true, false],
    env: { SHELL: "/usr/bin/zsh" },
    files: {
      ...lists(REQUIRED.join("\n"), MARKETPLACE_NAME),
      "home/.bashrc": "alias x=y\n",
    },
  });
  add(
    "plugin check on fish plans only the rc files that exist",
    "pluginCheck",
    {
      answers: [true, true],
      env: { SHELL: "fish" },
      files: {
        ...lists(HOOKS_PLUGIN_ID, ""),
        "home/.bashrc": "",
        "home/.zshrc": loadsShell,
      },
    },
  );
  add("plugin check in pt-br with colors", "pluginCheck", {
    answers: [true, "keep"],
    locale: "pt-br",
    colorize: true,
    files: lists(`${HOOKS_PLUGIN_ID}\n${BCCT_PLUGIN_ID}`, MARKETPLACE_NAME),
  });
  add("plugin check when claude lists nothing", "pluginCheck", {
    answers: [true, true],
    files: { "bin/claude": CLAUDE },
  });
  add("plugin check on a terminal", "pluginCheck", {
    answers: [true, true],
    colorize: true,
    tty: 200,
    files: lists("", ""),
  });
  add("plugin check on a narrow terminal", "pluginCheck", {
    answers: [true, true],
    colorize: true,
    tty: 9,
    files: lists("", ""),
  });

  const choice = (extra = {}) => ({
    marketplaces: "",
    plugins: "",
    pluginIds: PLUGIN_IDS,
    removedIds: [],
    ...extra,
  });

  add("plugin ensure adds the marketplace and every plugin", "pluginEnsure", {
    input: choice(),
    files: { "bin/claude": CLAUDE },
  });
  add(
    "plugin ensure skips what is in place and already enabled",
    "pluginEnsure",
    {
      input: choice({ marketplaces: MARKETPLACE_NAME, plugins: ALL }),
      files: {
        "bin/claude": CLAUDE,
        "claude/settings.json": json({
          enabledPlugins: {
            [CHANNEL_PLUGIN_ID]: false,
            [HOOKS_PLUGIN_ID]: true,
            [BCCT_PLUGIN_ID]: true,
          },
        }),
      },
    },
  );
  add(
    "plugin ensure says a plugin it just installed is enabled",
    "pluginEnsure",
    {
      input: choice({ marketplaces: MARKETPLACE_NAME, plugins: "" }),
      files: {
        "bin/claude": CLAUDE,
        "claude/settings.json": json({
          enabledPlugins: { [HOOKS_PLUGIN_ID]: true, [BCCT_PLUGIN_ID]: 1 },
        }),
      },
    },
  );
  add("plugin ensure removes the commands first", "pluginEnsure", {
    input: choice({
      marketplaces: MARKETPLACE_NAME,
      plugins: ALL,
      pluginIds: REQUIRED,
      removedIds: [BCCT_PLUGIN_ID],
    }),
    files: { "bin/claude": CLAUDE },
  });
  add(
    "plugin ensure stops when a plugin install fails, with what claude said",
    "pluginEnsure",
    {
      input: choice(),
      files: {
        "bin/claude": CLAUDE,
        "claude-fail.txt": `plugin install ${HOOKS_PLUGIN_ID} --scope user\n`,
      },
    },
  );
  add(
    "plugin ensure stops when the marketplace cannot be added, silently",
    "pluginEnsure",
    {
      input: choice(),
      files: {
        "bin/claude": CLAUDE,
        "claude-mute.txt": "plugin marketplace add {repo}\n",
      },
    },
  );
  add(
    "plugin ensure stops when the removal of the commands fails",
    "pluginEnsure",
    {
      input: choice({
        marketplaces: MARKETPLACE_NAME,
        plugins: ALL,
        pluginIds: REQUIRED,
        removedIds: [BCCT_PLUGIN_ID],
      }),
      files: {
        "bin/claude": CLAUDE,
        "claude-fail.txt": `plugin uninstall ${BCCT_PLUGIN_ID} --scope user\n`,
      },
    },
  );
  add("plugin ensure stops on an invalid settings.json", "pluginEnsure", {
    input: choice({ marketplaces: MARKETPLACE_NAME, plugins: ALL }),
    files: { "bin/claude": CLAUDE, "claude/settings.json": "{ broken" },
  });
  for (const enabledPlugins of [[false, true], "x", null, 7]) {
    add(
      `plugin ensure with enabledPlugins ${json(enabledPlugins)}`,
      "pluginEnsure",
      {
        input: choice({ marketplaces: MARKETPLACE_NAME, plugins: ALL }),
        files: {
          "bin/claude": CLAUDE,
          "claude/settings.json": json({ enabledPlugins }),
        },
      },
    );
  }
  add("plugin ensure ignores a failing enable or disable", "pluginEnsure", {
    input: choice({ marketplaces: MARKETPLACE_NAME, plugins: ALL }),
    files: {
      "bin/claude": CLAUDE,
      "claude-fail.txt": `plugin disable ${CHANNEL_PLUGIN_ID} --scope user\nplugin enable ${HOOKS_PLUGIN_ID} --scope user\n`,
    },
  });
  add("plugin ensure in pt-br with colors", "pluginEnsure", {
    input: choice({ plugins: HOOKS_PLUGIN_ID }),
    locale: "pt-br",
    colorize: true,
    files: {
      "bin/claude": CLAUDE,
      "claude/settings.json": json({
        enabledPlugins: { [HOOKS_PLUGIN_ID]: true },
      }),
    },
  });
  add("plugin ensure on a terminal", "pluginEnsure", {
    input: choice(),
    colorize: true,
    tty: 200,
    files: { "bin/claude": CLAUDE },
  });
  add("plugin ensure failing on a terminal", "pluginEnsure", {
    input: choice(),
    colorize: true,
    tty: 200,
    files: {
      "bin/claude": CLAUDE,
      "claude-fail.txt": `plugin install ${CHANNEL_PLUGIN_ID} --scope user\n`,
    },
  });

  const whisper = (options) => ({
    [venvPython]: PYTHON(options),
    "templates/python": PYTHON(),
  });

  add("transcription turned off on a fresh setup", "transcription", {
    answers: [null],
  });
  add("transcription turned off in pt-br", "transcription", {
    answers: [null],
    locale: "pt-br",
    files: config({ language: "pt-br" }),
  });
  add(
    "transcription keeps an installed model without downloading",
    "transcription",
    {
      answers: ["base"],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper(),
        [model("base")]: {},
      },
    },
  );
  add("transcription that stays off is kept", "transcription", {
    answers: [null],
    files: config({ transcription: null }),
  });
  add(
    "transcription switches to an installed model without downloading",
    "transcription",
    {
      answers: ["small"],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper(),
        [model("small")]: {},
      },
    },
  );
  add(
    "transcription switch asks which of the others to uninstall",
    "transcription",
    {
      answers: ["small", ["base"]],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper(),
        [model("base")]: {},
        [model("small")]: {},
        [model("medium")]: {},
      },
    },
  );
  add("transcription switch keeps the others on Enter", "transcription", {
    answers: ["small", []],
    files: {
      ...config({ transcription: { model: "base" } }),
      ...whisper(),
      [model("base")]: {},
      [model("small")]: {},
    },
  });
  add(
    "transcription switch not saved before asks without a previous model",
    "transcription",
    {
      answers: ["small", ["base", "medium"]],
      files: {
        ...whisper(),
        [model("base")]: {},
        [model("small")]: {},
        [model("medium")]: {},
      },
    },
  );
  add(
    "transcription downloads a new model quietly and says it is installed",
    "transcription",
    { answers: ["base"], files: whisper() },
  );
  add(
    "transcription shows the download output with the error when it fails",
    "transcription",
    {
      answers: ["small"],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper({ download: 3 }),
      },
    },
  );
  add("transcription creates the environment with uv", "transcription", {
    answers: ["medium"],
    files: { "bin/uv": UV(), "templates/python": PYTHON() },
  });
  add("transcription creates the environment with python3", "transcription", {
    answers: ["base"],
    files: {
      "bin/python3": PYTHON3(),
      "templates/python": PYTHON(),
      "templates/pip": PIP(),
    },
  });
  add("transcription stops when python3 cannot make a venv", "transcription", {
    answers: ["base"],
    files: { "bin/python3": PYTHON3({ venv: 1 }) },
  });
  add("transcription stops when pip cannot install", "transcription", {
    answers: ["base"],
    files: {
      "bin/python3": PYTHON3(),
      "templates/python": PYTHON(),
      "templates/pip": PIP(2),
    },
  });
  add("transcription stops when uv venv fails", "transcription", {
    answers: ["base"],
    files: { "bin/uv": UV({ venv: 2 }) },
  });
  add("transcription stops when uv pip fails", "transcription", {
    answers: ["base"],
    files: { "bin/uv": UV({ pip: 1 }), "templates/python": PYTHON() },
  });
  add(
    "transcription installs uv first when there is no uv nor python3",
    "transcription",
    {
      answers: ["base", true],
      files: { "templates/python": PYTHON() },
    },
  );
  add("transcription stops when installing uv is declined", "transcription", {
    answers: ["small", false],
  });
  add(
    "transcription rebuilds a broken environment of an installed model",
    "transcription",
    {
      answers: ["base"],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper({ works: false }),
        "bin/uv": UV(),
        [model("base")]: {},
      },
    },
  );
  add(
    "transcription uninstalls the only model without asking which",
    "transcription",
    {
      answers: [{ uninstall: true }],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper(),
        [model("base")]: {},
      },
    },
  );
  add("transcription uninstalls all of several models", "transcription", {
    answers: [{ uninstall: true }, ["base", "small", "medium"]],
    files: {
      ...config({ transcription: { model: "base" } }),
      ...whisper(),
      [model("base")]: {},
      [model("small")]: {},
      [model("medium")]: {},
    },
  });
  add(
    "transcription uninstalls a model not in use and stays on",
    "transcription",
    {
      answers: [{ uninstall: true }, ["small"]],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper(),
        [model("base")]: {},
        [model("small")]: {},
      },
    },
  );
  add("transcription uninstall keeps everything on Enter", "transcription", {
    answers: [{ uninstall: true }, []],
    files: {
      ...config({ transcription: { model: "base" } }),
      ...whisper(),
      [model("base")]: {},
      [model("small")]: {},
    },
  });
  add(
    "transcription uninstall of the model in use turns off",
    "transcription",
    {
      answers: [{ uninstall: true }, ["base"]],
      files: {
        ...config({ transcription: { model: "base" } }),
        ...whisper(),
        [model("base")]: {},
        [model("small")]: {},
      },
    },
  );
  add(
    "transcription uninstall without a saved choice turns off",
    "transcription",
    {
      answers: [{ uninstall: true }],
      files: { ...whisper(), [model("medium")]: {} },
    },
  );
  add(
    "transcription uninstall with nothing installed asks which of none",
    "transcription",
    { answers: [{ uninstall: true }, []] },
  );
  for (const transcription of [
    "small",
    { model: "MEDIUM" },
    { model: " small " },
    { model: "large" },
    { model: "off" },
    { model: 5 },
    { model: null },
    false,
    0,
    "",
    true,
    [],
  ]) {
    add(
      `transcription reads the saved ${json(transcription)}`,
      "transcription",
      { answers: [null], files: config({ transcription }) },
    );
  }
  add("transcription finds the models in the default cache", "transcription", {
    answers: ["small"],
    env: { HF_HUB_CACHE: null },
    files: {
      ...config({ transcription: { model: "base" } }),
      ...whisper(),
      "home/.cache/huggingface/hub/models--Systran--faster-whisper-small/": {},
    },
  });
  add("transcription follows HF_HOME and XDG_CACHE_HOME", "transcription", {
    answers: ["small"],
    env: { HF_HUB_CACHE: null, HF_HOME: "{root}/hf" },
    files: {
      ...whisper(),
      "hf/hub/models--Systran--faster-whisper-small/": {},
    },
  });
  add("transcription in pt-br with colors", "transcription", {
    answers: ["small", ["base"]],
    locale: "pt-br",
    colorize: true,
    files: {
      ...config({ language: "pt-br", transcription: { model: "base" } }),
      ...whisper(),
      [model("base")]: {},
    },
  });
  add("transcription download on a terminal", "transcription", {
    answers: ["medium"],
    colorize: true,
    tty: 200,
    files: { "bin/uv": UV(), "templates/python": PYTHON() },
  });
  add("apply transcription turns it off", "applyTranscription", {
    input: null,
    files: config({ transcription: { model: "small" } }),
  });
  add("apply transcription downloads the model", "applyTranscription", {
    input: "small",
    files: whisper(),
  });

  add("inbox saves the default on a fresh setup", "inbox", {
    answers: [7],
  });
  add("inbox keeps the saved days", "inbox", {
    answers: [7],
    files: config({ inboxRetentionDays: 7 }),
  });
  add("inbox keeps the files forever", "inbox", {
    answers: [null],
    files: config({ language: "en-us", inboxRetentionDays: 3 }),
  });
  add("inbox that stays forever is kept", "inbox", {
    answers: [null],
    files: config({ inboxRetentionDays: null }),
  });
  add("inbox changes the days", "inbox", {
    answers: [10],
    files: config({ inboxRetentionDays: 3, delayMinutes: 2 }),
  });
  for (const inboxRetentionDays of ["5", -1, 0, true, [3]]) {
    add(`inbox reads the saved ${json(inboxRetentionDays)}`, "inbox", {
      answers: [3],
      files: config({ inboxRetentionDays }),
    });
  }
  add("inbox keeps a saved fraction of a day as it is", "inbox", {
    answers: [2.5],
    files: config({ inboxRetentionDays: 2.5 }),
  });
  add("inbox saves a fraction of a day", "inbox", {
    answers: [0.5],
    files: config({ inboxRetentionDays: 3 }),
  });
  add("inbox saves a number too long for an integer", "inbox", {
    answers: [1e20],
  });
  add("inbox saves a number JavaScript writes as an exponent", "inbox", {
    answers: [1e21],
  });
  add("inbox with a config that is not an object", "inbox", {
    answers: [14],
    files: { "app/better-cc-telegram.json": "[1]" },
  });
  add("inbox creates the app folder", "inbox", {
    answers: [30],
    files: { "app/": null },
    env: { BETTER_CC_TELEGRAM_DIR: "{root}/new/app" },
  });
  add("inbox in pt-br with colors", "inbox", {
    answers: [1],
    locale: "pt-br",
    colorize: true,
    files: config({ language: "pt-br" }),
  });

  const kept = (step, value, saved, extra = {}) =>
    add(`kept ${step} ${json(value)} against ${json(saved)}`, "kept", {
      input: { step, value },
      files: { ...(saved === undefined ? {} : config(saved)), ...extra },
    });

  kept("language", "pt-br", { language: "pt-br" });
  kept("language", "en-us", { language: "pt-br" });
  kept("language", "xx", { language: "xx" });
  kept("language", "en-us", {});
  kept("delay", 4, { delayMinutes: 4 });
  kept("delay", 2.5, { delayMinutes: 2.5 });
  kept("delay", 5, { delayMinutes: 4 });
  kept("delay", 4, { delayMinutes: "4" });
  kept("delay", 4, undefined);
  kept(
    "quiet-hours",
    { start: "22:00", end: "07:00" },
    { quietHours: { start: "22:00", end: "07:00" } },
  );
  kept("quiet-hours", null, { quietHours: null });
  kept("quiet-hours", { start: "", end: "07:00" }, { quietHours: null });
  kept("quiet-hours", { start: "22:00", end: "" }, { quietHours: null });
  kept("quiet-hours", null, {});
  kept("quiet-hours", null, { quietHours: { start: "22:00" } });
  kept(
    "quiet-hours",
    { start: "1", end: "2" },
    { quietHours: { start: 1, end: 2 } },
  );
  kept(
    "quiet-hours",
    { start: "22:00", end: "07:00" },
    { quietHours: { start: "22:00", end: "08:00" } },
  );
  kept("inbox", 7, { inboxRetentionDays: 7 });
  kept("inbox", null, { inboxRetentionDays: null });
  kept("inbox", 7, {});
  kept("inbox", 7, { inboxRetentionDays: "7" });
  kept("transcription", null, { transcription: null });
  kept("transcription", null, { transcription: { model: null } });
  kept("transcription", null, { transcription: "x" });
  kept("transcription", null, {});
  kept("transcription", "base", { transcription: { model: "base" } });
  kept(
    "transcription",
    "base",
    { transcription: { model: "base" } },
    { ...whisper(), [model("base")]: {} },
  );
  kept(
    "transcription",
    "base",
    { transcription: { model: "base" } },
    { ...whisper({ works: false }), [model("base")]: {} },
  );
  kept("transcription", "small", { transcription: { model: "base" } });

  const uninstallFiles = (extra = {}) => ({
    ...lists(ALL, `${MARKETPLACE_NAME}\n`),
    ...extra,
  });

  add("uninstall removes every plugin and the marketplace", "uninstall", {
    answers: [false],
    files: uninstallFiles(),
  });
  add("uninstall skips what is not there", "uninstall", {
    answers: [false],
    files: uninstallFiles(lists(REQUIRED.join("\n"), "")),
  });
  add("uninstall says what could not be removed and goes on", "uninstall", {
    answers: [false],
    files: uninstallFiles({
      "claude-fail.txt": [
        ...PLUGIN_IDS.map((id) => `plugin uninstall ${id} --scope user`),
        `plugin marketplace remove ${MARKETPLACE_NAME}`,
        "",
      ].join("\n"),
    }),
  });
  add("uninstall without claude explains the commands", "uninstall", {
    answers: [false],
  });
  add("uninstall removes the transcription when confirmed", "uninstall", {
    answers: [true, false],
    files: uninstallFiles({
      [venvPython]: TEMPLATE,
      "hub/models--Systran--faster-whisper-base/model.bin": "x",
      "hub/models--Systran--faster-whisper-medium/": {},
      "hub/models--someone--else/x.bin": "x",
    }),
  });
  add("uninstall keeps the transcription when not confirmed", "uninstall", {
    answers: [false, false],
    files: uninstallFiles({
      "app/whisper/": {},
      "hub/models--Systran--faster-whisper-small/": {},
    }),
  });
  add("uninstall finds only the downloaded models", "uninstall", {
    answers: [true, false],
    env: { HF_HUB_CACHE: null },
    files: uninstallFiles({
      "home/.cache/huggingface/hub/models--Systran--faster-whisper-small":
        "a file",
    }),
  });
  add("uninstall removes mmdc when confirmed", "uninstall", {
    answers: [true, false],
    files: uninstallFiles({ "bin/mmdc": TEMPLATE, "bin/npm": NPM() }),
  });
  add("uninstall explains how to remove mmdc by hand", "uninstall", {
    answers: [true, false],
    files: uninstallFiles({ "bin/mmdc": TEMPLATE, "bin/npm": NPM(1) }),
  });
  add("uninstall keeps mmdc when not confirmed", "uninstall", {
    answers: [false, false],
    files: uninstallFiles({ "bin/mmdc": TEMPLATE, "bin/npm": NPM() }),
  });
  add("uninstall without npm cannot remove mmdc", "uninstall", {
    answers: [true, false],
    files: uninstallFiles({ "bin/mmdc": TEMPLATE }),
  });
  add("uninstall in pt-br with colors", "uninstall", {
    answers: [true, true, false],
    locale: "pt-br",
    colorize: true,
    files: uninstallFiles({
      "app/whisper/venv/": {},
      "bin/mmdc": TEMPLATE,
      "bin/npm": NPM(),
      "claude-fail.txt": `plugin uninstall ${HOOKS_PLUGIN_ID} --scope user\n`,
    }),
  });
  add("uninstall on a terminal", "uninstall", {
    answers: [true, true, false],
    colorize: true,
    tty: 200,
    files: uninstallFiles({
      "app/whisper/": {},
      "bin/mmdc": TEMPLATE,
      "bin/npm": NPM(),
    }),
  });

  add("report of a declined tool", "report", {
    input: {
      message: MESSAGES["en-us"].toolsDeclined("bun"),
      commands: [setup.installerFor("bun", "/h").command],
    },
  });
  add("report of a declined plan in pt-br with colors", "report", {
    locale: "pt-br",
    colorize: true,
    input: {
      message: MESSAGES["pt-br"].nothingInstalled,
      commands: [
        "claude plugin marketplace add /r",
        "echo 'x' >> \"/h/.bashrc\"",
      ],
    },
  });

  const sys = realpathSync(mkdtempSync(join(tmpdir(), "bcct-sys-")));
  const located = (tool) =>
    spawnSync("sh", ["-c", `command -v ${tool}`], {
      encoding: "utf8",
    }).stdout.trim();
  const SCRIPT = located("script");
  const STTY = located("stty");

  for (const tool of ["sh", "bash"])
    symlinkSync(located(tool), join(sys, tool));

  function normalizeTerminal(text) {
    const parts = text.replaceAll("\r\n", "\n").split("\r");
    let out = parts[0];

    for (const part of parts.slice(1)) {
      const frame = part.startsWith(CYAN) ? part.slice(CYAN.length) : part;

      if (!(SPINNER_FRAMES.has([...frame][0]) && !part.includes("\n"))) {
        out += `\r${part}`;
      }
    }

    return out;
  }

  function shellQuote(text) {
    return `'${text.replaceAll("'", "'\\''")}'`;
  }

  function runScenario(scenario) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "bcct-fixture-")));
    const work = realpathSync(mkdtempSync(join(tmpdir(), "bcct-work-")));
    const fill = (text) =>
      text.replaceAll("{root}", root).replaceAll("{sys}", sys);
    const unfill = (text) => placeholders(text, root).replaceAll(sys, "{sys}");

    try {
      materialize(root, scenario.files);

      const env = Object.fromEntries(
        Object.entries(scenario.env).map(([key, value]) => [key, fill(value)]),
      );
      const scenarioFile = join(work, "scenario.json");
      const resultFile = join(work, "result.json");

      writeFileSync(scenarioFile, JSON.stringify(scenario));

      const args = [GENERATOR, "--child", scenarioFile, resultFile];
      const run =
        scenario.tty === null
          ? spawnSync(process.execPath, args, {
              cwd: REPO_ROOT,
              env,
              encoding: "utf8",
            })
          : spawnSync(
              SCRIPT,
              [
                "-qec",
                `${STTY} cols ${scenario.tty}; ${[process.execPath, ...args].map(shellQuote).join(" ")}`,
                "/dev/null",
              ],
              { cwd: REPO_ROOT, env, encoding: "utf8" },
            );

      if (run.status !== 0) {
        throw new Error(`${scenario.name}: ${run.stderr}${run.stdout}`);
      }

      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      let stdout =
        scenario.tty === null ? run.stdout : normalizeTerminal(run.stdout);
      let { asks } = result;
      let { answers } = scenario;

      if (scenario.op === "uninstall") {
        const tail =
          scenario.tty === null
            ? result.tail
            : result.tail.replaceAll("\r", "");

        if (!stdout.endsWith(tail)) {
          throw new Error(`${scenario.name}: unexpected tail`);
        }

        stdout = stdout.slice(0, stdout.length - tail.length);
        asks = asks.slice(0, -1);
        answers = answers.slice(0, -1);
      }

      return {
        ...scenario,
        answers,
        asks: JSON.parse(unfill(JSON.stringify(asks))),
        journal: JSON.parse(unfill(JSON.stringify(result.journal))),
        undoCalls: result.undoCalls.map(unfill),
        value: JSON.parse(unfill(JSON.stringify(result.value))),
        error: JSON.parse(unfill(JSON.stringify(result.error))),
        path: unfill(result.path),
        stdout: unfill(stdout),
        stderr: scenario.tty === null ? unfill(run.stderr) : "",
        after: snapshot(root),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }

  const results = scenarios.map(runScenario);

  rmSync(sys, { recursive: true, force: true });

  const keep = (value) => (value === KEEP ? "keep" : value);
  const answers = [
    "",
    "  ",
    "base",
    "Small",
    " MEDIUM ",
    "large",
    "não",
    "NAO",
    "n",
    "nenhum",
    "No",
    "none",
    "off",
    "0",
    "1",
    "7",
    " 30 ",
    "007",
    "-1",
    "1.5",
    "1e3",
    "99999999999999999999",
    "١",
    "sim",
    " off ",
  ];

  await writeFixture("setup-install.json", {
    constants: {
      marketplace: MARKETPLACE_NAME,
      pluginIds: PLUGIN_IDS,
      mermaidUninstallCommand: setup.MERMAID_UNINSTALL_COMMAND,
      manualUninstallCommands: setup.manualUninstallCommands(),
      shellFile: placeholders(shellFile, "/nonexistent-root"),
    },
    nodeVersionOk: [
      "24.11.0",
      "24.20.0",
      "25.0.0",
      "24.10.9",
      "22.12.0",
      "18.0.0",
      "",
      "24",
      "24.11",
      "v24.11.0",
      "24.x",
      "100.0.0",
      " 24.11.0",
      "24.11.0-rc.1",
    ].map((version) => ({ version, ok: setup.nodeVersionOk(version) })),
    installerFor: ["claude", "bun", "uv", "node", "Claude"].flatMap((tool) =>
      ["/h", "/h/", "", "/a b/c"].map((home) => ({
        tool,
        home,
        installer: setup.installerFor(tool, home) ?? null,
      })),
    ),
    huggingFaceCacheDir: [
      [{ HF_HUB_CACHE: "/hub", HF_HOME: "/x" }, "/h"],
      [{ HF_HOME: "/hf" }, "/h"],
      [{ HF_HOME: "/hf/", XDG_CACHE_HOME: "/c" }, "/h"],
      [{ XDG_CACHE_HOME: "/c" }, "/h"],
      [{}, "/h"],
      [{ HF_HUB_CACHE: "", HF_HOME: "", XDG_CACHE_HOME: "" }, "/h"],
      [{ HF_HUB_CACHE: "rel/hub" }, "/h"],
      [{ XDG_CACHE_HOME: "/c/../d" }, "/h"],
      [{}, ""],
    ].map(([env, home]) => ({
      env,
      home,
      dir: setup.huggingFaceCacheDir(env, home),
    })),
    parseTranscriptionModel: answers.map((answer) => ({
      answer,
      result: keep(setup.parseTranscriptionModel(answer, KEEP)),
    })),
    parseInboxDays: answers.map((answer) => ({
      answer,
      result: keep(setup.parseInboxDays(answer, KEEP)),
    })),
    pluginPlan: [
      {
        marketplaces: "",
        plugins: `${HOOKS_PLUGIN_ID}\n`,
        rcFiles: ["/h/.zshrc"],
        pluginIds: null,
      },
      {
        marketplaces: `${MARKETPLACE_NAME}\n`,
        plugins: "",
        rcFiles: [],
        pluginIds: [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID],
      },
      {
        marketplaces: `${MARKETPLACE_NAME}\n`,
        plugins: ALL,
        rcFiles: [],
        pluginIds: null,
      },
      {
        marketplaces: `x-${MARKETPLACE_NAME}-y`,
        plugins: `x${CHANNEL_PLUGIN_ID}`,
        rcFiles: ["/h/.bashrc", "/h/.zshrc"],
        pluginIds: [CHANNEL_PLUGIN_ID],
      },
    ].flatMap((input) =>
      ["en-us", "pt-br"].map((locale) => ({
        input,
        locale,
        plan: setup.pluginPlan(
          {
            marketplaces: input.marketplaces,
            plugins: input.plugins,
            rcFiles: input.rcFiles,
            ...(input.pluginIds === null ? {} : { pluginIds: input.pluginIds }),
          },
          MESSAGES[locale],
          { rootDir: "/repo", shellFile: "/repo/shell.sh" },
        ),
      })),
    ),
    scenarios: results,
  });
}
