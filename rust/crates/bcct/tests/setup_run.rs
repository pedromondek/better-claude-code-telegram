#![cfg(unix)]
#![cfg(test)]

mod support;

#[path = "support/pty.rs"]
mod pty;

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use bcct::install::{CommandsChoice, TranscriptionChoice};
use bcct::js::{parse_json, stringify, stringify_pretty};
use bcct::locale::Locale;
use bcct::messages::{Messages, messages_for};
use bcct::prompt::{
    Choice, ChoiceItem, FakeCall, FakePrompter, HIDE_CURSOR, PromptError, Reply, SHOW_CURSOR,
};
use bcct::setup::{command_on_path, shell_script};
use bcct::setup_ask::{
    QuietRange, ask_delay, ask_inbox, ask_installed_commands, ask_language, ask_our_statusline,
    ask_pairing_choice, ask_quiet_hours, ask_remove_models, ask_statusline_choice,
    ask_transcription,
};
use bcct::setup_files::StatuslineChoice;
use bcct::setup_telegram::PairingChoice;
use serde_json::{Value, json};
use support::{
    Helper, Tree, app_form, coverage_env, list, materialize, placeholders, release_form,
    snapshot_under, text,
};

const FIXTURE: &str = include_str!("fixtures/setup-run.json");
const BCCT: &str = env!("CARGO_BIN_EXE_bcct");
const TOOLS: [&str; 8] = ["sh", "ps", "mkdir", "chmod", "cat", "rm", "sleep", "node"];
const UNREACHABLE_API: &str = "http://127.0.0.1:1";
const GIT_VERSION: &str = "2.43.0";
const FAKE_GIT: &str = "#!/bin/sh\necho 'git version 2.43.0'\n";
const DIGITS: &str = "0123456789";
const WAIT_LIMIT: Duration = Duration::from_secs(5);
const RUN_LIMIT: Duration = Duration::from_secs(15);
const APP: &str = "{root}/home/.claude/better-claude-code-telegram";
const APP_FOLDER: &str = "home/.claude/better-claude-code-telegram/";
const SHELL_SCRIPT: &str = "home/.claude/better-claude-code-telegram/shell.sh";

fn fixture() -> Value {
    with_the_path_step(&with_the_shell_script_journaled(&app_form(
        &parse_json(&release_form(FIXTURE)).unwrap(),
        APP,
    )))
}

const JS_TOTAL: &str = "/10 ";
const RUST_TOTAL: &str = "/11 ";
const HEADING: &str = "── ";
const JS_HEALTH_HEADING: &str = "── 🩺 10/10 ";
const HEALTH_HEADING: &str = "── 🩺 11/11 ";
const SHELL_CHECK: &str = " Shell: ";
const HEALTH_COMMAND: &str = "npx @pedromondek/better-claude-code-telegram health";

fn counted_with_the_path_step(stdout: &str) -> String {
    stdout
        .split_inclusive('\n')
        .map(|line| {
            if line.starts_with(JS_HEALTH_HEADING) {
                line.replacen(JS_HEALTH_HEADING, HEALTH_HEADING, 1)
            } else if line.starts_with(HEADING) {
                line.replacen(JS_TOTAL, RUST_TOTAL, 1)
            } else {
                line.to_owned()
            }
        })
        .collect()
}

fn path_step_shown(counted: &str) -> Option<String> {
    let health = counted.find(HEALTH_HEADING)?;
    let messages = messages_for(if counted.contains("Verificação final") {
        Locale::PtBr
    } else {
        Locale::EnUs
    });
    let step = format!(
        "── 💻 10/11 {} ──\n{} {} {}\n\n",
        messages.step_titles.path,
        messages.path_question,
        (messages.yes_no_hint)(false),
        messages.path_off
    );
    let (before, after) = counted.split_at(health);
    let checked = after.find(SHELL_CHECK).map_or_else(
        || after.to_owned(),
        |shell| with_the_new_checks(after, shell, messages),
    );

    Some(format!("{before}{step}{checked}"))
}

fn with_the_new_checks(after: &str, shell: usize, messages: &Messages) -> String {
    let labels = messages.health_labels;
    let detail = messages.health_detail;
    let line_start = after[..shell].rfind('\n').map_or(0, |line| line + 1);
    let shell_end = after[shell..]
        .find('\n')
        .map_or(after.len(), |line| shell + line + 1);
    let launcher = format!(
        "✘ {}: {}\n○ {}: {}\n",
        labels.launcher,
        (detail.launcher_missing)(&format!("{APP}/bin")),
        labels.version,
        detail.version_unknown
    );
    let rows = format!(
        "○ {}: {}\n✔ {}: {}\n✔ {}: {}\n",
        labels.path,
        detail.path_off,
        labels.app_dir,
        detail.app_writable,
        labels.hooks,
        detail.no_hook_failures
    );
    let rest = &after[shell_end..];
    let warning = format!("⚠ {}\n", (messages.health_has_failures)(HEALTH_COMMAND));
    let rest = match rest.find("\n\n") {
        Some(end) if !rest[..end].contains(warning.trim_end()) => {
            format!("{}{warning}{}", &rest[..=end], &rest[end + 1..])
        }
        _ => rest.to_owned(),
    };

    let checked = format!(
        "{}{launcher}{}{rows}{rest}",
        &after[..line_start],
        &after[line_start..shell_end]
    );

    with_the_git_row(&checked, messages)
}

fn with_the_git_row(checked: &str, messages: &Messages) -> String {
    let labels = messages.health_labels;
    let plugins = format!(" {}: ", labels.plugins);

    checked.find(&plugins).map_or_else(
        || checked.to_owned(),
        |found| {
            let line_start = checked[..found].rfind('\n').map_or(0, |line| line + 1);

            format!(
                "{}✔ {}: {GIT_VERSION}\n{}",
                &checked[..line_start],
                labels.git,
                &checked[line_start..]
            )
        },
    )
}

fn with_the_path_step(fixture: &Value) -> Value {
    let mut fixture = fixture.clone();

    for group in fixture["processes"].as_object_mut().unwrap().values_mut() {
        for scenario in group.as_array_mut().unwrap() {
            let runs = scenario["runs"].as_array().unwrap().len();

            for index in 0..runs {
                let counted =
                    counted_with_the_path_step(text(&scenario["results"][index], "stdout"));

                if let Some(shown) = path_step_shown(&counted) {
                    let input = format!("{}\n", text(&scenario["runs"][index], "input"));

                    scenario["results"][index]["stdout"] = Value::String(shown);
                    scenario["runs"][index]["input"] = Value::String(input);
                } else {
                    scenario["results"][index]["stdout"] = Value::String(counted);
                }
            }
        }
    }

    fixture
}

fn undone(change: &str) -> String {
    format!(
        "\u{1b}[36m⠋\u{1b}[39m \u{1b}[2mUndoing: {change}…\u{1b}[22m\r\u{1b}[2K\u{1b}[32m✔ Undone:\r\n  • {change}\u{1b}[39m\r\n"
    )
}

fn journaled_text(text: &str) -> String {
    let folder = format!("created the folder {APP}");
    let script = format!("created {APP}/shell.sh");
    let rc = "created {root}/home/.zshrc";

    text.replace(
        &format!("  • {rc}\r\n  • {folder}\r\n"),
        &format!("  • {folder}\r\n  • {script}\r\n  • {rc}\r\n"),
    )
    .replace(
        &format!("{}{}", undone(&folder), undone(rc)),
        &format!("{}{}{}", undone(rc), undone(&script), undone(&folder)),
    )
    .replace("inbox, statusline\n", "inbox, statusline, path\n")
    .replace(
        "inbox, statusline\u{1b}[39m",
        "inbox, statusline, path\u{1b}[39m",
    )
}

fn with_the_shell_script_journaled(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(journaled_text(text)),
        Value::Array(items) => items.iter().map(with_the_shell_script_journaled).collect(),
        Value::Object(map) => map
            .iter()
            .map(|(key, item)| (key.clone(), with_the_shell_script_journaled(item)))
            .collect(),
        other => other.clone(),
    }
}

fn without_the_shell_script(mut tree: Tree, root: &Path, name: &str) -> Tree {
    let loads = tree
        .values()
        .filter_map(|(content, _)| content.as_deref())
        .any(|content| content.contains(&format!("{APP}/shell.sh\" ] && .")));
    let Some((content, mode)) = tree.remove(SHELL_SCRIPT) else {
        assert!(!loads, "{name}: the rc loads a shell.sh that is missing");
        return tree;
    };
    let app_dir = root.join(APP_FOLDER.trim_end_matches('/'));

    assert_eq!(
        content.as_deref(),
        Some(placeholders(&shell_script(&app_dir, command_on_path(&app_dir)), root).as_str()),
        "{name}: shell.sh"
    );
    assert_eq!(mode, "600", "{name}: shell.sh");

    if !tree
        .keys()
        .any(|path| path.starts_with(APP_FOLDER) && path != APP_FOLDER)
    {
        tree.remove(APP_FOLDER);
    }

    tree
}

fn resolved(name: &str) -> String {
    static KNOWN: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();

    KNOWN
        .get_or_init(Mutex::default)
        .lock()
        .unwrap()
        .entry(name.to_owned())
        .or_insert_with(|| {
            let output = Command::new("sh")
                .args(["-c", &format!("command -v {name}")])
                .output()
                .unwrap();

            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        })
        .clone()
}

fn node_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();

    VERSION.get_or_init(|| {
        let output = Command::new("node").arg("--version").output().unwrap();

        String::from_utf8_lossy(&output.stdout)
            .trim()
            .trim_start_matches('v')
            .to_owned()
    })
}

#[derive(Default)]
struct Facts {
    code: Option<String>,
    pid: Option<String>,
}

fn after_prefix(input: &str, prefix: &str, keep: &str, shown: &str) -> String {
    let mut out = String::new();
    let mut rest = input;

    while let Some(found) = rest.find(prefix) {
        let (before, after) = rest.split_at(found + prefix.len());
        let tail = after.trim_start_matches(|character| keep.contains(character));

        out.push_str(before);
        out.push_str(shown);
        rest = tail;
    }

    out.push_str(rest);
    out
}

fn normalized(input: &str, root: &Path, facts: &Facts) -> String {
    let mut out = placeholders(input, root).replace(node_version(), "{node}");

    if let Some(code) = &facts.code {
        out = out.replace(code, "{code}");
    }

    if let Some(pid) = &facts.pid {
        out = out.replace(pid, "{pid}");
    }

    let out = after_prefix(&out, ".bak.", DIGITS, "{now}");
    let out = after_prefix(&out, "\"requestedAt\":\"", "0123456789-:.TZ", "{iso}");

    after_prefix(&out, "\"launchedAt\":", DIGITS, "\"{now}\"")
}

#[derive(Clone)]
struct FakeOptions {
    can_join_groups: bool,
    webhook: String,
    refuse: BTreeMap<String, Value>,
    me_empty_after: Option<usize>,
    hold_updates: bool,
}

fn options_of(spec: &Value) -> FakeOptions {
    FakeOptions {
        hold_updates: spec["holdUpdates"].as_bool() == Some(true),
        can_join_groups: spec["canJoinGroups"].as_bool() == Some(true),
        webhook: spec["webhook"].as_str().unwrap_or_default().to_owned(),
        refuse: spec["refuse"]
            .as_object()
            .map(|refused| {
                refused
                    .iter()
                    .map(|(name, reason)| (name.clone(), reason.clone()))
                    .collect()
            })
            .unwrap_or_default(),
        me_empty_after: spec["meEmptyAfter"]
            .as_u64()
            .map(|count| usize::try_from(count).unwrap()),
    }
}

struct Telegram {
    port: u16,
    code: Arc<Mutex<Option<String>>>,
    calls: Arc<Mutex<Vec<Value>>>,
    gate: Arc<AtomicBool>,
}

struct TelegramState {
    pending: Vec<Value>,
    code_sent: Option<String>,
    next_update: u64,
}

fn private_update(update_id: u64, id: u64, username: &str, message: &str) -> Value {
    json!({
        "update_id": update_id,
        "message": {
            "chat": { "type": "private" },
            "from": { "id": id, "username": username },
            "text": message,
        },
    })
}

fn read_request(stream: &mut TcpStream) -> (String, String) {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];

    loop {
        let read = stream.read(&mut buffer).unwrap();

        bytes.extend_from_slice(&buffer[..read]);

        let headers_end = bytes.windows(4).position(|window| window == b"\r\n\r\n");

        if let Some(end) = headers_end {
            let head = String::from_utf8_lossy(&bytes[..end]).into_owned();
            let length = head
                .lines()
                .find_map(|line| {
                    let lower = line.to_lowercase();

                    lower
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or_default();

            if bytes.len() >= end + 4 + length {
                let path = head.split(' ').nth(1).unwrap().to_owned();
                let body = String::from_utf8_lossy(&bytes[end + 4..end + 4 + length]).into_owned();

                return (path, body);
            }
        }

        assert!(read > 0, "the request ended early");
    }
}

fn answer(
    method: &str,
    params: &Value,
    options: &FakeOptions,
    state: &mut TelegramState,
    code: Option<&str>,
    me_calls: usize,
) -> Value {
    if let Some(reason) = options.refuse.get(method) {
        return if reason.is_null() {
            json!({ "ok": false })
        } else {
            json!({ "ok": false, "description": reason })
        };
    }

    let result = match method {
        "getMe" => {
            if options.me_empty_after.is_some_and(|limit| me_calls > limit) {
                return json!({ "ok": true });
            }

            json!({ "username": "e2e_bot", "can_join_groups": options.can_join_groups })
        }
        "getWebhookInfo" => json!({ "url": options.webhook }),
        "getChat" => {
            let id: u64 = params["chat_id"].as_str().unwrap().parse().unwrap();

            json!({ "id": id, "username": "dev" })
        }
        "getUpdates" => {
            if let Some(code) = code
                && state.code_sent.as_deref() != Some(code)
            {
                state.code_sent = Some(code.to_owned());
                state.pending.push(private_update(
                    state.next_update,
                    42,
                    "dev",
                    &format!("/start {code}"),
                ));
                state.next_update += 1;
            }

            if params["offset"].as_i64() == Some(-1) {
                json!([])
            } else {
                let offset = params["offset"].as_f64().unwrap();

                Value::Array(
                    state
                        .pending
                        .iter()
                        .filter(|update| update["update_id"].as_f64().unwrap() >= offset)
                        .cloned()
                        .collect(),
                )
            }
        }
        _ => json!(true),
    };

    json!({ "ok": true, "result": result })
}

fn start_telegram(spec: &Value) -> Telegram {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let options = options_of(spec);
    let code = Arc::new(Mutex::new(None::<String>));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(Mutex::new(TelegramState {
        pending: vec![private_update(6, 13, "stranger", "/start")],
        code_sent: None,
        next_update: 7,
    }));
    let (seen_code, seen_calls) = (Arc::clone(&code), Arc::clone(&calls));
    let gate = Arc::new(AtomicBool::new(spec["gated"].as_bool() != Some(true)));
    let opened = Arc::clone(&gate);

    thread::spawn(move || {
        let mut held = Vec::new();

        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let (path, body) = read_request(&mut stream);
            let method = path.rsplit('/').next().unwrap().to_owned();
            let params: Value = serde_json::from_str(&body).unwrap();
            let me_calls = {
                let mut calls = seen_calls.lock().unwrap();

                calls.push(json!({ "method": method, "params": params }));
                calls
                    .iter()
                    .filter(|call: &&Value| call["method"] == "getMe")
                    .count()
            };

            while !opened.load(Ordering::SeqCst) {
                thread::sleep(std::time::Duration::from_millis(5));
            }

            let polling = method == "getUpdates" && params["offset"] != json!(-1);

            if options.hold_updates && polling {
                held.push(stream);
                continue;
            }

            let waiting_since = Instant::now();

            while polling
                && waiting_since.elapsed() < WAIT_LIMIT
                && seen_code.lock().unwrap().is_none()
            {
                thread::sleep(Duration::from_millis(1));
            }

            let current_code = seen_code.lock().unwrap().clone();

            let reply = answer(
                &method,
                &params,
                &options,
                &mut state.lock().unwrap(),
                current_code.as_deref(),
                me_calls,
            )
            .to_string();
            let _sent = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });

    Telegram {
        port,
        code,
        calls,
        gate,
    }
}

fn prepared(root: &Path, scenario: &Value, fake_claude: &str) {
    for folder in ["home", "bin", "work"] {
        fs::create_dir(root.join(folder)).unwrap();
    }

    for tool in TOOLS {
        std::os::unix::fs::symlink(resolved(tool), root.join("bin").join(tool)).unwrap();
    }

    let mut files = serde_json::Map::new();

    files.insert("home/.claude/".to_owned(), json!(""));

    if scenario["claude"] != json!(false) {
        files.insert(
            "bin/claude".to_owned(),
            json!({ "content": fake_claude, "mode": 0o755 }),
        );
    }

    if scenario["noBun"].as_bool() != Some(true) {
        files.insert(
            "bin/bun".to_owned(),
            json!({ "content": "#!/bin/sh\nexit 0\n", "mode": 0o755 }),
        );
    }

    if scenario["noGit"].as_bool() != Some(true) {
        files.insert(
            "bin/git".to_owned(),
            json!({ "content": FAKE_GIT, "mode": 0o755 }),
        );
    }

    if let Some(extra) = scenario["bin"].as_object() {
        for (name, spec) in extra {
            files.insert(format!("bin/{name}"), spec.clone());
        }
    }

    if scenario["claude"].is_object() {
        files.insert(
            "work/claude.json".to_owned(),
            Value::String(scenario["claude"].to_string()),
        );
    }

    materialize(root, &Value::Object(files));
}

fn with_pid(files: &Value, pid: &str) -> Value {
    Value::Object(
        files
            .as_object()
            .map(|files| {
                files
                    .iter()
                    .map(|(path, spec)| {
                        let spec = spec.as_str().map_or_else(
                            || spec.clone(),
                            |content| Value::String(content.replace("{pid}", pid)),
                        );

                        (path.clone(), spec)
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn pumped(mut source: impl Read + Send + 'static) -> (Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
    let collected = Arc::new(Mutex::new(Vec::new()));
    let filling = Arc::clone(&collected);
    let handle = thread::spawn(move || {
        let mut buffer = [0; 4096];

        loop {
            let read = source.read(&mut buffer).unwrap_or_default();

            if read == 0 {
                return;
            }

            filling.lock().unwrap().extend_from_slice(&buffer[..read]);
        }
    });

    (collected, handle)
}

fn scraped_code(stdout: &[u8]) -> Option<String> {
    let shown = String::from_utf8_lossy(stdout);
    let (_, after) = shown.split_once("?start=")?;
    let code: String = after.chars().take_while(char::is_ascii_hexdigit).collect();

    (code.len() == 8).then_some(code)
}

struct RunResult {
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_once(run: &Value, root: &Path, telegram: Option<&Telegram>, facts: &mut Facts) -> RunResult {
    let args: Vec<&str> = list(run, "args")
        .iter()
        .map(|arg| arg.as_str().unwrap())
        .collect();
    let api = telegram.map_or_else(
        || UNREACHABLE_API.to_owned(),
        |telegram| format!("http://127.0.0.1:{}", telegram.port),
    );
    let mut command = Command::new(BCCT);

    command
        .arg("setup")
        .args(args)
        .env_clear()
        .envs(coverage_env())
        .env("PATH", root.join("bin"))
        .env("HOME", root.join("home"))
        .env("CLAUDE_CONFIG_DIR", root.join("home/.claude"))
        .env("SHELL", "/bin/zsh")
        .env("LANG", "C")
        .env("BETTER_CC_TELEGRAM_API_ROOT", api)
        .env("FAKE_CLAUDE_LOG", root.join("work/claude.log"))
        .env("FAKE_CLAUDE_STATE", root.join("work/claude.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (name, value) in run["env"].as_object().unwrap() {
        command.env(name, value.as_str().unwrap());
    }

    let mut child = command.spawn().unwrap();
    let input = text(run, "input").to_owned();
    let mut stdin = child.stdin.take().unwrap();
    let feeding = thread::spawn(move || {
        let _written = stdin.write_all(input.as_bytes());
    });
    let (stdout, out_done) = pumped(child.stdout.take().unwrap());
    let (stderr, err_done) = pumped(child.stderr.take().unwrap());
    let started = Instant::now();

    loop {
        if started.elapsed() > RUN_LIMIT {
            let _killed = child.kill();

            panic!("the setup did not end: {run}");
        }

        if let Some(status) = child.try_wait().unwrap() {
            feeding.join().unwrap();
            out_done.join().unwrap();
            err_done.join().unwrap();

            if let Some(code) = scraped_code(&stdout.lock().unwrap()) {
                facts.code = Some(code);
            }

            return RunResult {
                status: status.code(),
                stdout: normalized(
                    &String::from_utf8_lossy(&stdout.lock().unwrap()),
                    root,
                    facts,
                ),
                stderr: normalized(
                    &String::from_utf8_lossy(&stderr.lock().unwrap()),
                    root,
                    facts,
                ),
            };
        }

        if let Some(telegram) = telegram
            && let Some(code) = scraped_code(&stdout.lock().unwrap())
        {
            *telegram.code.lock().unwrap() = Some(code);
        }

        thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn canonical_content(path: &str, content: &str) -> String {
    if path.ends_with("settings.json") {
        return parse_json(content)
            .map_or_else(|| content.to_owned(), |value| stringify_pretty(&value));
    }

    content.to_owned()
}

fn home_tree(root: &Path, facts: &Facts) -> Tree {
    snapshot_under(root, "home")
        .into_iter()
        .map(|(path, (content, mode))| {
            let path = normalized(&path, root, facts);
            let content =
                content.map(|content| canonical_content(&path, &normalized(&content, root, facts)));

            (path, (content, mode))
        })
        .collect()
}

fn expected_home(after: &Value) -> Tree {
    after
        .as_object()
        .unwrap()
        .iter()
        .filter(|(path, _)| path.as_str() != "home/")
        .map(|(path, entry)| {
            let content = entry["content"]
                .as_str()
                .map(|content| canonical_content(path, content));

            (path.clone(), (content, text(entry, "mode").to_owned()))
        })
        .collect()
}

fn as_recorded(name: &str, run: &Value, expected: &Value, result: &RunResult) {
    assert_eq!(
        result.stdout,
        text(expected, "stdout"),
        "{name}: stdout of {run}"
    );
    assert_eq!(
        result.stderr,
        text(expected, "stderr"),
        "{name}: stderr of {run}"
    );
    assert_eq!(
        result.status,
        expected["status"]
            .as_i64()
            .map(|code| i32::try_from(code).unwrap()),
        "{name}: status of {run}"
    );
}

fn replay_scenario(scenario: &Value, fake_claude: &str) {
    replay_checked(scenario, fake_claude, &as_recorded);
}

fn replay_checked(
    scenario: &Value,
    fake_claude: &str,
    check: &dyn Fn(&str, &Value, &Value, &RunResult),
) {
    let folder = support::sandbox();
    let root = folder.path();
    let name = text(scenario, "name");
    let telegram = scenario["telegram"]
        .is_object()
        .then_some(&scenario["telegram"])
        .filter(|spec| spec["down"].as_bool() != Some(true))
        .map(start_telegram);
    let helper = (scenario["botAlive"].as_bool() == Some(true)).then(|| Helper::start("server.ts"));
    let mut facts = Facts {
        code: None,
        pid: helper.as_ref().map(Helper::pid),
    };

    prepared(root, scenario, fake_claude);
    materialize(
        root,
        &with_pid(&scenario["files"], facts.pid.as_deref().unwrap_or_default()),
    );

    for (run, expected) in list(scenario, "runs").iter().zip(list(scenario, "results")) {
        if let Some(telegram) = &telegram {
            *telegram.code.lock().unwrap() = None;
        }

        let result = run_once(run, root, telegram.as_ref(), &mut facts);

        check(name, run, expected, &result);
    }

    assert_eq!(
        without_the_shell_script(home_tree(root, &facts), root, name),
        expected_home(&scenario["after"]),
        "{name}: files"
    );

    let log = root.join("work/claude.log");
    let claude_calls: Vec<Value> = fs::read_to_string(log)
        .map(|text| {
            text.lines()
                .map(|line| serde_json::from_str(&normalized(line, root, &facts)).unwrap())
                .collect()
        })
        .unwrap_or_default();

    assert_eq!(
        &claude_calls,
        list(scenario, "claudeCalls"),
        "{name}: claude"
    );

    let tools = fs::read_to_string(root.join("work/tools.log")).unwrap_or_default();

    assert_eq!(
        normalized(&tools, root, &facts),
        text(scenario, "toolCalls"),
        "{name}: tools"
    );

    let calls: Vec<Value> = telegram.as_ref().map_or_else(Vec::new, |telegram| {
        serde_json::from_str(&normalized(
            &Value::Array(telegram.calls.lock().unwrap().clone()).to_string(),
            root,
            &facts,
        ))
        .unwrap()
    });

    assert_eq!(&calls, list(scenario, "telegramCalls"), "{name}: telegram");
}

const HEALTH_KEEPS_GOING: &str = "the health stops when the bot answers nothing";

fn replay_group(group: &str) {
    let fixture = fixture();
    let fake_claude = text(&fixture, "fakeClaude");

    for scenario in list(&fixture["processes"], group) {
        if text(scenario, "name") != HEALTH_KEEPS_GOING {
            replay_scenario(scenario, fake_claude);
        }
    }
}

#[test]
fn a_bot_answer_without_data_fails_only_its_check_and_the_setup_finishes() {
    let fixture = fixture();
    let mut scenario = list(&fixture["processes"], "telegram")
        .iter()
        .find(|scenario| text(scenario, "name") == HEALTH_KEEPS_GOING)
        .unwrap()
        .clone();
    scenario["telegramCalls"]
        .as_array_mut()
        .unwrap()
        .push(json!({"method": "getChat", "params": {"chat_id": "42"}}));
    let scenario = &scenario;
    let recorded = |expected: &Value| {
        let stdout = text(expected, "stdout");
        stdout[..stdout.rfind("Telegram\n").unwrap()].to_owned()
    };

    replay_checked(
        scenario,
        text(&fixture, "fakeClaude"),
        &|name, run, expected, result| {
            assert!(
                result.stdout.starts_with(&recorded(expected)),
                "{name}: stdout of {run}"
            );
            assert!(
                result.stdout.contains(
                    "\nTelegram\n✘ Bot token: Telegram answered getMe without the bot data. Try again in a moment.\n○ Groups: needs a working bot token\n"
                ),
                "{name}: {}",
                result.stdout
            );
            assert!(
                result.stdout.contains("\nSecurity\n"),
                "{name}: {}",
                result.stdout
            );
            assert!(
                result.stdout.contains("\nExtras\n"),
                "{name}: {}",
                result.stdout
            );
            assert!(
                result.stdout.ends_with(&format!(
                    "⚠ Some checks failed. Fix what is marked with ✘ and run '{HEALTH_COMMAND}' again.\n\n✔ Done. Open a new terminal and run 'claude --telegram'.\n"
                )),
                "{name}: {}",
                result.stdout
            );
            assert_eq!(result.stderr, "", "{name}: stderr of {run}");
            assert_eq!(result.status, Some(0), "{name}: status of {run}");
        },
    );
}

#[test]
fn the_steps_do_what_the_js_does() {
    replay_group("steps");
}

#[test]
fn the_status_line_does_what_the_js_does() {
    replay_group("statusline");
}

#[test]
fn keeping_the_statusline_of_the_clone_moves_it_to_the_launcher_of_the_app() {
    let name = "ours kept with Enter, nothing to restore";
    let scenario_of = |fixture: &Value| {
        list(&fixture["processes"], "statusline")
            .iter()
            .find(|scenario| text(scenario, "name") == name)
            .unwrap()
            .clone()
    };
    let fixture = fixture();
    let en = messages_for(Locale::EnUs);
    let mut scenario = scenario_of(&fixture);
    let kept = format!("○ {}", en.statusline_ours_kept);
    let moved = format!(
        "✔ {}",
        (en.statusline_installed)("{root}/home/.claude/settings.json")
    );
    let stdout = text(&scenario["results"][0], "stdout").replace(&kept, &moved);

    assert_ne!(stdout, text(&scenario["results"][0], "stdout"));
    scenario["files"] = scenario_of(&parse_json(&release_form(FIXTURE)).unwrap())["files"].clone();
    scenario["results"][0]["stdout"] = Value::String(stdout);

    replay_scenario(&scenario, text(&fixture, "fakeClaude"));
}

#[test]
fn the_command_line_flags_do_what_the_js_does() {
    replay_group("set");
}

#[test]
fn the_plugin_step_does_what_the_js_does() {
    replay_group("plugins");
}

#[test]
fn the_telegram_steps_do_what_the_js_does() {
    replay_group("telegram");
}

#[test]
fn the_uninstall_does_what_the_js_does() {
    replay_group("uninstall");
}

fn messages_of(entry: &Value) -> &'static Messages {
    messages_for(Locale::parse(text(entry, "locale")).unwrap())
}

fn replies_of(entry: &Value) -> Vec<Reply> {
    let piped = entry["piped"].as_bool() == Some(true);
    let replies = list(entry, "replies");
    let mut out: Vec<Reply> = replies
        .iter()
        .map(|reply| {
            if let Some(index) = reply.as_u64() {
                return Reply::Choose(usize::try_from(index).unwrap());
            }

            match reply.as_str().unwrap() {
                "last" => Reply::Last,
                typed => Reply::Text(typed.to_owned()),
            }
        })
        .collect();

    if !piped && !matches!(out.last(), Some(Reply::Text(_) | Reply::Last)) {
        for call in list(entry, "calls").iter().skip(out.len()) {
            out.push(if call["line"].is_string() {
                Reply::Text(String::new())
            } else {
                Reply::Default
            });
        }
    }

    out.push(Reply::End);

    out
}

fn range_of(value: &Value) -> Option<QuietRange> {
    value["start"]
        .as_str()
        .map(|start| (start.to_owned(), text(value, "end").to_owned()))
}

fn statusline_name(choice: StatuslineChoice) -> &'static str {
    match choice {
        StatuslineChoice::After => "after",
        StatuslineChoice::Replace => "replace",
        StatuslineChoice::Custom => "custom",
        StatuslineChoice::Keep => "keep",
        StatuslineChoice::On | StatuslineChoice::Off => "unexpected",
    }
}

fn commands_name(choice: CommandsChoice) -> &'static str {
    match choice {
        CommandsChoice::Keep => "keep",
        CommandsChoice::Remove => "remove",
    }
}

fn model_of(value: &Value) -> Option<&'static str> {
    value.as_str().map(|model| match model {
        "base" => "base",
        "small" => "small",
        _ => "medium",
    })
}

fn models_of(value: &Value) -> Vec<&'static str> {
    value
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|model| model_of(model).unwrap())
        .collect()
}

fn asked(entry: &Value, ask: &mut FakePrompter) -> Result<Value, PromptError> {
    let messages = messages_of(entry);
    let saved = entry["saved"].as_bool() == Some(true);

    Ok(match text(entry, "ask") {
        "delay" => json!(ask_delay(
            entry["current"].as_f64().unwrap(),
            saved,
            messages,
            ask
        )?),
        "inbox" => json!(ask_inbox(entry["current"].as_f64(), saved, messages, ask)?),
        "quiet" => {
            let current = range_of(&entry["current"]);

            ask_quiet_hours(current.as_ref(), saved, messages, ask)?.map_or(
                Value::Null,
                |(start, end)| json!({ "start": start, "end": end }),
            )
        }
        "transcription" => {
            let installed = models_of(&entry["installed"]);

            match ask_transcription(
                model_of(&entry["current"]),
                saved,
                &installed,
                messages,
                ask,
            )? {
                TranscriptionChoice::Off => Value::Null,
                TranscriptionChoice::Model(model) => json!(model),
                TranscriptionChoice::Uninstall => json!("<uninstall>"),
            }
        }
        "language" => {
            let flags = entry["noFlags"].as_bool() != Some(true);
            let current = Locale::parse(text(entry, "current")).unwrap();

            json!(ask_language(current, saved, flags, messages, ask)?.as_str())
        }
        "statusline" => json!(statusline_name(ask_statusline_choice(
            text(entry, "preview"),
            entry["customized"].as_bool() == Some(true),
            messages,
            ask,
        )?)),
        "ours" => json!(commands_name(ask_our_statusline(
            entry["restores"].as_bool().unwrap(),
            messages,
            ask,
        )?)),
        "commands" => json!(commands_name(ask_installed_commands(messages, ask)?)),
        "pairing" => {
            let choice = ask_pairing_choice(text(entry, "accounts"), messages, ask)?;

            json!(match choice {
                PairingChoice::Keep => "keep",
                PairingChoice::Replace => "replace",
            })
        }
        _ => {
            let others = models_of(&entry["others"]);
            let tag = entry["tag"].as_str().unwrap_or(messages.model_in_use);

            json!(ask_remove_models(
                &others,
                model_of(&entry["previous"]),
                tag,
                messages,
                ask,
            )?)
        }
    })
}

fn expected_calls(entry: &Value) -> Vec<FakeCall> {
    list(entry, "calls")
        .iter()
        .map(|call| {
            if let Some(prompt) = call["line"].as_str() {
                return FakeCall::Line {
                    prompt: prompt.to_owned(),
                };
            }

            FakeCall::Select {
                title: text(call, "title").to_owned(),
                index: usize::try_from(call["index"].as_u64().unwrap()).unwrap(),
                choices: list(call, "choices")
                    .iter()
                    .map(|choice| Choice {
                        label: text(choice, "label").to_owned(),
                        hint: choice["hint"].as_str().map(str::to_owned),
                        heading: choice["heading"].as_bool().unwrap(),
                        previous: choice["previous"].as_bool().unwrap(),
                    })
                    .collect(),
            }
        })
        .collect()
}

#[test]
fn the_questions_ask_what_the_js_asks() {
    let fixture = fixture();

    for entry in list(&fixture, "questions") {
        let mut ask = FakePrompter::new(entry["piped"].as_bool() != Some(true))
            .with_replies(replies_of(entry));
        let value =
            asked(entry, &mut ask).unwrap_or_else(|error| json!({ "error": error.to_string() }));
        let reports: Vec<Value> = ask.reports().iter().map(|report| json!(report)).collect();

        assert_eq!(stringify(&value), stringify(&entry["value"]), "{entry}");
        assert_eq!(ask.calls(), expected_calls(entry), "{entry}");
        assert_eq!(&reports, list(entry, "errors"), "{entry}");
    }
}

#[test]
fn a_heading_keeps_its_label_when_the_values_change_type() {
    let heading: ChoiceItem<u8> = ChoiceItem::heading("title");
    let pick = ChoiceItem::pick("label", "answer", 1_u8).map_value(u16::from);

    assert_eq!(heading.map_value(u16::from), ChoiceItem::heading("title"));
    assert_eq!(pick.value(), Some(&1_u16));
    assert_eq!(pick.label(), "label");
}

#[test]
fn the_plugin_step_stops_with_the_install_commands_when_git_is_missing() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({ "noGit": true }), "");

    let output = closed_output_command(root, &["plugin"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let messages = messages_for(Locale::EnUs);

    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(messages.git_missing_setup),
        "{output:?}"
    );
    assert!(!root.join("work/claude.log").exists(), "{output:?}");
}

#[test]
fn the_uninstall_subcommand_is_the_same_as_the_flag() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({ "claude": false }), "");

    let output = Command::new(BCCT)
        .arg("uninstall")
        .env_clear()
        .envs(coverage_env())
        .env("PATH", root.join("bin"))
        .env("HOME", root.join("home"))
        .env("LANG", "C")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let messages = messages_for(Locale::EnUs);

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains(messages.cancelled),
        "{output:?}"
    );
}

fn ended_in_time(mut child: Child) -> Output {
    let started = Instant::now();

    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > RUN_LIMIT {
            let _killed = child.kill();

            break;
        }

        thread::sleep(Duration::from_millis(1));
    }

    child.wait_with_output().unwrap()
}

fn closed_output_command(root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(BCCT);

    command
        .arg("setup")
        .args(args)
        .env_clear()
        .envs(coverage_env())
        .env("PATH", root.join("bin"))
        .env("HOME", root.join("home"))
        .env("CLAUDE_CONFIG_DIR", root.join("home/.claude"))
        .env("SHELL", "/bin/zsh")
        .env("LANG", "C")
        .env("BETTER_CC_TELEGRAM_API_ROOT", UNREACHABLE_API)
        .env("FAKE_CLAUDE_LOG", root.join("work/claude.log"))
        .env("FAKE_CLAUDE_STATE", root.join("work/claude.json"));

    command
}

fn with_full_output(root: &Path, args: &[&str], input: &str) -> (Option<i32>, String) {
    let full = fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .unwrap();
    let mut child = closed_output_command(root, args)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(full))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _written = stdin.write_all(input.as_bytes());

    drop(stdin);

    let output = ended_in_time(child);

    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn path_run(root: &Path, input: &str, facts: &mut Facts) -> RunResult {
    run_once(
        &json!({"args": ["path"], "input": input, "env": {}}),
        root,
        None,
        facts,
    )
}

#[test]
fn the_path_step_adds_keeps_and_removes_the_launcher_folder() {
    let fixture = fixture();
    let folder = support::sandbox();
    let root = folder.path();
    let mut facts = Facts {
        code: None,
        pid: None,
    };
    let en = messages_for(Locale::EnUs);
    let shell = format!("{APP}/shell.sh");
    let config = root.join(APP_FOLDER).join("better-cc-telegram.json");
    let script = root.join(SHELL_SCRIPT);
    let block = "case \":${PATH}:\" in";
    let read = |path: &Path| fs::read_to_string(path).unwrap_or_default();

    prepared(root, &json!({}), text(&fixture, "fakeClaude"));

    let off = path_run(root, "\n", &mut facts);

    assert_eq!(off.status, Some(0), "{}", off.stdout);
    assert!(
        off.stdout
            .contains("── 💻 1/1 bcct command in the terminal ──")
    );
    assert!(off.stdout.contains(en.path_off), "{}", off.stdout);
    assert!(!config.exists());

    let added = path_run(root, "y\n", &mut facts);

    assert_eq!(added.status, Some(0), "{}", added.stdout);
    assert!(
        added.stdout.contains(&(en.path_added)(&shell)),
        "{}",
        added.stdout
    );
    assert!(read(&config).contains("\"commandOnPath\": true"));
    assert!(read(&script).contains(block));
    assert!(read(&root.join("home/.zshrc")).contains("/shell.sh\" ] && ."));

    let kept = path_run(root, "\n", &mut facts);

    assert!(
        kept.stdout.contains(&(en.path_already)(&shell)),
        "{}",
        kept.stdout
    );
    assert!(read(&script).contains(block));

    let removed = path_run(root, "n\n", &mut facts);

    assert!(
        removed.stdout.contains(&(en.path_removed)(&shell)),
        "{}",
        removed.stdout
    );
    assert!(read(&config).contains("\"commandOnPath\": false"));
    assert!(!read(&script).contains(block));
    assert!(read(&script).contains("claude() {"));

    path_run(root, "y\n", &mut facts);
    fs::remove_file(&script).unwrap();
    fs::create_dir(&script).unwrap();

    let refused = path_run(root, "n\n", &mut facts);

    assert_eq!(refused.status, Some(1), "{}", refused.stdout);
    assert!(
        format!("{}{}", refused.stdout, refused.stderr).contains(&(en.file_not_saved)(&shell)),
        "{}{}",
        refused.stdout,
        refused.stderr
    );
}

#[test]
fn a_shell_script_that_cannot_be_saved_stops_the_plugin_step_with_its_name() {
    let fixture = fixture();
    let scenario = list(&fixture["processes"], "plugins")
        .iter()
        .find(|scenario| text(scenario, "name") == "a fresh machine")
        .unwrap();
    let folder = support::sandbox();
    let root = folder.path();
    let mut facts = Facts {
        code: None,
        pid: None,
    };

    prepared(root, scenario, text(&fixture, "fakeClaude"));
    materialize(root, &with_pid(&scenario["files"], ""));
    fs::create_dir_all(root.join(SHELL_SCRIPT)).unwrap();

    let result = run_once(&list(scenario, "runs")[0], root, None, &mut facts);
    let shown = format!("{}{}", result.stdout, result.stderr);

    assert_eq!(result.status, Some(1), "{shown}");
    assert!(
        shown.contains(&(messages_for(Locale::EnUs).file_not_saved)(&format!(
            "{APP}/shell.sh"
        ))),
        "{shown}"
    );
    assert!(!root.join("home/.zshrc").exists());
}

#[test]
fn an_uninstall_that_cannot_remove_the_shell_script_names_it_and_stops() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), text(&fixture(), "fakeClaude"));
    fs::create_dir_all(root.join(SHELL_SCRIPT).join("inside")).unwrap();

    let mut child = closed_output_command(root, &["--uninstall"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _written = child.stdin.take().unwrap().write_all(b"\n");
    let output = ended_in_time(child);
    let shown = placeholders(
        &format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        root,
    );

    assert_eq!(output.status.code(), Some(1), "{shown}");
    assert!(
        shown.contains(&(messages_for(Locale::EnUs).file_not_removed)(&format!(
            "{APP}/shell.sh"
        ))),
        "{shown}"
    );
    assert!(root.join(SHELL_SCRIPT).join("inside").is_dir());
}

fn full_output_sandbox() -> tempfile::TempDir {
    let folder = support::sandbox();

    prepared(folder.path(), &json!({}), text(&fixture(), "fakeClaude"));

    folder
}

#[test]
fn a_closed_output_ends_a_step_with_the_line_of_the_catalog() {
    let messages = messages_for(Locale::EnUs);
    let line = format!("✘ {}\n", messages.output_not_shown);

    for (args, input) in [
        (vec!["delay"], "5\n"),
        (vec!["--set", "delay", "5"], ""),
        (vec!["--set", "inbox", "5"], ""),
        (vec!["--set", "statusline", "on"], ""),
        (vec!["--show"], ""),
        (vec!["--uninstall"], "\n"),
        (vec!["transcription"], "off\n"),
    ] {
        let folder = full_output_sandbox();
        let (code, stderr) = with_full_output(folder.path(), &args, input);

        assert_eq!(code, Some(1), "{args:?}");
        assert_eq!(stderr, line, "{args:?}");
    }
}

#[test]
fn a_closed_output_saves_the_write_in_course_and_stops_before_the_next_question() {
    let folder = full_output_sandbox();
    let root = folder.path();

    let (code, stderr) = with_full_output(root, &["delay", "inbox"], "5\n3\n");
    let config = fs::read_to_string(
        root.join("home/.claude/better-claude-code-telegram/better-cc-telegram.json"),
    )
    .unwrap_or_default();

    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("Could not write to the output."),
        "{stderr}"
    );
    assert!(!config.contains("inboxRetentionDays"), "{config}");
}

#[test]
fn a_closed_output_after_a_failure_still_says_both() {
    let folder = full_output_sandbox();
    let root = folder.path();

    materialize(
        root,
        &json!({
            "home/.claude/settings.json": "{\"permissions\":{\"deny\":[\"Read(~/.claude/channels/telegram/.env)\"]}}",
        }),
    );

    let claude_dir = root.join("home/.claude");

    fs::set_permissions(&claude_dir, fs::Permissions::from_mode(0o500)).unwrap();

    let (code, stderr) = with_full_output(root, &["--uninstall"], "");

    fs::set_permissions(&claude_dir, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(code, Some(1));
    assert!(stderr.contains("Could not save"), "{stderr}");
    assert!(
        stderr.contains("Could not write to the output."),
        "{stderr}"
    );
}

#[test]
fn a_closed_output_stops_the_prompt_of_the_statusline_request_and_the_declined_report() {
    let folder = full_output_sandbox();
    let root = folder.path();

    materialize(
        root,
        &json!({
            "home/.claude/settings.json": "{\"statusLine\":{\"command\":\"mine\"}}",
        }),
    );

    let (code, stderr) = with_full_output(root, &["--statusline-prompt"], "");

    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("Could not write to the output."),
        "{stderr}"
    );

    let folder = full_output_sandbox();
    let (code, stderr) = with_full_output(folder.path(), &["plugin"], "n\n");

    assert_eq!(code, Some(1));
    assert!(
        stderr.contains("Could not write to the output."),
        "{stderr}"
    );
}

fn closed_once_asked(
    root: &Path,
    args: &[&str],
    api: &str,
    needle: &str,
    input: &str,
) -> (Option<i32>, String) {
    let mut child = closed_output_command(root, args)
        .env("BETTER_CC_TELEGRAM_API_ROOT", api)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut seen = Vec::new();
    let mut buffer = [0; 4096];

    while !String::from_utf8_lossy(&seen).contains(needle) {
        let read = stdout.read(&mut buffer).unwrap();

        assert!(read > 0, "{}", String::from_utf8_lossy(&seen));
        seen.extend_from_slice(&buffer[..read]);
    }

    drop(stdout);

    let mut stdin = child.stdin.take().unwrap();
    let _written = stdin.write_all(input.as_bytes());

    drop(stdin);

    let output = ended_in_time(child);

    (
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn give_up_in_time() {
    thread::spawn(|| {
        thread::sleep(RUN_LIMIT);
        std::process::exit(1);
    });
}

fn passes_alone(driver: &str) {
    let status = Command::new(std::env::current_exe().unwrap())
        .args([driver, "--exact", "--ignored", "--test-threads", "1"])
        .status()
        .unwrap();

    assert!(status.success(), "{driver}");
}

#[test]
fn an_output_closed_at_the_token_still_applies_the_rule_and_then_stops() {
    passes_alone("closed_at_the_token_driver");
}

#[test]
fn an_output_closed_at_the_token_prompt_stops_without_saving_it() {
    passes_alone("closed_at_the_token_prompt_driver");
}

#[test]
fn an_output_closed_at_the_pairing_stops_after_keeping_the_account() {
    passes_alone("closed_at_the_pairing_driver");
}

#[test]
#[ignore = "alone in its process, so that no other test holds the read end of the pipe"]
fn closed_at_the_token_driver() {
    give_up_in_time();

    let folder = full_output_sandbox();
    let root = folder.path();
    let telegram = start_telegram(&json!({ "gated": true }));
    let api = format!("http://127.0.0.1:{}", telegram.port);
    let messages = messages_for(Locale::EnUs);
    let mut child = closed_output_command(root, &["token", "pairing"])
        .env("BETTER_CC_TELEGRAM_API_ROOT", &api)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut seen = Vec::new();
    let mut buffer = [0; 4096];

    while !String::from_utf8_lossy(&seen).contains(messages.token_prompt) {
        let read = stdout.read(&mut buffer).unwrap();

        assert!(read > 0, "{}", String::from_utf8_lossy(&seen));
        seen.extend_from_slice(&buffer[..read]);
    }

    child.stdin.take().unwrap().write_all(b"1:x\n").unwrap();

    let started = Instant::now();

    while telegram.calls.lock().unwrap().is_empty() {
        assert!(started.elapsed() < WAIT_LIMIT, "the token was not checked");
        thread::sleep(Duration::from_millis(5));
    }

    drop(stdout);
    telegram.gate.store(true, Ordering::SeqCst);

    let output = ended_in_time(child);
    let settings = fs::read_to_string(root.join("home/.claude/settings.json")).unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        format!("✘ {}\n", messages.output_not_shown)
    );
    assert!(settings.contains(".env"), "{settings}");
    assert!(root.join("home/.claude/channels/telegram/.env").exists());
    assert!(
        !root
            .join("home/.claude/channels/telegram/access.json")
            .exists()
    );
}

#[test]
#[ignore = "alone in its process, so that no other test holds the read end of the pipe"]
fn closed_at_the_token_prompt_driver() {
    give_up_in_time();

    let folder = full_output_sandbox();
    let root = folder.path();
    let telegram = start_telegram(&json!({}));
    let api = format!("http://127.0.0.1:{}", telegram.port);
    let messages = messages_for(Locale::EnUs);
    let (code, stderr) = closed_once_asked(root, &["token"], &api, messages.token_prompt, "1:x\n");

    assert_eq!(code, Some(1));
    assert_eq!(stderr, format!("✘ {}\n", messages.output_not_shown));
    assert!(!root.join("home/.claude/channels/telegram/.env").exists());
    assert!(telegram.calls.lock().unwrap().is_empty());
}

#[test]
fn a_closed_output_never_reaches_the_network() {
    let folder = full_output_sandbox();
    let root = folder.path();
    let telegram = start_telegram(&json!({}));
    let api = format!("http://127.0.0.1:{}", telegram.port);
    let full = fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .unwrap();

    materialize(
        root,
        &json!({ "home/.claude/channels/telegram/.env": "TELEGRAM_BOT_TOKEN=1:x\n" }),
    );

    let child = closed_output_command(root, &["pairing"])
        .env("BETTER_CC_TELEGRAM_API_ROOT", &api)
        .stdin(Stdio::null())
        .stdout(Stdio::from(full))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let output = ended_in_time(child);

    assert_eq!(output.status.code(), Some(1));
    assert!(telegram.calls.lock().unwrap().is_empty());
}

#[test]
#[ignore = "alone in its process, so that no other test holds the read end of the pipe"]
fn closed_at_the_pairing_driver() {
    give_up_in_time();

    let folder = full_output_sandbox();
    let root = folder.path();
    let telegram = start_telegram(&json!({}));
    let api = format!("http://127.0.0.1:{}", telegram.port);
    let messages = messages_for(Locale::EnUs);

    materialize(
        root,
        &json!({
            "home/.claude/channels/telegram/.env": "TELEGRAM_BOT_TOKEN=1:x\n",
            "home/.claude/channels/telegram/access.json": "{\"allowFrom\":[\"42\"]}",
        }),
    );

    let (code, stderr) =
        closed_once_asked(root, &["pairing", "delay"], &api, "(keep, replace)", "\n");

    assert_eq!(code, Some(1));
    assert_eq!(stderr, format!("✘ {}\n", messages.output_not_shown));
    assert!(
        !root
            .join("home/.claude/better-claude-code-telegram/better-cc-telegram.json")
            .exists()
    );
}

#[test]
fn a_file_that_cannot_be_saved_says_so_in_one_line_of_the_catalog() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), text(&fixture(), "fakeClaude"));
    materialize(
        root,
        &json!({
            "home/.claude/better-claude-code-telegram/keep": "",
            "home/.zshrc/": "",
        }),
    );

    let app = root.join("home/.claude/better-claude-code-telegram");
    let config = app.join("better-cc-telegram.json");

    fs::create_dir(&config).unwrap();

    let output = closed_output_command(root, &["--set", "delay", "5"])
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        format!("✘ Could not save {}.\n", config.display())
    );

    let launch = app.join("launch.json");

    fs::create_dir(&launch).unwrap();

    let marked = closed_output_command(root, &["--mark-launch"])
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert_eq!(marked.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&marked.stderr),
        format!("✘ Could not save {}.\n", launch.display())
    );
}

#[test]
fn an_rc_file_that_cannot_be_written_stops_the_plugin_step_in_one_line() {
    let folder = full_output_sandbox();
    let root = folder.path();
    let rc = root.join("home/.zshrc");

    fs::create_dir(&rc).unwrap();

    let result = run_once(
        &json!({ "args": ["plugin"], "input": "s\ns\n", "env": {} }),
        root,
        None,
        &mut Facts::default(),
    );

    assert_eq!(result.status, Some(1));
    assert_eq!(result.stderr, "✘ Could not save {root}/home/.zshrc.\n");
}

#[test]
fn a_state_folder_that_cannot_be_removed_stops_the_uninstall_in_one_line() {
    let folder = full_output_sandbox();
    let root = folder.path();
    let channels = root.join("home/.claude/channels");

    materialize(root, &json!({ "home/.claude/channels/telegram/x": "" }));
    fs::set_permissions(&channels, fs::Permissions::from_mode(0o500)).unwrap();

    let result = run_once(
        &json!({ "args": ["--uninstall"], "input": "s\n", "env": {} }),
        root,
        None,
        &mut Facts::default(),
    );

    fs::set_permissions(&channels, fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(result.status, Some(1));
    assert_eq!(
        result.stderr,
        "✘ Could not remove {root}/home/.claude/channels/telegram.\n"
    );
}

#[test]
fn a_request_that_cannot_be_taken_says_so_in_one_line_of_the_catalog() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), "");
    materialize(
        root,
        &json!({
            "home/.claude/settings.json": "{\"statusLine\":{\"command\":\"mine\"}}",
            "home/.claude/better-claude-code-telegram/statusline-customize.json/keep": "",
        }),
    );

    let request = root.join("home/.claude/better-claude-code-telegram/statusline-customize.json");
    let output = closed_output_command(root, &["--statusline-prompt", "x", "--take"])
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        format!("✘ Could not remove {}.\n", request.display())
    );
}

#[test]
fn a_missing_node_lets_the_setup_go_on_and_an_old_one_stops_it() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), "");
    fs::remove_file(root.join("bin/node")).unwrap();

    let without = closed_output_command(root, &["delay"])
        .stdin(Stdio::null())
        .output()
        .unwrap();

    assert!(
        String::from_utf8_lossy(&without.stdout).contains("Wait time"),
        "{without:?}"
    );

    materialize(
        root,
        &json!({ "bin/node": { "content": "#!/bin/sh\necho v18.2.0\n", "mode": 0o755 } }),
    );

    let old = closed_output_command(root, &["delay"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let messages = messages_for(Locale::EnUs);

    assert_eq!(old.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&old.stderr),
        format!("✘ {}\n", (messages.node_too_old)("18.2.0", "24.11"))
    );
    assert_eq!(old.stdout, Vec::<u8>::new());
}

#[test]
fn a_tool_installed_by_the_setup_is_seen_by_the_rest_of_the_setup() {
    let folder = support::sandbox();
    let root = folder.path();
    let fixture = fixture();

    prepared(
        root,
        &json!({ "noBun": true }),
        text(&fixture, "fakeClaude"),
    );
    materialize(
        root,
        &json!({
            "bin/curl": { "content": "#!/bin/sh\nexit 0\n", "mode": 0o755 },
            "bin/bash": {
                "content": "#!/bin/sh\nmkdir -p \"$HOME/.bun/bin\"\nprintf '#!/bin/sh\\nexit 0\\n' > \"$HOME/.bun/bin/bun\"\nchmod 755 \"$HOME/.bun/bin/bun\"\n",
                "mode": 0o755,
            },
        }),
    );

    let output = run_once(
        &json!({ "args": ["plugin"], "input": "s\ns\ns\n", "env": {} }),
        root,
        None,
        &mut Facts::default(),
    );

    assert_eq!(output.status, Some(0), "{}", output.stderr);
    assert!(output.stdout.contains("bun"), "{}", output.stdout);
}

const PTY_COLUMNS: u16 = 200;
const PTY_ROWS: u16 = 50;
const SPINNER_START: &str = "\r\u{1b}[36m";
const SPINNER_END: &str = "\u{1b}[22m";
const PTY_WRAPPER: &str = "trap : INT; printf '<<<'; \"$0\" \"$@\"; echo \"[exit=$?]\"";

fn strip_spinner(input: &str) -> String {
    let mut out = String::new();
    let mut rest = input;

    while let Some(start) = rest.find(SPINNER_START) {
        let end = rest[start..].find(SPINNER_END).unwrap() + start;

        out.push_str(&rest[..start]);
        rest = &rest[end + SPINNER_END.len()..];
    }

    out.push_str(rest);
    out
}

fn pty_env(root: &Path, api: &str) -> Vec<(String, String)> {
    let text = |path: &str| root.join(path).to_string_lossy().into_owned();
    let mut env = vec![
        ("PATH".to_owned(), text("bin")),
        ("HOME".to_owned(), text("home")),
        ("CLAUDE_CONFIG_DIR".to_owned(), text("home/.claude")),
        ("SHELL".to_owned(), "/bin/zsh".to_owned()),
        ("LANG".to_owned(), "C".to_owned()),
        ("BETTER_CC_TELEGRAM_API_ROOT".to_owned(), api.to_owned()),
        ("FAKE_CLAUDE_LOG".to_owned(), text("work/claude.log")),
        ("FAKE_CLAUDE_STATE".to_owned(), text("work/claude.json")),
    ];

    env.extend(
        coverage_env()
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.to_string_lossy().into_owned())),
    );

    env
}

fn pty_steps(scenario: &Value) -> Vec<pty::Step> {
    list(scenario, "keys")
        .iter()
        .map(|key| match key.as_str() {
            Some(typed) => pty::Step::Key(typed.as_bytes().to_vec()),
            None => pty::Step::When(
                text(key, "when").as_bytes().to_vec(),
                text(key, "key").as_bytes().to_vec(),
            ),
        })
        .collect()
}

fn with_stty(root: &Path) {
    std::os::unix::fs::symlink(resolved("stty"), root.join("bin/stty")).unwrap();
}

#[test]
fn the_terminal_shows_what_the_js_shows() {
    let fixture = fixture();
    let fake_claude = text(&fixture, "fakeClaude");

    for scenario in list(&fixture, "terminal") {
        let folder = support::sandbox();
        let root = folder.path();
        let name = text(scenario, "name");
        let telegram = scenario["telegram"]
            .is_object()
            .then(|| start_telegram(&scenario["telegram"]));
        let api = telegram.as_ref().map_or_else(
            || UNREACHABLE_API.to_owned(),
            |telegram| format!("http://127.0.0.1:{}", telegram.port),
        );

        prepared(root, scenario, fake_claude);
        with_stty(root);
        materialize(root, &with_pid(&scenario["files"], ""));

        let mut argv: Vec<String> = ["sh", "-c", PTY_WRAPPER, BCCT, "setup"]
            .map(str::to_owned)
            .to_vec();

        argv.extend(
            list(scenario, "args")
                .iter()
                .map(|arg| arg.as_str().unwrap().to_owned()),
        );

        let mut env = pty_env(root, &api);

        if let Some(extra) = scenario["env"].as_object() {
            env.extend(
                extra
                    .iter()
                    .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned())),
            );
        }

        let output = pty::record(&pty::Run {
            argv: &argv,
            env: &env,
            columns: scenario["columns"]
                .as_u64()
                .map_or(PTY_COLUMNS, |columns| u16::try_from(columns).unwrap()),
            rows: PTY_ROWS,
            steps: &pty_steps(scenario),
            redirect: None,
        })
        .unwrap();
        let shown = String::from_utf8_lossy(&output).into_owned();
        let facts = Facts {
            code: scraped_code(&output),
            pid: None,
        };

        assert_eq!(
            normalized(&strip_spinner(&shown), root, &facts),
            text(scenario, "output"),
            "{name}"
        );
        assert_eq!(
            without_the_shell_script(home_tree(root, &facts), root, name),
            expected_home(&scenario["after"]),
            "{name}: files"
        );
    }
}

fn modes_between(shown: &str) -> &str {
    let start = shown.find("[modes]").unwrap();
    let end = shown[start..].find("[/modes]").unwrap() + start;

    &shown[start..end]
}

fn assert_cooked(modes: &str) {
    let words: Vec<&str> = modes.split_whitespace().collect();

    for flag in ["icanon", "isig", "icrnl", "iexten"] {
        assert!(words.contains(&flag), "{flag}: {modes}");
    }
}

#[test]
fn a_closed_output_on_the_terminal_ends_without_offering_to_undo() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), "");
    with_stty(root);

    let argv: Vec<String> = [BCCT, "setup", "delay"].map(str::to_owned).to_vec();
    let output = pty::record(&pty::Run {
        argv: &argv,
        env: &pty_env(root, UNREACHABLE_API),
        columns: PTY_COLUMNS,
        rows: PTY_ROWS,
        steps: &[],
        redirect: Some(Path::new("/dev/full")),
    })
    .unwrap();
    let shown = String::from_utf8_lossy(&output).into_owned();

    assert!(shown.contains("Could not write to the output."), "{shown}");
    assert!(!shown.contains("Nothing"), "{shown}");
}

#[test]
fn ctrl_z_gives_the_terminal_back_while_stopped_and_fg_goes_on_asking() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), "");
    with_stty(root);
    std::os::unix::fs::symlink(resolved("bash"), root.join("bin/bash")).unwrap();

    let script = "set -m; printf '<<<'; \"$0\" setup delay; echo \"[stopped=$?]\"; echo \"[modes]\"; stty -a; echo \"[/modes]\"; fg; echo \"[exit=$?]\"";
    let argv: Vec<String> = ["bash", "-c", script, BCCT].map(str::to_owned).to_vec();
    let down = b"\x1b[B".to_vec();
    let steps = [
        pty::Step::Key(down.clone()),
        pty::Step::Key(down.clone()),
        pty::Step::Key(down.clone()),
        pty::Step::Key(down),
        pty::Step::Key(b"\r".to_vec()),
        pty::Step::Key(vec![0x1a]),
        pty::Step::Key(b"7\r".to_vec()),
    ];
    let output = pty::record(&pty::Run {
        argv: &argv,
        env: &pty_env(root, UNREACHABLE_API),
        columns: PTY_COLUMNS,
        rows: PTY_ROWS,
        steps: &steps,
        redirect: None,
    })
    .unwrap();
    let shown = String::from_utf8_lossy(&output).into_owned();

    assert!(shown.contains("[stopped=148]"), "{shown}");
    assert_cooked(modes_between(&shown));
    assert!(shown.contains("[exit=0]"), "{shown}");

    let config = fs::read_to_string(
        root.join("home/.claude/better-claude-code-telegram/better-cc-telegram.json"),
    )
    .unwrap();

    assert!(config.contains("\"delayMinutes\": 7"), "{config}");
}

fn signalled_modes(flow: &str, signal: &str) -> String {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(
        root,
        &json!({ "claude": { "marketplaces": [], "plugins": [] } }),
        "",
    );
    with_stty(root);

    let inner = format!("( sleep 1; kill -{signal} $$ ) & exec \"$0\" {flow}");
    let script = format!(
        "printf '<<<'; sh -c '{inner}' \"$0\"; echo \"[exit=$?]\"; echo \"[modes]\"; stty -a; echo \"[/modes]\""
    );
    let argv: Vec<String> = ["sh".to_owned(), "-c".to_owned(), script, BCCT.to_owned()].to_vec();
    let output = pty::record(&pty::Run {
        argv: &argv,
        env: &pty_env(root, UNREACHABLE_API),
        columns: PTY_COLUMNS,
        rows: PTY_ROWS,
        steps: &[],
        redirect: None,
    })
    .unwrap();
    let shown = String::from_utf8_lossy(&output).into_owned();

    assert_cooked(modes_between(&shown));

    shown
}

const SIGNAL_DRIVE: &str = "BCCT_SIGNAL_DRIVE";

const QUESTION_LIMIT: Duration = Duration::from_secs(60);

fn asking_a_question() -> bool {
    use rustix::termios::{LocalModes, tcgetattr};

    tcgetattr(std::io::stdin()).is_ok_and(|modes| !modes.local_modes.contains(LocalModes::ICANON))
}

fn wait_for_a_question() {
    let started = Instant::now();

    while !asking_a_question() && started.elapsed() < QUESTION_LIMIT {
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "runs inside a terminal, started by the test below"]
fn signal_driver() {
    use rustix::process::{Pid, Signal, kill_process};
    use std::os::unix::process::ExitStatusExt;

    let spec: Value = serde_json::from_str(&std::env::var(SIGNAL_DRIVE).unwrap()).unwrap();
    let signal = match text(&spec, "signal") {
        "SIGTERM" => Signal::TERM,
        _ => Signal::INT,
    };
    let mut child = Command::new(BCCT)
        .arg("setup")
        .args(list(&spec, "args").iter().map(|arg| arg.as_str().unwrap()))
        .spawn()
        .unwrap();

    wait_for_a_question();
    kill_process(Pid::from_child(&child), signal).unwrap();

    let status = child.wait().unwrap();
    let modes = Command::new("stty")
        .arg("-a")
        .stdin(Stdio::inherit())
        .output()
        .unwrap();

    print!(
        "[signal={:?}][code={:?}][modes]{}[/modes]",
        status.signal(),
        status.code(),
        String::from_utf8_lossy(&modes.stdout)
    );
    std::io::stdout().flush().unwrap();
}

#[test]
fn a_signal_ends_the_process_by_itself_like_node_and_shows_the_cursor_again() {
    const SIGTERM: i32 = 15;
    const SIGINT: i32 = 2;

    let fixture = fixture();

    for entry in list(&fixture, "signals") {
        let name = text(entry, "name");
        let folder = support::sandbox();
        let root = folder.path();
        let number = match text(entry, "signal") {
            "SIGTERM" => SIGTERM,
            _ => SIGINT,
        };
        let argv = [
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "signal_driver".to_owned(),
            "--exact".to_owned(),
            "--ignored".to_owned(),
            "--nocapture".to_owned(),
            "--test-threads".to_owned(),
            "1".to_owned(),
        ];
        let mut env = pty_env(root, UNREACHABLE_API);

        prepared(root, entry, text(&fixture, "fakeClaude"));
        with_stty(root);
        env.push((SIGNAL_DRIVE.to_owned(), entry.to_string()));

        let output = pty::record(&pty::Run {
            argv: &argv,
            env: &env,
            columns: PTY_COLUMNS,
            rows: PTY_ROWS,
            steps: &[],
            redirect: None,
        })
        .unwrap();
        let shown = String::from_utf8_lossy(&output).into_owned();
        let flow = &shown[..shown.find("[signal=").unwrap()];

        assert_eq!(entry["received"], entry["signal"], "{name}: the JS");
        assert_eq!(entry["code"], json!("null"), "{name}: the JS");
        assert_eq!(entry["cooked"], json!(true), "{name}: the JS");
        assert!(
            shown.contains(&format!("[signal=Some({number})][code=None]")),
            "{name}: {shown}"
        );
        assert_cooked(modes_between(&shown));
        assert!(flow.contains(HIDE_CURSOR), "{name}: {flow}");
        assert!(
            flow.rfind(SHOW_CURSOR) > flow.rfind(HIDE_CURSOR),
            "{name}: {flow}"
        );
    }
}

const SURVIVED_DRIVE: &str = "BCCT_SURVIVED_SIGNAL";

#[test]
#[ignore = "runs inside a terminal, started by the test below"]
fn survived_signal_driver() {
    use bcct::prompt::{Console, StdConsole};
    use rustix::process::{Signal, getpid, kill_process};

    let signal = match std::env::var(SURVIVED_DRIVE).unwrap().as_str() {
        "TERM" => Signal::TERM,
        _ => Signal::INT,
    };
    let mut console = StdConsole::new();

    bcct::signals::watch_with(None, |_| Ok(()));
    console.set_raw(true).unwrap();
    kill_process(getpid(), signal).unwrap();
    thread::sleep(Duration::from_secs(5));
    std::process::exit(99);
}

#[test]
fn a_signal_that_does_not_kill_ends_with_the_code_of_the_signal_and_the_terminal_back() {
    for (name, code) in [("TERM", 143), ("INT", 130)] {
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let script = "\"$0\" survived_signal_driver --exact --ignored --nocapture --test-threads 1; echo \"[exit=$?]\"; echo \"[modes]\"; stty -a; echo \"[/modes]\"".to_owned();
        let argv = ["sh".to_owned(), "-c".to_owned(), script, exe];
        let mut env: Vec<(String, String)> = coverage_env()
            .into_iter()
            .map(|(variable, value)| (variable.to_owned(), value.to_string_lossy().into_owned()))
            .collect();

        env.push((SURVIVED_DRIVE.to_owned(), name.to_owned()));

        let output = pty::record(&pty::Run {
            argv: &argv,
            env: &env,
            columns: PTY_COLUMNS,
            rows: PTY_ROWS,
            steps: &[],
            redirect: None,
        })
        .unwrap();
        let shown = String::from_utf8_lossy(&output).into_owned();

        assert!(shown.contains(&format!("[exit={code}]")), "{name}: {shown}");
        assert!(shown.contains(SHOW_CURSOR), "{name}: {shown}");
        assert_cooked(modes_between(&shown));
    }
}

#[test]
fn sigterm_at_a_question_gives_the_terminal_back_and_ends_by_the_signal() {
    for flow in ["setup delay", "setup --set transcription base", "uninstall"] {
        let shown = signalled_modes(flow, "TERM");

        assert!(shown.contains("[exit=143]"), "{flow}: {shown}");
    }
}

#[test]
fn sigint_from_outside_at_a_question_of_the_uninstall_gives_the_terminal_back() {
    let shown = signalled_modes("uninstall", "INT");

    assert!(shown.contains("[exit=130]"), "{shown}");
}

#[test]
fn sigint_from_outside_at_a_question_of_the_setup_does_not_end_it() {
    let folder = support::sandbox();
    let root = folder.path();

    prepared(root, &json!({}), "");
    with_stty(root);

    let script = "printf '<<<'; sh -c '( sleep 1; kill -INT $$ ) & exec \"$0\" setup delay' \"$0\"; echo \"[exit=$?]\"";
    let argv: Vec<String> = ["sh", "-c", script, BCCT].map(str::to_owned).to_vec();
    let output = pty::record(&pty::Run {
        argv: &argv,
        env: &pty_env(root, UNREACHABLE_API),
        columns: PTY_COLUMNS,
        rows: PTY_ROWS,
        steps: &[pty::Step::Pause(1500), pty::Step::Key(b"\r".to_vec())],
        redirect: None,
    })
    .unwrap();
    let shown = String::from_utf8_lossy(&output).into_owned();

    assert!(shown.contains("[exit=0]"), "{shown}");
}

#[test]
#[ignore = "runs inside a terminal, started by the test below"]
fn drop_driver() {
    use bcct::prompt::{Console, StdConsole};

    let mut console = StdConsole::new();

    console.set_raw(true).unwrap();
    print!("[raw]");
    drop(console);

    let modes = Command::new("stty")
        .arg("-a")
        .stdin(Stdio::inherit())
        .output()
        .unwrap();

    print!("[modes]{}[/modes]", String::from_utf8_lossy(&modes.stdout));

    std::io::stdout().flush().unwrap();
}

#[test]
fn a_console_dropped_in_raw_mode_gives_the_terminal_back() {
    let argv = [
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "drop_driver".to_owned(),
        "--exact".to_owned(),
        "--ignored".to_owned(),
        "--nocapture".to_owned(),
        "--test-threads".to_owned(),
        "1".to_owned(),
    ];
    let env: Vec<(String, String)> = coverage_env()
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_string_lossy().into_owned()))
        .collect();
    let output = pty::record(&pty::Run {
        argv: &argv,
        env: &env,
        columns: PTY_COLUMNS,
        rows: PTY_ROWS,
        steps: &[],
        redirect: None,
    })
    .unwrap();
    let shown = String::from_utf8_lossy(&output).into_owned();

    assert!(shown.contains("[raw]"), "{shown}");
    assert_cooked(modes_between(&shown));
}
