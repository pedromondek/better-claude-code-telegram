pub mod changes;
pub mod config;
pub mod files;
pub mod health;
pub mod health_fix;
pub mod hook;
pub mod hook_failures;
pub mod install;
pub mod journal;
pub mod js;
pub mod launch;
pub mod locale;
pub mod messages;
pub mod paths;
pub mod prompt;
pub mod release;
pub mod self_install;
pub mod settings;
pub mod setup;
pub mod setup_ask;
pub mod setup_files;
pub mod setup_run;
pub mod setup_telegram;
pub mod shell_rc;
pub mod signals;
pub mod spinner;
pub mod statusline;
pub mod telegram;
pub mod ui;
pub mod update;

use std::ffi::OsString;
use std::io::Write;
use std::process::ExitCode;

const USAGE_ERROR: u8 = 2;
const AFTER_PREVIOUS: &str = "--after-previous";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Version,
    Hook(Option<String>),
    Statusline(bool),
    Release(Option<String>),
    Launch(Vec<OsString>),
    Health(Vec<OsString>),
    Setup(Vec<OsString>),
    Uninstall,
    UninstallVersion(String),
    SelfInstall(Vec<OsString>),
    Update(Vec<OsString>),
}

const VERSION_FLAGS: [&str; 5] = ["-v", "-V", "-version", "--version", "--v"];

pub fn run<I, O, E>(args: I, stdout: &mut O, stderr: &mut E) -> ExitCode
where
    I: IntoIterator<Item = OsString>,
    O: Write,
    E: Write,
{
    match parse(args) {
        Ok(Command::Version) => self_install::run_version_process(stdout, stderr)
            .map_or(ExitCode::FAILURE, |()| ExitCode::SUCCESS),
        Ok(Command::Hook(mode)) => {
            hook::run_process(mode.as_deref(), stdout);
            ExitCode::SUCCESS
        }
        Ok(Command::Statusline(after_previous)) => {
            ExitCode::from(statusline::run_process(after_previous, stdout, stderr))
        }
        Ok(Command::Release(prefix)) => {
            ExitCode::from(release::run_process(prefix.as_deref(), stdout, stderr))
        }
        Ok(Command::Launch(args)) => ExitCode::from(launch::run_process(&args, stderr)),
        Ok(Command::Health(args)) => ExitCode::from(health::run_process(&args, stdout, stderr)),
        Ok(Command::Setup(args)) => ExitCode::from(setup_run::run_process(&args, stdout, stderr)),
        Ok(Command::Uninstall) => ExitCode::from(setup_run::run_uninstall_process(stdout, stderr)),
        Ok(Command::UninstallVersion(version)) => {
            ExitCode::from(self_install::run_remove_process(&version, stdout, stderr))
        }
        Ok(Command::SelfInstall(args)) => {
            ExitCode::from(self_install::run_process(&args, stdout, stderr))
        }
        Ok(Command::Update(args)) => ExitCode::from(update::run_process(&args, stdout, stderr)),
        Err(error) => {
            let _written = writeln!(stderr, "bcct: {error}");
            ExitCode::from(USAGE_ERROR)
        }
    }
}

fn parse<I>(args: I) -> Result<Command, lexopt::Error>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    let program = args.next();
    let word = args.next();

    match word.as_ref().and_then(|word| word.to_str()) {
        Some(flag) if VERSION_FLAGS.contains(&flag) => return Ok(Command::Version),
        Some("hook") => return Ok(Command::Hook(first_word(args.next()))),
        Some("statusline") => {
            return Ok(Command::Statusline(
                args.next().is_some_and(|flag| flag == AFTER_PREVIOUS),
            ));
        }
        _ => {}
    }

    let mut parser = lexopt::Parser::from_iter(program.into_iter().chain(word).chain(args));

    match parser.next()? {
        Some(lexopt::Arg::Value(word)) if word == "release" => {
            Ok(Command::Release(first_word(parser.raw_args()?.next())))
        }
        Some(lexopt::Arg::Value(word)) if word == "launch" => {
            Ok(Command::Launch(parser.raw_args()?.collect()))
        }
        Some(lexopt::Arg::Value(word)) if word == "health" => {
            Ok(Command::Health(parser.raw_args()?.collect()))
        }
        Some(lexopt::Arg::Value(word)) if word == "setup" => {
            Ok(Command::Setup(parser.raw_args()?.collect()))
        }
        Some(lexopt::Arg::Value(word)) if word == "uninstall" => {
            let version = first_word(parser.raw_args()?.next())
                .filter(|version| semver::Version::parse(version).is_ok());

            Ok(version.map_or(Command::Uninstall, Command::UninstallVersion))
        }
        Some(lexopt::Arg::Value(word)) if word == "self-install" => {
            Ok(Command::SelfInstall(parser.raw_args()?.collect()))
        }
        Some(lexopt::Arg::Value(word)) if word == "update" => {
            Ok(Command::Update(parser.raw_args()?.collect()))
        }
        Some(arg) => Err(arg.unexpected()),
        None => Err("missing subcommand".into()),
    }
}

fn first_word(word: Option<OsString>) -> Option<String> {
    word.map(|word| word.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn the_hook_subcommand_takes_the_first_following_word_as_its_mode() {
        let mode = |list: &[&str]| parse(args(list)).unwrap();

        assert_eq!(
            mode(&["bcct", "hook", "post"]),
            Command::Hook(Some("post".to_owned()))
        );
        assert_eq!(
            mode(&["bcct", "hook", "--odd", "x"]),
            Command::Hook(Some("--odd".to_owned()))
        );
        assert_eq!(mode(&["bcct", "hook"]), Command::Hook(None));
        assert!(parse(args(&["bcct", "hooks"])).is_err());
    }

    #[test]
    fn the_statusline_chains_only_when_the_first_word_is_after_previous() {
        let parsed = |list: &[&str]| parse(args(list)).unwrap();

        assert_eq!(
            parsed(&["bcct", "statusline", "--after-previous", "x"]),
            Command::Statusline(true)
        );
        assert_eq!(
            parsed(&["bcct", "statusline", "x", "--after-previous"]),
            Command::Statusline(false)
        );
        assert_eq!(parsed(&["bcct", "statusline"]), Command::Statusline(false));
    }

    #[test]
    fn release_takes_the_first_word_and_launch_keeps_every_argument() {
        let parsed = |list: &[&str]| parse(args(list)).unwrap();

        assert_eq!(
            parsed(&["bcct", "release", "ab", "cd"]),
            Command::Release(Some("ab".to_owned()))
        );
        assert_eq!(parsed(&["bcct", "release"]), Command::Release(None));
        assert_eq!(
            parsed(&["bcct", "launch", "--", "-c", "x"]),
            Command::Launch(args(&["--", "-c", "x"]))
        );
        assert_eq!(parsed(&["bcct", "launch"]), Command::Launch(Vec::new()));
        assert_eq!(
            parsed(&["bcct", "health", "--json", "x"]),
            Command::Health(args(&["--json", "x"]))
        );
        assert_eq!(parsed(&["bcct", "--version"]), Command::Version);
    }

    #[test]
    fn setup_keeps_every_argument_and_uninstall_ignores_them() {
        let parsed = |list: &[&str]| parse(args(list)).unwrap();

        assert_eq!(
            parsed(&["bcct", "setup", "--check", "--", "x"]),
            Command::Setup(args(&["--check", "--", "x"]))
        );
        assert_eq!(parsed(&["bcct", "setup"]), Command::Setup(Vec::new()));
        assert_eq!(parsed(&["bcct", "uninstall", "x"]), Command::Uninstall);
        assert_eq!(parsed(&["bcct", "uninstall"]), Command::Uninstall);
        assert_eq!(
            parsed(&["bcct", "uninstall", "0.3.0-beta.1", "x"]),
            Command::UninstallVersion("0.3.0-beta.1".to_owned())
        );
    }

    #[test]
    fn update_keeps_every_argument() {
        let parsed = |list: &[&str]| parse(args(list)).unwrap();

        assert_eq!(
            parsed(&["bcct", "update", "beta", "--check"]),
            Command::Update(args(&["beta", "--check"]))
        );
        assert_eq!(parsed(&["bcct", "update"]), Command::Update(Vec::new()));
    }

    #[test]
    fn every_version_flag_is_the_same_command() {
        for flag in VERSION_FLAGS {
            assert_eq!(parse(args(&["bcct", flag])).unwrap(), Command::Version);
        }

        assert!(parse(args(&["bcct", "-x"])).is_err());
    }

    #[test]
    fn a_missing_subcommand_is_reported_on_stderr() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let code = run(args(&["bcct"]), &mut stdout, &mut stderr);

        assert_eq!(code, ExitCode::from(USAGE_ERROR));
        assert_eq!(stdout, Vec::<u8>::new());
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "bcct: missing subcommand\n"
        );
    }
}
