import { DEFAULT_LOCALE, LOCALES } from "./state.mjs";

const enUs = {
  statusMain: "(Main)",
  statusSecondary: "(Secondary)",
  statusConnected: (role) => `📱 ${role} Telegram connected`,
  statusDown: (role) => `📱 ${role} Telegram down`,
  statusConnecting: (role) => `📱 ${role} Telegram connecting…`,
  stepLabels: { token: "bot token", pairing: "pairing" },
  stepTitles: {
    language: "Language / Idioma",
    plugin: "Plugins",
    token: "Bot token",
    pairing: "Pairing",
    delay: "Wait time",
    "quiet-hours": "Quiet hours",
    transcription: "Audio transcription",
    inbox: "Received files",
    statusline: "Status line",
    path: "bcct command in the terminal",
    health: "Final check",
  },
  healthHasFailures: (command) =>
    `Some checks failed. Fix what is marked with ✘ and run '${command}' again.`,
  notConfigured: (missing, command) =>
    `'claude --telegram' is not set up yet. Missing:\n  • ${missing}\nRun '${command}' first.`,
  alreadyRunning: (pid) =>
    `A 'claude --telegram' instance is already open (bot in process ${pid}). Close it before opening another one.`,
  unknownSteps: (unknown, all) =>
    `Unknown step:\n  • ${unknown}\nUse one or more of these (none runs them all):\n  • ${all}`,
  networkFailure: (method) => `Network failure calling Telegram (${method}).`,
  telegramRefused: (method, description) =>
    `Telegram refused ${method}:\n  • ${description}`,
  noDescription: "no description",
  failed: (description) => `Failed:\n  • ${description}`,
  yesNoHint: (defaultYes) => `(y/n) [default: ${defaultYes ? "y" : "n"}]`,
  defaultHint: (value) => `[default: ${value}]`,
  languageDefaultHint: (value) => `[default / padrão: ${value}]`,
  selectHint: "↑/↓ to move · Enter to confirm",
  yes: "Yes",
  no: "No",
  custom: "Custom",
  recommended: "Recommended",
  previousChoice: "previously chosen",
  invalidAnswer: (value, hint) => `'${value}' is not valid. Use:\n  • ${hint}`,
  enterKeepsDefault:
    "Press Enter on an empty answer to keep the default or the existing setting.",
  cancelled: "Cancelled.",
  exitPrompt: "Leave the setup?",
  continueSetup: "Go on where it stopped",
  exitSetup: "Leave",
  interrupted: "Setup interrupted.",
  nothingChanged: "Nothing was changed.",
  doneSoFar: (changes) => `So far the setup has:\n  • ${changes}`,
  undoPrompt: "Undo what the setup did?",
  undoAll: "Undo everything",
  keepDone: "Keep it as it is",
  undone: "Everything the setup did was undone.",
  undoLeft: (changes) => `Could not undo:\n  • ${changes}`,
  keptDone: (command) => `Kept. Run '${command}' to go on later.`,
  changedSetting: (label, before, after) => `${label}: ${before} → ${after}`,
  notSet: "not set",
  ruleOn: "on",
  ruleOff: "off",
  pluginOn: "enabled",
  pluginOff: "disabled",
  pluginSetting: (pluginId) => `plugin '${pluginId}'`,
  undoing: (change) => `Undoing: ${change}…`,
  undoneItem: (change) => `Undone:\n  • ${change}`,
  settingsKeys: {
    statusLine: "status line",
    permissions: "security rule for the token file",
    enabledPlugins: "enabled plugins",
  },
  changeKinds: {
    fileCreated: (target) => `created ${target}`,
    fileChanged: (target) => `changed ${target}`,
    dirCreated: (target) => `created the folder ${target}`,
    marketplaceAdded: (target) => `registered the marketplace '${target}'`,
    pluginInstalled: (target) => `installed the plugin '${target}'`,
    pluginRemoved: (target) => `removed the plugin '${target}'`,
    toolInstalled: (target) =>
      `installed ${target}, which stays installed (remove it by hand if you want)`,
  },
  toolsDeclined: (tools) =>
    `Nothing was installed; ${tools} is still missing from PATH.`,
  invalidSetting: (step, value, hint) =>
    `'${value}' is not a valid ${step}. Use:\n  • ${hint}\nNothing was changed.`,
  settingHints: {
    language: "en-us or pt-br",
    delay: "the minutes, greater than 0 (for example 3)",
    "quiet-hours": "HH:MM-HH:MM (for example 22:00-08:00) or off",
    transcription: "base, small, medium or off",
    inbox: "the days, greater than 0, or off",
    statusline: "on, after, replace, custom or off",
  },
  inboxQuestion:
    "Days to keep the photos and files received on Telegram before deleting them",
  inboxDaysLabel: (days) => `${days} day(s)`,
  inboxForeverLabel: "Never delete",
  inboxCustomPrompt: "Days (greater than 0): ",
  inboxCustomHint: "a whole number of days greater than 0",
  inboxSaved: (retention, file) =>
    `Received files:\n  • ${retention}\nSaved in ${file}.`,
  inboxKept: (retention) => `Received files kept:\n  • ${retention}`,
  languageKept: (locale) => `Language kept:\n  • ${locale}`,
  delayKept: (minutes) => `Wait time kept:\n  • ${minutes} min`,
  quietKept: (value) => `Quiet hours kept:\n  • ${value}`,
  transcriptionModelKept: (model) =>
    `Local transcription kept with the ${model} model, already installed.`,
  transcriptionKeptOff: "Local transcription stays off.",
  transcriptionSwitched: (model) =>
    `Local transcription on with the ${model} model, already installed.`,
  removeModelsQuestion: "Which transcription models should be uninstalled?",
  removeModelsKeep: "None (keep it as it is)",
  removeModelsAll: (models) => `All of them (${models})`,
  removeModel: (model) => `Only the ${model} model`,
  modelInUse: "in use",
  modelUsedUntilNow: "used until now",
  transcriptionUninstall: "Uninstall",
  transcriptionInstalledHeading: "Installed:",
  transcriptionAvailableHeading: "To download:",
  modelsRemoved: (models) => `Transcription models removed:\n  • ${models}`,
  inboxDays: (days) => `deleted after ${days} day(s)`,
  inboxForever: "kept forever",
  notSettable: (step, steps) =>
    `'${step}' cannot be set with --set, only ${steps}. The token, the pairing and the plugins go through 'npx better-claude-code-telegram' in your own terminal.`,
  unknownHealthGroups: (groups, valid) =>
    `Unknown group:\n  • ${groups}\nUse all, or one or more of these:\n  • ${valid}`,
  healthGroupTitles: {
    install: "Install",
    telegram: "Telegram",
    security: "Security",
    extras: "Extras",
  },
  healthLabels: {
    node: "Node",
    user: "Running as root",
    claude: "claude",
    bun: "bun",
    plugins: "Plugins",
    shell: "Shell",
    path: "bcct on PATH",
    token: "Bot token",
    groups: "Groups",
    pairing: "Pairing",
    polling: "Connection",
    protection: "Token protection",
    config: "Settings",
    transcription: "Transcription",
    mermaid: "Diagrams (mmdc)",
    statusline: "Status line",
    launcher: "Launcher",
    appDir: "App folder",
    hooks: "Hooks",
  },
  healthDetail: {
    version: (version) => `Node ${version}`,
    found: "found",
    missing: "missing",
    installed: "installed",
    notInstalled: (ids) =>
      `missing ${ids}. Run 'npx better-claude-code-telegram plugin'.`,
    loadedIn: (file) => `loaded by ${file}`,
    notLoaded: (file) =>
      `not loaded by ${file}. Run 'npx better-claude-code-telegram plugin'.`,
    pathOn: (dir) => dir,
    pathPending: (file) => `turned on in ${file}; it applies to new terminals`,
    pathOff: "off (optional). Run 'npx better-claude-code-telegram path'.",
    bot: (username) => `@${username}`,
    noToken:
      "no token. Run 'npx better-claude-code-telegram token' in your own terminal.",
    paired: (account) => `paired with one account (${account})`,
    notPaired: "not paired. Run 'npx better-claude-code-telegram pairing'.",
    notAllowlist: (policy) =>
      `dmPolicy is ${policy}, so strangers who write to the bot get a pairing code. Run 'npx better-claude-code-telegram pairing'.`,
    pendingPairings: (count) =>
      `${count} pairing(s) pending in access.json. Run 'npx better-claude-code-telegram pairing'.`,
    groupsAllowed: (count) =>
      `${count} group(s) can talk to the bot. Run 'npx better-claude-code-telegram pairing'.`,
    groupsOff: "the bot cannot be added to groups",
    groupsUnknown: "needs a working bot token",
    regularUser: "no, runs as a regular user (as recommended)",
    root: "running as root; use a regular user, so Claude cannot change the whole machine",
    connected: "connected",
    notOpen: "'claude --telegram' is not open",
    connecting: "connecting; 'claude --telegram' was just opened",
    down: "the bot stopped receiving messages; reopen 'claude --telegram'",
    protected: "Claude cannot read the bot token",
    unprotected: (command) =>
      `Claude can read the bot token. Run '${command}'.`,
    valid: "valid",
    invalid: (file) => `${file} is not valid JSON`,
    off: "off",
    model: (model) => `model ${model}`,
    broken: (command) =>
      `the Python environment does not work. Run '${command}'.`,
    statusline: {
      ours: "Telegram indicator on",
      "ours-after": "Telegram indicator after your status line",
      other: "another status line, without the indicator",
      none: "no status line",
      custom: "yours, with the indicator Claude added",
      "custom-pending":
        "Claude fits the indicator into yours on the next 'claude --telegram'",
    },
    shellCommented: (rc) =>
      `the line in ${rc} is commented out. Run 'npx better-claude-code-telegram plugin'.`,
    shellScriptMissing: (rc, script) =>
      `${rc} loads ${script}, which does not exist. Run 'npx better-claude-code-telegram plugin'.`,
    shellScriptOutdated: (script) =>
      `${script} is out of date. Run 'npx better-claude-code-telegram plugin'.`,
    launcherActive: (version, channel) =>
      `version ${version} active (${channel})`,
    launcherMissing: (folder) =>
      `no launcher in ${folder}. Run 'npx better-claude-code-telegram'.`,
    launcherNoVersion:
      "the launcher has no active version. Run 'npx better-claude-code-telegram'.",
    appWritable: "writable",
    appNoPermission: (folder) =>
      `cannot write to ${folder} (no write permission). Run 'chmod u+rwx ${folder}'.`,
    appOtherOwner: (folder, user) =>
      `${folder} belongs to another user. Run 'sudo chown -R ${user} ${folder}'.`,
    appBlocked: (folder, reason) =>
      `cannot write to ${folder} (${reason}). Free some space or mount the disk read-write.`,
    noHookFailures: "no recent failures",
    hookWriteFailed: (event, file, reason) =>
      `the ${event} hook could not write ${file} (${reason})`,
    hookFailedOften: (event, count, reason) =>
      `the ${event} hook failed ${count} times in 24 h (${reason})`,
  },
  installToolPrompt: (tool, command) =>
    `'${tool}' is missing. Install it now with the official installer (${command})?`,
  toolInstalled: (tool, binDir) =>
    `'${tool}' installed in ${binDir}. Open a new terminal later so your shell finds it.`,
  installFailed: (tool) =>
    `The installer of '${tool}' failed; nothing else was changed.`,
  toolStillMissing: (tool, binDir) =>
    `'${tool}' was installed but is not in ${binDir}; check the installer output.`,
  nodeTooOld: (version, minimum) =>
    `Node ${version} is too old; the setup needs Node ${minimum} or newer (see .nvmrc; with nvm, run nvm install).`,
  bcctPrompt:
    "(optional) Also add the /bcct: commands to Claude Code (setup steps and health from inside a session)?",
  bcctInstalledQuestion:
    "(optional) The /bcct: commands are already in Claude Code. What should happen to them?",
  bcctChoices: {
    keep: "Keep them",
    remove: "Remove them",
  },
  bcctHints: {
    keep: "nothing changes",
    remove:
      "the /bcct: commands leave Claude Code; the setup goes on from the terminal",
  },
  pluginsChecked: "Checked:",
  requiredPlugins: (installed, total) =>
    `${installed} of ${total} required plugins installed`,
  optionalPlugins: (installed, total) =>
    `${installed} of ${total} optional plugin installed`,
  marketplaceFound: "Marketplace registered",
  marketplaceMissing: "Marketplace not registered yet",
  planHeader: "To finish this step, the setup needs to:",
  planMarketplace: (name) =>
    `register the marketplace '${name}' from this folder`,
  planPlugin: (id) => `install the plugin '${id}' for your user`,
  planShellLine: (file) =>
    `add to ${file} the line that loads 'claude --telegram'`,
  planPrompt: "Go ahead with the installation?",
  nothingInstalled: "Nothing was installed.",
  byHand: "To do it by hand, run:",
  marketplaceAdded: (name) => `Marketplace '${name}' registered.`,
  pluginsChecking: "Checking the marketplace and the installed plugins…",
  marketplaceAdding: (name) => `Registering the marketplace '${name}'…`,
  pluginInstalling: (id) => `Installing the plugin '${id}'…`,
  pluginRemoving: (id) => `Removing the plugin '${id}'…`,
  pluginEnabling: (id) => `Enabling '${id}' in every instance…`,
  pluginDisabling: (id) => `Disabling '${id}' outside 'claude --telegram'…`,
  pluginAdded: (id) => `Plugin '${id}' installed for your user.`,
  marketplaceRegistered: (name) => `Marketplace '${name}' already registered.`,
  pluginInstalled: (id) => `Plugin '${id}' already installed.`,
  pluginDisabledOutside: (id) =>
    `Plugin '${id}' disabled outside 'claude --telegram'.`,
  pluginEnabled: (id) => `Plugin '${id}' enabled in every instance.`,
  pluginAlreadyDisabledOutside: (id) =>
    `Plugin '${id}' already disabled outside 'claude --telegram'.`,
  pluginAlreadyEnabled: (id) =>
    `Plugin '${id}' already enabled in every instance.`,
  rcAlreadyLoads: (rcFile) => `${rcFile} already loads 'claude --telegram'.`,
  rcNowLoads: (rcFile) => `${rcFile} now loads 'claude --telegram'.`,
  shellUnsupported: (shell, line) =>
    `The ${shell} shell cannot load 'claude --telegram'. Load this line in bash or zsh:\n  ${line}`,
  rcNoLongerLoads: (rcFile) => `${rcFile} no longer loads 'claude --telegram'.`,
  statuslineRemoved: (file) => `Telegram status line removed from ${file}.`,
  envRuleRemoved: (file) =>
    `Rule that kept Claude from reading the bot token removed from ${file}.`,
  envProtected: (envFile, settingsFile) =>
    `Security rule added:\n  • Claude Code may not read ${envFile}, the file that holds the bot token (deny rule in ${settingsFile})`,
  envAlreadyProtected: (envFile, settingsFile) =>
    `Security rule already on:\n  • Claude Code may not read ${envFile} (deny rule in ${settingsFile})`,
  pluginRemoved: (pluginId) => `Plugin '${pluginId}' removed.`,
  pluginNotRemoved: (pluginId) =>
    `Could not remove the plugin '${pluginId}'. To do it by hand, run:\n  claude plugin uninstall ${pluginId} --scope user`,
  pluginNotInstalled: (pluginId) => `Plugin '${pluginId}' was not installed.`,
  marketplaceRemoved: (name) => `Marketplace '${name}' removed.`,
  marketplaceNotRemoved: (name) =>
    `Could not remove the marketplace '${name}'. To do it by hand, run:\n  claude plugin marketplace remove ${name}`,
  marketplaceNotRegistered: (name) =>
    `Marketplace '${name}' was not registered.`,
  claudeMissingForUninstall: (commands) =>
    `'claude' is not in the PATH. To remove the plugins later, run:\n${commands}`,
  closeInstanceBeforeUninstall:
    "Close 'claude --telegram' before uninstalling; nothing was changed.",
  transcriptionFound: (paths) =>
    `Local transcription installed by the setup:\n  • ${paths}`,
  deleteTranscriptionPrompt:
    "Remove the local transcription (Python environment and downloaded models)?",
  transcriptionRemoved: "Local transcription removed.",
  transcriptionKept: "Local transcription kept.",
  deleteMermaidPrompt:
    "Also remove mermaid-cli (mmdc), used for the diagrams? The setup did not install it, and other tools may use it.",
  mermaidRemoved: "mermaid-cli removed.",
  mermaidNotRemoved: (command) =>
    `Could not remove mermaid-cli. To do it by hand, run:\n  ${command}`,
  deleteStatePrompt: (channelDir, appDir) =>
    `Also delete the bot token and the pairing in ${channelDir} and the settings in ${appDir}?`,
  stateDeleted: (channelDir, appDir) => `${channelDir} and ${appDir} deleted.`,
  stateKept: (channelDir, appDir) =>
    `Bot token and pairing kept in ${channelDir}, settings in ${appDir}.`,
  uninstallDone:
    "Done. Open a new terminal; this repository folder can now be deleted.",
  noSavedToken: (command) => `No saved token. Run this first:\n  ${command}`,
  useSavedBot: (username) => `Use the saved bot, @${username}?`,
  tokenPrompt: "Bot token (from @BotFather; hidden while you type): ",
  tokenSaved: (username, file) => `Token of bot @${username} saved in ${file}.`,
  noPairingMessage:
    "No message with the code arrived in 3 min. Run the setup again.",
  alreadyPaired: (accounts) => `Bot already paired with ${accounts}.`,
  pairingChoiceQuestion: (accounts) =>
    `The bot is already paired with ${accounts}. What now?`,
  pairingChoices: {
    keep: "Keep this account",
    replace: "Pair another account (with a new code)",
  },
  tooManyAccounts: (count, command) =>
    `access.json lets ${count} Telegram accounts talk to the bot, but it only talks to one. Run '${command}' to keep only yours.`,
  permissionsSkipped: (option) =>
    `'claude --telegram' does not start with ${option}:\n  • with the channel on, a message on Telegram could make Claude run anything without asking you\nStart it without that option.`,
  groupsWarning: (username) =>
    `@${username} can be added to groups. In @BotFather send /setjoingroups, pick @${username} and choose Disable.`,
  closeInstanceBeforePairing:
    "Close the 'claude --telegram' instance before pairing, because it holds the bot.",
  webhookConfigured: (username) =>
    `Bot @${username} has a webhook set; use a bot only for Claude.`,
  sendPairingCode: (username, code, link) =>
    [
      "To pair, open this link and tap Start:",
      `  • ${link}`,
      `Or send this code to @${username}:`,
      `  • ${code}`,
      "Waiting up to 3 min. Only the message with this code pairs.",
    ].join("\n"),
  confirmPairing: (label, userId) => `Pair with ${label} (id ${userId})?`,
  pairingCancelled: "Pairing cancelled.",
  pairedChatMessage:
    "Paired with Claude Code.\n\nRun 'claude --telegram' to chat here.",
  pairedWith: (label) =>
    `Paired with ${label}; only this account talks to the bot.`,
  delayQuestion:
    "Minutes without an answer in the terminal before going to Telegram",
  delayLabel: (minutes) => `${minutes} min`,
  delayCustomPrompt: "Minutes (greater than 0): ",
  delayCustomHint: "a number of minutes greater than 0",
  delaySaved: (minutes, file) => `Delay of ${minutes} min saved in ${file}.`,
  quietQuestion: "Quiet hours, when nothing goes to Telegram",
  quietOffLabel: "Off",
  quietPresets: {
    outsideWork: "Outside business hours",
    fullNight: "All night",
    night: "Night",
    lateNight: "Small hours",
  },
  quietStartPrompt: "Start of the quiet hours (HH:MM): ",
  quietEndPrompt: "End of the quiet hours (HH:MM): ",
  timeHint: "HH:MM, from 00:00 to 23:59",
  quietEndHint: (start) => `HH:MM, from 00:00 to 23:59 and other than ${start}`,
  quietSaved: (value, file) => `Quiet hours ${value} saved in ${file}.`,
  quietOff: "off",
  transcriptionPurpose:
    "Turns the voice messages you send on Telegram into text, here on your machine, so Claude can read what you said.",
  transcriptionQuestion: "Local voice transcription",
  transcriptionOffLabel: "Off",
  transcriptionModels: {
    base: "fastest, uses the least RAM, fine for clear speech, ~150 MB of storage",
    small: "more accurate, slower, uses more RAM, ~490 MB of storage",
    medium:
      "most accurate, much slower, uses much more RAM, ~1.5 GB of storage",
  },
  transcriptionDisabled:
    "Transcription off:\n  • voice messages reach Claude as attachments",
  pythonEnvFailed:
    "Could not create the Python environment. Install one of these and run the setup again:\n  • uv (curl -LsSf https://astral.sh/uv/install.sh | sh)\n  • Python's venv (on Debian and Ubuntu, sudo apt install python3-venv)",
  installWhisper: "install faster-whisper",
  downloadingModel: (model) =>
    `Downloading the ${model} transcription model (first time only)…`,
  modelDownload: "download the model",
  savedBotChecking: "Checking the saved bot…",
  tokenChecking: "Checking the token with Telegram…",
  pairedAccountChecking: "Looking up the paired account…",
  pairingPreparing: "Getting the pairing ready…",
  pairingWaiting: "Waiting for the message with the code on Telegram…",
  pairingFinishing: "Finishing the pairing…",
  whisperEnvCreating: "Creating the Python environment of the transcription…",
  whisperInstalling: "Installing faster-whisper…",
  modelRemoving: (model) => `Removing the ${model} model…`,
  marketplaceRemoving: (name) => `Removing the marketplace '${name}'…`,
  transcriptionRemoving: "Deleting the transcription files…",
  mermaidRemoving: "Removing mermaid-cli…",
  transcriptionReady: (model) =>
    `Installed:\n  • the ${model} model of the local transcription`,
  languageQuestion: "Language / Idioma",
  languageSaved: (locale, file) => `Language ${locale} saved in ${file}.`,
  statuslinePrompt: (example) =>
    `Claude Code's footer (status line) can show whether Telegram is connected, like this:\n  • ${example}\nShow it?`,
  statuslineInstalled: (file) => `Status line set in ${file}.`,
  statuslineKept:
    "Status line kept:\n  • yours stays, without the Telegram indicator",
  statuslineSkipped: "Status line left unchanged.",
  statuslineChoiceQuestion: (preview, example) =>
    `You already have a status line (${preview}).\nWhere should the Telegram indicator (${example}) go?`,
  statuslineChoices: {
    after: "Next to yours",
    replace: "Instead of yours",
    custom: "Ask Claude to fit it into mine",
    keep: "Nowhere (keep only yours)",
    keepCustom: "Keep yours (it already has the indicator)",
  },
  statuslineChoiceHints: {
    after: "yours stays and the indicator shows beside it",
    replace: "only the indicator; yours is saved and comes back on uninstall",
    custom:
      "on the next 'claude --telegram', Claude fits the indicator into yours the way you want",
    keep: "nothing changes",
  },
  statuslineCustomKept:
    "Status line kept:\n  • yours, with the indicator Claude added",
  statuslineCustomRequested:
    "Request noted:\n  • on the next 'claude --telegram', Claude asks how to fit the indicator into your status line",
  statuslineCustomNeedsOwn:
    "There is no status line of yours to fit the indicator into; use on to show only the indicator.",
  statuslineCustomPrompt: (settingsFile, current, indicator, example) =>
    [
      "The better-claude-code-telegram setup asked you to fit the Telegram indicator into my status line.",
      "",
      `My status line today (statusLine in ${settingsFile}):`,
      `  ${current}`,
      "",
      "The indicator is this command:",
      `  ${indicator}`,
      `It prints the Telegram state with ANSI color (for example ${example}) or nothing, and does not read its input.`,
      "",
      "Do it like this:",
      "  • before changing anything, ask how I want the two together (where the indicator goes, separator, color)",
      "  • change only my status line, so it also calls the indicator",
      "  • if the indicator file no longer exists, the status line keeps working without it",
      "  • at the end, show what changed",
    ].join("\n"),
  statuslineCustomLeft: (command) =>
    `Your status line still calls the Telegram indicator, which Claude added to it. Ask Claude to remove this call:\n  ${command}`,
  statuslineChained: (file) =>
    `Telegram indicator added after your status line in ${file}.`,
  statuslineReplaced: (file, backup) =>
    `Status line replaced in ${file}; the previous settings are in ${backup}.`,
  statuslineAlready: "The Telegram indicator is already in your status line.",
  statuslineOursQuestion: (example) =>
    `The Telegram indicator (${example}) is already in your status line. What should happen to it?`,
  statuslineOursChoices: {
    keep: "Keep it",
    remove: "Remove it",
  },
  statuslineOursHints: {
    keep: "nothing changes",
    restore: "your previous status line comes back",
    remove: "the footer is left without a status line",
  },
  statuslineOursKept: "Status line kept with the Telegram indicator.",
  statuslineRestored: (file) => `Your previous status line is back in ${file}.`,
  settingsInvalid: (file) =>
    `${file} is not a valid JSON object. Fix it and run the setup again; nothing was changed.`,
  doneAll: "Done. Open a new terminal and run 'claude --telegram'.",
  doneReopen: "Done. Reopen 'claude --telegram' for it to apply.",
  doneLive: "Done. It applies to the next messages, nothing to reopen.",
  questionReleased: (instance, headers) =>
    `Released the question from [${instance}]: ${headers}`,
  nothingPending: (sessionPrefix) =>
    sessionPrefix
      ? `No pending question from session ${sessionPrefix}.`
      : "No pending question.",
  fileNotSaved: (file) => `Could not save ${file}.`,
  fileNotRemoved: (file) => `Could not remove ${file}.`,
  statuslineNotShown: "Could not show the status line.",
  healthNotShown: "Could not show the result.",
  outputNotShown: "Could not write to the output.",
  selfInstallDone: (version, channel) =>
    `bcct ${version} installed (${channel}).`,
  selfInstallUnstable: (channel) =>
    `This is a test version (${channel}): it may change or break before the stable one.`,
  selfInstallHashMismatch:
    "The file does not match the expected hash; nothing was installed.",
  selfInstallNotBcct: "The file did not answer as bcct; nothing was installed.",
  selfInstallFailed:
    "Could not install bcct: the file or the app folder could not be read or written.",
  selfInstallUsage:
    "Usage: bcct self-install <file> --sha256 <hash> [--from npm|release|manual]",
  pathQuestion:
    "Add the bcct command to your PATH, so 'bcct setup', 'bcct health' and the others work right in the terminal, without npx?",
  pathAdded: (file) =>
    `${file} now adds bcct to your PATH. It applies to new terminals.`,
  pathAlready: (file) => `${file} already adds bcct to your PATH.`,
  pathRemoved: (file) => `${file} no longer adds bcct to your PATH.`,
  pathOff:
    "bcct stays off your PATH. To use it directly later, run 'npx better-claude-code-telegram path'.",
  hookWriteFailed: (file, reason) =>
    `bcct: could not write ${file} (${reason}). Telegram messages may not arrive. Run /bcct:health.`,
  hookFailedOften: (event, count, reason) =>
    `bcct: the ${event} hook failed ${count} times in 24 h (${reason}). Run /bcct:health.`,
  hookReasons: {
    noPermission: "no write permission",
    diskFull: "disk full",
    readOnly: "read-only file system",
    quota: "disk quota exceeded",
    busy: "file busy or changed by another instance",
    input: "unexpected input from Claude Code",
  },
};

const ptBr = {
  statusMain: "(Principal)",
  statusSecondary: "(Secundário)",
  statusConnected: (role) => `📱 ${role} Telegram conectado`,
  statusDown: (role) => `📱 ${role} Telegram fora`,
  statusConnecting: (role) => `📱 ${role} Telegram conectando…`,
  stepLabels: { token: "token do bot", pairing: "pareamento" },
  stepTitles: {
    language: "Language / Idioma",
    plugin: "Plugins",
    token: "Token do bot",
    pairing: "Pareamento",
    delay: "Tempo de espera",
    "quiet-hours": "Silêncio",
    transcription: "Transcrição de áudio",
    inbox: "Arquivos recebidos",
    statusline: "Statusline",
    path: "Comando bcct no terminal",
    health: "Verificação final",
  },
  healthHasFailures: (command) =>
    `Algumas verificações falharam. Corrija o que está com ✘ e rode '${command}' de novo.`,
  notConfigured: (missing, command) =>
    `O 'claude --telegram' ainda não está configurado. Falta:\n  • ${missing}\nRode '${command}' antes.`,
  alreadyRunning: (pid) =>
    `Já existe uma instância do 'claude --telegram' aberta (bot no processo ${pid}). Feche-a antes de abrir outra.`,
  unknownSteps: (unknown, all) =>
    `Etapa desconhecida:\n  • ${unknown}\nUse uma ou mais destas (sem nenhuma, roda todas):\n  • ${all}`,
  networkFailure: (method) => `Falha de rede ao chamar o Telegram (${method}).`,
  telegramRefused: (method, description) =>
    `O Telegram recusou ${method}:\n  • ${description}`,
  noDescription: "sem descrição",
  failed: (description) => `Falhou:\n  • ${description}`,
  yesNoHint: (defaultYes) => `(s/n) [padrão: ${defaultYes ? "s" : "n"}]`,
  defaultHint: (value) => `[padrão: ${value}]`,
  languageDefaultHint: (value) => `[default / padrão: ${value}]`,
  selectHint: "↑/↓ para escolher · Enter para confirmar",
  yes: "Sim",
  no: "Não",
  custom: "Customizado",
  recommended: "Recomendado",
  previousChoice: "escolhido anteriormente",
  invalidAnswer: (value, hint) => `'${value}' não vale. Use:\n  • ${hint}`,
  enterKeepsDefault:
    "Confirmar (Enter) vazio confirma o padrão ou mantém a configuração existente.",
  cancelled: "Cancelado.",
  exitPrompt: "Sair do setup?",
  continueSetup: "Continuar de onde parou",
  exitSetup: "Sair",
  interrupted: "Setup interrompido.",
  nothingChanged: "Nada foi alterado.",
  doneSoFar: (changes) => `Até aqui o setup:\n  • ${changes}`,
  undoPrompt: "Desfazer o que o setup fez?",
  undoAll: "Desfazer tudo",
  keepDone: "Manter como está",
  undone: "Tudo o que o setup fez foi desfeito.",
  undoLeft: (changes) => `Não foi possível desfazer:\n  • ${changes}`,
  keptDone: (command) => `Mantido. Rode '${command}' para continuar depois.`,
  changedSetting: (label, before, after) => `${label}: ${before} → ${after}`,
  notSet: "não definido",
  ruleOn: "ativada",
  ruleOff: "desativada",
  pluginOn: "ativado",
  pluginOff: "desativado",
  pluginSetting: (pluginId) => `plugin '${pluginId}'`,
  undoing: (change) => `Desfazendo: ${change}…`,
  undoneItem: (change) => `Desfeito:\n  • ${change}`,
  settingsKeys: {
    statusLine: "statusline",
    permissions: "regra de segurança do arquivo do token",
    enabledPlugins: "plugins ativados",
  },
  changeKinds: {
    fileCreated: (target) => `criou ${target}`,
    fileChanged: (target) => `alterou ${target}`,
    dirCreated: (target) => `criou a pasta ${target}`,
    marketplaceAdded: (target) => `registrou o marketplace '${target}'`,
    pluginInstalled: (target) => `instalou o plugin '${target}'`,
    pluginRemoved: (target) => `removeu o plugin '${target}'`,
    toolInstalled: (target) =>
      `instalou ${target}, que continua instalado (remova à mão se quiser)`,
  },
  toolsDeclined: (tools) =>
    `Nada foi instalado; ${tools} continua faltando no PATH.`,
  invalidSetting: (step, value, hint) =>
    `'${value}' não vale para ${step}. Use:\n  • ${hint}\nNada foi alterado.`,
  settingHints: {
    language: "en-us ou pt-br",
    delay: "os minutos, maiores que 0 (por exemplo 3)",
    "quiet-hours": "HH:MM-HH:MM (por exemplo 22:00-08:00) ou off",
    transcription: "base, small, medium ou off",
    inbox: "os dias, maiores que 0, ou off",
    statusline: "on, after, replace, custom ou off",
  },
  inboxQuestion:
    "Dias para manter as fotos e arquivos recebidos pelo Telegram antes de apagar",
  inboxDaysLabel: (days) => `${days} dia(s)`,
  inboxForeverLabel: "Nunca apagar",
  inboxCustomPrompt: "Dias (maior que 0): ",
  inboxCustomHint: "um número inteiro de dias maior que 0",
  inboxSaved: (retention, file) =>
    `Arquivos recebidos:\n  • ${retention}\nSalvo em ${file}.`,
  inboxKept: (retention) => `Arquivos recebidos mantidos:\n  • ${retention}`,
  languageKept: (locale) => `Idioma mantido:\n  • ${locale}`,
  delayKept: (minutes) => `Tempo de espera mantido:\n  • ${minutes} min`,
  quietKept: (value) => `Silêncio mantido:\n  • ${value}`,
  transcriptionModelKept: (model) =>
    `Transcrição local mantida com o modelo ${model}, já instalado.`,
  transcriptionKeptOff: "Transcrição local continua desligada.",
  transcriptionSwitched: (model) =>
    `Transcrição local ligada com o modelo ${model}, já instalado.`,
  removeModelsQuestion: "Quais modelos de transcrição desinstalar?",
  removeModelsKeep: "Nenhum (manter como está)",
  removeModelsAll: (models) => `Todos (${models})`,
  removeModel: (model) => `Só o modelo ${model}`,
  modelInUse: "em uso",
  modelUsedUntilNow: "usado até agora",
  transcriptionUninstall: "Desinstalar",
  transcriptionInstalledHeading: "Instalados:",
  transcriptionAvailableHeading: "Para baixar:",
  modelsRemoved: (models) => `Modelos de transcrição removidos:\n  • ${models}`,
  inboxDays: (days) => `apagados depois de ${days} dia(s)`,
  inboxForever: "mantidos para sempre",
  notSettable: (step, steps) =>
    `'${step}' não muda pelo --set, só ${steps}. Token, pareamento e plugins passam pelo 'npx better-claude-code-telegram' no seu próprio terminal.`,
  unknownHealthGroups: (groups, valid) =>
    `Grupo desconhecido:\n  • ${groups}\nUse all, ou um ou mais destes:\n  • ${valid}`,
  healthGroupTitles: {
    install: "Instalação",
    telegram: "Telegram",
    security: "Segurança",
    extras: "Extras",
  },
  healthLabels: {
    node: "Node",
    user: "Execução como root",
    claude: "claude",
    bun: "bun",
    plugins: "Plugins",
    shell: "Shell",
    path: "bcct no PATH",
    token: "Token do bot",
    groups: "Grupos",
    pairing: "Pareamento",
    polling: "Conexão",
    protection: "Proteção do token",
    config: "Configurações",
    transcription: "Transcrição",
    mermaid: "Mermaid (mmdc)",
    statusline: "Statusline",
    launcher: "Launcher",
    appDir: "Pasta do app",
    hooks: "Hooks",
  },
  healthDetail: {
    version: (version) => `Node ${version}`,
    found: "encontrado",
    missing: "não encontrado",
    installed: "instalados",
    notInstalled: (ids) =>
      `faltam ${ids}. Rode 'npx better-claude-code-telegram plugin'.`,
    loadedIn: (file) => `carregado por ${file}`,
    notLoaded: (file) =>
      `não carregado por ${file}. Rode 'npx better-claude-code-telegram plugin'.`,
    pathOn: (dir) => dir,
    pathPending: (file) => `ligado em ${file}; vale nos terminais novos`,
    pathOff: "fora (opcional). Rode 'npx better-claude-code-telegram path'.",
    bot: (username) => `@${username}`,
    noToken:
      "sem token. Rode 'npx better-claude-code-telegram token' no seu próprio terminal.",
    paired: (account) => `pareado com uma conta (${account})`,
    notPaired: "não pareado. Rode 'npx better-claude-code-telegram pairing'.",
    notAllowlist: (policy) =>
      `o dmPolicy é ${policy}, e quem escreve para o bot recebe um código de pareamento. Rode 'npx better-claude-code-telegram pairing'.`,
    pendingPairings: (count) =>
      `${count} pareamento(s) pendente(s) no access.json. Rode 'npx better-claude-code-telegram pairing'.`,
    groupsAllowed: (count) =>
      `${count} grupo(s) podem falar com o bot. Rode 'npx better-claude-code-telegram pairing'.`,
    groupsOff: "o bot não entra em grupos",
    groupsUnknown: "precisa de um token de bot válido",
    regularUser: "não, roda como usuário comum (o recomendado)",
    root: "rodando como root; use um usuário comum, para o Claude não poder mexer na máquina inteira",
    connected: "conectado",
    notOpen: "o 'claude --telegram' não está aberto",
    connecting: "conectando; o 'claude --telegram' acabou de abrir",
    down: "o bot parou de receber mensagens; reabra o 'claude --telegram'",
    protected: "o Claude não consegue ler o token do bot",
    unprotected: (command) =>
      `o Claude consegue ler o token do bot. Rode '${command}'.`,
    valid: "válidas",
    invalid: (file) => `${file} não é um JSON válido`,
    off: "desligado",
    model: (model) => `modelo ${model}`,
    broken: (command) => `o ambiente Python não funciona. Rode '${command}'.`,
    statusline: {
      ours: "indicador do Telegram ligado",
      "ours-after": "indicador do Telegram depois da sua statusline",
      other: "outra statusline, sem o indicador",
      none: "sem statusline",
      custom: "a sua, com o indicador que o Claude juntou",
      "custom-pending":
        "o Claude junta o indicador à sua no próximo 'claude --telegram'",
    },
    shellCommented: (rc) =>
      `a linha de ${rc} está comentada. Rode 'npx better-claude-code-telegram plugin'.`,
    shellScriptMissing: (rc, script) =>
      `${rc} carrega ${script}, que não existe. Rode 'npx better-claude-code-telegram plugin'.`,
    shellScriptOutdated: (script) =>
      `${script} está desatualizado. Rode 'npx better-claude-code-telegram plugin'.`,
    launcherActive: (version, channel) =>
      `versão ${version} ativa (${channel})`,
    launcherMissing: (folder) =>
      `sem launcher em ${folder}. Rode 'npx better-claude-code-telegram'.`,
    launcherNoVersion:
      "o launcher não tem versão ativa. Rode 'npx better-claude-code-telegram'.",
    appWritable: "gravável",
    appNoPermission: (folder) =>
      `não dá para gravar em ${folder} (sem permissão de escrita). Rode 'chmod u+rwx ${folder}'.`,
    appOtherOwner: (folder, user) =>
      `${folder} é de outro usuário. Rode 'sudo chown -R ${user} ${folder}'.`,
    appBlocked: (folder, reason) =>
      `não dá para gravar em ${folder} (${reason}). Libere espaço ou monte o disco com escrita.`,
    noHookFailures: "sem falhas recentes",
    hookWriteFailed: (event, file, reason) =>
      `o hook ${event} não conseguiu gravar ${file} (${reason})`,
    hookFailedOften: (event, count, reason) =>
      `o hook ${event} falhou ${count} vezes em 24 h (${reason})`,
  },
  installToolPrompt: (tool, command) =>
    `O '${tool}' não está instalado. Instalar agora com o instalador do próprio projeto (${command})?`,
  toolInstalled: (tool, binDir) =>
    `'${tool}' instalado em ${binDir}. Depois abra um terminal novo para o shell encontrá-lo.`,
  installFailed: (tool) =>
    `O instalador do '${tool}' falhou; nada mais foi alterado.`,
  toolStillMissing: (tool, binDir) =>
    `O '${tool}' foi instalado mas não está em ${binDir}; confira a saída do instalador.`,
  nodeTooOld: (version, minimum) =>
    `O Node ${version} é antigo demais; o setup precisa do Node ${minimum} ou mais novo (veja o .nvmrc; com nvm, rode nvm install).`,
  bcctPrompt:
    "(opcional) Adicionar também ao Claude Code os comandos /bcct: (etapas do setup e health de dentro da sessão)?",
  bcctInstalledQuestion:
    "(opcional) Os comandos /bcct: já estão no Claude Code. O que fazer com eles?",
  bcctChoices: {
    keep: "Manter",
    remove: "Remover",
  },
  bcctHints: {
    keep: "nada muda",
    remove:
      "os comandos /bcct: deixam o Claude Code; o setup continua no terminal",
  },
  pluginsChecked: "Conferido:",
  requiredPlugins: (installed, total) =>
    `${installed} de ${total} plugins obrigatórios instalados`,
  optionalPlugins: (installed, total) =>
    `${installed} de ${total} plugin opcional instalado`,
  marketplaceFound: "Marketplace registrado",
  marketplaceMissing: "Marketplace ainda não registrado",
  planHeader: "Para concluir esta etapa, o setup precisa:",
  planMarketplace: (name) =>
    `registrar o marketplace '${name}' a partir desta pasta`,
  planPlugin: (id) => `instalar o plugin '${id}' para o seu usuário`,
  planShellLine: (file) =>
    `acrescentar em ${file} a linha que carrega o 'claude --telegram'`,
  planPrompt: "Seguir com a instalação?",
  nothingInstalled: "Nada foi instalado.",
  byHand: "Para fazer à mão, rode:",
  marketplaceAdded: (name) => `Marketplace '${name}' registrado.`,
  pluginsChecking: "Conferindo o marketplace e os plugins instalados…",
  marketplaceAdding: (name) => `Registrando o marketplace '${name}'…`,
  pluginInstalling: (id) => `Instalando o plugin '${id}'…`,
  pluginRemoving: (id) => `Removendo o plugin '${id}'…`,
  pluginEnabling: (id) => `Ativando '${id}' em todas as instâncias…`,
  pluginDisabling: (id) => `Desativando '${id}' fora do 'claude --telegram'…`,
  pluginAdded: (id) => `Plugin '${id}' instalado para o seu usuário.`,
  marketplaceRegistered: (name) => `Marketplace '${name}' já registrado.`,
  pluginInstalled: (id) => `Plugin '${id}' já instalado.`,
  pluginDisabledOutside: (id) =>
    `Plugin '${id}' desativado fora do 'claude --telegram'.`,
  pluginEnabled: (id) => `Plugin '${id}' ativado em todas as instâncias.`,
  pluginAlreadyDisabledOutside: (id) =>
    `Plugin '${id}' já desativado fora do 'claude --telegram'.`,
  pluginAlreadyEnabled: (id) =>
    `Plugin '${id}' já ativado em todas as instâncias.`,
  rcAlreadyLoads: (rcFile) => `${rcFile} já carrega o 'claude --telegram'.`,
  rcNowLoads: (rcFile) => `${rcFile} passou a carregar o 'claude --telegram'.`,
  shellUnsupported: (shell, line) =>
    `O shell ${shell} não carrega o 'claude --telegram'. Carregue esta linha no bash ou no zsh:\n  ${line}`,
  rcNoLongerLoads: (rcFile) =>
    `${rcFile} não carrega mais o 'claude --telegram'.`,
  statuslineRemoved: (file) => `Statusline do Telegram removida de ${file}.`,
  envRuleRemoved: (file) =>
    `Regra que impedia o Claude de ler o token do bot removida de ${file}.`,
  envProtected: (envFile, settingsFile) =>
    `Adicionada regra de segurança:\n  • o Claude Code não pode ler ${envFile}, o arquivo com o token do bot (regra deny em ${settingsFile})`,
  envAlreadyProtected: (envFile, settingsFile) =>
    `Regra de segurança já ativa:\n  • o Claude Code não pode ler ${envFile} (regra deny em ${settingsFile})`,
  pluginRemoved: (pluginId) => `Plugin '${pluginId}' removido.`,
  pluginNotRemoved: (pluginId) =>
    `Não foi possível remover o plugin '${pluginId}'. Para fazer à mão, rode:\n  claude plugin uninstall ${pluginId} --scope user`,
  pluginNotInstalled: (pluginId) =>
    `Plugin '${pluginId}' não estava instalado.`,
  marketplaceRemoved: (name) => `Marketplace '${name}' removido.`,
  marketplaceNotRemoved: (name) =>
    `Não foi possível remover o marketplace '${name}'. Para fazer à mão, rode:\n  claude plugin marketplace remove ${name}`,
  marketplaceNotRegistered: (name) =>
    `Marketplace '${name}' não estava registrado.`,
  claudeMissingForUninstall: (commands) =>
    `O 'claude' não está no PATH. Para remover os plugins depois, rode:\n${commands}`,
  closeInstanceBeforeUninstall:
    "Feche o 'claude --telegram' antes de desinstalar; nada foi alterado.",
  transcriptionFound: (paths) =>
    `Transcrição local instalada pelo setup:\n  • ${paths}`,
  deleteTranscriptionPrompt:
    "Remover a transcrição local (ambiente Python e modelos baixados)?",
  transcriptionRemoved: "Transcrição local removida.",
  transcriptionKept: "Transcrição local mantida.",
  deleteMermaidPrompt:
    "Remover também o mermaid-cli (mmdc), que gera as imagens dos fluxos? Ele não foi instalado pelo setup e outras ferramentas podem usá-lo.",
  mermaidRemoved: "mermaid-cli removido.",
  mermaidNotRemoved: (command) =>
    `Não foi possível remover o mermaid-cli. Para fazer à mão, rode:\n  ${command}`,
  deleteStatePrompt: (channelDir, appDir) =>
    `Apagar também o token do bot e o pareamento em ${channelDir} e as configurações em ${appDir}?`,
  stateDeleted: (channelDir, appDir) => `${channelDir} e ${appDir} apagados.`,
  stateKept: (channelDir, appDir) =>
    `Token do bot e pareamento mantidos em ${channelDir}, configurações em ${appDir}.`,
  uninstallDone:
    "Pronto. Abra um terminal novo; já dá para apagar a pasta deste repositório.",
  noSavedToken: (command) => `Nenhum token salvo. Rode antes:\n  ${command}`,
  useSavedBot: (username) => `Usar o bot salvo, @${username}?`,
  tokenPrompt: "Token do bot (do @BotFather; não aparece no terminal): ",
  tokenSaved: (username, file) => `Token do bot @${username} salvo em ${file}.`,
  noPairingMessage:
    "Nenhuma mensagem com o código chegou em 3 min. Rode o setup de novo.",
  alreadyPaired: (accounts) => `Bot já pareado com ${accounts}.`,
  pairingChoiceQuestion: (accounts) =>
    `O bot já está pareado com ${accounts}. O que fazer?`,
  pairingChoices: {
    keep: "Manter esta conta",
    replace: "Trocar por outra conta (com um código novo)",
  },
  tooManyAccounts: (count, command) =>
    `O access.json deixa ${count} contas do Telegram falarem com o bot, mas ele só fala com uma. Rode '${command}' para deixar só a sua.`,
  permissionsSkipped: (option) =>
    `O 'claude --telegram' não abre com ${option}:\n  • com o canal ligado, uma mensagem no Telegram poderia fazer o Claude executar qualquer coisa sem te perguntar\nAbra sem essa opção.`,
  groupsWarning: (username) =>
    `O @${username} pode entrar em grupos. No @BotFather mande /setjoingroups, escolha o @${username} e depois Disable.`,
  closeInstanceBeforePairing:
    "Feche a instância do 'claude --telegram' antes de parear, porque ela segura o bot.",
  webhookConfigured: (username) =>
    `O bot @${username} tem webhook configurado; use um bot só para o Claude.`,
  sendPairingCode: (username, code, link) =>
    [
      "Para parear, abra este link e toque em Iniciar:",
      `  • ${link}`,
      `Ou mande este código para @${username}:`,
      `  • ${code}`,
      "Aguardando até 3 min. Só a mensagem com esse código pareia.",
    ].join("\n"),
  confirmPairing: (label, userId) => `Parear com ${label} (id ${userId})?`,
  pairingCancelled: "Pareamento cancelado.",
  pairedChatMessage:
    "Pareado com o Claude Code.\n\nRode 'claude --telegram' para conversar por aqui.",
  pairedWith: (label) => `Pareado com ${label}; só essa conta fala com o bot.`,
  delayQuestion: "Minutos sem resposta no terminal antes de levar ao Telegram",
  delayLabel: (minutes) => `${minutes} min`,
  delayCustomPrompt: "Minutos (maior que 0): ",
  delayCustomHint: "um número de minutos maior que 0",
  delaySaved: (minutes, file) => `Espera de ${minutes} min salva em ${file}.`,
  quietQuestion: "Horário de silêncio, sem mensagens no Telegram",
  quietOffLabel: "Desligado",
  quietPresets: {
    outsideWork: "Fora do horário comercial",
    fullNight: "Noite completa",
    night: "Noite",
    lateNight: "Madrugada",
  },
  quietStartPrompt: "Início do silêncio (HH:MM): ",
  quietEndPrompt: "Fim do silêncio (HH:MM): ",
  timeHint: "HH:MM, de 00:00 a 23:59",
  quietEndHint: (start) => `HH:MM, de 00:00 a 23:59 e diferente de ${start}`,
  quietSaved: (value, file) => `Silêncio ${value} salvo em ${file}.`,
  quietOff: "desligado",
  transcriptionPurpose:
    "Transforma em texto, aqui na sua máquina, os áudios que você manda pelo Telegram, para o Claude ler o que você falou.",
  transcriptionQuestion: "Transcrição local dos áudios",
  transcriptionOffLabel: "Desligada",
  transcriptionModels: {
    base: "a mais rápida, usa menos RAM, boa para fala clara, ~150 MB de armazenamento",
    small: "mais precisa, mais lenta, usa mais RAM, ~490 MB de armazenamento",
    medium:
      "a mais precisa, bem mais lenta, usa muito mais RAM, ~1,5 GB de armazenamento",
  },
  transcriptionDisabled:
    "Transcrição desligada:\n  • o áudio chega ao Claude como anexo",
  pythonEnvFailed:
    "Não foi possível criar o ambiente Python. Instale um destes e rode o setup de novo:\n  • o uv (curl -LsSf https://astral.sh/uv/install.sh | sh)\n  • o venv do Python (no Debian e no Ubuntu, sudo apt install python3-venv)",
  installWhisper: "instalar o faster-whisper",
  downloadingModel: (model) =>
    `Baixando o modelo ${model} da transcrição (só na primeira vez)…`,
  modelDownload: "baixar o modelo",
  savedBotChecking: "Conferindo o bot salvo…",
  tokenChecking: "Conferindo o token com o Telegram…",
  pairedAccountChecking: "Buscando a conta pareada…",
  pairingPreparing: "Preparando o pareamento…",
  pairingWaiting: "Aguardando a mensagem com o código no Telegram…",
  pairingFinishing: "Concluindo o pareamento…",
  whisperEnvCreating: "Criando o ambiente Python da transcrição…",
  whisperInstalling: "Instalando o faster-whisper…",
  modelRemoving: (model) => `Removendo o modelo ${model}…`,
  marketplaceRemoving: (name) => `Removendo o marketplace '${name}'…`,
  transcriptionRemoving: "Apagando os arquivos da transcrição…",
  mermaidRemoving: "Removendo o mermaid-cli…",
  transcriptionReady: (model) =>
    `Instalado:\n  • modelo ${model} da transcrição local`,
  languageQuestion: "Language / Idioma",
  languageSaved: (locale, file) => `Idioma ${locale} salvo em ${file}.`,
  statuslinePrompt: (example) =>
    `O rodapé do Claude Code (statusline) pode mostrar se o Telegram está conectado, assim:\n  • ${example}\nMostrar?`,
  statuslineInstalled: (file) => `Statusline configurada em ${file}.`,
  statuslineKept:
    "Statusline mantida:\n  • a sua continua, sem o indicador do Telegram",
  statuslineSkipped: "Statusline sem mudança.",
  statuslineChoiceQuestion: (preview, example) =>
    `Você já tem uma statusline (${preview}).\nOnde mostrar o indicador do Telegram (${example})?`,
  statuslineChoices: {
    after: "Junto da sua",
    replace: "No lugar da sua",
    custom: "Pedir ao Claude para customizar com a minha",
    keep: "Em lugar nenhum (manter só a sua)",
    keepCustom: "Manter a sua (já com o indicador)",
  },
  statuslineChoiceHints: {
    after: "a sua continua e o indicador aparece ao lado",
    replace: "só o indicador; a sua fica guardada e volta no uninstall",
    custom:
      "no próximo 'claude --telegram', o Claude junta o indicador à sua do jeito que você quiser",
    keep: "nada muda",
  },
  statuslineCustomKept:
    "Statusline mantida:\n  • a sua, com o indicador que o Claude juntou",
  statuslineCustomRequested:
    "Pedido anotado:\n  • no próximo 'claude --telegram', o Claude pergunta como juntar o indicador à sua statusline",
  statuslineCustomNeedsOwn:
    "Não há uma statusline sua para juntar o indicador; use on para mostrar só ele.",
  statuslineCustomPrompt: (settingsFile, current, indicator, example) =>
    [
      "O setup do better-claude-code-telegram pediu que você junte o indicador do Telegram à minha statusline.",
      "",
      `Minha statusline hoje (statusLine em ${settingsFile}):`,
      `  ${current}`,
      "",
      "O indicador é este comando:",
      `  ${indicator}`,
      `Ele imprime o estado do Telegram com cor ANSI (por exemplo ${example}) ou nada, e não lê a entrada.`,
      "",
      "Faça assim:",
      "  • antes de mudar algo, pergunte como eu quero juntar os dois (onde fica o indicador, separador, cor)",
      "  • mude só a minha statusline, para ela chamar também o indicador",
      "  • se o arquivo do indicador não existir mais, a statusline continua funcionando sem ele",
      "  • no fim, mostre o que mudou",
    ].join("\n"),
  statuslineCustomLeft: (command) =>
    `A sua statusline ainda chama o indicador do Telegram, que o Claude juntou a ela. Peça ao Claude para tirar esta chamada:\n  ${command}`,
  statuslineChained: (file) =>
    `Indicador do Telegram acrescentado depois da sua statusline em ${file}.`,
  statuslineReplaced: (file, backup) =>
    `Statusline trocada em ${file}; as configurações anteriores estão em ${backup}.`,
  statuslineAlready: "O indicador do Telegram já está na sua statusline.",
  statuslineOursQuestion: (example) =>
    `O indicador do Telegram (${example}) já está na sua statusline. O que fazer com ele?`,
  statuslineOursChoices: {
    keep: "Manter",
    remove: "Remover",
  },
  statuslineOursHints: {
    keep: "nada muda",
    restore: "a sua statusline anterior volta",
    remove: "o rodapé fica sem statusline",
  },
  statuslineOursKept: "Statusline mantida com o indicador do Telegram.",
  statuslineRestored: (file) => `Sua statusline anterior voltou em ${file}.`,
  settingsInvalid: (file) =>
    `${file} não é um objeto JSON válido. Corrija e rode o setup de novo; nada foi alterado.`,
  doneAll: "Pronto. Abra um terminal novo e rode 'claude --telegram'.",
  doneReopen: "Pronto. Reabra o 'claude --telegram' para valer.",
  doneLive: "Pronto. Já vale para as próximas mensagens, sem reabrir nada.",
  questionReleased: (instance, headers) =>
    `Pergunta de [${instance}] solta: ${headers}`,
  nothingPending: (sessionPrefix) =>
    sessionPrefix
      ? `Nenhuma pergunta pendente da sessão ${sessionPrefix}.`
      : "Nenhuma pergunta pendente.",
  fileNotSaved: (file) => `Não foi possível gravar ${file}.`,
  fileNotRemoved: (file) => `Não foi possível remover ${file}.`,
  statuslineNotShown: "Não foi possível mostrar a statusline.",
  healthNotShown: "Não foi possível mostrar o resultado.",
  outputNotShown: "Não foi possível escrever na saída.",
  selfInstallDone: (version, channel) =>
    `bcct ${version} instalado (${channel}).`,
  selfInstallUnstable: (channel) =>
    `Esta é uma versão de teste (${channel}): ela pode mudar ou quebrar antes da estável.`,
  selfInstallHashMismatch:
    "O arquivo não confere com o hash esperado; nada foi instalado.",
  selfInstallNotBcct: "O arquivo não respondeu como bcct; nada foi instalado.",
  selfInstallFailed:
    "Não foi possível instalar o bcct: falha ao ler ou gravar o arquivo ou a pasta do app.",
  selfInstallUsage:
    "Uso: bcct self-install <arquivo> --sha256 <hash> [--from npm|release|manual]",
  pathQuestion:
    "Adicionar o comando bcct ao PATH, para usar 'bcct setup', 'bcct health' e os outros direto no terminal, sem o npx?",
  pathAdded: (file) =>
    `${file} passou a adicionar o bcct ao PATH. Vale nos terminais novos.`,
  pathAlready: (file) => `${file} já adiciona o bcct ao PATH.`,
  pathRemoved: (file) => `${file} não adiciona mais o bcct ao PATH.`,
  pathOff:
    "bcct fora do PATH. Para usar direto depois, rode 'npx better-claude-code-telegram path'.",
  hookWriteFailed: (file, reason) =>
    `bcct: não consegui gravar ${file} (${reason}). As mensagens do Telegram podem não chegar. Rode /bcct:health.`,
  hookFailedOften: (event, count, reason) =>
    `bcct: o hook ${event} falhou ${count} vezes em 24 h (${reason}). Rode /bcct:health.`,
  hookReasons: {
    noPermission: "sem permissão de escrita",
    diskFull: "disco cheio",
    readOnly: "sistema de arquivos só de leitura",
    quota: "cota de disco excedida",
    busy: "arquivo ocupado ou mexido por outra instância",
    input: "entrada inesperada do Claude Code",
  },
};

export const MESSAGES = { "en-us": enUs, "pt-br": ptBr };

export function messagesFor(locale) {
  return MESSAGES[LOCALES.includes(locale) ? locale : DEFAULT_LOCALE];
}
