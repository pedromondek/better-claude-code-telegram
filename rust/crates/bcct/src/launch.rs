use std::ffi::OsString;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::process::Command;

use crate::files::FileFailure;
use crate::hook::now_ms;
use crate::messages::messages_for;
use crate::setup::{
    SetupPaths, check_setup, mark_launch, repo_root, setup_locale, statusline_prompt,
    telegram_instance_running,
};
use crate::ui::{fail, should_colorize};

pub const CHANNEL_SETTINGS: &str =
    r#"{"enabledPlugins":{"telegram@better-claude-code-telegram":true}}"#;
pub const CHANNEL: &str = "plugin:telegram@better-claude-code-telegram";

const CLAUDE: &str = "claude";
const INSTANCE_NAME: [&str; 2] = ["--name", "telegram"];
const TELEGRAM_FLAG: &str = "BETTER_CC_TELEGRAM";
const REFUSED: u8 = 1;
#[cfg(unix)]
const COMMAND_NOT_FOUND: u8 = 127;
#[cfg(unix)]
const COMMAND_NOT_EXECUTABLE: u8 = 126;

pub struct Launch<'a> {
    pub var: &'a dyn Fn(&str) -> Option<OsString>,
    pub home: &'a Path,
    pub now: u64,
    pub is_running: &'a dyn Fn(&Path) -> Option<String>,
    pub repo: &'a Path,
    pub colorize: bool,
}

impl std::fmt::Debug for Launch<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Launch")
            .field("home", &self.home)
            .field("now", &self.now)
            .field("repo", &self.repo)
            .field("colorize", &self.colorize)
            .finish_non_exhaustive()
    }
}

fn only_flags(args: &[OsString]) -> bool {
    args.iter()
        .all(|arg| arg.as_encoded_bytes().first() == Some(&b'-'))
}

pub fn claude_args(
    args: &[OsString],
    launch: &Launch<'_>,
    stderr: &mut dyn Write,
) -> Option<Vec<OsString>> {
    let paths = SetupPaths::resolve(launch.var, launch.home);
    let text_args: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    let report = |stderr: &mut dyn Write, text: &str| {
        let _written = stderr.write_all(format!("{}\n", fail(text, launch.colorize)).as_bytes());
    };
    let report_failure = |stderr: &mut dyn Write, failure: &FileFailure| {
        report(
            stderr,
            &failure.message(messages_for(setup_locale(&paths.app_dir, launch.var))),
        );
    };

    if let Some(refusal) = check_setup(&paths, launch.var, &text_args, launch.is_running) {
        report(stderr, &refusal);
        return None;
    }

    if let Err(failure) = mark_launch(&paths.app_dir, launch.now) {
        report_failure(stderr, &failure);
    }

    let mut call: Vec<OsString> = INSTANCE_NAME.map(OsString::from).to_vec();

    if only_flags(args) {
        match statusline_prompt(true, &paths, launch.var, launch.repo) {
            Ok(request) if !request.trim_end_matches('\n').is_empty() => {
                call.push(OsString::from(request.trim_end_matches('\n')));
            }
            Ok(_) => {}
            Err(failure) => report_failure(stderr, &failure),
        }
    }

    call.extend(
        [
            "--settings",
            CHANNEL_SETTINGS,
            "--dangerously-load-development-channels",
            CHANNEL,
        ]
        .map(OsString::from),
    );
    call.extend(args.iter().cloned());

    Some(call)
}

fn replace_process(command: &mut Command, stderr: &mut dyn Write) -> u8 {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let error = command.exec();
        let _written = stderr.write_all(format!("bcct: exec: {CLAUDE}: {error}\n").as_bytes());

        if error.kind() == io::ErrorKind::NotFound {
            COMMAND_NOT_FOUND
        } else {
            COMMAND_NOT_EXECUTABLE
        }
    }

    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => status
                .code()
                .and_then(|code| u8::try_from(code).ok())
                .unwrap_or(REFUSED),
            Err(error) => {
                let _written = stderr.write_all(format!("bcct: {CLAUDE}: {error}\n").as_bytes());
                REFUSED
            }
        }
    }
}

pub fn run_process(args: &[OsString], stderr: &mut dyn Write) -> u8 {
    let home = std::env::home_dir().unwrap_or_default();
    let var = |name: &str| std::env::var_os(name);
    let repo = repo_root();
    let launch = Launch {
        var: &var,
        home: &home,
        now: now_ms(),
        is_running: &telegram_instance_running,
        repo: &repo,
        colorize: should_colorize(&var, io::stderr().is_terminal()),
    };
    let Some(call) = claude_args(args, &launch, stderr) else {
        return REFUSED;
    };
    let mut command = Command::new(CLAUDE);
    command.args(call).env(TELEGRAM_FLAG, "1");

    replace_process(&mut command, stderr)
}
