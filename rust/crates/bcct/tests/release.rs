#![cfg(unix)]
#![cfg(test)]

mod support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::files::FileFailure;
use bcct::release::{headers_of, release_pending_asks, run};
use serde_json::{Value, json};
use support::{
    default_file_mode, environment, expected_tree, home, list, lookup, materialize, parse,
    placeholders, sandbox, snapshot, text,
};

const FIXTURE: &str = include_str!("fixtures/release.json");

#[test]
fn every_scenario_prints_and_leaves_the_same_files_as_release_mjs() {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();
    let scenarios = list(&fixture, "scenarios");

    assert!(scenarios.len() > 90);

    for scenario in scenarios {
        let name = text(scenario, "name");
        let root = sandbox();
        materialize(root.path(), &scenario["files"]);
        let variables = environment(&scenario["env"], root.path());
        let prefix = scenario["args"]
            .as_array()
            .unwrap()
            .first()
            .map(|arg| arg.as_str().unwrap());
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let code = run(
            prefix,
            &lookup(&variables),
            &home(&variables),
            now,
            &mut stdout,
            &mut stderr,
        );

        assert_eq!(json!(code), scenario["status"], "{name}: status");
        assert_eq!(text(scenario, "stderr"), "", "{name}: stderr");
        assert_eq!(stderr, Vec::<u8>::new(), "{name}: stderr");
        assert_eq!(
            placeholders(&String::from_utf8(stdout).unwrap(), root.path()),
            text(scenario, "stdout"),
            "{name}: stdout"
        );
        assert_eq!(
            snapshot(root.path()),
            with_approved_surrogate(expected_tree(&scenario["after"], None, &default_mode)),
            "{name}: files"
        );
    }
}

fn with_approved_surrogate(tree: support::Tree) -> support::Tree {
    tree.into_iter()
        .map(|(path, (content, mode))| {
            (
                path,
                (
                    content.map(|body| body.replace("\\ud83d", "\u{fffd}")),
                    mode,
                ),
            )
        })
        .collect()
}

#[test]
fn the_released_records_are_the_ones_read_before_the_new_due_time() {
    let root = sandbox();
    let asks = root.path().join("asks");
    fs::create_dir(&asks).unwrap();
    fs::write(asks.join("a.json"), r#"{"id":"a","dueAt":200,"x":1}"#).unwrap();

    let released = release_pending_asks(root.path(), "", 100).unwrap();

    assert_eq!(released, vec![json!({"id": "a", "dueAt": 200, "x": 1})]);
    assert_eq!(
        fs::read_to_string(asks.join("a.json")).unwrap(),
        r#"{"id":"a","dueAt":100,"x":1,"released":true}"#
    );
}

#[test]
fn a_record_that_cannot_be_written_stops_the_release_with_an_error() {
    let root = sandbox();
    let asks = root.path().join("asks");
    fs::create_dir(&asks).unwrap();
    fs::write(asks.join("a.json"), r#"{"id":"a","dueAt":200}"#).unwrap();
    fs::set_permissions(&asks, fs::Permissions::from_mode(0o500)).unwrap();

    let result = release_pending_asks(root.path(), "", 100);
    fs::set_permissions(&asks, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(result, Err(FileFailure::NotSaved(asks.join("a.json"))));
    assert_eq!(
        fs::read_to_string(asks.join("a.json")).unwrap(),
        r#"{"id":"a","dueAt":200}"#
    );
}

fn read_only_release(language: Option<&str>) -> (u8, String, String, String) {
    let root = sandbox();
    let asks = root.path().join("asks");
    fs::create_dir(&asks).unwrap();
    fs::write(asks.join("a.json"), r#"{"id":"a","dueAt":200}"#).unwrap();
    if let Some(language) = language {
        fs::write(
            root.path().join("better-cc-telegram.json"),
            json!({ "language": language }).to_string(),
        )
        .unwrap();
    }
    fs::set_permissions(&asks, fs::Permissions::from_mode(0o500)).unwrap();
    let variables = std::collections::HashMap::from([(
        "BETTER_CC_TELEGRAM_DIR".to_owned(),
        root.path().as_os_str().to_owned(),
    )]);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    let code = run(
        None,
        &lookup(&variables),
        root.path(),
        100,
        &mut stdout,
        &mut stderr,
    );
    fs::set_permissions(&asks, fs::Permissions::from_mode(0o700)).unwrap();

    (
        code,
        String::from_utf8(stdout).unwrap(),
        String::from_utf8(stderr).unwrap(),
        asks.join("a.json").display().to_string(),
    )
}

#[test]
fn a_record_that_cannot_be_written_is_named_on_stderr_in_the_configured_language() {
    let (code, stdout, stderr, file) = read_only_release(None);

    assert_eq!(code, 1);
    assert_eq!(stdout, "");
    assert_eq!(stderr, format!("Could not save {file}.\n"));

    let (code, _, stderr, file) = read_only_release(Some("pt-br"));

    assert_eq!(code, 1);
    assert_eq!(stderr, format!("Não foi possível gravar {file}.\n"));
}

#[test]
fn the_headers_join_the_truthy_header_or_question_of_each_question() {
    assert_eq!(
        headers_of(
            &json!({"questions": [{"header": "A"}, {"question": "B"}, {"header": 0}, null]})
        ),
        "A, B"
    );
    assert_eq!(headers_of(&json!({"questions": "x"})), "");
    assert_eq!(headers_of(&Value::Null), "");
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

fn release(root: &std::path::Path) -> assert_cmd::Command {
    let mut command = cargo_bin_cmd!("bcct");
    command
        .arg("release")
        .env_clear()
        .envs(support::coverage_env())
        .env("HOME", root.join("home"))
        .env("BETTER_CC_TELEGRAM_DIR", root.join("app"))
        .timeout(Duration::from_secs(30));
    command
}

#[test]
fn the_binary_releases_a_pending_question_now_and_lists_it() {
    let root = sandbox();
    let asks = root.path().join("app/asks");
    fs::create_dir_all(&asks).unwrap();
    fs::write(
        asks.join("a.json"),
        json!({"id": "a", "sessionId": "abc", "dueAt": now_ms() + 600_000, "instance": "p", "questions": [{"header": "H"}]})
            .to_string(),
    )
    .unwrap();
    let before = now_ms();

    release(root.path())
        .arg(" ab ")
        .assert()
        .success()
        .stdout("Released the question from [p]: H\n")
        .stderr("");

    let record: Value =
        serde_json::from_str(&fs::read_to_string(asks.join("a.json")).unwrap()).unwrap();
    let due = record["dueAt"].as_u64().unwrap();
    assert!((before..=now_ms()).contains(&due));
    assert_eq!(
        fs::metadata(asks.join("a.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn the_binary_says_nothing_is_pending_for_another_prefix() {
    let root = sandbox();

    release(root.path())
        .arg("zzz")
        .assert()
        .success()
        .stdout("No pending question from session zzz.\n");
}

#[test]
fn the_binary_fails_with_code_1_and_names_the_record_it_could_not_write() {
    let root = sandbox();
    let asks = root.path().join("app/asks");
    fs::create_dir_all(&asks).unwrap();
    fs::write(
        asks.join("a.json"),
        json!({"id": "a", "dueAt": now_ms() + 600_000}).to_string(),
    )
    .unwrap();
    fs::set_permissions(&asks, fs::Permissions::from_mode(0o500)).unwrap();

    let assert = release(root.path()).assert();
    fs::set_permissions(&asks, fs::Permissions::from_mode(0o700)).unwrap();

    assert.code(1).stdout("").stderr(format!(
        "Could not save {}.\n",
        asks.join("a.json").display()
    ));
}

#[test]
fn the_binary_ignores_a_closed_stdout_like_console_log() {
    let root = sandbox();

    let status = std::process::Command::new(assert_cmd::cargo::cargo_bin!("bcct"))
        .arg("release")
        .env("BETTER_CC_TELEGRAM_DIR", root.path())
        .stdout(std::process::Stdio::from(
            fs::OpenOptions::new()
                .write(true)
                .open("/dev/full")
                .unwrap(),
        ))
        .status()
        .unwrap();

    assert_eq!(status.code(), Some(0));
}
