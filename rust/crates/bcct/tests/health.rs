#![cfg(unix)]
#![cfg(test)]

mod support;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::health::{Machine, Screen, run};
use bcct::setup::whisper_python_works;
use bcct::spinner::Terminal;
use bcct::telegram::{API_ROOT_ENV, DEFAULT_API_ROOT, api_root, post_json, request_url};
use bcct::ui::should_colorize;
use serde_json::{Value, json};
use support::{
    Tree, default_file_mode, expected_tree, list, lookup, materialize, parse, placeholders,
    repo_root, sandbox, snapshot, strings, substitute, text,
};

const FIXTURE: &str = include_str!("fixtures/health.json");
const BCCT: &str = env!("CARGO_BIN_EXE_bcct");
const CYAN: &str = "\u{1b}[36m";
const SPINNER_FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const REGULAR_UID: u32 = 1000;

struct FakeTelegram {
    root: String,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl FakeTelegram {
    fn start(scenario: &Value) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());

        if scenario["api"] == json!("refused") {
            return Self { root, requests };
        }

        let replies = list(scenario, "replies").clone();
        let recorded = Arc::clone(&requests);

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                serve(stream, &replies, &recorded);
            }
        });

        Self { root, requests }
    }

    fn requests(&self) -> Value {
        Value::Array(self.requests.lock().unwrap().clone())
    }
}

fn serve(stream: TcpStream, replies: &[Value], recorded: &Mutex<Vec<Value>>) {
    let mut reader = BufReader::new(stream);
    let mut start = String::new();
    reader.read_line(&mut start).unwrap();
    let mut headers = HashMap::new();

    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();

        if line.is_empty() {
            break;
        }

        let (name, value) = line.split_once(':').unwrap();
        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
    }

    let length = headers
        .get("content-length")
        .map_or(0, |length| length.parse::<usize>().unwrap());
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let mut parts = start.split(' ');
    let method = parts.next().unwrap().to_owned();
    let path = parts.next().unwrap().to_owned();
    let index = {
        let mut requests = recorded.lock().unwrap();
        requests.push(json!({
            "method": method,
            "path": path,
            "contentType": headers.get("content-type"),
            "body": String::from_utf8(body).unwrap(),
        }));
        requests.len() - 1
    };
    let fallback = json!({"status": 500, "body": "{\"ok\":false}"});
    let answer = replies.get(index).unwrap_or(&fallback);

    if answer.get("drop").is_some() {
        return;
    }

    let payload: Vec<u8> = answer.get("bytes").map_or_else(
        || text(answer, "body").as_bytes().to_vec(),
        |bytes| {
            bytes
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
                .collect()
        },
    );
    let mut stream = reader.into_inner();
    let head = format!(
        "HTTP/1.1 {} X\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
        answer["status"],
        payload.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&payload).unwrap();
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

fn timed(text: &str, now: u64) -> String {
    let mut out = String::new();
    let mut rest = text;

    while let Some(start) = rest.find("{now") {
        let (before, from) = rest.split_at(start);
        let end = from.find('}').unwrap();
        let offset = from.get(4..end).unwrap();
        let value = if offset.is_empty() {
            i128::from(now)
        } else {
            i128::from(now) + offset.parse::<i128>().unwrap()
        };

        out.push_str(before);
        out.push_str(&value.to_string());
        rest = from.get(end + 1..).unwrap();
    }

    out.push_str(rest);
    out
}

fn filled(value: &Value, now: u64) -> Value {
    serde_json::from_str(&timed(&serde_json::to_string(value).unwrap(), now)).unwrap()
}

fn variables_of(scenario: &Value, root: &Path, api: &str) -> HashMap<String, OsString> {
    scenario["env"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                OsString::from(substitute(value.as_str().unwrap(), root).replace("{api}", api)),
            )
        })
        .collect()
}

fn home_of(variables: &HashMap<String, OsString>, root: &Path) -> PathBuf {
    variables
        .get("HOME")
        .map_or_else(|| root.join("passwd-home"), PathBuf::from)
}

fn expected_after(scenario: &Value, root: &Path, now: u64, default_mode: &str) -> Tree {
    let mut tree = expected_tree(&scenario["after"], None, default_mode);

    for (path, spec) in scenario["files"].as_object().unwrap() {
        let content = spec
            .as_str()
            .or_else(|| spec.get("content").and_then(Value::as_str));

        if let Some(content) = content.filter(|content| content.contains("{now")) {
            let entry = tree.get_mut(path).unwrap();
            entry.0 = Some(placeholders(&substitute(&timed(content, now), root), root));
        }
    }

    tree
}

#[test]
fn every_scenario_prints_what_health_mjs_prints() {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();
    let repo = repo_root();
    let scenarios = list(&fixture, "scenarios");

    assert!(scenarios.len() > 300);

    for scenario in scenarios {
        let name = text(scenario, "name");
        let root = sandbox();
        let telegram = FakeTelegram::start(scenario);
        materialize(root.path(), &filled(&scenario["files"], now));
        let variables = variables_of(scenario, root.path(), &telegram.root);
        let var = lookup(&variables);
        let bin = root.path().join("bin");
        let version = text(scenario, "nodeVersion").to_owned();
        let node_version = || Some(version.clone());
        let has_command = |name: &str| bin.join(name).is_file();
        let claude_output = |args: &[&str]| {
            Command::new(bin.join("claude"))
                .args(args)
                .stdin(Stdio::null())
                .output()
                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                .unwrap_or_default()
        };
        let machine = Machine {
            var: &var,
            home: &home_of(&variables, root.path()),
            repo: &repo,
            uid: Some(
                scenario["uid"]
                    .as_u64()
                    .map_or(REGULAR_UID, |uid| u32::try_from(uid).unwrap()),
            ),
            now,
            node_version: &node_version,
            has_command: &has_command,
            claude_output: &claude_output,
            python_works: &whisper_python_works,
            fetch: &post_json,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let colorize = should_colorize(&var, false);
        let mut screen = Screen {
            out: &mut out,
            err: &mut err,
            terminal: None,
            colorize_out: colorize,
            colorize_err: colorize,
            spin: &|_, _| None,
        };

        let status = run(&strings(&scenario["args"]), &machine, &mut screen);

        assert!(format!("{machine:?}").starts_with("Machine {"));
        assert!(format!("{screen:?}").starts_with("Screen {"));
        assert_eq!(json!(status), scenario["status"], "{name}: status");
        assert_eq!(
            placeholders(&String::from_utf8(out).unwrap(), root.path()),
            text(scenario, "stdout"),
            "{name}: stdout"
        );
        assert_eq!(
            placeholders(&String::from_utf8(err).unwrap(), root.path()),
            text(scenario, "stderr"),
            "{name}: stderr"
        );
        assert_eq!(
            telegram.requests(),
            scenario["requests"],
            "{name}: requests"
        );
        assert_eq!(
            snapshot(root.path()),
            expected_tree(&scenario["after"], None, &default_mode),
            "{name}: files"
        );
    }
}

#[test]
fn every_scenario_of_the_binary_matches_health_mjs() {
    let fixture = parse(FIXTURE);
    let default_mode = default_file_mode();
    let scenarios: Vec<&Value> = list(&fixture, "scenarios")
        .iter()
        .filter(|scenario| scenario["process"] == json!(true))
        .collect();

    assert!(scenarios.len() > 290);

    for scenario in scenarios {
        let name = text(scenario, "name");
        let root = sandbox();
        let telegram = FakeTelegram::start(scenario);
        let now = now_ms();
        materialize(root.path(), &filled(&scenario["files"], now));
        let output = cargo_bin_cmd!("bcct")
            .arg("health")
            .args(strings(&scenario["args"]))
            .env_clear()
            .envs(support::coverage_env())
            .envs(variables_of(scenario, root.path(), &telegram.root))
            .current_dir(root.path())
            .timeout(Duration::from_secs(60))
            .output()
            .unwrap();

        assert_eq!(
            json!(output.status.code()),
            scenario["status"],
            "{name}: status"
        );
        assert_eq!(
            placeholders(&String::from_utf8(output.stdout).unwrap(), root.path()),
            text(scenario, "stdout"),
            "{name}: stdout"
        );
        assert_eq!(
            placeholders(&String::from_utf8(output.stderr).unwrap(), root.path()),
            text(scenario, "stderr"),
            "{name}: stderr"
        );
        assert_eq!(
            telegram.requests(),
            scenario["requests"],
            "{name}: requests"
        );
        assert_eq!(
            snapshot(root.path()),
            expected_after(scenario, root.path(), now, &default_mode),
            "{name}: files"
        );
    }
}

fn normalized_terminal(raw: &str) -> (String, bool) {
    let joined = raw.replace("\r\n", "\n");
    let mut parts = joined.split('\r');
    let mut out = parts.next().unwrap_or_default().to_owned();
    let mut repainted = false;

    for part in parts {
        let frame = part.strip_prefix(CYAN).unwrap_or(part);

        if frame
            .chars()
            .next()
            .is_some_and(|first| SPINNER_FRAMES.contains(&first))
            && !part.contains('\n')
        {
            repainted = true;
        } else {
            out.push('\r');
            out.push_str(part);
        }
    }

    (out, repainted)
}

fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(target_os = "linux")]
#[test]
fn every_terminal_scenario_spins_and_prints_like_health_mjs() {
    let fixture = parse(FIXTURE);

    for scenario in list(&fixture, "tty") {
        let name = text(scenario, "name");
        let root = sandbox();
        let telegram = FakeTelegram::start(scenario);
        materialize(root.path(), &filled(&scenario["files"], now_ms()));
        let columns = scenario["columns"]
            .as_u64()
            .map(|columns| format!("stty cols {columns}; "))
            .unwrap_or_default();
        let command = format!(
            "{columns}{}",
            [BCCT.to_owned(), "health".to_owned()]
                .into_iter()
                .chain(strings(&scenario["args"]))
                .map(|arg| quoted(&arg))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let output = Command::new("script")
            .args(["-qec", &command, "/dev/null"])
            .env_clear()
            .envs(support::coverage_env())
            .envs(variables_of(scenario, root.path(), &telegram.root))
            .current_dir(root.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let (terminal, repainted) = normalized_terminal(&placeholders(
            &String::from_utf8(output.stdout).unwrap(),
            root.path(),
        ));

        assert_eq!(
            json!(output.status.code()),
            scenario["status"],
            "{name}: status"
        );
        assert_eq!(terminal, text(scenario, "terminal"), "{name}: terminal");

        if scenario["repainted"] == json!(true) {
            assert!(repainted, "{name}: the spinner never turned");
        }

        assert_eq!(
            telegram.requests(),
            scenario["requests"],
            "{name}: requests"
        );
    }
}

#[test]
fn a_node_that_cannot_be_found_fails_the_node_check() {
    let root = sandbox();
    let variables = HashMap::from([
        ("HOME".to_owned(), root.path().as_os_str().to_owned()),
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            root.path().join("claude").into_os_string(),
        ),
    ]);
    let var = lookup(&variables);
    let machine = Machine {
        var: &var,
        home: root.path(),
        repo: root.path(),
        uid: None,
        now: 0,
        node_version: &|| None,
        has_command: &|name| name == "claude",
        claude_output: &|_| String::new(),
        python_works: &|_| false,
        fetch: &|_, _| None,
    };
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut screen = Screen {
        out: &mut out,
        err: &mut err,
        terminal: None,
        colorize_out: false,
        colorize_err: false,
        spin: &|_, _| None,
    };

    let status = run(
        &["--json".to_owned(), "install".to_owned()],
        &machine,
        &mut screen,
    );
    let results: Value = serde_json::from_slice(&out).unwrap();

    assert_eq!(status, 1);
    assert_eq!(
        results[0],
        json!({"group": "install", "check": "node", "status": "fail", "detail": "missing"})
    );
    assert_eq!(err, Vec::<u8>::new());
}

struct Failing {
    accepted: Vec<u8>,
    writes: usize,
    refuses: fn(usize) -> bool,
}

impl Failing {
    fn new(refuses: fn(usize) -> bool) -> Self {
        Self {
            accepted: Vec::new(),
            writes: 0,
            refuses,
        }
    }
}

impl Write for Failing {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.writes += 1;

        if (self.refuses)(self.writes) {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }

        self.accepted.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn scenario_named<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    list(fixture, "scenarios")
        .iter()
        .find(|scenario| text(scenario, "name") == name)
        .unwrap()
}

fn run_failing(
    scenario: &Value,
    args: &[&str],
    out: &mut Failing,
    terminal: Option<Terminal>,
    colorize: bool,
) -> (u8, String) {
    let fixture = parse(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let repo = repo_root();
    let root = sandbox();
    let telegram = FakeTelegram::start(scenario);
    materialize(root.path(), &filled(&scenario["files"], now));
    let variables = variables_of(scenario, root.path(), &telegram.root);
    let var = lookup(&variables);
    let bin = root.path().join("bin");
    let version = text(scenario, "nodeVersion").to_owned();
    let node_version = || Some(version.clone());
    let has_command = |name: &str| bin.join(name).is_file();
    let claude_output = |args: &[&str]| {
        Command::new(bin.join("claude"))
            .args(args)
            .stdin(Stdio::null())
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
            .unwrap_or_default()
    };
    let machine = Machine {
        var: &var,
        home: &home_of(&variables, root.path()),
        repo: &repo,
        uid: Some(REGULAR_UID),
        now,
        node_version: &node_version,
        has_command: &has_command,
        claude_output: &claude_output,
        python_works: &whisper_python_works,
        fetch: &post_json,
    };
    let mut err = Vec::new();
    let mut screen = Screen {
        out,
        err: &mut err,
        terminal,
        colorize_out: false,
        colorize_err: colorize,
        spin: &|_, _| None,
    };
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();

    let status = run(&args, &machine, &mut screen);

    (status, String::from_utf8(err).unwrap())
}

const NOT_SHOWN: &str = "✘ Could not show the result.\n";

#[test]
fn a_green_result_that_cannot_be_written_ends_with_failure_and_says_so() {
    let fixture = parse(FIXTURE);
    let green = scenario_named(&fixture, "a healthy machine passes every check");

    assert_eq!(green["status"], json!(0));

    for args in [&[][..], &["--json"][..]] {
        let mut out = Failing::new(|_| true);

        assert_eq!(
            run_failing(green, args, &mut out, None, false),
            (1, NOT_SHOWN.to_owned()),
            "{args:?}"
        );
        assert_eq!(out.accepted, Vec::<u8>::new());
    }
}

#[test]
fn a_red_result_that_cannot_be_written_also_says_so() {
    let fixture = parse(FIXTURE);
    let red = scenario_named(&fixture, "everything broken");

    assert_eq!(red["status"], json!(1));

    for args in [&[][..], &["--json"][..]] {
        let mut out = Failing::new(|_| true);

        assert_eq!(
            run_failing(red, args, &mut out, None, false),
            (1, NOT_SHOWN.to_owned()),
            "{args:?}"
        );
    }
}

#[test]
fn the_result_stops_at_the_first_line_that_cannot_be_written() {
    let fixture = parse(FIXTURE);
    let green = scenario_named(&fixture, "a healthy machine passes every check");
    let mut out = Failing::new(|write| write == 2);

    assert_eq!(
        run_failing(green, &[], &mut out, None, true),
        (
            1,
            "\u{1b}[31m✘ Could not show the result.\u{1b}[39m\n".to_owned()
        )
    );
    assert_eq!(String::from_utf8(out.accepted).unwrap(), "Install\n");
}

#[test]
fn a_spinner_line_that_cannot_be_written_also_fails_the_result() {
    let fixture = parse(FIXTURE);
    let green = scenario_named(&fixture, "a healthy machine passes every check");
    let terminal = Some(Terminal { columns: None });
    let mut out = Failing::new(|write| write == 2);

    assert_eq!(
        run_failing(green, &["install"], &mut out, terminal, false),
        (1, NOT_SHOWN.to_owned())
    );
    assert_eq!(
        String::from_utf8(out.accepted).unwrap(),
        "Install\n\r\u{1b}[2K✔ Node: Node 24.20.0\n"
    );
}

#[test]
fn a_result_in_pt_br_that_cannot_be_written_says_so_in_pt_br() {
    let fixture = parse(FIXTURE);
    let scenario = scenario_named(&fixture, "locale from a pt-br config");
    let mut out = Failing::new(|_| true);

    assert_eq!(
        run_failing(scenario, &["--json"], &mut out, None, false),
        (1, "✘ Não foi possível mostrar o resultado.\n".to_owned())
    );
}

#[cfg(target_os = "linux")]
#[test]
fn the_binary_with_a_full_disk_as_stdout_ends_with_failure_and_says_so() {
    let fixture = parse(FIXTURE);
    let green = scenario_named(&fixture, "a healthy machine passes every check");

    for args in [&["health"][..], &["health", "--json"][..]] {
        let root = sandbox();
        let telegram = FakeTelegram::start(green);
        materialize(root.path(), &filled(&green["files"], now_ms()));
        let output = Command::new(BCCT)
            .args(args)
            .env_clear()
            .envs(support::coverage_env())
            .envs(variables_of(green, root.path(), &telegram.root))
            .current_dir(root.path())
            .stdin(Stdio::null())
            .stdout(std::fs::File::create("/dev/full").unwrap())
            .output()
            .unwrap();

        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            NOT_SHOWN,
            "{args:?}"
        );
    }
}

#[test]
fn every_request_url_is_the_one_node_fetch_sends() {
    let fixture = parse(FIXTURE);

    for entry in list(&fixture, "urls") {
        assert_eq!(
            request_url(
                text(entry, "root"),
                text(entry, "token"),
                text(entry, "method")
            ),
            text(entry, "url"),
            "{entry}"
        );
    }

    assert_eq!(request_url("x", "t", "m"), "x/bott/m");
}

#[test]
fn the_api_root_falls_back_to_telegram_only_when_unset_or_empty() {
    let empty = HashMap::from([(API_ROOT_ENV.to_owned(), OsString::new())]);
    let set = HashMap::from([(API_ROOT_ENV.to_owned(), OsString::from("http://x"))]);

    assert_eq!(api_root(&|_| None), DEFAULT_API_ROOT);
    assert_eq!(api_root(&lookup(&empty)), DEFAULT_API_ROOT);
    assert_eq!(api_root(&lookup(&set)), "http://x");
}

#[test]
fn the_terminal_normalizer_drops_only_the_repainted_frames() {
    assert_eq!(
        normalized_terminal("a\r\n⠋ x\r⠙ x\r\u{1b}[36m⠹\u{1b}[39m x\r\u{1b}[2K✔ x\r\n"),
        ("a\n⠋ x\r\u{1b}[2K✔ x\n".to_owned(), true)
    );
    assert_eq!(
        normalized_terminal("⠋ x\r⠙ x\nmore"),
        ("⠋ x\r⠙ x\nmore".to_owned(), false)
    );
    assert_eq!(normalized_terminal(""), (String::new(), false));
    assert_eq!(timed("{now}|{now-5}|{now+5}|x", 10), "10|5|15|x");
}
