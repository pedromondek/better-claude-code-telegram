use super::{
    BcctChoices, BcctHints, ChangeKinds, ChannelNames, FixTexts, HealthDetail, HealthGroupTitles,
    HealthLabels, HookReasons, Messages, PairingChoices, QuietPresets, SettingHints, SettingsKeys,
    StatuslineChoiceHints, StatuslineChoices, StatuslineDetail, StatuslineOursChoices,
    StatuslineOursHints, StepLabels, StepTitles, TranscriptionModels,
};

pub(super) const MESSAGES: Messages = Messages {
    status_main: "(Main)",
    status_secondary: "(Secondary)",
    status_connected: |role| format!("📱 {role} Telegram connected"),
    status_down: |role| format!("📱 {role} Telegram down"),
    status_connecting: |role| format!("📱 {role} Telegram connecting…"),
    step_labels: StepLabels {
        token: "bot token",
        pairing: "pairing",
    },
    step_titles: StepTitles {
        language: "Language / Idioma",
        plugin: "Plugins",
        token: "Bot token",
        pairing: "Pairing",
        delay: "Wait time",
        quiet_hours: "Quiet hours",
        transcription: "Audio transcription",
        inbox: "Received files",
        statusline: "Status line",
        path: "bcct command in the terminal",
        health: "Final check",
    },
    health_has_failures: |command| {
        format!("Some checks failed. Fix what is marked with ✘ and run '{command}' again.")
    },
    not_configured: |missing, command| {
        format!(
            "'claude --telegram' is not set up yet. Missing:\n  • {missing}\nRun '{command}' first."
        )
    },
    already_running: |pid| {
        format!(
            "A 'claude --telegram' instance is already open (bot in process {pid}). Close it before opening another one."
        )
    },
    unknown_steps: |unknown, all| {
        format!(
            "Unknown step:\n  • {unknown}\nUse one or more of these (none runs them all):\n  • {all}"
        )
    },
    network_failure: |method| format!("Network failure calling Telegram ({method})."),
    telegram_refused: |method, description| {
        format!("Telegram refused {method}:\n  • {description}")
    },
    no_description: "no description",
    failed: |description| format!("Failed:\n  • {description}"),
    yes_no_hint: |default_yes| format!("(y/n) [default: {}]", if default_yes { "y" } else { "n" }),
    default_hint: |value| format!("[default: {value}]"),
    language_default_hint: |value| format!("[default / padrão: {value}]"),
    select_hint: "↑/↓ to move · Enter to confirm",
    yes: "Yes",
    no: "No",
    custom: "Custom",
    recommended: "Recommended",
    previous_choice: "previously chosen",
    invalid_answer: |value, hint| format!("'{value}' is not valid. Use:\n  • {hint}"),
    enter_keeps_default: "Press Enter on an empty answer to keep the default or the existing setting.",
    cancelled: "Cancelled.",
    exit_prompt: "Leave the setup?",
    continue_setup: "Go on where it stopped",
    exit_setup: "Leave",
    interrupted: "Setup interrupted.",
    nothing_changed: "Nothing was changed.",
    done_so_far: |changes| format!("So far the setup has:\n  • {changes}"),
    undo_prompt: "Undo what the setup did?",
    undo_all: "Undo everything",
    keep_done: "Keep it as it is",
    undone: "Everything the setup did was undone.",
    undo_left: |changes| format!("Could not undo:\n  • {changes}"),
    kept_done: |command| format!("Kept. Run '{command}' to go on later."),
    changed_setting: |label, before, after| format!("{label}: {before} → {after}"),
    not_set: "not set",
    rule_on: "on",
    rule_off: "off",
    plugin_on: "enabled",
    plugin_off: "disabled",
    plugin_setting: |plugin_id| format!("plugin '{plugin_id}'"),
    undoing: |change| format!("Undoing: {change}…"),
    undone_item: |change| format!("Undone:\n  • {change}"),
    settings_keys: SettingsKeys {
        status_line: "status line",
        permissions: "security rule for the token file",
        enabled_plugins: "enabled plugins",
    },
    change_kinds: ChangeKinds {
        file_created: |target| format!("created {target}"),
        file_changed: |target| format!("changed {target}"),
        dir_created: |target| format!("created the folder {target}"),
        marketplace_added: |target| format!("registered the marketplace '{target}'"),
        plugin_installed: |target| format!("installed the plugin '{target}'"),
        plugin_removed: |target| format!("removed the plugin '{target}'"),
        tool_installed: |target| {
            format!("installed {target}, which stays installed (remove it by hand if you want)")
        },
    },
    tools_declined: |tools| format!("Nothing was installed; {tools} is still missing from PATH."),
    invalid_setting: |step, value, hint| {
        format!("'{value}' is not a valid {step}. Use:\n  • {hint}\nNothing was changed.")
    },
    setting_hints: SettingHints {
        language: "en-us or pt-br",
        delay: "the minutes, greater than 0 (for example 3)",
        quiet_hours: "HH:MM-HH:MM (for example 22:00-08:00) or off",
        transcription: "base, small, medium or off",
        inbox: "the days, greater than 0, or off",
        statusline: "on, after, replace, custom or off",
    },
    inbox_question: "Days to keep the photos and files received on Telegram before deleting them",
    inbox_days_label: |days| format!("{days} day(s)"),
    inbox_forever_label: "Never delete",
    inbox_custom_prompt: "Days (greater than 0): ",
    inbox_custom_hint: "a whole number of days greater than 0",
    inbox_saved: |retention, file| format!("Received files:\n  • {retention}\nSaved in {file}."),
    inbox_kept: |retention| format!("Received files kept:\n  • {retention}"),
    language_kept: |locale| format!("Language kept:\n  • {locale}"),
    delay_kept: |minutes| format!("Wait time kept:\n  • {minutes} min"),
    quiet_kept: |value| format!("Quiet hours kept:\n  • {value}"),
    transcription_model_kept: |model| {
        format!("Local transcription kept with the {model} model, already installed.")
    },
    transcription_kept_off: "Local transcription stays off.",
    transcription_switched: |model| {
        format!("Local transcription on with the {model} model, already installed.")
    },
    remove_models_question: "Which transcription models should be uninstalled?",
    remove_models_keep: "None (keep it as it is)",
    remove_models_all: |models| format!("All of them ({models})"),
    remove_model: |model| format!("Only the {model} model"),
    model_in_use: "in use",
    model_used_until_now: "used until now",
    transcription_uninstall: "Uninstall",
    transcription_installed_heading: "Installed:",
    transcription_available_heading: "To download:",
    models_removed: |models| format!("Transcription models removed:\n  • {models}"),
    inbox_days: |days| format!("deleted after {days} day(s)"),
    inbox_forever: "kept forever",
    not_settable: |step, steps| {
        format!(
            "'{step}' cannot be set with --set, only {steps}. The token, the pairing and the plugins go through 'npx better-claude-code-telegram' in your own terminal."
        )
    },
    unknown_health_groups: |groups, valid| {
        format!("Unknown group:\n  • {groups}\nUse all, or one or more of these:\n  • {valid}")
    },
    health_group_titles: HealthGroupTitles {
        install: "Install",
        telegram: "Telegram",
        security: "Security",
        extras: "Extras",
    },
    health_labels: HealthLabels {
        node: "Node",
        user: "Running as root",
        claude: "claude",
        bun: "bun",
        git: "Git",
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
        app_dir: "App folder",
        hooks: "Hooks",
    },
    health_detail: HealthDetail {
        version: |version| format!("Node {version}"),
        found: "found",
        missing: "missing",
        git_missing: "not installed. Claude Code needs it to download and update the plugins.",
        installed: "installed",
        not_installed: |ids| {
            format!("missing {ids}. Run 'npx better-claude-code-telegram plugin'.")
        },
        loaded_in: |file| format!("loaded by {file}"),
        not_loaded: |file| {
            format!("not loaded by {file}. Run 'npx better-claude-code-telegram plugin'.")
        },
        path_on: str::to_owned,
        path_pending: |file| format!("turned on in {file}; it applies to new terminals"),
        path_off: "off (optional). Run 'npx better-claude-code-telegram path'.",
        bot: |username| format!("@{username}"),
        no_token: "no token. Run 'npx better-claude-code-telegram token' in your own terminal.",
        paired: |account| format!("paired with one account ({account})"),
        not_paired: "not paired. Run 'npx better-claude-code-telegram pairing'.",
        not_allowlist: |policy| {
            format!(
                "dmPolicy is {policy}, so strangers who write to the bot get a pairing code. Run 'npx better-claude-code-telegram pairing'."
            )
        },
        pending_pairings: |count| {
            format!(
                "{count} pairing(s) pending in access.json. Run 'npx better-claude-code-telegram pairing'."
            )
        },
        groups_allowed: |count| {
            format!(
                "{count} group(s) can talk to the bot. Run 'npx better-claude-code-telegram pairing'."
            )
        },
        groups_off: "the bot cannot be added to groups",
        groups_unknown: "needs a working bot token",
        regular_user: "no, runs as a regular user (as recommended)",
        root: "running as root; use a regular user, so Claude cannot change the whole machine",
        connected: "connected",
        not_open: "'claude --telegram' is not open",
        connecting: "connecting; 'claude --telegram' was just opened",
        down: "the bot stopped receiving messages; reopen 'claude --telegram'",
        protected: "Claude cannot read the bot token",
        unprotected: |command| format!("Claude can read the bot token. Run '{command}'."),
        valid: "valid",
        invalid: |file| format!("{file} is not valid JSON"),
        off: "off",
        model: |model| format!("model {model}"),
        broken: |command| format!("the Python environment does not work. Run '{command}'."),
        statusline: StatuslineDetail {
            ours: "Telegram indicator on",
            ours_after: "Telegram indicator after your status line",
            other: "another status line, without the indicator",
            none: "no status line",
            custom: "yours, with the indicator Claude added",
            custom_pending: "Claude fits the indicator into yours on the next 'claude --telegram'",
        },
        shell_commented: |rc| {
            format!(
                "the line in {rc} is commented out. Run 'npx better-claude-code-telegram plugin'."
            )
        },
        shell_script_missing: |rc, script| {
            format!(
                "{rc} loads {script}, which does not exist. Run 'npx better-claude-code-telegram plugin'."
            )
        },
        shell_script_outdated: |script| {
            format!("{script} is out of date. Run 'npx better-claude-code-telegram plugin'.")
        },
        launcher_active: |version, channel| format!("version {version} active ({channel})"),
        launcher_missing: |folder| {
            format!("no launcher in {folder}. Run 'npx better-claude-code-telegram'.")
        },
        launcher_no_version: "the launcher has no active version. Run 'npx better-claude-code-telegram'.",
        app_writable: "writable",
        app_no_permission: |folder| {
            format!("cannot write to {folder} (no write permission). Run 'chmod u+rwx {folder}'.")
        },
        app_other_owner: |folder, user| {
            format!("{folder} belongs to another user. Run 'sudo chown -R {user} {folder}'.")
        },
        app_blocked: |folder, reason| {
            format!(
                "cannot write to {folder} ({reason}). Free some space or mount the disk read-write."
            )
        },
        no_hook_failures: "no recent failures",
        hook_write_failed: |event, file, reason| {
            format!("the {event} hook could not write {file} ({reason})")
        },
        hook_failed_often: |event, count, reason| {
            format!("the {event} hook failed {count} times in 24 h ({reason})")
        },
        no_home: "HOME is not set, so the shell rc cannot be found.",
        bot_answer_unexpected: "Telegram answered getMe without the bot data. Try again in a moment.",
        deny_not_a_list: |settings| {
            format!(
                "permissions.deny in {settings} is not a list. Fix the file and run 'npx better-claude-code-telegram token'."
            )
        },
    },
    install_tool_prompt: |tool, command| {
        format!("'{tool}' is missing. Install it now with the official installer ({command})?")
    },
    tool_installed: |tool, bin_dir| {
        format!(
            "'{tool}' installed in {bin_dir}. Open a new terminal later so your shell finds it."
        )
    },
    install_failed: |tool| format!("The installer of '{tool}' failed; nothing else was changed."),
    tool_still_missing: |tool, bin_dir| {
        format!("'{tool}' was installed but is not in {bin_dir}; check the installer output.")
    },
    node_too_old: |version, minimum| {
        format!(
            "Node {version} is too old; the setup needs Node {minimum} or newer (see .nvmrc; with nvm, run nvm install)."
        )
    },
    bcct_prompt: "(optional) Also add the /bcct: commands to Claude Code (setup steps and health from inside a session)?",
    bcct_installed_question: "(optional) The /bcct: commands are already in Claude Code. What should happen to them?",
    bcct_choices: BcctChoices {
        keep: "Keep them",
        remove: "Remove them",
    },
    bcct_hints: BcctHints {
        keep: "nothing changes",
        remove: "the /bcct: commands leave Claude Code; the setup goes on from the terminal",
    },
    plugins_checked: "Checked:",
    required_plugins: |installed, total| {
        format!("{installed} of {total} required plugins installed")
    },
    optional_plugins: |installed, total| {
        format!("{installed} of {total} optional plugin installed")
    },
    marketplace_found: "Marketplace registered",
    marketplace_missing: "Marketplace not registered yet",
    plan_header: "To finish this step, the setup needs to:",
    plan_marketplace: |name| format!("register the marketplace '{name}' from this folder"),
    plan_plugin: |id| format!("install the plugin '{id}' for your user"),
    plan_shell_line: |file| format!("add to {file} the line that loads 'claude --telegram'"),
    plan_prompt: "Go ahead with the installation?",
    nothing_installed: "Nothing was installed.",
    by_hand: "To do it by hand, run:",
    marketplace_added: |name| format!("Marketplace '{name}' registered."),
    plugins_checking: "Checking the marketplace and the installed plugins…",
    marketplace_adding: |name| format!("Registering the marketplace '{name}'…"),
    plugin_installing: |id| format!("Installing the plugin '{id}'…"),
    plugin_removing: |id| format!("Removing the plugin '{id}'…"),
    plugin_enabling: |id| format!("Enabling '{id}' in every instance…"),
    plugin_disabling: |id| format!("Disabling '{id}' outside 'claude --telegram'…"),
    plugin_added: |id| format!("Plugin '{id}' installed for your user."),
    marketplace_registered: |name| format!("Marketplace '{name}' already registered."),
    plugin_installed: |id| format!("Plugin '{id}' already installed."),
    plugin_disabled_outside: |id| format!("Plugin '{id}' disabled outside 'claude --telegram'."),
    plugin_enabled: |id| format!("Plugin '{id}' enabled in every instance."),
    plugin_already_disabled_outside: |id| {
        format!("Plugin '{id}' already disabled outside 'claude --telegram'.")
    },
    plugin_already_enabled: |id| format!("Plugin '{id}' already enabled in every instance."),
    rc_already_loads: |rc_file| format!("{rc_file} already loads 'claude --telegram'."),
    rc_now_loads: |rc_file| format!("{rc_file} now loads 'claude --telegram'."),
    shell_unsupported: |shell, line| {
        format!(
            "The {shell} shell cannot load 'claude --telegram'. Load this line in bash or zsh:\n  {line}"
        )
    },
    rc_no_longer_loads: |rc_file| format!("{rc_file} no longer loads 'claude --telegram'."),
    statusline_removed: |file| format!("Telegram status line removed from {file}."),
    env_rule_removed: |file| {
        format!("Rule that kept Claude from reading the bot token removed from {file}.")
    },
    env_protected: |env_file, settings_file| {
        format!(
            "Security rule added:\n  • Claude Code may not read {env_file}, the file that holds the bot token (deny rule in {settings_file})"
        )
    },
    env_already_protected: |env_file, settings_file| {
        format!(
            "Security rule already on:\n  • Claude Code may not read {env_file} (deny rule in {settings_file})"
        )
    },
    plugin_removed: |plugin_id| format!("Plugin '{plugin_id}' removed."),
    plugin_not_removed: |plugin_id| {
        format!(
            "Could not remove the plugin '{plugin_id}'. To do it by hand, run:\n  claude plugin uninstall {plugin_id} --scope user"
        )
    },
    plugin_not_installed: |plugin_id| format!("Plugin '{plugin_id}' was not installed."),
    marketplace_removed: |name| format!("Marketplace '{name}' removed."),
    marketplace_not_removed: |name| {
        format!(
            "Could not remove the marketplace '{name}'. To do it by hand, run:\n  claude plugin marketplace remove {name}"
        )
    },
    marketplace_not_registered: |name| format!("Marketplace '{name}' was not registered."),
    claude_missing_for_uninstall: |commands| {
        format!("'claude' is not in the PATH. To remove the plugins later, run:\n{commands}")
    },
    close_instance_before_uninstall: "Close 'claude --telegram' before uninstalling; nothing was changed.",
    transcription_found: |paths| {
        format!("Local transcription installed by the setup:\n  • {paths}")
    },
    delete_transcription_prompt: "Remove the local transcription (Python environment and downloaded models)?",
    transcription_removed: "Local transcription removed.",
    transcription_kept: "Local transcription kept.",
    delete_mermaid_prompt: "Also remove mermaid-cli (mmdc), used for the diagrams? The setup did not install it, and other tools may use it.",
    mermaid_removed: "mermaid-cli removed.",
    mermaid_not_removed: |command| {
        format!("Could not remove mermaid-cli. To do it by hand, run:\n  {command}")
    },
    delete_state_prompt: |channel_dir, app_dir| {
        format!(
            "Also delete the bot token and the pairing in {channel_dir} and the settings in {app_dir}?"
        )
    },
    state_deleted: |channel_dir, app_dir| format!("{channel_dir} and {app_dir} deleted."),
    state_kept: |channel_dir, app_dir| {
        format!("Bot token and pairing kept in {channel_dir}, settings in {app_dir}.")
    },
    uninstall_done: "Done. Open a new terminal; this repository folder can now be deleted.",
    no_saved_token: |command| format!("No saved token. Run this first:\n  {command}"),
    use_saved_bot: |username| format!("Use the saved bot, @{username}?"),
    token_prompt: "Bot token (from @BotFather; hidden while you type): ",
    token_saved: |username, file| format!("Token of bot @{username} saved in {file}."),
    no_pairing_message: "No message with the code arrived in 3 min. Run the setup again.",
    already_paired: |accounts| format!("Bot already paired with {accounts}."),
    pairing_choice_question: |accounts| {
        format!("The bot is already paired with {accounts}. What now?")
    },
    pairing_choices: PairingChoices {
        keep: "Keep this account",
        replace: "Pair another account (with a new code)",
    },
    too_many_accounts: |count, command| {
        format!(
            "access.json lets {count} Telegram accounts talk to the bot, but it only talks to one. Run '{command}' to keep only yours."
        )
    },
    permissions_skipped: |option| {
        format!(
            "'claude --telegram' does not start with {option}:\n  • with the channel on, a message on Telegram could make Claude run anything without asking you\nStart it without that option."
        )
    },
    groups_warning: |username| {
        format!(
            "@{username} can be added to groups. In @BotFather send /setjoingroups, pick @{username} and choose Disable."
        )
    },
    close_instance_before_pairing: "Close the 'claude --telegram' instance before pairing, because it holds the bot.",
    webhook_configured: |username| {
        format!("Bot @{username} has a webhook set; use a bot only for Claude.")
    },
    send_pairing_code: |username, code, link| {
        format!(
            "To pair, open this link and tap Start:\n  • {link}\nOr send this code to @{username}:\n  • {code}\nWaiting up to 3 min. Only the message with this code pairs."
        )
    },
    confirm_pairing: |label, user_id| format!("Pair with {label} (id {user_id})?"),
    pairing_cancelled: "Pairing cancelled.",
    paired_chat_message: "Paired with Claude Code.\n\nRun 'claude --telegram' to chat here.",
    paired_with: |label| format!("Paired with {label}; only this account talks to the bot."),
    delay_question: "Minutes without an answer in the terminal before going to Telegram",
    delay_label: |minutes| format!("{minutes} min"),
    delay_custom_prompt: "Minutes (greater than 0): ",
    delay_custom_hint: "a number of minutes greater than 0",
    delay_saved: |minutes, file| format!("Delay of {minutes} min saved in {file}."),
    quiet_question: "Quiet hours, when nothing goes to Telegram",
    quiet_off_label: "Off",
    quiet_presets: QuietPresets {
        outside_work: "Outside business hours",
        full_night: "All night",
        night: "Night",
        late_night: "Small hours",
    },
    quiet_start_prompt: "Start of the quiet hours (HH:MM): ",
    quiet_end_prompt: "End of the quiet hours (HH:MM): ",
    time_hint: "HH:MM, from 00:00 to 23:59",
    quiet_end_hint: |start| format!("HH:MM, from 00:00 to 23:59 and other than {start}"),
    quiet_saved: |value, file| format!("Quiet hours {value} saved in {file}."),
    quiet_off: "off",
    transcription_purpose: "Turns the voice messages you send on Telegram into text, here on your machine, so Claude can read what you said.",
    transcription_question: "Local voice transcription",
    transcription_off_label: "Off",
    transcription_models: TranscriptionModels {
        base: "fastest, uses the least RAM, fine for clear speech, ~150 MB of storage",
        small: "more accurate, slower, uses more RAM, ~490 MB of storage",
        medium: "most accurate, much slower, uses much more RAM, ~1.5 GB of storage",
    },
    transcription_disabled: "Transcription off:\n  • voice messages reach Claude as attachments",
    python_env_failed: "Could not create the Python environment. Install one of these and run the setup again:\n  • uv (curl -LsSf https://astral.sh/uv/install.sh | sh)\n  • Python's venv (on Debian and Ubuntu, sudo apt install python3-venv)",
    git_missing_setup: "git is not installed, and Claude Code needs it to download the plugins. Install it and run the setup again:\n  • Debian and Ubuntu: sudo apt install git\n  • Fedora: sudo dnf install git\n  • macOS: xcode-select --install",
    install_whisper: "install faster-whisper",
    downloading_model: |model| {
        format!("Downloading the {model} transcription model (first time only)…")
    },
    model_download: "download the model",
    saved_bot_checking: "Checking the saved bot…",
    token_checking: "Checking the token with Telegram…",
    paired_account_checking: "Looking up the paired account…",
    pairing_preparing: "Getting the pairing ready…",
    pairing_waiting: "Waiting for the message with the code on Telegram…",
    pairing_finishing: "Finishing the pairing…",
    whisper_env_creating: "Creating the Python environment of the transcription…",
    whisper_installing: "Installing faster-whisper…",
    model_removing: |model| format!("Removing the {model} model…"),
    marketplace_removing: |name| format!("Removing the marketplace '{name}'…"),
    transcription_removing: "Deleting the transcription files…",
    mermaid_removing: "Removing mermaid-cli…",
    transcription_ready: |model| {
        format!("Installed:\n  • the {model} model of the local transcription")
    },
    language_question: "Language / Idioma",
    language_saved: |locale, file| format!("Language {locale} saved in {file}."),
    statusline_prompt: |example| {
        format!(
            "Claude Code's footer (status line) can show whether Telegram is connected, like this:\n  • {example}\nShow it?"
        )
    },
    statusline_installed: |file| format!("Status line set in {file}."),
    statusline_kept: "Status line kept:\n  • yours stays, without the Telegram indicator",
    statusline_skipped: "Status line left unchanged.",
    statusline_choice_question: |preview, example| {
        format!(
            "You already have a status line ({preview}).\nWhere should the Telegram indicator ({example}) go?"
        )
    },
    statusline_choices: StatuslineChoices {
        after: "Next to yours",
        replace: "Instead of yours",
        custom: "Ask Claude to fit it into mine",
        keep: "Nowhere (keep only yours)",
        keep_custom: "Keep yours (it already has the indicator)",
    },
    statusline_choice_hints: StatuslineChoiceHints {
        after: "yours stays and the indicator shows beside it",
        replace: "only the indicator; yours is saved and comes back on uninstall",
        custom: "on the next 'claude --telegram', Claude fits the indicator into yours the way you want",
        keep: "nothing changes",
    },
    statusline_custom_kept: "Status line kept:\n  • yours, with the indicator Claude added",
    statusline_custom_requested: "Request noted:\n  • on the next 'claude --telegram', Claude asks how to fit the indicator into your status line",
    statusline_custom_needs_own: "There is no status line of yours to fit the indicator into; use on to show only the indicator.",
    statusline_custom_prompt: |settings_file, current, indicator, example| {
        format!(
            "The better-claude-code-telegram setup asked you to fit the Telegram indicator into my status line.\n\nMy status line today (statusLine in {settings_file}):\n  {current}\n\nThe indicator is this command:\n  {indicator}\nIt prints the Telegram state with ANSI color (for example {example}) or nothing, and does not read its input.\n\nDo it like this:\n  • before changing anything, ask how I want the two together (where the indicator goes, separator, color)\n  • change only my status line, so it also calls the indicator\n  • if the indicator file no longer exists, the status line keeps working without it\n  • at the end, show what changed"
        )
    },
    statusline_custom_left: |command| {
        format!(
            "Your status line still calls the Telegram indicator, which Claude added to it. Ask Claude to remove this call:\n  {command}"
        )
    },
    statusline_chained: |file| {
        format!("Telegram indicator added after your status line in {file}.")
    },
    statusline_replaced: |file, backup| {
        format!("Status line replaced in {file}; the previous settings are in {backup}.")
    },
    statusline_already: "The Telegram indicator is already in your status line.",
    statusline_ours_question: |example| {
        format!(
            "The Telegram indicator ({example}) is already in your status line. What should happen to it?"
        )
    },
    statusline_ours_choices: StatuslineOursChoices {
        keep: "Keep it",
        remove: "Remove it",
    },
    statusline_ours_hints: StatuslineOursHints {
        keep: "nothing changes",
        restore: "your previous status line comes back",
        remove: "the footer is left without a status line",
    },
    statusline_ours_kept: "Status line kept with the Telegram indicator.",
    statusline_restored: |file| format!("Your previous status line is back in {file}."),
    settings_invalid: |file| {
        format!(
            "{file} is not a valid JSON object. Fix it and run the setup again; nothing was changed."
        )
    },
    done_all: "Done. Open a new terminal and run 'claude --telegram'.",
    done_reopen: "Done. Reopen 'claude --telegram' for it to apply.",
    done_live: "Done. It applies to the next messages, nothing to reopen.",
    question_released: |instance, headers| {
        format!("Released the question from [{instance}]: {headers}")
    },
    nothing_pending: |session_prefix| match session_prefix {
        Some(prefix) if !prefix.is_empty() => {
            format!("No pending question from session {prefix}.")
        }
        _ => "No pending question.".to_owned(),
    },
    file_not_saved: |file| format!("Could not save {file}."),
    file_not_removed: |file| format!("Could not remove {file}."),
    statusline_not_shown: "Could not show the status line.",
    health_not_shown: "Could not show the result.",
    output_not_shown: "Could not write to the output.",
    self_install_done: |version, channel| format!("bcct {version} installed ({channel})."),
    self_install_unstable: |channel| {
        format!("This is a test version ({channel}): it may change or break before the stable one.")
    },
    self_install_hash_mismatch: "The file does not match the expected hash; nothing was installed.",
    self_install_not_bcct: "The file did not answer as bcct; nothing was installed.",
    self_install_failed: "Could not install bcct: the file or the app folder could not be read or written.",
    self_install_usage: "Usage: bcct self-install <file> --sha256 <hash> [--from npm|release|manual]",
    version_installed: "Installed:",
    version_active: "active",
    version_channels: ChannelNames {
        stable: "stable",
        beta: "beta",
        alpha: "alpha",
    },
    version_remove_hint: "To delete a kept one: npx better-claude-code-telegram uninstall <version>",
    version_uninstall_hint: "To uninstall everything: npx better-claude-code-telegram uninstall",
    version_unstable: |channel| {
        format!("Test version ({channel}). For the stable one: 'bcct update stable'.")
    },
    uninstall_version_removed: |version| format!("Deleted {version}."),
    uninstall_version_active: |version| {
        format!("{version} is in use. Switch first with 'bcct update'.")
    },
    uninstall_version_missing: |version| format!("{version} is not installed."),
    path_question: "Add the bcct command to your PATH, so 'bcct setup', 'bcct health' and the others work right in the terminal, without npx?",
    path_added: |file| format!("{file} now adds bcct to your PATH. It applies to new terminals."),
    path_already: |file| format!("{file} already adds bcct to your PATH."),
    path_removed: |file| format!("{file} no longer adds bcct to your PATH."),
    path_off: "bcct stays off your PATH. To use it directly later, run 'npx better-claude-code-telegram path'.",
    hook_write_failed: |file, reason| {
        format!(
            "bcct: could not write {file} ({reason}). Telegram messages may not arrive. Run /bcct:health."
        )
    },
    hook_failed_often: |event, count, reason| {
        format!("bcct: the {event} hook failed {count} times in 24 h ({reason}). Run /bcct:health.")
    },
    hook_reasons: HookReasons {
        no_permission: "no write permission",
        disk_full: "disk full",
        read_only: "read-only file system",
        quota: "disk quota exceeded",
        busy: "file busy or changed by another instance",
        input: "unexpected input from Claude Code",
    },
    fix: FixTexts {
        can_fix: "I can fix:",
        only_recommend: "I only recommend:",
        question: "Which ones? (1, 2, ... or all; Enter: none):",
        nothing: "Nothing I can fix on my own.",
        fixed: |action| format!("Fixed: {action}"),
        could_not: |action, error| format!("Could not: {action} ({error})"),
        checking_again: "Checking again:",
        how_to_apply: "To apply, run 'bcct health --fix --yes' or pick with '--only shell,protection'.",
        invalid_answer: |count| {
            format!("Answer with numbers from the list (1 to {count}), 'all' or Enter.")
        },
        unknown: |ids, valid| format!("Unknown fixes: {ids}. The possible ones are: {valid}."),
        shell: |rc| format!("rewrite shell.sh and the line in {rc}"),
        protection: |settings| {
            format!("add the rule that keeps Claude from reading the token to {settings}")
        },
        statusline: |settings| {
            format!("replace the old command (from the clone) with the current one in {settings}")
        },
        app_dir: |folder| format!("give write permission to {folder}"),
    },
};
