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
const INPUT_WAITS: [&str; 5] = [
    "do_epoll_wait",
    "ep_poll",
    "do_sys_poll",
    "do_select",
    "n_tty_read",
];
const TERMINAL_WAIT: &str = "wait_woken";
const STDIN_ARGUMENT: &str = "0x0";
#[cfg(target_arch = "x86_64")]
const READ_SYSCALL: &str = "0";
#[cfg(target_arch = "aarch64")]
const READ_SYSCALL: &str = "63";

#[derive(Debug, Clone)]
pub(crate) enum Step {
    Key(Vec<u8>),
    Resize(u16),
    Pause(u64),
    When(Vec<u8>, Vec<u8>),
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Redirect<'a> {
    File(&'a Path),
    Unwritable,
}

#[derive(Debug)]
pub(crate) struct Run<'a> {
    pub(crate) argv: &'a [String],
    pub(crate) env: &'a [(String, String)],
    pub(crate) columns: u16,
    pub(crate) rows: u16,
    pub(crate) steps: &'a [Step],
    pub(crate) redirect: Option<Redirect<'a>>,
}

#[cfg(target_os = "linux")]
fn unwritable_script(size: &str) -> String {
    format!("{size} && exec \"$0\" \"$@\" > '/dev/full'")
}

#[cfg(not(target_os = "linux"))]
fn unwritable_script(size: &str) -> String {
    format!("{size} && {{ sleep 1; exec \"$0\" \"$@\"; }} | true")
}

#[cfg(target_os = "macos")]
pub(crate) const JOB_SHELL: &str = "zsh";
#[cfg(target_os = "macos")]
pub(crate) const JOB_FLAGS: &[&str] = &["-f", "-i", "-c"];
#[cfg(target_os = "macos")]
pub(crate) const JOB_CONTROL: &str = "setopt monitor";
#[cfg(target_os = "macos")]
pub(crate) const STOPPED_STATUS: i32 = 146;
#[cfg(not(target_os = "macos"))]
pub(crate) const JOB_SHELL: &str = "bash";
#[cfg(not(target_os = "macos"))]
pub(crate) const JOB_FLAGS: &[&str] = &["-c"];
#[cfg(not(target_os = "macos"))]
pub(crate) const JOB_CONTROL: &str = "set -m";
#[cfg(not(target_os = "macos"))]
pub(crate) const STOPPED_STATUS: i32 = 148;

pub(crate) fn job_argv(script: &str, program: &str) -> Vec<String> {
    std::iter::once(JOB_SHELL)
        .chain(JOB_FLAGS.iter().copied())
        .chain([script, program])
        .map(str::to_owned)
        .collect()
}

fn process_tree(root: i32) -> String {
    let Ok(output) = Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,pgid=,tpgid=,stat=,comm="])
        .output()
    else {
        return String::new();
    };
    let table = String::from_utf8_lossy(&output.stdout);
    let rows: Vec<(&str, &str, &str)> = table
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (child, rest) = line.split_once(' ')?;
            let (parent, _) = rest.trim_start().split_once(' ')?;

            Some((child, parent, line))
        })
        .collect();
    let mut tree = vec![root.to_string()];
    let mut grown = true;

    while grown {
        grown = false;

        for (child, parent, _) in &rows {
            if tree.iter().any(|known| known == parent) && !tree.iter().any(|known| known == child)
            {
                tree.push((*child).to_owned());
                grown = true;
            }
        }
    }

    rows.iter()
        .filter(|(child, _, _)| tree.iter().any(|known| known == child))
        .map(|(_, _, line)| *line)
        .collect::<Vec<_>>()
        .join(" | ")
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

fn reading_stdin(thread: &Path) -> bool {
    let Ok(call) = std::fs::read_to_string(thread.join("syscall")) else {
        return true;
    };
    let mut fields = call.split_whitespace();

    fields.next() == Some(READ_SYSCALL) && fields.next() == Some(STDIN_ARGUMENT)
}

fn thread_listens(thread: &Path) -> bool {
    let Ok(wchan) = std::fs::read_to_string(thread.join("wchan")) else {
        return false;
    };
    let wchan = wchan.trim();

    INPUT_WAITS.contains(&wchan) || (wchan == TERMINAL_WAIT && reading_stdin(thread))
}

fn waiting_for_input(pid: i32) -> bool {
    let Ok(threads) = std::fs::read_dir(format!("/proc/{}/task", innermost(pid))) else {
        return true;
    };

    threads
        .filter_map(Result::ok)
        .any(|thread| thread_listens(&thread.path()))
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

fn wait_for_output_after(
    session: &mut PtySession,
    out: &mut Vec<u8>,
    length: usize,
) -> io::Result<()> {
    let started = Instant::now();

    while out.len() <= length {
        if pump(session, out)?.is_none() {
            return Err(fail("the program in the terminal ended before the redraw"));
        }

        if started.elapsed() > LIMIT {
            return Err(fail("the terminal never redrew after the resize"));
        }

        thread::sleep(POLL);
    }

    Ok(())
}

fn command_of(run: &Run<'_>) -> io::Result<Command> {
    let size = format!("read -r _ && stty cols {} rows {}", run.columns, run.rows);
    let script = match run.redirect {
        None => format!("{size} && exec \"$0\" \"$@\""),
        Some(Redirect::File(path)) => format!(
            "{size} && exec \"$0\" \"$@\" > '{}'",
            path.to_string_lossy()
        ),
        Some(Redirect::Unwritable) => unwritable_script(&size),
    };
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
    session.write_all(b"\n")?;
    session.flush()?;

    let mut out = Vec::new();
    let blind = run.redirect.is_some();
    let ready = if blind { &[][..] } else { START };
    let mut drawn_from: Option<usize> = None;

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
                drawn_from = Some(out.len());
                session.write_all(bytes)?;
                session.flush()?;
            }
            Step::Resize(columns) => {
                if let Some(length) = drawn_from.take().filter(|_| !blind) {
                    wait_for_output_after(&mut session, &mut out, length)?;
                }

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
            return Err(fail(&format!(
                "the program in the terminal did not end; it showed: {:?}; processes: {}",
                String::from_utf8_lossy(&out),
                process_tree(session.get_process().pid().as_raw())
            )));
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
