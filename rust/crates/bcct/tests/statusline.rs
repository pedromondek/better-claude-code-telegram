#![cfg(unix)]
#![cfg(test)]

mod support;

use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::statusline::{
    TELEGRAM_HEALTH_TTL_MS, TELEGRAM_LAUNCH_GRACE_MS, join_statusline, render, show,
    telegram_segment,
};
use serde_json::{Value, json};
use support::{
    environment, expected_tree, home, list, lookup, materialize, parse, sandbox, snapshot, text,
};

const FIXTURE: &str = include_str!("fixtures/statusline.json");

fn stdin_of(spec: &Value) -> Vec<u8> {
    if let Some(content) = spec.as_str() {
        return content.as_bytes().to_vec();
    }

    if let Some(unit) = spec.get("repeat").and_then(Value::as_str) {
        let count = usize::try_from(spec["count"].as_u64().unwrap()).unwrap();
        return unit.repeat(count).into_bytes();
    }

    spec["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
        .collect()
}

#[test]
fn the_time_limits_are_the_same_as_the_javascript_ones() {
    let fixture = parse(FIXTURE);

    assert_eq!(
        TELEGRAM_HEALTH_TTL_MS,
        fixture["healthTtlMs"].as_f64().unwrap()
    );
    assert_eq!(
        TELEGRAM_LAUNCH_GRACE_MS,
        fixture["launchGraceMs"].as_f64().unwrap()
    );
}

#[test]
fn every_scenario_prints_byte_for_byte_what_statusline_mjs_prints() {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let scenarios = list(&fixture, "scenarios");

    assert!(scenarios.len() > 200);

    for scenario in scenarios {
        let name = text(scenario, "name");
        let root = sandbox();
        materialize(root.path(), &scenario["files"]);
        let variables = environment(&scenario["env"], root.path());
        let after_previous =
            scenario["args"].as_array().unwrap().first() == Some(&json!("--after-previous"));
        let stdin = stdin_of(&scenario["stdin"]);

        let out = render(
            after_previous,
            &lookup(&variables),
            &home(&variables),
            now,
            &mut stdin.as_slice(),
        );

        assert_eq!(scenario["status"], json!(0), "{name}: status");
        assert_eq!(text(scenario, "stderr"), "", "{name}: stderr");
        assert_eq!(
            support::placeholders(&out, root.path()),
            text(scenario, "stdout"),
            "{name}: stdout"
        );
        assert_eq!(
            snapshot(root.path()),
            expected_tree(&scenario["after"], None, "644"),
            "{name}: files"
        );
    }
}

#[test]
fn the_segment_is_nothing_for_a_secondary_without_health() {
    let root = sandbox();
    let variables = std::collections::HashMap::from([(
        "BETTER_CC_TELEGRAM_DIR".to_owned(),
        root.path().as_os_str().to_owned(),
    )]);

    assert_eq!(telegram_segment(&lookup(&variables), root.path(), 0), None);
}

#[test]
fn joining_keeps_the_rows_and_drops_only_the_trailing_newlines() {
    assert_eq!(join_statusline("a\n\n", Some("s")), "a │ s");
    assert_eq!(join_statusline("a\r\n", Some("s")), "a\r │ s");
    assert_eq!(join_statusline("\n\n", Some("s")), "s");
    assert_eq!(join_statusline("", Some("s")), "s");
    assert_eq!(join_statusline("a\nb\n", None), "a\nb");
    assert_eq!(join_statusline("", None), "");
    assert_eq!(join_statusline("a", Some("")), "a");
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

fn statusline(root: &std::path::Path) -> assert_cmd::Command {
    let mut command = cargo_bin_cmd!("bcct");
    command
        .arg("statusline")
        .env_clear()
        .envs(support::coverage_env())
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", root.join("home"))
        .env("BETTER_CC_TELEGRAM_DIR", root.join("app"))
        .timeout(Duration::from_secs(30));
    command
}

#[test]
fn the_binary_paints_a_fresh_polling_health_green_without_a_newline() {
    let root = sandbox();
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(
        root.path().join("app/health.json"),
        json!({"checkedAt": now_ms(), "polling": true}).to_string(),
    )
    .unwrap();

    statusline(root.path())
        .env("BETTER_CC_TELEGRAM", "1")
        .assert()
        .success()
        .stdout("\u{1b}[32m📱 (Main) Telegram connected\u{1b}[0m")
        .stderr("");
}

#[test]
fn the_binary_shows_connecting_right_after_a_launch_and_nothing_for_a_stale_secondary() {
    let root = sandbox();
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(
        root.path().join("app/launch.json"),
        json!({"launchedAt": now_ms()}).to_string(),
    )
    .unwrap();

    statusline(root.path())
        .env("BETTER_CC_TELEGRAM", "1")
        .assert()
        .success()
        .stdout("\u{1b}[33m📱 (Main) Telegram connecting…\u{1b}[0m");
    statusline(root.path()).assert().success().stdout("");
}

#[test]
fn the_binary_runs_the_previous_status_line_with_the_same_input_and_environment() {
    let root = sandbox();
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(
        root.path().join("app/statusline-previous.json"),
        json!({"type": "command", "command": "cat; printf ' %s\\n' \"$BETTER_CC_TELEGRAM\""})
            .to_string(),
    )
    .unwrap();

    statusline(root.path())
        .arg("--after-previous")
        .env("BETTER_CC_TELEGRAM", "1")
        .write_stdin("{\"model\":\"x\"}")
        .assert()
        .success()
        .stdout("{\"model\":\"x\"} 1 │ \u{1b}[31m📱 (Main) Telegram down · type /mcp reconnect all\u{1b}[0m")
        .stderr("");
}

#[test]
fn an_unreadable_input_reaches_the_previous_status_line_as_nothing() {
    struct Unreadable;

    impl std::io::Read for Unreadable {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    let root = sandbox();
    fs::write(
        root.path().join("statusline-previous.json"),
        json!({"command": "printf '[%s]' \"$(cat)\""}).to_string(),
    )
    .unwrap();
    let variables = std::collections::HashMap::from([(
        "BETTER_CC_TELEGRAM_DIR".to_owned(),
        root.path().as_os_str().to_owned(),
    )]);

    assert_eq!(
        render(true, &lookup(&variables), root.path(), 0, &mut Unreadable),
        "[]"
    );
}

#[test]
fn without_sh_on_the_path_the_previous_status_line_prints_nothing() {
    let root = sandbox();
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(
        root.path().join("app/statusline-previous.json"),
        json!({"command": "printf mine"}).to_string(),
    )
    .unwrap();

    statusline(root.path())
        .arg("--after-previous")
        .env("PATH", root.path())
        .env("BETTER_CC_TELEGRAM", "1")
        .assert()
        .success()
        .stdout("\u{1b}[31m📱 (Main) Telegram down · type /mcp reconnect all\u{1b}[0m");
}

#[test]
fn the_binary_ignores_the_previous_status_line_without_the_flag() {
    let root = sandbox();
    fs::create_dir(root.path().join("app")).unwrap();
    fs::write(
        root.path().join("app/statusline-previous.json"),
        json!({"command": "printf mine"}).to_string(),
    )
    .unwrap();

    statusline(root.path())
        .arg("--other")
        .env("BETTER_CC_TELEGRAM", "1")
        .assert()
        .success()
        .stdout("\u{1b}[31m📱 (Main) Telegram down · type /mcp reconnect all\u{1b}[0m");
}

#[test]
fn the_binary_ends_with_code_1_like_node_when_stdout_cannot_take_the_segment() {
    let root = sandbox();

    let output = std::process::Command::new(assert_cmd::cargo::cargo_bin!("bcct"))
        .arg("statusline")
        .env("BETTER_CC_TELEGRAM_DIR", root.path())
        .env("BETTER_CC_TELEGRAM", "1")
        .stdout(std::process::Stdio::from(
            fs::OpenOptions::new()
                .write(true)
                .open("/dev/full")
                .unwrap(),
        ))
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "Could not show the status line.\n"
    );
}

struct Closed;

impl std::io::Write for Closed {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Err(std::io::ErrorKind::BrokenPipe.into())
    }
}

#[test]
fn a_segment_that_cannot_be_shown_is_reported_once_in_the_configured_language() {
    let root = sandbox();
    let variables = std::collections::HashMap::from([(
        "BETTER_CC_TELEGRAM_DIR".to_owned(),
        root.path().as_os_str().to_owned(),
    )]);
    let mut stderr = Vec::new();

    assert_eq!(
        show(
            "x",
            &lookup(&variables),
            root.path(),
            &mut Closed,
            &mut stderr
        ),
        1
    );
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        "Could not show the status line.\n"
    );

    fs::write(
        root.path().join("better-cc-telegram.json"),
        json!({"language": "pt-br"}).to_string(),
    )
    .unwrap();
    let mut stderr = Vec::new();

    assert_eq!(
        show(
            "x",
            &lookup(&variables),
            root.path(),
            &mut Closed,
            &mut stderr
        ),
        1
    );
    assert_eq!(
        String::from_utf8(stderr).unwrap(),
        "Não foi possível mostrar a statusline.\n"
    );

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    assert_eq!(
        show(
            "x",
            &lookup(&variables),
            root.path(),
            &mut stdout,
            &mut stderr
        ),
        0
    );
    assert_eq!(stdout, b"x");
    assert_eq!(stderr, Vec::<u8>::new());
}
