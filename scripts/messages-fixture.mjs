import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { MESSAGES } from "../plugins/telegram-hooks/lib/messages.mjs";

const OUTPUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rust",
  "crates",
  "bcct",
  "tests",
  "fixtures",
  "messages.json",
);

const STRING_POOL = ["alpha 1", "beta 'two'", "gamma/3", "delta_4"];

const OVERRIDES = {
  alreadyRunning: [[4242]],
  yesNoHint: [[true], [false]],
  inboxDaysLabel: [[7], [1]],
  inboxDays: [[7], [1]],
  delayKept: [[3], [1.5]],
  delayLabel: [[3], [1.5]],
  delaySaved: [
    [3, "config.json"],
    [1.5, "config.json"],
  ],
  "healthDetail.pendingPairings": [[2]],
  "healthDetail.groupsAllowed": [[2]],
  requiredPlugins: [[2, 3]],
  optionalPlugins: [[1, 2]],
  tooManyAccounts: [[3, "npm run setup:pairing"]],
  confirmPairing: [["Ana (@ana)", 123456789]],
  nothingPending: [["ab12cd34"], [null], [""]],
  statuslineChoiceQuestion: [["~/bin/line.sh", "📱 (Main) Telegram connected"]],
  changedSetting: [["⚙ delay", "3 min", "5 min"]],
  removeModelsAll: [["base, small"]],
  sendPairingCode: [["my_bot", "A1B2C3", "https://t.me/my_bot?start=A1B2C3"]],
  unknownSteps: [["foo, bar", "language, token, pairing"]],
  invalidAnswer: [["x", "y or n"]],
  hookFailedOften: [
    ["Stop", 3, "disk full"],
    ["UserPromptSubmit", 12, "unexpected input from Claude Code"],
  ],
  "healthDetail.hookFailedOften": [["PostToolUse", 4, "disk full"]],
  "fix.invalidAnswer": [[3], [1]],
};

function stringArgs(arity) {
  return Array.from(
    { length: arity },
    (_, index) => STRING_POOL[index % STRING_POOL.length],
  );
}

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "object" && entry !== null
      ? flatten(entry, `${prefix}${key}.`)
      : [[`${prefix}${key}`, entry]],
  );
}

function recordLocale(catalog) {
  const recorded = {};
  for (const [key, entry] of flatten(catalog)) {
    if (typeof entry !== "function") {
      recorded[key] = entry;
      continue;
    }
    const calls = OVERRIDES[key] ?? [stringArgs(entry.length)];
    recorded[key] = calls.map((args) => ({ args, out: entry(...args) }));
  }
  return recorded;
}

const fixture = Object.fromEntries(
  Object.entries(MESSAGES).map(([locale, catalog]) => [
    locale,
    recordLocale(catalog),
  ]),
);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(
  OUTPUT,
  await format(JSON.stringify(fixture), { parser: "json" }),
);
