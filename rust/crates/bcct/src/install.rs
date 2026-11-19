use std::cell::RefCell;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{Map, Number, Value, json};

use crate::config::{
    DelayKind, VISUAL_REVIEW_KEY, VISUALS_KEY, VisualMode, Visuals, read_config, read_visuals,
};
use crate::files::{FileFailure, create_private_dir, write_private};
use crate::health::Screen;
use crate::journal::{ChangeKind, link_target};
use crate::js::{
    format_number, join_path, js_number, js_template, js_trim, js_truthy, stringify_pretty,
};
use crate::locale::Locale;
use crate::messages::Messages;
use crate::paths::CONFIG_FILE;
use crate::program::{HOST_PROGRAM_LOOKUP, PATH_EXTENSIONS_VARIABLE, ProgramLookup, find_program};
use crate::self_install::Channel;
use crate::setup::{
    CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID, read_settings, shell_file, whisper_python_works,
};
use crate::setup_files::{current_inbox_days, review_name, templated_days, visuals_text};
use crate::shell_rc::{rc_files_without_shell_line, source_line};
use crate::spinner::{Pending, pending};
use crate::ui::{bold, info, note, skipped, success, warn};

pub const CLAUDE_CODE_VERSION: &str = "2.1.303";
pub const BUN_VERSION: &str = "1.4.3";
pub const UV_VERSION: &str = "0.13.1";
pub const MARKETPLACE_NAME: &str = "better-claude-code-telegram";
pub const BCCT_PLUGIN_ID: &str = "bcct@better-claude-code-telegram";
pub const PLUGIN_IDS: [&str; 3] = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID, BCCT_PLUGIN_ID];
pub const MERMAID_UNINSTALL_COMMAND: &str = "npm uninstall -g @mermaid-js/mermaid-cli";
pub const TRANSCRIPTION_MODELS: [&str; 3] = ["base", "small", "medium"];
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "base";

const REQUIRED_PLUGIN_IDS: [&str; 2] = [CHANNEL_PLUGIN_ID, HOOKS_PLUGIN_ID];
pub const DISABLE_ANSWERS: [&str; 8] = ["não", "nao", "n", "nenhum", "no", "none", "off", "0"];
const WHISPER_PACKAGES: [&str; 2] = ["faster-whisper==1.2.1", "av==18.1.0"];
pub const MARKETPLACE_REPO: &str = "pedromondek/better-claude-code-telegram";
pub const TRANSCRIBE_SOURCE: &str =
    include_str!("../../../../plugins/telegram/extensions/transcribe.py");
const STABLE_REF: &str = "stable";
const STDIN_SCRIPT: &str = "-";
const WHISPER_FOLDER: &str = "whisper";
const VENV_FOLDER: &str = "whisper/venv";
const VENV_PYTHON: &str = "bin/python";
const VENV_PIP: &str = "bin/pip";
const MODEL_PREFIX: &str = "models--Systran--faster-whisper-";
const SCOPE: [&str; 2] = ["--scope", "user"];
const PATH_VARIABLE: &str = "PATH";
const PATH_SEPARATOR: &str = if cfg!(windows) { ";" } else { ":" };
const LIST_SEPARATOR: &str = "\n  • ";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Claude,
    Bun,
    Uv,
}

impl Tool {
    pub const REQUIRED: [Self; 2] = [Self::Claude, Self::Bun];
    const ALL: [Self; 3] = [Self::Claude, Self::Bun, Self::Uv];

    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.as_str() == name)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Bun => "bun",
            Self::Uv => "uv",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installer {
    pub command: String,
    pub bin_dir: PathBuf,
}

#[must_use]
pub fn installer_for(tool: Tool, home: &Path) -> Installer {
    let (command, bin_dir) = match tool {
        Tool::Claude => (
            format!("curl -fsSL https://claude.ai/install.sh | bash -s {CLAUDE_CODE_VERSION}"),
            ".local/bin",
        ),
        Tool::Bun => (
            format!("curl -fsSL https://bun.sh/install | bash -s \"bun-v{BUN_VERSION}\""),
            ".bun/bin",
        ),
        Tool::Uv => (
            format!("curl -LsSf https://astral.sh/uv/{UV_VERSION}/install.sh | sh"),
            ".local/bin",
        ),
    };

    Installer {
        command,
        bin_dir: join_path(home, bin_dir),
    }
}

#[must_use]
pub fn manual_uninstall_commands() -> String {
    PLUGIN_IDS
        .iter()
        .map(|id| format!("  claude plugin uninstall {id}"))
        .chain([format!(
            "  claude plugin marketplace remove {MARKETPLACE_NAME}"
        )])
        .collect::<Vec<_>>()
        .join("\n")
}

fn filled_var(var: &dyn Fn(&str) -> Option<OsString>, name: &str) -> Option<OsString> {
    var(name).filter(|value| !value.is_empty())
}

#[must_use]
pub fn huggingface_cache_dir(var: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> PathBuf {
    if let Some(hub) = filled_var(var, "HF_HUB_CACHE") {
        return PathBuf::from(hub);
    }

    if let Some(hf_home) = filled_var(var, "HF_HOME") {
        return join_path(Path::new(&hf_home), "hub");
    }

    let cache =
        filled_var(var, "XDG_CACHE_HOME").map_or_else(|| join_path(home, ".cache"), PathBuf::from);

    join_path(&cache, "huggingface/hub")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Parsed<T> {
    Value(T),
    Off,
    Keep,
}

fn normalized_answer(answer: &str) -> String {
    js_trim(answer).to_lowercase()
}

#[must_use]
pub fn parse_transcription_model(answer: &str) -> Parsed<&'static str> {
    let answer = normalized_answer(answer);

    if answer.is_empty() {
        return Parsed::Keep;
    }

    if DISABLE_ANSWERS.contains(&answer.as_str()) {
        return Parsed::Off;
    }

    TRANSCRIPTION_MODELS
        .into_iter()
        .find(|model| *model == answer)
        .map_or(Parsed::Keep, Parsed::Value)
}

#[must_use]
pub fn parse_inbox_days(answer: &str) -> Parsed<f64> {
    let answer = normalized_answer(answer);

    if !answer.is_empty() && answer.bytes().all(|byte| byte.is_ascii_digit()) {
        let days = js_number(&answer);

        return if days > 0.0 {
            Parsed::Value(days)
        } else {
            Parsed::Keep
        };
    }

    if DISABLE_ANSWERS.contains(&answer.as_str()) {
        Parsed::Off
    } else {
        Parsed::Keep
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    pub description: String,
    pub command: String,
}

#[derive(Debug, Clone, Copy)]
pub struct Installed<'a> {
    pub marketplaces: &'a str,
    pub plugins: &'a str,
    pub rc_files: &'a [PathBuf],
    pub plugin_ids: &'a [&'static str],
}

#[must_use]
pub fn marketplace_source(version: &str) -> String {
    if Channel::of(version).is_unstable() {
        format!("{MARKETPLACE_REPO}#v{version}")
    } else {
        format!("{MARKETPLACE_REPO}#{STABLE_REF}")
    }
}

#[must_use]
pub fn plugin_plan(
    installed: Installed<'_>,
    messages: &Messages,
    source: &str,
    shell_file: &Path,
) -> Vec<PlanStep> {
    let marketplace = (!installed.marketplaces.contains(MARKETPLACE_NAME)).then(|| PlanStep {
        description: (messages.plan_marketplace)(MARKETPLACE_NAME),
        command: format!("claude plugin marketplace add {source}"),
    });
    let plugins = installed
        .plugin_ids
        .iter()
        .filter(|id| !installed.plugins.contains(*id))
        .map(|id| PlanStep {
            description: (messages.plan_plugin)(id),
            command: format!("claude plugin install {id} --scope user"),
        });
    let rc_files = installed.rc_files.iter().map(|rc_file| PlanStep {
        description: (messages.plan_shell_line)(&rc_file.to_string_lossy()),
        command: format!(
            "echo '{}' >> \"{}\"",
            source_line(&shell_file.to_string_lossy()),
            rc_file.display()
        ),
    });

    marketplace
        .into_iter()
        .chain(plugins)
        .chain(rc_files)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declined {
    pub message: String,
    pub hint: &'static str,
    pub commands: Vec<String>,
}

#[must_use]
pub fn declined_report(declined: &Declined, colorize: bool) -> String {
    let lines: Vec<String> = [info(declined.hint, colorize)]
        .into_iter()
        .chain(
            declined
                .commands
                .iter()
                .map(|command| bold(command, colorize)),
        )
        .collect();

    format!(
        "{}\n{}\n",
        success(&declined.message, colorize),
        lines.join("\n")
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure<E> {
    Failed(String),
    Declined(Declined),
    Asking(E),
    Screen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandsChoice {
    Keep,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptionChoice {
    Off,
    Model(&'static str),
    Uninstall(Vec<&'static str>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualsPick {
    pub mode: VisualMode,
    pub review: Option<bool>,
}

pub trait Asker {
    type Error;

    fn yes_no(&mut self, prompt: &str, default_yes: bool) -> Result<bool, Self::Error>;
    fn installed_commands(&mut self) -> Result<CommandsChoice, Self::Error>;
    fn transcription(
        &mut self,
        current: Option<&'static str>,
        saved: bool,
        installed: &[&'static str],
    ) -> Result<TranscriptionChoice, Self::Error>;
    fn remove_models(
        &mut self,
        others: &[&'static str],
        previous: Option<&'static str>,
        tag: &str,
    ) -> Result<Vec<&'static str>, Self::Error>;
    fn inbox(&mut self, current: Option<f64>, saved: bool) -> Result<Option<f64>, Self::Error>;
    fn visuals(
        &mut self,
        current: Visuals,
        saved: bool,
        review_saved: bool,
    ) -> Result<VisualsPick, Self::Error>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeUndo {
    pub args: Vec<String>,
}

impl ClaudeUndo {
    fn of(args: &[&str]) -> Self {
        Self {
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }

    pub fn run(&self, system: &System, messages: &Messages) -> Result<(), String> {
        let args: Vec<&str> = self.args.iter().map(String::as_str).collect();

        system.run_claude(&args, messages)
    }
}

pub trait Journal {
    fn record(&mut self, kind: ChangeKind, target: String, undo: Option<ClaudeUndo>);
    fn track_dir(&mut self, dir: &Path);
    fn track_file(&mut self, file: &Path) -> io::Result<()>;
}

#[derive(Debug)]
pub struct System {
    vars: RefCell<Vec<(OsString, OsString)>>,
    lookup: ProgramLookup,
}

impl System {
    #[must_use]
    pub fn new(vars: Vec<(OsString, OsString)>) -> Self {
        Self {
            vars: RefCell::new(vars),
            lookup: HOST_PROGRAM_LOOKUP,
        }
    }

    #[must_use]
    pub fn with_program_lookup(self, lookup: ProgramLookup) -> Self {
        Self { lookup, ..self }
    }

    #[must_use]
    pub fn from_process() -> Self {
        Self::new(
            [PATH_VARIABLE, PATH_EXTENSIONS_VARIABLE]
                .into_iter()
                .filter_map(|name| {
                    std::env::var_os(name).map(|value| (OsString::from(name), value))
                })
                .collect(),
        )
    }

    fn var(&self, wanted: &str) -> Option<OsString> {
        self.vars
            .borrow()
            .iter()
            .rev()
            .find(|(name, _)| name == wanted)
            .map(|(_, value)| value.clone())
    }

    #[must_use]
    pub fn path(&self) -> Option<OsString> {
        self.var(PATH_VARIABLE)
    }

    fn prepend_path(&self, dir: &Path) {
        let mut path = dir.as_os_str().to_owned();
        path.push(PATH_SEPARATOR);
        path.push(self.path().unwrap_or_default());

        self.vars
            .borrow_mut()
            .push((OsString::from(PATH_VARIABLE), path));
    }

    fn find_program(&self, name: &OsStr) -> Option<PathBuf> {
        let folders: Vec<PathBuf> = self
            .path()
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();

        find_program(
            name.to_str()?,
            &folders,
            self.var(PATH_EXTENSIONS_VARIABLE).as_deref(),
            &Path::is_file,
        )
    }

    #[must_use]
    pub fn command(&self, program: impl AsRef<OsStr>) -> Command {
        let program = program.as_ref();
        let resolved = match self.lookup {
            ProgramLookup::Shell => None,
            ProgramLookup::PathSearch => self.find_program(program),
        };
        let mut command = Command::new(resolved.as_deref().map_or(program, Path::as_os_str));
        command.envs(self.vars.borrow().iter().map(|(name, value)| (name, value)));
        command
    }

    fn quiet(&self, program: impl AsRef<OsStr>, args: &[&str]) -> Option<i32> {
        self.command(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .and_then(|status| status.code())
    }

    #[must_use]
    pub fn has_command(&self, name: &str) -> bool {
        match self.lookup {
            ProgramLookup::Shell => {
                self.quiet("sh", &["-c", &format!("command -v {name}")]) == Some(0)
            }
            ProgramLookup::PathSearch => self.find_program(OsStr::new(name)).is_some(),
        }
    }

    #[must_use]
    pub fn claude_output(&self, args: &[&str]) -> String {
        self.command("claude")
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default()
    }

    fn run_or_fail(
        &self,
        program: impl AsRef<OsStr>,
        args: &[&str],
        description: &str,
        messages: &Messages,
    ) -> Result<(), String> {
        let output = self
            .command(program)
            .args(args)
            .stdin(Stdio::null())
            .output();

        Self::succeeded_or_said(&output, description, messages)
    }

    fn run_script_or_fail(
        &self,
        python: impl AsRef<OsStr>,
        script: &str,
        args: &[&str],
        description: &str,
        messages: &Messages,
    ) -> Result<(), String> {
        let output = self
            .command(python)
            .arg(STDIN_SCRIPT)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                let _written = child
                    .stdin
                    .take()
                    .map(|mut stdin| stdin.write_all(script.as_bytes()));

                child.wait_with_output()
            });

        Self::succeeded_or_said(&output, description, messages)
    }

    fn succeeded_or_said(
        output: &io::Result<Output>,
        description: &str,
        messages: &Messages,
    ) -> Result<(), String> {
        let said = match output {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
            Err(_) => String::new(),
        };
        let failed = (messages.failed)(description);
        let said = js_trim(&said);

        Err(if said.is_empty() {
            failed
        } else {
            format!("{failed}\n{said}")
        })
    }

    pub fn run_claude(&self, args: &[&str], messages: &Messages) -> Result<(), String> {
        self.run_or_fail(
            "claude",
            args,
            &format!("claude {}", args.join(" ")),
            messages,
        )
    }

    #[must_use]
    pub fn run_installer(&self, command: &str) -> Option<i32> {
        self.command("sh")
            .args(["-c", command])
            .status()
            .ok()
            .and_then(|status| status.code())
    }
}

pub struct Machine<'a> {
    pub home: &'a Path,
    pub app_dir: &'a Path,
    pub marketplace: &'a str,
    pub hf_cache: &'a Path,
    pub settings_file: &'a Path,
    pub shell: Option<&'a str>,
    pub macos: bool,
    pub system: &'a System,
    pub run_installer: &'a dyn Fn(&System, &str) -> Option<i32>,
    pub chromium: &'a dyn Fn() -> Option<PathBuf>,
}

impl std::fmt::Debug for Machine<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Machine")
            .field("home", &self.home)
            .field("app_dir", &self.app_dir)
            .field("marketplace", &self.marketplace)
            .field("hf_cache", &self.hf_cache)
            .field("settings_file", &self.settings_file)
            .field("shell", &self.shell)
            .field("macos", &self.macos)
            .field("system", &self.system)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginChoice {
    pub marketplaces: String,
    pub plugins: String,
    pub plugin_ids: Vec<&'static str>,
    pub removed_ids: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kept<'v> {
    Language(&'v str),
    Delay(f64),
    Delays { kinds: [f64; 3], summary: &'v str },
    QuietHours(Option<(&'v str, &'v str)>),
    Inbox(Option<f64>),
    Transcription(Option<&'v str>),
    Visuals(VisualsPick),
    VisualReview(bool),
}

fn model_dir(hf_cache: &Path, model: &str) -> PathBuf {
    join_path(hf_cache, &format!("{MODEL_PREFIX}{model}"))
}

fn model_installed(hf_cache: &Path, model: &str) -> bool {
    model_dir(hf_cache, model).exists()
}

fn whisper_python(app_dir: &Path) -> PathBuf {
    join_path(&join_path(app_dir, VENV_FOLDER), VENV_PYTHON)
}

fn saved_quiet_hours(value: Option<&Value>) -> String {
    let part = |key: &str| {
        value
            .and_then(|range| range.get(key))
            .filter(|part| js_truthy(part))
            .map(js_template)
    };

    match (part("start"), part("end")) {
        (Some(start), Some(end)) => format!("{start}-{end}"),
        _ => String::new(),
    }
}

fn chosen_quiet_hours(value: Option<(&str, &str)>) -> String {
    match value {
        Some((start, end)) if !start.is_empty() && !end.is_empty() => format!("{start}-{end}"),
        _ => String::new(),
    }
}

fn same_number(value: Option<&Value>, number: f64) -> bool {
    value.and_then(Value::as_f64) == Some(number)
}

fn days_text(messages: &Messages, days: Option<f64>) -> String {
    days.map_or_else(
        || messages.inbox_forever.to_owned(),
        |days| templated_days(messages, &format_number(days)),
    )
}

#[must_use]
pub fn kept_message(
    kept: Kept<'_>,
    config: &Map<String, Value>,
    app_dir: &Path,
    hf_cache: &Path,
    messages: &Messages,
) -> Option<String> {
    match kept {
        Kept::Language(language) => (Locale::parse(language).is_some()
            && config.get("language").and_then(Value::as_str) == Some(language))
        .then(|| (messages.language_kept)(language)),
        Kept::Delay(minutes) => {
            same_number(config.get("delayMinutes"), minutes).then(|| (messages.delay_kept)(minutes))
        }
        Kept::Delays { kinds, summary } => config
            .get("delays")
            .and_then(Value::as_object)
            .is_some_and(|delays| {
                DelayKind::ALL
                    .into_iter()
                    .zip(kinds)
                    .all(|(kind, minutes)| same_number(delays.get(kind.key()), minutes))
            })
            .then(|| (messages.delays_kept)(summary)),
        Kept::QuietHours(range) => {
            let chosen = chosen_quiet_hours(range);

            (config.contains_key("quietHours")
                && saved_quiet_hours(config.get("quietHours")) == chosen)
                .then(|| {
                    (messages.quiet_kept)(if chosen.is_empty() {
                        messages.quiet_off
                    } else {
                        &chosen
                    })
                })
        }
        Kept::Inbox(days) => {
            let saved = config.get("inboxRetentionDays");
            let same = match days {
                None => saved == Some(&Value::Null),
                Some(days) => same_number(saved, days),
            };

            same.then(|| (messages.inbox_kept)(&days_text(messages, days)))
        }
        Kept::Visuals(pick) => {
            let same_mode =
                config.get(VISUALS_KEY).and_then(Value::as_str) == Some(pick.mode.key());
            let same_review = pick
                .review
                .is_none_or(|review| config.get(VISUAL_REVIEW_KEY) == Some(&Value::Bool(review)));

            (same_mode && same_review)
                .then(|| (messages.visuals_kept)(&visuals_text(messages, pick.mode, pick.review)))
        }
        Kept::VisualReview(review) => (config.get(VISUAL_REVIEW_KEY) == Some(&Value::Bool(review)))
            .then(|| (messages.visual_review_kept)(review_name(messages, review))),
        Kept::Transcription(model) => {
            let saved = config.get("transcription")?;
            let saved_model = saved.get("model").and_then(Value::as_str);
            let same = match model {
                None => saved.get("model").is_none_or(Value::is_null),
                Some(model) => saved_model == Some(model),
            };

            if !same {
                return None;
            }

            match model {
                None => Some(messages.transcription_kept_off.to_owned()),
                Some(model) => (model_installed(hf_cache, model)
                    && whisper_python_works(&whisper_python(app_dir)))
                .then(|| (messages.transcription_model_kept)(model)),
            }
        }
    }
}

pub fn remove_path(path: &Path) -> Result<(), FileFailure> {
    let removed = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    };

    removed.map_err(|_| FileFailure::NotRemoved(path.to_path_buf()))
}

fn number_value(number: f64) -> Value {
    Number::from_f64(number).map_or(Value::Null, Value::Number)
}

pub struct Install<'r, 's, E> {
    machine: &'r Machine<'r>,
    screen: &'r mut Screen<'s>,
    journal: &'r mut dyn Journal,
    asker: &'r mut dyn Asker<Error = E>,
    messages: &'static Messages,
    refused: bool,
}

impl<E> std::fmt::Debug for Install<'_, '_, E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Install")
            .field("machine", &self.machine)
            .field("screen", &self.screen)
            .field("refused", &self.refused)
            .finish_non_exhaustive()
    }
}

impl<'r, 's, E> Install<'r, 's, E> {
    #[must_use]
    pub fn new(
        machine: &'r Machine<'r>,
        screen: &'r mut Screen<'s>,
        journal: &'r mut dyn Journal,
        asker: &'r mut dyn Asker<Error = E>,
        messages: &'static Messages,
    ) -> Self {
        Self {
            machine,
            screen,
            journal,
            asker,
            messages,
            refused: false,
        }
    }

    fn colorize(&self) -> bool {
        self.screen.colorize_out
    }

    fn file_failure(&self, failure: &FileFailure) -> Failure<E> {
        Failure::Failed(failure.message(self.messages))
    }

    fn ready_to_wait(&self) -> Result<(), Failure<E>> {
        if self.refused {
            Err(Failure::Screen)
        } else {
            Ok(())
        }
    }

    fn say(&mut self, text: &str) {
        let out = &mut *self.screen.out;

        if out
            .write_all(format!("{text}\n").as_bytes())
            .and_then(|()| out.flush())
            .is_err()
        {
            self.refused = true;
        }
    }

    fn say_last(&mut self, text: &str) -> Result<(), Failure<E>> {
        self.say(text);
        self.ready_to_wait()
    }

    fn ask<T>(
        &mut self,
        question: impl FnOnce(&mut dyn Asker<Error = E>) -> Result<T, E>,
    ) -> Result<T, Failure<E>> {
        self.ready_to_wait()?;
        question(&mut *self.asker).map_err(Failure::Asking)
    }

    fn end_wait(&mut self, waiting: Pending, line: Option<&str>) {
        if waiting.finish(line, self.screen.out).is_err() {
            self.refused = true;
        }
    }

    fn while_pending<T>(
        &mut self,
        text: &str,
        work: impl FnOnce(&mut Self) -> Result<(T, Option<String>), Failure<E>>,
    ) -> Result<T, Failure<E>> {
        self.ready_to_wait()?;

        let waiting = pending(
            text,
            self.screen.out,
            self.screen.terminal,
            self.screen.colorize_out,
            self.screen.spin,
        );

        if waiting.refused() {
            self.end_wait(waiting, None);

            return Err(Failure::Screen);
        }

        match work(self) {
            Ok((value, line)) => {
                self.end_wait(waiting, line.as_deref());
                Ok(value)
            }
            Err(failure) => {
                self.end_wait(waiting, None);
                Err(failure)
            }
        }
    }

    pub fn ensure_requirements(&mut self, tools: &[Tool]) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let system = self.machine.system;
        let missing: Vec<Tool> = tools
            .iter()
            .copied()
            .filter(|tool| !system.has_command(tool.as_str()))
            .collect();
        let mut declined = Vec::new();

        for tool in missing {
            let name = tool.as_str();
            let installer = installer_for(tool, self.machine.home);
            let prompt = (messages.install_tool_prompt)(name, &installer.command);

            if !self.ask(|asker| asker.yes_no(&prompt, true))? {
                declined.push(tool);
                continue;
            }

            if (self.machine.run_installer)(system, &installer.command) != Some(0) {
                return Err(Failure::Failed((messages.install_failed)(name)));
            }

            let bin_dir = installer.bin_dir.to_string_lossy();

            self.journal.record(
                ChangeKind::ToolInstalled,
                format!("{name} ({bin_dir})"),
                None,
            );
            system.prepend_path(&installer.bin_dir);

            if !system.has_command(name) {
                return Err(Failure::Failed((messages.tool_still_missing)(
                    name, &bin_dir,
                )));
            }

            let line = success(&(messages.tool_installed)(name, &bin_dir), self.colorize());
            self.say(&line);
        }

        self.ready_to_wait()?;

        if declined.is_empty() {
            return Ok(());
        }

        let names: Vec<&str> = declined.iter().map(|tool| tool.as_str()).collect();

        Err(Failure::Declined(Declined {
            message: (messages.tools_declined)(&names.join(", ")),
            hint: messages.by_hand,
            commands: declined
                .iter()
                .map(|tool| installer_for(*tool, self.machine.home).command)
                .collect(),
        }))
    }

    fn rc_files_without_shell_line(&self) -> Vec<PathBuf> {
        rc_files_without_shell_line(
            &self.machine.home.to_string_lossy(),
            self.machine.shell,
            self.machine.macos,
            &shell_file(self.machine.app_dir),
        )
    }

    fn checked_lines(&self, marketplaces: &str, plugins: &str) -> String {
        let messages = self.messages;
        let colorize = self.colorize();
        let marker = |complete: bool, text: &str| {
            if complete {
                success(text, colorize)
            } else {
                skipped(text, colorize)
            }
        };
        let count = |ids: &[&str]| {
            u64::try_from(ids.iter().filter(|id| plugins.contains(**id)).count())
                .unwrap_or(u64::MAX)
        };
        let required = count(&REQUIRED_PLUGIN_IDS);
        let optional = count(&[BCCT_PLUGIN_ID]);
        let required_complete = required == 2;
        let registered = marketplaces.contains(MARKETPLACE_NAME);

        [
            marker(required_complete, messages.plugins_checked),
            format!(
                "  {}",
                marker(
                    registered,
                    if registered {
                        messages.marketplace_found
                    } else {
                        messages.marketplace_missing
                    }
                )
            ),
            format!(
                "  {}",
                marker(required_complete, &(messages.required_plugins)(required, 2))
            ),
            format!(
                "  {}",
                marker(optional == 1, &(messages.optional_plugins)(optional, 1))
            ),
        ]
        .join("\n")
    }

    pub fn confirm_plugin_step(&mut self) -> Result<PluginChoice, Failure<E>> {
        let messages = self.messages;
        let system = self.machine.system;
        let (marketplaces, plugins) = self.while_pending(messages.plugins_checking, |this| {
            let marketplaces = system.claude_output(&["plugin", "marketplace", "list"]);
            let plugins = system.claude_output(&["plugin", "list"]);
            let lines = this.checked_lines(&marketplaces, &plugins);

            Ok(((marketplaces, plugins), Some(lines)))
        })?;
        let rc_files = self.rc_files_without_shell_line();
        let plan = plugin_plan(
            Installed {
                marketplaces: &marketplaces,
                plugins: &plugins,
                rc_files: &rc_files,
                plugin_ids: &REQUIRED_PLUGIN_IDS,
            },
            messages,
            self.machine.marketplace,
            &shell_file(self.machine.app_dir),
        );

        if !plan.is_empty() {
            let steps: Vec<String> = plan
                .iter()
                .map(|step| format!("  • {}", step.description))
                .collect();
            self.say(&format!("{}\n{}", messages.plan_header, steps.join("\n")));

            if !self.ask(|asker| asker.yes_no(messages.plan_prompt, true))? {
                return Err(Failure::Declined(Declined {
                    message: messages.nothing_installed.to_owned(),
                    hint: messages.by_hand,
                    commands: plan.into_iter().map(|step| step.command).collect(),
                }));
            }
        }

        let has_commands = plugins.contains(BCCT_PLUGIN_ID);
        let wants_commands = if has_commands {
            self.ask(|asker| asker.installed_commands())? == CommandsChoice::Keep
        } else {
            self.ask(|asker| asker.yes_no(messages.bcct_prompt, true))?
        };

        Ok(PluginChoice {
            marketplaces,
            plugins,
            plugin_ids: if wants_commands {
                PLUGIN_IDS.to_vec()
            } else {
                REQUIRED_PLUGIN_IDS.to_vec()
            },
            removed_ids: if has_commands && !wants_commands {
                vec![BCCT_PLUGIN_ID]
            } else {
                Vec::new()
            },
        })
    }

    fn claude_step(&mut self, text: &str, args: &[&str], done: &str) -> Result<(), Failure<E>> {
        let system = self.machine.system;
        let messages = self.messages;

        self.while_pending(text, |this| {
            system.run_claude(args, messages).map_err(Failure::Failed)?;
            Ok(((), Some(success(done, this.colorize()))))
        })
    }

    fn quiet_step(&mut self, text: &str, args: &[&str], done: &str) -> Result<(), Failure<E>> {
        let system = self.machine.system;

        self.while_pending(text, |this| {
            let _status = system.quiet("claude", args);
            Ok(((), Some(success(done, this.colorize()))))
        })
    }

    fn remove_plugin(&mut self, id: &str) -> Result<(), Failure<E>> {
        let messages = self.messages;

        self.claude_step(
            &(messages.plugin_removing)(id),
            &["plugin", "uninstall", id, SCOPE[0], SCOPE[1]],
            &(messages.plugin_removed)(id),
        )?;
        self.journal.record(
            ChangeKind::PluginRemoved,
            id.to_owned(),
            Some(ClaudeUndo::of(&[
                "plugin", "install", id, SCOPE[0], SCOPE[1],
            ])),
        );

        Ok(())
    }

    pub fn ensure_plugins(&mut self, choice: &PluginChoice) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let colorize = self.colorize();

        for id in &choice.removed_ids {
            self.remove_plugin(id)?;
        }

        if choice.marketplaces.contains(MARKETPLACE_NAME) {
            self.say(&skipped(
                &(messages.marketplace_registered)(MARKETPLACE_NAME),
                colorize,
            ));
        } else {
            self.claude_step(
                &(messages.marketplace_adding)(MARKETPLACE_NAME),
                &["plugin", "marketplace", "add", self.machine.marketplace],
                &(messages.marketplace_added)(MARKETPLACE_NAME),
            )?;
            self.journal.record(
                ChangeKind::MarketplaceAdded,
                MARKETPLACE_NAME.to_owned(),
                Some(ClaudeUndo::of(&[
                    "plugin",
                    "marketplace",
                    "remove",
                    MARKETPLACE_NAME,
                ])),
            );
        }

        for id in &choice.plugin_ids {
            if choice.plugins.contains(id) {
                self.say(&skipped(&(messages.plugin_installed)(id), colorize));
                continue;
            }

            self.claude_step(
                &(messages.plugin_installing)(id),
                &["plugin", "install", id, SCOPE[0], SCOPE[1]],
                &(messages.plugin_added)(id),
            )?;
            self.journal.record(
                ChangeKind::PluginInstalled,
                (*id).to_owned(),
                Some(ClaudeUndo::of(&[
                    "plugin",
                    "uninstall",
                    id,
                    SCOPE[0],
                    SCOPE[1],
                ])),
            );
        }

        let settings =
            read_settings(self.machine.settings_file, messages).map_err(Failure::Failed)?;
        let enabled = |id: &str| {
            settings
                .get("enabledPlugins")
                .and_then(Value::as_object)
                .and_then(|enabled| enabled.get(id))
                .and_then(Value::as_bool)
        };

        if enabled(CHANNEL_PLUGIN_ID) == Some(false) {
            self.say(&skipped(
                &(messages.plugin_already_disabled_outside)(CHANNEL_PLUGIN_ID),
                colorize,
            ));
        } else {
            self.quiet_step(
                &(messages.plugin_disabling)(CHANNEL_PLUGIN_ID),
                &["plugin", "disable", CHANNEL_PLUGIN_ID, SCOPE[0], SCOPE[1]],
                &(messages.plugin_disabled_outside)(CHANNEL_PLUGIN_ID),
            )?;
        }

        for id in choice
            .plugin_ids
            .iter()
            .filter(|id| **id != CHANNEL_PLUGIN_ID)
        {
            if enabled(id) == Some(true) {
                let line = if choice.plugins.contains(id) {
                    skipped(&(messages.plugin_already_enabled)(id), colorize)
                } else {
                    success(&(messages.plugin_enabled)(id), colorize)
                };
                self.say(&line);
                continue;
            }

            self.quiet_step(
                &(messages.plugin_enabling)(id),
                &["plugin", "enable", id, SCOPE[0], SCOPE[1]],
                &(messages.plugin_enabled)(id),
            )?;
        }

        self.ready_to_wait()
    }

    fn removal_step(
        &mut self,
        text: &str,
        args: &[&str],
        (removed, not_removed): (&str, &str),
    ) -> Result<(), Failure<E>> {
        let system = self.machine.system;

        self.while_pending(text, |this| {
            let colorize = this.colorize();
            let line = if system.quiet("claude", args) == Some(0) {
                success(removed, colorize)
            } else {
                warn(not_removed, colorize)
            };

            Ok(((), Some(line)))
        })
    }

    pub fn remove_plugins(&mut self) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let system = self.machine.system;
        let colorize = self.colorize();

        if !system.has_command("claude") {
            return self.say_last(&warn(
                &(messages.claude_missing_for_uninstall)(&manual_uninstall_commands()),
                colorize,
            ));
        }

        let (plugins, marketplaces) = self.while_pending(messages.plugins_checking, |_| {
            let plugins = system.claude_output(&["plugin", "list"]);
            let marketplaces = system.claude_output(&["plugin", "marketplace", "list"]);

            Ok(((plugins, marketplaces), None))
        })?;

        for id in PLUGIN_IDS {
            if !plugins.contains(id) {
                self.say(&skipped(&(messages.plugin_not_installed)(id), colorize));
                continue;
            }

            self.removal_step(
                &(messages.plugin_removing)(id),
                &["plugin", "uninstall", id, SCOPE[0], SCOPE[1]],
                (
                    &(messages.plugin_removed)(id),
                    &(messages.plugin_not_removed)(id),
                ),
            )?;
        }

        if !marketplaces.contains(MARKETPLACE_NAME) {
            return self.say_last(&skipped(
                &(messages.marketplace_not_registered)(MARKETPLACE_NAME),
                colorize,
            ));
        }

        self.removal_step(
            &(messages.marketplace_removing)(MARKETPLACE_NAME),
            &["plugin", "marketplace", "remove", MARKETPLACE_NAME],
            (
                &(messages.marketplace_removed)(MARKETPLACE_NAME),
                &(messages.marketplace_not_removed)(MARKETPLACE_NAME),
            ),
        )?;

        self.ready_to_wait()
    }

    fn update_config(
        &mut self,
        app_dir: &Path,
        key: &str,
        value: Value,
    ) -> Result<PathBuf, Failure<E>> {
        self.update_config_keys(app_dir, Map::from_iter([(key.to_owned(), value)]))
    }

    fn update_config_keys(
        &mut self,
        app_dir: &Path,
        patch: Map<String, Value>,
    ) -> Result<PathBuf, Failure<E>> {
        let config_file = join_path(app_dir, CONFIG_FILE);

        self.journal.track_dir(app_dir);

        let saved = create_private_dir(app_dir)
            .and_then(|()| self.journal.track_file(&config_file))
            .and_then(|()| {
                let mut config = read_config(app_dir);
                config.extend(patch);

                write_private(
                    &link_target(&config_file),
                    format!("{}\n", stringify_pretty(&Value::Object(config))).as_bytes(),
                )
            });

        match saved {
            Ok(()) => Ok(config_file),
            Err(_) => Err(self.file_failure(&FileFailure::NotSaved(config_file))),
        }
    }

    pub fn kept_setting(&mut self, kept: Kept<'_>, app_dir: &Path) -> Result<bool, Failure<E>> {
        let Some(message) = kept_message(
            kept,
            &read_config(app_dir),
            app_dir,
            self.machine.hf_cache,
            self.messages,
        ) else {
            return Ok(false);
        };

        let line = skipped(&message, self.colorize());
        self.say_last(&line)?;

        Ok(true)
    }

    fn installed_models(&self) -> Vec<&'static str> {
        TRANSCRIPTION_MODELS
            .into_iter()
            .filter(|model| model_installed(self.machine.hf_cache, model))
            .collect()
    }

    pub fn ensure_transcription(&mut self, app_dir: &Path) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let purpose = note(messages.transcription_purpose, self.colorize());
        self.say(&purpose);

        let config = read_config(app_dir);
        let saved_value = config.get("transcription");
        let current = if saved_value.is_some_and(|value| !js_truthy(value)) {
            None
        } else {
            let typed = saved_value
                .and_then(|value| value.get("model"))
                .filter(|model| !model.is_null())
                .map(js_template)
                .unwrap_or_default();

            match parse_transcription_model(&typed) {
                Parsed::Value(model) => Some(model),
                Parsed::Off => None,
                Parsed::Keep => Some(DEFAULT_TRANSCRIPTION_MODEL),
            }
        };
        let saved = saved_value.is_some();
        let previous = current.filter(|_| saved);
        let installed = self.installed_models();
        let model = match self.ask(|asker| asker.transcription(current, saved, &installed))? {
            TranscriptionChoice::Uninstall(removed) => {
                return self.uninstall_models(app_dir, &removed, previous);
            }
            TranscriptionChoice::Off => None,
            TranscriptionChoice::Model(model) => Some(model),
        };

        if self.kept_setting(Kept::Transcription(model), app_dir)? {
            return Ok(());
        }

        self.apply_transcription(app_dir, model)?;

        let Some(model) = model else {
            return Ok(());
        };
        let others: Vec<&'static str> = self
            .installed_models()
            .into_iter()
            .filter(|installed| *installed != model)
            .collect();

        if others.is_empty() {
            return Ok(());
        }

        let removed = self
            .ask(|asker| asker.remove_models(&others, previous, messages.model_used_until_now))?;

        self.remove_models(&removed)
    }

    fn remove_models(&mut self, models: &[&'static str]) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let hf_cache = self.machine.hf_cache;

        for model in models {
            self.while_pending(&(messages.model_removing)(model), |this| {
                remove_path(&model_dir(hf_cache, model))
                    .map_err(|failure| this.file_failure(&failure))?;
                Ok(((), None))
            })?;
        }

        if models.is_empty() {
            return Ok(());
        }

        let line = success(
            &(messages.models_removed)(&models.join(LIST_SEPARATOR)),
            self.colorize(),
        );
        self.say_last(&line)
    }

    fn uninstall_models(
        &mut self,
        app_dir: &Path,
        removed: &[&'static str],
        in_use: Option<&'static str>,
    ) -> Result<(), Failure<E>> {
        let messages = self.messages;

        if removed.is_empty() {
            return Ok(());
        }

        self.remove_models(removed)?;

        if self.installed_models().is_empty() {
            remove_path(&join_path(app_dir, WHISPER_FOLDER))
                .map_err(|failure| self.file_failure(&failure))?;
        }

        if in_use.is_none_or(|model| removed.contains(&model)) {
            self.update_config(app_dir, "transcription", Value::Null)?;
            let line = success(messages.transcription_disabled, self.colorize());
            self.say(&line);
        }

        self.ready_to_wait()
    }

    fn create_whisper_env(&mut self, venv: &Path) -> Result<PathBuf, Failure<E>> {
        let messages = self.messages;
        let system = self.machine.system;
        let python = join_path(venv, VENV_PYTHON);
        let venv_text = venv.to_string_lossy();
        let python_text = python.to_string_lossy();

        if system.has_command("uv") {
            self.while_pending(messages.whisper_env_creating, |_| {
                system
                    .run_or_fail(
                        "uv",
                        &["venv", &venv_text, "--python", "python3", "-q"],
                        "uv venv",
                        messages,
                    )
                    .map_err(Failure::Failed)?;
                Ok(((), None))
            })?;
            self.while_pending(messages.whisper_installing, |_| {
                let mut args = vec!["pip", "install", "-q", "--python", &python_text];
                args.extend(WHISPER_PACKAGES);
                system
                    .run_or_fail("uv", &args, messages.install_whisper, messages)
                    .map_err(Failure::Failed)?;
                Ok(((), None))
            })?;

            return Ok(python);
        }

        self.while_pending(messages.whisper_env_creating, |_| {
            if system.quiet("python3", &["-m", "venv", &venv_text]) == Some(0) {
                Ok(((), None))
            } else {
                Err(Failure::Failed(messages.python_env_failed.to_owned()))
            }
        })?;
        self.while_pending(messages.whisper_installing, |_| {
            let mut args = vec!["install", "-q"];
            args.extend(WHISPER_PACKAGES);
            system
                .run_or_fail(
                    join_path(venv, VENV_PIP),
                    &args,
                    messages.install_whisper,
                    messages,
                )
                .map_err(Failure::Failed)?;
            Ok(((), None))
        })?;

        Ok(python)
    }

    pub fn apply_transcription(
        &mut self,
        app_dir: &Path,
        model: Option<&'static str>,
    ) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let system = self.machine.system;
        let hf_cache = self.machine.hf_cache;
        let saved = model.map_or(Value::Null, |model| {
            let mut chosen = Map::new();
            chosen.insert("model".to_owned(), Value::String(model.to_owned()));
            Value::Object(chosen)
        });

        self.update_config(app_dir, "transcription", saved)?;

        let Some(model) = model else {
            let line = success(messages.transcription_disabled, self.colorize());
            return self.say_last(&line);
        };
        let existing = whisper_python(app_dir);
        let reuse = whisper_python_works(&existing);

        if reuse && model_installed(hf_cache, model) {
            let line = success(&(messages.transcription_switched)(model), self.colorize());
            return self.say_last(&line);
        }

        if !reuse && !system.has_command("uv") && !system.has_command("python3") {
            self.ensure_requirements(&[Tool::Uv])?;
        }

        self.journal.track_dir(&join_path(app_dir, WHISPER_FOLDER));

        let python = if reuse {
            existing
        } else {
            self.create_whisper_env(&join_path(app_dir, VENV_FOLDER))?
        };

        self.journal.track_dir(&model_dir(hf_cache, model));

        self.while_pending(&(messages.downloading_model)(model), |this| {
            system
                .run_script_or_fail(
                    &python,
                    TRANSCRIBE_SOURCE,
                    &["--download-only", "--model", model],
                    messages.model_download,
                    messages,
                )
                .map_err(Failure::Failed)?;
            Ok((
                (),
                Some(success(
                    &(messages.transcription_ready)(model),
                    this.colorize(),
                )),
            ))
        })?;

        self.ready_to_wait()
    }

    pub fn remove_transcription(&mut self, app_dir: &Path) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let hf_cache = self.machine.hf_cache;
        let paths: Vec<PathBuf> = [join_path(app_dir, WHISPER_FOLDER)]
            .into_iter()
            .chain(
                TRANSCRIPTION_MODELS
                    .iter()
                    .map(|model| model_dir(hf_cache, model)),
            )
            .filter(|path| path.exists())
            .collect();

        if paths.is_empty() {
            return Ok(());
        }

        let shown: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        self.say(&(messages.transcription_found)(&shown.join(LIST_SEPARATOR)));

        if !self.ask(|asker| asker.yes_no(messages.delete_transcription_prompt, false))? {
            return self.say_last(messages.transcription_kept);
        }

        self.while_pending(messages.transcription_removing, |this| {
            for path in &paths {
                remove_path(path).map_err(|failure| this.file_failure(&failure))?;
            }

            Ok((
                (),
                Some(success(messages.transcription_removed, this.colorize())),
            ))
        })?;

        self.ready_to_wait()
    }

    pub fn remove_mermaid(&mut self) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let system = self.machine.system;

        if !system.has_command("mmdc")
            || !self.ask(|asker| asker.yes_no(messages.delete_mermaid_prompt, false))?
        {
            return Ok(());
        }

        self.while_pending(messages.mermaid_removing, |this| {
            let colorize = this.colorize();
            let line = if system.quiet("sh", &["-c", MERMAID_UNINSTALL_COMMAND]) == Some(0) {
                success(messages.mermaid_removed, colorize)
            } else {
                warn(
                    &(messages.mermaid_not_removed)(MERMAID_UNINSTALL_COMMAND),
                    colorize,
                )
            };

            Ok(((), Some(line)))
        })?;

        self.ready_to_wait()
    }

    pub fn ensure_inbox(&mut self, app_dir: &Path) -> Result<(), Failure<E>> {
        let current = current_inbox_days(app_dir);
        let saved = read_config(app_dir).contains_key("inboxRetentionDays");
        let days = self.ask(|asker| asker.inbox(current, saved))?;

        if self.kept_setting(Kept::Inbox(days), app_dir)? {
            return Ok(());
        }

        self.save_inbox_days(app_dir, days)
    }

    pub fn ensure_visuals(&mut self, app_dir: &Path) -> Result<(), Failure<E>> {
        let config = read_config(app_dir);
        let current = read_visuals(&config);
        let saved = config.contains_key(VISUALS_KEY);
        let review_saved = config.contains_key(VISUAL_REVIEW_KEY);
        let pick = self.ask(|asker| asker.visuals(current, saved, review_saved))?;

        self.save_visuals(app_dir, pick)
    }

    pub fn save_visuals(&mut self, app_dir: &Path, pick: VisualsPick) -> Result<(), Failure<E>> {
        if self.kept_setting(Kept::Visuals(pick), app_dir)? {
            return Ok(());
        }

        let messages = self.messages;
        let mut patch = Map::from_iter([(VISUALS_KEY.to_owned(), json!(pick.mode.key()))]);

        if let Some(review) = pick.review {
            patch.insert(VISUAL_REVIEW_KEY.to_owned(), Value::Bool(review));
        }

        let config_file = self.update_config_keys(app_dir, patch)?;
        let line = success(
            &(messages.visuals_saved)(
                &visuals_text(messages, pick.mode, pick.review),
                &config_file.to_string_lossy(),
            ),
            self.colorize(),
        );

        self.say_last(&line)?;
        self.warn_missing_visual_tools(pick.mode)
    }

    pub fn save_visual_review(&mut self, app_dir: &Path, review: bool) -> Result<(), Failure<E>> {
        if self.kept_setting(Kept::VisualReview(review), app_dir)? {
            return Ok(());
        }

        let messages = self.messages;
        let config_file = self.update_config(app_dir, VISUAL_REVIEW_KEY, Value::Bool(review))?;
        let line = success(
            &(messages.visual_review_saved)(
                review_name(messages, review),
                &config_file.to_string_lossy(),
            ),
            self.colorize(),
        );

        self.say_last(&line)
    }

    fn warn_missing_visual_tools(&mut self, mode: VisualMode) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let colorize = self.colorize();

        if mode != VisualMode::Off && (self.machine.chromium)().is_none() {
            self.say(&warn(messages.chromium_missing_warning, colorize));
        }

        if mode == VisualMode::Video && !self.machine.system.has_command("ffmpeg") {
            self.say(&warn(messages.ffmpeg_missing_warning, colorize));
        }

        self.ready_to_wait()
    }

    pub fn save_inbox_days(&mut self, app_dir: &Path, days: Option<f64>) -> Result<(), Failure<E>> {
        let messages = self.messages;
        let config_file = self.update_config(
            app_dir,
            "inboxRetentionDays",
            days.map_or(Value::Null, number_value),
        )?;
        let line = success(
            &(messages.inbox_saved)(&days_text(messages, days), &config_file.to_string_lossy()),
            self.colorize(),
        );

        self.say_last(&line)
    }
}

#[cfg(unix)]
#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::Write;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;
    use crate::messages::EN_US;

    const STOP: &str = "stop";

    #[test]
    fn a_stable_binary_follows_the_stable_branch_and_a_test_version_stays_on_its_tag() {
        assert_eq!(
            marketplace_source("0.1.0"),
            "pedromondek/better-claude-code-telegram#stable"
        );
        assert_eq!(
            marketplace_source("1.12.3"),
            "pedromondek/better-claude-code-telegram#stable"
        );

        for version in ["0.0.1-alpha.1", "0.2.0-beta.3", "0.2.0-rc.1"] {
            assert_eq!(
                marketplace_source(version),
                format!("pedromondek/better-claude-code-telegram#v{version}")
            );
        }
    }

    #[test]
    fn the_transcription_script_is_the_one_of_the_plugin() {
        assert_eq!(
            TRANSCRIBE_SOURCE,
            std::fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../plugins/telegram/extensions/transcribe.py")
            )
            .unwrap()
        );
        assert!(TRANSCRIBE_SOURCE.contains("--download-only"));
    }

    type StepWork<'a> =
        dyn FnOnce(&mut Install<'_, '_, String>) -> Result<(), Failure<String>> + 'a;

    fn remove_plugins(install: &mut Install<'_, '_, String>) -> Result<(), Failure<String>> {
        install.remove_plugins()
    }

    fn remove_mermaid(install: &mut Install<'_, '_, String>) -> Result<(), Failure<String>> {
        install.remove_mermaid()
    }

    struct Scripted {
        yes: VecDeque<Result<bool, String>>,
        commands: Result<CommandsChoice, String>,
        transcription: Result<TranscriptionChoice, String>,
        remove: Result<Vec<&'static str>, String>,
        inbox: Result<Option<f64>, String>,
        visuals: Result<VisualsPick, String>,
        visuals_asked: Vec<(Visuals, bool, bool)>,
    }

    impl Default for Scripted {
        fn default() -> Self {
            Self {
                yes: VecDeque::new(),
                commands: Err(STOP.to_owned()),
                transcription: Err(STOP.to_owned()),
                remove: Err(STOP.to_owned()),
                inbox: Err(STOP.to_owned()),
                visuals: Err(STOP.to_owned()),
                visuals_asked: Vec::new(),
            }
        }
    }

    impl Asker for Scripted {
        type Error = String;

        fn yes_no(&mut self, _prompt: &str, _default_yes: bool) -> Result<bool, String> {
            self.yes.pop_front().unwrap_or_else(|| Err(STOP.to_owned()))
        }

        fn installed_commands(&mut self) -> Result<CommandsChoice, String> {
            self.commands.clone()
        }

        fn transcription(
            &mut self,
            _current: Option<&'static str>,
            _saved: bool,
            _installed: &[&'static str],
        ) -> Result<TranscriptionChoice, String> {
            self.transcription.clone()
        }

        fn remove_models(
            &mut self,
            _others: &[&'static str],
            _previous: Option<&'static str>,
            _tag: &str,
        ) -> Result<Vec<&'static str>, String> {
            self.remove.clone()
        }

        fn inbox(&mut self, _current: Option<f64>, _saved: bool) -> Result<Option<f64>, String> {
            self.inbox.clone()
        }

        fn visuals(
            &mut self,
            current: Visuals,
            saved: bool,
            review_saved: bool,
        ) -> Result<VisualsPick, String> {
            self.visuals_asked.push((current, saved, review_saved));
            self.visuals.clone()
        }
    }

    #[derive(Default)]
    struct Recorded {
        records: Vec<(ChangeKind, String, Option<ClaudeUndo>)>,
        unreadable: bool,
    }

    impl Journal for Recorded {
        fn record(&mut self, kind: ChangeKind, target: String, undo: Option<ClaudeUndo>) {
            self.records.push((kind, target, undo));
        }

        fn track_dir(&mut self, _dir: &Path) {}

        fn track_file(&mut self, _file: &Path) -> io::Result<()> {
            if self.unreadable {
                Err(io::ErrorKind::PermissionDenied.into())
            } else {
                Ok(())
            }
        }
    }

    struct Failing {
        needle: &'static str,
        written: Vec<u8>,
    }

    impl Failing {
        fn on(needle: &'static str) -> Self {
            Self {
                needle,
                written: Vec::new(),
            }
        }
    }

    impl Write for Failing {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if String::from_utf8_lossy(buf).contains(self.needle) {
                return Err(io::ErrorKind::BrokenPipe.into());
            }

            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct World {
        root: tempfile::TempDir,
        system: System,
        terminal: Option<crate::spinner::Terminal>,
        installer: Option<String>,
        chromium: Option<PathBuf>,
    }

    impl World {
        fn new(scripts: &[(&str, &str)]) -> Self {
            let root = tempfile::tempdir().unwrap();
            let bin = root.path().join("bin");
            let sys = root.path().join("sys");
            fs::create_dir_all(&bin).unwrap();
            fs::create_dir_all(&sys).unwrap();
            symlink("/bin/sh", sys.join("sh")).unwrap();

            for (name, body) in scripts {
                let file = bin.join(name);
                fs::write(&file, format!("#!/bin/sh\nPATH=/usr/bin:/bin\n{body}\n")).unwrap();
                fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
            }

            let mut path = bin.into_os_string();
            path.push(":");
            path.push(sys);
            let system = System::new(vec![(OsString::from(PATH_VARIABLE), path)]);

            Self {
                root,
                system,
                terminal: None,
                installer: None,
                chromium: None,
            }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.path().join(name)
        }

        fn logging_claude(root: &Path) -> String {
            format!("echo \"$*\" >> {}/calls\nexit 0", root.display())
        }

        fn run<R>(
            &self,
            asker: &mut Scripted,
            journal: &mut Recorded,
            out: &mut dyn Write,
            work: impl FnOnce(&mut Install<'_, '_, String>) -> R,
        ) -> R {
            let home = self.path("home");
            let hub = self.path("hub");
            let settings = self.path("settings.json");
            let app_dir = self.path("app");
            let installer = |system: &System, command: &str| {
                system.run_installer(self.installer.as_deref().unwrap_or(command))
            };
            let machine = Machine {
                home: &home,
                app_dir: &app_dir,
                marketplace: MARKETPLACE_REPO,
                hf_cache: &hub,
                settings_file: &settings,
                shell: Some("bash"),
                macos: false,
                system: &self.system,
                run_installer: &installer,
                chromium: &|| self.chromium.clone(),
            };
            let mut err = Vec::new();
            let mut screen = Screen {
                out,
                err: &mut err,
                terminal: self.terminal,
                colorize_out: false,
                colorize_err: false,
                spin: &|_, _| None,
            };
            let mut install = Install::new(&machine, &mut screen, journal, asker, &EN_US);

            work(&mut install)
        }
    }

    fn installed_plugins() -> String {
        format!(
            "case \"$*\" in \"plugin list\") printf '%s\\n' {} ;; \"plugin marketplace list\") echo {MARKETPLACE_NAME} ;; esac\nexit 0",
            PLUGIN_IDS.join(" ")
        )
    }

    #[test]
    fn an_undo_runs_claude_again_and_reports_what_it_said() {
        let world = World::new(&[(
            "claude",
            "[ \"$*\" = \"plugin install x\" ] && exit 0\necho nope\nexit 1",
        )]);
        let undo = ClaudeUndo::of(&["plugin", "install", "x"]);
        let other = ClaudeUndo::of(&["plugin", "install", "y"]);

        assert_eq!(undo.run(&world.system, &EN_US), Ok(()));
        assert_eq!(
            other.run(&world.system, &EN_US),
            Err(format!(
                "{}\nnope",
                (EN_US.failed)("claude plugin install y")
            ))
        );
    }

    #[test]
    fn the_process_system_starts_from_the_process_path_and_prepends_to_it() {
        assert_eq!(
            System::from_process().path(),
            std::env::var_os(PATH_VARIABLE)
        );

        let empty = System::new(Vec::new());
        assert_eq!(empty.path(), None);
        empty.prepend_path(Path::new("/b"));
        assert_eq!(
            empty.path(),
            Some(OsString::from(format!("/b{PATH_SEPARATOR}")))
        );
        empty.prepend_path(Path::new("/a"));
        assert_eq!(
            empty.path(),
            Some(OsString::from(format!(
                "/a{PATH_SEPARATOR}/b{PATH_SEPARATOR}"
            )))
        );
    }

    fn searching_system(folder: &Path) -> System {
        System::new(vec![
            (OsString::from(PATH_VARIABLE), folder.as_os_str().to_owned()),
            (
                OsString::from(PATH_EXTENSIONS_VARIABLE),
                OsString::from(".sh"),
            ),
        ])
        .with_program_lookup(ProgramLookup::PathSearch)
    }

    #[test]
    fn finds_and_runs_a_program_through_path_and_pathext_when_searching() {
        let folder = tempfile::tempdir().unwrap();
        let tool = folder.path().join("tool.sh");
        fs::write(&tool, "").unwrap();
        let system = searching_system(folder.path());

        assert!(system.has_command("tool"));
        assert!(!system.has_command("missing"));
        assert_eq!(system.command("tool").get_program(), tool.as_os_str());
        assert_eq!(system.command("missing").get_program(), "missing");
    }

    #[test]
    fn searches_nothing_without_a_path() {
        let system = System::new(Vec::new()).with_program_lookup(ProgramLookup::PathSearch);

        assert!(!system.has_command("sh"));
        assert_eq!(system.command("sh").get_program(), "sh");
    }

    #[test]
    fn finds_programs_through_the_shell_by_default_on_unix() {
        let folder = tempfile::tempdir().unwrap();
        let system = searching_system(folder.path());
        let shell = System::new(vec![(
            OsString::from(PATH_VARIABLE),
            std::env::var_os(PATH_VARIABLE).unwrap_or_default(),
        )]);

        assert!(!system.has_command("sh"));
        assert_eq!(shell.has_command("sh"), cfg!(unix));
    }

    #[test]
    fn the_script_reaches_the_interpreter_through_its_input_with_the_arguments() {
        let world = World::new(&[(
            "python",
            "[ \"$1\" = - ] || exit 9\nshift\nexec /bin/sh -s -- \"$@\"",
        )]);
        let out = world.root.path().join("out");
        let script = format!("printf '%s|%s' \"$1\" \"$2\" > '{}'", out.display());

        assert_eq!(
            world
                .system
                .run_script_or_fail("python", &script, &["a b", "c"], "describe", &EN_US),
            Ok(())
        );
        assert_eq!(fs::read_to_string(&out).unwrap(), "a b|c");
        assert_eq!(
            world.system.run_script_or_fail(
                "python",
                "echo said; echo also >&2; exit 3",
                &[],
                "describe",
                &EN_US
            ),
            Err(format!("{}\nsaid\nalso", (EN_US.failed)("describe")))
        );
        assert_eq!(
            world
                .system
                .run_script_or_fail("/nonexistent/x", "", &[], "describe", &EN_US),
            Err((EN_US.failed)("describe"))
        );
    }

    #[test]
    fn a_program_that_cannot_start_fails_with_only_the_description() {
        let world = World::new(&[]);

        assert_eq!(
            world
                .system
                .run_or_fail("/nonexistent/x", &[], "describe", &EN_US),
            Err((EN_US.failed)("describe"))
        );
        assert_eq!(world.system.quiet("/nonexistent/x", &[]), None);
        assert_eq!(world.system.claude_output(&["plugin", "list"]), "");
    }

    #[test]
    fn the_installer_runs_in_a_shell_and_returns_its_exit_code() {
        let world = World::new(&[]);

        assert_eq!(world.system.run_installer("exit 3"), Some(3));
        assert_eq!(world.system.run_installer("exit 0"), Some(0));
        assert_eq!(world.system.run_installer("kill -9 $$"), None);
        assert_eq!(System::new(Vec::new()).run_installer("exit 4"), Some(4));
    }

    #[test]
    fn the_machine_and_the_install_describe_themselves() {
        let world = World::new(&[]);
        let mut out = Vec::new();
        let text = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| format!("{install:?}"),
        );

        assert!(
            text.starts_with("Install { machine: Machine { home: "),
            "{text}"
        );
        assert!(text.contains("macos: false, system: System"), "{text}");
        assert!(text.ends_with(", refused: false, .. }"), "{text}");
    }

    #[test]
    fn removing_reports_what_could_not_be_removed() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("file");
        fs::write(&file, "x").unwrap();

        assert_eq!(remove_path(&folder.path().join("missing")), Ok(()));
        assert_eq!(remove_path(&file.join("child")), Ok(()));
        assert!(file.exists());

        let too_long = folder.path().join("x".repeat(300));

        assert_eq!(
            remove_path(&too_long),
            Err(FileFailure::NotRemoved(too_long))
        );

        let locked = folder.path().join("locked");
        fs::create_dir_all(locked.join("inside")).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        let denied = remove_path(&locked.join("inside"));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(denied, Err(FileFailure::NotRemoved(locked.join("inside"))));
        assert_eq!(remove_path(&file), Ok(()));
        assert!(!file.exists());
    }

    #[test]
    fn a_config_that_cannot_be_saved_stops_with_the_file() {
        let world = World::new(&[]);
        let blocked = world.path("blocked");
        fs::write(&blocked, "x").unwrap();
        let folder = world.path("folder");
        fs::create_dir_all(folder.join(CONFIG_FILE)).unwrap();
        let mut out = Vec::new();

        let not_a_folder = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.save_inbox_days(&blocked, Some(3.0)),
        );
        let not_a_file = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.save_inbox_days(&folder, None),
        );

        assert_eq!(
            not_a_folder,
            Err(Failure::Failed((EN_US.file_not_saved)(
                &blocked.join(CONFIG_FILE).to_string_lossy()
            )))
        );
        assert_eq!(
            not_a_file,
            Err(Failure::Failed((EN_US.file_not_saved)(
                &folder.join(CONFIG_FILE).to_string_lossy()
            )))
        );
        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn a_model_that_cannot_be_removed_stops_the_uninstall() {
        let world = World::new(&[]);
        let hub = world.path("hub");
        let model = model_dir(&hub, "base");
        fs::create_dir_all(model.join("inside")).unwrap();
        fs::set_permissions(&model, fs::Permissions::from_mode(0o500)).unwrap();
        let mut asker = Scripted {
            transcription: Ok(TranscriptionChoice::Uninstall(vec!["base"])),
            ..Scripted::default()
        };
        let mut out = Vec::new();

        let result = world.run(&mut asker, &mut Recorded::default(), &mut out, |install| {
            install.ensure_transcription(&world.path("app"))
        });
        fs::set_permissions(&model, fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(
            result,
            Err(Failure::Failed((EN_US.file_not_removed)(
                &model.to_string_lossy()
            ))),
        );
    }

    fn locked_whisper(world: &World) -> PathBuf {
        let whisper = world.path("app/whisper");
        fs::create_dir_all(whisper.join("venv")).unwrap();
        fs::set_permissions(&whisper, fs::Permissions::from_mode(0o500)).unwrap();
        whisper
    }

    #[test]
    fn a_python_environment_that_cannot_be_removed_stops_the_removal() {
        let world = World::new(&[]);
        let whisper = locked_whisper(&world);
        fs::create_dir_all(model_dir(&world.path("hub"), "base")).unwrap();
        let mut out = Vec::new();
        let mut uninstall = Scripted {
            transcription: Ok(TranscriptionChoice::Uninstall(vec!["base"])),
            ..Scripted::default()
        };
        let mut confirm = Scripted {
            yes: VecDeque::from([Ok(true)]),
            ..Scripted::default()
        };

        let models = world.run(
            &mut uninstall,
            &mut Recorded::default(),
            &mut out,
            |install| install.ensure_transcription(&world.path("app")),
        );
        let everything = world.run(
            &mut confirm,
            &mut Recorded::default(),
            &mut out,
            |install| install.remove_transcription(&world.path("app")),
        );
        fs::set_permissions(&whisper, fs::Permissions::from_mode(0o700)).unwrap();
        let not_removed = Err(Failure::Failed((EN_US.file_not_removed)(
            &whisper.to_string_lossy(),
        )));

        assert_eq!(models, not_removed);
        assert_eq!(everything, not_removed);
        assert!(!model_dir(&world.path("hub"), "base").exists());
    }

    #[test]
    fn a_config_folder_in_the_way_stops_the_transcription() {
        let world = World::new(&[]);
        let app = world.path("app");
        fs::create_dir_all(app.join(CONFIG_FILE)).unwrap();
        fs::create_dir_all(model_dir(&world.path("hub"), "base")).unwrap();
        let not_saved = Err(Failure::Failed((EN_US.file_not_saved)(
            &app.join(CONFIG_FILE).to_string_lossy(),
        )));
        let mut out = Vec::new();
        let mut uninstall = Scripted {
            transcription: Ok(TranscriptionChoice::Uninstall(vec!["base"])),
            ..Scripted::default()
        };

        let models = world.run(
            &mut uninstall,
            &mut Recorded::default(),
            &mut out,
            |install| install.ensure_transcription(&app),
        );

        assert_eq!(models, not_saved);
        assert_eq!(
            world.run(
                &mut Scripted::default(),
                &mut Recorded::default(),
                &mut out,
                |install| install.apply_transcription(&app, Some("small"))
            ),
            not_saved
        );
    }

    #[test]
    fn the_remaining_lines_that_cannot_be_shown_stop_the_step() {
        let claude = [("claude", "exit 0")];

        assert_eq!(
            screen_failure("", &claude, &mut Scripted::default(), |install, _| {
                install.remove_plugins()
            }),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure(
                "already enabled",
                &claude,
                &mut Scripted::default(),
                |install, world| {
                    fs::write(
                        world.path("settings.json"),
                        format!("{{\"enabledPlugins\":{{\"{HOOKS_PLUGIN_ID}\":true}}}}"),
                    )
                    .unwrap();
                    install.ensure_plugins(&PluginChoice {
                        marketplaces: MARKETPLACE_NAME.to_owned(),
                        plugins: PLUGIN_IDS.join("\n"),
                        plugin_ids: PLUGIN_IDS.to_vec(),
                        removed_ids: Vec::new(),
                    })
                }
            ),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure(
                "Transcription off",
                &[],
                &mut Scripted {
                    transcription: Ok(TranscriptionChoice::Uninstall(vec!["medium"])),
                    ..Scripted::default()
                },
                |install, world| {
                    fs::create_dir_all(model_dir(&world.path("hub"), "medium")).unwrap();
                    install.ensure_transcription(&world.path("app"))
                }
            ),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure(
                "Received files kept",
                &[],
                &mut Scripted {
                    inbox: Ok(Some(3.0)),
                    ..Scripted::default()
                },
                |install, world| {
                    fs::create_dir_all(world.path("app")).unwrap();
                    fs::write(
                        world.path("app").join(CONFIG_FILE),
                        "{\"inboxRetentionDays\":3}",
                    )
                    .unwrap();
                    install.ensure_inbox(&world.path("app"))
                }
            ),
            Err(Failure::Screen)
        );

        let mut out = Vec::new();
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(true)]),
            ..Scripted::default()
        };
        let without_commands = format!(
            "case \"$*\" in \"plugin list\") printf '%s\\n' {CHANNEL_PLUGIN_ID} {HOOKS_PLUGIN_ID} ;; esac"
        );
        let world_without = World::new(&[("claude", &without_commands)]);

        assert_eq!(
            world_without.run(&mut asker, &mut Recorded::default(), &mut out, |install| {
                install.confirm_plugin_step()
            }),
            Err(Failure::Asking(STOP.to_owned()))
        );
    }

    #[test]
    fn a_spinner_that_cannot_be_shown_stops_the_check_and_an_empty_removal_says_nothing() {
        let mut world = World::new(&[("claude", "exit 0"), ("python", "exit 0")]);
        world.terminal = Some(crate::spinner::Terminal { columns: None });
        let mut out = Failing::on("Checking");

        assert_eq!(
            world.run(
                &mut Scripted::default(),
                &mut Recorded::default(),
                &mut out,
                remove_plugins
            ),
            Err(Failure::Screen)
        );

        world.terminal = None;
        let app = world.path("app");
        fs::create_dir_all(app.join("whisper/venv/bin")).unwrap();
        fs::copy(
            world.path("bin/python"),
            app.join("whisper/venv/bin/python"),
        )
        .unwrap();
        fs::create_dir_all(model_dir(&world.path("hub"), "base")).unwrap();
        fs::create_dir_all(model_dir(&world.path("hub"), "small")).unwrap();
        let mut asker = Scripted {
            transcription: Ok(TranscriptionChoice::Model("small")),
            remove: Ok(Vec::new()),
            ..Scripted::default()
        };
        let mut shown = Vec::new();

        let switched = world.run(
            &mut asker,
            &mut Recorded::default(),
            &mut shown,
            |install| install.ensure_transcription(&app),
        );

        assert_eq!(switched, Ok(()));
        assert!(
            String::from_utf8(shown)
                .unwrap()
                .ends_with(&format!("{}\n", (EN_US.transcription_switched)("small")))
        );
        assert!(model_dir(&world.path("hub"), "base").exists());
    }

    #[test]
    fn a_failing_installer_stops_the_requirements() {
        let world = World::new(&[]);
        let mut out = Vec::new();
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(true)]),
            ..Scripted::default()
        };

        let result = world.run(&mut asker, &mut Recorded::default(), &mut out, |install| {
            install.ensure_requirements(&[Tool::Bun])
        });

        assert_eq!(result, Err(Failure::Failed((EN_US.install_failed)("bun"))));
        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn every_question_can_stop_the_step() {
        let world = World::new(&[("claude", "exit 0"), ("mmdc", "exit 0")]);
        let app = world.path("app");
        let hub = world.path("hub");
        fs::create_dir_all(app.join("whisper/venv/bin")).unwrap();
        fs::write(app.join("whisper/venv/bin/python"), "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(
            app.join("whisper/venv/bin/python"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::create_dir_all(model_dir(&hub, "base")).unwrap();
        fs::create_dir_all(model_dir(&hub, "small")).unwrap();
        let choosing = |transcription| Scripted {
            transcription: Ok(transcription),
            ..Scripted::default()
        };
        let steps: Vec<(Scripted, Box<StepWork<'_>>)> = vec![
            (
                Scripted::default(),
                Box::new(|install| install.ensure_requirements(&[Tool::Bun])),
            ),
            (
                Scripted::default(),
                Box::new(|install| install.confirm_plugin_step().map(|_| ())),
            ),
            (
                Scripted::default(),
                Box::new(|install| install.ensure_transcription(&app)),
            ),
            (
                choosing(TranscriptionChoice::Model("small")),
                Box::new(|install| install.ensure_transcription(&app)),
            ),
            (
                Scripted::default(),
                Box::new(|install| install.remove_transcription(&app)),
            ),
            (Scripted::default(), Box::new(remove_mermaid)),
            (
                Scripted::default(),
                Box::new(|install| install.ensure_inbox(&app)),
            ),
        ];

        for (index, (mut asker, step)) in steps.into_iter().enumerate() {
            let mut out = Vec::new();
            let result = world.run(&mut asker, &mut Recorded::default(), &mut out, step);

            assert_eq!(result, Err(Failure::Asking(STOP.to_owned())), "{index}");
        }
    }

    #[test]
    fn the_commands_question_and_the_plan_question_can_stop_the_plugin_step() {
        let world = World::new(&[("claude", &installed_plugins())]);
        let mut out = Vec::new();
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(true)]),
            ..Scripted::default()
        };

        let result = world.run(&mut asker, &mut Recorded::default(), &mut out, |install| {
            install.confirm_plugin_step()
        });

        assert_eq!(result, Err(Failure::Asking(STOP.to_owned())));
    }

    fn screen_failure(
        needle: &'static str,
        scripts: &[(&str, &str)],
        asker: &mut Scripted,
        work: impl FnOnce(&mut Install<'_, '_, String>, &World) -> Result<(), Failure<String>>,
    ) -> Result<(), Failure<String>> {
        let world = World::new(scripts);
        let mut out = Failing::on(needle);

        world.run(asker, &mut Recorded::default(), &mut out, |install| {
            work(install, &world)
        })
    }

    #[test]
    fn a_screen_that_cannot_show_a_line_stops_the_step() {
        let installed = installed_plugins();
        let everything = PluginChoice {
            marketplaces: MARKETPLACE_NAME.to_owned(),
            plugins: PLUGIN_IDS.join("\n"),
            plugin_ids: PLUGIN_IDS.to_vec(),
            removed_ids: Vec::new(),
        };
        let fresh = PluginChoice {
            marketplaces: String::new(),
            plugins: String::new(),
            plugin_ids: PLUGIN_IDS.to_vec(),
            removed_ids: vec![BCCT_PLUGIN_ID],
        };
        let claude = [("claude", "exit 0")];

        for needle in [
            "already registered",
            "already installed",
            "outside",
            "every instance",
        ] {
            assert_eq!(
                screen_failure(needle, &claude, &mut Scripted::default(), |install, _| {
                    install.ensure_plugins(&everything)
                }),
                Err(Failure::Screen),
                "{needle}"
            );
        }

        assert_eq!(
            screen_failure(
                "already disabled",
                &claude,
                &mut Scripted::default(),
                |install, world| {
                    fs::write(
                        world.path("settings.json"),
                        format!("{{\"enabledPlugins\":{{\"{CHANNEL_PLUGIN_ID}\":false}}}}"),
                    )
                    .unwrap();
                    install.ensure_plugins(&everything)
                }
            ),
            Err(Failure::Screen)
        );

        for needle in ["removed.", "registered.", "installed for", "enabled in"] {
            assert_eq!(
                screen_failure(needle, &claude, &mut Scripted::default(), |install, _| {
                    install.ensure_plugins(&fresh)
                }),
                Err(Failure::Screen),
                "{needle}"
            );
        }

        for needle in ["removed.", "Marketplace"] {
            assert_eq!(
                screen_failure(
                    needle,
                    &[("claude", &installed)],
                    &mut Scripted::default(),
                    |install, _| install.remove_plugins()
                ),
                Err(Failure::Screen),
                "{needle}"
            );
        }

        for needle in ["was not installed", "not registered"] {
            assert_eq!(
                screen_failure(needle, &claude, &mut Scripted::default(), |install, _| {
                    install.remove_plugins()
                }),
                Err(Failure::Screen),
                "{needle}"
            );
        }

        let without_claude = screen_failure(
            "remove the plugins",
            &[],
            &mut Scripted::default(),
            |install, _| install.remove_plugins(),
        );

        assert_eq!(without_claude, Err(Failure::Screen));
        assert_eq!(
            screen_failure(
                "Checked",
                &claude,
                &mut Scripted::default(),
                |install, _| install.confirm_plugin_step().map(|_| ())
            ),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure(
                "To finish",
                &claude,
                &mut Scripted::default(),
                |install, _| install.confirm_plugin_step().map(|_| ())
            ),
            Err(Failure::Screen)
        );
    }

    #[test]
    fn a_screen_that_cannot_show_the_transcription_lines_stops_the_step() {
        let python = ("python", "exit 0");
        let mut asker = Scripted {
            transcription: Ok(TranscriptionChoice::Model("small")),
            remove: Ok(vec!["base"]),
            inbox: Ok(Some(3.0)),
            yes: VecDeque::from([Ok(true), Ok(true)]),
            ..Scripted::default()
        };
        let prepared = |world: &World| {
            let app = world.path("app");
            let hub = world.path("hub");
            fs::create_dir_all(app.join("whisper/venv/bin")).unwrap();
            fs::copy(
                world.path("bin/python"),
                app.join("whisper/venv/bin/python"),
            )
            .unwrap();
            fs::create_dir_all(model_dir(&hub, "base")).unwrap();
            fs::create_dir_all(model_dir(&hub, "small")).unwrap();
            app
        };

        for needle in [
            "Turns the voice",
            "on with the",
            "Transcription models removed",
        ] {
            assert_eq!(
                screen_failure(needle, &[python], &mut asker, |install, world| {
                    install.ensure_transcription(&prepared(world))
                }),
                Err(Failure::Screen),
                "{needle}"
            );
        }

        assert_eq!(
            screen_failure("kept with the", &[python], &mut asker, |install, world| {
                let app = prepared(world);
                fs::write(
                    app.join(CONFIG_FILE),
                    "{\"transcription\":{\"model\":\"small\"}}",
                )
                .unwrap();
                install.ensure_transcription(&app)
            }),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure("Received files", &[], &mut asker, |install, world| {
                install.ensure_inbox(&world.path("app"))
            }),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure("off", &[], &mut asker, |install, world| {
                install.apply_transcription(&world.path("app"), None)
            }),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure(
                "Local transcription installed",
                &[],
                &mut asker,
                |install, world| {
                    fs::create_dir_all(world.path("app/whisper")).unwrap();
                    install.remove_transcription(&world.path("app"))
                }
            ),
            Err(Failure::Screen)
        );
        let mut keeping = Scripted {
            yes: VecDeque::from([Ok(false)]),
            ..Scripted::default()
        };
        let kept = screen_failure("kept", &[], &mut keeping, |install, world| {
            fs::create_dir_all(world.path("app/whisper")).unwrap();
            install.remove_transcription(&world.path("app"))
        });

        assert_eq!(kept, Err(Failure::Screen));
    }

    fn installing(world: &mut World, tools: &[Tool]) {
        let commands: Vec<String> = tools
            .iter()
            .map(|tool| {
                let target = installer_for(*tool, &world.path("home")).bin_dir;
                let name = tool.as_str();

                format!(
                    "mkdir -p {0}; printf '#!/bin/sh\\n' > {0}/{name}; chmod 755 {0}/{name}",
                    target.display()
                )
            })
            .collect();

        world.installer = Some(format!("PATH=/usr/bin:/bin; {}", commands.join("; ")));
    }

    #[test]
    fn a_tool_installed_by_the_installer_is_shown_and_journaled() {
        let mut world = World::new(&[]);
        installing(&mut world, &[Tool::Bun]);
        let mut out = Failing::on("installed in");
        let mut journal = Recorded::default();
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(true)]),
            ..Scripted::default()
        };

        let result = world.run(&mut asker, &mut journal, &mut out, |install| {
            install.ensure_requirements(&[Tool::Bun])
        });

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(journal.records.len(), 1);
    }

    #[test]
    fn a_refused_line_stops_at_the_next_question_and_not_before_the_install_ends() {
        let mut world = World::new(&[]);
        installing(&mut world, &[Tool::Bun, Tool::Uv]);
        let mut out = Failing::on("installed in");
        let mut journal = Recorded::default();
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(true), Ok(true)]),
            ..Scripted::default()
        };

        let result = world.run(&mut asker, &mut journal, &mut out, |install| {
            install.ensure_requirements(&[Tool::Bun, Tool::Uv])
        });

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(asker.yes.len(), 1);
        assert_eq!(journal.records.len(), 1);
    }

    #[test]
    fn a_refused_line_wins_over_the_tools_that_were_declined() {
        let mut world = World::new(&[]);
        installing(&mut world, &[Tool::Uv]);
        let mut out = Failing::on("installed in");
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(false), Ok(true)]),
            ..Scripted::default()
        };

        let result = world.run(&mut asker, &mut Recorded::default(), &mut out, |install| {
            install.ensure_requirements(&[Tool::Bun, Tool::Uv])
        });

        assert_eq!(result, Err(Failure::Screen));
    }

    #[test]
    fn a_refused_line_keeps_the_next_process_from_starting() {
        let root = tempfile::tempdir().unwrap();
        let world = World::new(&[("claude", &World::logging_claude(root.path()))]);
        let calls = || fs::read_to_string(root.path().join("calls")).unwrap_or_default();
        let everything = PluginChoice {
            marketplaces: MARKETPLACE_NAME.to_owned(),
            plugins: PLUGIN_IDS.join("\n"),
            plugin_ids: PLUGIN_IDS.to_vec(),
            removed_ids: Vec::new(),
        };
        let mut out = Failing::on("already registered");

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.ensure_plugins(&everything),
        );

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(calls(), "");

        let mut shown = Vec::new();
        let finished = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut shown,
            |install| install.ensure_plugins(&everything),
        );

        let made = calls();

        assert_eq!(finished, Ok(()));
        assert!(made.contains("plugin disable"), "{made}");
    }

    #[test]
    fn a_refused_line_keeps_the_marketplace_from_being_removed() {
        let root = tempfile::tempdir().unwrap();
        let script = format!(
            "{}\n",
            World::logging_claude(root.path()).replace(
                "exit 0",
                &format!(
                    "[ \"$*\" = \"plugin marketplace list\" ] && echo {MARKETPLACE_NAME}\nexit 0"
                )
            )
        );
        let world = World::new(&[("claude", &script)]);
        let mut out = Failing::on("was not installed");

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            remove_plugins,
        );
        let calls = fs::read_to_string(root.path().join("calls")).unwrap();

        assert_eq!(result, Err(Failure::Screen));
        assert!(!calls.contains("marketplace remove"), "{calls}");
    }

    #[test]
    fn a_spinner_that_cannot_be_shown_keeps_its_process_from_starting() {
        let root = tempfile::tempdir().unwrap();
        let mut world = World::new(&[("claude", &World::logging_claude(root.path()))]);
        world.terminal = Some(crate::spinner::Terminal { columns: None });
        let mut out = Failing::on("Checking");

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            remove_plugins,
        );
        let checking = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.confirm_plugin_step().map(|_| ()),
        );

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(checking, Err(Failure::Screen));
        assert_eq!(
            fs::read_to_string(root.path().join("calls")).unwrap_or_default(),
            ""
        );
    }

    #[test]
    fn a_plugin_install_ends_its_wait_in_every_way() {
        let root = tempfile::tempdir().unwrap();
        let script = format!(
            "echo \"$*\" >> {}/calls\n[ -f {0}/fail ] && exit 1\nexit 0",
            root.path().display()
        );
        let mut world = World::new(&[("claude", &script)]);
        world.terminal = Some(crate::spinner::Terminal { columns: None });
        let choice = PluginChoice {
            marketplaces: MARKETPLACE_NAME.to_owned(),
            plugins: String::new(),
            plugin_ids: vec![HOOKS_PLUGIN_ID],
            removed_ids: Vec::new(),
        };
        let ensure = |out: &mut dyn Write| {
            world.run(
                &mut Scripted::default(),
                &mut Recorded::default(),
                out,
                |install| install.ensure_plugins(&choice),
            )
        };

        assert_eq!(ensure(&mut Failing::on("Installing")), Err(Failure::Screen));
        assert_eq!(
            fs::read_to_string(root.path().join("calls")).unwrap_or_default(),
            ""
        );
        assert_eq!(ensure(&mut Vec::new()), Ok(()));

        fs::write(root.path().join("fail"), "").unwrap();

        assert_eq!(
            ensure(&mut Vec::new()),
            Err(Failure::Failed((EN_US.failed)(&format!(
                "claude plugin install {HOOKS_PLUGIN_ID} --scope user"
            ))))
        );
    }

    #[test]
    fn a_spinner_that_cannot_be_shown_keeps_mermaid_installed() {
        let root = tempfile::tempdir().unwrap();
        let npm = format!("echo \"$*\" >> {}/calls\nexit 0", root.path().display());
        let mut world = World::new(&[("mmdc", "exit 0"), ("npm", &npm)]);
        world.terminal = Some(crate::spinner::Terminal { columns: None });
        let mut out = Failing::on(&EN_US.mermaid_removing[..4]);
        let mut asker = Scripted {
            yes: VecDeque::from([Ok(true)]),
            ..Scripted::default()
        };

        let result = world.run(
            &mut asker,
            &mut Recorded::default(),
            &mut out,
            remove_mermaid,
        );

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(
            fs::read_to_string(root.path().join("calls")).unwrap_or_default(),
            ""
        );
    }

    #[test]
    fn a_refused_line_after_a_write_keeps_the_file_written() {
        let world = World::new(&[]);
        let app = world.path("app");
        let mut out = Failing::on("deleted after");

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.save_inbox_days(&app, Some(3.0)),
        );

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(
            read_config(&app).get("inboxRetentionDays"),
            Some(&Value::from(3))
        );
    }

    #[test]
    fn a_refused_line_after_the_download_keeps_the_config_and_stops() {
        let world = World::new(&[("python", "exit 0")]);
        let app = world.path("app");
        fs::create_dir_all(app.join("whisper/venv/bin")).unwrap();
        fs::copy(
            world.path("bin/python"),
            app.join("whisper/venv/bin/python"),
        )
        .unwrap();
        let mut out = Failing::on("Installed");

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.apply_transcription(&app, Some("small")),
        );

        assert_eq!(result, Err(Failure::Screen));
        assert_eq!(
            read_config(&app)["transcription"]["model"],
            Value::from("small")
        );
    }

    #[test]
    fn a_config_behind_a_dangling_link_creates_the_target_and_keeps_the_link() {
        let world = World::new(&[]);
        let app = world.path("app");
        let elsewhere = world.path("elsewhere.json");
        fs::create_dir_all(&app).unwrap();
        symlink(&elsewhere, app.join(CONFIG_FILE)).unwrap();
        let mut out = Vec::new();

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.save_inbox_days(&app, Some(3.0)),
        );

        assert_eq!(result, Ok(()));
        assert!(
            fs::symlink_metadata(app.join(CONFIG_FILE))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_to_string(&elsewhere).unwrap(),
            "{\n  \"inboxRetentionDays\": 3\n}\n"
        );
    }

    #[test]
    fn a_config_behind_a_link_is_written_through_the_link() {
        let world = World::new(&[]);
        let app = world.path("app");
        let elsewhere = world.path("elsewhere.json");
        fs::create_dir_all(&app).unwrap();
        fs::write(&elsewhere, "{\"delayMinutes\":2}").unwrap();
        symlink(&elsewhere, app.join(CONFIG_FILE)).unwrap();
        let mut out = Vec::new();

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.save_inbox_days(&app, Some(3.0)),
        );

        assert_eq!(result, Ok(()));
        assert!(
            fs::symlink_metadata(app.join(CONFIG_FILE))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read_to_string(&elsewhere).unwrap(),
            "{\n  \"delayMinutes\": 2,\n  \"inboxRetentionDays\": 3\n}\n"
        );
    }

    #[test]
    fn a_journal_that_cannot_read_the_config_stops_before_writing_it() {
        let world = World::new(&[]);
        let app = world.path("app");
        let mut out = Vec::new();
        let mut journal = Recorded {
            unreadable: true,
            ..Recorded::default()
        };

        let result = world.run(
            &mut Scripted::default(),
            &mut journal,
            &mut out,
            |install| install.save_inbox_days(&app, Some(3.0)),
        );

        assert_eq!(
            result,
            Err(Failure::Failed((EN_US.file_not_saved)(
                &app.join(CONFIG_FILE).to_string_lossy()
            )))
        );
        assert!(!app.join(CONFIG_FILE).exists());
    }

    fn pick(mode: VisualMode, review: Option<bool>) -> VisualsPick {
        VisualsPick { mode, review }
    }

    fn saving_visuals(
        world: &World,
        config: Option<&str>,
        chosen: VisualsPick,
    ) -> (Result<(), Failure<String>>, String, Scripted) {
        let app = world.path("app");

        if let Some(config) = config {
            fs::create_dir_all(&app).unwrap();
            fs::write(app.join(CONFIG_FILE), config).unwrap();
        }

        let mut asker = Scripted {
            visuals: Ok(chosen),
            ..Scripted::default()
        };
        let mut out = Vec::new();
        let result = world.run(&mut asker, &mut Recorded::default(), &mut out, |install| {
            install.ensure_visuals(&app)
        });

        (result, String::from_utf8(out).unwrap(), asker)
    }

    #[test]
    fn asks_for_the_visuals_saved_and_saves_the_pick_with_the_review() {
        let world = World::new(&[]);
        let (result, shown, asker) = saving_visuals(
            &world,
            Some("{\"visuals\":\"prints\",\"visualReview\":false}"),
            pick(VisualMode::Video, Some(true)),
        );
        let config = read_config(&world.path("app"));

        assert_eq!(result, Ok(()));
        assert_eq!(
            asker.visuals_asked,
            [(
                Visuals {
                    mode: VisualMode::Prints,
                    review: false
                },
                true,
                true
            )]
        );
        assert_eq!(config.get("visuals"), Some(&Value::from("video")));
        assert_eq!(config.get("visualReview"), Some(&Value::Bool(true)));
        assert!(shown.starts_with(&format!(
            "✔ {}",
            (EN_US.visuals_saved)(
                "screenshots and video · with review",
                &world.path("app/better-cc-telegram.json").to_string_lossy()
            )
        )));
    }

    #[test]
    fn asks_for_the_visuals_off_with_the_review_on_when_nothing_is_saved() {
        let world = World::new(&[]);
        let (result, shown, asker) = saving_visuals(&world, None, pick(VisualMode::Off, None));
        let config = read_config(&world.path("app"));

        assert_eq!(result, Ok(()));
        assert_eq!(
            asker.visuals_asked,
            [(
                Visuals {
                    mode: VisualMode::Off,
                    review: true
                },
                false,
                false
            )]
        );
        assert_eq!(config.get("visuals"), Some(&Value::from("off")));
        assert_eq!(config.get("visualReview"), None);
        assert!(shown.contains("• off\n"));
        assert!(!shown.contains("missing"));
    }

    #[test]
    fn keeps_the_review_saved_when_the_visuals_go_off() {
        let world = World::new(&[]);
        let (result, _, _) = saving_visuals(
            &world,
            Some("{\"visuals\":\"video\",\"visualReview\":false}"),
            pick(VisualMode::Off, None),
        );
        let config = read_config(&world.path("app"));

        assert_eq!(result, Ok(()));
        assert_eq!(config.get("visuals"), Some(&Value::from("off")));
        assert_eq!(config.get("visualReview"), Some(&Value::Bool(false)));
    }

    #[test]
    fn warns_about_the_chromium_and_the_ffmpeg_that_the_video_needs() {
        let world = World::new(&[]);
        let (result, shown, _) = saving_visuals(&world, None, pick(VisualMode::Video, Some(true)));

        assert_eq!(result, Ok(()));
        assert!(shown.contains(&format!("⚠ {}\n", EN_US.chromium_missing_warning)));
        assert!(shown.ends_with(&format!("⚠ {}\n", EN_US.ffmpeg_missing_warning)));
    }

    #[test]
    fn warns_only_about_the_chromium_when_the_visuals_are_prints() {
        let world = World::new(&[]);
        let (result, shown, _) = saving_visuals(&world, None, pick(VisualMode::Prints, Some(true)));

        assert_eq!(result, Ok(()));
        assert!(shown.ends_with(&format!("⚠ {}\n", EN_US.chromium_missing_warning)));
        assert!(!shown.contains("ffmpeg"));
    }

    #[test]
    fn does_not_warn_when_the_chromium_and_the_ffmpeg_are_there() {
        let mut world = World::new(&[("ffmpeg", "exit 0")]);
        world.chromium = Some(PathBuf::from("/cache/chrome"));

        let (result, shown, _) = saving_visuals(&world, None, pick(VisualMode::Video, Some(true)));

        assert_eq!(result, Ok(()));
        assert!(!shown.contains('⚠'));
    }

    #[test]
    fn keeps_the_visuals_when_the_mode_and_the_review_are_the_same() {
        let world = World::new(&[]);
        let config = "{\"visuals\":\"video\",\"visualReview\":false}";
        let (result, shown, _) =
            saving_visuals(&world, Some(config), pick(VisualMode::Video, Some(false)));

        assert_eq!(result, Ok(()));
        assert_eq!(
            shown,
            format!(
                "○ {}\n",
                (EN_US.visuals_kept)("screenshots and video · sent directly")
            )
        );
        assert_eq!(
            fs::read_to_string(world.path("app").join(CONFIG_FILE)).unwrap(),
            config
        );
    }

    #[test]
    fn keeps_the_mode_without_a_review_when_none_was_asked() {
        let world = World::new(&[]);
        let (_, shown, _) = saving_visuals(
            &world,
            Some("{\"visuals\":\"prints\"}"),
            pick(VisualMode::Prints, None),
        );

        assert_eq!(
            shown,
            format!("○ {}\n", (EN_US.visuals_kept)("screenshots only"))
        );
    }

    #[test]
    fn saves_the_visuals_when_only_the_review_or_only_the_mode_changed() {
        for (config, chosen) in [
            (
                "{\"visuals\":\"video\",\"visualReview\":false}",
                pick(VisualMode::Video, Some(true)),
            ),
            (
                "{\"visuals\":\"prints\",\"visualReview\":true}",
                pick(VisualMode::Video, Some(true)),
            ),
            (
                "{\"visuals\":\"video\"}",
                pick(VisualMode::Video, Some(true)),
            ),
            ("{\"visuals\":3}", pick(VisualMode::Off, None)),
        ] {
            let world = World::new(&[]);
            let (result, shown, _) = saving_visuals(&world, Some(config), chosen);

            assert_eq!(result, Ok(()), "{config}");
            assert!(shown.starts_with("✔ "), "{config}");
        }
    }

    #[test]
    fn saves_the_review_alone_and_keeps_it_when_it_is_the_same() {
        let world = World::new(&[]);
        let app = world.path("app");
        let save = |review: bool| {
            let mut out = Vec::new();
            let result = world.run(
                &mut Scripted::default(),
                &mut Recorded::default(),
                &mut out,
                |install| install.save_visual_review(&app, review),
            );

            (result, String::from_utf8(out).unwrap())
        };

        let (first, shown) = save(false);

        assert_eq!(first, Ok(()));
        assert_eq!(
            read_config(&app).get("visualReview"),
            Some(&Value::Bool(false))
        );
        assert!(shown.starts_with(&format!(
            "✔ {}",
            (EN_US.visual_review_saved)("sent directly", &app.join(CONFIG_FILE).to_string_lossy())
        )));

        let (second, kept) = save(false);

        assert_eq!(second, Ok(()));
        assert_eq!(
            kept,
            format!("○ {}\n", (EN_US.visual_review_kept)("sent directly"))
        );

        let (third, shown) = save(true);

        assert_eq!(third, Ok(()));
        assert_eq!(
            read_config(&app).get("visualReview"),
            Some(&Value::Bool(true))
        );
        assert!(shown.contains("• with review\n"));
    }

    #[test]
    fn a_visuals_config_that_cannot_be_saved_stops_with_the_file() {
        let world = World::new(&[]);
        let folder = world.path("folder");
        fs::create_dir_all(folder.join(CONFIG_FILE)).unwrap();
        let mut out = Vec::new();

        let result = world.run(
            &mut Scripted::default(),
            &mut Recorded::default(),
            &mut out,
            |install| install.save_visuals(&folder, pick(VisualMode::Prints, None)),
        );

        assert_eq!(
            result,
            Err(Failure::Failed((EN_US.file_not_saved)(
                &folder.join(CONFIG_FILE).to_string_lossy()
            )))
        );
    }

    #[test]
    fn a_visuals_question_that_fails_stops_the_step() {
        let world = World::new(&[]);
        let mut out = Vec::new();

        assert_eq!(
            world.run(
                &mut Scripted::default(),
                &mut Recorded::default(),
                &mut out,
                |install| install.ensure_visuals(&world.path("app"))
            ),
            Err(Failure::Asking(STOP.to_owned()))
        );
    }

    #[test]
    fn a_screen_that_cannot_show_a_visuals_line_stops_the_step() {
        for (needle, chosen) in [
            ("Illustrations on Telegram:", pick(VisualMode::Off, None)),
            (
                "Chromium of Playwright",
                pick(VisualMode::Prints, Some(true)),
            ),
            ("ffmpeg is missing", pick(VisualMode::Video, Some(true))),
        ] {
            let mut asker = Scripted::default();

            assert_eq!(
                screen_failure(needle, &[], &mut asker, |install, world| {
                    install.save_visuals(&world.path("app"), chosen)
                }),
                Err(Failure::Screen),
                "{needle}"
            );
        }

        assert_eq!(
            screen_failure(
                "Illustrations on Telegram kept",
                &[],
                &mut Scripted::default(),
                |install, world| {
                    fs::create_dir_all(world.path("app")).unwrap();
                    fs::write(world.path("app").join(CONFIG_FILE), "{\"visuals\":\"off\"}")
                        .unwrap();
                    install.save_visuals(&world.path("app"), pick(VisualMode::Off, None))
                }
            ),
            Err(Failure::Screen)
        );
        assert_eq!(
            screen_failure(
                "Review before sending",
                &[],
                &mut Scripted::default(),
                |install, world| install.save_visual_review(&world.path("app"), true)
            ),
            Err(Failure::Screen)
        );
    }

    #[test]
    fn does_not_keep_the_review_when_the_saved_one_is_not_a_boolean() {
        let config = serde_json::json!({"visualReview": "yes"});

        assert_eq!(
            kept_message(
                Kept::VisualReview(true),
                config.as_object().unwrap(),
                Path::new("/app"),
                Path::new("/hub"),
                &EN_US,
            ),
            None
        );
    }

    #[test]
    fn the_inbox_days_are_shown_as_javascript_shows_the_number() {
        assert_eq!(days_text(&EN_US, Some(7.0)), (EN_US.inbox_days)(7));
        assert_eq!(days_text(&EN_US, None), EN_US.inbox_forever);
        assert_eq!(number_value(f64::NAN), Value::Null);
    }

    #[test]
    fn the_tool_names_are_the_js_ones() {
        assert_eq!(Tool::REQUIRED, [Tool::Claude, Tool::Bun]);
        assert_eq!(Tool::parse("uv"), Some(Tool::Uv));
        assert_eq!(Tool::parse("node"), None);
    }

    #[test]
    fn keeps_the_delay_per_kind_only_when_every_kind_is_saved_the_same() {
        use serde_json::json;

        let kept = |config: Value, kinds: [f64; 3]| {
            kept_message(
                Kept::Delays {
                    kinds,
                    summary: "s",
                },
                config.as_object().unwrap(),
                Path::new("/app"),
                Path::new("/hub"),
                &EN_US,
            )
        };
        let saved = json!({ "delays": { "questions": 0, "permissions": 0, "waiting": 4 } });

        assert_eq!(
            kept(saved.clone(), [0.0, 0.0, 4.0]),
            Some("Delay per kind kept:\n  • s".to_owned())
        );
        assert_eq!(kept(saved, [0.0, 1.0, 4.0]), None);
        assert_eq!(
            kept(
                json!({ "delays": { "questions": 0, "waiting": 4 } }),
                [0.0, 0.0, 4.0]
            ),
            None
        );
        assert_eq!(kept(json!({ "delays": 4 }), [4.0, 4.0, 4.0]), None);
        assert_eq!(kept(json!({ "delayMinutes": 4 }), [4.0, 4.0, 4.0]), None);
    }
}
