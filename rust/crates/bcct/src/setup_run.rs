use std::cell::RefCell;
use std::ffi::OsString;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde_json::{Map, Number, Value, json};

use crate::changes::{
    ChangeContext, DELAY_ICON, INBOX_ICON, LANGUAGE_ICON, PLUGIN_ICON, QUIET_HOURS_ICON,
    STATUSLINE_ICON, TRANSCRIPTION_ICON, describe_changes, quiet_hours_text,
};
use crate::config::{DEFAULT_DELAY_MINUTES, read_config};
use crate::files::{FileFailure, create_private_dir, read_json, write_private};
use crate::health::{self, Screen};
use crate::hook::now_ms;
use crate::install::{
    self, ClaudeUndo, CommandsChoice, Declined, Install, Kept, Parsed, System, Tool,
    TranscriptionChoice, declined_report, huggingface_cache_dir, kept_message, marketplace_source,
    parse_inbox_days, parse_transcription_model, remove_path,
};
use crate::journal::{Change, ChangeKind, Journal, UndoAction};
use crate::js::{join_path, js_length, js_string, js_trim, js_truthy, stringify_pretty};
use crate::locale::Locale;
use crate::messages::{Messages, messages_for};
use crate::paths::PREVIOUS_STATUSLINE_FILE;
use crate::prompt::ask_hidden;
use crate::prompt::{
    Choice, Colors, GuardCancel, PromptError, Prompter, ask_yes_no, create_prompter,
};
use crate::settings::{STATUS_LINE, is_our_statusline, remove_if_present, statusline_preview};
use crate::setup::{
    ACCESS_FILE, COMMAND_ON_PATH_KEY, ENV_FILE, MINIMUM_NODE, SETUP_COMMAND, SetupPaths,
    StatuslineState, check_setup, command_on_path, env_deny_rule, git_version_from, mark_launch,
    node_version_from, node_version_ok, parse_env_token, read_settings, read_text, setup_locale,
    shell_file, shell_script, statusline_is_current, statusline_prompt, statusline_state,
    telegram_instance_running, whisper_python_works,
};
use crate::setup_ask::{
    QuietRange, ask_delay, ask_inbox, ask_installed_commands, ask_language, ask_our_statusline,
    ask_pairing_choice, ask_quiet_hours, ask_remove_models, ask_statusline_choice,
    ask_transcription, parse_delay_minutes, parse_locale, parse_quiet_hours, quiet_answer,
    statusline_example,
};
use crate::setup_files::{
    CUSTOMIZED_KEY, ConfigError, Printer, SetupFiles, StatuslineChoice, apply_statusline,
    current_inbox_days, ensure_env_denied, remove_our_settings, statusline_custom_left,
    update_config,
};
use crate::setup_telegram::{
    self, PairingChoice, Prompts, TelegramSetup, Tracks, ensure_pairing, ensure_token,
    groups_warning, load_saved_bot, random_bytes,
};
use crate::shell_rc::{install_shell_function, remove_shell_lines};
use crate::signals;
use crate::spinner::{Pending, Terminal, pending, spin_on_stdout};
use crate::telegram::{Interruption, abortable_post_json, api_root};
use crate::ui::{fail, note, question, should_colorize, step_heading, success, warn};

const OK: u8 = 0;
const FAILURE: u8 = 1;
const INTERRUPTED: u8 = 130;
const SETTLE: Duration = Duration::from_millis(50);
const HEALTH_COMMAND: &str = "npx better-claude-code-telegram health";
const HEALTH_ICON: &str = "🩺";
const TOKEN_ICON: &str = "🔑";
const PAIRING_ICON: &str = "🔗";
const PATH_ICON: &str = "💻";
const SETTABLE_STEPS: [&str; 6] = [
    "language",
    "delay",
    "quiet-hours",
    "transcription",
    "inbox",
    "statusline",
];
const STATUSLINE_CHOICES: [(&str, StatuslineChoice); 5] = [
    ("on", StatuslineChoice::On),
    ("after", StatuslineChoice::After),
    ("replace", StatuslineChoice::Replace),
    ("custom", StatuslineChoice::Custom),
    ("off", StatuslineChoice::Off),
];
const UNDO_INDEX: usize = 0;
const KEEP_INDEX: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Language,
    Plugin,
    Token,
    Pairing,
    Delay,
    QuietHours,
    Transcription,
    Inbox,
    Statusline,
    Path,
    Health,
}

pub const SETUP_SECTIONS: [Section; 10] = [
    Section::Language,
    Section::Plugin,
    Section::Token,
    Section::Pairing,
    Section::Delay,
    Section::QuietHours,
    Section::Transcription,
    Section::Inbox,
    Section::Statusline,
    Section::Path,
];

impl Section {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Language => "language",
            Self::Plugin => "plugin",
            Self::Token => "token",
            Self::Pairing => "pairing",
            Self::Delay => "delay",
            Self::QuietHours => "quiet-hours",
            Self::Transcription => "transcription",
            Self::Inbox => "inbox",
            Self::Statusline => "statusline",
            Self::Path => "path",
            Self::Health => "health",
        }
    }

    fn heading(self, messages: &Messages) -> (&'static str, &'static str) {
        let titles = &messages.step_titles;

        match self {
            Self::Language => (LANGUAGE_ICON, titles.language),
            Self::Plugin => (PLUGIN_ICON, titles.plugin),
            Self::Token => (TOKEN_ICON, titles.token),
            Self::Pairing => (PAIRING_ICON, titles.pairing),
            Self::Delay => (DELAY_ICON, titles.delay),
            Self::QuietHours => (QUIET_HOURS_ICON, titles.quiet_hours),
            Self::Transcription => (TRANSCRIPTION_ICON, titles.transcription),
            Self::Inbox => (INBOX_ICON, titles.inbox),
            Self::Statusline => (STATUSLINE_ICON, titles.statusline),
            Self::Path => (PATH_ICON, titles.path),
            Self::Health => (HEALTH_ICON, titles.health),
        }
    }
}

pub fn parse_setup_sections(args: &[String], messages: &Messages) -> Result<Vec<Section>, String> {
    let requested: Vec<String> = args
        .iter()
        .map(|arg| js_trim(arg).to_lowercase())
        .filter(|arg| !arg.is_empty())
        .collect();

    if requested.is_empty() {
        return Ok(SETUP_SECTIONS.to_vec());
    }

    let names = || SETUP_SECTIONS.iter().map(|section| section.as_str());
    let unknown: Vec<&str> = requested
        .iter()
        .map(String::as_str)
        .filter(|arg| !names().any(|name| name == *arg))
        .collect();

    if !unknown.is_empty() {
        return Err((messages.unknown_steps)(
            &unknown.join(", "),
            &names().collect::<Vec<_>>().join(", "),
        ));
    }

    Ok(SETUP_SECTIONS
        .into_iter()
        .filter(|section| requested.iter().any(|arg| arg == section.as_str()))
        .collect())
}

#[derive(Debug)]
enum Stop {
    Failed(String),
    Declined(Declined),
    Prompt(PromptError),
    Output,
}

impl Stop {
    fn interrupted(&self) -> bool {
        matches!(self, Self::Prompt(error) if error.is_interrupted())
    }

    fn output(&self) -> bool {
        matches!(self, Self::Output | Self::Prompt(PromptError::Io(_)))
    }
}

impl From<PromptError> for Stop {
    fn from(error: PromptError) -> Self {
        Self::Prompt(error)
    }
}

impl From<setup_telegram::Failure> for Stop {
    fn from(failure: setup_telegram::Failure) -> Self {
        match failure {
            setup_telegram::Failure::Failed(message) => Self::Failed(message),
            setup_telegram::Failure::Screen => Self::Output,
        }
    }
}

impl From<install::Failure<PromptError>> for Stop {
    fn from(failure: install::Failure<PromptError>) -> Self {
        match failure {
            install::Failure::Failed(message) => Self::Failed(message),
            install::Failure::Declined(declined) => Self::Declined(declined),
            install::Failure::Asking(error) => Self::Prompt(error),
            install::Failure::Screen => Self::Output,
        }
    }
}

struct Tracked<'a> {
    inner: &'a mut dyn Write,
    failed: bool,
}

impl Tracked<'_> {
    fn watched<T>(&mut self, result: io::Result<T>) -> io::Result<T> {
        if result.is_err() {
            self.failed = true;
        }

        result
    }
}

impl Write for Tracked<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf);

        self.watched(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        let flushed = self.inner.flush();

        self.watched(flushed)
    }
}

struct Output<'a> {
    out: Tracked<'a>,
    err: &'a mut dyn Write,
    on_terminal: bool,
    colors: Colors,
}

fn terminal_columns() -> Option<u16> {
    #[cfg(unix)]
    let columns = rustix::termios::tcgetwinsize(io::stdout())
        .ok()
        .map(|size| size.ws_col);
    #[cfg(not(unix))]
    let columns = None;

    columns
}

impl Output<'_> {
    fn screen(&mut self) -> Screen<'_> {
        Screen {
            out: &mut self.out,
            err: &mut *self.err,
            terminal: self.on_terminal.then(|| Terminal {
                columns: terminal_columns(),
            }),
            colorize_out: self.colors.out,
            colorize_err: self.colors.err,
            spin: &spin_on_stdout,
        }
    }

    fn printer<'s>(&'s mut self, messages: &'s Messages) -> Printer<'s> {
        Printer::new(&mut self.out, self.colors.out, messages)
    }

    fn line(&mut self, text: &str) {
        let _written = writeln!(self.out, "{text}");
    }

    fn begin(&mut self, section: Section, steps: &[Section], messages: &Messages) -> bool {
        let Some(position) = steps.iter().position(|step| *step == section) else {
            return false;
        };
        let (icon, title) = section.heading(messages);
        let heading = step_heading(position + 1, steps.len(), title, icon, self.colors.out);

        self.line(&heading);

        true
    }

    fn error_line(&mut self, text: &str) {
        let _written = writeln!(self.err, "{text}");
    }

    fn fail(&mut self, text: &str) {
        let line = fail(text, self.colors.err);

        self.error_line(&line);
    }

    fn pending(&mut self, text: &str) -> Pending {
        let terminal = self.on_terminal.then(|| Terminal {
            columns: terminal_columns(),
        });

        pending(
            text,
            &mut self.out,
            terminal,
            self.colors.out,
            &spin_on_stdout,
        )
    }
}

struct Questions<'p> {
    ask: &'p mut dyn Prompter,
    messages: &'static Messages,
}

impl install::Asker for Questions<'_> {
    type Error = PromptError;

    fn yes_no(&mut self, prompt: &str, default_yes: bool) -> Result<bool, PromptError> {
        ask_yes_no(prompt, self.messages, default_yes, &mut *self.ask)
    }

    fn installed_commands(&mut self) -> Result<CommandsChoice, PromptError> {
        ask_installed_commands(self.messages, &mut *self.ask)
    }

    fn transcription(
        &mut self,
        current: Option<&'static str>,
        saved: bool,
        installed: &[&'static str],
    ) -> Result<TranscriptionChoice, PromptError> {
        ask_transcription(current, saved, installed, self.messages, &mut *self.ask)
    }

    fn remove_models(
        &mut self,
        others: &[&'static str],
        previous: Option<&'static str>,
        tag: &str,
    ) -> Result<Vec<&'static str>, PromptError> {
        ask_remove_models(others, previous, tag, self.messages, &mut *self.ask)
    }

    fn inbox(&mut self, current: Option<f64>, saved: bool) -> Result<Option<f64>, PromptError> {
        ask_inbox(current, saved, self.messages, &mut *self.ask)
    }
}

impl Prompts for Questions<'_> {
    type Error = Stop;

    fn yes_no(&mut self, prompt: &str) -> Result<bool, Stop> {
        Ok(ask_yes_no(prompt, self.messages, true, &mut *self.ask)?)
    }

    fn hidden(&mut self, prompt: &str) -> Result<String, Stop> {
        Ok(ask_hidden(prompt, self.messages, &mut *self.ask)?)
    }

    fn pairing_choice(&mut self, accounts: &str) -> Result<PairingChoice, Stop> {
        Ok(ask_pairing_choice(accounts, self.messages, &mut *self.ask)?)
    }
}

struct InstallJournal<'j> {
    journal: &'j mut Journal,
    system: &'j Rc<System>,
    messages: &'static Messages,
}

impl install::Journal for InstallJournal<'_> {
    fn record(&mut self, kind: ChangeKind, target: String, undo: Option<ClaudeUndo>) {
        let action = undo.map(|undo| {
            let system = Rc::clone(self.system);
            let messages = self.messages;
            let action: UndoAction = Box::new(move || undo.run(&system, messages).is_ok());

            action
        });

        self.journal.record(kind, &target, action);
    }

    fn track_dir(&mut self, dir: &Path) {
        self.journal.track_dir(dir);
    }

    fn track_file(&mut self, file: &Path) -> io::Result<()> {
        self.journal.track_file(file)
    }
}

impl Tracks for Journal {
    fn track_dir(&mut self, dir: &Path) {
        Self::track_dir(self, dir);
    }

    fn track_file(&mut self, file: &Path) -> io::Result<()> {
        Self::track_file(self, file)
    }
}

fn number(value: f64) -> Value {
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn quiet_value(range: Option<&QuietRange>) -> Value {
    range.map_or(
        Value::Null,
        |(start, end)| json!({ "start": start, "end": end }),
    )
}

fn quiet_text(range: Option<&QuietRange>) -> String {
    range.map_or_else(String::new, |(start, end)| format!("{start}-{end}"))
}

fn kept_quiet(range: Option<&QuietRange>) -> Kept<'_> {
    Kept::QuietHours(
        range
            .as_ref()
            .map(|(start, end)| (start.as_str(), end.as_str())),
    )
}

fn setup_files<'f>(paths: &'f SetupPaths, home: &'f str) -> SetupFiles<'f> {
    SetupFiles {
        app_dir: &paths.app_dir,
        state_dir: &paths.state_dir,
        settings_file: &paths.settings_file,
        home,
    }
}

struct Setup<'a> {
    var: &'a dyn Fn(&str) -> Option<OsString>,
    home: PathBuf,
    home_text: String,
    marketplace: String,
    shell: Option<String>,
    macos: bool,
    flags: bool,
    uid: Option<u32>,
    paths: SetupPaths,
    hf_cache: PathBuf,
    api_root: String,
    system: Rc<System>,
    interruption: Interruption,
    journal: Journal,
    output: Output<'a>,
}

impl<'a> Setup<'a> {
    fn new(
        var: &'a dyn Fn(&str) -> Option<OsString>,
        stdout: &'a mut dyn Write,
        stderr: &'a mut dyn Write,
    ) -> Self {
        let home = std::env::home_dir().unwrap_or_default();
        let on_terminal = io::stdout().is_terminal();
        let filled = |name: &str| var(name).is_some_and(|value| !value.is_empty());
        #[cfg(unix)]
        let uid = Some(rustix::process::getuid().as_raw());
        #[cfg(not(unix))]
        let uid = None;

        Self {
            var,
            home_text: home.to_string_lossy().into_owned(),
            marketplace: marketplace_source(env!("CARGO_PKG_VERSION")),
            shell: var("SHELL").map(|shell| shell.to_string_lossy().into_owned()),
            macos: cfg!(target_os = "macos"),
            flags: !cfg!(windows) && !filled("WSL_DISTRO_NAME") && !filled("WT_SESSION"),
            uid,
            paths: SetupPaths::resolve(var, &home),
            hf_cache: huggingface_cache_dir(var, &home),
            api_root: api_root(var),
            system: Rc::new(System::from_process()),
            interruption: Interruption::new(),
            journal: Journal::new(),
            home,
            output: Output {
                out: Tracked {
                    inner: stdout,
                    failed: false,
                },
                err: stderr,
                on_terminal,
                colors: Colors {
                    out: should_colorize(var, on_terminal),
                    err: should_colorize(var, io::stderr().is_terminal()),
                },
            },
        }
    }

    fn messages(&self) -> &'static Messages {
        messages_for(setup_locale(&self.paths.app_dir, self.var))
    }

    fn save_shell_script(&mut self, script: &Path) -> Result<(), FileFailure> {
        let contents = shell_script(&self.paths.app_dir, command_on_path(&self.paths.app_dir));

        if read_text(script).as_deref() == Some(contents.as_str()) {
            return Ok(());
        }

        let not_saved = |_| FileFailure::NotSaved(script.to_path_buf());

        self.journal.track_dir(&self.paths.app_dir);
        create_private_dir(&self.paths.app_dir).map_err(not_saved)?;
        self.journal.track_file(script).map_err(not_saved)?;
        write_private(script, contents.as_bytes()).map_err(not_saved)
    }

    fn ready(&self) -> Result<(), Stop> {
        if self.output.out.failed {
            Err(Stop::Output)
        } else {
            Ok(())
        }
    }

    fn installing<T>(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
        work: impl FnOnce(&mut Install<'_, '_, PromptError>) -> Result<T, install::Failure<PromptError>>,
    ) -> Result<T, Stop> {
        self.ready()?;

        let machine = install::Machine {
            home: &self.home,
            app_dir: &self.paths.app_dir,
            marketplace: &self.marketplace,
            hf_cache: &self.hf_cache,
            settings_file: &self.paths.settings_file,
            shell: self.shell.as_deref(),
            macos: self.macos,
            system: &self.system,
            run_installer: &|system, command| system.run_installer(command),
        };
        let mut screen = self.output.screen();
        let mut journal = InstallJournal {
            journal: &mut self.journal,
            system: &self.system,
            messages,
        };
        let mut asker = Questions { ask, messages };
        let mut install = Install::new(&machine, &mut screen, &mut journal, &mut asker, messages);

        Ok(work(&mut install)?)
    }

    fn save_setting(
        &mut self,
        key: &str,
        value: Value,
        messages: &Messages,
    ) -> Result<PathBuf, Stop> {
        let patch = Map::from_iter([(key.to_owned(), value)]);

        update_config(&self.paths.app_dir, &patch, &mut self.journal)
            .map_err(|failure| Stop::Failed(failure.message(messages)))
    }

    fn kept_setting(&mut self, kept: Kept<'_>, messages: &Messages) -> bool {
        let app_dir = &self.paths.app_dir;
        let Some(message) = kept_message(
            kept,
            &read_config(app_dir),
            app_dir,
            &self.hf_cache,
            messages,
        ) else {
            return false;
        };

        self.output.printer(messages).skipped(&message);

        true
    }

    fn begin(&mut self, section: Section, steps: &[Section], messages: &Messages) -> bool {
        self.output.begin(section, steps, messages)
    }

    fn enter_keeps_default(&self) -> String {
        let chosen = read_config(&self.paths.app_dir)
            .get("language")
            .and_then(Value::as_str)
            .and_then(Locale::parse);

        chosen.map_or_else(
            || {
                Locale::ALL
                    .map(|locale| {
                        format!(
                            "[{}] {}",
                            locale.as_str(),
                            messages_for(locale).enter_keeps_default
                        )
                    })
                    .join(" / ")
            },
            |locale| messages_for(locale).enter_keeps_default.to_owned(),
        )
    }

    fn node_version(&self) -> Option<String> {
        node_version_from(self.system.command("node"))
    }

    fn ensure_language(&mut self, ask: &mut dyn Prompter) -> Result<(), Stop> {
        let current = setup_locale(&self.paths.app_dir, self.var);
        let saved = read_config(&self.paths.app_dir)
            .get("language")
            .and_then(Value::as_str)
            .and_then(Locale::parse)
            .is_some();

        self.ready()?;

        let language = ask_language(current, saved, self.flags, messages_for(current), ask)?;

        self.save_language(language)
    }

    fn save_language(&mut self, language: Locale) -> Result<(), Stop> {
        let messages = messages_for(language);
        let name = language.as_str();

        if self.kept_setting(Kept::Language(name), messages) {
            return Ok(());
        }

        let config_file = self.save_setting("language", json!(name), messages)?;

        self.output
            .printer(messages)
            .success(&(messages.language_saved)(
                name,
                &config_file.to_string_lossy(),
            ));

        Ok(())
    }

    fn ensure_delay(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        let config = read_config(&self.paths.app_dir);
        let typed = config
            .get("delayMinutes")
            .filter(|minutes| !minutes.is_null())
            .map(js_string)
            .unwrap_or_default();
        let current = parse_delay_minutes(&typed).unwrap_or(DEFAULT_DELAY_MINUTES);
        let saved = config.contains_key("delayMinutes");

        self.ready()?;

        let minutes = ask_delay(current, saved, messages, ask)?;

        self.save_delay(minutes, messages)
    }

    fn save_delay(&mut self, minutes: f64, messages: &Messages) -> Result<(), Stop> {
        if self.kept_setting(Kept::Delay(minutes), messages) {
            return Ok(());
        }

        let config_file = self.save_setting("delayMinutes", number(minutes), messages)?;

        self.output
            .printer(messages)
            .success(&(messages.delay_saved)(
                minutes,
                &config_file.to_string_lossy(),
            ));

        Ok(())
    }

    fn ensure_quiet_hours(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        let config = read_config(&self.paths.app_dir);
        let text = quiet_hours_text(config.get("quietHours").unwrap_or(&Value::Null));
        let current = match parse_quiet_hours(&text) {
            Parsed::Value(range) => Some(range),
            Parsed::Off | Parsed::Keep => None,
        };
        let saved = config.contains_key("quietHours");

        self.ready()?;

        let quiet = ask_quiet_hours(current.as_ref(), saved, messages, ask)?;

        self.save_quiet_hours(quiet.as_ref(), messages)
    }

    fn save_quiet_hours(
        &mut self,
        quiet: Option<&QuietRange>,
        messages: &Messages,
    ) -> Result<(), Stop> {
        if self.kept_setting(kept_quiet(quiet), messages) {
            return Ok(());
        }

        let config_file = self.save_setting("quietHours", quiet_value(quiet), messages)?;
        let text = quiet.map_or_else(|| messages.quiet_off.to_owned(), |_| quiet_text(quiet));

        self.output
            .printer(messages)
            .success(&(messages.quiet_saved)(
                &text,
                &config_file.to_string_lossy(),
            ));

        Ok(())
    }

    fn apply_statusline(
        &mut self,
        choice: StatuslineChoice,
        messages: &Messages,
    ) -> Result<(), Stop> {
        let files = setup_files(&self.paths, &self.home_text);
        let mut printer = self.output.printer(messages);

        apply_statusline(&files, choice, now_ms(), &mut self.journal, &mut printer)
            .map_err(|error: ConfigError| Stop::Failed(error.message(messages)))
    }

    fn ensure_statusline(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        let settings = read_settings(&self.paths.settings_file, messages).map_err(Stop::Failed)?;
        let current = settings.get(STATUS_LINE);

        self.ready()?;

        if is_our_statusline(current, &self.paths.app_dir) {
            let restores = join_path(&self.paths.app_dir, PREVIOUS_STATUSLINE_FILE).exists();

            if ask_our_statusline(restores, messages, ask)? == CommandsChoice::Remove {
                return self.apply_statusline(StatuslineChoice::Off, messages);
            }

            if !statusline_is_current(current, &self.paths.app_dir) {
                return self.apply_statusline(StatuslineChoice::On, messages);
            }

            self.output
                .printer(messages)
                .skipped(messages.statusline_ours_kept);

            return Ok(());
        }

        if !current.is_some_and(js_truthy) {
            let prompt = (messages.statusline_prompt)(&statusline_example(messages));

            if ask_yes_no(&prompt, messages, false, ask)? {
                return self.apply_statusline(StatuslineChoice::On, messages);
            }

            self.output.line(messages.statusline_skipped);

            return Ok(());
        }

        let customized =
            read_config(&self.paths.app_dir).get(CUSTOMIZED_KEY) == Some(&Value::Bool(true));
        let choice =
            ask_statusline_choice(&statusline_preview(current), customized, messages, ask)?;

        self.apply_statusline(choice, messages)
    }

    fn bot_steps(
        &mut self,
        sections: &[Section],
        steps: &[Section],
        offer_saved: bool,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        let wants_token = sections.contains(&Section::Token);

        if !wants_token && !sections.contains(&Section::Pairing) {
            return Ok(());
        }

        if wants_token {
            self.output.begin(Section::Token, steps, messages);
        }

        self.ready()?;

        let interruption = self.interruption.clone();
        let fetch = move |url: &str, body: &str| abortable_post_json(url, body, &interruption);
        let setup = TelegramSetup {
            state_dir: &self.paths.state_dir,
            messages,
            fetch: &fetch,
            api_root: &self.api_root,
            now: &now_ms,
            random: &random_bytes,
            is_running: &telegram_instance_running,
        };
        let bot = {
            let mut screen = self.output.screen();

            if wants_token {
                let mut questions = Questions { ask, messages };

                ensure_token(
                    &setup,
                    offer_saved,
                    &mut screen,
                    &mut questions,
                    &mut self.journal,
                )?
            } else {
                load_saved_bot(&setup, &mut screen)?
            }
        };

        if wants_token {
            let files = setup_files(&self.paths, &self.home_text);
            let mut printer = self.output.printer(messages);

            ensure_env_denied(&files, &mut self.journal, &mut printer)
                .map_err(|error| Stop::Failed(error.message(messages)))?;

            if let Some(warning) = groups_warning(&bot, messages, self.output.colors.out) {
                self.output.line(&warning);
            }

            if bot.screen_refused {
                return Err(Stop::Output);
            }
        }

        if self.output.begin(Section::Pairing, steps, messages) {
            self.ready()?;

            let mut screen = self.output.screen();
            let mut questions = Questions { ask, messages };

            ensure_pairing(&setup, &bot, &mut screen, &mut questions, &mut self.journal)?;
        }

        Ok(())
    }

    fn final_check(&mut self, messages: &'static Messages) -> Result<(), Stop> {
        self.ready()?;

        let interruption = self.interruption.clone();
        let system = Rc::clone(&self.system);
        let node_system = Rc::clone(&self.system);
        let git_system = Rc::clone(&self.system);
        let claude_system = Rc::clone(&self.system);
        let has_command = move |name: &str| system.has_command(name);
        let claude_output = move |args: &[&str]| claude_system.claude_output(args);
        let node_version = move || node_version_from(node_system.command("node"));
        let git_version = move || git_version_from(git_system.command("git"));
        let fetch = move |url: &str, body: &str| abortable_post_json(url, body, &interruption);
        let machine = health::Machine {
            var: self.var,
            home: &self.home,
            uid: self.uid,
            now: now_ms(),
            node_version: &node_version,
            git_version: &git_version,
            has_command: &has_command,
            claude_output: &claude_output,
            python_works: &whisper_python_works,
            fetch: &fetch,
            update: &crate::update::run_quietly,
        };
        let failed = health::check_all(&machine, &mut self.output.screen(), messages);

        self.ready()?;

        if failed.map_err(Stop::Failed)? {
            let colorize = self.output.colors.out;

            self.output.line(&warn(
                &(messages.health_has_failures)(HEALTH_COMMAND),
                colorize,
            ));
        }

        Ok(())
    }

    fn main(&mut self, args: &[String], ask: &mut dyn Prompter) -> Result<(), Stop> {
        let first = self.messages();
        let sections = parse_setup_sections(args, first).map_err(Stop::Failed)?;
        let runs_all = sections.len() == SETUP_SECTIONS.len();

        if let Some(version) = self.node_version().filter(|found| !node_version_ok(found)) {
            return Err(Stop::Failed((first.node_too_old)(&version, MINIMUM_NODE)));
        }

        let colorize = self.output.colors.out;
        let intro = note(&self.enter_keeps_default(), colorize);

        self.output.line(&intro);

        let mut steps = sections.clone();

        if runs_all {
            steps.push(Section::Health);
        }

        if self.begin(Section::Language, &steps, first) {
            self.ensure_language(ask)?;
        }

        let messages = self.messages();

        if self.begin(Section::Plugin, &steps, messages) {
            self.plugin_step(messages, ask)?;
        }

        self.bot_steps(&sections, &steps, runs_all, messages, ask)?;

        if self.begin(Section::Delay, &steps, messages) {
            self.ensure_delay(messages, ask)?;
        }

        if self.begin(Section::QuietHours, &steps, messages) {
            self.ensure_quiet_hours(messages, ask)?;
        }

        let app_dir = self.paths.app_dir.clone();

        if self.begin(Section::Transcription, &steps, messages) {
            self.installing(messages, ask, |install| {
                install.ensure_transcription(&app_dir)
            })?;
        }

        if self.begin(Section::Inbox, &steps, messages) {
            self.installing(messages, ask, |install| install.ensure_inbox(&app_dir))?;
        }

        if self.begin(Section::Statusline, &steps, messages) {
            self.ensure_statusline(messages, ask)?;
        }

        if self.begin(Section::Path, &steps, messages) {
            self.ensure_path(messages, ask)?;
        }

        if self.begin(Section::Health, &steps, messages) {
            self.final_check(messages)?;
        }

        let needs_reopen = [Section::Plugin, Section::Token, Section::Pairing]
            .iter()
            .any(|section| sections.contains(section));
        let done = if runs_all {
            messages.done_all
        } else if needs_reopen {
            messages.done_reopen
        } else {
            messages.done_live
        };

        self.output.line(&format!("\n{}", success(done, colorize)));

        Ok(())
    }

    #[allow(
        clippy::redundant_closure_for_method_calls,
        reason = "the path of the method is not general enough over the lifetimes of Install"
    )]
    fn plugin_step(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        if !self.system.has_command("git") {
            return Err(Stop::Failed(messages.git_missing_setup.to_owned()));
        }

        self.installing(messages, ask, |install| {
            install.ensure_requirements(&Tool::REQUIRED)
        })?;

        let choice = self.installing(messages, ask, |install| install.confirm_plugin_step())?;

        self.installing(messages, ask, |install| install.ensure_plugins(&choice))?;

        self.install_shell(messages)
    }

    fn install_shell(&mut self, messages: &'static Messages) -> Result<(), Stop> {
        let script = shell_file(&self.paths.app_dir);

        self.save_shell_script(&script)
            .map_err(|failure| Stop::Failed(failure.message(messages)))?;

        let mut printer = self.output.printer(messages);

        install_shell_function(
            &self.home_text,
            self.shell.as_deref(),
            self.macos,
            &script,
            &mut self.journal,
            &mut printer,
        )
        .map_err(|error| Stop::Failed(error.message(messages)))
    }

    fn ensure_path(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        self.ready()?;

        let current = command_on_path(&self.paths.app_dir);
        let wanted = ask_yes_no(messages.path_question, messages, current, ask)?;
        let script = shell_file(&self.paths.app_dir);
        let shown = script.to_string_lossy().into_owned();

        if wanted != current {
            self.save_setting(COMMAND_ON_PATH_KEY, Value::Bool(wanted), messages)?;
        }

        if !wanted {
            if current {
                self.save_shell_script(&script)
                    .map_err(|failure| Stop::Failed(failure.message(messages)))?;
                self.output
                    .printer(messages)
                    .success(&(messages.path_removed)(&shown));
            } else {
                self.output.line(messages.path_off);
            }

            return Ok(());
        }

        self.install_shell(messages)?;

        let mut printer = self.output.printer(messages);

        if current {
            printer.skipped(&(messages.path_already)(&shown));
        } else {
            printer.success(&(messages.path_added)(&shown));
        }

        Ok(())
    }

    fn apply_setting(
        &mut self,
        step: &str,
        value: &str,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        if !SETTABLE_STEPS.contains(&step) {
            return Err(Stop::Failed((messages.not_settable)(
                step,
                &SETTABLE_STEPS.join(", "),
            )));
        }

        let invalid = |hint: &str| Stop::Failed((messages.invalid_setting)(step, value, hint));
        let hints = messages.setting_hints;

        match step {
            "language" => {
                let language = parse_locale(value).ok_or_else(|| invalid(hints.language))?;

                self.save_language(language)
            }
            "delay" => {
                let minutes = parse_delay_minutes(value).ok_or_else(|| invalid(hints.delay))?;

                self.save_delay(minutes, messages)
            }
            "quiet-hours" => {
                let quiet = quiet_answer(value).ok_or_else(|| invalid(hints.quiet_hours))?;

                self.save_quiet_hours(quiet.as_ref(), messages)
            }
            "transcription" => {
                let model = match parse_transcription_model(value) {
                    Parsed::Value(model) => Some(model),
                    Parsed::Off => None,
                    Parsed::Keep => return Err(invalid(hints.transcription)),
                };

                if self.kept_setting(Kept::Transcription(model), messages) {
                    return Ok(());
                }

                let app_dir = self.paths.app_dir.clone();

                self.installing(messages, ask, |install| {
                    install.apply_transcription(&app_dir, model)
                })
            }
            "inbox" => {
                let days = match parse_inbox_days(value) {
                    Parsed::Value(days) => Some(days),
                    Parsed::Off => None,
                    Parsed::Keep => return Err(invalid(hints.inbox)),
                };

                if self.kept_setting(Kept::Inbox(days), messages) {
                    return Ok(());
                }

                let app_dir = self.paths.app_dir.clone();

                self.installing(messages, ask, |install| {
                    install.save_inbox_days(&app_dir, days)
                })
            }
            _ => {
                let typed = js_trim(value).to_lowercase();
                let choice = STATUSLINE_CHOICES
                    .iter()
                    .find(|(name, _)| *name == typed)
                    .ok_or_else(|| invalid(hints.statusline))?
                    .1;

                self.apply_statusline(choice, messages)
            }
        }
    }

    #[allow(
        clippy::redundant_closure_for_method_calls,
        reason = "the path of the method is not general enough over the lifetimes of Install"
    )]
    fn uninstall(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
    ) -> Result<(), Stop> {
        if telegram_instance_running(&self.paths.state_dir).is_some() {
            return Err(Stop::Failed(
                messages.close_instance_before_uninstall.to_owned(),
            ));
        }

        let settings = read_settings(&self.paths.settings_file, messages).map_err(Stop::Failed)?;
        let script = shell_file(&self.paths.app_dir);
        let colorize = self.output.colors.out;

        {
            let files = setup_files(&self.paths, &self.home_text);
            let mut printer = self.output.printer(messages);
            let failed = |error: ConfigError| Stop::Failed(error.message(messages));

            remove_shell_lines(&self.home_text, &script, &mut printer).map_err(failed)?;
            remove_if_present(&script).map_err(|_| {
                Stop::Failed(FileFailure::NotRemoved(script.clone()).message(messages))
            })?;
            remove_our_settings(&settings, &files, &mut self.journal, &mut printer)
                .map_err(failed)?;
        }

        self.installing(messages, ask, |install| install.remove_plugins())?;

        if let Some(left) = statusline_custom_left(&self.paths.app_dir, messages, colorize) {
            self.output.line(&left);
        }

        let app_dir = self.paths.app_dir.clone();

        self.installing(messages, ask, |install| {
            install.remove_transcription(&app_dir)
        })?;
        self.installing(messages, ask, |install| install.remove_mermaid())?;
        self.ready()?;

        let state_dir = self.paths.state_dir.clone();
        let state_text = state_dir.to_string_lossy();
        let app_text = app_dir.to_string_lossy();

        if ask_yes_no(
            &(messages.delete_state_prompt)(&state_text, &app_text),
            messages,
            false,
            ask,
        )? {
            let removed = |failure: FileFailure| Stop::Failed(failure.message(messages));

            remove_path(&state_dir).map_err(removed)?;
            remove_path(&app_dir).map_err(removed)?;
            self.output.line(&success(
                &(messages.state_deleted)(&state_text, &app_text),
                colorize,
            ));
        } else {
            self.output
                .line(&(messages.state_kept)(&state_text, &app_text));
        }

        self.output
            .line(&format!("\n{}", success(messages.uninstall_done, colorize)));

        Ok(())
    }

    fn report_stop(&mut self, stop: &Stop) {
        let colorize = self.output.colors.out;

        match stop {
            Stop::Failed(message) => self.output.fail(message),
            Stop::Prompt(error) if !stop.output() => self.output.fail(&error.to_string()),
            Stop::Declined(declined) => {
                let report = declined_report(declined, colorize);
                let _written = self.output.out.write_all(report.as_bytes());
            }
            Stop::Prompt(_) | Stop::Output => self.output.out.failed = true,
        }
    }

    fn finish(&mut self, code: u8) -> u8 {
        if self.output.out.failed {
            let line = self.messages().output_not_shown;

            self.output.fail(line);

            return FAILURE;
        }

        code
    }

    fn concluded(&mut self, result: Result<(), Stop>) -> u8 {
        match result {
            Ok(()) => self.finish(OK),
            Err(stop) => {
                self.report_stop(&stop);
                self.finish(FAILURE)
            }
        }
    }

    fn change_context_rule(&self) -> String {
        env_deny_rule(&join_path(&self.paths.state_dir, ENV_FILE), &self.home_text)
    }

    fn described(&self, changes: &[Change], messages: &Messages) -> Result<String, String> {
        let rule = self.change_context_rule();
        let context = ChangeContext {
            env_rule: &rule,
            app_dir: &self.paths.app_dir,
            messages,
            colorize: self.output.colors.out,
        };

        describe_changes(changes, &self.journal, &context)
    }

    fn undo_everything(&mut self, messages: &Messages) -> Result<(), String> {
        let output = RefCell::new(&mut self.output);
        let waiting: RefCell<Option<Pending>> = RefCell::new(None);
        let left = self.journal.undo_all(
            &mut |change| {
                let text = (messages.undoing)(&change.describe(messages));

                waiting.replace(Some(output.borrow_mut().pending(&text)));
            },
            &mut |change, done| {
                let mut output = output.borrow_mut();

                let _cleared = waiting
                    .take()
                    .map(|shown| shown.finish(None, &mut output.out));

                if done {
                    let line = (messages.undone_item)(&change.describe(messages));

                    output.printer(messages).success(&line);
                }
            },
        );

        if left.is_empty() {
            self.output.printer(messages).success(messages.undone);

            return Ok(());
        }

        let text = self.described(&left, messages)?;

        self.output
            .printer(messages)
            .warn(&(messages.undo_left)(&text));

        Ok(())
    }

    fn offer_undo(
        &mut self,
        messages: &'static Messages,
        ask: &mut dyn Prompter,
        interrupted: bool,
    ) -> Result<(), String> {
        let changes = self.journal.changes();

        if changes.is_empty() {
            self.output.line(messages.nothing_changed);

            return Ok(());
        }

        let text = self.described(&changes, messages)?;

        self.output.line(&(messages.done_so_far)(&text));

        let title = question(messages.undo_prompt, ask.colors().out);
        let choices = [
            Choice::new(messages.undo_all),
            Choice::new(messages.keep_done),
        ];
        let index = if interrupted { UNDO_INDEX } else { KEEP_INDEX };
        let chosen = ask.select(&title, &choices, index, messages);

        if !matches!(chosen, Ok(UNDO_INDEX)) {
            self.output.line(&(messages.kept_done)(SETUP_COMMAND));

            return Ok(());
        }

        self.undo_everything(messages)
    }

    fn run_interactive(&mut self, args: &[String], terminal: &mut dyn Prompter) -> u8 {
        let interrupted = Arc::new(AtomicBool::new(false));

        signals::watch(Some(signals::Interrupted {
            flag: Arc::clone(&interrupted),
            interruption: self.interruption.clone(),
        }));

        let result = {
            let mut guarded = GuardCancel::new(&mut *terminal);

            self.main(args, &mut guarded)
        };
        let Err(stop) = result else {
            return self.finish(OK);
        };

        thread::sleep(SETTLE);

        if stop.output() {
            self.report_stop(&stop);

            return self.finish(FAILURE);
        }

        let stopped = interrupted.load(Ordering::SeqCst) || stop.interrupted();
        let messages = self.messages();

        if stopped {
            let line = warn(messages.interrupted, self.output.colors.out);

            self.output.error_line(&line);
        } else {
            self.report_stop(&stop);
        }

        if let Err(message) = self.offer_undo(messages, terminal, stopped) {
            self.output.fail(&message);

            return self.finish(FAILURE);
        }

        self.finish(if stopped { INTERRUPTED } else { FAILURE })
    }

    fn run_setup(&mut self, args: &[String], terminal: &mut dyn Prompter) -> u8 {
        if terminal.interactive() {
            return self.run_interactive(args, terminal);
        }

        let result = self.main(args, terminal);

        self.concluded(result)
    }

    fn run_uninstall(&mut self, terminal: &mut dyn Prompter) -> u8 {
        if terminal.interactive() {
            signals::watch(None);
        }

        let messages = self.messages();
        let result = self.uninstall(messages, terminal);

        self.concluded(result)
    }

    fn run_set(&mut self, step: &str, value: &str, terminal: &mut dyn Prompter) -> u8 {
        if terminal.interactive() {
            signals::watch(None);
        }

        let messages = self.messages();
        let result = self.apply_setting(step, value, messages, terminal);

        self.concluded(result)
    }

    fn check(&mut self, args: &[String]) -> u8 {
        let refusal = check_setup(&self.paths, self.var, args, &telegram_instance_running);

        refusal.map_or(OK, |text| {
            self.output.fail(&text);

            FAILURE
        })
    }

    fn statusline_request(&mut self, take: bool) -> u8 {
        match statusline_prompt(take, &self.paths, self.var) {
            Ok(request) => {
                if !request.is_empty() {
                    self.output.line(&request);
                }

                self.finish(OK)
            }
            Err(failure) => {
                let text = failure.message(self.messages());

                self.output.fail(&text);

                FAILURE
            }
        }
    }

    fn mark_launch(&mut self) -> u8 {
        match mark_launch(&self.paths.app_dir, now_ms()) {
            Ok(()) => OK,
            Err(failure) => {
                let text = failure.message(self.messages());

                self.output.fail(&text);

                FAILURE
            }
        }
    }

    fn show(&mut self) -> u8 {
        let state = current_state(&self.paths, self.var);

        self.output.line(&stringify_pretty(&state));
        self.finish(OK)
    }
}

fn statusline_state_name(state: StatuslineState) -> &'static str {
    match state {
        StatuslineState::None => "none",
        StatuslineState::Ours => "ours",
        StatuslineState::OursAfter => "ours-after",
        StatuslineState::Other => "other",
        StatuslineState::Custom => "custom",
        StatuslineState::CustomPending => "custom-pending",
    }
}

#[must_use]
pub fn current_state(paths: &SetupPaths, var: &dyn Fn(&str) -> Option<OsString>) -> Value {
    let config = read_config(&paths.app_dir);
    let delay = config
        .get("delayMinutes")
        .filter(|minutes| !minutes.is_null())
        .map(js_string)
        .unwrap_or_default();
    let token =
        parse_env_token(&read_text(&join_path(&paths.state_dir, ENV_FILE)).unwrap_or_default())
            .is_some_and(|token| !token.is_empty());
    let accounts = read_json(&join_path(&paths.state_dir, ACCESS_FILE))
        .as_ref()
        .and_then(|access| access.get("allowFrom"))
        .and_then(js_length)
        .unwrap_or_default();

    json!({
        "language": setup_locale(&paths.app_dir, var).as_str(),
        "delayMinutes": number(parse_delay_minutes(&delay).unwrap_or(DEFAULT_DELAY_MINUTES)),
        "quietHours": config
            .get("quietHours")
            .cloned()
            .unwrap_or(Value::Null),
        "transcription": config
            .get("transcription")
            .and_then(|transcription| transcription.get("model"))
            .cloned()
            .unwrap_or(Value::Null),
        "inboxRetentionDays": current_inbox_days(&paths.app_dir).map_or(Value::Null, number),
        "statusline": statusline_state_name(statusline_state(paths)),
        "token": token,
        "pairedAccounts": accounts,
    })
}

fn text_args(args: &[OsString]) -> Vec<String> {
    args.iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

pub fn run_process(args: &[OsString], stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    let var = |name: &str| std::env::var_os(name);
    let args = text_args(args);
    let mut setup = Setup::new(&var, stdout, stderr);

    match args.first().map(String::as_str) {
        Some("--check") => setup.check(args.get(1..).unwrap_or_default()),
        Some("--statusline-prompt") => {
            setup.statusline_request(args.iter().any(|arg| arg == "--take"))
        }
        Some("--mark-launch") => setup.mark_launch(),
        Some("--show") => setup.show(),
        first => {
            let mut terminal = create_prompter(&var);

            match first {
                Some("--uninstall") => setup.run_uninstall(&mut *terminal),
                Some("--set") => {
                    let word = |index: usize| args.get(index).map_or("", String::as_str);

                    setup.run_set(word(1), word(2), &mut *terminal)
                }
                _ => setup.run_setup(&args, &mut *terminal),
            }
        }
    }
}

pub fn run_uninstall_process(stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    let var = |name: &str| std::env::var_os(name);
    let mut setup = Setup::new(&var, stdout, stderr);
    let mut terminal = create_prompter(&var);

    setup.run_uninstall(&mut *terminal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::FakePrompter;

    const PLUGIN: &str = "telegram@better-claude-code-telegram";

    fn tampered_journal(file: &Path) -> Journal {
        let mut journal = Journal::new();

        std::fs::write(file, "{}").unwrap();
        journal.track_file(file).unwrap();
        journal.record(ChangeKind::ToolInstalled, PLUGIN, None);
        std::fs::write(file, r#"{"permissions":{"deny":5}}"#).unwrap();

        journal
    }

    #[test]
    fn a_change_that_cannot_be_described_ends_with_its_error() {
        let folder = tempfile::tempdir().unwrap();
        let settings = folder.path().join("settings.json");
        let var = |_: &str| None::<OsString>;
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = {
            let mut setup = Setup::new(&var, &mut out, &mut err);
            let mut ask = FakePrompter::new(true);

            setup.journal = tampered_journal(&settings);
            setup.run_interactive(&["modelo".to_owned()], &mut ask)
        };
        let err = String::from_utf8(err).unwrap();

        assert_eq!(code, FAILURE);
        assert!(err.contains("includes is not a function"), "{err}");
        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn what_was_left_that_cannot_be_described_ends_with_its_error() {
        let folder = tempfile::tempdir().unwrap();
        let settings = folder.path().join("settings.json");
        let var = |_: &str| None::<OsString>;
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let messages = messages_for(Locale::EnUs);
        let setup = Setup::new(&var, &mut out, &mut err);
        let target = settings.to_string_lossy().into_owned();
        let change = Change {
            kind: ChangeKind::FileChanged,
            target,
        };

        std::fs::write(&settings, r#"{"permissions":{"deny":5}}"#).unwrap();

        assert!(setup.described(&[change], messages).is_err());
    }

    struct Refusing;

    impl Write for Refusing {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn the_tracked_output_remembers_each_failure_and_writes_everything() {
        let mut written = Vec::new();
        let mut tracked = Tracked {
            inner: &mut written,
            failed: false,
        };

        tracked.write_all(b"abc").unwrap();
        tracked.flush().unwrap();
        assert!(!tracked.failed);
        assert_eq!(written, b"abc");

        let mut refusing = Refusing;
        let mut tracked = Tracked {
            inner: &mut refusing,
            failed: false,
        };

        assert!(tracked.flush().is_err());
        assert!(tracked.failed);

        let mut tracked = Tracked {
            inner: &mut refusing,
            failed: false,
        };

        assert!(tracked.write(b"x").is_err());
        assert!(tracked.failed);
    }

    #[test]
    fn the_final_check_is_a_step_but_cannot_be_asked_for() {
        assert_eq!(Section::Health.as_str(), "health");
        assert!(!SETUP_SECTIONS.contains(&Section::Health));
        assert!(parse_setup_sections(&["health".to_owned()], messages_for(Locale::EnUs)).is_err());
    }
}
