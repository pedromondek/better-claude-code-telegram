use std::ffi::OsString;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::browser::{Platform, playwright_chromium, read_dir_names};
use crate::config::{VisualMode, read_visuals};
use crate::files::read_json;
use crate::health_fix::{FixRequest, FixRun, parse_only, run_fix};
use crate::hook::Abort;
use crate::hook::{millis, now_ms};
use crate::hook_failures::{Reason, open_notices};
use crate::install::System;
use crate::js::{
    join_path, js_key_count, js_length, js_template, js_trim, js_truthy, stringify_pretty,
};
use crate::messages::{Messages, messages_for};
use crate::paths::{CONFIG_FILE, HEALTH_FILE, LAUNCH_FILE, TELEGRAM_FLAG};
use crate::prompt::{Prompter, create_prompter};
use crate::self_install::Store;
use crate::setup::{
    ACCESS_FILE, CHANNEL_PLUGIN_ID, ENV_FILE, HOOKS_PLUGIN_ID, MINIMUM_NODE, SETUP_COMMAND,
    SetupPaths, StatuslineState, claude_output, command_on_path, env_deny_rule, git_version_from,
    has_command, launcher_dir, node_version, node_version_ok, parse_env_token, path_lists,
    read_settings, read_text, setup_locale, shell_file, shell_rc_files, shell_script,
    statusline_state, whisper_python_works,
};
use crate::shell_rc::{rc_line_active, rc_loads};
use crate::spinner::{Spinner, Terminal, pending, spin_on_stdout};
use crate::statusline::{TELEGRAM_HEALTH_TTL_MS, TELEGRAM_LAUNCH_GRACE_MS, time_of};
use crate::telegram::{api_root, call, post_json, property};
use crate::ui::{fail, section, should_colorize, skipped, success};
use crate::update::{parse_plugins, run_quietly};

const JSON_FLAG: &str = "--json";
const FIX_FLAG: &str = "--fix";
const YES_FLAG: &str = "--yes";
const ONLY_FLAG: &str = "--only";
const ONLY_PREFIX: &str = "--only=";
const ALL_ANSWERS: [&str; 2] = ["all", "tudo"];
const FAILURE: u8 = 1;
const WHISPER_PYTHON: &str = "whisper/venv/bin/python";

pub struct Machine<'a> {
    pub var: &'a dyn Fn(&str) -> Option<OsString>,
    pub home: &'a Path,
    pub uid: Option<u32>,
    pub now: u64,
    pub node_version: &'a dyn Fn() -> Option<String>,
    pub git_version: &'a dyn Fn() -> Option<String>,
    pub has_command: &'a dyn Fn(&str) -> bool,
    pub claude_output: &'a dyn Fn(&[&str]) -> String,
    pub python_works: &'a dyn Fn(&Path) -> bool,
    pub fetch: &'a dyn Fn(&str, &str) -> Option<Vec<u8>>,
    pub update: &'a dyn Fn(&str) -> Result<(), String>,
}

impl std::fmt::Debug for Machine<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Machine")
            .field("home", &self.home)
            .field("uid", &self.uid)
            .field("now", &self.now)
            .finish_non_exhaustive()
    }
}

pub struct Screen<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub terminal: Option<Terminal>,
    pub colorize_out: bool,
    pub colorize_err: bool,
    pub spin: &'a dyn Fn(Vec<String>, String) -> Option<Spinner>,
}

impl std::fmt::Debug for Screen<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Screen")
            .field("terminal", &self.terminal)
            .field("colorize_out", &self.colorize_out)
            .field("colorize_err", &self.colorize_err)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    Install,
    Telegram,
    Security,
    Extras,
}

pub const HEALTH_GROUPS: [Group; 4] = [
    Group::Install,
    Group::Telegram,
    Group::Security,
    Group::Extras,
];

impl Group {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Telegram => "telegram",
            Self::Security => "security",
            Self::Extras => "extras",
        }
    }

    fn title(self, messages: &Messages) -> &'static str {
        let titles = messages.health_group_titles;

        match self {
            Self::Install => titles.install,
            Self::Telegram => titles.telegram,
            Self::Security => titles.security,
            Self::Extras => titles.extras,
        }
    }

    fn checks(self) -> &'static [Check] {
        match self {
            Self::Install => &[
                Check::Node,
                Check::Claude,
                Check::Bun,
                Check::Git,
                Check::Plugins,
                Check::Launcher,
                Check::Version,
                Check::Shell,
                Check::Path,
                Check::AppDir,
                Check::Hooks,
            ],
            Self::Telegram => &[Check::Token, Check::Groups, Check::Pairing, Check::Polling],
            Self::Security => &[Check::User, Check::Protection, Check::Config],
            Self::Extras => &[
                Check::Transcription,
                Check::Mermaid,
                Check::Chromium,
                Check::Ffmpeg,
                Check::Statusline,
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Node,
    Claude,
    Bun,
    Git,
    Plugins,
    Launcher,
    Version,
    Shell,
    Path,
    AppDir,
    Hooks,
    Token,
    Groups,
    Pairing,
    Polling,
    User,
    Protection,
    Config,
    Transcription,
    Mermaid,
    Chromium,
    Ffmpeg,
    Statusline,
}

impl Check {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Claude => "claude",
            Self::Bun => "bun",
            Self::Git => "git",
            Self::Plugins => "plugins",
            Self::Launcher => "launcher",
            Self::Version => "version",
            Self::Shell => "shell",
            Self::Path => "path",
            Self::AppDir => "app",
            Self::Hooks => "hooks",
            Self::Token => "token",
            Self::Groups => "groups",
            Self::Pairing => "pairing",
            Self::Polling => "polling",
            Self::User => "user",
            Self::Protection => "protection",
            Self::Config => "config",
            Self::Transcription => "transcription",
            Self::Mermaid => "mermaid",
            Self::Chromium => "chromium",
            Self::Ffmpeg => "ffmpeg",
            Self::Statusline => "statusline",
        }
    }

    #[must_use]
    pub fn label(self, messages: &Messages) -> &'static str {
        let labels = messages.health_labels;

        match self {
            Self::Node => labels.node,
            Self::Claude => labels.claude,
            Self::Bun => labels.bun,
            Self::Git => labels.git,
            Self::Plugins => labels.plugins,
            Self::Launcher => labels.launcher,
            Self::Version => labels.version,
            Self::Shell => labels.shell,
            Self::Path => labels.path,
            Self::AppDir => labels.app_dir,
            Self::Hooks => labels.hooks,
            Self::Token => labels.token,
            Self::Groups => labels.groups,
            Self::Pairing => labels.pairing,
            Self::Polling => labels.polling,
            Self::User => labels.user,
            Self::Protection => labels.protection,
            Self::Config => labels.config,
            Self::Transcription => labels.transcription,
            Self::Mermaid => labels.mermaid,
            Self::Chromium => labels.chromium,
            Self::Ffmpeg => labels.ffmpeg,
            Self::Statusline => labels.statusline,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Fail,
    Off,
}

impl Status {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Fail => "fail",
            Self::Off => "off",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub group: Group,
    pub check: Check,
    pub status: Status,
    pub detail: String,
}

type Verdict = (Status, String);

fn ok(detail: &str) -> Verdict {
    (Status::Ok, detail.to_owned())
}

fn failed(detail: &str) -> Verdict {
    (Status::Fail, detail.to_owned())
}

fn off(detail: &str) -> Verdict {
    (Status::Off, detail.to_owned())
}

#[must_use]
pub fn installed_versions(machine: &Machine<'_>, app_dir: &Path) -> Option<(String, String)> {
    let binary = Store::new(app_dir).active()?.version;

    if !(machine.has_command)("claude") {
        return None;
    }

    let plugins = parse_plugins(&(machine.claude_output)(&["plugin", "list", "--json"]))?;

    Some((binary, plugins.hooks_version))
}

pub fn parse_health_groups(args: &[String], messages: &Messages) -> Result<Vec<Group>, String> {
    let requested: Vec<String> = args
        .iter()
        .map(|arg| js_trim(arg).to_lowercase())
        .filter(|arg| !arg.is_empty())
        .collect();

    if requested.is_empty()
        || requested
            .iter()
            .any(|arg| ALL_ANSWERS.contains(&arg.as_str()))
    {
        return Ok(HEALTH_GROUPS.to_vec());
    }

    let unknown: Vec<&str> = requested
        .iter()
        .map(String::as_str)
        .filter(|arg| !HEALTH_GROUPS.iter().any(|group| group.as_str() == *arg))
        .collect();

    if !unknown.is_empty() {
        let valid: Vec<&str> = HEALTH_GROUPS.iter().map(|group| group.as_str()).collect();

        return Err((messages.unknown_health_groups)(
            &unknown.join(", "),
            &valid.join(", "),
        ));
    }

    Ok(HEALTH_GROUPS
        .into_iter()
        .filter(|group| requested.iter().any(|arg| arg == group.as_str()))
        .collect())
}

fn undefined_or(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js_template)
}

fn first_item(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Array(items) => items.first().cloned(),
        Value::String(text) => text.chars().next().map(|first| Value::String(first.into())),
        _ => None,
    }
}

fn readable(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn write_blocked(
    messages: &Messages,
    folder: &str,
    reason: Reason,
    (owner, uid): (Option<u32>, Option<u32>),
    user: Option<String>,
) -> Verdict {
    let detail = messages.health_detail;

    if reason != Reason::NoPermission {
        return failed(&(detail.app_blocked)(folder, reason.text(messages)));
    }

    match (owner, uid) {
        (Some(owner), Some(uid)) if owner != uid => failed(&(detail.app_other_owner)(
            folder,
            &user.unwrap_or_else(|| "$USER".to_owned()),
        )),
        _ => failed(&(detail.app_no_permission)(folder)),
    }
}

pub(crate) fn first_blocked(app: &Path) -> Option<(PathBuf, io::ErrorKind)> {
    [app.to_path_buf(), app.join("asks"), app.join("pings")]
        .into_iter()
        .filter(|folder| folder.is_dir())
        .find_map(|folder| {
            tempfile::Builder::new()
                .prefix(".bcct-probe-")
                .tempfile_in(&folder)
                .err()
                .map(|error| (folder, error.kind()))
        })
}

pub(crate) fn owner_of(path: &Path) -> Option<u32> {
    let metadata = std::fs::metadata(path).ok()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        Some(metadata.uid())
    }

    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

enum Bot {
    Missing,
    Found(Option<Value>),
    Failed(String),
}

struct Checks<'a> {
    machine: &'a Machine<'a>,
    messages: &'static Messages,
    paths: SetupPaths,
    token: Option<String>,
    bot: Option<Bot>,
}

impl Checks<'_> {
    fn text_var(&self, name: &str) -> Option<String> {
        (self.machine.var)(name).map(|value| value.to_string_lossy().into_owned())
    }

    fn enter(&mut self, group: Group) {
        if group == Group::Telegram {
            self.token = parse_env_token(
                &read_text(&join_path(&self.paths.state_dir, ENV_FILE)).unwrap_or_default(),
            )
            .filter(|token| !token.is_empty());
        }
    }

    fn run(&mut self, check: Check) -> Verdict {
        match check {
            Check::Shell => self.shell(),
            Check::Path => self.path(),
            Check::Launcher => self.launcher(),
            Check::Version => self.version(),
            Check::AppDir => self.app_dir(),
            Check::Hooks => self.hooks(),
            Check::Token => self.token_check(),
            Check::Groups => self.groups(),
            Check::Protection => self.protection(),
            Check::Node => self.node(),
            Check::Claude => self.tool("claude"),
            Check::Bun => self.tool("bun"),
            Check::Git => (self.machine.git_version)().map_or_else(
                || failed(self.messages.health_detail.git_missing),
                |version| ok(&version),
            ),
            Check::Plugins => self.plugins(),
            Check::Pairing => self.pairing(),
            Check::Polling => self.polling(),
            Check::User => self.user(),
            Check::Config => self.config(),
            Check::Transcription => self.transcription(),
            Check::Mermaid => self.mermaid(),
            Check::Chromium => self.chromium(),
            Check::Ffmpeg => self.ffmpeg(),
            Check::Statusline => self.statusline(),
        }
    }

    fn node(&self) -> Verdict {
        let detail = self.messages.health_detail;

        match (self.machine.node_version)() {
            Some(version) if node_version_ok(&version) => ok(&(detail.version)(&version)),
            Some(version) => failed(&(self.messages.node_too_old)(&version, MINIMUM_NODE)),
            None => failed(detail.missing),
        }
    }

    fn tool(&self, name: &str) -> Verdict {
        let detail = self.messages.health_detail;

        if (self.machine.has_command)(name) {
            ok(detail.found)
        } else {
            failed(detail.missing)
        }
    }

    fn plugins(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let list = if (self.machine.has_command)("claude") {
            (self.machine.claude_output)(&["plugin", "list"])
        } else {
            String::new()
        };
        let missing: Vec<&str> = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID]
            .into_iter()
            .filter(|plugin| !list.contains(plugin))
            .collect();

        if missing.is_empty() {
            ok(detail.installed)
        } else {
            failed(&(detail.not_installed)(&missing.join(", ")))
        }
    }

    fn launcher(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let store = Store::new(&self.paths.app_dir);

        if !store.has_launcher() {
            return failed(&(detail.launcher_missing)(&readable(&launcher_dir(
                &self.paths.app_dir,
            ))));
        }

        match store.active() {
            Some(active) => ok(&(detail.launcher_active)(&active.version, &active.channel)),
            None => failed(detail.launcher_no_version),
        }
    }

    fn version(&self) -> Verdict {
        let detail = self.messages.health_detail;

        match installed_versions(self.machine, &self.paths.app_dir) {
            Some((binary, plugin)) if binary == plugin => ok(&(detail.version_same)(&binary)),
            Some((binary, plugin)) => failed(&(detail.version_differs)(&plugin, &binary)),
            None => off(detail.version_unknown),
        }
    }

    fn app_dir(&self) -> Verdict {
        match first_blocked(&self.paths.app_dir) {
            Some((folder, kind)) => self.blocked(&folder, kind),
            None => ok(self.messages.health_detail.app_writable),
        }
    }

    fn blocked(&self, folder: &Path, kind: io::ErrorKind) -> Verdict {
        let reason = Reason::of(&Abort::Io {
            kind,
            path: folder.to_path_buf(),
        });

        write_blocked(
            self.messages,
            &readable(folder),
            reason,
            (owner_of(folder), self.machine.uid),
            self.text_var("USER"),
        )
    }

    fn hooks(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let shown: Vec<String> = open_notices(&self.paths.app_dir)
            .iter()
            .map(|notice| {
                let reason = notice.reason.text(self.messages);
                let event = notice.event.event_name();

                match &notice.file {
                    Some(file) => (detail.hook_write_failed)(event, file, reason),
                    None => (detail.hook_failed_often)(
                        event,
                        u64::try_from(notice.count).unwrap_or(u64::MAX),
                        reason,
                    ),
                }
            })
            .collect();

        if shown.is_empty() {
            ok(detail.no_hook_failures)
        } else {
            failed(&shown.join("; "))
        }
    }

    fn path(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let bin = launcher_dir(&self.paths.app_dir);

        if path_lists((self.machine.var)("PATH"), &bin) {
            return ok(&(detail.path_on)(&readable(&bin)));
        }

        if command_on_path(&self.paths.app_dir) {
            return off(&(detail.path_pending)(&readable(&shell_file(
                &self.paths.app_dir,
            ))));
        }

        off(detail.path_off)
    }

    fn shell(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let Some(home) = self.text_var("HOME") else {
            return failed(detail.no_home);
        };
        let shell = self.text_var("SHELL");
        let files = shell_rc_files(&home, shell.as_deref(), cfg!(target_os = "macos"));
        let script = shell_file(&self.paths.app_dir);
        let script_text = script.to_string_lossy();
        let candidates: Vec<(&PathBuf, String)> = files
            .primary
            .iter()
            .chain(&files.others)
            .map(|rc| (rc, read_text(rc).unwrap_or_default()))
            .collect();
        let active = candidates
            .iter()
            .find(|(_, text)| rc_line_active(text, &script_text));

        if let Some((rc, _)) = active {
            let expected = shell_script(&self.paths.app_dir, command_on_path(&self.paths.app_dir));

            return match read_text(&script) {
                None => failed(&(detail.shell_script_missing)(
                    &readable(rc),
                    &readable(&script),
                )),
                Some(current) if current != expected => {
                    failed(&(detail.shell_script_outdated)(&readable(&script)))
                }
                Some(_) => ok(&(detail.loaded_in)(&readable(rc))),
            };
        }

        if let Some((rc, _)) = candidates
            .iter()
            .find(|(_, text)| rc_loads(text, &script_text))
        {
            return failed(&(detail.shell_commented)(&readable(rc)));
        }

        match files.unsupported.filter(|name| !name.is_empty()) {
            Some(name) => off(&(self.messages.shell_unsupported)(
                &name,
                &readable(&script),
            )),
            None => failed(&(detail.not_loaded)(
                &files
                    .primary
                    .as_deref()
                    .map_or_else(|| "null".to_owned(), readable),
            )),
        }
    }

    fn bot(&mut self) -> &Bot {
        let machine = self.machine;
        let messages = self.messages;
        let token = self.token.clone();

        self.bot.get_or_insert_with(|| {
            token.map_or(Bot::Missing, |token| {
                match call(
                    machine.fetch,
                    &api_root(machine.var),
                    &token,
                    "getMe",
                    &json!({}),
                    messages,
                ) {
                    Ok(found) => Bot::Found(found),
                    Err(error) => Bot::Failed(error),
                }
            })
        })
    }

    fn token_check(&mut self) -> Verdict {
        let detail = self.messages.health_detail;

        match self.bot() {
            Bot::Missing => failed(detail.no_token),
            Bot::Failed(error) => failed(error),
            Bot::Found(found) => match property(found.as_ref(), "username") {
                Ok(username) => ok(&(detail.bot)(&undefined_or(username))),
                Err(_) => failed(detail.bot_answer_unexpected),
            },
        }
    }

    fn groups(&mut self) -> Verdict {
        let messages = self.messages;
        let detail = messages.health_detail;

        let Bot::Found(found) = self.bot() else {
            return off(detail.groups_unknown);
        };

        match property(found.as_ref(), "can_join_groups") {
            Err(_) => off(detail.groups_unknown),
            Ok(joins) if joins.is_some_and(js_truthy) => failed(&(messages.groups_warning)(
                &undefined_or(property(found.as_ref(), "username").unwrap_or_default()),
            )),
            Ok(_) => ok(detail.groups_off),
        }
    }

    fn describe_account(&self, token: &str, user_id: &Value) -> String {
        let chat = call(
            self.machine.fetch,
            &api_root(self.machine.var),
            token,
            "getChat",
            &json!({ "chat_id": user_id }),
            self.messages,
        )
        .ok()
        .flatten();
        let field = |key: &str| {
            chat.as_ref()
                .and_then(|chat| chat.get(key))
                .filter(|value| js_truthy(value))
        };
        let name = field("username")
            .map(|username| format!("@{}", js_template(username)))
            .or_else(|| field("first_name").map(js_template));

        name.map_or_else(
            || format!("id {}", js_template(user_id)),
            |name| format!("{name} (id {})", js_template(user_id)),
        )
    }

    fn pairing(&self) -> Verdict {
        let messages = self.messages;
        let detail = messages.health_detail;
        let access = read_json(&join_path(&self.paths.state_dir, ACCESS_FILE))
            .filter(|access| !access.is_null())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let allowed = access.get("allowFrom").filter(|allowed| !allowed.is_null());
        let account = match (&self.token, allowed) {
            (Some(token), Some(Value::Array(users))) if users.len() == 1 => {
                self.describe_account(token, users.first().unwrap_or(&Value::Null))
            }
            _ => format!("id {}", undefined_or(first_item(allowed).as_ref())),
        };
        let accounts = allowed.and_then(js_length).unwrap_or_default();
        let waiting = js_key_count(access.get("pending"));
        let groups = js_key_count(access.get("groups"));
        let policy = access.get("dmPolicy").filter(|policy| !policy.is_null());

        if accounts == 0 {
            return failed(detail.not_paired);
        }

        if accounts > 1 {
            return failed(&(messages.too_many_accounts)(
                u64::try_from(accounts).unwrap_or(u64::MAX),
                &format!("{SETUP_COMMAND} pairing"),
            ));
        }

        if policy.and_then(Value::as_str) != Some("allowlist") {
            return failed(&(detail.not_allowlist)(
                &policy.map_or_else(|| "pairing".to_owned(), js_template),
            ));
        }

        if waiting > 0 {
            return failed(&(detail.pending_pairings)(
                u64::try_from(waiting).unwrap_or(u64::MAX),
            ));
        }

        if groups > 0 {
            return failed(&(detail.groups_allowed)(
                u64::try_from(groups).unwrap_or(u64::MAX),
            ));
        }

        ok(&(detail.paired)(&account))
    }

    fn polling(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let now = millis(self.machine.now);
        let health = read_json(&join_path(&self.paths.app_dir, HEALTH_FILE));
        let fresh = now - time_of(health.as_ref(), "checkedAt") < TELEGRAM_HEALTH_TTL_MS;
        let launch = read_json(&join_path(&self.paths.app_dir, LAUNCH_FILE));
        let launching = now - time_of(launch.as_ref(), "launchedAt") < TELEGRAM_LAUNCH_GRACE_MS;
        let polling = health
            .as_ref()
            .and_then(|health| health.get("polling"))
            .is_some_and(js_truthy);

        if fresh && polling {
            ok(detail.connected)
        } else if launching {
            off(detail.connecting)
        } else if fresh {
            failed(detail.down)
        } else if self.text_var(TELEGRAM_FLAG).as_deref() == Some("1") {
            failed(detail.down_here)
        } else {
            off(detail.not_open)
        }
    }

    fn user(&self) -> Verdict {
        let detail = self.messages.health_detail;

        if self.machine.uid == Some(0) {
            failed(detail.root)
        } else {
            ok(detail.regular_user)
        }
    }

    fn protection(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let home = self
            .text_var("HOME")
            .unwrap_or_else(|| readable(self.machine.home));
        let rule = env_deny_rule(&join_path(&self.paths.state_dir, ENV_FILE), &home);
        let settings = read_json(&self.paths.settings_file);
        let deny = settings
            .as_ref()
            .and_then(|settings| settings.get("permissions"))
            .and_then(|permissions| permissions.get("deny"))
            .filter(|deny| !deny.is_null());
        let protected = match deny {
            None => false,
            Some(Value::Array(rules)) => rules.iter().any(|item| item.as_str() == Some(&rule)),
            Some(Value::String(rules)) => rules.contains(&rule),
            Some(_) => {
                return failed(&(detail.deny_not_a_list)(&readable(
                    &self.paths.settings_file,
                )));
            }
        };

        if protected {
            ok(detail.protected)
        } else {
            failed(&(detail.unprotected)(&format!("{SETUP_COMMAND} token")))
        }
    }

    fn config(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let config_file = join_path(&self.paths.app_dir, CONFIG_FILE);

        if let Err(error) = read_settings(&self.paths.settings_file, self.messages) {
            return failed(&error);
        }

        if read_text(&config_file).is_some()
            && read_json(&config_file).is_none_or(|config| config.is_null())
        {
            failed(&(detail.invalid)(&readable(&config_file)))
        } else {
            ok(detail.valid)
        }
    }

    fn transcription(&self) -> Verdict {
        let detail = self.messages.health_detail;
        let config = crate::config::read_config(&self.paths.app_dir);
        let Some(model) = config
            .get("transcription")
            .and_then(|transcription| transcription.get("model"))
            .filter(|model| js_truthy(model))
        else {
            return off(detail.off);
        };
        let python: PathBuf = join_path(&self.paths.app_dir, WHISPER_PYTHON);

        if (self.machine.python_works)(&python) {
            ok(&(detail.model)(&js_template(model)))
        } else {
            failed(&(detail.broken)(&format!("{SETUP_COMMAND} transcription")))
        }
    }

    fn mermaid(&self) -> Verdict {
        let detail = self.messages.health_detail;

        if (self.machine.has_command)("mmdc") {
            ok(detail.found)
        } else {
            off(detail.missing)
        }
    }

    fn visual_mode(&self) -> VisualMode {
        read_visuals(&crate::config::read_config(&self.paths.app_dir)).mode
    }

    fn chromium(&self) -> Verdict {
        let detail = self.messages.health_detail;

        if self.visual_mode() == VisualMode::Off {
            return off(detail.off);
        }

        let found = playwright_chromium(
            Platform::current(),
            self.machine.home,
            self.machine.var,
            &read_dir_names,
        );

        if found.is_some() {
            ok(detail.found)
        } else {
            failed(detail.chromium_missing)
        }
    }

    fn ffmpeg(&self) -> Verdict {
        let detail = self.messages.health_detail;

        if self.visual_mode() != VisualMode::Video {
            return off(detail.off);
        }

        if (self.machine.has_command)("ffmpeg") {
            ok(detail.found)
        } else {
            failed(detail.ffmpeg_missing)
        }
    }

    fn statusline(&self) -> Verdict {
        let shown = self.messages.health_detail.statusline;
        let (status, detail) = match statusline_state(&self.paths) {
            StatuslineState::Ours => (Status::Ok, shown.ours),
            StatuslineState::OursAfter => (Status::Ok, shown.ours_after),
            StatuslineState::Custom => (Status::Ok, shown.custom),
            StatuslineState::Other => (Status::Off, shown.other),
            StatuslineState::None => (Status::Off, shown.none),
            StatuslineState::CustomPending => (Status::Off, shown.custom_pending),
        };

        (status, detail.to_owned())
    }
}

#[must_use]
pub fn format_entry(entry: &Entry, messages: &Messages, colorize: bool) -> String {
    let line = format!("{}: {}", entry.check.label(messages), entry.detail);

    match entry.status {
        Status::Ok => success(&line, colorize),
        Status::Fail => fail(&line, colorize),
        Status::Off => skipped(&line, colorize),
    }
}

pub(crate) fn write_all(out: &mut dyn Write, text: &str) -> io::Result<()> {
    out.write_all(text.as_bytes()).and_then(|()| out.flush())
}

fn run_groups(
    groups: &[Group],
    checks: &mut Checks<'_>,
    screen: &mut Screen<'_>,
    show: bool,
) -> Result<Vec<Entry>, String> {
    let messages = checks.messages;
    let mut results = Vec::new();

    let not_shown = |_| messages.health_not_shown.to_owned();

    for group in groups {
        if show {
            write_all(
                screen.out,
                &format!("{}\n", section(group.title(messages), screen.colorize_out)),
            )
            .map_err(not_shown)?;
        }

        checks.enter(*group);

        for check in group.checks() {
            let waiting = show.then(|| {
                pending(
                    &format!("{}…", check.label(messages)),
                    screen.out,
                    screen.terminal,
                    screen.colorize_out,
                    screen.spin,
                )
            });

            let (status, detail) = checks.run(*check);
            let entry = Entry {
                group: *group,
                check: *check,
                status,
                detail,
            };

            if let Some(waiting) = waiting {
                waiting
                    .finish(
                        Some(&format_entry(&entry, messages, screen.colorize_out)),
                        screen.out,
                    )
                    .map_err(not_shown)?;
            }

            results.push(entry);
        }
    }

    Ok(results)
}

pub(crate) fn entries_json(results: &[Entry]) -> Value {
    Value::Array(
        results
            .iter()
            .map(|entry| {
                json!({
                    "group": entry.group.as_str(),
                    "check": entry.check.as_str(),
                    "status": entry.status.as_str(),
                    "detail": entry.detail,
                })
            })
            .collect(),
    )
}

fn as_json(results: &[Entry]) -> String {
    format!("{}\n", stringify_pretty(&entries_json(results)))
}

pub(crate) fn status_of(results: &[Entry]) -> u8 {
    if results.iter().any(|entry| entry.status == Status::Fail) {
        FAILURE
    } else {
        0
    }
}

pub(crate) fn collect(
    groups: &[Group],
    machine: &Machine<'_>,
    messages: &'static Messages,
    paths: &SetupPaths,
    screen: &mut Screen<'_>,
    show: bool,
) -> Result<Vec<Entry>, String> {
    let mut checks = Checks {
        machine,
        messages,
        paths: paths.clone(),
        token: None,
        bot: None,
    };

    run_groups(groups, &mut checks, screen, show)
}

#[derive(Debug, Default)]
struct Options {
    json: bool,
    fix: bool,
    yes: bool,
    only: Vec<String>,
    groups: Vec<String>,
}

fn options_of(args: &[String]) -> Options {
    let mut options = Options::default();
    let mut args = args.iter();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            JSON_FLAG => options.json = true,
            FIX_FLAG => options.fix = true,
            YES_FLAG => options.yes = true,
            ONLY_FLAG => options
                .only
                .extend(args.next().map(|ids| split_ids(ids)).unwrap_or_default()),
            other => match other.strip_prefix(ONLY_PREFIX) {
                Some(ids) => options.only.extend(split_ids(ids)),
                None => options.groups.push(other.to_owned()),
            },
        }
    }

    options
}

fn split_ids(ids: &str) -> Vec<String> {
    ids.split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

fn report(screen: &mut Screen<'_>, error: &str) -> u8 {
    let _written = write_all(
        screen.err,
        &format!("{}\n", fail(error, screen.colorize_err)),
    );
    FAILURE
}

pub fn check_all(
    machine: &Machine<'_>,
    screen: &mut Screen<'_>,
    messages: &'static Messages,
) -> Result<bool, String> {
    let mut checks = Checks {
        machine,
        messages,
        paths: SetupPaths::resolve(machine.var, machine.home),
        token: None,
        bot: None,
    };
    let results = run_groups(&HEALTH_GROUPS, &mut checks, screen, true)?;

    Ok(results.iter().any(|entry| entry.status == Status::Fail))
}

pub fn run(args: &[String], machine: &Machine<'_>, screen: &mut Screen<'_>) -> u8 {
    run_with(args, machine, screen, None)
}

pub fn run_with(
    args: &[String],
    machine: &Machine<'_>,
    screen: &mut Screen<'_>,
    ask: Option<&mut dyn Prompter>,
) -> u8 {
    let paths = SetupPaths::resolve(machine.var, machine.home);
    let messages = messages_for(setup_locale(&paths.app_dir, machine.var));
    let options = options_of(args);
    let groups = match parse_health_groups(&options.groups, messages) {
        Ok(groups) => groups,
        Err(error) => return report(screen, &error),
    };
    let only = match parse_only(&options.only, messages) {
        Ok(only) => only,
        Err(error) => return report(screen, &error),
    };
    let results = match collect(&groups, machine, messages, &paths, screen, !options.json) {
        Ok(results) => results,
        Err(error) => return report(screen, &error),
    };

    if options.fix {
        let run = FixRun {
            groups: &groups,
            machine,
            paths: &paths,
            messages,
            screen,
            json: options.json,
        };
        let request = FixRequest {
            yes: options.yes,
            only,
        };

        return match run_fix(run, results, &request, ask) {
            Ok(status) => status,
            Err(error) => report(screen, &error),
        };
    }

    if options.json && write_all(screen.out, &as_json(&results)).is_err() {
        return report(screen, messages.health_not_shown);
    }

    status_of(&results)
}

pub fn run_process(args: &[OsString], stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    let home = std::env::home_dir().unwrap_or_default();
    let var = |name: &str| std::env::var_os(name);
    #[cfg(unix)]
    let uid = Some(rustix::process::getuid().as_raw());
    #[cfg(not(unix))]
    let uid = None;
    #[cfg(unix)]
    let columns = rustix::termios::tcgetwinsize(io::stdout())
        .ok()
        .map(|size| size.ws_col);
    #[cfg(not(unix))]
    let columns = None;
    let machine = Machine {
        var: &var,
        home: &home,
        uid,
        now: now_ms(),
        node_version: &node_version,
        git_version: &|| git_version_from(System::from_process().command("git")),
        has_command: &has_command,
        claude_output: &claude_output,
        python_works: &whisper_python_works,
        fetch: &post_json,
        update: &run_quietly,
    };
    let on_terminal = io::stdout().is_terminal();
    let mut screen = Screen {
        out: stdout,
        err: stderr,
        terminal: on_terminal.then_some(Terminal { columns }),
        colorize_out: should_colorize(&var, on_terminal),
        colorize_err: should_colorize(&var, io::stderr().is_terminal()),
        spin: &spin_on_stdout,
    };
    let args: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    let mut prompter = create_prompter(&var);
    let status = run_with(&args, &machine, &mut screen, Some(prompter.as_mut()));

    prompter.close();
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{EN_US, PT_BR};

    const FOLDER: &str = "/app/pings";

    #[test]
    fn a_folder_without_write_permission_of_the_same_user_asks_for_chmod() {
        for owners in [
            (Some(7), Some(7)),
            (None, Some(7)),
            (Some(7), None),
            (None, None),
        ] {
            assert_eq!(
                write_blocked(&EN_US, FOLDER, Reason::NoPermission, owners, None),
                failed(
                    "cannot write to /app/pings (no write permission). Run 'chmod u+rwx /app/pings'."
                ),
                "{owners:?}"
            );
        }
    }

    #[test]
    fn a_folder_of_another_user_asks_for_chown_with_the_user_name() {
        assert_eq!(
            write_blocked(
                &EN_US,
                FOLDER,
                Reason::NoPermission,
                (Some(0), Some(1000)),
                Some("ana".to_owned())
            ),
            failed("/app/pings belongs to another user. Run 'sudo chown -R ana /app/pings'.")
        );
        assert_eq!(
            write_blocked(
                &PT_BR,
                FOLDER,
                Reason::NoPermission,
                (Some(0), Some(1000)),
                None
            ),
            failed("/app/pings é de outro usuário. Rode 'sudo chown -R $USER /app/pings'.")
        );
    }

    #[test]
    fn a_full_or_read_only_disk_asks_to_free_space_or_mount_it_read_write() {
        for (reason, shown) in [
            (Reason::DiskFull, "disk full"),
            (Reason::ReadOnly, "read-only file system"),
            (Reason::Quota, "disk quota exceeded"),
            (Reason::Busy, "file busy or changed by another instance"),
        ] {
            assert_eq!(
                write_blocked(&EN_US, FOLDER, reason, (Some(0), Some(1000)), None),
                failed(&format!(
                    "cannot write to /app/pings ({shown}). Free some space or mount the disk read-write."
                )),
                "{reason:?}"
            );
        }
    }
}
