#![cfg(unix)]
#![cfg(test)]

mod support;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::launch::{CHANNEL, CHANNEL_SETTINGS, Launch, claude_args};
use bcct::setup::{
    SetupPaths, check_setup, mark_launch, missing_setup_steps, skipped_permissions,
    statusline_prompt, telegram_instance_running,
};
use bcct::ui::{colors_available, fail, should_colorize};
use serde_json::{Value, json};
use support::{
    Helper, Tree, app_form, app_placeholder, dead_pid, default_file_mode, environment,
    expected_tree, home, list, lookup, materialize, parse, placeholders, sandbox, snapshot,
    strings, text,
};

const FIXTURE: &str = include_str!("fixtures/launch.json");
const CLAUDE_ARGS: &str = "claude-args";
const CLAUDE_ENV: &str = "claude-env";
const CLAUDE_ERR: &str = "claude err\n";

struct Pids {
    server: Helper,
    plain: Helper,
    dead: String,
}

impl Pids {
    fn start() -> Self {
        Self {
            server: Helper::start("server.ts"),
            plain: Helper::start("other.ts"),
            dead: dead_pid(),
        }
    }

    fn fill(&self, text: &str) -> String {
        text.replace("{server}", &self.server.pid())
            .replace("{plain}", &self.plain.pid())
            .replace("{dead}", &self.dead)
    }

    fn hide(&self, text: &str) -> String {
        let text = whole_number_replaced(text, &self.server.pid(), "{server}");

        whole_number_replaced(&text, &self.plain.pid(), "{plain}")
    }
}

fn whole_number_replaced(text: &str, number: &str, placeholder: &str) -> String {
    let is_digit = |found: Option<char>| found.is_some_and(|character| character.is_ascii_digit());
    let mut replaced = String::with_capacity(text.len());
    let mut copied = 0;

    for (at, _) in text.match_indices(number) {
        let before = text.get(..at).and_then(|head| head.chars().next_back());
        let after = text
            .get(at + number.len()..)
            .and_then(|tail| tail.chars().next());

        if is_digit(before) || is_digit(after) {
            continue;
        }

        replaced.push_str(text.get(copied..at).unwrap_or_default());
        replaced.push_str(placeholder);
        copied = at + number.len();
    }

    replaced.push_str(text.get(copied..).unwrap_or_default());
    replaced
}

#[test]
fn hides_a_pid_only_where_it_is_a_whole_number() {
    assert_eq!(
        whole_number_replaced("{\"launchedAt\":1763712345678}", "12345", "{server}"),
        "{\"launchedAt\":1763712345678}"
    );
    assert_eq!(
        whole_number_replaced("12345\npid 12345, 123456 and 12345", "12345", "{server}"),
        "{server}\npid {server}, 123456 and {server}"
    );
    assert_eq!(
        whole_number_replaced("no pid here", "12345", "{server}"),
        "no pid here"
    );
}

#[test]
fn the_missing_steps_match_missing_setup_steps() {
    let fixture = parse(FIXTURE);
    let entries = list(&fixture, "missing");

    assert!(entries.len() > 200);

    for entry in entries {
        let root = sandbox();
        materialize(root.path(), &entry["files"]);

        let out: Vec<&str> = missing_setup_steps(&root.path().join("state"))
            .into_iter()
            .map(bcct::setup::SetupStep::as_str)
            .collect();

        assert_eq!(json!(out), entry["out"], "{}", entry["files"]);
    }
}

#[test]
fn the_skipped_permission_matches_skipped_permissions() {
    let fixture = parse(FIXTURE);

    for entry in list(&fixture, "permissions") {
        let args = strings(&entry["args"]);
        let settings = Some(&entry["settings"]).filter(|settings| !settings.is_null());

        assert_eq!(
            skipped_permissions(&args, settings).map_or(Value::Null, Value::String),
            entry["out"],
            "{entry}"
        );
    }
}

#[test]
fn the_running_instance_matches_telegram_instance_running() {
    let fixture = parse(FIXTURE);
    let pids = Pids::start();

    for entry in list(&fixture, "running") {
        let root = sandbox();

        if let Some(pid_text) = entry["pidText"].as_str() {
            fs::create_dir(root.path().join("state")).unwrap();
            fs::write(root.path().join("state/bot.pid"), pids.fill(pid_text)).unwrap();
        }

        let out = telegram_instance_running(&root.path().join("state"))
            .map_or(Value::Null, |pid| Value::String(pids.hide(&pid)));

        assert_eq!(out, entry["out"], "{entry}");
    }
}

fn variables_of(entry: &Value, root: &Path) -> HashMap<String, OsString> {
    environment(&entry["env"], root)
}

fn app_entry(entry: &Value, root: &Path) -> Value {
    let variables = variables_of(entry, root);
    let var = lookup(&variables);
    let paths = SetupPaths::resolve(&var, &home(&variables));

    app_form(entry, &app_placeholder(&paths.app_dir, root))
}

#[test]
fn every_check_refuses_with_the_same_message_as_check_setup() {
    let fixture = parse(FIXTURE);

    for entry in list(&fixture, "checks") {
        let name = text(entry, "name");
        let root = sandbox();
        materialize(root.path(), &entry["files"]);
        let variables = variables_of(entry, root.path());
        let var = lookup(&variables);
        let paths = SetupPaths::resolve(&var, &home(&variables));
        let running = entry["running"].as_str().map(str::to_owned);

        let refusal = check_setup(&paths, &var, &strings(&entry["args"]), &|_| running.clone());
        let stderr = refusal
            .as_deref()
            .map(|message| format!("{}\n", fail(message, should_colorize(&var, false))))
            .unwrap_or_default();

        assert_eq!(
            json!(i32::from(refusal.is_some())),
            entry["code"],
            "{name}: code"
        );
        assert_eq!(
            placeholders(&stderr, root.path()),
            text(entry, "stderr"),
            "{name}: stderr"
        );
    }
}

#[test]
fn every_mark_leaves_the_same_launch_file_as_mark_launch() {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();

    for entry in list(&fixture, "marks") {
        let name = text(entry, "name");
        let root = sandbox();
        materialize(root.path(), &entry["files"]);

        let result = mark_launch(&root.path().join("claude/better-claude-code-telegram"), now);

        assert_eq!(
            result.is_err(),
            entry["threw"].as_bool().unwrap(),
            "{name}: threw"
        );
        assert_eq!(
            snapshot(root.path()),
            expected_tree(&entry["after"], Some(&entry["written"]), &default_mode),
            "{name}: files"
        );
    }
}

#[test]
fn every_prompt_and_its_files_match_statusline_prompt() {
    let fixture = parse(FIXTURE);
    let default_mode = default_file_mode();

    for entry in list(&fixture, "prompts") {
        let name = text(entry, "name");
        let root = sandbox();
        let entry = &app_entry(entry, root.path());
        materialize(root.path(), &entry["files"]);
        let variables = variables_of(entry, root.path());
        let var = lookup(&variables);
        let paths = SetupPaths::resolve(&var, &home(&variables));

        let result = statusline_prompt(entry["take"].as_bool().unwrap(), &paths, &var);

        assert_eq!(
            result.is_err(),
            entry["threw"].as_bool().unwrap(),
            "{name}: threw"
        );
        assert_eq!(
            result.map_or(Value::Null, |out| Value::String(placeholders(
                &out,
                root.path()
            ))),
            entry["out"],
            "{name}: out"
        );
        assert_eq!(
            snapshot(root.path()),
            expected_tree(&entry["after"], Some(&entry["written"]), &default_mode),
            "{name}: files"
        );
    }
}

#[test]
fn the_colors_follow_the_node_color_depth_and_force_color() {
    let fixture = parse(FIXTURE);
    let entries = list(&fixture, "colors");

    assert!(entries.len() > 100);

    for entry in entries {
        let variables: HashMap<String, OsString> = entry["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| (name.clone(), OsString::from(value.as_str().unwrap())))
            .collect();
        let var = lookup(&variables);
        let colors = entry["colors"].as_bool().unwrap();
        let forced = variables.contains_key("FORCE_COLOR");

        assert_eq!(colors_available(&var), colors, "{entry}");
        assert_eq!(should_colorize(&var, true), colors, "{entry}: tty");
        assert_eq!(
            should_colorize(&var, false),
            forced && colors,
            "{entry}: pipe"
        );
    }
}

#[test]
fn the_failure_line_is_red_only_when_asked() {
    assert_eq!(fail("x", false), "✘ x");
    assert_eq!(fail("x", true), "\u{1b}[31m✘ x\u{1b}[39m");
    assert_eq!(
        fail("a\u{1b}[39mb\u{1b}[39m", true),
        "\u{1b}[31m✘ a\u{1b}[31mb\u{1b}[39m\u{1b}[39m"
    );
}

fn claude_call(call: &[OsString]) -> String {
    call.iter()
        .map(|arg| arg.to_string_lossy() + "\0")
        .collect()
}

fn without_claude_files(tree: &Value) -> Value {
    let mut map = tree.as_object().unwrap().clone();
    map.remove(CLAUDE_ARGS);
    map.remove(CLAUDE_ENV);
    Value::Object(map)
}

fn prepared(entry: &Value, root: &Path, pids: &Pids) {
    materialize(root, &entry["files"]);

    for (path, spec) in entry["files"].as_object().unwrap() {
        if spec
            .as_str()
            .is_some_and(|content| content.contains("{server}"))
        {
            fs::write(root.join(path), pids.fill(spec.as_str().unwrap())).unwrap();
        }
    }
}

fn hidden_tree(tree: Tree, pids: &Pids) -> Tree {
    tree.into_iter()
        .map(|(path, (content, mode))| (path, (content.map(|body| pids.hide(&body)), mode)))
        .collect()
}

#[test]
fn every_launch_builds_the_same_claude_call_as_telegram_sh() {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();
    let pids = Pids::start();

    for entry in list(&fixture, "launches") {
        let name = text(entry, "name");
        let root = sandbox();
        let entry = &app_entry(entry, root.path());
        prepared(entry, root.path(), &pids);
        let variables = variables_of(entry, root.path());
        let var = lookup(&variables);
        let args: Vec<OsString> = strings(&entry["args"])
            .into_iter()
            .map(OsString::from)
            .collect();
        let launch = Launch {
            var: &var,
            home: &home(&variables),
            now,
            is_running: &telegram_instance_running,
            colorize: should_colorize(&var, false),
        };
        let mut stderr = Vec::new();

        let call = claude_args(&args, &launch, &mut stderr);
        let stderr = pids.hide(&placeholders(
            &String::from_utf8(stderr).unwrap(),
            root.path(),
        ));
        let after = &entry["after"];

        if let Some(call) = &call {
            assert_eq!(
                placeholders(&claude_call(call), root.path()),
                text(&after[CLAUDE_ARGS], "content"),
                "{name}: claude arguments"
            );
            assert_eq!(
                format!("{stderr}{CLAUDE_ERR}"),
                text(entry, "stderr"),
                "{name}: stderr"
            );
        } else {
            assert_eq!(entry["status"], json!(1), "{name}: status");
            assert_eq!(stderr, text(entry, "stderr"), "{name}: stderr");
            assert!(after.get(CLAUDE_ARGS).is_none(), "{name}: claude ran");
        }

        assert_eq!(
            hidden_tree(snapshot(root.path()), &pids),
            expected_tree(&without_claude_files(after), None, &default_mode),
            "{name}: files"
        );
    }
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

fn with_fixed_launch_time(tree: Tree, now: u64, window: (u64, u64)) -> Tree {
    tree.into_iter()
        .map(|(path, (content, mode))| {
            let content = content.map(|body| {
                if !path.ends_with("launch.json") {
                    return body;
                }

                let value: Value = serde_json::from_str(&body).unwrap();
                let launched = value["launchedAt"].as_u64().unwrap();
                assert!((window.0..=window.1).contains(&launched), "{path}: {body}");
                body.replace(&launched.to_string(), &now.to_string())
            });

            (path, (content, mode))
        })
        .collect()
}

#[test]
fn every_launch_of_the_binary_runs_claude_like_telegram_sh() {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();
    let pids = Pids::start();

    for entry in list(&fixture, "launches") {
        let name = text(entry, "name");
        let root = sandbox();
        let entry = &app_entry(entry, root.path());
        prepared(entry, root.path(), &pids);
        let mut command = cargo_bin_cmd!("bcct");
        command
            .arg("launch")
            .args(strings(&entry["args"]))
            .env_clear()
            .envs(support::coverage_env())
            .envs(variables_of(entry, root.path()))
            .env(
                "PATH",
                format!("{}/bin:/usr/bin:/bin", root.path().display()),
            )
            .current_dir(root.path())
            .timeout(Duration::from_secs(30));
        let before = now_ms();

        let output = command.output().unwrap();
        let after = now_ms();

        assert_eq!(
            json!(output.status.code()),
            entry["status"],
            "{name}: status"
        );
        assert_eq!(
            placeholders(&String::from_utf8(output.stdout).unwrap(), root.path()),
            text(entry, "stdout"),
            "{name}: stdout"
        );
        assert_eq!(
            pids.hide(&placeholders(
                &String::from_utf8(output.stderr).unwrap(),
                root.path()
            )),
            text(entry, "stderr"),
            "{name}: stderr"
        );
        assert_eq!(
            with_fixed_launch_time(
                hidden_tree(snapshot(root.path()), &pids),
                now,
                (before, after)
            ),
            expected_tree(&entry["after"], None, &default_mode),
            "{name}: files"
        );
    }
}

fn ready(root: &Path) {
    fs::create_dir_all(root.join("state")).unwrap();
    fs::write(root.join("state/.env"), "TELEGRAM_BOT_TOKEN=1\n").unwrap();
    fs::write(root.join("state/access.json"), r#"{"allowFrom":["1"]}"#).unwrap();
}

fn launcher(root: &Path, path: &str) -> assert_cmd::Command {
    let mut command = cargo_bin_cmd!("bcct");
    command
        .arg("launch")
        .env_clear()
        .envs(support::coverage_env())
        .env("HOME", root.join("home"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env("TELEGRAM_STATE_DIR", root.join("state"))
        .env("PATH", path)
        .timeout(Duration::from_secs(30));
    command
}

#[test]
fn a_missing_claude_ends_with_code_127_after_noting_the_launch() {
    let root = sandbox();
    ready(root.path());
    fs::create_dir(root.path().join("bin")).unwrap();

    let output = launcher(root.path(), &format!("{}/bin", root.path().display()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(127));
    assert!(String::from_utf8_lossy(&output.stderr).contains("claude"));
    assert!(
        root.path()
            .join("claude/better-claude-code-telegram/launch.json")
            .exists()
    );
}

#[test]
fn a_claude_that_cannot_run_ends_with_code_126() {
    let root = sandbox();
    ready(root.path());
    fs::create_dir(root.path().join("bin")).unwrap();
    fs::write(root.path().join("bin/claude"), "not a program").unwrap();

    let output = launcher(root.path(), &format!("{}/bin", root.path().display()))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(126));
}

fn launch_with(root: &Path, colorize: bool) -> (Option<Vec<OsString>>, String) {
    launch_args(root, colorize, &[])
}

fn launch_args(root: &Path, colorize: bool, args: &[&str]) -> (Option<Vec<OsString>>, String) {
    let variables = HashMap::from([
        ("HOME".to_owned(), root.join("home").into_os_string()),
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            root.join("claude").into_os_string(),
        ),
        (
            "TELEGRAM_STATE_DIR".to_owned(),
            root.join("state").into_os_string(),
        ),
    ]);
    let var = lookup(&variables);
    let launch = Launch {
        var: &var,
        home: &root.join("home"),
        now: 1,
        is_running: &|_| None,
        colorize,
    };
    let mut stderr = Vec::new();
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();

    let call = claude_args(&args, &launch, &mut stderr);

    assert!(format!("{launch:?}").starts_with("Launch {"));
    (
        call,
        placeholders(&String::from_utf8(stderr).unwrap(), root),
    )
}

fn plain_call() -> Vec<OsString> {
    [
        "--name",
        "telegram",
        "--settings",
        CHANNEL_SETTINGS,
        "--dangerously-load-development-channels",
        CHANNEL,
    ]
    .map(OsString::from)
    .to_vec()
}

const APP: &str = "claude/better-claude-code-telegram";

#[test]
fn the_telegram_flag_of_the_shell_function_never_reaches_claude() {
    let root = sandbox();
    ready(root.path());

    let mut expected = plain_call();
    expected.extend(["-c", "--model", "opus"].map(OsString::from));

    assert_eq!(
        launch_args(
            root.path(),
            false,
            &["--telegram", "-c", "--telegram", "--model", "opus"]
        ),
        (Some(expected), String::new())
    );
}

#[test]
fn a_launch_with_only_the_telegram_flag_still_asks_for_the_custom_statusline() {
    let root = sandbox();
    with_request(root.path());
    fs::write(
        root.path().join(APP).join("statusline-customize.json"),
        "{}",
    )
    .unwrap();

    let (call, stderr) = launch_args(root.path(), false, &["--telegram"]);
    let call = call.unwrap();

    assert_eq!(stderr, "");
    assert_eq!(call.len(), plain_call().len() + 1);
    assert!(
        call[2].to_string_lossy().contains(&format!(
            "\"{}/{APP}/bin/bcct\" statusline",
            root.path().display()
        )),
        "{call:?}"
    );
}

#[test]
fn a_launch_file_that_cannot_be_written_is_named_and_does_not_stop_claude() {
    let root = sandbox();
    ready(root.path());
    fs::create_dir(root.path().join("claude")).unwrap();
    fs::write(root.path().join(APP), "x").unwrap();

    assert_eq!(
        launch_with(root.path(), false),
        (
            Some(plain_call()),
            format!("✘ Could not save {{root}}/{APP}/launch.json.\n")
        )
    );
    assert_eq!(
        launch_with(root.path(), true).1,
        format!("\u{1b}[31m✘ Could not save {{root}}/{APP}/launch.json.\u{1b}[39m\n")
    );
}

fn with_request(root: &Path) {
    ready(root);
    fs::create_dir_all(root.join(APP)).unwrap();
    fs::write(
        root.join("claude/settings.json"),
        r#"{"statusLine":{"command":"mine.sh"}}"#,
    )
    .unwrap();
}

#[test]
fn a_request_that_cannot_be_removed_is_named_and_claude_opens_without_it() {
    let root = sandbox();
    with_request(root.path());
    fs::create_dir(root.path().join(APP).join("statusline-customize.json")).unwrap();

    assert_eq!(
        launch_with(root.path(), false),
        (
            Some(plain_call()),
            format!("✘ Could not remove {{root}}/{APP}/statusline-customize.json.\n")
        )
    );

    fs::write(
        root.path().join(APP).join("better-cc-telegram.json"),
        r#"{"language":"pt-br"}"#,
    )
    .unwrap();

    assert_eq!(
        launch_with(root.path(), false).1,
        format!("✘ Não foi possível remover {{root}}/{APP}/statusline-customize.json.\n")
    );
}

#[test]
fn a_config_that_cannot_be_saved_is_named_and_claude_opens_without_the_request() {
    let root = sandbox();
    with_request(root.path());
    fs::write(
        root.path().join(APP).join("statusline-customize.json"),
        "{}",
    )
    .unwrap();
    fs::create_dir(root.path().join(APP).join("better-cc-telegram.json")).unwrap();

    assert_eq!(
        launch_with(root.path(), false),
        (
            Some(plain_call()),
            format!("✘ Could not save {{root}}/{APP}/better-cc-telegram.json.\n")
        )
    );
    assert!(
        !root
            .path()
            .join(APP)
            .join("statusline-customize.json")
            .exists()
    );
}

#[test]
fn a_refusal_that_cannot_be_written_still_refuses() {
    struct Closed;

    impl std::io::Write for Closed {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
    }

    let root = sandbox();
    let variables = HashMap::new();
    let var = lookup(&variables);
    let launch = Launch {
        var: &var,
        home: root.path(),
        now: 1,
        is_running: &|_| None,
        colorize: false,
    };

    assert_eq!(claude_args(&[], &launch, &mut Closed), None);
}
