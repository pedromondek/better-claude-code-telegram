import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  NOW,
  REPO_ROOT,
  materialize,
  placeholders,
  resolveEnv,
  snapshot,
  substitute,
  withProcessEnv,
  withRoot,
  writeFixture,
} from "./fixture-support.mjs";
import { createJournal } from "./journal.mjs";
import { MESSAGES } from "../plugins/telegram-hooks/lib/messages.mjs";

const SETUP_URL = pathToFileURL(join(REPO_ROOT, "scripts", "setup.mjs")).href;
const INTERNALS = [
  "applyStatusline",
  "changedOptions",
  "describeChanges",
  "ensureEnvDenied",
  "forgetStatuslineCustomized",
  "forgetStatuslineRequest",
  "isOurStatusline",
  "journal",
  "parsedJson",
  "rcFilesWithoutShellLine",
  "removeOurSettings",
  "removeShellLines",
  "requestStatuslineCustom",
  "saveInboxDays",
  "savePreviousStatusline",
  "settingText",
  "statuslineKind",
  "statuslinePreview",
  "updateConfig",
];

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);

    if (url !== SETUP_URL) return loaded;

    return {
      ...loaded,
      source: `${String(loaded.source)}\nexport { ${INTERNALS.join(", ")} };\n`,
    };
  },
});

const setup = await import(SETUP_URL);

process.umask(0o022);

const RealDate = Date;

globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length === 0 ? [NOW] : args));
  }

  static now() {
    return NOW;
  }
};

const SETTINGS = "claude/settings.json";
const APP = "app";
const CONFIG = `${APP}/better-cc-telegram.json`;
const PREVIOUS = `${APP}/statusline-previous.json`;
const REQUEST = `${APP}/statusline-customize.json`;
const ENV_RULE_FILE = "{root}/state/.env";
const OURS = setup.statuslineCommand();
const OURS_AFTER = setup.statuslineAfterCommand();
const SHELL_FILE = join(REPO_ROOT, "scripts", "shell.sh");
const BASE_ENV = {
  HOME: "{root}/home",
  CLAUDE_CONFIG_DIR: "{root}/claude",
  BETTER_CC_TELEGRAM_DIR: "{root}/app",
  TELEGRAM_STATE_DIR: "{root}/state",
};

const NO_ROOT = "\u{0}";
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const json = (value) => JSON.stringify(value);
const absent = { absent: true };
const unwrap = (entry) => (entry.absent ? undefined : entry.value);

function caught(run) {
  try {
    return { value: run() ?? null };
  } catch (error) {
    return { error: error.message };
  }
}

function capture(run) {
  const lines = [];
  const original = console.log;

  console.log = (...parts) => lines.push(parts.join(" "));

  try {
    return { ...caught(run), lines };
  } finally {
    console.log = original;
  }
}

function deepSubstitute(value, root) {
  if (typeof value === "string") return substitute(value, root);
  if (Array.isArray(value))
    return value.map((item) => deepSubstitute(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        deepSubstitute(item, root),
      ]),
    );
  }

  return value;
}

function deepPlaceholders(value, root) {
  if (typeof value === "string") return placeholders(value, root);
  if (Array.isArray(value))
    return value.map((item) => deepPlaceholders(item, root));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        deepPlaceholders(item, root),
      ]),
    );
  }

  return value;
}

const shellTexts = [
  "",
  "alias x=y\n",
  "alias x=y",
  `alias x=y\n\n# Added by better-claude-code-telegram setup\n[ -f "{shell}" ] && . "{shell}"\n`,
  `# Added by better-claude-code-telegram setup\n[ -f "{shell}" ] && . "{shell}"\n`,
  `a\n[ -f "{shell}" ] && . "{shell}"\nb\n`,
  `a\n\n# Added by better-claude-code-telegram setup\n[ -f "{shell}" ] && . "{shell}"\nb\n`,
  "a\n# {shell}\nb",
  "source {shell}",
  "{shell}{shell}\nkeep\n",
  "\n",
  "\n\n",
  "a\r\nb\r\n",
  `x\n# Added by better-claude-code-telegram setup\n[ -f "{shell}" ] && . "{shell}"\n\n# Added by better-claude-code-telegram setup\n[ -f "{shell}" ] && . "{shell}"\n`,
  "{shell}",
  "nothing about it",
];
const shellFiles = ["/repo/shell.sh", SHELL_FILE, "/a b/$x.sh", ""];

const shellText = (text, shellFile) => text.replaceAll("{shell}", shellFile);

const shell = shellFiles.flatMap((shellFile) =>
  shellTexts.map((template) => {
    const text = shellText(template, shellFile);

    return deepPlaceholders(
      {
        text,
        shellFile,
        sourceLine: setup.sourceLine(shellFile),
        loads: setup.rcLoadsShellFile(text, shellFile),
        withBlock: setup.withShellBlock(text, shellFile),
        withoutBlock: setup.withoutShellBlock(text, shellFile),
      },
      NO_ROOT,
    );
  }),
);

const denyRules = [
  ["/home/dev/.claude/channels/telegram/.env", "/home/dev"],
  ["/srv/telegram/.env", "/home/dev"],
  ["/home/dev", "/home/dev"],
  ["/home/dev/", "/home/dev"],
  ["/home/devx/.env", "/home/dev"],
  ["relative/.env", "/home/dev"],
  ["/home/dev/.env", "/"],
  ["/home/dev/.env", ""],
].map(([envFile, home]) => ({
  envFile,
  home,
  rule: setup.envDenyRule(envFile, home),
}));

const RULE = "Read(~/x/.env)";
const deniedSettings = [
  {},
  { theme: "dark" },
  {
    theme: "dark",
    permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf *)"] },
  },
  { permissions: { deny: [RULE] } },
  { permissions: { deny: ["Bash(rm -rf *)", RULE] } },
  { theme: "dark", permissions: { deny: [RULE] } },
  { permissions: { deny: [RULE, "a", RULE] }, theme: "dark" },
  { permissions: { deny: [RULE], allow: ["x"] }, z: 1 },
  { permissions: { allow: ["x"], deny: [RULE, "b"] }, z: 1 },
  { permissions: { deny: [] } },
  { permissions: { deny: null } },
  { permissions: { deny: "Read(~/x/.env) and more" } },
  { permissions: { deny: "ab😀" } },
  { permissions: { deny: 5 } },
  { permissions: { deny: true } },
  { permissions: { deny: {} } },
  { permissions: { deny: [1, null, { a: 1 }, [RULE]] } },
  { permissions: null },
  { permissions: "ab" },
  { permissions: 7 },
  { permissions: false },
  { permissions: ["p", "q"] },
  { permissions: {} },
  { permissions: { defaultMode: "plan" } },
  { 2: "two", permissions: { 1: "one", deny: ["a"] }, a: 1 },
  { permissions: { deny: ["a"], 3: "three" } },
];

const envDenied = deniedSettings.map((settings) => ({
  settings,
  with: caught(() => setup.withEnvDenied(settings, RULE)),
  without: caught(() => setup.withoutEnvDenied(settings, RULE)),
}));

const statusValues = [
  absent,
  { value: null },
  { value: false },
  { value: 0 },
  { value: "" },
  { value: "text" },
  { value: 7 },
  { value: true },
  { value: [] },
  { value: [1, 2] },
  { value: {} },
  { value: { type: "command" } },
  { value: { type: "command", command: "mine" } },
  { value: { type: "static" } },
  { value: { command: null, type: "x" } },
  { value: { command: 5 } },
  { value: { command: { a: 1 } } },
  { value: { command: ["a", "b"] } },
  { value: { command: OURS } },
  { value: { command: OURS_AFTER } },
  { value: { type: "command", command: `${OURS} ` } },
  { value: { command: "x".repeat(60) } },
  { value: { command: "x".repeat(61) } },
  { value: { command: `${"x".repeat(58)}😀z` } },
  { value: { command: `${"x".repeat(59)}😀` } },
  { value: { command: `${"é".repeat(70)}` } },
  { value: { command: "", type: "fallback" } },
];

const statuslines = statusValues.map((entry) => {
  const statusLine = unwrap(entry);

  return {
    statusLine: deepPlaceholders(entry, NO_ROOT),
    preview: JSON.stringify(entry).includes(REPO_ROOT)
      ? null
      : setup.statuslinePreview(statusLine),
    ours: setup.isOurStatusline(statusLine),
    kind: setup.statuslineKind(statusLine),
    withStatusline: deepPlaceholders(
      setup.withStatusline(
        statusLine === undefined
          ? { theme: "dark" }
          : { theme: "dark", statusLine },
        "node x",
      ),
      NO_ROOT,
    ),
  };
});

const settingValues = [
  absent,
  { value: null },
  { value: 0 },
  { value: 3 },
  { value: 1.5 },
  { value: -2 },
  { value: 1e21 },
  { value: 0.000001 },
  { value: "4" },
  { value: "" },
  { value: true },
  { value: false },
  { value: [] },
  { value: [1, null, "a"] },
  { value: {} },
  { value: { start: "22:00", end: "07:00" } },
  { value: { start: "22:00" } },
  { value: { start: "", end: "07:00" } },
  { value: { start: 0, end: 7 } },
  { value: { start: 22, end: [7] } },
  { value: { model: "base" } },
  { value: { model: null } },
  { value: { model: "" } },
  { value: "pt-br" },
];
const settingKeys = [
  "language",
  "delayMinutes",
  "quietHours",
  "transcription",
  "inboxRetentionDays",
  "other",
];
const settingTexts = settingKeys.flatMap((key) =>
  settingValues
    .filter(
      (entry) =>
        key !== "transcription" ||
        entry.absent ||
        entry.value === null ||
        entry.value?.model === undefined ||
        typeof entry.value?.model === "string",
    )
    .map((entry) => ({
      key,
      value: entry,
      en: setup.settingText(key, unwrap(entry), MESSAGES["en-us"]),
      pt: setup.settingText(key, unwrap(entry), MESSAGES["pt-br"]),
    })),
);

const parsedTexts = [
  null,
  "",
  "{",
  "null",
  "5",
  "[1]",
  '"x"',
  '{"a":1}',
  '{"a":"\\ud83d"}',
  " {} ",
];
const parsed = parsedTexts.map((text) => ({
  text,
  out: setup.parsedJson(text ?? undefined),
}));

const rcCases = [
  { shell: "/bin/zsh", platform: "linux", files: [] },
  { shell: "/usr/bin/bash", platform: "linux", files: [] },
  { shell: "/bin/bash", platform: "darwin", files: [".bash_profile"] },
  { shell: "/bin/bash", platform: "darwin", files: [] },
  { shell: "/bin/zsh", platform: "linux", files: [".zshrc", ".bashrc"] },
  { shell: "", platform: "linux", files: [] },
  { shell: null, platform: "linux", files: [".zshrc"] },
  { shell: "/usr/bin/fish", platform: "linux", files: [".bashrc"] },
  { shell: "/usr/bin/fish", platform: "linux", files: [] },
  { shell: "zsh", platform: "darwin", files: [".bash_profile", ".bashrc"] },
  { shell: "/bin/bash", platform: "linux", files: [".bash_profile", ".zshrc"] },
  { shell: "/opt/bash/", platform: "linux", files: [] },
];
const rcFiles = rcCases.map((entry) =>
  withRoot((root) => {
    const home = join(root, "home");

    mkdirSync(home);

    for (const name of entry.files) writeFileSync(join(home, name), "");

    return {
      ...entry,
      out: deepPlaceholders(
        setup.shellRcFiles({
          home,
          shell: entry.shell ?? undefined,
          platform: entry.platform,
        }),
        root,
      ),
    };
  }),
);

const operations = [];

function operation(name, op, options = {}) {
  operations.push({
    name,
    op,
    args: deepPlaceholders(options.args ?? {}, NO_ROOT),
    files: deepPlaceholders(options.files ?? {}, NO_ROOT),
    links: options.links ?? {},
    env: { ...BASE_ENV, ...options.env },
    locale: options.locale ?? "en-us",
    colorize: options.colorize ?? false,
  });
}

const OUR_LINE = { type: "command", command: OURS };
const OUR_AFTER_LINE = { type: "command", command: OURS_AFTER };
const THEIRS = { type: "command", command: "mine", padding: 1 };
const RULE_IN_HOME = setup.envDenyRule(
  join("{root}", "state", ".env"),
  join("{root}", "home"),
);

for (const [label, text] of [
  ["missing", null],
  ["empty object", pretty({})],
  ["theme", pretty({ theme: "dark" })],
  ["falsy status line", pretty({ statusLine: false, theme: "dark" })],
  ["null status line", pretty({ theme: "dark", statusLine: null })],
  ["ours", pretty({ theme: "dark", statusLine: OUR_LINE })],
  ["ours after", pretty({ statusLine: OUR_AFTER_LINE, theme: "dark" })],
  ["theirs", pretty({ statusLine: THEIRS, theme: "dark" })],
  ["theirs compact", json({ statusLine: THEIRS, theme: "dark" })],
  ["theme compact", json({ theme: "dark" })],
  ["integer keys", pretty({ 1: "one", theme: "dark" })],
  ["invalid", "{ broken"],
  ["array", "[]"],
  ["null", "null"],
  ["text", '"text"'],
  [
    "four spaces with escapes",
    '{\n    "theme": "dark",\n    "path": "a\\/b \\u00e9",\n    "n": 1.0\n}\n',
  ],
]) {
  for (const choice of ["on", "after", "replace", "custom", "off", "keep"]) {
    const files = text === null ? { "claude/": {} } : { [SETTINGS]: text };

    operation(`statusline ${choice} with ${label}`, "applyStatusline", {
      args: { choice },
      files,
    });
  }
}

operation("statusline off restores the previous one", "applyStatusline", {
  args: { choice: "off" },
  files: {
    [SETTINGS]: pretty({ statusLine: OUR_AFTER_LINE, theme: "dark" }),
    [PREVIOUS]: json(THEIRS),
  },
});
operation("statusline off with a falsy previous one", "applyStatusline", {
  args: { choice: "off" },
  files: {
    [SETTINGS]: pretty({ statusLine: OUR_AFTER_LINE, theme: "dark" }),
    [PREVIOUS]: "0",
  },
});
operation("statusline off with a broken previous one", "applyStatusline", {
  args: { choice: "off" },
  files: {
    [SETTINGS]: pretty({ theme: "dark", statusLine: OUR_LINE }),
    [PREVIOUS]: "{",
  },
});
operation("statusline off restores a nested previous one", "applyStatusline", {
  args: { choice: "off" },
  files: {
    [SETTINGS]: pretty({ statusLine: OUR_LINE, theme: "dark", z: [1] }),
    [PREVIOUS]: json({
      type: "command",
      command: 'say "hi"\u007f\t',
      list: [[], {}, [1, [null]], { a: [true] }],
      3: "three",
    }),
  },
});
operation(
  "statusline off with a folder as the previous copy",
  "applyStatusline",
  {
    args: { choice: "off" },
    files: {
      [SETTINGS]: pretty({ statusLine: OUR_AFTER_LINE }),
      [`${PREVIOUS}/`]: {},
    },
  },
);
operation("statusline after keeps the customized mark out", "applyStatusline", {
  args: { choice: "after" },
  files: {
    [SETTINGS]: pretty({ statusLine: THEIRS }),
    [CONFIG]: pretty({ language: "en-us", statuslineCustomized: true }),
    [REQUEST]: json({ requestedAt: "x" }),
  },
});
operation(
  "statusline keep says the customized one is kept",
  "applyStatusline",
  {
    args: { choice: "keep" },
    files: {
      [SETTINGS]: pretty({ statusLine: THEIRS }),
      [CONFIG]: pretty({ statuslineCustomized: true }),
    },
  },
);
operation(
  "statusline keep with a customized mark that is not true",
  "applyStatusline",
  {
    args: { choice: "keep" },
    files: {
      [SETTINGS]: pretty({ statusLine: THEIRS }),
      [CONFIG]: pretty({ statuslineCustomized: "yes" }),
    },
  },
);
operation("statusline on forgets a customized mark", "applyStatusline", {
  args: { choice: "on" },
  files: {
    [SETTINGS]: pretty({ theme: "dark" }),
    [CONFIG]: pretty({ statuslineCustomized: false, delayMinutes: 3 }),
  },
});
operation("statusline custom with an app folder to create", "applyStatusline", {
  args: { choice: "custom" },
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/deep/app" },
  files: { [SETTINGS]: pretty({ statusLine: THEIRS }) },
});
operation("statusline replace in pt-br with colors", "applyStatusline", {
  args: { choice: "replace" },
  locale: "pt-br",
  colorize: true,
  files: { [SETTINGS]: pretty({ statusLine: THEIRS }) },
});
operation(
  "statusline replace keeps a private backup of a public file",
  "applyStatusline",
  {
    args: { choice: "replace" },
    files: {
      [SETTINGS]: { content: pretty({ statusLine: THEIRS }), mode: 0o644 },
    },
  },
);
operation("statusline on keeps a private mode", "applyStatusline", {
  args: { choice: "on" },
  files: { [SETTINGS]: { content: pretty({ theme: "dark" }), mode: 0o640 } },
});
operation("statusline on writes through a symlink", "applyStatusline", {
  args: { choice: "on" },
  files: { "dotfiles/settings.json": pretty({ theme: "dark" }), "claude/": {} },
  links: { [SETTINGS]: "../dotfiles/settings.json" },
});
operation("statusline on replaces a dangling symlink", "applyStatusline", {
  args: { choice: "on" },
  files: { "claude/": {} },
  links: { [SETTINGS]: "../dotfiles/missing.json" },
});
operation("statusline on without the claude folder", "applyStatusline", {
  args: { choice: "on" },
  files: {},
});
operation("statusline on with the claude dir unset", "applyStatusline", {
  args: { choice: "on" },
  env: { CLAUDE_CONFIG_DIR: null },
  files: { "home/.claude/settings.json": pretty({ theme: "dark" }) },
});
operation("statusline on in a CRLF file", "applyStatusline", {
  args: { choice: "on" },
  files: { [SETTINGS]: '{\r\n  "theme": "dark"\r\n}\r\n' },
});
operation("statusline on with comments", "applyStatusline", {
  args: { choice: "on" },
  files: { [SETTINGS]: '{\n  // mine\n  "theme": "dark",\n}\n' },
});

for (const [label, text] of [
  ["missing", null],
  ["empty object", pretty({})],
  [
    "other rules",
    pretty({ theme: "dark", permissions: { allow: ["a"], deny: ["b"] } }),
  ],
  ["already denied", pretty({ permissions: { deny: [RULE_IN_HOME] } })],
  ["empty deny", pretty({ permissions: { deny: [] } })],
  ["deny as text", pretty({ permissions: { deny: 5 } })],
  ["permissions as text", pretty({ permissions: "ab", theme: "dark" })],
  ["compact", json({ permissions: { deny: ["b"] } })],
]) {
  operation(`env deny with ${label}`, "ensureEnvDenied", {
    files: text === null ? { "claude/": {} } : { [SETTINGS]: text },
  });
}

operation("env deny outside the home", "ensureEnvDenied", {
  env: { TELEGRAM_STATE_DIR: "/srv/telegram" },
  files: { [SETTINGS]: pretty({}) },
});
operation("env deny in pt-br with colors", "ensureEnvDenied", {
  locale: "pt-br",
  colorize: true,
  files: { [SETTINGS]: pretty({ permissions: { deny: [RULE_IN_HOME] } }) },
});

const BLOCK = `# Added by better-claude-code-telegram setup\n[ -f "${SHELL_FILE}" ] && . "${SHELL_FILE}"\n`;

for (const [label, shellPath, platform, files] of [
  ["zsh creates the rc", "/bin/zsh", "linux", {}],
  ["bash creates the bashrc", "/bin/bash", "linux", {}],
  [
    "bash on macOS with a profile",
    "/bin/bash",
    "darwin",
    { "home/.bash_profile": "x\n" },
  ],
  [
    "zsh with both files",
    "/bin/zsh",
    "linux",
    { "home/.zshrc": "a", "home/.bashrc": "b\n" },
  ],
  ["already loaded", "/bin/zsh", "linux", { "home/.zshrc": `x\n${BLOCK}` }],
  ["fish", "/usr/bin/fish", "linux", { "home/.bashrc": "b\n" }],
  ["fish alone", "/usr/bin/fish", "linux", { "home/": {} }],
  ["no shell", null, "linux", { "home/.zshrc": "" }],
  [
    "a public rc",
    "/bin/bash",
    "linux",
    { "home/.bashrc": { content: "x\n", mode: 0o644 } },
  ],
  ["an rc that is a folder", "/bin/bash", "linux", { "home/.bashrc/": {} }],
]) {
  operation(`shell function: ${label}`, "installShellFunction", {
    args: { shell: shellPath, platform },
    files: { "home/": {}, ...files },
  });
}

operation("shell function in pt-br with colors", "installShellFunction", {
  args: { shell: "/usr/bin/fish", platform: "linux" },
  locale: "pt-br",
  colorize: true,
  files: { "home/.bashrc": `x\n${BLOCK}`, "home/.zshrc": "z\n" },
});
operation("shell function for another shell file", "installShellFunction", {
  args: { shell: "/bin/zsh", platform: "linux", shellFile: "/repo/shell.sh" },
  files: { "home/.zshrc": `x\n${BLOCK}` },
});
operation("shell function through a symlinked rc", "installShellFunction", {
  args: { shell: "/bin/zsh", platform: "linux" },
  files: { "dotfiles/zshrc": "a\n", "home/": {} },
  links: { "home/.zshrc": "../dotfiles/zshrc" },
});

for (const [label, shellPath, files] of [
  [
    "zsh without the line",
    "/bin/zsh",
    { "home/.zshrc": "a\n", "home/.bashrc": `x\n${BLOCK}` },
  ],
  [
    "bash with both loaded",
    "/bin/bash",
    { "home/.zshrc": BLOCK, "home/.bashrc": BLOCK },
  ],
  ["fish", "/usr/bin/fish", { "home/.zshrc": "z\n" }],
  ["no shell and no files", null, { "home/": {} }],
]) {
  operation(`rc files without the line: ${label}`, "rcFilesWithoutShellLine", {
    env: shellPath === null ? {} : { SHELL: shellPath },
    files,
  });
}

for (const [label, files] of [
  [
    "all three",
    {
      "home/.bashrc": `alias x=y\n\n${BLOCK}`,
      "home/.zshrc": BLOCK,
      "home/.bash_profile": `p\n${BLOCK}`,
    },
  ],
  ["none", { "home/.bashrc": "alias x=y\n" }],
  ["missing home", {}],
  ["a folder rc", { "home/.zshrc/": {}, "home/.bashrc": BLOCK }],
]) {
  operation(`remove shell lines: ${label}`, "removeShellLines", { files });
}

for (const [label, files, extra] of [
  [
    "ours and the rule",
    {
      [SETTINGS]: pretty({
        theme: "dark",
        statusLine: OUR_LINE,
        permissions: { deny: ["Bash(rm -rf *)", RULE_IN_HOME] },
      }),
    },
  ],
  [
    "only the rule",
    {
      [SETTINGS]: pretty({
        permissions: { deny: [RULE_IN_HOME] },
        theme: "dark",
      }),
    },
  ],
  [
    "the rule beside other permissions",
    {
      [SETTINGS]: pretty({
        permissions: { deny: [RULE_IN_HOME], allow: ["x"] },
        z: 1,
      }),
    },
  ],
  [
    "previous restored",
    {
      [SETTINGS]: pretty({ statusLine: OUR_AFTER_LINE, theme: "dark" }),
      [PREVIOUS]: json(THEIRS),
    },
  ],
  [
    "theirs kept",
    { [SETTINGS]: json({ statusLine: { type: "command", command: "mine" } }) },
  ],
  ["nothing", { [SETTINGS]: pretty({ theme: "dark" }) }],
  ["missing settings", { "claude/": {} }],
  [
    "deny as text",
    { [SETTINGS]: pretty({ permissions: { deny: `x ${RULE_IN_HOME}` } }) },
  ],
  ["deny as number", { [SETTINGS]: pretty({ permissions: { deny: 5 } }) }],
  ["invalid settings", { [SETTINGS]: "{ broken" }],
  [
    "with colors in pt-br",
    {
      [SETTINGS]: pretty({
        statusLine: OUR_LINE,
        permissions: { deny: [RULE_IN_HOME] },
      }),
    },
    { locale: "pt-br", colorize: true },
  ],
  [
    "commented settings",
    {
      [SETTINGS]: `{\n  // keep me\n  "statusLine": ${json(OUR_LINE)},\n  "permissions": { "deny": [${json(RULE_IN_HOME)}] },\n}\n`,
    },
  ],
]) {
  operation(`remove our settings: ${label}`, "removeOurSettings", {
    files,
    ...extra,
  });
}

for (const [label, patch, files] of [
  ["new config", { language: "pt-br" }, {}],
  [
    "keeps the rest",
    { delayMinutes: 3 },
    { [CONFIG]: json({ language: "pt-br", quietHours: null }) },
  ],
  ["broken config", { delayMinutes: 3 }, { [CONFIG]: "{" }],
  ["array config", { delayMinutes: 3 }, { [CONFIG]: "[1]" }],
  [
    "public config",
    { inboxRetentionDays: null },
    { [CONFIG]: { content: "{}", mode: 0o644 } },
  ],
  ["integer keys", { 2: "b", z: 1 }, { [CONFIG]: json({ 10: "a", y: 0 }) }],
  [
    "nested folder",
    { language: "en-us" },
    {},
    { BETTER_CC_TELEGRAM_DIR: "{root}/a/b/app" },
  ],
]) {
  operation(`update config: ${label}`, "updateConfig", {
    args: { patch },
    files,
  });
}

operation("update config in a folder to create", "updateConfig", {
  args: { patch: { language: "en-us" } },
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/a/b/app" },
});
operation("update config under a file", "updateConfig", {
  args: { patch: { language: "en-us" } },
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/plain/app" },
  files: { plain: "x" },
});

for (const [label, days, files, extra] of [
  ["seven days", 7, {}],
  ["forever", null, { [CONFIG]: json({ inboxRetentionDays: 7 }) }],
  ["pt-br with colors", 30, {}, { locale: "pt-br", colorize: true }],
  ["one day", 1, { [CONFIG]: json({ language: "pt-br" }) }],
]) {
  operation(`save inbox: ${label}`, "saveInboxDays", {
    args: { days },
    files,
    ...extra,
  });
}

for (const [label, config] of [
  ["missing", null],
  ["null", { inboxRetentionDays: null }],
  ["three", { inboxRetentionDays: 3 }],
  ["fraction", { inboxRetentionDays: 2.5 }],
  ["zero", { inboxRetentionDays: 0 }],
  ["negative", { inboxRetentionDays: -1 }],
  ["text", { inboxRetentionDays: "3" }],
  ["unset", {}],
]) {
  operation(`inbox days: ${label}`, "currentInboxDays", {
    files: config === null ? {} : { [CONFIG]: json(config) },
  });
}

for (const [label, current, files] of [
  ["theirs", THEIRS, {}],
  ["none", null, {}],
  ["ours", OUR_LINE, {}],
  ["ours after in pt-br", OUR_AFTER_LINE, {}],
]) {
  operation(`request custom: ${label}`, "requestStatuslineCustom", {
    args: { current },
    files,
    locale: label.endsWith("pt-br") ? "pt-br" : "en-us",
  });
}

for (const [label, files] of [
  ["present", { [REQUEST]: "{}" }],
  ["missing", {}],
  ["a folder", { [`${REQUEST}/`]: {} }],
]) {
  operation(`forget request: ${label}`, "forgetStatuslineRequest", { files });
}

for (const [label, files] of [
  [
    "true",
    { [CONFIG]: pretty({ statuslineCustomized: true, language: "pt-br" }) },
  ],
  ["null", { [CONFIG]: json({ statuslineCustomized: null }) }],
  ["missing", { [CONFIG]: json({ language: "pt-br" }) }],
  ["no config", {}],
]) {
  operation(`forget customized: ${label}`, "forgetStatuslineCustomized", {
    files,
  });
}

for (const [label, statusLine, extra] of [
  ["object", THEIRS],
  ["text", "x"],
  ["nested", { a: [1, { b: null }] }],
  ["deep folder", THEIRS, { env: { BETTER_CC_TELEGRAM_DIR: "{root}/x/y" } }],
]) {
  operation(`save previous: ${label}`, "savePreviousStatusline", {
    args: { statusLine },
    ...extra,
  });
}

for (const [label, data, files, links] of [
  ["new file", { theme: "dark" }, { "claude/": {} }],
  [
    "symlink",
    { theme: "dark" },
    { "dotfiles-settings.json": "{}", "claude/": {} },
    { [SETTINGS]: "../dotfiles-settings.json" },
  ],
  ["mode kept", { a: [1, 2] }, { [SETTINGS]: { content: "{}", mode: 0o640 } }],
  ["missing folder", { a: 1 }, {}],
  ["folder in the way", { a: 1 }, { [`${SETTINGS}/`]: {} }],
]) {
  operation(`write json: ${label}`, "writeJsonAtomic", {
    args: { data },
    files,
    links: links ?? {},
  });
}

const DOTFILE_CONFIG = "dotfiles/better-cc-telegram.json";
const DOTFILE_PREVIOUS = "dotfiles/statusline-previous.json";
const DOTFILE_REQUEST = "dotfiles/statusline-customize.json";

operation("update config through a symlink", "updateConfig", {
  args: { patch: { delayMinutes: 3 } },
  files: { [DOTFILE_CONFIG]: json({ language: "pt-br" }), "app/": {} },
  links: { [CONFIG]: "../dotfiles/better-cc-telegram.json" },
});
operation("save inbox through a symlink", "saveInboxDays", {
  args: { days: 3 },
  files: { [DOTFILE_CONFIG]: json({ language: "pt-br" }), "app/": {} },
  links: { [CONFIG]: "../dotfiles/better-cc-telegram.json" },
});
operation("forget customized through a symlink", "forgetStatuslineCustomized", {
  files: {
    [DOTFILE_CONFIG]: pretty({ statuslineCustomized: true, language: "pt-br" }),
    "app/": {},
  },
  links: { [CONFIG]: "../dotfiles/better-cc-telegram.json" },
});
operation("save previous through a symlink", "savePreviousStatusline", {
  args: { statusLine: THEIRS },
  files: { [DOTFILE_PREVIOUS]: json({ command: "old" }), "app/": {} },
  links: { [PREVIOUS]: "../dotfiles/statusline-previous.json" },
});
operation("request custom through a symlink", "requestStatuslineCustom", {
  args: { current: THEIRS },
  files: { [DOTFILE_REQUEST]: json({ requestedAt: "old" }), "app/": {} },
  links: { [REQUEST]: "../dotfiles/statusline-customize.json" },
});
operation("forget request through a symlink", "forgetStatuslineRequest", {
  files: { [DOTFILE_REQUEST]: json({ requestedAt: "old" }), "app/": {} },
  links: { [REQUEST]: "../dotfiles/statusline-customize.json" },
});
operation("statusline after through a symlinked previous", "applyStatusline", {
  args: { choice: "after" },
  files: {
    [SETTINGS]: pretty({ statusLine: THEIRS }),
    [DOTFILE_PREVIOUS]: json({ command: "old" }),
    "app/": {},
  },
  links: { [PREVIOUS]: "../dotfiles/statusline-previous.json" },
});
operation("update config through a dangling symlink", "updateConfig", {
  args: { patch: { delayMinutes: 3 } },
  files: { "dotfiles/": {}, "app/": {} },
  links: { [CONFIG]: "../dotfiles/better-cc-telegram.json" },
});
operation("save inbox through a dangling symlink", "saveInboxDays", {
  args: { days: 3 },
  files: { "dotfiles/": {}, "app/": {} },
  links: { [CONFIG]: "../dotfiles/better-cc-telegram.json" },
});
operation(
  "save previous through a dangling symlink",
  "savePreviousStatusline",
  {
    args: { statusLine: THEIRS },
    files: { "dotfiles/": {}, "app/": {} },
    links: { [PREVIOUS]: "../dotfiles/statusline-previous.json" },
  },
);
operation(
  "request custom through a dangling symlink",
  "requestStatuslineCustom",
  {
    args: { current: THEIRS },
    files: { "dotfiles/": {}, "app/": {} },
    links: { [REQUEST]: "../dotfiles/statusline-customize.json" },
  },
);

const journalScripts = [];

function journalScript(name, steps, options = {}) {
  journalScripts.push({
    name,
    steps: deepPlaceholders(steps, NO_ROOT),
    files: deepPlaceholders(options.files ?? {}, NO_ROOT),
    links: options.links ?? {},
    env: { ...BASE_ENV, ...options.env },
    colorize: options.colorize ?? false,
    locale: options.locale ?? "en-us",
  });
}

journalScript(
  "changed and created files",
  [
    { chmod: "w/settings.json", mode: 0o640 },
    { trackFile: "w/settings.json" },
    { write: "w/settings.json", content: "after" },
    { chmod: "w/settings.json", mode: 0o600 },
    { trackFile: "w/.env" },
    { write: "w/.env", content: "token" },
  ],
  { files: { "w/settings.json": "before" } },
);
journalScript(
  "first state of a file written many times",
  [
    { trackFile: "w/config.json" },
    { write: "w/config.json", content: "second" },
    { trackFile: "w/config.json" },
    { write: "w/config.json", content: "third" },
  ],
  { files: { "w/config.json": "first" } },
);
journalScript(
  "folders only when created",
  [
    { trackDir: "w/existing" },
    { trackDir: "w/created" },
    { mkdir: "w/created" },
    { write: "w/created/file", content: "x" },
    { trackDir: "w/created/inner" },
  ],
  { files: { "w/existing/": {} } },
);
journalScript(
  "parent folders created along",
  [
    { trackDir: "w/home/.claude/app" },
    { mkdir: "w/home/.claude/app" },
    { trackDir: "w/home/.claude/other" },
  ],
  { files: { "w/": {} } },
);
journalScript(
  "originals",
  [
    { trackFile: "w/config.json" },
    { write: "w/config.json", content: '{"a":2}' },
    { trackFile: "w/new.json" },
    { original: "w/config.json" },
    { original: "w/new.json" },
    { original: "w/never.json" },
  ],
  { files: { "w/config.json": '{"a":1}' } },
);
journalScript("records in reverse with failures", [
  { record: "pluginInstalled", target: "a", undo: "ok" },
  { record: "pluginInstalled", target: "b", undo: "fail" },
  { record: "toolInstalled", target: "bun", undo: null },
  { record: "marketplaceAdded", target: "m", undo: "ok" },
  { record: "pluginRemoved", target: "c", undo: "ok" },
]);
journalScript(
  "a symlinked file is tracked by its target",
  [
    { trackFile: "w/link.json" },
    { write: "w/real.json", content: "{}" },
    { trackFile: "w/real.json" },
  ],
  {
    files: { "w/real.json": '{"theme":"dark"}' },
    links: { "w/link.json": "real.json" },
  },
);
journalScript(
  "a file deleted before undo is written back",
  [{ trackFile: "w/a.json" }, { remove: "w/a.json" }],
  { files: { "w/a.json": "x" } },
);
journalScript(
  "a created file that became a folder cannot be undone",
  [{ trackFile: "w/a" }, { mkdir: "w/a" }],
  { files: { "w/": {} } },
);
journalScript(
  "a created folder that is already gone",
  [{ trackDir: "w/gone" }],
  { files: { "w/": {} } },
);
journalScript(
  "options changed in the config and in settings.json",
  [
    { trackFile: CONFIG },
    { trackFile: SETTINGS },
    {
      write: CONFIG,
      content: json({
        delayMinutes: 4,
        quietHours: { start: "22:00", end: "07:00" },
        transcription: null,
      }),
    },
    {
      write: SETTINGS,
      content: json({
        theme: "dark",
        statusLine: OUR_LINE,
        permissions: {
          deny: [setup.envDenyRule(ENV_RULE_FILE, "{root}/home")],
        },
        enabledPlugins: {
          "telegram@better-claude-code-telegram": false,
          "telegram-hooks@better-claude-code-telegram": true,
        },
      }),
    },
  ],
  {
    files: {
      [CONFIG]: json({ delayMinutes: 3 }),
      [SETTINGS]: json({
        theme: "dark",
        enabledPlugins: { "telegram@better-claude-code-telegram": true },
      }),
    },
  },
);
journalScript(
  "each option painted",
  [
    { trackFile: CONFIG },
    { write: CONFIG, content: json({ language: "pt-br" }) },
  ],
  { colorize: true, files: { "app/": {} } },
);
journalScript(
  "each option painted in pt-br",
  [
    { trackFile: CONFIG },
    {
      write: CONFIG,
      content: json({
        language: "pt-br",
        inboxRetentionDays: null,
        delayMinutes: 1.5,
      }),
    },
    { trackFile: SETTINGS },
    { write: SETTINGS, content: json({ statusLine: { command: "mine" } }) },
  ],
  {
    colorize: true,
    locale: "pt-br",
    files: {
      [CONFIG]: json({
        inboxRetentionDays: 7,
        transcription: { model: "base" },
      }),
      "claude/": {},
    },
  },
);
journalScript(
  "settings kinds and rules",
  [
    { trackFile: SETTINGS },
    {
      write: SETTINGS,
      content: json({
        statusLine: { command: OURS_AFTER },
        permissions: {
          deny: `x ${setup.envDenyRule(ENV_RULE_FILE, "{root}/home")}`,
        },
        enabledPlugins: "ab",
      }),
    },
  ],
  {
    files: {
      [SETTINGS]: json({
        statusLine: { command: "other" },
        enabledPlugins: { b: 0, a: "", 2: true, 1: null },
      }),
    },
  },
);
journalScript(
  "enabled plugins compared like the js",
  [
    { trackFile: SETTINGS },
    {
      write: SETTINGS,
      content: json({
        enabledPlugins: { n: 1, m: 3, o: {}, s: "x", t: true, u: false, l: [] },
      }),
    },
  ],
  {
    files: {
      [SETTINGS]: json({
        enabledPlugins: { n: 1, m: 2, o: {}, s: "x", t: true, l: [], z: null },
      }),
    },
  },
);
journalScript(
  "enabled plugins that only change how a number is written",
  [
    { trackFile: SETTINGS },
    { write: SETTINGS, content: '{"enabledPlugins":{"n":1.0,"m":2.5e0}}' },
  ],
  { files: { [SETTINGS]: '{"enabledPlugins":{"n":1,"m":2.5}}' } },
);
journalScript(
  "enabled plugins of odd shapes",
  [
    { trackFile: SETTINGS },
    { write: SETTINGS, content: json({ enabledPlugins: [true, false] }) },
  ],
  { files: { [SETTINGS]: json({ enabledPlugins: 5 }) } },
);
journalScript(
  "enabled plugins with a lone surrogate",
  [
    { trackFile: SETTINGS },
    { write: SETTINGS, content: json({ enabledPlugins: "a😀" }) },
  ],
  { files: { [SETTINGS]: json({ enabledPlugins: "😀" }) } },
);
journalScript(
  "a deny list that is not a list",
  [
    { trackFile: SETTINGS },
    { write: SETTINGS, content: json({ permissions: { deny: 5 } }) },
  ],
  { files: { [SETTINGS]: json({}) } },
);
journalScript(
  "config and settings that are not objects",
  [
    { trackFile: CONFIG },
    { trackFile: SETTINGS },
    { write: CONFIG, content: "[1]" },
    { write: SETTINGS, content: "null" },
  ],
  { files: { [CONFIG]: "5", [SETTINGS]: '"x"' } },
);
journalScript(
  "a config whose file is gone and another file name",
  [
    { trackFile: CONFIG },
    { trackFile: "app/other.json" },
    { write: "app/other.json", content: "{}" },
    { remove: CONFIG },
  ],
  { files: { [CONFIG]: json({ language: "pt-br" }) } },
);

function runJournalScript(entry) {
  return withRoot((root) => {
    materialize(root, entry.files);
    makeLinks(root, entry.links);

    const env = resolveEnv(entry.env, root);
    const journal = createJournal();
    const originals = [];
    const order = [];
    const path = (relative) => join(root, relative);

    for (const step of entry.steps) {
      if (step.trackFile) journal.trackFile(path(step.trackFile));
      if (step.trackDir) journal.trackDir(path(step.trackDir));
      if (step.write)
        writeFileSync(path(step.write), substitute(step.content, root));
      if (step.mkdir) mkdirSync(path(step.mkdir), { recursive: true });
      if (step.chmod) chmodSync(path(step.chmod), step.mode);
      if (step.remove) rmSync(path(step.remove), { recursive: true });
      if (step.original) {
        const original = journal.original(path(step.original));

        originals.push(original === undefined ? absent : { value: original });
      }
      if (step.record) {
        journal.record(
          step.record,
          step.target,
          step.undo === null
            ? null
            : () => {
                order.push(step.target);
                if (step.undo === "fail") throw new Error("boom");
              },
        );
      }
    }

    return withProcessEnv(
      { ...env, ...(entry.colorize ? { FORCE_COLOR: "1" } : {}) },
      () => {
        const messages = MESSAGES[entry.locale];
        const changes = journal.changes();
        const described = caught(() =>
          setup.describeChanges(
            changes,
            messages,
            journal,
            env.TELEGRAM_STATE_DIR,
          ),
        );
        const events = [];
        const left = journal.undoAll({
          onStart: ({ target }) =>
            events.push(`start ${placeholders(target, root)}`),
          onDone: ({ target }, ok) =>
            events.push(`done ${placeholders(target, root)} ${ok}`),
        });
        const leftDescribed = caught(() =>
          setup.describeChanges(
            left,
            messages,
            journal,
            env.TELEGRAM_STATE_DIR,
          ),
        );

        return {
          ...entry,
          changes: deepPlaceholders(changes, root),
          originals: deepPlaceholders(originals, root),
          described: deepPlaceholders(described, root),
          events,
          order,
          left: deepPlaceholders(left, root),
          leftDescribed: deepPlaceholders(leftDescribed, root),
          afterUndo: snapshot(root),
        };
      },
    );
  });
}

function makeLinks(root, links) {
  for (const [link, target] of Object.entries(links)) {
    mkdirSync(join(root, link, ".."), { recursive: true });
    symlinkSync(target, join(root, link));
  }
}

function runOperation(entry) {
  return withRoot((root) => {
    materialize(root, entry.files);
    makeLinks(root, entry.links);

    const env = resolveEnv(entry.env, root);
    const args = deepSubstitute(entry.args, root);
    const messages = MESSAGES[entry.locale];
    const appDir = env.BETTER_CC_TELEGRAM_DIR;
    const stateDir = env.TELEGRAM_STATE_DIR;
    const home = env.HOME;
    const run = {
      applyStatusline: () =>
        setup.applyStatusline(appDir, args.choice, messages),
      ensureEnvDenied: () => setup.ensureEnvDenied(stateDir, messages),
      installShellFunction: () =>
        setup.installShellFunction(
          { home, shell: args.shell ?? undefined, platform: args.platform },
          messages,
          args.shellFile ?? SHELL_FILE,
        ),
      rcFilesWithoutShellLine: () =>
        setup.rcFilesWithoutShellLine(args.shellFile ?? SHELL_FILE),
      removeShellLines: () =>
        setup.removeShellLines(home, args.shellFile ?? SHELL_FILE, messages),
      removeOurSettings: () => {
        const settingsFile = setup.claudeSettingsFile();

        setup.removeOurSettings(
          setup.readSettings(settingsFile, messages),
          { stateDir, appDir, home, settingsFile },
          messages,
        );
      },
      updateConfig: () => setup.updateConfig(appDir, args.patch),
      saveInboxDays: () => setup.saveInboxDays(appDir, args.days, messages),
      currentInboxDays: () => setup.currentInboxDays(appDir),
      requestStatuslineCustom: () =>
        setup.requestStatuslineCustom(appDir, args.current, messages),
      forgetStatuslineRequest: () => setup.forgetStatuslineRequest(appDir),
      forgetStatuslineCustomized: () =>
        setup.forgetStatuslineCustomized(appDir),
      savePreviousStatusline: () =>
        setup.savePreviousStatusline(appDir, args.statusLine),
      writeJsonAtomic: () =>
        setup.writeJsonAtomic(setup.claudeSettingsFile(), args.data),
    }[entry.op];

    return withProcessEnv(
      { ...env, ...(entry.colorize ? { FORCE_COLOR: "1" } : {}) },
      () => {
        const counted = setup.journal.changes().length;
        const result = capture(run);
        const changes = setup.journal.changes().slice(counted);
        const described = caught(() =>
          setup.describeChanges(changes, messages, setup.journal, stateDir),
        );
        const after = snapshot(root);
        const left = setup.journal.undoAll();

        return {
          ...entry,
          result: deepPlaceholders(result, root),
          changes: deepPlaceholders(changes, root),
          described: deepPlaceholders(described, root),
          after,
          left: deepPlaceholders(left, root),
          afterUndo: snapshot(root),
        };
      },
    );
  });
}

await writeFixture("setup-files.json", {
  now: NOW,
  shell,
  denyRules,
  rule: RULE,
  envDenied,
  statuslines,
  settingTexts,
  parsed,
  rcFiles,
  operations: operations.map(runOperation),
  journals: journalScripts.map(runJournalScript),
});
