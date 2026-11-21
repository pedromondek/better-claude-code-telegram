use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use crate::config::{js_to_number, read_config, read_locale};
use crate::files::read_json;
use crate::hook::{millis, now_ms};
use crate::js::{join_path, js_truthy, normalize_path};
use crate::messages::messages_for;
use crate::paths::{HEALTH_FILE, LAUNCH_FILE, PREVIOUS_STATUSLINE_FILE, Paths, TELEGRAM_FLAG};

pub const TELEGRAM_HEALTH_TTL_MS: f64 = 15_000.0;
pub const TELEGRAM_LAUNCH_GRACE_MS: f64 = 60_000.0;

const RESET: &str = "\u{1b}[0m";
const GREEN: &str = "\u{1b}[32m";
const RED: &str = "\u{1b}[31m";
const YELLOW: &str = "\u{1b}[33m";
const SEPARATOR: &str = " │ ";
const FAILURE: u8 = 1;

fn app_dir(var: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> std::path::PathBuf {
    normalize_path(&Paths::resolve(var, home).app_dir)
}

pub(crate) fn time_of(data: Option<&Value>, key: &str) -> f64 {
    match data {
        Some(Value::Object(map)) => map.get(key).map_or(f64::NAN, js_to_number),
        _ => f64::NAN,
    }
}

#[must_use]
pub fn telegram_segment(
    var: &dyn Fn(&str) -> Option<OsString>,
    home: &Path,
    now: u64,
) -> Option<String> {
    let app_dir = app_dir(var, home);
    let messages = messages_for(read_locale(&read_config(&app_dir)));
    let telegram_instance = var(TELEGRAM_FLAG).is_some_and(|flag| flag == "1");
    let role = if telegram_instance {
        messages.status_main
    } else {
        messages.status_secondary
    };
    let now = millis(now);
    let health = read_json(&join_path(&app_dir, HEALTH_FILE));
    let fresh = now - time_of(health.as_ref(), "checkedAt") < TELEGRAM_HEALTH_TTL_MS;

    if fresh
        && health
            .as_ref()
            .and_then(|health| health.get("polling"))
            .is_some_and(js_truthy)
    {
        return Some(format!(
            "{GREEN}{}{RESET}",
            (messages.status_connected)(role)
        ));
    }

    if !fresh && !telegram_instance {
        return None;
    }

    let launch = read_json(&join_path(&app_dir, LAUNCH_FILE));
    let launching = now - time_of(launch.as_ref(), "launchedAt") < TELEGRAM_LAUNCH_GRACE_MS;

    Some(if launching {
        format!("{YELLOW}{}{RESET}", (messages.status_connecting)(role))
    } else if fresh {
        format!("{RED}{}{RESET}", (messages.status_down)(role))
    } else {
        format!("{RED}{}{RESET}", (messages.status_down_here)(role))
    })
}

#[must_use]
pub fn join_statusline(previous: &str, segment: Option<&str>) -> String {
    let rows = previous.trim_end_matches('\n');

    match segment.filter(|segment| !segment.is_empty()) {
        None => rows.to_owned(),
        Some(segment) if rows.is_empty() => segment.to_owned(),
        Some(segment) => format!("{rows}{SEPARATOR}{segment}"),
    }
}

fn previous_output(app_dir: &Path, input: &[u8]) -> String {
    let previous = read_json(&join_path(app_dir, PREVIOUS_STATUSLINE_FILE));
    let Some(Value::String(command)) = previous.as_ref().and_then(|value| value.get("command"))
    else {
        return String::new();
    };
    let Ok(mut child) = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return String::new();
    };
    let stdin = child.stdin.take();

    std::thread::scope(|scope| {
        scope.spawn(move || {
            if let Some(mut stdin) = stdin {
                let _written = stdin.write_all(input);
            }
        });

        child
            .wait_with_output()
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default()
    })
}

fn read_stdin(stdin: &mut dyn Read) -> Vec<u8> {
    let mut bytes = Vec::new();

    match stdin.read_to_end(&mut bytes) {
        Ok(_) => String::from_utf8_lossy(&bytes).into_owned().into_bytes(),
        Err(_) => Vec::new(),
    }
}

pub fn render(
    after_previous: bool,
    var: &dyn Fn(&str) -> Option<OsString>,
    home: &Path,
    now: u64,
    stdin: &mut dyn Read,
) -> String {
    let segment = telegram_segment(var, home, now);

    if !after_previous {
        return segment.unwrap_or_default();
    }

    let input = read_stdin(stdin);

    join_statusline(
        &previous_output(&app_dir(var, home), &input),
        segment.as_deref(),
    )
}

pub fn show(
    out: &str,
    var: &dyn Fn(&str) -> Option<OsString>,
    home: &Path,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> u8 {
    if stdout
        .write_all(out.as_bytes())
        .and_then(|()| stdout.flush())
        .is_ok()
    {
        return 0;
    }

    let messages = messages_for(read_locale(&read_config(&app_dir(var, home))));
    let _written = stderr.write_all(format!("{}\n", messages.statusline_not_shown).as_bytes());

    FAILURE
}

pub fn run_process(after_previous: bool, stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    let home = std::env::home_dir().unwrap_or_default();
    let var = |name: &str| std::env::var_os(name);
    let out = render(
        after_previous,
        &var,
        &home,
        now_ms(),
        &mut io::stdin().lock(),
    );

    show(&out, &var, &home, stdout, stderr)
}
