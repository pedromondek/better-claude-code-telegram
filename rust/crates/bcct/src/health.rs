use std::ffi::OsString;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::files::read_json;
use crate::hook::{millis, now_ms};
use crate::js::{
    join_path, js_key_count, js_length, js_template, js_trim, js_truthy, stringify_pretty,
};
use crate::messages::{Messages, messages_for};
use crate::paths::{CONFIG_FILE, HEALTH_FILE, LAUNCH_FILE};
use crate::setup::{
    ACCESS_FILE, CHANNEL_PLUGIN_ID, ENV_FILE, HOOKS_PLUGIN_ID, MINIMUM_NODE, SETUP_COMMAND,
    SetupPaths, StatuslineState, claude_output, env_deny_rule, has_command, node_version,
    node_version_ok, parse_env_token, read_settings, read_text, repo_root, setup_locale,
    shell_file, shell_rc_files, statusline_state, whisper_python_works,
};
use crate::shell_rc::rc_loads;
use crate::spinner::{Spinner, Terminal, pending, spin_on_stdout};
use crate::statusline::{TELEGRAM_HEALTH_TTL_MS, TELEGRAM_LAUNCH_GRACE_MS, time_of};
use crate::telegram::{api_root, call, post_json, property};
use crate::ui::{fail, section, should_colorize, skipped, success};

const JSON_FLAG: &str = "--json";
const ALL_ANSWERS: [&str; 2] = ["all", "tudo"];
const FAILURE: u8 = 1;
const UNDEFINED_PATH: &str = "The \"path\" argument must be of type string. Received undefined";
const DENY_NOT_A_LIST: &str = "deny.includes is not a function";
const WHISPER_PYTHON: &str = "whisper/venv/bin/python";

pub struct Machine<'a> {
    pub var: &'a dyn Fn(&str) -> Option<OsString>,
    pub home: &'a Path,
    pub repo: &'a Path,
    pub uid: Option<u32>,
    pub now: u64,
    pub node_version: &'a dyn Fn() -> Option<String>,
    pub has_command: &'a dyn Fn(&str) -> bool,
    pub claude_output: &'a dyn Fn(&[&str]) -> String,
    pub python_works: &'a dyn Fn(&Path) -> bool,
    pub fetch: &'a dyn Fn(&str, &str) -> Option<Vec<u8>>,
}

impl std::fmt::Debug for Machine<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Machine")
            .field("home", &self.home)
            .field("repo", &self.repo)
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
                Check::Plugins,
                Check::Shell,
            ],
            Self::Telegram => &[Check::Token, Check::Groups, Check::Pairing, Check::Polling],
            Self::Security => &[Check::User, Check::Protection, Check::Config],
            Self::Extras => &[Check::Transcription, Check::Mermaid, Check::Statusline],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Node,
    Claude,
    Bun,
    Plugins,
    Shell,
    Token,
    Groups,
    Pairing,
    Polling,
    User,
    Protection,
    Config,
    Transcription,
    Mermaid,
    Statusline,
}

impl Check {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Claude => "claude",
            Self::Bun => "bun",
            Self::Plugins => "plugins",
            Self::Shell => "shell",
            Self::Token => "token",
            Self::Groups => "groups",
            Self::Pairing => "pairing",
            Self::Polling => "polling",
            Self::User => "user",
            Self::Protection => "protection",
            Self::Config => "config",
            Self::Transcription => "transcription",
            Self::Mermaid => "mermaid",
            Self::Statusline => "statusline",
        }
    }

    fn label(self, messages: &Messages) -> &'static str {
        let labels = messages.health_labels;

        match self {
            Self::Node => labels.node,
            Self::Claude => labels.claude,
            Self::Bun => labels.bun,
            Self::Plugins => labels.plugins,
            Self::Shell => labels.shell,
            Self::Token => labels.token,
            Self::Groups => labels.groups,
            Self::Pairing => labels.pairing,
            Self::Polling => labels.polling,
            Self::User => labels.user,
            Self::Protection => labels.protection,
            Self::Config => labels.config,
            Self::Transcription => labels.transcription,
            Self::Mermaid => labels.mermaid,
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
type Outcome = Result<Verdict, String>;

fn ok(detail: &str) -> Verdict {
    (Status::Ok, detail.to_owned())
}

fn failed(detail: &str) -> Verdict {
    (Status::Fail, detail.to_owned())
}

fn off(detail: &str) -> Verdict {
    (Status::Off, detail.to_owned())
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

    fn run(&mut self, check: Check) -> Outcome {
        match check {
            Check::Shell => self.shell(),
            Check::Token => self.token_check(),
            Check::Groups => self.groups(),
            Check::Protection => self.protection(),
            Check::Node => Ok(self.node()),
            Check::Claude => Ok(self.tool("claude")),
            Check::Bun => Ok(self.tool("bun")),
            Check::Plugins => Ok(self.plugins()),
            Check::Pairing => Ok(self.pairing()),
            Check::Polling => Ok(self.polling()),
            Check::User => Ok(self.user()),
            Check::Config => Ok(self.config()),
            Check::Transcription => Ok(self.transcription()),
            Check::Mermaid => Ok(self.mermaid()),
            Check::Statusline => Ok(self.statusline()),
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

    fn shell(&self) -> Outcome {
        let detail = self.messages.health_detail;
        let home = self
            .text_var("HOME")
            .ok_or_else(|| UNDEFINED_PATH.to_owned())?;
        let shell = self.text_var("SHELL");
        let files = shell_rc_files(&home, shell.as_deref(), cfg!(target_os = "macos"));
        let script = shell_file(self.machine.repo);
        let script_text = script.to_string_lossy();
        let loaded_by = files
            .primary
            .iter()
            .chain(&files.others)
            .find(|rc| rc_loads(&read_text(rc).unwrap_or_default(), &script_text));

        if let Some(rc) = loaded_by {
            return Ok(ok(&(detail.loaded_in)(&readable(rc))));
        }

        Ok(match files.unsupported.filter(|name| !name.is_empty()) {
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
        })
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

    fn token_check(&mut self) -> Outcome {
        let detail = self.messages.health_detail;

        Ok(match self.bot() {
            Bot::Missing => failed(detail.no_token),
            Bot::Failed(error) => failed(error),
            Bot::Found(found) => {
                let username = property(found.as_ref(), "username")?;
                ok(&(detail.bot)(&undefined_or(username)))
            }
        })
    }

    fn groups(&mut self) -> Outcome {
        let messages = self.messages;
        let detail = messages.health_detail;

        let Bot::Found(found) = self.bot() else {
            return Ok(off(detail.groups_unknown));
        };

        Ok(
            if property(found.as_ref(), "can_join_groups")?.is_some_and(js_truthy) {
                let username = property(found.as_ref(), "username")?;
                failed(&(messages.groups_warning)(&undefined_or(username)))
            } else {
                ok(detail.groups_off)
            },
        )
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
                &format!("{SETUP_COMMAND}:pairing"),
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

    fn protection(&self) -> Outcome {
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
            Some(_) => return Err(DENY_NOT_A_LIST.to_owned()),
        };

        Ok(if protected {
            ok(detail.protected)
        } else {
            failed(&(detail.unprotected)(&format!("{SETUP_COMMAND}:token")))
        })
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
            failed(&(detail.broken)(&format!("{SETUP_COMMAND}:transcription")))
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

    fn statusline(&self) -> Verdict {
        let shown = self.messages.health_detail.statusline;
        let (status, detail) = match statusline_state(&self.paths, self.machine.repo) {
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

fn write_all(out: &mut dyn Write, text: &str) -> io::Result<()> {
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

            let (status, detail) = match checks.run(*check) {
                Ok(outcome) => outcome,
                Err(error) => {
                    if let Some(waiting) = waiting {
                        let _shown = waiting.abandon();
                    }

                    return Err(error);
                }
            };
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

fn as_json(results: &[Entry]) -> String {
    let entries: Vec<Value> = results
        .iter()
        .map(|entry| {
            json!({
                "group": entry.group.as_str(),
                "check": entry.check.as_str(),
                "status": entry.status.as_str(),
                "detail": entry.detail,
            })
        })
        .collect();

    format!("{}\n", stringify_pretty(&Value::Array(entries)))
}

fn report(screen: &mut Screen<'_>, error: &str) -> u8 {
    let _written = write_all(
        screen.err,
        &format!("{}\n", fail(error, screen.colorize_err)),
    );
    FAILURE
}

pub fn run(args: &[String], machine: &Machine<'_>, screen: &mut Screen<'_>) -> u8 {
    let paths = SetupPaths::resolve(machine.var, machine.home);
    let messages = messages_for(setup_locale(&paths.app_dir, machine.var));
    let json = args.iter().any(|arg| arg == JSON_FLAG);
    let named: Vec<String> = args
        .iter()
        .filter(|arg| *arg != JSON_FLAG)
        .cloned()
        .collect();
    let groups = match parse_health_groups(&named, messages) {
        Ok(groups) => groups,
        Err(error) => return report(screen, &error),
    };
    let mut checks = Checks {
        machine,
        messages,
        paths,
        token: None,
        bot: None,
    };

    match run_groups(&groups, &mut checks, screen, !json) {
        Ok(results) => {
            if json && write_all(screen.out, &as_json(&results)).is_err() {
                return report(screen, messages.health_not_shown);
            }

            if results.iter().any(|entry| entry.status == Status::Fail) {
                FAILURE
            } else {
                0
            }
        }
        Err(error) => report(screen, &error),
    }
}

pub fn run_process(args: &[OsString], stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    let home = std::env::home_dir().unwrap_or_default();
    let var = |name: &str| std::env::var_os(name);
    let repo = repo_root();
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
        repo: &repo,
        uid,
        now: now_ms(),
        node_version: &node_version,
        has_command: &has_command,
        claude_output: &claude_output,
        python_works: &whisper_python_works,
        fetch: &post_json,
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

    run(&args, &machine, &mut screen)
}
