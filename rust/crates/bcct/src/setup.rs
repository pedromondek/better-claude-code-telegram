use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Map, Value};

use crate::config::read_config;
use crate::files::{FileFailure, create_private_dir, read_json, write_private};
use crate::journal::Journal;
use crate::js::{
    join_path, js_basename, js_number, js_trim, js_truthy, normalize_path, parse_json, stringify,
};
use crate::locale::Locale;
use crate::messages::{Messages, messages_for};
use crate::paths::{LAUNCH_FILE, Paths};
use crate::settings::remove_if_present;
use crate::setup_files::{CUSTOMIZED_KEY, update_config};

pub use crate::package::SETUP_COMMAND;
pub const STATUSLINE_REQUEST_FILE: &str = "statusline-customize.json";
pub const CHANNEL_PLUGIN_ID: &str = "telegram@better-claude-code-telegram";
pub const HOOKS_PLUGIN_ID: &str = "telegram-hooks@better-claude-code-telegram";
pub const MINIMUM_NODE: &str = "24.11";
pub const ENV_FILE: &str = ".env";
pub const ACCESS_FILE: &str = "access.json";

const SETTINGS_FILE: &str = "settings.json";
const MINIMUM_NODE_MAJOR: f64 = 24.0;
const MINIMUM_NODE_MINOR: f64 = 11.0;
const SHELL_SCRIPT: &str = "shell.sh";
const LAUNCHER: &str = if cfg!(windows) {
    "bin/bcct.cmd"
} else {
    "bin/bcct"
};
const SHELL_LAUNCHER: &str = "bin/bcct";
const LAUNCHER_FOLDER: &str = "bin";
pub const COMMAND_ON_PATH_KEY: &str = "commandOnPath";
const DEFAULT_SHELL: &str = "bash";
const WHISPER_CHECK: &str = "import importlib.metadata as m; assert m.version(\"faster-whisper\") == \"1.2.1\" and m.version(\"av\") == \"18.1.0\"";
const BOT_PID_FILE: &str = "bot.pid";
const TOKEN_KEY: &str = "TELEGRAM_BOT_TOKEN=";
const JS_LINE_BREAKS: [char; 4] = ['\n', '\r', '\u{2028}', '\u{2029}'];
const LOCALE_VARIABLES: [&str; 3] = ["LC_ALL", "LC_MESSAGES", "LANG"];
const SKIP_PERMISSION_FLAGS: [&str; 3] = [
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode=bypassPermissions",
];
const PERMISSION_MODE_FLAG: &str = "--permission-mode";
const BYPASS_MODE: &str = "bypassPermissions";
const BOT_SERVER: &str = "server.ts";
const STATUSLINE_SUBCOMMAND: &str = " statusline";
const CLONE_STATUSLINE_SCRIPT: &str = "/plugins/telegram-hooks/statusline.mjs";
const CLONE_STATUSLINE_PREFIX: &str = "node \"";
const AFTER_PREVIOUS_FLAG: &str = " --after-previous";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStep {
    Token,
    Pairing,
}

impl SetupStep {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Pairing => "pairing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatuslineKind {
    None,
    Ours,
    OursAfter,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupPaths {
    pub app_dir: PathBuf,
    pub state_dir: PathBuf,
    pub settings_file: PathBuf,
}

impl SetupPaths {
    #[must_use]
    pub fn resolve(var: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> Self {
        let paths = Paths::resolve(var, home);

        Self {
            app_dir: normalize_path(&paths.app_dir),
            state_dir: normalize_path(&paths.telegram_state_dir),
            settings_file: join_path(&paths.claude_dir, SETTINGS_FILE),
        }
    }
}

#[must_use]
pub fn suggested_locale(var: &dyn Fn(&str) -> Option<OsString>) -> Locale {
    let system = LOCALE_VARIABLES
        .iter()
        .find_map(|name| var(name).filter(|value| !value.is_empty()))
        .map(|value| value.to_string_lossy().to_lowercase().replace('_', "-"))
        .unwrap_or_default();

    Locale::ALL
        .into_iter()
        .find(|locale| system.starts_with(locale.as_str()))
        .unwrap_or_default()
}

#[must_use]
pub fn setup_locale(app_dir: &Path, var: &dyn Fn(&str) -> Option<OsString>) -> Locale {
    read_config(app_dir)
        .get("language")
        .and_then(Value::as_str)
        .and_then(Locale::parse)
        .unwrap_or_else(|| suggested_locale(var))
}

#[must_use]
pub fn read_text(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

#[must_use]
pub fn parse_env_token(text: &str) -> Option<String> {
    text.split(JS_LINE_BREAKS)
        .find_map(|line| line.strip_prefix(TOKEN_KEY).filter(|rest| !rest.is_empty()))
        .map(|token| js_trim(token).to_owned())
}

#[must_use]
pub fn is_paired(access: Option<&Value>) -> bool {
    access
        .and_then(|access| access.get("allowFrom"))
        .and_then(Value::as_array)
        .is_some_and(|allowed| !allowed.is_empty())
}

#[must_use]
pub fn missing_setup_steps(state_dir: &Path) -> Vec<SetupStep> {
    let mut missing = Vec::new();
    let token = parse_env_token(&read_text(&join_path(state_dir, ENV_FILE)).unwrap_or_default());

    if token.is_none_or(|token| token.is_empty()) {
        missing.push(SetupStep::Token);
    }

    if !is_paired(read_json(&join_path(state_dir, ACCESS_FILE)).as_ref()) {
        missing.push(SetupStep::Pairing);
    }

    missing
}

#[must_use]
pub fn skipped_permissions(args: &[String], settings: Option<&Value>) -> Option<String> {
    for (index, arg) in args.iter().enumerate() {
        if SKIP_PERMISSION_FLAGS.contains(&arg.as_str()) {
            return Some(arg.clone());
        }

        if arg == PERMISSION_MODE_FLAG
            && args.get(index + 1).is_some_and(|next| next == BYPASS_MODE)
        {
            return Some(format!("{arg} {BYPASS_MODE}"));
        }
    }

    settings
        .and_then(|settings| settings.get("permissions"))
        .and_then(|permissions| permissions.get("defaultMode"))
        .is_some_and(|mode| mode == BYPASS_MODE)
        .then(|| format!("defaultMode {BYPASS_MODE}"))
}

#[must_use]
pub fn telegram_instance_running(state_dir: &Path) -> Option<String> {
    let text = read_text(&join_path(state_dir, BOT_PID_FILE))?;
    let pid = js_trim(&text);

    if pid.is_empty() {
        return None;
    }

    let output = Command::new("ps")
        .args(["-p", pid, "-o", "args="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    String::from_utf8_lossy(&output.stdout)
        .contains(BOT_SERVER)
        .then(|| pid.to_owned())
}

#[must_use]
pub fn check_setup(
    paths: &SetupPaths,
    var: &dyn Fn(&str) -> Option<OsString>,
    args: &[String],
    is_running: &dyn Fn(&Path) -> Option<String>,
) -> Option<String> {
    let messages = messages_for(setup_locale(&paths.app_dir, var));
    let missing = missing_setup_steps(&paths.state_dir);

    if !missing.is_empty() {
        let labels: Vec<&str> = missing
            .iter()
            .map(|step| match step {
                SetupStep::Token => messages.step_labels.token,
                SetupStep::Pairing => messages.step_labels.pairing,
            })
            .collect();

        return Some((messages.not_configured)(&labels.join(", "), SETUP_COMMAND));
    }

    let accounts = read_json(&join_path(&paths.state_dir, ACCESS_FILE))
        .and_then(|access| {
            access
                .get("allowFrom")
                .and_then(Value::as_array)
                .map(Vec::len)
        })
        .unwrap_or_default();

    if accounts > 1 {
        return Some((messages.too_many_accounts)(
            u64::try_from(accounts).unwrap_or(u64::MAX),
            &format!("{SETUP_COMMAND} pairing"),
        ));
    }

    let from_settings = || {
        skipped_permissions(&[], read_json(&paths.settings_file).as_ref())
            .map(|found| format!("{found} ({})", paths.settings_file.display()))
    };

    if let Some(bypass) = skipped_permissions(args, None).or_else(from_settings) {
        return Some((messages.permissions_skipped)(&bypass));
    }

    is_running(&paths.state_dir).map(|pid| (messages.already_running)(&pid))
}

fn save_private(path: &Path, contents: &[u8]) -> Result<(), FileFailure> {
    path.parent()
        .map_or(Ok(()), create_private_dir)
        .and_then(|()| write_private(path, contents))
        .map_err(|_| FileFailure::NotSaved(path.to_path_buf()))
}

pub fn mark_launch(app_dir: &Path, now: u64) -> Result<(), FileFailure> {
    save_private(
        &join_path(app_dir, LAUNCH_FILE),
        format!("{{\"launchedAt\":{now}}}\n").as_bytes(),
    )
}

#[must_use]
pub fn launcher_file(app_dir: &Path) -> PathBuf {
    join_path(app_dir, LAUNCHER)
}

#[must_use]
pub fn statusline_command(app_dir: &Path) -> String {
    format!(
        "\"{}\"{STATUSLINE_SUBCOMMAND}",
        launcher_file(app_dir).display()
    )
}

#[must_use]
pub fn statusline_after_command(app_dir: &Path) -> String {
    format!("{}{AFTER_PREVIOUS_FLAG}", statusline_command(app_dir))
}

fn is_clone_statusline(command: &str) -> bool {
    command
        .strip_prefix(CLONE_STATUSLINE_PREFIX)
        .and_then(|rest| rest.strip_suffix('"'))
        .is_some_and(|script| {
            script.len() > CLONE_STATUSLINE_SCRIPT.len()
                && !script.contains('"')
                && script.replace('\\', "/").ends_with(CLONE_STATUSLINE_SCRIPT)
        })
}

fn statusline_command_of(status_line: Option<&Value>) -> Option<&str> {
    status_line
        .filter(|value| js_truthy(value))
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
}

#[must_use]
pub fn statusline_kind(status_line: Option<&Value>, app_dir: &Path) -> StatuslineKind {
    if !status_line.is_some_and(js_truthy) {
        return StatuslineKind::None;
    }

    let Some(command) = statusline_command_of(status_line) else {
        return StatuslineKind::Other;
    };

    if command == statusline_command(app_dir) || is_clone_statusline(command) {
        StatuslineKind::Ours
    } else if command == statusline_after_command(app_dir)
        || command
            .strip_suffix(AFTER_PREVIOUS_FLAG)
            .is_some_and(is_clone_statusline)
    {
        StatuslineKind::OursAfter
    } else {
        StatuslineKind::Other
    }
}

#[must_use]
pub fn statusline_is_current(status_line: Option<&Value>, app_dir: &Path) -> bool {
    statusline_command_of(status_line).is_some_and(|command| {
        command == statusline_command(app_dir) || command == statusline_after_command(app_dir)
    })
}

pub fn statusline_prompt(
    take: bool,
    paths: &SetupPaths,
    var: &dyn Fn(&str) -> Option<OsString>,
) -> Result<String, FileFailure> {
    let request_file = join_path(&paths.app_dir, STATUSLINE_REQUEST_FILE);

    if take {
        if !request_file.exists() {
            return Ok(String::new());
        }

        remove_if_present(&request_file).map_err(|_| FileFailure::NotRemoved(request_file))?;
    }

    let current =
        read_json(&paths.settings_file).and_then(|settings| settings.get("statusLine").cloned());

    if statusline_kind(current.as_ref(), &paths.app_dir) != StatuslineKind::Other {
        return Ok(String::new());
    }

    if take {
        let customized = Map::from_iter([(CUSTOMIZED_KEY.to_owned(), Value::Bool(true))]);

        update_config(&paths.app_dir, &customized, &mut Journal::new())?;
    }

    let messages = messages_for(setup_locale(&paths.app_dir, var));

    Ok((messages.statusline_custom_prompt)(
        &paths.settings_file.to_string_lossy(),
        &stringify(&current.unwrap_or_default()),
        &statusline_command(&paths.app_dir),
        &(messages.status_connected)(messages.status_main),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatuslineState {
    None,
    Ours,
    OursAfter,
    Other,
    Custom,
    CustomPending,
}

#[must_use]
pub fn statusline_state(paths: &SetupPaths) -> StatuslineState {
    let current =
        read_json(&paths.settings_file).and_then(|settings| settings.get("statusLine").cloned());

    match statusline_kind(current.as_ref(), &paths.app_dir) {
        StatuslineKind::None => StatuslineState::None,
        StatuslineKind::Ours => StatuslineState::Ours,
        StatuslineKind::OursAfter => StatuslineState::OursAfter,
        StatuslineKind::Other if join_path(&paths.app_dir, STATUSLINE_REQUEST_FILE).exists() => {
            StatuslineState::CustomPending
        }
        StatuslineKind::Other
            if read_config(&paths.app_dir).get(CUSTOMIZED_KEY) == Some(&Value::Bool(true)) =>
        {
            StatuslineState::Custom
        }
        StatuslineKind::Other => StatuslineState::Other,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRcFiles {
    pub primary: Option<PathBuf>,
    pub others: Vec<PathBuf>,
    pub unsupported: Option<String>,
}

#[must_use]
pub fn shell_file(app_dir: &Path) -> PathBuf {
    join_path(app_dir, SHELL_SCRIPT)
}

fn single_quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[must_use]
pub fn shell_script(app_dir: &Path, on_path: bool) -> String {
    let launcher = single_quoted(&join_path(app_dir, SHELL_LAUNCHER).to_string_lossy());
    let function = [
        "claude() {",
        "  local arg",
        "  for arg in \"$@\"; do",
        "    if [ \"$arg\" = \"--telegram\" ]; then",
        &format!("      {launcher} launch \"$@\""),
        "      return",
        "    fi",
        "  done",
        "  command claude \"$@\"",
        "}",
        "",
    ]
    .join("\n");

    if !on_path {
        return function;
    }

    let bin = single_quoted(&launcher_dir(app_dir).to_string_lossy());

    format!(
        "{function}case \":${{PATH}}:\" in\n  *:{bin}:*) ;;\n  *) export PATH={bin}:\"$PATH\" ;;\nesac\n"
    )
}

#[must_use]
pub fn launcher_dir(app_dir: &Path) -> PathBuf {
    join_path(app_dir, LAUNCHER_FOLDER)
}

#[must_use]
pub fn command_on_path(app_dir: &Path) -> bool {
    read_config(app_dir).get(COMMAND_ON_PATH_KEY) == Some(&Value::Bool(true))
}

#[must_use]
pub fn path_lists(path: Option<OsString>, folder: &Path) -> bool {
    path.is_some_and(|path| std::env::split_paths(&path).any(|entry| entry == folder))
}

#[must_use]
pub fn shell_rc_files(home: &str, shell: Option<&str>, macos: bool) -> ShellRcFiles {
    let home = Path::new(home);
    let bashrc = join_path(home, ".bashrc");
    let zshrc = join_path(home, ".zshrc");
    let bash_profile = join_path(home, ".bash_profile");
    let name = js_basename(
        shell
            .filter(|shell| !shell.is_empty())
            .unwrap_or(DEFAULT_SHELL),
    );
    let primary = match name {
        "zsh" => Some(zshrc.clone()),
        "bash" if macos && bash_profile.exists() => Some(bash_profile),
        "bash" => Some(bashrc.clone()),
        _ => None,
    };
    let others = [bashrc, zshrc]
        .into_iter()
        .filter(|file| Some(file) != primary.as_ref() && file.exists())
        .collect();
    let unsupported = primary.is_none().then(|| name.to_owned());

    ShellRcFiles {
        primary,
        others,
        unsupported,
    }
}

#[must_use]
pub fn env_deny_rule(env_file: &Path, home: &str) -> String {
    let env_file = env_file.to_string_lossy();

    env_file.strip_prefix(&format!("{home}/")).map_or_else(
        || format!("Read(/{env_file})"),
        |inside| format!("Read(~/{inside})"),
    )
}

#[must_use]
pub fn node_version_ok(version: &str) -> bool {
    let mut parts = version.split('.').map(js_number);
    let major = parts.next().unwrap_or(f64::NAN);
    let minor = parts.next().unwrap_or(f64::NAN);

    major > MINIMUM_NODE_MAJOR || (major == MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR)
}

pub fn read_settings(
    settings_file: &Path,
    messages: &Messages,
) -> Result<Map<String, Value>, String> {
    let Some(text) = read_text(settings_file) else {
        return Ok(Map::new());
    };

    match parse_json(&text) {
        Some(Value::Object(settings)) => Ok(settings),
        _ => Err((messages.settings_invalid)(
            &settings_file.to_string_lossy(),
        )),
    }
}

#[must_use]
pub fn has_command(name: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {name}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[must_use]
pub fn claude_output(args: &[&str]) -> String {
    Command::new("claude")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
}

#[must_use]
pub fn node_version() -> Option<String> {
    node_version_from(Command::new("node"))
}

#[must_use]
pub fn node_version_from(mut command: Command) -> Option<String> {
    let output = command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim();

    Some(version.strip_prefix('v').unwrap_or(version).to_owned())
}

#[must_use]
pub fn git_version_from(mut command: Command) -> Option<String> {
    let output = command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&output.stdout);

    text.split_whitespace().nth(2).map(str::to_owned)
}

#[must_use]
pub fn whisper_python_works(python: &Path) -> bool {
    Command::new(python)
        .args(["-c", WHISPER_CHECK])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAUNCHER_OF_A: &str = if cfg!(windows) {
        "\\a\\bin\\bcct.cmd"
    } else {
        "/a/bin/bcct"
    };

    fn launcher_command(arguments: &str) -> String {
        format!("\"{LAUNCHER_OF_A}\" {arguments}")
    }

    fn path_of(folders: &[&str]) -> Option<OsString> {
        std::env::join_paths(folders).ok()
    }

    #[test]
    fn the_statusline_commands_quote_the_launcher_of_the_app_folder() {
        let app_dir = Path::new("/a/x/..");

        assert_eq!(statusline_command(app_dir), launcher_command("statusline"));
        assert_eq!(
            statusline_after_command(app_dir),
            launcher_command("statusline --after-previous")
        );
    }

    fn kind_of(command: &str) -> StatuslineKind {
        statusline_kind(
            Some(&serde_json::json!({"type": "command", "command": command})),
            Path::new("/a"),
        )
    }

    #[test]
    fn the_statusline_of_the_clone_still_counts_as_ours() {
        assert_eq!(
            kind_of("node \"/r/plugins/telegram-hooks/statusline.mjs\""),
            StatuslineKind::Ours
        );
        assert_eq!(
            kind_of("node \"C:\\r\\plugins\\telegram-hooks\\statusline.mjs\""),
            StatuslineKind::Ours
        );
        assert_eq!(
            kind_of("node \"/r/plugins/telegram-hooks/statusline.mjs\" --after-previous"),
            StatuslineKind::OursAfter
        );
        assert_eq!(
            kind_of(&launcher_command("statusline")),
            StatuslineKind::Ours
        );
        assert_eq!(
            kind_of(&launcher_command("statusline --after-previous")),
            StatuslineKind::OursAfter
        );
    }

    #[test]
    fn only_the_exact_statusline_of_the_clone_counts_as_ours() {
        for command in [
            "node \"/r/plugins/other/statusline.mjs\"",
            "node \"/r/plugins/telegram-hooks/statusline.mjs\" --other",
            "node \"/r/plugins/telegram-hooks/statusline.mjs",
            "node /r/plugins/telegram-hooks/statusline.mjs",
            "bun \"/r/plugins/telegram-hooks/statusline.mjs\"",
            "node \"plugins/telegram-hooks/statusline.mjs\"",
            "\"/b/bin/bcct\" statusline",
            "",
        ] {
            assert_eq!(kind_of(command), StatuslineKind::Other, "{command}");
        }
    }

    #[test]
    fn the_current_statusline_is_only_the_one_of_this_app_folder() {
        let app_dir = Path::new("/a");
        let current = |command: &str| {
            statusline_is_current(
                Some(&serde_json::json!({"type": "command", "command": command})),
                app_dir,
            )
        };

        assert!(current(&launcher_command("statusline")));
        assert!(current(&launcher_command("statusline --after-previous")));
        assert!(!current(
            "node \"/r/plugins/telegram-hooks/statusline.mjs\""
        ));
        assert!(!current("mine.sh"));
        assert!(!statusline_is_current(None, app_dir));
    }

    #[test]
    fn the_shell_file_lives_in_the_app_folder() {
        assert_eq!(shell_file(Path::new("/a")), PathBuf::from("/a/shell.sh"));
    }

    const SHELL_FUNCTION: &str = concat!(
        "claude() {\n",
        "  local arg\n",
        "  for arg in \"$@\"; do\n",
        "    if [ \"$arg\" = \"--telegram\" ]; then\n",
        "      '/a/it'\\''s/bin/bcct' launch \"$@\"\n",
        "      return\n",
        "    fi\n",
        "  done\n",
        "  command claude \"$@\"\n",
        "}\n",
    );

    fn with_host_separators(expected: &str) -> String {
        expected.replace('/', std::path::MAIN_SEPARATOR_STR)
    }

    #[test]
    fn the_shell_script_sends_only_the_telegram_launch_to_the_launcher() {
        assert_eq!(
            shell_script(Path::new("/a/it's"), false),
            with_host_separators(SHELL_FUNCTION)
        );
    }

    #[test]
    fn the_shell_script_adds_the_launcher_folder_to_the_path_once_when_asked() {
        assert_eq!(
            shell_script(Path::new("/a/it's"), true),
            with_host_separators(&format!(
                "{SHELL_FUNCTION}{}",
                concat!(
                    "case \":${PATH}:\" in\n",
                    "  *:'/a/it'\\''s/bin':*) ;;\n",
                    "  *) export PATH='/a/it'\\''s/bin':\"$PATH\" ;;\n",
                    "esac\n",
                )
            ))
        );
    }

    #[test]
    fn the_command_is_on_the_path_only_when_the_config_says_so() {
        let folder = tempfile::tempdir().unwrap();
        let config = folder.path().join(crate::paths::CONFIG_FILE);

        assert!(!command_on_path(folder.path()));

        for (text, expected) in [
            (r#"{"commandOnPath":true}"#, true),
            (r#"{"commandOnPath":false}"#, false),
            (r#"{"commandOnPath":"yes"}"#, false),
            ("{}", false),
        ] {
            fs::write(&config, text).unwrap();
            assert_eq!(command_on_path(folder.path()), expected, "{text}");
        }
    }

    #[test]
    fn the_launcher_folder_is_on_the_path_only_when_listed_exactly() {
        let bin = Path::new("/a/bin");

        assert!(path_lists(path_of(&["/x", "/a/bin", "/y"]), bin));
        assert!(path_lists(Some(OsString::from("/a/bin")), bin));
        assert!(!path_lists(path_of(&["/a/bin2", "/a"]), bin));
        assert!(!path_lists(Some(OsString::new()), bin));
        assert!(!path_lists(None, bin));
    }

    #[test]
    fn a_missing_request_file_counts_as_already_removed() {
        let folder = tempfile::tempdir().unwrap();

        remove_if_present(&folder.path().join("missing")).unwrap();
        assert!(remove_if_present(folder.path()).is_err());
    }

    #[test]
    fn the_token_comes_from_the_first_line_that_carries_one() {
        assert_eq!(
            parse_env_token("A=1\nTELEGRAM_BOT_TOKEN= x \n"),
            Some("x".to_owned())
        );
        assert_eq!(
            parse_env_token("TELEGRAM_BOT_TOKEN= \nTELEGRAM_BOT_TOKEN=y"),
            Some(String::new())
        );
        assert_eq!(
            parse_env_token("TELEGRAM_BOT_TOKEN=\nTELEGRAM_BOT_TOKEN=y"),
            Some("y".to_owned())
        );
        assert_eq!(parse_env_token(""), None);
    }

    fn rc_files(home: &Path, shell: &str, macos: bool) -> ShellRcFiles {
        shell_rc_files(&home.to_string_lossy(), Some(shell), macos)
    }

    #[test]
    fn the_rc_files_list_only_the_others_that_exist() {
        let home = tempfile::tempdir().unwrap();
        let bashrc = home.path().join(".bashrc");
        let zshrc = home.path().join(".zshrc");

        assert_eq!(
            rc_files(home.path(), "/bin/bash", false),
            ShellRcFiles {
                primary: Some(bashrc.clone()),
                others: Vec::new(),
                unsupported: None,
            }
        );

        fs::write(&bashrc, "").unwrap();
        fs::write(&zshrc, "").unwrap();

        assert_eq!(
            rc_files(home.path(), "bash", false).others,
            vec![zshrc.clone()]
        );
        assert_eq!(
            rc_files(home.path(), "zsh", false).others,
            vec![bashrc.clone()]
        );
        assert_eq!(
            rc_files(home.path(), "fish", false),
            ShellRcFiles {
                primary: None,
                others: vec![bashrc, zshrc],
                unsupported: Some("fish".to_owned()),
            }
        );
    }

    #[test]
    fn bash_on_macos_prefers_an_existing_bash_profile() {
        let home = tempfile::tempdir().unwrap();
        let profile = home.path().join(".bash_profile");
        let bashrc = home.path().join(".bashrc");

        assert_eq!(
            rc_files(home.path(), "bash", true).primary,
            Some(bashrc.clone())
        );

        fs::write(&profile, "").unwrap();

        assert_eq!(rc_files(home.path(), "bash", true).primary, Some(profile));
        assert_eq!(rc_files(home.path(), "bash", false).primary, Some(bashrc));
        assert_eq!(
            shell_rc_files("/h", None, false).primary,
            Some(PathBuf::from("/h/.bashrc"))
        );
    }

    #[test]
    fn a_missing_python_does_not_work_and_an_empty_version_is_too_old() {
        let folder = tempfile::tempdir().unwrap();

        assert!(!whisper_python_works(&folder.path().join("missing")));
        assert!(node_version_ok("24.11.0"));
        assert!(!node_version_ok(""));
    }
}
