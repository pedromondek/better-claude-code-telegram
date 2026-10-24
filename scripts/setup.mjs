import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { messagesFor } from "../plugins/telegram-hooks/lib/messages.mjs";
import { createJournal } from "./journal.mjs";
import { selectOnTerminal } from "./select.mjs";
import {
  code as highlightCode,
  fail,
  info,
  link,
  newValue,
  note,
  pending,
  question,
  skipped,
  stepHeading,
  success,
  warn,
} from "./ui.mjs";
import {
  CONFIG_FILE,
  DEFAULT_DELAY_MINUTES,
  DEFAULT_INBOX_RETENTION_DAYS,
  DEFAULT_LOCALE,
  LAUNCH_FILE,
  LOCALES,
  PREVIOUS_STATUSLINE_FILE,
  defaultAppDir,
  readConfig,
  readJsonFile,
  telegramStateDir,
} from "../plugins/telegram-hooks/lib/state.mjs";

export { DEFAULT_DELAY_MINUTES, defaultAppDir, telegramStateDir };

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHELL_FILE = join(ROOT_DIR, "scripts", "shell.sh");
const STATUSLINE_FILE = join(
  ROOT_DIR,
  "plugins",
  "telegram-hooks",
  "statusline.mjs",
);
const STATUSLINE_REQUEST_FILE = "statusline-customize.json";
const TRANSCRIBE_SCRIPT = join(
  ROOT_DIR,
  "plugins",
  "telegram",
  "extensions",
  "transcribe.py",
);
const FASTER_WHISPER_VERSION = "1.2.1";
const PYAV_VERSION = "18.1.0";
const WHISPER_PACKAGES = [
  `faster-whisper==${FASTER_WHISPER_VERSION}`,
  `av==${PYAV_VERSION}`,
];
const TRANSCRIPTION_MODELS = ["base", "small", "medium"];
const DEFAULT_TRANSCRIPTION_MODEL = "base";
const DELAY_PRESETS = [1, 3, 4, 5, 10, 15];
const INBOX_PRESETS = [1, 3, 7, 14, 30];
const QUIET_PRESETS = [
  { key: "outsideWork", start: "18:00", end: "08:00" },
  { key: "fullNight", start: "18:00", end: "07:00" },
  { key: "night", start: "22:00", end: "07:00" },
  { key: "lateNight", start: "00:00", end: "07:00" },
];
const LANGUAGE_LABELS = {
  "en-us": "English / Inglês (en-us)",
  "pt-br": "Português Brasileiro / Brazilian Portuguese (pt-br)",
};
const LANGUAGE_FLAGS = { "en-us": "🇺🇸", "pt-br": "🇧🇷" };

function flagsRender(env = process.env, platform = process.platform) {
  return platform !== "win32" && !env.WSL_DISTRO_NAME && !env.WT_SESSION;
}

function languageLabel(locale) {
  return flagsRender()
    ? `${LANGUAGE_FLAGS[locale]} ${LANGUAGE_LABELS[locale]}`
    : LANGUAGE_LABELS[locale];
}
const OTHER = Symbol("other");
const UNINSTALL = Symbol("uninstall");
const INVALID = Symbol("invalid");
const journal = createJournal();
const interruption = new AbortController();

function abortableFetch(url, init) {
  return fetch(url, { ...init, signal: interruption.signal });
}
const PAIRING_TIMEOUT_MS = 180_000;
const REQUIRED_TOOLS = ["claude", "bun"];
export const MINIMUM_NODE = "24.11";
const CLAUDE_CODE_VERSION = "2.1.303";
const BUN_VERSION = "1.4.3";
const UV_VERSION = "0.13.1";

export const MARKETPLACE_NAME = "better-claude-code-telegram";
export const CHANNEL_PLUGIN_ID = `telegram@${MARKETPLACE_NAME}`;
export const HOOKS_PLUGIN_ID = `telegram-hooks@${MARKETPLACE_NAME}`;
export const BCCT_PLUGIN_ID = `bcct@${MARKETPLACE_NAME}`;
export const PLUGIN_IDS = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID, BCCT_PLUGIN_ID];

export function manualUninstallCommands() {
  return [
    ...PLUGIN_IDS.map((pluginId) => `claude plugin uninstall ${pluginId}`),
    `claude plugin marketplace remove ${MARKETPLACE_NAME}`,
  ]
    .map((command) => `  ${command}`)
    .join("\n");
}
export const SETUP_COMMAND = "npm run setup";
export const MERMAID_UNINSTALL_COMMAND =
  "npm uninstall -g @mermaid-js/mermaid-cli";

export function huggingFaceCacheDir(env = process.env, home = homedir()) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, "hub");

  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "huggingface", "hub");
}
export const SHELL_MARKER = `# Added by ${MARKETPLACE_NAME} setup`;

export const SETUP_SECTIONS = [
  "language",
  "plugin",
  "token",
  "pairing",
  "delay",
  "quiet-hours",
  "transcription",
  "inbox",
  "statusline",
];

const STEP_ICONS = {
  language: "🌐",
  plugin: "🧩",
  token: "🔑",
  pairing: "🔗",
  delay: "⏳",
  "quiet-hours": "🌙",
  transcription: "🎤",
  inbox: "📥",
  statusline: "📊",
  health: "🩺",
};
const SECURITY_RULE_ICON = "🔒";

async function finalCheck(messages) {
  const { HEALTH_GROUPS, printingProgress, runHealth } =
    await import("./health.mjs");
  const results = await runHealth(HEALTH_GROUPS, messages, {
    ...printingProgress(messages),
    callTelegram: (token) =>
      createTelegramApi(token, abortableFetch, messages)("getMe"),
  });

  if (results.some(({ status }) => status === "fail")) {
    console.log(warn(messages.healthHasFailures("npm run health")));
  }
}

export function missingSetupSteps(stateDir) {
  const missing = [];

  if (!parseEnvToken(readText(join(stateDir, ".env")) ?? "")) {
    missing.push("token");
  }

  if (!isPaired(readJsonFile(join(stateDir, "access.json")))) {
    missing.push("pairing");
  }

  return missing;
}

const SKIP_PERMISSION_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode=bypassPermissions",
]);

export function skippedPermissions(args, settings) {
  for (const [index, arg] of args.entries()) {
    const next = args[index + 1];

    if (SKIP_PERMISSION_FLAGS.has(arg)) return arg;
    if (arg === "--permission-mode" && next === "bypassPermissions") {
      return `${arg} ${next}`;
    }
  }

  return settings?.permissions?.defaultMode === "bypassPermissions"
    ? "defaultMode bypassPermissions"
    : null;
}

export function checkSetup(
  stateDir,
  isRunning = telegramInstanceRunning,
  {
    appDir = defaultAppDir(),
    env = process.env,
    args = [],
    settingsFile = claudeSettingsFile(env),
  } = {},
) {
  const messages = messagesFor(setupLocale(appDir, env));
  const missing = missingSetupSteps(stateDir);

  if (missing.length > 0) {
    console.error(
      fail(
        messages.notConfigured(
          missing.map((label) => messages.stepLabels[label]).join(", "),
          SETUP_COMMAND,
        ),
      ),
    );

    return 1;
  }

  const accounts = readJsonFile(join(stateDir, "access.json")).allowFrom.length;

  if (accounts > 1) {
    console.error(
      fail(messages.tooManyAccounts(accounts, `${SETUP_COMMAND}:pairing`)),
    );

    return 1;
  }

  const fromFlags = skippedPermissions(args, null);
  const fromSettings = skippedPermissions([], readJsonFile(settingsFile));
  const bypass =
    fromFlags ?? (fromSettings ? `${fromSettings} (${settingsFile})` : null);

  if (bypass) {
    console.error(fail(messages.permissionsSkipped(bypass)));

    return 1;
  }

  const runningPid = isRunning(stateDir);

  if (runningPid) {
    console.error(fail(messages.alreadyRunning(runningPid)));

    return 1;
  }

  return 0;
}

export function parseSetupSections(
  args,
  messages = messagesFor(DEFAULT_LOCALE),
) {
  const requested = args.map((arg) => arg.trim().toLowerCase()).filter(Boolean);

  if (requested.length === 0) return SETUP_SECTIONS;

  const unknown = requested.filter((arg) => !SETUP_SECTIONS.includes(arg));

  if (unknown.length > 0) {
    throw new Error(
      messages.unknownSteps(unknown.join(", "), SETUP_SECTIONS.join(", ")),
    );
  }

  return SETUP_SECTIONS.filter((section) => requested.includes(section));
}

export function parseLocale(answer, current) {
  const trimmed = answer.trim().toLowerCase().replaceAll("_", "-");

  return LOCALES.includes(trimmed) ? trimmed : current;
}

export function suggestedLocale(env = process.env) {
  const system = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "")
    .toLowerCase()
    .replaceAll("_", "-");

  return LOCALES.find((locale) => system.startsWith(locale)) ?? DEFAULT_LOCALE;
}

function enterKeepsDefault(appDir) {
  const { language } = readConfig(appDir);

  return LOCALES.includes(language)
    ? messagesFor(language).enterKeepsDefault
    : LOCALES.map(
        (locale) => `[${locale}] ${messagesFor(locale).enterKeepsDefault}`,
      ).join(" / ");
}

export function setupLocale(appDir, env = process.env) {
  const { language } = readConfig(appDir);

  return LOCALES.includes(language) ? language : suggestedLocale(env);
}

export function parseDelayMinutes(answer, fallbackMinutes) {
  const minutes = Number(answer.trim().replace(",", "."));

  return answer.trim() !== "" && Number.isFinite(minutes) && minutes > 0
    ? minutes
    : fallbackMinutes;
}

const QUIET_HOURS_PATTERN =
  /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/;
const DISABLE_ANSWERS = new Set([
  "não",
  "nao",
  "n",
  "nenhum",
  "no",
  "none",
  "off",
  "0",
]);

export function parseQuietHours(answer, current) {
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === "") return current;
  if (DISABLE_ANSWERS.has(trimmed)) return null;

  const match = QUIET_HOURS_PATTERN.exec(trimmed);

  if (!match || `${match[1]}:${match[2]}` === `${match[3]}:${match[4]}`) {
    return current;
  }

  return { start: `${match[1]}:${match[2]}`, end: `${match[3]}:${match[4]}` };
}

export function formatQuietHours(quietHours) {
  return quietHours?.start && quietHours?.end
    ? `${quietHours.start}-${quietHours.end}`
    : "";
}

export function parseInboxDays(answer, current) {
  const trimmed = answer.trim().toLowerCase();

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) > 0 ? Number(trimmed) : current;
  }

  return DISABLE_ANSWERS.has(trimmed) ? null : current;
}

export function currentInboxDays(appDir) {
  const days = readConfig(appDir).inboxRetentionDays;

  if (days === null) return null;

  return typeof days === "number" && days > 0
    ? days
    : DEFAULT_INBOX_RETENTION_DAYS;
}

function saveInboxDays(appDir, days, messages) {
  const configFile = updateConfig(appDir, { inboxRetentionDays: days });

  console.log(
    success(
      messages.inboxSaved(
        days === null ? messages.inboxForever : messages.inboxDays(days),
        configFile,
      ),
    ),
  );
}

async function ensureInbox(appDir, messages) {
  const current = currentInboxDays(appDir);
  const saved = "inboxRetentionDays" in readConfig(appDir);
  const days = await askInbox(current, messages, prompter(), { saved });

  if (keptSetting("inbox", days, appDir, messages)) return;

  saveInboxDays(appDir, days, messages);
}

export function parseTranscriptionModel(answer, current) {
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === "") return current;
  if (DISABLE_ANSWERS.has(trimmed)) return null;

  return TRANSCRIPTION_MODELS.includes(trimmed) ? trimmed : current;
}

export function parseEnvToken(envText) {
  const match = /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(envText);

  return match ? match[1].trim() : null;
}

export function sourceLine(shellFile) {
  return `[ -f "${shellFile}" ] && . "${shellFile}"`;
}

export function rcLoadsShellFile(rcText, shellFile) {
  return rcText.includes(shellFile);
}

export function shellRcFiles({
  home,
  shell,
  platform = process.platform,
  exists = existsSync,
}) {
  const bashrc = join(home, ".bashrc");
  const zshrc = join(home, ".zshrc");
  const bashProfile = join(home, ".bash_profile");
  const shellName = basename(shell || "bash");
  let primary = null;

  if (shellName === "zsh") primary = zshrc;
  if (shellName === "bash") {
    primary =
      platform === "darwin" && exists(bashProfile) ? bashProfile : bashrc;
  }

  return {
    primary,
    others: [bashrc, zshrc].filter((file) => file !== primary && exists(file)),
    unsupported: primary === null ? shellName : null,
  };
}

export function withShellBlock(rcText, shellFile) {
  if (rcLoadsShellFile(rcText, shellFile)) return null;

  const block = `${SHELL_MARKER}\n${sourceLine(shellFile)}\n`;

  if (rcText === "") return block;

  return `${rcText}${rcText.endsWith("\n") ? "" : "\n"}\n${block}`;
}

export function withoutShellBlock(rcText, shellFile) {
  if (!rcLoadsShellFile(rcText, shellFile)) return null;

  const block = `${SHELL_MARKER}\n${sourceLine(shellFile)}\n`;

  return rcText
    .replace(`\n\n${block}`, "\n")
    .replace(block, "")
    .split("\n")
    .filter((line) => !line.includes(shellFile))
    .join("\n");
}

export async function uninstall(
  {
    stateDir,
    appDir = defaultAppDir(),
    home = homedir(),
    settingsFile = claudeSettingsFile(),
    shellFile = SHELL_FILE,
    hasClaude = () => hasCommand("claude"),
    runClaudeCommand = (args) =>
      spawnSync("claude", args, { stdio: "ignore" }).status,
    confirm = (prompt, messages) => askYesNo(prompt, messages, false),
    isRunning = telegramInstanceRunning,
    hfCacheDir = huggingFaceCacheDir(),
    hasMermaid = () => hasCommand("mmdc"),
    removeMermaid = () =>
      spawnSync("sh", ["-c", MERMAID_UNINSTALL_COMMAND], { stdio: "ignore" })
        .status,
    listInstalled = () => ({
      plugins: claudeOutput(["plugin", "list"]),
      marketplaces: claudeOutput(["plugin", "marketplace", "list"]),
    }),
  },
  messages,
) {
  if (isRunning(stateDir)) {
    throw new Error(messages.closeInstanceBeforeUninstall);
  }

  const settings = readSettings(settingsFile, messages);

  removeShellLines(home, shellFile, messages);
  removeOurSettings(
    settings,
    { stateDir, appDir, home, settingsFile },
    messages,
  );
  removePlugins({ hasClaude, runClaudeCommand, listInstalled }, messages);

  if (readConfig(appDir).statuslineCustomized === true) {
    console.log(warn(messages.statuslineCustomLeft(statuslineCommand())));
  }

  await removeTranscription(appDir, hfCacheDir, confirm, messages);

  if (hasMermaid() && (await confirm(messages.deleteMermaidPrompt, messages))) {
    whilePending(messages.mermaidRemoving, (done) =>
      done(
        removeMermaid() === 0
          ? success(messages.mermaidRemoved)
          : warn(messages.mermaidNotRemoved(MERMAID_UNINSTALL_COMMAND)),
      ),
    );
  }

  if (await confirm(messages.deleteStatePrompt(stateDir, appDir), messages)) {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(appDir, { recursive: true, force: true });
    console.log(success(messages.stateDeleted(stateDir, appDir)));
  } else {
    console.log(messages.stateKept(stateDir, appDir));
  }

  console.log(`\n${success(messages.uninstallDone)}`);
}

function removeShellLines(home, shellFile, messages) {
  for (const name of [".bashrc", ".zshrc", ".bash_profile"]) {
    const rcFile = join(home, name);
    const updated = withoutShellBlock(readText(rcFile) ?? "", shellFile);

    if (updated === null) continue;

    writeFileSync(rcFile, updated);
    console.log(success(messages.rcNoLongerLoads(rcFile)));
  }
}

function removeOurSettings(
  settings,
  { stateDir, appDir, home, settingsFile },
  messages,
) {
  let cleaned = settings;

  const removed = withoutOurStatusline(settings, appDir);

  if (removed !== null) {
    cleaned = removed.settings;
    console.log(
      success(
        removed.restored
          ? messages.statuslineRestored(settingsFile)
          : messages.statuslineRemoved(settingsFile),
      ),
    );
  }

  const withoutRule = withoutEnvDenied(
    cleaned,
    envDenyRule(join(stateDir, ".env"), home),
  );

  if (withoutRule !== null) {
    cleaned = withoutRule;
    console.log(success(messages.envRuleRemoved(settingsFile)));
  }

  if (cleaned !== settings) writeJsonAtomic(settingsFile, cleaned);
}

function removePlugins(
  { hasClaude, runClaudeCommand, listInstalled },
  messages,
) {
  if (hasClaude()) {
    const succeeded = (...args) => runClaudeCommand(["plugin", ...args]) === 0;
    const { plugins, marketplaces } = showingProgress(
      messages.pluginsChecking,
      listInstalled,
    );

    for (const pluginId of PLUGIN_IDS) {
      if (!plugins.includes(pluginId)) {
        console.log(skipped(messages.pluginNotInstalled(pluginId)));
        continue;
      }

      whilePending(messages.pluginRemoving(pluginId), (done) =>
        done(
          succeeded("uninstall", pluginId, "--scope", "user")
            ? success(messages.pluginRemoved(pluginId))
            : warn(messages.pluginNotRemoved(pluginId)),
        ),
      );
    }

    if (!marketplaces.includes(MARKETPLACE_NAME)) {
      console.log(skipped(messages.marketplaceNotRegistered(MARKETPLACE_NAME)));
      return;
    }

    whilePending(messages.marketplaceRemoving(MARKETPLACE_NAME), (done) =>
      done(
        succeeded("marketplace", "remove", MARKETPLACE_NAME)
          ? success(messages.marketplaceRemoved(MARKETPLACE_NAME))
          : warn(messages.marketplaceNotRemoved(MARKETPLACE_NAME)),
      ),
    );
  } else {
    console.log(
      warn(messages.claudeMissingForUninstall(manualUninstallCommands())),
    );
  }
}

async function removeTranscription(appDir, hfCacheDir, confirm, messages) {
  const transcriptionPaths = [
    join(appDir, "whisper"),
    ...TRANSCRIPTION_MODELS.map((model) =>
      join(hfCacheDir, `models--Systran--faster-whisper-${model}`),
    ),
  ].filter((path) => existsSync(path));

  if (transcriptionPaths.length > 0) {
    console.log(messages.transcriptionFound(transcriptionPaths.join("\n  • ")));

    if (await confirm(messages.deleteTranscriptionPrompt, messages)) {
      whilePending(messages.transcriptionRemoving, (done) => {
        for (const path of transcriptionPaths) {
          rmSync(path, { recursive: true, force: true });
        }
        done(success(messages.transcriptionRemoved));
      });
    } else {
      console.log(messages.transcriptionKept);
    }
  }
}

export function installShellFunction(
  { home = homedir(), shell = process.env.SHELL, platform = process.platform },
  messages,
  shellFile = SHELL_FILE,
) {
  const { primary, others, unsupported } = shellRcFiles({
    home,
    shell,
    platform,
  });

  if (unsupported) {
    console.log(
      warn(messages.shellUnsupported(unsupported, sourceLine(shellFile))),
    );
  }

  for (const rcFile of primary ? [primary, ...others] : others) {
    const updated = withShellBlock(readText(rcFile) ?? "", shellFile);

    if (updated === null) {
      console.log(skipped(messages.rcAlreadyLoads(rcFile)));
      continue;
    }

    journal.trackFile(rcFile);
    writeFileSync(rcFile, updated);
    console.log(success(messages.rcNowLoads(rcFile)));
  }
}

export function statuslineCommand(statuslineFile = STATUSLINE_FILE) {
  return `node "${statuslineFile}"`;
}

export function statuslineAfterCommand(statuslineFile = STATUSLINE_FILE) {
  return `${statuslineCommand(statuslineFile)} --after-previous`;
}

function isOurStatusline(statusLine) {
  return [statuslineCommand(), statuslineAfterCommand()].includes(
    statusLine?.command,
  );
}

function statuslinePreview(statusLine) {
  const command = String(statusLine?.command ?? statusLine?.type ?? "");

  return command.length > 60 ? `${command.slice(0, 59)}…` : command;
}

export function withStatusline(settings, command) {
  if (settings?.statusLine) return null;

  return { ...settings, statusLine: { type: "command", command } };
}

export function envDenyRule(envFile, home = homedir()) {
  const homePrefix = `${home}/`;

  return envFile.startsWith(homePrefix)
    ? `Read(~/${envFile.slice(homePrefix.length)})`
    : `Read(/${envFile})`;
}

export function withEnvDenied(settings, rule) {
  const deny = settings.permissions?.deny ?? [];

  if (deny.includes(rule)) return null;

  return {
    ...settings,
    permissions: { ...settings.permissions, deny: [...deny, rule] },
  };
}

export function withoutEnvDenied(settings, rule) {
  const deny = settings.permissions?.deny ?? [];

  if (!deny.includes(rule)) return null;

  const { permissions, ...rest } = settings;
  const { deny: _ours, ...otherPermissions } = permissions;
  const remaining = deny.filter((entry) => entry !== rule);
  const kept =
    remaining.length > 0
      ? { ...otherPermissions, deny: remaining }
      : otherPermissions;

  return Object.keys(kept).length > 0 ? { ...rest, permissions: kept } : rest;
}

export function isPaired(access) {
  return Array.isArray(access?.allowFrom) && access.allowFrom.length > 0;
}

export function buildAccess(currentAccess, userId) {
  return {
    ...currentAccess,
    dmPolicy: "allowlist",
    allowFrom: [userId],
    groups: {},
    pending: {},
  };
}

export function pairingCode(random = randomBytes) {
  return random(4).toString("hex");
}

export function pairingLink(username, code) {
  return `https://t.me/${username}?start=${code}`;
}

export function findPairingCandidate(updates, code) {
  const privateMessage = updates.find(
    (update) =>
      update.message?.chat?.type === "private" &&
      update.message.from &&
      [code, `/start ${code}`].includes(update.message.text?.trim()),
  );

  if (!privateMessage) return null;

  const { from } = privateMessage.message;

  return {
    userId: String(from.id),
    label: from.username ? `@${from.username}` : from.first_name,
    updateId: privateMessage.update_id,
  };
}

export function lastUpdateId(updates) {
  return updates.reduce(
    (highest, update) => Math.max(highest, update.update_id),
    -1,
  );
}

export function telegramApiRoot(env = process.env) {
  return env.BETTER_CC_TELEGRAM_API_ROOT || "https://api.telegram.org";
}

export function createTelegramApi(
  token,
  fetchImpl = fetch,
  messages = messagesFor(DEFAULT_LOCALE),
  apiRoot = telegramApiRoot(),
) {
  return async function callTelegram(method, params = {}) {
    let body;

    try {
      const response = await fetchImpl(`${apiRoot}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      body = await response.json();
    } catch {
      throw new Error(messages.networkFailure(method));
    }

    if (!body.ok) {
      throw new Error(
        messages.telegramRefused(
          method,
          body.description ?? messages.noDescription,
        ),
      );
    }

    return body.result;
  };
}

export function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function hasCommand(name) {
  return (
    spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" })
      .status === 0
  );
}

export function claudeOutput(args) {
  return spawnSync("claude", args, { encoding: "utf8" }).stdout ?? "";
}

function runClaude(args, messages) {
  const result = spawnSync("claude", args, { encoding: "utf8" });

  if (result.status !== 0) {
    const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

    throw new Error(
      [messages.failed(`claude ${args.join(" ")}`), said]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

export function telegramInstanceRunning(stateDir) {
  const botPid = readText(join(stateDir, "bot.pid"))?.trim();

  if (!botPid) return null;

  const args = spawnSync("ps", ["-p", botPid, "-o", "args="], {
    encoding: "utf8",
  }).stdout;

  return (args ?? "").includes("server.ts") ? botPid : null;
}

function cancelledError(messages) {
  return Object.assign(new Error(messages.cancelled), { cancelled: true });
}

async function questionOnTerminal(prompt, messages, input, output) {
  const readline = createInterface({ input, output });
  const controller = new AbortController();

  readline.on("SIGINT", () => controller.abort());

  try {
    return await readline.question(prompt, { signal: controller.signal });
  } catch (error) {
    throw controller.signal.aborted ? cancelledError(messages) : error;
  } finally {
    readline.close();
  }
}

function hiddenOnTerminal(prompt, messages, input, output) {
  return new Promise((resolveAnswer, rejectAnswer) => {
    let typed = "";

    const finish = (callback) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      callback();
    };

    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n")
          return finish(() => resolveAnswer(typed.trim()));
        if (char === "\u0003")
          return finish(() => rejectAnswer(cancelledError(messages)));
        if (char === "\u007F" || char === "\b") typed = typed.slice(0, -1);
        else typed += char;
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function createPrompter({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (input.isTTY) {
    return {
      interactive: true,
      line: (prompt, messages) =>
        questionOnTerminal(prompt, messages, input, output),
      hidden: (prompt, messages) =>
        hiddenOnTerminal(prompt, messages, input, output),
      select: (title, choices, index, messages) =>
        selectOnTerminal({
          title,
          choices,
          index,
          hint: messages.selectHint,
          cancelled: messages.cancelled,
          input,
          output,
        }),
      close: () => {},
    };
  }

  const readline = createInterface({ input, terminal: false });
  const lines = readline[Symbol.asyncIterator]();
  const nextLine = async (prompt, messages) => {
    output.write(prompt);

    const { value, done } = await lines.next();

    if (done) throw new Error(messages.cancelled);

    return value;
  };

  return {
    interactive: false,
    line: nextLine,
    hidden: async (prompt, messages) => {
      const answer = await nextLine(prompt, messages);

      output.write("\n");

      return answer.trim();
    },
    close: () => readline.close(),
  };
}

let activePrompter = null;

function prompter() {
  activePrompter ??= createPrompter();

  return activePrompter;
}

export function guardCancel(ask) {
  if (!ask.interactive) return ask;

  const askLeaving = (messages) =>
    ask
      .select(
        question(messages.exitPrompt),
        [
          { label: messages.continueSetup, value: false },
          { label: messages.exitSetup, value: true },
        ],
        1,
        messages,
      )
      .catch(() => true);

  const retrying =
    (method) =>
    async (...args) => {
      const messages = args.at(-1);

      for (;;) {
        try {
          return await ask[method](...args);
        } catch (error) {
          if (!error.cancelled) throw error;

          if (await askLeaving(messages)) {
            throw Object.assign(new Error(messages.interrupted), {
              interrupted: true,
            });
          }
        }
      }
    };

  return {
    ...ask,
    line: retrying("line"),
    hidden: retrying("hidden"),
    select: retrying("select"),
  };
}

const CONFIG_KEYS = [
  ["language", "language"],
  ["delayMinutes", "delay"],
  ["quietHours", "quiet-hours"],
  ["transcription", "transcription"],
  ["inboxRetentionDays", "inbox"],
];

function settingText(key, value, messages) {
  if (value === undefined) return messages.notSet;
  if (key === "delayMinutes") return messages.delayLabel(value);
  if (key === "quietHours") {
    return formatQuietHours(value) || messages.quietOff;
  }
  if (key === "transcription") {
    return value?.model ?? messages.transcriptionOffLabel;
  }
  if (key === "inboxRetentionDays") {
    return value === null ? messages.inboxForever : messages.inboxDays(value);
  }

  return String(value);
}

function parsedJson(text) {
  try {
    return JSON.parse(text ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function optionChange(icon, label, before, after, messages) {
  return messages.changedSetting(
    info(`${icon} ${label}`),
    note(before),
    newValue(after),
  );
}

function settingsChanges(before, after, stateDir, messages) {
  const changes = [];
  const statusline = (settings) =>
    messages.healthDetail.statusline[statuslineKind(settings.statusLine)];
  const rule = envDenyRule(join(stateDir, ".env"));
  const protectedBy = (settings) =>
    (settings.permissions?.deny ?? []).includes(rule)
      ? messages.ruleOn
      : messages.ruleOff;
  const pluginState = (value) =>
    value === undefined
      ? messages.notSet
      : value
        ? messages.pluginOn
        : messages.pluginOff;

  if (statusline(before) !== statusline(after)) {
    changes.push(
      optionChange(
        STEP_ICONS.statusline,
        messages.settingsKeys.statusLine,
        statusline(before),
        statusline(after),
        messages,
      ),
    );
  }

  if (protectedBy(before) !== protectedBy(after)) {
    changes.push(
      optionChange(
        SECURITY_RULE_ICON,
        messages.settingsKeys.permissions,
        protectedBy(before),
        protectedBy(after),
        messages,
      ),
    );
  }

  const beforePlugins = before.enabledPlugins ?? {};
  const afterPlugins = after.enabledPlugins ?? {};

  for (const pluginId of new Set([
    ...Object.keys(afterPlugins),
    ...Object.keys(beforePlugins),
  ])) {
    if (beforePlugins[pluginId] !== afterPlugins[pluginId]) {
      changes.push(
        optionChange(
          STEP_ICONS.plugin,
          messages.pluginSetting(pluginId),
          pluginState(beforePlugins[pluginId]),
          pluginState(afterPlugins[pluginId]),
          messages,
        ),
      );
    }
  }

  return changes;
}

function changedOptions(target, changeJournal, messages, stateDir) {
  const name = basename(target);

  if (name !== CONFIG_FILE && name !== "settings.json") return [];

  const before = parsedJson(changeJournal.original(target));
  const after = parsedJson(readText(target));
  const differs = (key) =>
    JSON.stringify(before[key]) !== JSON.stringify(after[key]);

  if (name === "settings.json") {
    return settingsChanges(before, after, stateDir, messages);
  }

  return CONFIG_KEYS.filter(([key]) => differs(key)).map(([key, step]) =>
    optionChange(
      STEP_ICONS[step],
      messages.stepTitles[step],
      settingText(key, before[key], messages),
      settingText(key, after[key], messages),
      messages,
    ),
  );
}

function describeChanges(changes, messages, changeJournal, stateDir) {
  return changes
    .map(
      ({ kind, target }) =>
        `${messages.changeKinds[kind](target)}${changedOptions(
          target,
          changeJournal,
          messages,
          stateDir,
        )
          .map((option) => `\n    – ${option}`)
          .join("")}`,
    )
    .join("\n  • ");
}

export async function offerUndo(
  changeJournal,
  messages,
  ask,
  { interrupted, stateDir = telegramStateDir() },
) {
  const changes = changeJournal.changes();

  if (changes.length === 0) {
    console.log(messages.nothingChanged);
    return;
  }

  console.log(
    messages.doneSoFar(
      describeChanges(changes, messages, changeJournal, stateDir),
    ),
  );

  const undo = await ask
    .select(
      question(messages.undoPrompt),
      [
        { label: messages.undoAll, value: true },
        { label: messages.keepDone, value: false },
      ],
      interrupted ? 0 : 1,
      messages,
    )
    .catch(() => false);

  if (!undo) {
    console.log(messages.keptDone(SETUP_COMMAND));
    return;
  }

  let finish = () => {};
  const described = ({ kind, target }) => messages.changeKinds[kind](target);
  const left = changeJournal.undoAll({
    onStart: (change) => {
      finish = pending(messages.undoing(described(change)));
    },
    onDone: (change, ok) => {
      finish();
      if (ok) console.log(success(messages.undoneItem(described(change))));
    },
  });

  console.log(
    left.length === 0
      ? success(messages.undone)
      : warn(
          messages.undoLeft(
            describeChanges(left, messages, changeJournal, stateDir),
          ),
        ),
  );
}

export async function askYesNo(
  prompt,
  messages,
  defaultYes = true,
  ask = prompter(),
) {
  if (ask.interactive) {
    return ask.select(
      question(prompt),
      [
        { label: messages.yes, value: true },
        { label: messages.no, value: false },
      ],
      defaultYes ? 0 : 1,
      messages,
    );
  }

  const answer = (
    await ask.line(
      question(`${prompt} ${messages.yesNoHint(defaultYes)} `),
      messages,
    )
  )
    .trim()
    .toLowerCase();

  if (answer === "") return defaultYes;

  return answer.startsWith("s") || answer.startsWith("y");
}

function askHidden(prompt, messages) {
  return prompter().hidden(question(prompt), messages);
}

async function askValidated(prompt, parse, hint, messages, ask) {
  for (;;) {
    const typed = (await ask.line(question(prompt), messages)).trim();
    const value = parse(typed);

    if (value !== INVALID) return value;

    console.error(fail(messages.invalidAnswer(typed, hint)));
  }
}

async function askChoice(
  { title, choices, index, other, defaultHint },
  messages,
  ask,
) {
  if (ask.interactive) {
    const options = other
      ? [...choices, { label: other.label, value: OTHER }]
      : choices;
    const picked = await ask.select(question(title), options, index, messages);

    return picked === OTHER ? other.askOnTerminal(ask) : picked;
  }

  const answers = [
    ...choices.filter(({ heading }) => !heading).map(({ answer }) => answer),
    ...(other ? [other.answer] : []),
  ].join(", ");
  const hint = (defaultHint ?? messages.defaultHint)(choices[index].answer);

  for (;;) {
    const typed = (
      await ask.line(question(`${title} (${answers}) ${hint}: `), messages)
    )
      .trim()
      .toLowerCase();

    if (typed === "") return choices[index].value;

    const match = choices.find(
      ({ answer, aliases = [] }) => answer === typed || aliases.includes(typed),
    );

    if (match) return match.value;

    const parsed = other ? other.parse(typed) : INVALID;

    if (parsed !== INVALID) return parsed;

    console.error(fail(messages.invalidAnswer(typed, answers)));
  }
}

function numberChoices(presets, current, label) {
  const values =
    current === null || presets.includes(current)
      ? presets
      : [...presets, current].toSorted((left, right) => left - right);

  return values.map((value) => ({
    label: label(value),
    answer: String(value),
    value,
  }));
}

function indexOfValue(choices, current) {
  return Math.max(
    0,
    choices.findIndex(({ value }) => value === current),
  );
}

export function parseTime(text) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());

  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : INVALID;
}

function parsePositiveDays(text) {
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : INVALID;
}

function marked(
  choices,
  index,
  { saved = false, tagsOf = () => [] },
  messages,
) {
  return choices.map((choice, position) => {
    const previous = saved && position === index;
    const tags = [
      ...tagsOf(choice),
      ...(previous ? [messages.previousChoice] : []),
    ];

    return tags.length === 0
      ? choice
      : { ...choice, label: `${choice.label} (${tags.join(", ")})`, previous };
  });
}

export function askLanguage(
  current,
  messages,
  ask = prompter(),
  { saved = false } = {},
) {
  const options = LOCALES.map((locale) => ({
    label: languageLabel(locale),
    answer: locale,
    aliases: [locale.replace("-", "_")],
    value: locale,
  }));
  const index = indexOfValue(options, current);
  const choices = marked(options, index, { saved }, messages);

  return askChoice(
    {
      title: messages.languageQuestion,
      choices,
      index,
      defaultHint: messages.languageDefaultHint,
    },
    messages,
    ask,
  );
}

export function askDelay(
  current,
  messages,
  ask = prompter(),
  { saved = false } = {},
) {
  const options = numberChoices(DELAY_PRESETS, current, messages.delayLabel);
  const index = indexOfValue(options, current);
  const choices = marked(
    options,
    index,
    {
      saved,
      tagsOf: ({ value }) =>
        value === DEFAULT_DELAY_MINUTES ? [messages.recommended] : [],
    },
    messages,
  );
  const parse = (text) => parseDelayMinutes(text, INVALID);

  return askChoice(
    {
      title: messages.delayQuestion,
      choices,
      index,
      other: {
        label: messages.custom,
        answer: "N",
        parse,
        askOnTerminal: (terminal) =>
          askValidated(
            messages.delayCustomPrompt,
            parse,
            messages.delayCustomHint,
            messages,
            terminal,
          ),
      },
    },
    messages,
    ask,
  );
}

export function askInbox(
  current,
  messages,
  ask = prompter(),
  { saved = false } = {},
) {
  const options = [
    ...numberChoices(INBOX_PRESETS, current, messages.inboxDaysLabel),
    {
      label: messages.inboxForeverLabel,
      answer: "off",
      aliases: [...DISABLE_ANSWERS].filter((answer) => answer !== "0"),
      value: null,
    },
  ];
  const index = indexOfValue(options, current);
  const choices = marked(options, index, { saved }, messages);

  return askChoice(
    {
      title: messages.inboxQuestion,
      choices,
      index,
      other: {
        label: messages.custom,
        answer: "N",
        parse: parsePositiveDays,
        askOnTerminal: (terminal) =>
          askValidated(
            messages.inboxCustomPrompt,
            parsePositiveDays,
            messages.inboxCustomHint,
            messages,
            terminal,
          ),
      },
    },
    messages,
    ask,
  );
}

async function askQuietRange(messages, ask) {
  const start = await askValidated(
    messages.quietStartPrompt,
    parseTime,
    messages.timeHint,
    messages,
    ask,
  );
  const end = await askValidated(
    messages.quietEndPrompt,
    (text) => {
      const time = parseTime(text);

      return time === start ? INVALID : time;
    },
    messages.quietEndHint(start),
    messages,
    ask,
  );

  return { start, end };
}

export function askQuietHours(
  current,
  messages,
  ask = prompter(),
  { saved = false } = {},
) {
  const range = formatQuietHours(current);
  const presets = QUIET_PRESETS.map(({ key, start, end }) => ({
    label: messages.quietPresets[key],
    hint: `${start}-${end}`,
    answer: `${start}-${end}`,
    value: { start, end },
  }));
  const own =
    range && !presets.some(({ answer }) => answer === range)
      ? [{ label: range, answer: range, value: current }]
      : [];
  const options = [
    {
      label: messages.quietOffLabel,
      answer: "off",
      aliases: [...DISABLE_ANSWERS],
      value: null,
    },
    ...own,
    ...presets,
  ];
  const index = Math.max(
    0,
    options.findIndex(({ answer }) => answer === (range || "off")),
  );
  const choices = marked(options, index, { saved }, messages);

  return askChoice(
    {
      title: messages.quietQuestion,
      choices,
      index,
      other: {
        label: messages.custom,
        answer: "HH:MM-HH:MM",
        parse: (text) => parseQuietHours(text, INVALID),
        askOnTerminal: (terminal) => askQuietRange(messages, terminal),
      },
    },
    messages,
    ask,
  );
}

export function askTranscription(
  current,
  messages,
  ask = prompter(),
  { saved = false, installed = [] } = {},
) {
  const modelOption = (model) => ({
    label: model,
    hint: messages.transcriptionModels[model],
    answer: model,
    value: model,
  });
  const downloaded = TRANSCRIPTION_MODELS.filter((model) =>
    installed.includes(model),
  );
  const toDownload = TRANSCRIPTION_MODELS.filter(
    (model) => !installed.includes(model),
  );
  const grouped = [
    {
      label: messages.transcriptionUninstall,
      answer: "uninstall",
      value: UNINSTALL,
    },
    { label: messages.transcriptionInstalledHeading, heading: true },
    ...downloaded.map(modelOption),
    ...(toDownload.length > 0
      ? [
          { label: messages.transcriptionAvailableHeading, heading: true },
          ...toDownload.map(modelOption),
        ]
      : []),
  ];
  const options = [
    {
      label: messages.transcriptionOffLabel,
      answer: "off",
      aliases: [...DISABLE_ANSWERS],
      value: null,
    },
    ...(downloaded.length > 0 ? grouped : toDownload.map(modelOption)),
  ];
  const index = indexOfValue(options, current);
  const choices = marked(options, index, { saved }, messages);

  return askChoice(
    {
      title: messages.transcriptionQuestion,
      choices,
      index,
    },
    messages,
    ask,
  );
}

function statuslineExample(messages) {
  return messages.statusConnected(messages.statusMain);
}

export function askStatuslineChoice(
  preview,
  messages,
  ask = prompter(),
  { customized = false } = {},
) {
  const choices = ["after", "replace", "custom", "keep"].map(
    (choice, position) => ({
      label:
        choice === "keep" && customized
          ? messages.statuslineChoices.keepCustom
          : messages.statuslineChoices[choice],
      hint: messages.statuslineChoiceHints[choice],
      answer: choice,
      aliases: [String(position + 1)],
      value: choice,
    }),
  );

  return askChoice(
    {
      title: messages.statuslineChoiceQuestion(
        preview,
        statuslineExample(messages),
      ),
      choices,
      index: 3,
    },
    messages,
    ask,
  );
}

function askOurStatusline(restores, messages, ask = prompter()) {
  const hints = {
    keep: messages.statuslineOursHints.keep,
    remove: restores
      ? messages.statuslineOursHints.restore
      : messages.statuslineOursHints.remove,
  };
  const choices = ["keep", "remove"].map((choice, position) => ({
    label: messages.statuslineOursChoices[choice],
    hint: hints[choice],
    answer: choice,
    aliases: [String(position + 1)],
    value: choice,
  }));

  return askChoice(
    {
      title: messages.statuslineOursQuestion(statuslineExample(messages)),
      choices,
      index: 0,
    },
    messages,
    ask,
  );
}

function updateConfig(appDir, patch) {
  const configFile = join(appDir, CONFIG_FILE);

  journal.trackDir(appDir);
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  journal.trackFile(configFile);
  writeFileSync(
    configFile,
    `${JSON.stringify({ ...readConfig(appDir), ...patch }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return configFile;
}

export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  const [minMajor, minMinor] = MINIMUM_NODE.split(".").map(Number);

  return major > minMajor || (major === minMajor && minor >= minMinor);
}

export function installerFor(tool, home = homedir()) {
  const installers = {
    claude: {
      command: `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`,
      binDir: join(home, ".local", "bin"),
    },
    bun: {
      command: `curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"`,
      binDir: join(home, ".bun", "bin"),
    },
    uv: {
      command: `curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh`,
      binDir: join(home, ".local", "bin"),
    },
  };

  return installers[tool];
}

export async function ensureRequirements(
  tools,
  messages,
  {
    home = homedir(),
    env = process.env,
    hasCommand: isAvailable = hasCommand,
    confirm = (prompt, promptMessages) =>
      askYesNo(prompt, promptMessages, true),
    runInstaller = (command) =>
      spawnSync("sh", ["-c", command], { stdio: "inherit" }).status,
  } = {},
) {
  const declined = [];

  for (const tool of tools.filter((name) => !isAvailable(name))) {
    const { command, binDir } = installerFor(tool, home);

    if (!(await confirm(messages.installToolPrompt(tool, command), messages))) {
      declined.push(tool);
      continue;
    }

    if (runInstaller(command) !== 0) {
      throw new Error(messages.installFailed(tool));
    }

    journal.record("toolInstalled", `${tool} (${binDir})`, null);

    env.PATH = `${binDir}:${env.PATH ?? ""}`;

    if (!isAvailable(tool)) {
      throw new Error(messages.toolStillMissing(tool, binDir));
    }

    console.log(success(messages.toolInstalled(tool, binDir)));
  }

  if (declined.length > 0) {
    throw declinedError(
      messages.toolsDeclined(declined.join(", ")),
      declined.map((tool) => installerFor(tool, home).command),
      messages,
    );
  }
}

function declinedError(message, commands, messages) {
  return Object.assign(new Error(message), {
    declined: true,
    hint: messages.byHand,
    commands,
  });
}

export function pluginPlan(
  { marketplaces, plugins, rcFiles, pluginIds = PLUGIN_IDS },
  messages,
  { rootDir = ROOT_DIR, shellFile = SHELL_FILE } = {},
) {
  return [
    ...(marketplaces.includes(MARKETPLACE_NAME)
      ? []
      : [
          {
            description: messages.planMarketplace(MARKETPLACE_NAME),
            command: `claude plugin marketplace add ${rootDir}`,
          },
        ]),
    ...pluginIds
      .filter((pluginId) => !plugins.includes(pluginId))
      .map((pluginId) => ({
        description: messages.planPlugin(pluginId),
        command: `claude plugin install ${pluginId} --scope user`,
      })),
    ...rcFiles.map((rcFile) => ({
      description: messages.planShellLine(rcFile),
      command: `echo '${sourceLine(shellFile)}' >> "${rcFile}"`,
    })),
  ];
}

function rcFilesWithoutShellLine(shellFile = SHELL_FILE) {
  const { primary, others } = shellRcFiles({
    home: homedir(),
    shell: process.env.SHELL,
    platform: process.platform,
  });

  return (primary ? [primary, ...others] : others).filter(
    (rcFile) => withShellBlock(readText(rcFile) ?? "", shellFile) !== null,
  );
}

async function confirmPluginStep(messages) {
  const { marketplaces, plugins } = whilePending(
    messages.pluginsChecking,
    (done) => {
      const lists = {
        marketplaces: claudeOutput(["plugin", "marketplace", "list"]),
        plugins: claudeOutput(["plugin", "list"]),
      };

      const required = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID];
      const optional = [BCCT_PLUGIN_ID];
      const countInstalled = (pluginIds) =>
        pluginIds.filter((pluginId) => lists.plugins.includes(pluginId)).length;
      const marker = (complete) => (complete ? success : skipped);
      const requiredInstalled = countInstalled(required);
      const optionalInstalled = countInstalled(optional);
      const requiredComplete = requiredInstalled === required.length;
      const registered = lists.marketplaces.includes(MARKETPLACE_NAME);

      done(
        [
          marker(requiredComplete)(messages.pluginsChecked),
          `  ${marker(registered)(registered ? messages.marketplaceFound : messages.marketplaceMissing)}`,
          `  ${marker(requiredComplete)(messages.requiredPlugins(requiredInstalled, required.length))}`,
          `  ${marker(optionalInstalled === optional.length)(messages.optionalPlugins(optionalInstalled, optional.length))}`,
        ].join("\n"),
      );

      return lists;
    },
  );
  const requiredIds = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID];
  const plan = pluginPlan(
    {
      marketplaces,
      plugins,
      rcFiles: rcFilesWithoutShellLine(),
      pluginIds: requiredIds,
    },
    messages,
  );

  if (plan.length > 0) {
    console.log(
      `${messages.planHeader}\n${plan.map(({ description }) => `  • ${description}`).join("\n")}`,
    );

    if (!(await askYesNo(messages.planPrompt, messages))) {
      throw declinedError(
        messages.nothingInstalled,
        plan.map(({ command }) => command),
        messages,
      );
    }
  }

  const hasCommands = plugins.includes(BCCT_PLUGIN_ID);
  const wantsCommands = hasCommands
    ? (await askInstalledCommands(messages)) === "keep"
    : await askYesNo(messages.bcctPrompt, messages);

  return {
    marketplaces,
    plugins,
    pluginIds: wantsCommands ? PLUGIN_IDS : requiredIds,
    removedIds: hasCommands && !wantsCommands ? [BCCT_PLUGIN_ID] : [],
  };
}

function askInstalledCommands(messages, ask = prompter()) {
  const choices = ["keep", "remove"].map((choice, position) => ({
    label: messages.bcctChoices[choice],
    hint: messages.bcctHints[choice],
    answer: choice,
    aliases: [String(position + 1)],
    value: choice,
  }));

  return askChoice(
    { title: messages.bcctInstalledQuestion, choices, index: 0 },
    messages,
    ask,
  );
}

function removePlugin(pluginId, messages) {
  whilePending(messages.pluginRemoving(pluginId), (done) => {
    runClaude(["plugin", "uninstall", pluginId, "--scope", "user"], messages);
    done(success(messages.pluginRemoved(pluginId)));
  });
  journal.record("pluginRemoved", pluginId, () =>
    runClaude(["plugin", "install", pluginId, "--scope", "user"], messages),
  );
}

function ensurePlugins(
  messages,
  { marketplaces, plugins: installed, pluginIds, removedIds = [] },
) {
  for (const pluginId of removedIds) removePlugin(pluginId, messages);

  if (marketplaces.includes(MARKETPLACE_NAME)) {
    console.log(skipped(messages.marketplaceRegistered(MARKETPLACE_NAME)));
  } else {
    whilePending(messages.marketplaceAdding(MARKETPLACE_NAME), (done) => {
      runClaude(["plugin", "marketplace", "add", ROOT_DIR], messages);
      done(success(messages.marketplaceAdded(MARKETPLACE_NAME)));
    });
    journal.record("marketplaceAdded", MARKETPLACE_NAME, () =>
      runClaude(
        ["plugin", "marketplace", "remove", MARKETPLACE_NAME],
        messages,
      ),
    );
  }

  for (const pluginId of pluginIds) {
    if (installed.includes(pluginId)) {
      console.log(skipped(messages.pluginInstalled(pluginId)));
    } else {
      whilePending(messages.pluginInstalling(pluginId), (done) => {
        runClaude(["plugin", "install", pluginId, "--scope", "user"], messages);
        done(success(messages.pluginAdded(pluginId)));
      });
      journal.record("pluginInstalled", pluginId, () =>
        runClaude(
          ["plugin", "uninstall", pluginId, "--scope", "user"],
          messages,
        ),
      );
    }
  }

  const enabled =
    readSettings(claudeSettingsFile(), messages).enabledPlugins ?? {};

  if (enabled[CHANNEL_PLUGIN_ID] === false) {
    console.log(
      skipped(messages.pluginAlreadyDisabledOutside(CHANNEL_PLUGIN_ID)),
    );
  } else {
    whilePending(messages.pluginDisabling(CHANNEL_PLUGIN_ID), (done) => {
      spawnSync(
        "claude",
        ["plugin", "disable", CHANNEL_PLUGIN_ID, "--scope", "user"],
        { stdio: "ignore" },
      );
      done(success(messages.pluginDisabledOutside(CHANNEL_PLUGIN_ID)));
    });
  }

  for (const pluginId of pluginIds.filter((id) => id !== CHANNEL_PLUGIN_ID)) {
    if (enabled[pluginId] === true) {
      console.log(
        installed.includes(pluginId)
          ? skipped(messages.pluginAlreadyEnabled(pluginId))
          : success(messages.pluginEnabled(pluginId)),
      );
      continue;
    }

    whilePending(messages.pluginEnabling(pluginId), (done) => {
      spawnSync("claude", ["plugin", "enable", pluginId, "--scope", "user"], {
        stdio: "ignore",
      });
      done(success(messages.pluginEnabled(pluginId)));
    });
  }
}

function whilePending(text, work) {
  const done = pending(text);
  const stopAndThrow = (error) => {
    done();
    throw error;
  };

  try {
    const result = work(done);

    return result instanceof Promise ? result.catch(stopAndThrow) : result;
  } catch (error) {
    return stopAndThrow(error);
  }
}

async function settled(promise, done) {
  const value = await promise;

  done();
  return value;
}

function showingProgress(text, work) {
  return whilePending(text, (done) => {
    const result = work();

    if (result instanceof Promise) return settled(result, done);

    done();
    return result;
  });
}

async function loadSavedBot(stateDir, messages) {
  const token = parseEnvToken(readText(join(stateDir, ".env")) ?? "");

  if (!token) {
    throw new Error(messages.noSavedToken(`${SETUP_COMMAND} -- token`));
  }

  return savedBot(
    token,
    await showingProgress(messages.savedBotChecking, () =>
      createTelegramApi(token, abortableFetch, messages)("getMe"),
    ),
  );
}

function savedBot(token, bot) {
  return {
    token,
    username: bot.username,
    canJoinGroups: bot.can_join_groups === true,
  };
}

async function ensureToken(stateDir, messages, { offerSaved = true } = {}) {
  const envFile = join(stateDir, ".env");
  const savedToken = parseEnvToken(readText(envFile) ?? "");

  if (savedToken && offerSaved) {
    const bot = await showingProgress(messages.savedBotChecking, () =>
      createTelegramApi(
        savedToken,
        abortableFetch,
        messages,
      )("getMe").catch(() => null),
    );

    if (bot && (await askYesNo(messages.useSavedBot(bot.username), messages))) {
      return savedBot(savedToken, bot);
    }
  }

  const token = await askHidden(messages.tokenPrompt, messages);
  const bot = await showingProgress(messages.tokenChecking, () =>
    createTelegramApi(token, abortableFetch, messages)("getMe"),
  );

  journal.trackDir(stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  journal.trackFile(envFile);
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  console.log(success(messages.tokenSaved(bot.username, envFile)));

  return savedBot(token, bot);
}

async function waitForPairingMessage(callTelegram, offset, messages, code) {
  const deadline = Date.now() + PAIRING_TIMEOUT_MS;
  let nextOffset = offset;

  while (Date.now() < deadline) {
    const updates = await callTelegram("getUpdates", {
      offset: nextOffset,
      timeout: 30,
      allowed_updates: ["message"],
    });
    const candidate = findPairingCandidate(updates, code);

    if (candidate) return candidate;

    nextOffset = Math.max(nextOffset, lastUpdateId(updates) + 1);
  }

  throw new Error(messages.noPairingMessage);
}

export async function pairedAccounts(userIds, token, messages) {
  const getChat = createTelegramApi(token, abortableFetch, messages);
  const labels = await Promise.all(
    userIds.map(async (userId) => {
      const chat = await getChat("getChat", { chat_id: userId }).catch(
        () => null,
      );
      const name = chat?.username ? `@${chat.username}` : chat?.first_name;

      return name ? `${name} (id ${userId})` : `id ${userId}`;
    }),
  );

  return labels.join(", ");
}

function askPairingChoice(accounts, messages, ask = prompter()) {
  return askChoice(
    {
      title: messages.pairingChoiceQuestion(accounts),
      choices: [
        {
          label: messages.pairingChoices.keep,
          answer: "keep",
          aliases: ["n", "no", "não", "nao"],
          value: "keep",
        },
        {
          label: messages.pairingChoices.replace,
          answer: "replace",
          aliases: ["s", "y", "sim", "yes"],
          value: "replace",
        },
      ],
      index: 0,
    },
    messages,
    ask,
  );
}

async function ensurePairing(stateDir, { token, username }, messages) {
  const accessFile = join(stateDir, "access.json");
  const savedAccess = readJsonFile(accessFile);

  if (isPaired(savedAccess)) {
    const accounts = await showingProgress(messages.pairedAccountChecking, () =>
      pairedAccounts(savedAccess.allowFrom, token, messages),
    );

    if ((await askPairingChoice(accounts, messages)) === "keep") {
      console.log(skipped(messages.alreadyPaired(accounts)));
      return;
    }
  }

  const currentAccess = savedAccess && { ...savedAccess, allowFrom: [] };

  if (telegramInstanceRunning(stateDir)) {
    throw new Error(messages.closeInstanceBeforePairing);
  }

  const callTelegram = createTelegramApi(token, abortableFetch, messages);
  const backlog = await showingProgress(messages.pairingPreparing, async () => {
    const webhook = await callTelegram("getWebhookInfo");

    if (webhook.url) {
      throw new Error(messages.webhookConfigured(username));
    }

    return callTelegram("getUpdates", { offset: -1, timeout: 0 });
  });
  const code = pairingCode();

  console.log(
    messages.sendPairingCode(
      username,
      highlightCode(code),
      link(pairingLink(username, code)),
    ),
  );

  const candidate = await showingProgress(messages.pairingWaiting, () =>
    waitForPairingMessage(
      callTelegram,
      lastUpdateId(backlog) + 1,
      messages,
      code,
    ),
  );

  if (
    !(await askYesNo(
      messages.confirmPairing(candidate.label, candidate.userId),
      messages,
    ))
  ) {
    throw new Error(messages.pairingCancelled);
  }

  journal.trackFile(accessFile);
  writeFileSync(
    accessFile,
    `${JSON.stringify(buildAccess(currentAccess, candidate.userId), null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await whilePending(messages.pairingFinishing, async (done) => {
    await callTelegram("getUpdates", {
      offset: candidate.updateId + 1,
      timeout: 0,
    });
    await callTelegram("sendMessage", {
      chat_id: candidate.userId,
      text: messages.pairedChatMessage,
    });
    done(success(messages.pairedWith(candidate.label)));
  });
}

async function ensureLanguage(appDir) {
  const current = setupLocale(appDir);
  const saved = LOCALES.includes(readConfig(appDir).language);
  const language = await askLanguage(
    current,
    messagesFor(current),
    prompter(),
    {
      saved,
    },
  );

  if (keptSetting("language", language, appDir, messagesFor(language))) {
    return;
  }

  const configFile = updateConfig(appDir, { language });

  console.log(
    success(messagesFor(language).languageSaved(language, configFile)),
  );
}

async function ensureDelay(appDir, messages) {
  const currentMinutes = parseDelayMinutes(
    String(readConfig(appDir).delayMinutes ?? ""),
    DEFAULT_DELAY_MINUTES,
  );
  const saved = "delayMinutes" in readConfig(appDir);
  const delayMinutes = await askDelay(currentMinutes, messages, prompter(), {
    saved,
  });

  if (keptSetting("delay", delayMinutes, appDir, messages)) return;

  const configFile = updateConfig(appDir, { delayMinutes });

  console.log(success(messages.delaySaved(delayMinutes, configFile)));
}

async function ensureQuietHours(appDir, messages) {
  const currentQuiet = parseQuietHours(
    formatQuietHours(readConfig(appDir).quietHours),
    null,
  );
  const saved = "quietHours" in readConfig(appDir);
  const quietHours = await askQuietHours(currentQuiet, messages, prompter(), {
    saved,
  });

  if (keptSetting("quiet-hours", quietHours, appDir, messages)) return;

  const configFile = updateConfig(appDir, { quietHours });

  console.log(
    success(
      messages.quietSaved(
        formatQuietHours(quietHours) || messages.quietOff,
        configFile,
      ),
    ),
  );
}

function runOrThrow(command, args, description, messages) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

    throw new Error(
      [messages.failed(description), said].filter(Boolean).join("\n"),
    );
  }
}

export function whisperPythonWorks(python) {
  return (
    spawnSync(
      python,
      [
        "-c",
        `import importlib.metadata as m; assert m.version("faster-whisper") == "${FASTER_WHISPER_VERSION}" and m.version("av") == "${PYAV_VERSION}"`,
      ],
      { stdio: "ignore" },
    ).status === 0
  );
}

function createWhisperEnv(venvDir, messages) {
  const python = join(venvDir, "bin", "python");

  if (hasCommand("uv")) {
    showingProgress(messages.whisperEnvCreating, () =>
      runOrThrow(
        "uv",
        ["venv", venvDir, "--python", "python3", "-q"],
        "uv venv",
        messages,
      ),
    );
    showingProgress(messages.whisperInstalling, () =>
      runOrThrow(
        "uv",
        ["pip", "install", "-q", "--python", python, ...WHISPER_PACKAGES],
        messages.installWhisper,
        messages,
      ),
    );
    return python;
  }

  showingProgress(messages.whisperEnvCreating, () => {
    if (
      spawnSync("python3", ["-m", "venv", venvDir], { stdio: "ignore" })
        .status !== 0
    ) {
      throw new Error(messages.pythonEnvFailed);
    }
  });
  showingProgress(messages.whisperInstalling, () =>
    runOrThrow(
      join(venvDir, "bin", "pip"),
      ["install", "-q", ...WHISPER_PACKAGES],
      messages.installWhisper,
      messages,
    ),
  );
  return python;
}

async function ensureTranscription(appDir, messages) {
  console.log(note(messages.transcriptionPurpose));

  const currentConfig = readConfig(appDir);
  const currentModel =
    "transcription" in currentConfig && !currentConfig.transcription
      ? null
      : parseTranscriptionModel(
          String(currentConfig.transcription?.model ?? ""),
          DEFAULT_TRANSCRIPTION_MODEL,
        );
  const saved = "transcription" in currentConfig;
  const model = await askTranscription(currentModel, messages, prompter(), {
    saved,
    installed: TRANSCRIPTION_MODELS.filter(modelInstalled),
  });

  if (model === UNINSTALL) {
    await uninstallModels(appDir, saved ? currentModel : null, messages);
    return;
  }

  if (keptSetting("transcription", model, appDir, messages)) return;

  await applyTranscription(appDir, model, messages);

  const others = TRANSCRIPTION_MODELS.filter(
    (installed) => installed !== model && modelInstalled(installed),
  );

  if (model === null || others.length === 0) return;

  removeModels(
    await askRemoveModels(
      others,
      saved ? currentModel : null,
      messages,
      prompter(),
      {
        tag: messages.modelUsedUntilNow,
      },
    ),
    messages,
  );
}

function removeModels(models, messages) {
  for (const model of models) {
    showingProgress(messages.modelRemoving(model), () =>
      rmSync(modelDir(model), { recursive: true, force: true }),
    );
  }

  if (models.length > 0) {
    console.log(success(messages.modelsRemoved(models.join("\n  • "))));
  }
}

async function uninstallModels(appDir, inUse, messages) {
  const installed = TRANSCRIPTION_MODELS.filter(modelInstalled);
  const removed =
    installed.length === 1
      ? installed
      : await askRemoveModels(installed, inUse, messages);

  if (removed.length === 0) return;

  removeModels(removed, messages);

  if (!TRANSCRIPTION_MODELS.some(modelInstalled)) {
    rmSync(join(appDir, "whisper"), { recursive: true, force: true });
  }

  if (inUse === null || removed.includes(inUse)) {
    updateConfig(appDir, { transcription: null });
    console.log(success(messages.transcriptionDisabled));
  }
}

export function askRemoveModels(
  others,
  previous,
  messages,
  ask = prompter(),
  { tag = messages.modelInUse } = {},
) {
  const each = others.map((model) => ({
    label:
      model === previous
        ? `${messages.removeModel(model)} (${tag})`
        : messages.removeModel(model),
    answer: model,
    value: [model],
  }));
  const all =
    others.length > 1
      ? [
          {
            label: messages.removeModelsAll(others.join(", ")),
            answer: "all",
            value: others,
          },
        ]
      : [];

  return askChoice(
    {
      title: messages.removeModelsQuestion,
      choices: [
        {
          label: messages.removeModelsKeep,
          answer: "keep",
          aliases: ["n", "no", "não", "nao"],
          value: [],
        },
        ...all,
        ...each,
      ],
      index: 0,
    },
    messages,
    ask,
  );
}

function keptMessage(step, value, config, appDir, messages) {
  if (step === "language") {
    return LOCALES.includes(config.language) && config.language === value
      ? messages.languageKept(value)
      : null;
  }

  if (step === "delay") {
    return config.delayMinutes === value ? messages.delayKept(value) : null;
  }

  if (step === "quiet-hours") {
    return "quietHours" in config &&
      formatQuietHours(config.quietHours) === formatQuietHours(value)
      ? messages.quietKept(formatQuietHours(value) || messages.quietOff)
      : null;
  }

  if (step === "inbox") {
    return "inboxRetentionDays" in config && config.inboxRetentionDays === value
      ? messages.inboxKept(
          value === null ? messages.inboxForever : messages.inboxDays(value),
        )
      : null;
  }

  if (!("transcription" in config)) return null;
  if ((config.transcription?.model ?? null) !== value) return null;
  if (value === null) return messages.transcriptionKeptOff;

  return modelInstalled(value) && whisperPythonWorks(whisperPython(appDir))
    ? messages.transcriptionModelKept(value)
    : null;
}

function keptSetting(step, value, appDir, messages) {
  const message = keptMessage(
    step,
    value,
    readConfig(appDir),
    appDir,
    messages,
  );

  if (message === null) return false;

  console.log(skipped(message));

  return true;
}

function modelDir(model) {
  return join(
    huggingFaceCacheDir(),
    `models--Systran--faster-whisper-${model}`,
  );
}

function modelInstalled(model) {
  return existsSync(modelDir(model));
}

function whisperPython(appDir) {
  return join(appDir, "whisper", "venv", "bin", "python");
}

async function applyTranscription(appDir, model, messages) {
  updateConfig(appDir, { transcription: model ? { model } : null });

  if (!model) {
    console.log(success(messages.transcriptionDisabled));
    return;
  }

  const venvDir = join(appDir, "whisper", "venv");
  const existingPython = whisperPython(appDir);
  const reuse = whisperPythonWorks(existingPython);

  if (reuse && modelInstalled(model)) {
    console.log(success(messages.transcriptionSwitched(model)));
    return;
  }

  if (!reuse && !hasCommand("uv") && !hasCommand("python3")) {
    await ensureRequirements(["uv"], messages);
  }

  journal.trackDir(join(appDir, "whisper"));

  const python = reuse ? existingPython : createWhisperEnv(venvDir, messages);

  journal.trackDir(
    join(huggingFaceCacheDir(), `models--Systran--faster-whisper-${model}`),
  );
  whilePending(messages.downloadingModel(model), (done) => {
    runOrThrow(
      python,
      [TRANSCRIBE_SCRIPT, "--download-only", "--model", model],
      messages.modelDownload,
      messages,
    );
    done(success(messages.transcriptionReady(model)));
  });
}

export function claudeSettingsFile(env = process.env) {
  return join(
    env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
}

export function readSettings(settingsFile, messages) {
  const text = readText(settingsFile);

  if (text === null) return {};

  let settings;

  try {
    settings = JSON.parse(text);
  } catch {
    settings = null;
  }

  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  ) {
    throw new Error(messages.settingsInvalid(settingsFile));
  }

  return settings;
}

export function writeJsonAtomic(file, data) {
  journal.trackFile(file);

  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const temporary = `${target}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
}

function savePreviousStatusline(appDir, statusLine) {
  journal.trackDir(appDir);
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  journal.trackFile(join(appDir, PREVIOUS_STATUSLINE_FILE));
  writeFileSync(
    join(appDir, PREVIOUS_STATUSLINE_FILE),
    JSON.stringify(statusLine),
    { mode: 0o600 },
  );
}

async function ensureStatusline(appDir, messages) {
  const settings = readSettings(claudeSettingsFile(), messages);
  const current = settings.statusLine;

  if (isOurStatusline(current)) {
    const restores = existsSync(join(appDir, PREVIOUS_STATUSLINE_FILE));

    if ((await askOurStatusline(restores, messages)) === "remove") {
      applyStatusline(appDir, "off", messages);
    } else {
      console.log(skipped(messages.statuslineOursKept));
    }

    return;
  }

  if (!current) {
    const wanted = await askYesNo(
      messages.statuslinePrompt(statuslineExample(messages)),
      messages,
      false,
    );

    if (!wanted) console.log(messages.statuslineSkipped);
    else applyStatusline(appDir, "on", messages);

    return;
  }

  applyStatusline(
    appDir,
    await askStatuslineChoice(
      statuslinePreview(current),
      messages,
      prompter(),
      {
        customized: readConfig(appDir).statuslineCustomized === true,
      },
    ),
    messages,
  );
}

export function withoutOurStatusline(settings, appDir) {
  if (!isOurStatusline(settings.statusLine)) return null;

  const previousFile = join(appDir, PREVIOUS_STATUSLINE_FILE);
  const previous = readJsonFile(previousFile);
  const { statusLine: _ours, ...rest } = settings;

  rmSync(previousFile, { force: true });

  return previous
    ? { settings: { ...rest, statusLine: previous }, restored: true }
    : { settings: rest, restored: false };
}

function requestStatuslineCustom(appDir, current, messages) {
  if (!current || isOurStatusline(current)) {
    throw new Error(messages.statuslineCustomNeedsOwn);
  }

  const requestFile = join(appDir, STATUSLINE_REQUEST_FILE);

  journal.trackDir(appDir);
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  journal.trackFile(requestFile);
  writeFileSync(
    requestFile,
    `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  console.log(success(messages.statuslineCustomRequested));
}

function forgetStatuslineRequest(appDir) {
  const requestFile = join(appDir, STATUSLINE_REQUEST_FILE);

  if (!existsSync(requestFile)) return;

  journal.trackFile(requestFile);
  rmSync(requestFile, { force: true });
}

function forgetStatuslineCustomized(appDir) {
  const { statuslineCustomized, ...rest } = readConfig(appDir);

  if (statuslineCustomized === undefined) return;

  const configFile = join(appDir, CONFIG_FILE);

  journal.trackFile(configFile);
  writeFileSync(configFile, `${JSON.stringify(rest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function statuslinePrompt(
  { take = false } = {},
  appDir = defaultAppDir(),
  settingsFile = claudeSettingsFile(),
) {
  const requestFile = join(appDir, STATUSLINE_REQUEST_FILE);

  if (take && !existsSync(requestFile)) return "";
  if (take) rmSync(requestFile, { force: true });

  const current = readJsonFile(settingsFile)?.statusLine;

  if (statuslineKind(current) !== "other") return "";
  if (take) updateConfig(appDir, { statuslineCustomized: true });

  const messages = messagesFor(setupLocale(appDir));

  return messages.statuslineCustomPrompt(
    settingsFile,
    JSON.stringify(current),
    statuslineCommand(),
    messages.statusConnected(messages.statusMain),
  );
}

export function markLaunch(appDir = defaultAppDir(), now = Date.now()) {
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(appDir, LAUNCH_FILE),
    `${JSON.stringify({ launchedAt: now })}\n`,
    { mode: 0o600 },
  );
}

function applyStatusline(appDir, choice, messages) {
  const settingsFile = claudeSettingsFile();
  const settings = readSettings(settingsFile, messages);
  const command = statuslineCommand();
  const current = settings.statusLine;

  if (choice === "custom") {
    requestStatuslineCustom(appDir, current, messages);
    return;
  }

  forgetStatuslineRequest(appDir);

  if (choice === "off") {
    const removed = withoutOurStatusline(settings, appDir);

    if (removed === null) {
      console.log(messages.statuslineSkipped);
      return;
    }

    writeJsonAtomic(settingsFile, removed.settings);
    console.log(
      success(
        removed.restored
          ? messages.statuslineRestored(settingsFile)
          : messages.statuslineRemoved(settingsFile),
      ),
    );
    return;
  }

  if (isOurStatusline(current)) {
    console.log(skipped(messages.statuslineAlready));
    return;
  }

  if (!current) {
    forgetStatuslineCustomized(appDir);
    writeJsonAtomic(settingsFile, withStatusline(settings, command));
    console.log(success(messages.statuslineInstalled(settingsFile)));
    return;
  }

  if (choice === "after") {
    forgetStatuslineCustomized(appDir);
    savePreviousStatusline(appDir, current);
    writeJsonAtomic(settingsFile, {
      ...settings,
      statusLine: { type: "command", command: statuslineAfterCommand() },
    });
    console.log(success(messages.statuslineChained(settingsFile)));
    return;
  }

  if (choice === "replace") {
    const backup = `${settingsFile}.bak.${Date.now()}`;

    forgetStatuslineCustomized(appDir);
    journal.trackFile(backup);
    copyFileSync(settingsFile, backup);
    chmodSync(backup, 0o600);
    savePreviousStatusline(appDir, current);
    writeJsonAtomic(settingsFile, {
      ...settings,
      statusLine: { type: "command", command },
    });
    console.log(success(messages.statuslineReplaced(settingsFile, backup)));
    return;
  }

  console.log(
    skipped(
      readConfig(appDir).statuslineCustomized === true
        ? messages.statuslineCustomKept
        : messages.statuslineKept,
    ),
  );
}

function ensureEnvDenied(stateDir, messages) {
  const settingsFile = claudeSettingsFile();
  const envFile = join(stateDir, ".env");
  const denied = withEnvDenied(
    readSettings(settingsFile, messages),
    envDenyRule(envFile),
  );

  if (denied === null) {
    console.log(skipped(messages.envAlreadyProtected(envFile, settingsFile)));
    return;
  }

  writeJsonAtomic(settingsFile, denied);
  console.log(success(messages.envProtected(envFile, settingsFile)));
}

async function main(args) {
  const stateDir = telegramStateDir();
  const appDir = defaultAppDir();
  const sections = parseSetupSections(args, messagesFor(setupLocale(appDir)));
  const runsAll = sections.length === SETUP_SECTIONS.length;

  if (!nodeVersionOk()) {
    throw new Error(
      messagesFor(setupLocale(appDir)).nodeTooOld(
        process.versions.node,
        MINIMUM_NODE,
      ),
    );
  }

  console.log(note(enterKeepsDefault(appDir)));

  let messages = messagesFor(setupLocale(appDir));
  const steps = runsAll ? [...sections, "health"] : sections;
  const begin = (section) => {
    if (!steps.includes(section)) return false;

    console.log(
      stepHeading(
        steps.indexOf(section) + 1,
        steps.length,
        messages.stepTitles[section],
        STEP_ICONS[section],
      ),
    );

    return true;
  };

  if (begin("language")) await ensureLanguage(appDir);

  messages = messagesFor(setupLocale(appDir));

  if (begin("plugin")) {
    await ensureRequirements(REQUIRED_TOOLS, messages);
    ensurePlugins(messages, await confirmPluginStep(messages));
    installShellFunction({}, messages);
  }

  if (sections.includes("token") || sections.includes("pairing")) {
    const bot = begin("token")
      ? await ensureToken(stateDir, messages, { offerSaved: runsAll })
      : await loadSavedBot(stateDir, messages);

    if (sections.includes("token")) {
      ensureEnvDenied(stateDir, messages);

      if (bot.canJoinGroups) {
        console.log(warn(messages.groupsWarning(bot.username)));
      }
    }

    if (begin("pairing")) {
      await ensurePairing(stateDir, bot, messages);
    }
  }

  if (begin("delay")) await ensureDelay(appDir, messages);
  if (begin("quiet-hours")) await ensureQuietHours(appDir, messages);
  if (begin("transcription")) await ensureTranscription(appDir, messages);
  if (begin("inbox")) await ensureInbox(appDir, messages);
  if (begin("statusline")) await ensureStatusline(appDir, messages);
  if (begin("health")) await finalCheck(messages);

  const needsReopen =
    sections.includes("plugin") ||
    sections.includes("token") ||
    sections.includes("pairing");

  console.log(
    `\n${success(
      runsAll
        ? messages.doneAll
        : needsReopen
          ? messages.doneReopen
          : messages.doneLive,
    )}`,
  );
}

export const SETTABLE_STEPS = [
  "language",
  "delay",
  "quiet-hours",
  "transcription",
  "inbox",
  "statusline",
];

const STATUSLINE_CHOICES = new Set(["on", "after", "replace", "custom", "off"]);

async function applySetting(step, value, { appDir, messages }) {
  if (!SETTABLE_STEPS.includes(step)) {
    throw new Error(messages.notSettable(step, SETTABLE_STEPS.join(", ")));
  }

  const invalid = () =>
    new Error(
      messages.invalidSetting(step, value, messages.settingHints[step]),
    );
  const parsers = {
    language: (text) => parseLocale(text, INVALID),
    delay: (text) => parseDelayMinutes(text, INVALID),
    "quiet-hours": (text) => parseQuietHours(text, INVALID),
    transcription: (text) => parseTranscriptionModel(text, INVALID),
    inbox: (text) => parseInboxDays(text, INVALID),
  };
  const parsed = parsers[step]?.(value);

  if (parsed === INVALID) throw invalid();

  if (
    step in parsers &&
    keptSetting(
      step,
      parsed,
      appDir,
      step === "language" ? messagesFor(parsed) : messages,
    )
  ) {
    return;
  }

  if (step === "language") {
    const language = parseLocale(value, INVALID);

    if (language === INVALID) throw invalid();

    const configFile = updateConfig(appDir, { language });

    console.log(
      success(messagesFor(language).languageSaved(language, configFile)),
    );
  }

  if (step === "delay") {
    const delayMinutes = parseDelayMinutes(value, INVALID);

    if (delayMinutes === INVALID) throw invalid();

    console.log(
      success(
        messages.delaySaved(
          delayMinutes,
          updateConfig(appDir, { delayMinutes }),
        ),
      ),
    );
  }

  if (step === "quiet-hours") {
    const quietHours = parseQuietHours(value, INVALID);

    if (quietHours === INVALID) throw invalid();

    console.log(
      success(
        messages.quietSaved(
          formatQuietHours(quietHours) || messages.quietOff,
          updateConfig(appDir, { quietHours }),
        ),
      ),
    );
  }

  if (step === "transcription") {
    const model = parseTranscriptionModel(value, INVALID);

    if (model === INVALID) throw invalid();

    await applyTranscription(appDir, model, messages);
  }

  if (step === "inbox") {
    const days = parseInboxDays(value, INVALID);

    if (days === INVALID) throw invalid();

    saveInboxDays(appDir, days, messages);
  }

  if (step === "statusline") {
    const choice = value.trim().toLowerCase();

    if (!STATUSLINE_CHOICES.has(choice)) throw invalid();

    applyStatusline(appDir, choice, messages);
  }
}

function statuslineKind(statusLine) {
  if (!statusLine) return "none";
  if (statusLine.command === statuslineCommand()) return "ours";

  return statusLine.command === statuslineAfterCommand()
    ? "ours-after"
    : "other";
}

export function currentState(
  stateDir,
  appDir,
  settingsFile = claudeSettingsFile(),
) {
  const config = readConfig(appDir);
  const kind = statuslineKind(readJsonFile(settingsFile)?.statusLine);
  const requested = existsSync(join(appDir, STATUSLINE_REQUEST_FILE));
  const customized = config.statuslineCustomized === true;
  const statusline =
    kind !== "other"
      ? kind
      : requested
        ? "custom-pending"
        : customized
          ? "custom"
          : "other";

  return {
    language: setupLocale(appDir),
    delayMinutes: parseDelayMinutes(
      String(config.delayMinutes ?? ""),
      DEFAULT_DELAY_MINUTES,
    ),
    quietHours: config.quietHours ?? null,
    transcription: config.transcription?.model ?? null,
    inboxRetentionDays: currentInboxDays(appDir),
    statusline,
    token: Boolean(parseEnvToken(readText(join(stateDir, ".env")) ?? "")),
    pairedAccounts:
      readJsonFile(join(stateDir, "access.json"))?.allowFrom?.length ?? 0,
  };
}

function runCommandLine(args) {
  const stateDir = telegramStateDir();
  const appDir = defaultAppDir();
  const messages = messagesFor(setupLocale(appDir));

  if (args[0] === "--uninstall") {
    return uninstall({ stateDir, appDir }, messages);
  }

  if (args[0] === "--set") {
    return applySetting(args[1] ?? "", args[2] ?? "", { appDir, messages });
  }

  return runSetup(args);
}

function reportStop(error) {
  if (!error.declined) {
    console.error(fail(error.message));
    return;
  }

  console.log(success(error.message));
  console.log(
    [info(error.hint), ...error.commands.map(highlightCode)].join("\n"),
  );
}

async function runSetup(args) {
  const terminal = prompter();

  if (!terminal.interactive) return main(args);

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    interruption.abort();
  };

  activePrompter = guardCancel(terminal);
  process.on("SIGINT", onInterrupt);

  try {
    await main(args);
  } catch (error) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    const stopped = interrupted || error.interrupted === true;
    const messages = messagesFor(setupLocale(defaultAppDir()));

    if (stopped) {
      console.error(warn(messages.interrupted));
    } else {
      reportStop(error);
    }

    await offerUndo(journal, messages, terminal, { interrupted: stopped });
    process.exitCode = stopped ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stateDir = telegramStateDir();

  if (process.argv[2] === "--check") {
    process.exitCode = checkSetup(stateDir, telegramInstanceRunning, {
      args: process.argv.slice(3),
    });
  } else if (process.argv[2] === "--statusline-prompt") {
    const request = statuslinePrompt({ take: process.argv.includes("--take") });

    if (request) console.log(request);
  } else if (process.argv[2] === "--mark-launch") {
    markLaunch();
  } else if (process.argv[2] === "--show") {
    console.log(
      JSON.stringify(currentState(stateDir, defaultAppDir()), null, 2),
    );
  } else {
    runCommandLine(process.argv.slice(2))
      .catch((error) => {
        reportStop(error);
        process.exitCode = 1;
      })
      .finally(() => activePrompter?.close());
  }
}
