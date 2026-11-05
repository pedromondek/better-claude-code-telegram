pub mod config;
pub mod files;
pub mod health;
pub mod hook;
pub mod js;
pub mod launch;
pub mod locale;
pub mod messages;
pub mod paths;
pub mod prompt;
pub mod release;
pub mod setup;
pub mod spinner;
pub mod statusline;
pub mod telegram;
pub mod ui;

use std::ffi::OsString;
use std::io::{self, Write};
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
}

pub fn run<I, O, E>(args: I, stdout: &mut O, stderr: &mut E) -> ExitCode
where
    I: IntoIterator<Item = OsString>,
    O: Write,
    E: Write,
{
    match parse(args) {
        Ok(Command::Version) => {
            print_version(stdout).map_or(ExitCode::FAILURE, |()| ExitCode::SUCCESS)
        }
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
        Some(lexopt::Arg::Long("version") | lexopt::Arg::Short('V')) => Ok(Command::Version),
        Some(lexopt::Arg::Value(word)) if word == "release" => {
            Ok(Command::Release(first_word(parser.raw_args()?.next())))
        }
        Some(lexopt::Arg::Value(word)) if word == "launch" => {
            Ok(Command::Launch(parser.raw_args()?.collect()))
        }
        Some(lexopt::Arg::Value(word)) if word == "health" => {
            Ok(Command::Health(parser.raw_args()?.collect()))
        }
        Some(arg) => Err(arg.unexpected()),
        None => Err("missing subcommand".into()),
    }
}

fn first_word(word: Option<OsString>) -> Option<String> {
    word.map(|word| word.to_string_lossy().into_owned())
}

fn print_version<O: Write>(stdout: &mut O) -> io::Result<()> {
    writeln!(stdout, "bcct {}", env!("CARGO_PKG_VERSION"))?;
    stdout.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct BrokenPipe {
        accepts_writes: bool,
    }

    impl Write for BrokenPipe {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if self.accepts_writes {
                Ok(buf.len())
            } else {
                Err(io::ErrorKind::BrokenPipe.into())
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

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
    fn short_version_flag_prints_the_same_as_the_long_one() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let code = run(args(&["bcct", "-V"]), &mut stdout, &mut stderr);

        assert_eq!(code, ExitCode::SUCCESS);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            format!("bcct {}\n", env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(stderr, Vec::<u8>::new());
    }

    #[test]
    fn a_closed_stdout_ends_with_failure_instead_of_a_panic() {
        let mut stderr = Vec::new();
        let mut closed = BrokenPipe {
            accepts_writes: false,
        };

        let code = run(args(&["bcct", "--version"]), &mut closed, &mut stderr);

        assert_eq!(code, ExitCode::FAILURE);
    }

    #[test]
    fn a_stdout_that_fails_on_flush_also_ends_with_failure() {
        let mut stderr = Vec::new();
        let mut unflushable = BrokenPipe {
            accepts_writes: true,
        };

        let code = run(args(&["bcct", "--version"]), &mut unflushable, &mut stderr);

        assert_eq!(code, ExitCode::FAILURE);
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
