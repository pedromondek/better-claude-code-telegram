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

const STATUSLINE = join(
  REPO_ROOT,
  "plugins",
  "telegram-hooks",
  "statusline.mjs",
);
const SYSTEM_PATH = "/usr/bin:/bin";
const HEALTH = "app/health.json";
const LAUNCH = "app/launch.json";
const CONFIG = "app/better-cc-telegram.json";
const PREVIOUS = "app/statusline-previous.json";
const AFTER = ["--after-previous"];

const scenarios = [];

function add(name, options = {}) {
  const env = {
    HOME: "{root}/home",
    BETTER_CC_TELEGRAM_DIR: "{root}/app",
    BETTER_CC_TELEGRAM: "1",
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
    stdin: options.stdin ?? "",
  });
}

const json = (value) => JSON.stringify(value);
const health = (extra = {}) =>
  json({ checkedAt: NOW - 1000, polling: true, ...extra });
const launch = (launchedAt) => json({ launchedAt });
const secondary = { BETTER_CC_TELEGRAM: null };

const locales = {
  none: {},
  "en-us": { [CONFIG]: json({ language: "en-us" }) },
  "pt-br": { [CONFIG]: json({ language: "pt-br" }) },
  unknown: { [CONFIG]: json({ language: "fr" }) },
  broken: { [CONFIG]: "{" },
  array: { [CONFIG]: json(["pt-br"]) },
  number: { [CONFIG]: json({ language: 1 }) },
  padded: { [CONFIG]: json({ language: " pt-br" }) },
};
const healthStates = {
  missing: {},
  connected: { [HEALTH]: health() },
  down: { [HEALTH]: health({ polling: false }) },
};

for (const [locale, config] of Object.entries(locales)) {
  for (const role of ["main", "secondary"]) {
    for (const [state, files] of Object.entries(healthStates)) {
      add(`locale ${locale}: ${role} ${state}`, {
        env: role === "main" ? {} : secondary,
        files: { ...config, ...files },
      });
    }
  }
}

const checkedAts = {
  "inside the ttl": NOW - 14_999,
  "exactly the ttl": NOW - 15_000,
  "past the ttl": NOW - 15_001,
  now: NOW,
  future: NOW + 5000,
  "numeric string": String(NOW - 100),
  "padded string": ` ${NOW - 100}\n`,
  "hex string": "0x10",
  "empty string": "",
  "text string": "abc",
  infinity: "Infinity",
  "minus infinity": "-Infinity",
  "single item array": [NOW - 100],
  "nested single item array": [[NOW - 100]],
  "two item array": [NOW - 100, 1],
  "empty array": [],
  true: true,
  false: false,
  null: null,
  object: {},
  float: NOW - 100.5,
  negative: -1,
};

for (const [label, checkedAt] of Object.entries(checkedAts)) {
  for (const role of ["main", "secondary"]) {
    add(`checkedAt ${label}: ${role}`, {
      env: role === "main" ? {} : secondary,
      files: { [HEALTH]: json({ checkedAt, polling: true }) },
    });
  }
}

add("health without checkedAt is stale", {
  files: { [HEALTH]: json({ polling: true }) },
});

const healthTexts = {
  null: "null",
  number: "5",
  string: json("checkedAt"),
  array: json([{ checkedAt: NOW, polling: true }]),
  broken: "{",
  empty: "",
  bom: `\u{feff}${health()}`,
  "invalid utf8": { bytes: [0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d] },
  "lone surrogate key": `{"\\ud83d":1,"checkedAt":${NOW},"polling":true}`,
  duplicate: `{"checkedAt":0,"polling":true,"checkedAt":${NOW}}`,
};

for (const [label, text] of Object.entries(healthTexts)) {
  for (const role of ["main", "secondary"]) {
    add(`health ${label}: ${role}`, {
      env: role === "main" ? {} : secondary,
      files: { [HEALTH]: text },
    });
  }
}

const pollings = {
  true: true,
  false: false,
  one: 1,
  zero: 0,
  "empty string": "",
  "text string": "no",
  "empty array": [],
  "empty object": {},
  null: null,
  "zero string": "0",
};

for (const [label, polling] of Object.entries(pollings)) {
  for (const role of ["main", "secondary"]) {
    add(`polling ${label}: ${role}`, {
      env: role === "main" ? {} : secondary,
      files: { [HEALTH]: health({ polling }) },
    });
  }
}

const launchedAts = {
  "inside the grace": NOW - 59_999,
  "exactly the grace": NOW - 60_000,
  "past the grace": NOW - 60_001,
  future: NOW + 1000,
  "numeric string": String(NOW - 10),
  "text string": "soon",
  infinity: "Infinity",
  "single item array": [NOW - 10],
  null: null,
  true: true,
  object: {},
};

for (const [label, launchedAt] of Object.entries(launchedAts)) {
  add(`launchedAt ${label}: main without health`, {
    files: { [LAUNCH]: launch(launchedAt) },
  });
  add(`launchedAt ${label}: secondary with health down`, {
    env: secondary,
    files: {
      [HEALTH]: health({ polling: false }),
      [LAUNCH]: launch(launchedAt),
    },
  });
}

for (const [label, text] of Object.entries({
  broken: "{",
  array: json([{ launchedAt: NOW }]),
  null: "null",
  missing: null,
})) {
  add(`launch ${label}: main without health`, {
    files: text === null ? {} : { [LAUNCH]: text },
  });
}

add("launch: secondary without health ignores a fresh launch", {
  env: secondary,
  files: { [LAUNCH]: launch(NOW - 10) },
});
add("launch: secondary with stale health ignores a fresh launch", {
  env: secondary,
  files: {
    [HEALTH]: health({ checkedAt: NOW - 20_000 }),
    [LAUNCH]: launch(NOW - 10),
  },
});
add("launch: connected wins over a fresh launch", {
  files: { [HEALTH]: health(), [LAUNCH]: launch(NOW - 10) },
});
add("launch: pt-br connecting", {
  files: { ...locales["pt-br"], [LAUNCH]: launch(NOW - 10) },
});

for (const [label, flag] of Object.entries({
  zero: "0",
  "true word": "true",
  "padded one": " 1",
  empty: "",
  two: "2",
})) {
  add(`telegram flag ${label} counts as secondary`, {
    env: { BETTER_CC_TELEGRAM: flag },
    files: { [HEALTH]: health({ polling: false }) },
  });
}

add("folder: claude config dir when the app dir is unset", {
  env: { BETTER_CC_TELEGRAM_DIR: null, CLAUDE_CONFIG_DIR: "{root}/cfg" },
  files: { "cfg/better-claude-code-telegram/health.json": health() },
});
add("folder: an empty app dir falls back to the claude config dir", {
  env: { BETTER_CC_TELEGRAM_DIR: "", CLAUDE_CONFIG_DIR: "{root}/cfg" },
  files: { "cfg/better-claude-code-telegram/health.json": health() },
});
add("folder: the home claude folder when nothing is set", {
  env: { BETTER_CC_TELEGRAM_DIR: null },
  files: { "home/.claude/better-claude-code-telegram/health.json": health() },
});
add("folder: an empty claude config dir falls back to the home", {
  env: { BETTER_CC_TELEGRAM_DIR: null, CLAUDE_CONFIG_DIR: "" },
  files: { "home/.claude/better-claude-code-telegram/health.json": health() },
});
add("folder: the app dir is normalized like path.join", {
  env: { BETTER_CC_TELEGRAM_DIR: "{root}/x/../app/./" },
  files: { [HEALTH]: health() },
});

for (const args of [
  ["--other"],
  ["--after-previous", "x"],
  ["x", "--after-previous"],
  ["--AFTER-PREVIOUS"],
]) {
  add(`args ${json(args)}`, {
    args,
    files: { [PREVIOUS]: json({ command: "printf mine" }) },
  });
}

const previous = (command) => ({
  [PREVIOUS]: json({ type: "command", command }),
});

add("after previous: no previous file shows only ours", { args: AFTER });
add("after previous: no previous file and no segment prints nothing", {
  args: AFTER,
  env: secondary,
});

for (const [label, text] of Object.entries({
  null: "null",
  array: json(["printf x"]),
  string: json("printf x"),
  "number command": json({ command: 5 }),
  "array command": json({ command: ["printf x"] }),
  "no command": json({ type: "command" }),
  broken: "{",
})) {
  add(`after previous: ${label} previous file runs nothing`, {
    args: AFTER,
    files: { [PREVIOUS]: text },
  });
}

const commands = {
  "same input": ["cat; printf ' | mine'", '{"model":"x"}'],
  rows: ["printf 'one\\ntwo\\n'", ""],
  "exit code": ["exit 3", ""],
  "output then failure": ["printf x; printf err >&2; exit 2", ""],
  "carriage return": ["printf 'a\\r\\n'", ""],
  "only newlines": ["printf '\\n\\n\\n'", ""],
  "inner blank rows": ["printf 'a\\n\\nb\\n\\n'", ""],
  "leading newline": ["printf '\\na'", ""],
  "invalid utf8 output": ["printf '\\377ok'", ""],
  "unicode output": ["printf '😀 é │'", ""],
  "blank command": ["  ", ""],
  "ignored big input": ["printf ok", { repeat: "a", count: 300_000 }],
  "big input counted": ["wc -c", { repeat: "b", count: 200_000 }],
  "no output": ["true", "input"],
  "ansi output": ["printf '\\033[1mbold\\033[0m'", ""],
};

for (const [label, [command, stdin]] of Object.entries(commands)) {
  for (const role of ["main", "secondary"]) {
    add(`after previous: ${label}: ${role}`, {
      args: AFTER,
      env: role === "main" ? {} : secondary,
      files: previous(command),
      stdin,
    });
  }
}

add("after previous: invalid utf8 input reaches the previous command", {
  args: AFTER,
  files: previous("cat"),
  stdin: { bytes: [0x7b, 0xff, 0x7d, 0xc3] },
});
add("after previous: connected with pt-br", {
  args: AFTER,
  files: {
    ...locales["pt-br"],
    [HEALTH]: health(),
    ...previous("printf 'mine\\n'"),
  },
});
add("after previous: connecting", {
  args: AFTER,
  files: { [LAUNCH]: launch(NOW - 10), ...previous("printf 'mine'") },
});
add("plain mode never runs the previous command", {
  files: previous("printf mine"),
});

function inputOf(stdin) {
  if (typeof stdin === "string") return stdin;
  if (stdin.repeat !== undefined) return stdin.repeat.repeat(stdin.count);

  return Buffer.from(stdin.bytes);
}

function runScenario(scenario) {
  return withRoot((root) => {
    materialize(root, scenario.files);

    const result = spawnSync(
      process.execPath,
      [FIXED_CLOCK, STATUSLINE, ...scenario.args],
      {
        cwd: root,
        env: { ...resolveEnv(scenario.env, root), PATH: SYSTEM_PATH },
        input: inputOf(scenario.stdin),
      },
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

await writeFixture("statusline.json", {
  now: NOW,
  healthTtlMs: 15_000,
  launchGraceMs: 60_000,
  scenarios: scenarios.map(runScenario),
});
