import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { messagesFor } from "../plugins/telegram-hooks/lib/messages.mjs";
import {
  CONFIG_FILE,
  HEALTH_FILE,
  LAUNCH_FILE,
  readConfig,
  readJsonFile,
} from "../plugins/telegram-hooks/lib/state.mjs";
import {
  TELEGRAM_HEALTH_TTL_MS,
  TELEGRAM_LAUNCH_GRACE_MS,
} from "../plugins/telegram-hooks/statusline.mjs";
import {
  CHANNEL_PLUGIN_ID,
  HOOKS_PLUGIN_ID,
  MINIMUM_NODE,
  SETUP_COMMAND,
  claudeOutput,
  claudeSettingsFile,
  createTelegramApi,
  currentState,
  defaultAppDir,
  envDenyRule,
  hasCommand,
  nodeVersionOk,
  pairedAccounts,
  parseEnvToken,
  rcLoadsShellFile,
  readSettings,
  readText,
  setupLocale,
  shellRcFiles,
  telegramStateDir,
  whisperPythonWorks,
} from "./setup.mjs";
import { fail, pending, section, skipped, success } from "./ui.mjs";

export const HEALTH_GROUPS = ["install", "telegram", "security", "extras"];

const SHELL_FILE = join(import.meta.dirname, "shell.sh");
const ALL_ANSWERS = new Set(["all", "tudo"]);
const STATUSLINE_WITH_INDICATOR = new Set(["ours", "ours-after", "custom"]);

export function parseHealthGroups(args, messages) {
  const requested = args.map((arg) => arg.trim().toLowerCase()).filter(Boolean);

  if (requested.length === 0 || requested.some((arg) => ALL_ANSWERS.has(arg))) {
    return HEALTH_GROUPS;
  }

  const unknown = requested.filter((arg) => !HEALTH_GROUPS.includes(arg));

  if (unknown.length > 0) {
    throw new Error(
      messages.unknownHealthGroups(
        unknown.join(", "),
        HEALTH_GROUPS.join(", "),
      ),
    );
  }

  return HEALTH_GROUPS.filter((group) => requested.includes(group));
}

function once(compute) {
  let computed = false;
  let value;

  return () => {
    if (!computed) {
      value = compute();
      computed = true;
    }

    return value;
  };
}

function shellCheck(messages, deps) {
  const detail = messages.healthDetail;
  const { primary, others, unsupported } = shellRcFiles({
    home: deps.home,
    shell: deps.shell,
  });
  const loadedBy = [primary, ...others]
    .filter(Boolean)
    .find((rcFile) => rcLoadsShellFile(readText(rcFile) ?? "", deps.shellFile));

  if (loadedBy) return { status: "ok", detail: detail.loadedIn(loadedBy) };

  return unsupported
    ? {
        status: "off",
        detail: messages.shellUnsupported(unsupported, deps.shellFile),
      }
    : { status: "fail", detail: detail.notLoaded(primary) };
}

function installChecks(messages, deps) {
  const detail = messages.healthDetail;
  const tool = (name) =>
    deps.hasCommand(name)
      ? { status: "ok", detail: detail.found }
      : { status: "fail", detail: detail.missing };

  return {
    node: () =>
      nodeVersionOk(deps.nodeVersion)
        ? { status: "ok", detail: detail.version(deps.nodeVersion) }
        : {
            status: "fail",
            detail: messages.nodeTooOld(deps.nodeVersion, MINIMUM_NODE),
          },
    claude: () => tool("claude"),
    bun: () => tool("bun"),
    plugins: () => {
      const pluginList = deps.hasCommand("claude")
        ? deps.claudeOutput(["plugin", "list"])
        : "";
      const missing = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID].filter(
        (pluginId) => !pluginList.includes(pluginId),
      );

      return missing.length === 0
        ? { status: "ok", detail: detail.installed }
        : { status: "fail", detail: detail.notInstalled(missing.join(", ")) };
    },
    shell: () => shellCheck(messages, deps),
  };
}

function pairingCheck(access, messages, account) {
  const detail = messages.healthDetail;
  const accounts = access.allowFrom?.length ?? 0;
  const waiting = Object.keys(access.pending ?? {}).length;
  const groups = Object.keys(access.groups ?? {}).length;
  const failed = (text) => ({ status: "fail", detail: text });

  if (accounts === 0) return failed(detail.notPaired);
  if (accounts > 1) {
    return failed(
      messages.tooManyAccounts(accounts, `${SETUP_COMMAND}:pairing`),
    );
  }
  if (access.dmPolicy !== "allowlist") {
    return failed(detail.notAllowlist(access.dmPolicy ?? "pairing"));
  }
  if (waiting > 0) return failed(detail.pendingPairings(waiting));
  if (groups > 0) return failed(detail.groupsAllowed(groups));

  return { status: "ok", detail: detail.paired(account) };
}

function telegramChecks(messages, deps) {
  const detail = messages.healthDetail;
  const token = parseEnvToken(readText(join(deps.stateDir, ".env")) ?? "");
  const bot = once(() =>
    token
      ? deps.callTelegram(token).then(
          (found) => ({ found }),
          (error) => ({ error }),
        )
      : Promise.resolve(null),
  );

  return {
    token: async () => {
      const answer = await bot();

      if (!answer) return { status: "fail", detail: detail.noToken };

      return answer.error
        ? { status: "fail", detail: answer.error.message }
        : { status: "ok", detail: detail.bot(answer.found.username) };
    },
    groups: async () => {
      const answer = await bot();

      if (!answer || answer.error) {
        return { status: "off", detail: detail.groupsUnknown };
      }

      return answer.found.can_join_groups
        ? {
            status: "fail",
            detail: messages.groupsWarning(answer.found.username),
          }
        : { status: "ok", detail: detail.groupsOff };
    },
    pairing: async () => {
      const access = readJsonFile(join(deps.stateDir, "access.json")) ?? {};
      const allowed = access.allowFrom ?? [];
      const account =
        token && allowed.length === 1
          ? await deps
              .describeAccounts(token, allowed)
              .catch(() => `id ${allowed[0]}`)
          : `id ${allowed[0]}`;

      return pairingCheck(access, messages, account);
    },
    polling: () => {
      const health = readJsonFile(join(deps.appDir, HEALTH_FILE));
      const fresh =
        health !== null &&
        deps.now - Number(health.checkedAt) < TELEGRAM_HEALTH_TTL_MS;
      const launch = readJsonFile(join(deps.appDir, LAUNCH_FILE));
      const launching =
        deps.now - Number(launch?.launchedAt) < TELEGRAM_LAUNCH_GRACE_MS;

      if (fresh && health.polling) {
        return { status: "ok", detail: detail.connected };
      }

      if (launching) return { status: "off", detail: detail.connecting };

      if (fresh) return { status: "fail", detail: detail.down };

      return deps.telegramInstance
        ? { status: "fail", detail: detail.downHere }
        : { status: "off", detail: detail.notOpen };
    },
  };
}

function configCheck(messages, deps) {
  const detail = messages.healthDetail;
  const configFile = join(deps.appDir, CONFIG_FILE);

  try {
    readSettings(deps.settingsFile, messages);
  } catch (error) {
    return { status: "fail", detail: error.message };
  }

  return readText(configFile) !== null && readJsonFile(configFile) === null
    ? { status: "fail", detail: detail.invalid(configFile) }
    : { status: "ok", detail: detail.valid };
}

function securityChecks(messages, deps) {
  const detail = messages.healthDetail;

  return {
    user: () =>
      deps.uid === 0
        ? { status: "fail", detail: detail.root }
        : { status: "ok", detail: detail.regularUser },
    protection: () => {
      const rule = envDenyRule(join(deps.stateDir, ".env"), deps.home);
      const deny = readJsonFile(deps.settingsFile)?.permissions?.deny ?? [];

      return deny.includes(rule)
        ? { status: "ok", detail: detail.protected }
        : {
            status: "fail",
            detail: detail.unprotected(`${SETUP_COMMAND}:token`),
          };
    },
    config: () => configCheck(messages, deps),
  };
}

function extrasChecks(messages, deps) {
  const detail = messages.healthDetail;

  return {
    transcription: () => {
      const model = readConfig(deps.appDir).transcription?.model;
      const python = join(deps.appDir, "whisper", "venv", "bin", "python");

      if (!model) return { status: "off", detail: detail.off };

      return deps.pythonWorks(python)
        ? { status: "ok", detail: detail.model(model) }
        : {
            status: "fail",
            detail: detail.broken(`${SETUP_COMMAND}:transcription`),
          };
    },
    mermaid: () =>
      deps.hasCommand("mmdc")
        ? { status: "ok", detail: detail.found }
        : { status: "off", detail: detail.missing },
    statusline: () => {
      const { statusline } = currentState(
        deps.stateDir,
        deps.appDir,
        deps.settingsFile,
      );

      return {
        status: STATUSLINE_WITH_INDICATOR.has(statusline) ? "ok" : "off",
        detail: detail.statusline[statusline],
      };
    },
  };
}

const GROUP_CHECKS = {
  install: installChecks,
  telegram: telegramChecks,
  security: securityChecks,
  extras: extrasChecks,
};

export async function runHealth(
  groups,
  messages,
  {
    stateDir = telegramStateDir(),
    appDir = defaultAppDir(),
    home,
    shell = process.env.SHELL,
    settingsFile = claudeSettingsFile(),
    shellFile = SHELL_FILE,
    nodeVersion = process.versions.node,
    hasCommand: isAvailable = hasCommand,
    claudeOutput: readClaude = claudeOutput,
    callTelegram = (token) =>
      createTelegramApi(token, fetch, messages)("getMe"),
    pythonWorks = whisperPythonWorks,
    describeAccounts = (token, userIds) =>
      pairedAccounts(userIds, token, messages),
    uid = process.getuid?.(),
    telegramInstance = process.env.BETTER_CC_TELEGRAM === "1",
    now = Date.now(),
    onGroup = () => {},
    onStart = () => {},
    onResult = () => {},
  } = {},
) {
  const deps = {
    uid,
    telegramInstance,
    stateDir,
    appDir,
    home: home ?? process.env.HOME,
    shell,
    settingsFile,
    shellFile,
    nodeVersion,
    hasCommand: isAvailable,
    claudeOutput: readClaude,
    callTelegram,
    pythonWorks,
    describeAccounts,
    now,
  };
  const results = [];

  for (const group of groups) {
    onGroup(group);

    for (const [check, run] of Object.entries(
      GROUP_CHECKS[group](messages, deps),
    )) {
      onStart({ group, check });

      const entry = { group, check, ...(await run()) };

      results.push(entry);
      onResult(entry);
    }
  }

  return results;
}

const STATUS_MARKS = {
  ok: success,
  fail: (text) => fail(text, process.stdout),
  off: skipped,
};

export function formatHealth(results, messages) {
  return results
    .map(({ check, status, detail }) =>
      STATUS_MARKS[status](`${messages.healthLabels[check]}: ${detail}`),
    )
    .join("\n");
}

export function printingProgress(messages, output = process.stdout) {
  let finish = () => {};

  return {
    onGroup: (group) =>
      output.write(`${section(messages.healthGroupTitles[group])}\n`),
    onStart: ({ check }) => {
      finish = pending(`${messages.healthLabels[check]}…`, output);
    },
    onResult: (result) => finish(formatHealth([result], messages)),
  };
}

async function main(args) {
  const messages = messagesFor(setupLocale(defaultAppDir()));
  const json = args.includes("--json");
  const groups = parseHealthGroups(
    args.filter((arg) => arg !== "--json"),
    messages,
  );
  const results = await runHealth(
    groups,
    messages,
    json ? {} : printingProgress(messages),
  );

  if (json) console.log(JSON.stringify(results, null, 2));

  if (results.some((result) => result.status === "fail")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(fail(error.message));
    process.exitCode = 1;
  });
}
