use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    bcct::run(std::env::args_os(), &mut io::stdout(), &mut io::stderr())
}
