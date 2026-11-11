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
use bcct::js::stringify;
use bcct::setup::{shell_script, whisper_python_works};
use bcct::spinner::Terminal;
use bcct::telegram::{API_ROOT_ENV, DEFAULT_API_ROOT, api_root, post_json, request_url};
use bcct::ui::should_colorize;
use serde_json::{Value, json};
use support::{
    Tree, default_file_mode, expected_tree, list, lookup, materialize, placeholders, sandbox,
    snapshot, strings, substitute, text,
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

const PATH_LABEL: &str = "bcct on PATH";

fn frozen(source: &str) -> Value {
    serde_json::from_str(source).unwrap()
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

struct Observed {
    status: Value,
    stdout: String,
    stderr: String,
    requests: Value,
    after: Tree,
}

fn observe(scenario: &Value, now: u64) -> Observed {
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

    Observed {
        status: json!(status),
        stdout: placeholders(&String::from_utf8(out).unwrap(), root.path()),
        stderr: placeholders(&String::from_utf8(err).unwrap(), root.path()),
        requests: telegram.requests(),
        after: snapshot(root.path()),
    }
}

#[test]
fn every_scenario_prints_what_the_fixture_recorded() {
    let fixture = frozen(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();
    let scenarios = list(&fixture, "scenarios");

    assert!(scenarios.len() > 300);

    for scenario in scenarios {
        let name = text(scenario, "name");
        let observed = observe(scenario, now);

        assert_eq!(observed.status, scenario["status"], "{name}: status");
        assert_eq!(observed.stdout, text(scenario, "stdout"), "{name}: stdout");
        assert_eq!(observed.stderr, text(scenario, "stderr"), "{name}: stderr");
        assert_eq!(observed.requests, scenario["requests"], "{name}: requests");
        assert_eq!(
            observed.after,
            expected_tree(&scenario["after"], None, &default_mode),
            "{name}: files"
        );
    }
}

#[test]
fn every_scenario_of_the_binary_matches_the_fixture() {
    let fixture = frozen(FIXTURE);
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

struct Painted {
    status: Value,
    terminal: String,
    repainted: bool,
    requests: Value,
}

fn observe_terminal(scenario: &Value) -> Painted {
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

    Painted {
        status: json!(output.status.code()),
        terminal,
        repainted,
        requests: telegram.requests(),
    }
}

#[cfg(target_os = "linux")]
#[test]
fn every_terminal_scenario_spins_and_prints_what_the_fixture_recorded() {
    let fixture = frozen(FIXTURE);

    for scenario in list(&fixture, "tty") {
        let name = text(scenario, "name");
        let painted = observe_terminal(scenario);

        assert_eq!(painted.status, scenario["status"], "{name}: status");
        assert_eq!(
            painted.terminal,
            text(scenario, "terminal"),
            "{name}: terminal"
        );

        if scenario["repainted"] == json!(true) {
            assert!(painted.repainted, "{name}: the spinner never turned");
        }

        assert_eq!(painted.requests, scenario["requests"], "{name}: requests");
    }
}

fn blessing() -> bool {
    std::env::var_os("BCCT_BLESS").is_some_and(|flag| flag == "1")
}

fn after_value(tree: &Tree) -> Value {
    Value::Object(
        tree.iter()
            .map(|(path, (content, mode))| {
                let mut entry = serde_json::Map::new();

                if let Some(content) = content {
                    entry.insert("content".to_owned(), json!(content));
                }

                entry.insert("mode".to_owned(), json!(mode));
                (path.clone(), Value::Object(entry))
            })
            .collect(),
    )
}

#[cfg(target_os = "linux")]
#[test]
fn blessing_rewrites_the_health_fixture_from_the_binary() {
    if !blessing() {
        return;
    }

    let mut fixture = frozen(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let default_mode = default_file_mode();

    for scenario in fixture["scenarios"].as_array_mut().unwrap() {
        let observed = observe(scenario, now);

        scenario["status"] = observed.status;
        scenario["stdout"] = json!(observed.stdout);
        scenario["stderr"] = json!(observed.stderr);
        scenario["requests"] = observed.requests;

        if observed.after != expected_tree(&scenario["after"], None, &default_mode) {
            scenario["after"] = after_value(&observed.after);
        }
    }

    for scenario in fixture["tty"].as_array_mut().unwrap() {
        let painted = observe_terminal(scenario);

        scenario["status"] = painted.status;
        scenario["terminal"] = json!(painted.terminal);
        scenario["requests"] = painted.requests;
    }

    std::fs::write(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/health.json"),
        stringify(&fixture)
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029"),
    )
    .unwrap();
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
    run_prepared(scenario, args, out, terminal, colorize, &|_| {})
}

fn run_prepared(
    scenario: &Value,
    args: &[&str],
    out: &mut Failing,
    terminal: Option<Terminal>,
    colorize: bool,
    prepare: &dyn Fn(&Path),
) -> (u8, String) {
    let fixture = frozen(FIXTURE);
    let now = fixture["now"].as_u64().unwrap();
    let root = sandbox();
    let telegram = FakeTelegram::start(scenario);
    materialize(root.path(), &filled(&scenario["files"], now));
    prepare(root.path());
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
    let shown = placeholders(&String::from_utf8(err).unwrap(), root.path());

    writable_again(root.path());

    (status, shown)
}

fn writable_again(folder: &Path) {
    use std::os::unix::fs::PermissionsExt;

    for entry in std::fs::read_dir(folder).unwrap().flatten() {
        let path = entry.path();

        if path.is_dir() && !path.is_symlink() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o750)).unwrap();
            writable_again(&path);
        }
    }
}

const NOT_SHOWN: &str = "✘ Could not show the result.\n";

#[test]
fn a_green_result_that_cannot_be_written_ends_with_failure_and_says_so() {
    let fixture = frozen(FIXTURE);
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
    let fixture = frozen(FIXTURE);
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
    let fixture = frozen(FIXTURE);
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
    let fixture = frozen(FIXTURE);
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
    let fixture = frozen(FIXTURE);
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
    let fixture = frozen(FIXTURE);
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
    let fixture = frozen(FIXTURE);

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

fn path_check_of(scenario: &Value) -> (u8, String) {
    let mut out = Failing::new(|_| false);
    let (status, _) = run_failing(scenario, &["install"], &mut out, None, false);
    let shown = String::from_utf8(out.accepted).unwrap();
    let line = shown
        .lines()
        .find(|line| line.contains(PATH_LABEL))
        .unwrap()
        .to_owned();

    (status, line)
}

#[test]
fn the_path_check_says_whether_bcct_is_on_the_path_and_never_fails() {
    let fixture = frozen(FIXTURE);
    let healthy = scenario_named(&fixture, "a healthy machine passes every check").clone();
    let config = "app/better-cc-telegram.json";
    let mut turned_on = healthy.clone();
    turned_on["files"][config] =
        json!(r#"{"language":"en-us","transcription":{"model":"small"},"commandOnPath":true}"#);
    turned_on["files"]["app/shell.sh"] = json!(shell_script(Path::new("{root}/app"), true));
    let mut listed = turned_on.clone();
    listed["env"]["PATH"] = json!("{root}/bin:{root}/app/bin:/usr/bin:/bin");

    assert_eq!(
        path_check_of(&healthy),
        (
            0,
            "○ bcct on PATH: off (optional). Run 'npx better-claude-code-telegram path'."
                .to_owned()
        )
    );

    let (status, pending) = path_check_of(&turned_on);

    assert_eq!(status, 0);
    assert!(
        pending.starts_with("○ bcct on PATH: turned on in ")
            && pending.ends_with("/app/shell.sh; it applies to new terminals"),
        "{pending}"
    );

    let (status, on) = path_check_of(&listed);

    assert_eq!(status, 0);
    assert!(
        on.starts_with("✔ bcct on PATH: ") && on.ends_with("/app/bin"),
        "{on}"
    );
}

fn install_row(scenario: &Value, label: &str, prepare: &dyn Fn(&Path)) -> (u8, String) {
    let root = std::cell::RefCell::new(PathBuf::new());
    let mut out = Failing::new(|_| false);
    let (status, _) = run_prepared(scenario, &["install"], &mut out, None, false, &|folder| {
        *root.borrow_mut() = folder.to_path_buf();
        prepare(folder);
    });
    let shown = placeholders(&String::from_utf8(out.accepted).unwrap(), &root.borrow());
    let line = shown
        .lines()
        .find(|line| line.contains(&format!(" {label}: ")))
        .unwrap()
        .to_owned();

    (status, line)
}

fn healthy() -> Value {
    scenario_named(&frozen(FIXTURE), "a healthy machine passes every check").clone()
}

fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

fn write(path: &Path, content: &str, mode: u32) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
    set_mode(path, mode);
}

const RUN_SETUP: &str = "Run 'npx better-claude-code-telegram'.";

#[test]
fn the_launcher_check_names_the_active_version_and_its_channel() {
    assert_eq!(
        install_row(&healthy(), "Launcher", &|_| {}),
        (0, "✔ Launcher: version 0.1.0 active (stable)".to_owned())
    );
    assert_eq!(
        install_row(&healthy(), "Launcher", &|root| {
            let bin = root.join("app/bin");
            write(&bin.join("current"), "unstable/beta/0.2.0-beta.1\n", 0o600);
            write(
                &bin.join("versions/unstable/beta/0.2.0-beta.1/bcct"),
                "#!/bin/sh\n",
                0o755,
            );
        }),
        (
            0,
            "✔ Launcher: version 0.2.0-beta.1 active (beta)".to_owned()
        )
    );
}

#[test]
fn a_missing_or_not_executable_launcher_fails_and_says_to_run_the_setup() {
    let missing = format!("✘ Launcher: no launcher in {{root}}/app/bin. {RUN_SETUP}");

    assert_eq!(
        install_row(&healthy(), "Launcher", &|root| {
            std::fs::remove_file(root.join("app/bin/bcct")).unwrap();
        }),
        (1, missing.clone())
    );
    assert_eq!(
        install_row(&healthy(), "Launcher", &|root| {
            set_mode(&root.join("app/bin/bcct"), 0o644);
        }),
        (1, missing)
    );
}

#[test]
fn a_launcher_without_a_usable_version_fails_and_says_to_run_the_setup() {
    let no_version = format!("✘ Launcher: the launcher has no active version. {RUN_SETUP}");

    for current in [
        None,
        Some("stable/9.9.9\n"),
        Some("0.1.0\n"),
        Some("stable/\n"),
        Some("/0.1.0\n"),
    ] {
        assert_eq!(
            install_row(&healthy(), "Launcher", &|root| {
                let file = root.join("app/bin/current");

                match current {
                    Some(text) => write(&file, text, 0o600),
                    None => std::fs::remove_file(&file).unwrap(),
                }
            }),
            (1, no_version.clone()),
            "{current:?}"
        );
    }

    assert_eq!(
        install_row(&healthy(), "Launcher", &|root| {
            set_mode(&root.join("app/bin/versions/stable/0.1.0/bcct"), 0o644);
        }),
        (1, no_version)
    );
}

#[test]
fn an_app_folder_that_cannot_be_written_fails_with_the_chmod_to_run() {
    let mut owned = healthy();
    owned["uid"] = json!(rustix::process::getuid().as_raw());

    for folder in ["app", "app/asks", "app/pings"] {
        assert_eq!(
            install_row(&owned, "App folder", &|root| {
                std::fs::create_dir_all(root.join(folder)).unwrap();
                set_mode(&root.join(folder), 0o500);
            }),
            (
                1,
                format!(
                    "✘ App folder: cannot write to {{root}}/{folder} (no write permission). Run 'chmod u+rwx {{root}}/{folder}'."
                )
            ),
            "{folder}"
        );
    }
}

#[test]
fn an_app_folder_of_another_user_fails_with_the_chown_to_run() {
    let mut stranger = healthy();
    stranger["uid"] = json!(rustix::process::getuid().as_raw() + 1);
    stranger["env"]["USER"] = json!("ana");

    assert_eq!(
        install_row(&stranger, "App folder", &|root| {
            std::fs::create_dir_all(root.join("app/pings")).unwrap();
            set_mode(&root.join("app/pings"), 0o500);
        }),
        (
            1,
            "✘ App folder: {root}/app/pings belongs to another user. Run 'sudo chown -R ana {root}/app/pings'."
                .to_owned()
        )
    );
}

#[test]
fn the_hooks_check_lists_every_open_warning_of_the_hooks() {
    let failures = json!({
        "transient": [],
        "notices": {
            "Stop": {"reason": "disk-full", "file": "/x/pings/s1.json", "count": 0, "told": false},
            "PostToolUse": {"reason": "busy", "file": null, "count": 3, "told": true},
        }
    })
    .to_string();

    assert_eq!(
        install_row(&healthy(), "Hooks", &|_| {}),
        (0, "✔ Hooks: no recent failures".to_owned())
    );
    assert_eq!(
        install_row(&healthy(), "Hooks", &|root| {
            write(&root.join("app/hook-failures.json"), &failures, 0o600);
        }),
        (
            1,
            "✘ Hooks: the PostToolUse hook failed 3 times in 24 h (file busy or changed by another instance); the Stop hook could not write /x/pings/s1.json (disk full)"
                .to_owned()
        )
    );
}

#[test]
fn a_missing_or_old_shell_script_fails_the_shell_check() {
    let plugin = "Run 'npx better-claude-code-telegram plugin'.";

    assert_eq!(
        install_row(&healthy(), "Shell", &|root| {
            std::fs::remove_file(root.join("app/shell.sh")).unwrap();
        }),
        (
            1,
            format!(
                "✘ Shell: {{root}}/home/.bashrc loads {{root}}/app/shell.sh, which does not exist. {plugin}"
            )
        )
    );
    assert_eq!(
        install_row(&healthy(), "Shell", &|root| {
            write(&root.join("app/shell.sh"), "claude() { :; }\n", 0o600);
        }),
        (
            1,
            format!("✘ Shell: {{root}}/app/shell.sh is out of date. {plugin}")
        )
    );
}

#[test]
fn an_active_line_in_another_rc_counts_over_a_commented_one() {
    let line = "[ -f \"{root}/app/shell.sh\" ] && . \"{root}/app/shell.sh\"\n";

    assert_eq!(
        install_row(&healthy(), "Shell", &|root| {
            let active = line.replace("{root}", &root.to_string_lossy());
            write(&root.join("home/.bashrc"), &format!("# {active}"), 0o600);
            write(&root.join("home/.zshrc"), &active, 0o600);
        }),
        (0, "✔ Shell: loaded by {root}/home/.zshrc".to_owned())
    );
}
