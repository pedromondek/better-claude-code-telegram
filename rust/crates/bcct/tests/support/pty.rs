#![allow(
    dead_code,
    reason = "the recorder example and the terminal tests use different parts"
)]

use std::io::{self, ErrorKind, Write};
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use expectrl::Session;

pub(crate) const START: &[u8] = b"<<<";
pub(crate) const END: &[u8] = b">>>";
pub(crate) const COLOR_VARIABLES: [&str; 11] = [
    "NO_COLOR",
    "FORCE_COLOR",
    "NODE_DISABLE_COLORS",
    "COLORTERM",
    "TMUX",
    "CI",
    "TERM_PROGRAM",
    "TEAMCITY_VERSION",
    "TF_BUILD",
    "WSL_DISTRO_NAME",
    "WT_SESSION",
];

const QUIET: Duration = Duration::from_millis(250);
const BLIND_START: Duration = Duration::from_millis(1000);
const POLL: Duration = Duration::from_millis(10);
const LIMIT: Duration = Duration::from_secs(60);
const BUFFER: usize = 4096;
const STOPPED_STATE: &str = "T";
const ZOMBIE_STATE: &str = "Z";
const INPUT_WAITS: [&str; 6] = [
    "do_epoll_wait",
    "ep_poll",
    "do_sys_poll",
    "do_select",
    "n_tty_read",
    "wait_woken",
];

#[derive(Debug, Clone)]
pub(crate) enum Step {
    Key(Vec<u8>),
    Resize(u16),
    Pause(u64),
    When(Vec<u8>, Vec<u8>),
}

#[derive(Debug)]
pub(crate) struct Run<'a> {
    pub(crate) argv: &'a [String],
    pub(crate) env: &'a [(String, String)],
    pub(crate) columns: u16,
    pub(crate) rows: u16,
    pub(crate) steps: &'a [Step],
    pub(crate) redirect: Option<&'a Path>,
}

fn fail(message: &str) -> io::Error {
    io::Error::other(message.to_owned())
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

type PtySession = expectrl::session::OsSession;

fn pump(session: &mut PtySession, out: &mut Vec<u8>) -> io::Result<Option<usize>> {
    let mut buffer = [0; BUFFER];

    match session.try_read(&mut buffer) {
        Ok(0) => Ok(None),
        Ok(read) => {
            out.extend_from_slice(buffer.get(..read).unwrap_or_default());
            Ok(Some(read))
        }
        Err(error) if error.kind() == ErrorKind::WouldBlock => Ok(Some(0)),
        Err(error) if error.raw_os_error() == Some(5) => Ok(None),
        Err(error) => Err(error),
    }
}

fn state_of(pid: i32) -> Option<String> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, rest) = status.rsplit_once(')')?;

    rest.split_whitespace().next().map(str::to_owned)
}

fn innermost(pid: i32) -> i32 {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .ok()
        .and_then(|children| {
            children
                .split_whitespace()
                .filter_map(|child| child.parse().ok())
                .rfind(|child| {
                    !matches!(
                        state_of(*child).as_deref(),
                        Some(ZOMBIE_STATE | STOPPED_STATE)
                    )
                })
        })
        .map_or(pid, innermost)
}

fn thread_waits(pid: i32) -> Option<Vec<String>> {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .ok()?
        .map(|thread| {
            std::fs::read_to_string(thread.ok()?.path().join("wchan"))
                .ok()
                .map(|wchan| wchan.trim().to_owned())
        })
        .collect()
}

fn waiting_for_input(pid: i32) -> bool {
    let Some(waits) = thread_waits(innermost(pid)) else {
        return true;
    };

    waits
        .iter()
        .any(|wait| INPUT_WAITS.contains(&wait.as_str()))
}

fn settle(
    session: &mut PtySession,
    out: &mut Vec<u8>,
    ready: &[u8],
    blind: bool,
    before_a_key: bool,
) -> io::Result<bool> {
    let started = Instant::now();
    let mut last = Instant::now();
    let pid = session.get_process().pid().as_raw();

    loop {
        match pump(session, out)? {
            None => return Ok(false),
            Some(0) => {}
            Some(_) => last = Instant::now(),
        }

        let waited = !blind || started.elapsed() >= BLIND_START;

        let listening = !before_a_key || waiting_for_input(pid);

        if waited && contains(out, ready) && last.elapsed() >= QUIET && listening {
            return Ok(true);
        }

        if started.elapsed() > LIMIT {
            return Err(fail("the program in the terminal did not settle"));
        }

        thread::sleep(POLL);
    }
}

fn wait_for(session: &mut PtySession, out: &mut Vec<u8>, needle: &[u8]) -> io::Result<()> {
    let started = Instant::now();

    while !contains(out, needle) {
        if pump(session, out)?.is_none() {
            return Err(fail("the program in the terminal ended before the text"));
        }

        if started.elapsed() > LIMIT {
            return Err(fail("the text never showed up in the terminal"));
        }

        thread::sleep(POLL);
    }

    Ok(())
}

fn command_of(run: &Run<'_>) -> io::Result<Command> {
    let redirect = run
        .redirect
        .map(|path| format!(" > '{}'", path.to_string_lossy()))
        .unwrap_or_default();
    let script = format!(
        "stty cols {} rows {} && exec \"$0\" \"$@\"{redirect}",
        run.columns, run.rows
    );
    let (program, args) = run.argv.split_first().ok_or_else(|| fail("no program"))?;
    let mut command = Command::new("sh");

    command.arg("-c").arg(script).arg(program).args(args);

    for name in COLOR_VARIABLES {
        command.env_remove(name);
    }

    command.env("TERM", "xterm-256color");
    command.envs(run.env.iter().map(|(name, value)| (name, value)));
    Ok(command)
}

pub(crate) fn record(run: &Run<'_>) -> io::Result<Vec<u8>> {
    let mut session = Session::spawn(command_of(run)?).map_err(|error| fail(&error.to_string()))?;

    session
        .get_process_mut()
        .set_window_size(run.columns, run.rows)
        .map_err(|error| fail(&error.to_string()))?;

    let mut out = Vec::new();
    let blind = run.redirect.is_some();
    let ready = if blind { &[][..] } else { START };

    for step in run.steps {
        if let Step::When(needle, bytes) = step {
            wait_for(&mut session, &mut out, needle)?;
            session.write_all(bytes)?;
            session.flush()?;
            continue;
        }

        let before_a_key = matches!(step, Step::Key(_));

        if !settle(&mut session, &mut out, ready, blind, before_a_key)? {
            return Err(fail("the program in the terminal ended before every key"));
        }

        match step {
            Step::When(..) => {}
            Step::Key(bytes) => {
                session.write_all(bytes)?;
                session.flush()?;
            }
            Step::Resize(columns) => {
                session
                    .get_process_mut()
                    .set_window_size(*columns, run.rows)
                    .map_err(|error| fail(&error.to_string()))?;
            }
            Step::Pause(milliseconds) => thread::sleep(Duration::from_millis(*milliseconds)),
        }
    }

    let started = Instant::now();

    while pump(&mut session, &mut out)?.is_some() {
        if started.elapsed() > LIMIT {
            return Err(fail("the program in the terminal did not end"));
        }

        thread::sleep(POLL);
    }

    Ok(out)
}

pub(crate) fn between(text: &[u8]) -> Option<(&[u8], &[u8])> {
    let start = text
        .windows(START.len())
        .position(|window| window == START)?
        + START.len();
    let rest = text.get(start..)?;
    let end = rest.windows(END.len()).position(|window| window == END)?;
    let after = rest.get(end + END.len()..)?;
    let line_end = after
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap_or(after.len());

    Some((rest.get(..end)?, after.get(..line_end)?))
}
