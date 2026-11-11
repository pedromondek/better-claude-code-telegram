#![cfg(unix)]
#![cfg(test)]

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use assert_cmd::Command;
use assert_cmd::cargo::cargo_bin_cmd;
use serde_json::{Value, json};
use tempfile::TempDir;

const QUESTION: &str = "Which database?";

struct Sandbox {
    root: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
        }
    }

    fn app(&self) -> PathBuf {
        self.root.path().join("app")
    }

    fn asks(&self) -> PathBuf {
        self.app().join("asks")
    }

    fn pings(&self) -> PathBuf {
        self.app().join("pings")
    }

    fn state(&self) -> PathBuf {
        self.root.path().join("state")
    }

    fn command(&self, mode: &str, telegram: bool) -> Command {
        let mut command = cargo_bin_cmd!("bcct");
        command
            .arg("hook")
            .arg(mode)
            .env_remove("BETTER_CC_TELEGRAM")
            .env_remove("BETTER_CC_TELEGRAM_DELAY_MS")
            .env_remove("CLAUDE_CONFIG_DIR")
            .env("HOME", self.root.path().join("home"))
            .env("TELEGRAM_STATE_DIR", self.state())
            .env("BETTER_CC_TELEGRAM_DIR", self.app())
            .timeout(Duration::from_secs(30));

        if telegram {
            command.env("BETTER_CC_TELEGRAM", "1");
        }

        command
    }
}

fn ask_input() -> Value {
    json!({
        "session_id": "s1",
        "cwd": "/home/dev/my-project",
        "tool_input": {
            "questions": [{
                "question": QUESTION,
                "header": "Database",
                "multiSelect": false,
                "options": [{"label": "Postgres"}, {"label": "Redis"}]
            }],
            "metadata": {"source": "test"}
        }
    })
}

const RECORD_SUFFIX: &str = ".json";

fn wait_for_record(asks: &Path) -> String {
    for _ in 0..500 {
        let found = fs::read_dir(asks).ok().and_then(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .find(|name| {
                    name.ends_with(RECORD_SUFFIX)
                        && !name.ends_with(".answer.json")
                        && !name.ends_with(".telegram.json")
                })
        });

        if let Some(name) = found
            && fs::read_to_string(asks.join(&name)).is_ok_and(|text| text.ends_with('}'))
        {
            return name.trim_end_matches(RECORD_SUFFIX).to_owned();
        }

        thread::sleep(Duration::from_millis(10));
    }

    panic!("the hook never wrote its request");
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

fn run_with_helper(
    command: &mut Command,
    stdin: &Value,
    helper: impl FnOnce() + Send,
) -> assert_cmd::assert::Assert {
    thread::scope(|scope| {
        let waiter = scope.spawn(helper);
        let assert = command.write_stdin(stdin.to_string()).assert();
        waiter.join().unwrap();
        assert
    })
}

#[test]
fn waits_for_the_answer_file_and_prints_the_decision_without_a_trailing_newline() {
    let sandbox = Sandbox::new();
    let asks = sandbox.asks();
    let started = now_ms();

    let assert = run_with_helper(
        &mut sandbox.command("permission", true),
        &ask_input(),
        || {
            let id = wait_for_record(&asks);
            thread::sleep(Duration::from_millis(100));
            fs::write(
                asks.join(format!("{id}.answer.json")),
                json!({"answers": {QUESTION: "Redis"}}).to_string(),
            )
            .unwrap();
        },
    );

    let expected = concat!(
        r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":"#,
        r#"{"questions":[{"question":"Which database?","header":"Database","multiSelect":false,"options":[{"label":"Postgres"},{"label":"Redis"}]}],"#,
        r#""metadata":{"source":"test"},"answers":{"Which database?":"Redis"}}}}}"#
    );
    assert.success().stdout(expected).stderr("");

    let name = fs::read_dir(&asks)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .find(|name| !name.contains("answer"))
        .unwrap();
    let record: Value =
        serde_json::from_str(&fs::read_to_string(asks.join(&name)).unwrap()).unwrap();
    let created = record["createdAt"].as_u64().unwrap();

    assert!(created >= started && created <= now_ms(), "{created}");
    assert_eq!(record["dueAt"].as_u64().unwrap(), created + 240_000);
    assert_eq!(record["id"], format!("s1-{created}"));
    assert_eq!(record["instance"], Value::Null);
}

#[test]
fn a_closed_file_ends_the_wait_without_output() {
    let sandbox = Sandbox::new();
    let asks = sandbox.asks();

    let assert = run_with_helper(
        &mut sandbox.command("permission", true),
        &ask_input(),
        || {
            let id = wait_for_record(&asks);
            fs::write(asks.join(format!("{id}.closed")), "").unwrap();
            fs::write(
                asks.join(format!("{id}.answer.json")),
                r#"{"answers":{"Q":"A"}}"#,
            )
            .unwrap();
        },
    );

    assert.success().stdout("").stderr("");
}

#[test]
fn a_removed_record_ends_the_wait_without_output() {
    let sandbox = Sandbox::new();
    let asks = sandbox.asks();

    let assert = run_with_helper(
        &mut sandbox.command("permission", true),
        &ask_input(),
        || {
            let id = wait_for_record(&asks);
            fs::remove_file(asks.join(format!("{id}.json"))).unwrap();
        },
    );

    assert.success().stdout("").stderr("");
}

#[test]
fn an_answer_that_is_not_an_object_is_ignored_until_a_valid_one_arrives() {
    let sandbox = Sandbox::new();
    let asks = sandbox.asks();

    let assert = run_with_helper(
        &mut sandbox.command("permission", true),
        &ask_input(),
        || {
            let id = wait_for_record(&asks);
            let answer = asks.join(format!("{id}.answer.json"));
            fs::write(&answer, r#"{"answers":"nope"}"#).unwrap();
            thread::sleep(Duration::from_millis(1300));
            fs::write(&answer, r#"{"answers":["a","b"]}"#).unwrap();
        },
    );

    assert
        .success()
        .stdout(predicates::str::contains(r#""answers":["a","b"]}}}}"#));
}

#[test]
fn invalid_stdin_leaves_no_trace_and_no_output() {
    let sandbox = Sandbox::new();

    sandbox
        .command("permission", true)
        .write_stdin("not json")
        .assert()
        .success()
        .stdout("")
        .stderr("");

    assert!(!sandbox.app().exists());
}

#[test]
fn an_unknown_or_missing_mode_does_nothing_and_exits_zero() {
    let sandbox = Sandbox::new();

    sandbox
        .command("bogus", true)
        .write_stdin(ask_input().to_string())
        .assert()
        .success()
        .stdout("")
        .stderr("");

    cargo_bin_cmd!("bcct")
        .arg("hook")
        .env_remove("BETTER_CC_TELEGRAM_DELAY_MS")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env("HOME", sandbox.root.path().join("home"))
        .env("BETTER_CC_TELEGRAM", "1")
        .env("BETTER_CC_TELEGRAM_DIR", sandbox.app())
        .write_stdin(ask_input().to_string())
        .assert()
        .success()
        .stdout("")
        .stderr("");

    assert!(!sandbox.app().exists());
}

#[test]
fn extra_arguments_after_the_mode_are_ignored() {
    let sandbox = Sandbox::new();

    sandbox
        .command("stop", true)
        .arg("--unknown")
        .arg("extra")
        .write_stdin(json!({"session_id": "s1", "last_assistant_message": "hi"}).to_string())
        .assert()
        .success()
        .stdout("")
        .stderr("");

    assert!(sandbox.pings().join("s1.json").exists());
}

#[test]
fn nothing_happens_without_the_telegram_flag_or_a_live_bot() {
    let sandbox = Sandbox::new();

    sandbox
        .command("stop", false)
        .write_stdin(json!({"session_id": "s1", "last_assistant_message": "hi"}).to_string())
        .assert()
        .success()
        .stdout("")
        .stderr("");

    assert!(!sandbox.app().exists());
}

#[test]
fn a_bot_pid_of_a_live_process_activates_the_hook_with_a_label() {
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.state()).unwrap();
    fs::write(
        sandbox.state().join("bot.pid"),
        std::process::id().to_string(),
    )
    .unwrap();

    sandbox
        .command("stop", false)
        .write_stdin(
            json!({
                "session_id": "abcdef",
                "cwd": "/x/proj",
                "last_assistant_message": "  waiting  "
            })
            .to_string(),
        )
        .assert()
        .success()
        .stdout("")
        .stderr("");

    let ping: Value =
        serde_json::from_str(&fs::read_to_string(sandbox.pings().join("abcdef.json")).unwrap())
            .unwrap();

    assert_eq!(ping["text"], "waiting");
    assert_eq!(ping["instance"], "proj#abcd");
    assert_eq!(ping["sessionId"], "abcdef");
    assert_eq!(
        ping["dueAt"].as_u64().unwrap(),
        ping["createdAt"].as_u64().unwrap() + 240_000
    );
}

#[test]
fn the_delay_variable_sets_the_deadline() {
    let sandbox = Sandbox::new();

    sandbox
        .command("stop", true)
        .env("BETTER_CC_TELEGRAM_DELAY_MS", "1500")
        .write_stdin(json!({"session_id": "s1", "last_assistant_message": "hi"}).to_string())
        .assert()
        .success();

    let ping: Value =
        serde_json::from_str(&fs::read_to_string(sandbox.pings().join("s1.json")).unwrap())
            .unwrap();

    assert_eq!(
        ping["dueAt"].as_u64().unwrap(),
        ping["createdAt"].as_u64().unwrap() + 1500
    );
}

#[test]
fn a_dead_bot_pid_keeps_the_hook_inactive() {
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.state()).unwrap();
    fs::write(sandbox.state().join("bot.pid"), "2147483646").unwrap();

    sandbox
        .command("stop", false)
        .write_stdin(json!({"session_id": "s1", "last_assistant_message": "hi"}).to_string())
        .assert()
        .success();

    assert!(!sandbox.app().exists());
}

#[test]
fn prompt_removes_the_ping_records_the_time_and_closes_the_asks_of_the_session() {
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.asks()).unwrap();
    fs::create_dir_all(sandbox.pings()).unwrap();
    fs::write(sandbox.pings().join("s1.json"), "{}").unwrap();
    fs::write(
        sandbox.asks().join("a.json"),
        r#"{"id":"a","sessionId":"s1"}"#,
    )
    .unwrap();
    fs::write(
        sandbox.asks().join("b.json"),
        r#"{"id":"b","sessionId":"s2"}"#,
    )
    .unwrap();
    let started = now_ms();

    sandbox
        .command("prompt", true)
        .write_stdin(json!({"session_id": "s1"}).to_string())
        .assert()
        .success()
        .stdout("")
        .stderr("");

    let last_prompt: u64 = fs::read_to_string(sandbox.pings().join("last-prompt"))
        .unwrap()
        .parse()
        .unwrap();

    assert!(!sandbox.pings().join("s1.json").exists());
    assert!(last_prompt >= started && last_prompt <= now_ms());
    assert!(sandbox.asks().join("a.closed").exists());
    assert!(!sandbox.asks().join("b.closed").exists());
}

#[test]
fn post_closes_the_asks_of_the_session() {
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.asks()).unwrap();
    fs::write(
        sandbox.asks().join("a.json"),
        r#"{"id":"a","sessionId":"s1"}"#,
    )
    .unwrap();

    sandbox
        .command("post", true)
        .write_stdin(json!({"session_id": "s1"}).to_string())
        .assert()
        .success()
        .stdout("")
        .stderr("");

    assert!(sandbox.asks().join("a.closed").exists());
}

fn set_mode(folder: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(folder, fs::Permissions::from_mode(mode)).unwrap();
}

fn failures(sandbox: &Sandbox) -> Value {
    serde_json::from_str(&fs::read_to_string(sandbox.app().join("hook-failures.json")).unwrap())
        .unwrap()
}

fn stdout_json(assert: &assert_cmd::assert::Assert) -> Value {
    serde_json::from_slice(&assert.get_output().stdout).unwrap()
}

#[test]
fn a_stop_that_cannot_write_warns_the_user_then_the_next_prompt_tells_claude_once() {
    let sandbox = Sandbox::new();
    let stop_input = json!({"session_id": "s1", "last_assistant_message": "done"}).to_string();
    let ping_file = sandbox.pings().join("s1.json");
    fs::create_dir_all(sandbox.pings()).unwrap();
    set_mode(&sandbox.pings(), 0o500);

    let stop = sandbox
        .command("stop", true)
        .write_stdin(stop_input.clone())
        .assert()
        .success()
        .stderr("");

    set_mode(&sandbox.pings(), 0o700);
    let warning = format!(
        "bcct: could not write {} (no write permission). Telegram messages may not arrive. Run /bcct:health.",
        ping_file.display()
    );

    assert_eq!(stdout_json(&stop), json!({ "systemMessage": warning }));

    let prompt = sandbox
        .command("prompt", true)
        .write_stdin(json!({"session_id": "s1"}).to_string())
        .assert()
        .success()
        .stderr("");

    assert_eq!(
        stdout_json(&prompt),
        json!({
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": format!(
                    "better-claude-code-telegram: the Stop hook failed: {}. Tell the user and recommend running /bcct:health.",
                    warning.trim_end_matches('.')
                )
            }
        })
    );

    sandbox
        .command("prompt", true)
        .write_stdin(json!({"session_id": "s1"}).to_string())
        .assert()
        .success()
        .stdout("");
    sandbox
        .command("stop", true)
        .write_stdin(stop_input)
        .assert()
        .success()
        .stdout("");

    assert!(ping_file.exists());
    assert_eq!(failures(&sandbox)["notices"], json!({}));
}

#[test]
fn a_prompt_that_cannot_write_warns_the_user_and_claude_in_the_same_reply() {
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.pings()).unwrap();
    fs::write(
        sandbox.app().join(bcct::paths::CONFIG_FILE),
        json!({"language": "pt-br"}).to_string(),
    )
    .unwrap();
    set_mode(&sandbox.pings(), 0o500);

    let prompt = sandbox
        .command("prompt", true)
        .write_stdin(json!({"session_id": "s1"}).to_string())
        .assert()
        .success()
        .stderr("");

    set_mode(&sandbox.pings(), 0o700);
    let file = sandbox.pings().join("last-prompt");

    assert_eq!(
        stdout_json(&prompt),
        json!({
            "systemMessage": format!(
                "bcct: não consegui gravar {} (sem permissão de escrita). As mensagens do Telegram podem não chegar. Rode /bcct:health.",
                file.display()
            ),
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": format!(
                    "better-claude-code-telegram: the UserPromptSubmit hook failed: bcct: could not write {} (no write permission). Telegram messages may not arrive. Run /bcct:health. Tell the user and recommend running /bcct:health.",
                    file.display()
                )
            }
        })
    );
}

#[test]
fn a_question_that_cannot_be_saved_warns_without_a_decision_and_without_waiting() {
    let sandbox = Sandbox::new();
    fs::create_dir_all(sandbox.asks()).unwrap();
    set_mode(&sandbox.asks(), 0o500);

    let permission = sandbox
        .command("permission", true)
        .write_stdin(ask_input().to_string())
        .assert()
        .success()
        .stderr("");

    set_mode(&sandbox.asks(), 0o700);
    let output = stdout_json(&permission);

    assert_eq!(output.as_object().unwrap().len(), 1);
    assert!(
        output["systemMessage"]
            .as_str()
            .unwrap()
            .starts_with(&format!(
                "bcct: could not write {}/",
                sandbox.asks().display()
            ))
    );
    assert_eq!(
        failures(&sandbox)["notices"]["PermissionRequest"]["reason"],
        json!("no-permission")
    );
}

#[test]
fn an_input_that_is_not_from_claude_code_warns_only_on_the_third_time() {
    let sandbox = Sandbox::new();
    let broken = json!({"session_id": 5}).to_string();

    for _ in 0..2 {
        sandbox
            .command("post", true)
            .write_stdin(broken.clone())
            .assert()
            .success()
            .stdout("")
            .stderr("");
    }

    let third = sandbox
        .command("post", true)
        .write_stdin(broken)
        .assert()
        .success()
        .stderr("");

    assert_eq!(
        stdout_json(&third),
        json!({
            "systemMessage": "bcct: the PostToolUse hook failed 3 times in 24 h (unexpected input from Claude Code). Run /bcct:health."
        })
    );
}

#[test]
fn a_closed_stdin_is_read_as_an_empty_input() {
    let sandbox = Sandbox::new();

    sandbox
        .command("post", true)
        .write_stdin("")
        .assert()
        .success()
        .stdout("")
        .stderr("");
}
