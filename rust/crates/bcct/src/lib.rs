use std::ffi::OsString;
use std::io::{self, Write};
use std::process::ExitCode;

const USAGE_ERROR: u8 = 2;

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Version,
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
    let mut parser = lexopt::Parser::from_iter(args);

    match parser.next()? {
        Some(lexopt::Arg::Long("version") | lexopt::Arg::Short('V')) => Ok(Command::Version),
        Some(arg) => Err(arg.unexpected()),
        None => Err("missing subcommand".into()),
    }
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
