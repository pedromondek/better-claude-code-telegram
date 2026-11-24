#![cfg(unix)]
#![cfg(test)]

mod support;

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bcct::health::Screen;
use bcct::js::{js_template, js_trim, stringify, stringify_pretty};
use bcct::locale::Locale;
use bcct::messages::{Messages, messages_for};
use bcct::setup::{is_paired, parse_env_token};
use bcct::setup_telegram::{
    Candidate, Failure, PairingChoice, Prompts, SavedBot, TelegramSetup, Tracks, build_access,
    ensure_pairing, ensure_token, find_pairing_candidate, groups_warning, last_update_id,
    load_saved_bot, paired_accounts, pairing_code, pairing_link, random_bytes,
};
use bcct::spinner::Terminal;
use bcct::telegram::{Interruption, abortable_post_json, api_root, call, post_json};
use bcct::ui::{fail, question};
use serde_json::{Map, Value, json};
use support::{
    Tree, default_file_mode, expected_tree, list, materialize, parse, placeholders, sandbox,
    snapshot, text,
};

const FIXTURE: &str = include_str!("fixtures/setup-telegram.json");
const HOLD_LIMIT: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Shared {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
}

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct Replies {
    list: Vec<Value>,
    used: HashSet<usize>,
}

struct FakeTelegram {
    root: String,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl FakeTelegram {
    fn start(replies: &[Value]) -> Self {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let replies = Arc::new(Mutex::new(Replies {
            list: replies.to_vec(),
            used: HashSet::new(),
        }));
        let recorded = Arc::clone(&requests);

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let replies = Arc::clone(&replies);
                let recorded = Arc::clone(&recorded);

                std::thread::spawn(move || serve(stream, &replies, &recorded));
            }
        });

        Self { root, requests }
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

fn pick(replies: &Mutex<Replies>, method: &str, chat_id: &str) -> Value {
    let mut replies = replies.lock().unwrap();
    let found = replies.list.iter().enumerate().position(|(index, reply)| {
        !replies.used.contains(&index)
            && reply["method"] == json!(method)
            && reply
                .get("chatId")
                .is_none_or(|wanted| wanted == &json!(chat_id))
    });

    found.map_or_else(
        || json!({"status": 500, "body": "{\"ok\":false}"}),
        |index| {
            replies.used.insert(index);
            replies.list[index].clone()
        },
    )
}

fn serve(stream: TcpStream, replies: &Mutex<Replies>, recorded: &Mutex<Vec<Value>>) {
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
    let body = String::from_utf8(body).unwrap();
    let mut parts = start.split(' ');
    let method = parts.next().unwrap().to_owned();
    let path = parts.next().unwrap().to_owned();
    let chat_id = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|params| params.get("chat_id").cloned())
        .map_or_else(|| "undefined".to_owned(), |id| js_template(&id));

    recorded.lock().unwrap().push(json!({
        "method": method,
        "path": path,
        "contentType": headers.get("content-type"),
        "body": body,
    }));

    let answer = pick(replies, path.rsplit('/').next().unwrap(), &chat_id);

    if answer.get("drop").is_some() {
        return;
    }

    let mut stream = reader.into_inner();

    if answer.get("hold").is_some() {
        stream.set_read_timeout(Some(HOLD_LIMIT)).unwrap();
        let _ended = stream.read_to_end(&mut Vec::new());
        return;
    }

    if let Some(delay) = answer.get("delayMs").and_then(Value::as_u64) {
        std::thread::sleep(Duration::from_millis(delay));
    }

    let payload = text(&answer, "body").as_bytes().to_vec();
    let head = format!(
        "HTTP/1.1 {} X\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n",
        answer["status"],
        payload.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&payload).unwrap();
}

fn normalized(requests: Vec<Value>) -> Vec<Value> {
    let mut out = Vec::new();
    let mut run: Vec<Value> = Vec::new();

    for request in requests {
        if text(&request, "path").ends_with("/getChat") {
            run.push(request);
            continue;
        }

        run.sort_by(|left, right| text(left, "body").cmp(text(right, "body")));
        out.append(&mut run);
        out.push(request);
    }

    run.sort_by(|left, right| text(left, "body").cmp(text(right, "body")));
    out.append(&mut run);
    out
}

fn messages_of(value: &Value) -> &'static Messages {
    messages_for(Locale::parse(text(value, "locale")).unwrap())
}

fn optional<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().unwrap().get(key)
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn candidate_json(candidate: &Candidate) -> String {
    let mut map = Map::new();
    map.insert(
        "userId".to_owned(),
        Value::String(candidate.user_id.clone()),
    );

    if let Some(label) = &candidate.label {
        map.insert("label".to_owned(), label.clone());
    }

    if let Some(update_id) = &candidate.update_id {
        map.insert("updateId".to_owned(), update_id.clone());
    }

    stringify(&Value::Object(map))
}

#[test]
fn answers_every_pure_case_like_the_fixture() {
    let fixture = parse(FIXTURE);
    let pure = &fixture["pure"];

    for case in list(pure, "parseEnvToken") {
        assert_eq!(
            parse_env_token(text(case, "input")).map(Value::String),
            Some(case["output"].clone()).filter(|output| !output.is_null()),
            "parseEnvToken {case}"
        );
    }

    for case in list(pure, "isPaired") {
        assert_eq!(
            json!(is_paired(optional(case, "access"))),
            case["output"],
            "isPaired {case}"
        );
    }

    for case in list(pure, "buildAccess") {
        assert_eq!(
            format!(
                "{}\n",
                stringify_pretty(&build_access(
                    optional(case, "current"),
                    text(case, "userId")
                ))
            ),
            text(case, "output"),
            "buildAccess {case}"
        );
    }

    for case in list(pure, "pairingCode") {
        let bytes: Vec<u8> = case["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
            .collect();

        assert_eq!(
            pairing_code(&|count| Some(bytes[..count].to_vec())).unwrap(),
            text(case, "output"),
            "pairingCode {case}"
        );
    }

    for case in list(pure, "pairingLink") {
        assert_eq!(
            pairing_link(text(case, "username"), text(case, "code")),
            text(case, "output"),
            "pairingLink {case}"
        );
    }

    for case in list(pure, "findPairingCandidate") {
        let found = find_pairing_candidate(optional(case, "updates"), text(case, "code"));

        match optional(case, "error") {
            Some(error) => assert_eq!(found, Err(error.as_str().unwrap().to_owned()), "{case}"),
            None => assert_eq!(
                found.unwrap().map(|candidate| candidate_json(&candidate)),
                case["output"].as_str().map(str::to_owned),
                "findPairingCandidate {case}"
            ),
        }
    }

    for case in list(pure, "lastUpdateId") {
        let found = last_update_id(optional(case, "updates"));

        match optional(case, "error") {
            Some(error) => assert_eq!(found, Err(error.as_str().unwrap().to_owned()), "{case}"),
            None => assert_eq!(
                stringify(&number(found.unwrap())),
                text(case, "output"),
                "lastUpdateId {case}"
            ),
        }
    }

    for case in list(pure, "telegramApiRoot") {
        let root = optional(case, "root").map(|root| OsString::from(root.as_str().unwrap()));

        assert_eq!(
            api_root(&|name| (name == "BETTER_CC_TELEGRAM_API_ROOT")
                .then(|| root.clone())
                .flatten()),
            text(case, "output"),
            "telegramApiRoot {case}"
        );
    }
}

#[test]
fn answers_every_api_call_like_create_telegram_api() {
    let fixture = parse(FIXTURE);
    let token = text(&fixture, "token");

    for case in list(&fixture, "api") {
        let name = text(case, "name");
        let server = FakeTelegram::start(list(case, "replies"));
        let root = format!("{}{}", server.root, text(case, "root"));
        let outcome = match call(
            &post_json,
            &root,
            token,
            text(case, "method"),
            &case["params"],
            messages_of(case),
        ) {
            Ok(Some(result)) => json!({ "result": result }),
            Ok(None) => json!({}),
            Err(error) => json!({ "error": error }),
        };

        assert_eq!(outcome, case["outcome"], "{name}: outcome");
        assert_eq!(
            Value::Array(server.requests()),
            case["requests"],
            "{name}: requests"
        );
    }
}

fn input_lines(input: &str) -> VecDeque<String> {
    let mut lines: Vec<String> = input.split('\n').map(str::to_owned).collect();

    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }

    lines.into()
}

struct FakePrompts {
    out: Shared,
    err: Shared,
    lines: VecDeque<String>,
    messages: &'static Messages,
    colorize_out: bool,
    colorize_err: bool,
}

impl FakePrompts {
    fn ask(&mut self, prompt: &str) -> Result<String, Failure> {
        self.out
            .write_all(question(prompt, self.colorize_out).as_bytes())
            .unwrap();
        self.lines
            .pop_front()
            .ok_or_else(|| Failure::Failed(self.messages.cancelled.to_owned()))
    }
}

impl Prompts for FakePrompts {
    type Error = Failure;

    fn yes_no(&mut self, prompt: &str) -> Result<bool, Failure> {
        let answer = self.ask(&format!("{prompt} {} ", (self.messages.yes_no_hint)(true)))?;
        let answer = js_trim(&answer).to_lowercase();

        Ok(answer.is_empty() || answer.starts_with('s') || answer.starts_with('y'))
    }

    fn hidden(&mut self, prompt: &str) -> Result<String, Failure> {
        let answer = self.ask(prompt)?;
        self.out.write_all(b"\n").unwrap();

        Ok(js_trim(&answer).to_owned())
    }

    fn pairing_choice(&mut self, accounts: &str) -> Result<PairingChoice, Failure> {
        let title = (self.messages.pairing_choice_question)(accounts);
        let answers = "keep, replace";
        let hint = (self.messages.default_hint)("keep");

        loop {
            let typed = self.ask(&format!("{title} ({answers}) {hint}: "))?;
            let typed = js_trim(&typed).to_lowercase();

            match typed.as_str() {
                "" | "keep" | "n" | "no" | "não" | "nao" => return Ok(PairingChoice::Keep),
                "replace" | "s" | "y" | "sim" | "yes" => return Ok(PairingChoice::Replace),
                _ => {
                    let line = fail(
                        &(self.messages.invalid_answer)(&typed, answers),
                        self.colorize_err,
                    );
                    self.err.write_all(format!("{line}\n").as_bytes()).unwrap();
                }
            }
        }
    }
}

#[derive(Default)]
struct Recorder(Vec<Value>);

impl Tracks for Recorder {
    fn track_dir(&mut self, dir: &Path) {
        self.0
            .push(json!({"kind": "dir", "path": dir.to_string_lossy()}));
    }

    fn track_file(&mut self, file: &Path) -> std::io::Result<()> {
        self.0
            .push(json!({"kind": "file", "path": file.to_string_lossy()}));

        Ok(())
    }
}

struct Unreadable;

impl Tracks for Unreadable {
    fn track_dir(&mut self, _dir: &Path) {}

    fn track_file(&mut self, _file: &Path) -> std::io::Result<()> {
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    }
}

fn bot_json(bot: &SavedBot) -> Value {
    json!({
        "token": bot.token,
        "username": bot.username,
        "canJoinGroups": bot.can_join_groups,
    })
}

fn dispatch(
    flow: &Value,
    setup: &TelegramSetup<'_>,
    screen: &mut Screen<'_>,
    prompts: &mut FakePrompts,
    tracks: &mut Recorder,
) -> Result<Value, Failure> {
    let bot = SavedBot {
        token: text(&flow["bot"], "token").to_owned(),
        username: text(&flow["bot"], "username").to_owned(),
        can_join_groups: false,
        screen_refused: false,
    };

    match text(flow, "kind") {
        "token" => ensure_token(
            setup,
            flow["offerSaved"] == json!(true),
            screen,
            prompts,
            tracks,
        )
        .map(|bot| {
            if let Some(line) = groups_warning(&bot, setup.messages, screen.colorize_out) {
                screen
                    .out
                    .write_all(format!("{line}\n").as_bytes())
                    .unwrap();
            }

            bot_json(&bot)
        }),
        "savedBot" => load_saved_bot(setup, screen).map(|bot| bot_json(&bot)),
        "pairing" => ensure_pairing(setup, &bot, screen, prompts, tracks).map(|()| Value::Null),
        "accounts" => Ok(Value::String(paired_accounts(
            setup,
            list(flow, "userIds"),
            &bot.token,
        ))),
        other => panic!("unknown flow {other}"),
    }
}

struct Ran {
    status: u8,
    stdout: String,
    stderr: String,
    outcome: Value,
    requests: Vec<Value>,
    after: Tree,
}

fn run_flow(flow: &Value, fixture: &Value) -> Ran {
    let root = sandbox();
    materialize(root.path(), &flow["files"]);
    let server = FakeTelegram::start(list(flow, "replies"));
    let state_dir = root.path().join("state");
    let messages = messages_of(flow);
    let out = Shared::default();
    let err = Shared::default();
    let terminal = flow["terminal"].as_u64().map(|columns| Terminal {
        columns: Some(u16::try_from(columns).unwrap()),
    });
    let forced = flow["forceColor"] == json!(true);
    let colorize_out = forced || terminal.is_some();
    let step = flow["clockStep"].as_u64().unwrap();
    let start = fixture["now"].as_u64().unwrap();
    let ticks = AtomicU64::new(0);
    let now = || start + ticks.fetch_add(1, Ordering::SeqCst) * step;
    let bytes: Vec<u8> = flow["random"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
        .collect();
    let random = |count: usize| Some(bytes[..count].to_vec());
    let running = flow["running"] == json!(true);
    let is_running = |_: &Path| running.then(|| "1".to_owned());
    let interruption = Interruption::new();
    let fetch = |url: &str, body: &str| abortable_post_json(url, body, &interruption);

    if let Some(after) = flow["abortAfter"].as_u64() {
        let interruption = interruption.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(after));
            interruption.interrupt();
        });
    }

    let setup = TelegramSetup {
        state_dir: &state_dir,
        messages,
        fetch: &fetch,
        api_root: &server.root,
        now: &now,
        random: &random,
        is_running: &is_running,
    };
    let mut out_writer = out.clone();
    let mut err_writer = err.clone();
    let mut screen = Screen {
        out: &mut out_writer,
        err: &mut err_writer,
        terminal,
        colorize_out,
        colorize_err: forced,
        spin: &|_, _| None,
    };
    let mut prompts = FakePrompts {
        out: out.clone(),
        err: err.clone(),
        lines: input_lines(text(flow, "input")),
        messages,
        colorize_out,
        colorize_err: forced,
    };
    let mut tracks = Recorder::default();
    let result = dispatch(flow, &setup, &mut screen, &mut prompts, &mut tracks);
    let tracked = Value::Array(tracks.0);
    let (status, outcome) = match result {
        Ok(value) => (0, json!({ "value": value, "tracked": tracked })),
        Err(Failure::Screen) => panic!("the screen of a flow never fails"),
        Err(Failure::Failed(error)) => {
            err.clone()
                .write_all(format!("{}\n", fail(&error, forced)).as_bytes())
                .unwrap();
            (1, json!({ "error": error, "tracked": tracked }))
        }
    };

    Ran {
        status,
        stdout: placeholders(&out.text(), root.path()),
        stderr: placeholders(&err.text(), root.path()),
        outcome: parse(&placeholders(&stringify(&outcome), root.path())),
        requests: normalized(server.requests()),
        after: snapshot(root.path()),
    }
}

fn written_files(outcome: &Value) -> Value {
    Value::Array(
        list(outcome, "tracked")
            .iter()
            .filter(|entry| entry["kind"] == json!("file"))
            .map(|entry| json!(text(entry, "path").trim_start_matches("{root}/")))
            .collect(),
    )
}

#[test]
fn runs_every_flow_like_the_fixture() {
    let fixture = parse(FIXTURE);
    let default_mode = default_file_mode();

    for flow in list(&fixture, "flows") {
        let name = text(flow, "name");
        let ran = run_flow(flow, &fixture);

        assert_eq!(json!(ran.status), flow["status"], "{name}: status");
        assert_eq!(ran.stdout, text(flow, "stdout"), "{name}: stdout");
        assert_eq!(ran.stderr, text(flow, "stderr"), "{name}: stderr");
        assert_eq!(ran.outcome, flow["outcome"], "{name}: outcome");
        assert_eq!(
            Value::Array(ran.requests),
            flow["requests"],
            "{name}: requests"
        );
        assert_eq!(
            ran.after,
            expected_tree(
                &flow["after"],
                Some(&written_files(&flow["outcome"])),
                &default_mode
            ),
            "{name}: files"
        );
    }
}

fn quiet_setup<'a>(
    state_dir: &'a Path,
    fetch: &'a dyn Fn(&str, &str) -> Option<Vec<u8>>,
    root: &'a str,
) -> TelegramSetup<'a> {
    TelegramSetup {
        state_dir,
        messages: messages_for(Locale::EnUs),
        fetch,
        api_root: root,
        now: &|| 0,
        random: &random_bytes,
        is_running: &|_| None,
    }
}

fn quiet_screen<'a>(out: &'a mut Vec<u8>, err: &'a mut Vec<u8>) -> Screen<'a> {
    Screen {
        out,
        err,
        terminal: None,
        colorize_out: false,
        colorize_err: false,
        spin: &|_, _| None,
    }
}

struct Typed(&'static str);

impl Prompts for Typed {
    type Error = Failure;

    fn yes_no(&mut self, _prompt: &str) -> Result<bool, Failure> {
        Ok(true)
    }

    fn hidden(&mut self, _prompt: &str) -> Result<String, Failure> {
        Ok(self.0.to_owned())
    }

    fn pairing_choice(&mut self, _accounts: &str) -> Result<PairingChoice, Failure> {
        Ok(PairingChoice::Replace)
    }
}

struct Keeping;

impl Prompts for Keeping {
    type Error = Failure;

    fn yes_no(&mut self, _prompt: &str) -> Result<bool, Failure> {
        Ok(true)
    }

    fn hidden(&mut self, _prompt: &str) -> Result<String, Failure> {
        Ok(String::new())
    }

    fn pairing_choice(&mut self, _accounts: &str) -> Result<PairingChoice, Failure> {
        Ok(PairingChoice::Keep)
    }
}

fn not_saved(file: &Path) -> Failure {
    Failure::Failed(format!("Could not save {}.", file.display()))
}

struct Refusing {
    writes: usize,
    refused_from: usize,
}

impl Refusing {
    fn from_write(refused_from: usize) -> Self {
        Self {
            writes: 0,
            refused_from,
        }
    }
}

impl Write for Refusing {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.writes += 1;

        if self.writes >= self.refused_from {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }

        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn refusing_screen<'a>(
    out: &'a mut Refusing,
    err: &'a mut Vec<u8>,
    terminal: Option<Terminal>,
) -> Screen<'a> {
    Screen {
        out,
        err,
        terminal,
        colorize_out: false,
        colorize_err: false,
        spin: &|_, _| None,
    }
}

fn silent_prompts() -> FakePrompts {
    FakePrompts {
        out: Shared::default(),
        err: Shared::default(),
        lines: VecDeque::new(),
        messages: messages_for(Locale::EnUs),
        colorize_out: false,
        colorize_err: false,
    }
}

fn greeting_replies() -> [Value; 2] {
    [
        json!({
            "method": "getUpdates",
            "status": 200,
            "body": "{\"ok\":true,\"result\":[]}",
        }),
        json!({
            "method": "sendMessage",
            "status": 200,
            "body": "{\"ok\":true,\"result\":{}}",
        }),
    ]
}

#[test]
fn calls_no_telegram_when_the_first_spinner_line_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join(".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n").unwrap();
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(1), Vec::new());

    let loaded = load_saved_bot(
        &setup,
        &mut refusing_screen(&mut out, &mut err, Some(Terminal { columns: None })),
    );

    assert_eq!(loaded, Err(Failure::Screen));
    assert_eq!(server.requests(), Vec::<Value>::new());
}

#[test]
fn saves_the_account_without_greeting_when_the_greeting_spinner_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let mut replies = pairing_replies();
    replies.extend(greeting_replies());
    let server = FakeTelegram::start(&replies);
    let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
    let zeros = |count: usize| Some(vec![0; count]);
    setup.random = &zeros;
    let (mut out, mut err) = (Refusing::from_write(6), Vec::new());

    let paired = ensure_pairing(
        &setup,
        &fake_bot(),
        &mut refusing_screen(&mut out, &mut err, Some(Terminal { columns: None })),
        &mut Typed(""),
        &mut Recorder::default(),
    );

    assert_eq!(paired, Err(Failure::Screen));
    assert!(state_dir.join("access.json").exists());
    assert_eq!(server.requests().len(), 3);
}

fn get_me_replies() -> [Value; 1] {
    [json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":true,\"result\":{\"username\":\"e2e_bot\"}}",
    })]
}

fn fake_bot() -> SavedBot {
    SavedBot {
        token: "123:FAKE".to_owned(),
        username: "e2e_bot".to_owned(),
        can_join_groups: false,
        screen_refused: false,
    }
}

#[test]
fn keeps_the_token_and_marks_the_refusal_when_the_saved_line_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(1), Vec::new());

    let saved = ensure_token(
        &setup,
        false,
        &mut refusing_screen(&mut out, &mut err, None),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    )
    .unwrap();

    assert!(saved.screen_refused);
    assert_eq!(
        fs::read_to_string(state_dir.join(".env")).unwrap(),
        "TELEGRAM_BOT_TOKEN=123:FAKE\n"
    );
}

#[test]
fn marks_no_refusal_when_the_screen_shows_everything() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let server = FakeTelegram::start(&[get_me_replies(), get_me_replies()].concat());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Vec::new(), Vec::new());

    let saved = ensure_token(
        &setup,
        false,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    )
    .unwrap();
    let loaded = load_saved_bot(&setup, &mut quiet_screen(&mut out, &mut err)).unwrap();

    assert!(!saved.screen_refused);
    assert!(!loaded.screen_refused);
}

#[test]
fn saves_the_token_when_the_end_of_its_check_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(2), Vec::new());

    let saved = ensure_token(
        &setup,
        false,
        &mut refusing_screen(&mut out, &mut err, Some(Terminal { columns: None })),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    )
    .unwrap();

    assert!(saved.screen_refused);
    assert_eq!(
        fs::read_to_string(state_dir.join(".env")).unwrap(),
        "TELEGRAM_BOT_TOKEN=123:FAKE\n"
    );
}

#[test]
fn stops_before_asking_about_the_saved_bot_or_a_token_on_a_refused_screen() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join(".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n").unwrap();
    let server = FakeTelegram::start(&[
        get_me_replies()[0].clone(),
        json!({"method": "getMe", "status": 200, "body": "{\"ok\":false}"}),
    ]);
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let mut err = Vec::new();
    let terminal = Some(Terminal { columns: None });

    for _answer in 0..2 {
        assert_eq!(
            ensure_token(
                &setup,
                true,
                &mut refusing_screen(&mut Refusing::from_write(2), &mut err, terminal),
                &mut silent_prompts(),
                &mut Recorder::default(),
            ),
            Err(Failure::Screen)
        );
    }
}

#[test]
fn stops_the_pairing_before_telegram_when_the_saved_bot_line_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join(".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n").unwrap();
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let mut err = Vec::new();

    let bot = load_saved_bot(
        &setup,
        &mut refusing_screen(
            &mut Refusing::from_write(2),
            &mut err,
            Some(Terminal { columns: None }),
        ),
    )
    .unwrap();

    assert!(bot.screen_refused);

    let paired = ensure_pairing(
        &setup,
        &bot,
        &mut quiet_screen(&mut Vec::new(), &mut err),
        &mut silent_prompts(),
        &mut Recorder::default(),
    );

    assert_eq!(paired, Err(Failure::Screen));
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn stops_before_asking_to_keep_or_confirm_the_account_on_a_refused_screen() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let server = FakeTelegram::start(&pairing_replies());
    let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
    let zeros = |count: usize| Some(vec![0; count]);
    setup.random = &zeros;
    let mut err = Vec::new();
    let terminal = Some(Terminal { columns: None });

    assert_eq!(
        ensure_pairing(
            &setup,
            &fake_bot(),
            &mut refusing_screen(&mut Refusing::from_write(5), &mut err, terminal),
            &mut silent_prompts(),
            &mut Recorder::default(),
        ),
        Err(Failure::Screen)
    );
    assert_eq!(server.requests().len(), 3);
    assert!(!state_dir.join("access.json").exists());

    fs::write(state_dir.join("access.json"), "{\"allowFrom\":[\"42\"]}").unwrap();

    assert_eq!(
        ensure_pairing(
            &setup,
            &fake_bot(),
            &mut refusing_screen(&mut Refusing::from_write(2), &mut err, terminal),
            &mut silent_prompts(),
            &mut Recorder::default(),
        ),
        Err(Failure::Screen)
    );
}

#[test]
fn fails_in_the_chosen_language_without_waiting_when_random_bytes_fail() {
    for (locale, expected) in [
        (Locale::EnUs, "Could not generate the pairing code."),
        (Locale::PtBr, "Não consegui gerar o código de pareamento."),
    ] {
        let root = sandbox();
        let state_dir = root.path().join("state");
        fs::create_dir_all(&state_dir).unwrap();
        let server = FakeTelegram::start(&pairing_replies());
        let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
        setup.random = &|_| None;
        setup.messages = messages_for(locale);
        let (mut out, mut err) = (Vec::new(), Vec::new());

        let paired = ensure_pairing(
            &setup,
            &fake_bot(),
            &mut quiet_screen(&mut out, &mut err),
            &mut silent_prompts(),
            &mut Recorder::default(),
        );

        assert_eq!(paired, Err(Failure::Failed(expected.to_owned())));
        assert_eq!(out, Vec::<u8>::new());
        assert_eq!(server.requests().len(), 2);
    }
}

#[test]
fn stops_before_saving_the_token_when_the_spinner_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(1), Vec::new());

    let saved = ensure_token(
        &setup,
        false,
        &mut refusing_screen(&mut out, &mut err, Some(Terminal { columns: None })),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    );

    assert_eq!(saved, Err(Failure::Screen));
    assert!(!state_dir.join(".env").exists());
}

#[test]
fn stops_before_offering_the_saved_bot_when_its_spinner_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join(".env"), "TELEGRAM_BOT_TOKEN=123:FAKE\n").unwrap();
    let server = FakeTelegram::start(&[get_me_replies(), get_me_replies()].concat());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(1), Vec::new());
    let terminal = Some(Terminal { columns: None });

    assert_eq!(
        ensure_token(
            &setup,
            true,
            &mut refusing_screen(&mut out, &mut err, terminal),
            &mut silent_prompts(),
            &mut Recorder::default(),
        ),
        Err(Failure::Screen)
    );
    assert_eq!(
        load_saved_bot(
            &setup,
            &mut refusing_screen(&mut Refusing::from_write(1), &mut err, terminal),
        ),
        Err(Failure::Screen)
    );
}

#[test]
fn keeps_the_failure_when_the_spinner_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    let server = FakeTelegram::start(&[json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":false,\"description\":\"Not Found\"}",
    })]);
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(2), Vec::new());
    let saved = ensure_token(
        &setup,
        false,
        &mut refusing_screen(&mut out, &mut err, Some(Terminal { columns: None })),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    );

    assert!(matches!(saved, Err(Failure::Failed(_))));
}

#[test]
fn waits_for_no_message_when_the_code_line_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let server = FakeTelegram::start(&pairing_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(1), Vec::new());

    let paired = ensure_pairing(
        &setup,
        &fake_bot(),
        &mut refusing_screen(&mut out, &mut err, None),
        &mut Typed(""),
        &mut Recorder::default(),
    );

    assert_eq!(paired, Err(Failure::Screen));
    assert_eq!(server.requests().len(), 2);
    assert!(!state_dir.join("access.json").exists());
}

#[test]
fn stops_with_the_account_saved_and_greeted_when_the_paired_line_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    let mut replies = pairing_replies();
    replies.extend(greeting_replies());
    let server = FakeTelegram::start(&replies);
    let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
    let zeros = |count: usize| Some(vec![0; count]);
    setup.random = &zeros;
    let (mut out, mut err) = (Refusing::from_write(2), Vec::new());

    let paired = ensure_pairing(
        &setup,
        &fake_bot(),
        &mut refusing_screen(&mut out, &mut err, None),
        &mut Typed(""),
        &mut Recorder::default(),
    );

    assert_eq!(paired, Err(Failure::Screen));
    assert_eq!(server.requests().len(), 5);
    assert!(state_dir.join("access.json").exists());
}

#[test]
fn stops_when_the_kept_account_line_is_refused() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join("access.json"), "{\"allowFrom\":[\"42\"]}").unwrap();
    let server = FakeTelegram::start(&[]);
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Refusing::from_write(1), Vec::new());

    assert_eq!(
        ensure_pairing(
            &setup,
            &fake_bot(),
            &mut refusing_screen(&mut out, &mut err, None),
            &mut Keeping,
            &mut Recorder::default(),
        ),
        Err(Failure::Screen)
    );
    assert_eq!(
        ensure_pairing(
            &setup,
            &fake_bot(),
            &mut refusing_screen(
                &mut Refusing::from_write(1),
                &mut err,
                Some(Terminal { columns: None }),
            ),
            &mut silent_prompts(),
            &mut Recorder::default(),
        ),
        Err(Failure::Screen)
    );
}

#[test]
fn builds_a_failure_from_its_message() {
    assert_eq!(
        Failure::from("x".to_owned()),
        Failure::Failed("x".to_owned())
    );
}

#[test]
fn names_the_file_and_saves_nothing_when_the_token_cannot_be_saved() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::write(&state_dir, "a file where the folder goes").unwrap();
    let server = FakeTelegram::start(&[json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":true,\"result\":{\"username\":\"e2e_bot\"}}",
    })]);
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut tracks = Recorder::default();

    let saved = ensure_token(
        &setup,
        false,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed("123:FAKE"),
        &mut tracks,
    );

    assert_eq!(saved, Err(not_saved(&state_dir.join(".env"))));
    assert_eq!(out, Vec::<u8>::new());
    assert_eq!(
        fs::read_to_string(&state_dir).unwrap(),
        "a file where the folder goes"
    );
}

#[test]
fn reports_a_token_file_that_cannot_be_written() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(state_dir.join(".env")).unwrap();
    let server = FakeTelegram::start(&[json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":true,\"result\":{\"username\":\"e2e_bot\"}}",
    })]);
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut tracks = Recorder::default();

    let saved = ensure_token(
        &setup,
        false,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed("123:FAKE"),
        &mut tracks,
    );

    assert_eq!(saved, Err(not_saved(&state_dir.join(".env"))));
    assert_eq!(tracks.0.len(), 2);
}

#[test]
fn keeps_the_token_file_the_journal_cannot_read() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join(".env"), "OLD=1\n").unwrap();
    let server = FakeTelegram::start(&[json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":true,\"result\":{\"username\":\"e2e_bot\"}}",
    })]);
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Vec::new(), Vec::new());

    let saved = ensure_token(
        &setup,
        false,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed("123:FAKE"),
        &mut Unreadable,
    );

    assert_eq!(saved, Err(not_saved(&state_dir.join(".env"))));
    assert_eq!(
        fs::read_to_string(state_dir.join(".env")).unwrap(),
        "OLD=1\n"
    );
}

#[test]
fn saves_the_token_in_the_target_of_its_link() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    let target = root.path().join("real.env");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(&target, "OLD=1\n").unwrap();
    std::os::unix::fs::symlink(&target, state_dir.join(".env")).unwrap();
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Vec::new(), Vec::new());

    ensure_token(
        &setup,
        false,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    )
    .unwrap();

    let link = fs::symlink_metadata(state_dir.join(".env")).unwrap();

    assert!(link.file_type().is_symlink());
    assert_eq!(fs::read_link(state_dir.join(".env")).unwrap(), target);
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "TELEGRAM_BOT_TOKEN=123:FAKE\n"
    );
    assert_eq!(
        String::from_utf8(out).unwrap(),
        format!(
            "✔ Token of bot @e2e_bot saved in {}.\n",
            state_dir.join(".env").display()
        )
    );
}

#[test]
fn creates_the_target_of_a_dangling_token_link() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    std::os::unix::fs::symlink("../real.env", state_dir.join(".env")).unwrap();
    let server = FakeTelegram::start(&get_me_replies());
    let setup = quiet_setup(&state_dir, &post_json, &server.root);
    let (mut out, mut err) = (Vec::new(), Vec::new());

    ensure_token(
        &setup,
        false,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed("123:FAKE"),
        &mut Recorder::default(),
    )
    .unwrap();

    let link = fs::symlink_metadata(state_dir.join(".env")).unwrap();

    assert!(link.file_type().is_symlink());
    assert_eq!(
        fs::read_to_string(root.path().join("real.env")).unwrap(),
        "TELEGRAM_BOT_TOKEN=123:FAKE\n"
    );
}

#[test]
fn saves_the_access_in_the_target_of_its_link() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    let target = root.path().join("real-access.json");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(&target, "{\"extra\":1}").unwrap();
    std::os::unix::fs::symlink(&target, state_dir.join("access.json")).unwrap();
    let mut replies = pairing_replies();
    replies.extend(greeting_replies());
    let server = FakeTelegram::start(&replies);
    let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
    let zeros = |count: usize| Some(vec![0; count]);
    setup.random = &zeros;
    let (mut out, mut err) = (Vec::new(), Vec::new());

    ensure_pairing(
        &setup,
        &fake_bot(),
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed(""),
        &mut Recorder::default(),
    )
    .unwrap();

    let link = fs::symlink_metadata(state_dir.join("access.json")).unwrap();
    let saved: Value = parse(&fs::read_to_string(&target).unwrap());

    assert!(link.file_type().is_symlink());
    assert_eq!(saved["extra"], json!(1));
    assert_eq!(saved["allowFrom"], json!(["42"]));
}

fn pairing_replies() -> Vec<Value> {
    let ok = |method: &str, result: Value| {
        json!({
            "method": method,
            "status": 200,
            "body": stringify(&json!({"ok": true, "result": result})),
        })
    };

    vec![
        ok("getWebhookInfo", json!({"url": ""})),
        ok("getUpdates", json!([])),
        ok(
            "getUpdates",
            json!([{"update_id": 3, "message": {"chat": {"type": "private"}, "from": {"id": 42}, "text": "00000000"}}]),
        ),
    ]
}

#[test]
fn reports_an_access_file_that_cannot_be_written_and_greets_nobody() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(state_dir.join("access.json")).unwrap();
    let server = FakeTelegram::start(&pairing_replies());
    let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
    let zeros = |count: usize| Some(vec![0; count]);
    setup.random = &zeros;
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let bot = SavedBot {
        token: "123:FAKE".to_owned(),
        username: "e2e_bot".to_owned(),
        can_join_groups: false,
        screen_refused: false,
    };

    let paired = ensure_pairing(
        &setup,
        &bot,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed(""),
        &mut Recorder::default(),
    );

    assert_eq!(paired, Err(not_saved(&state_dir.join("access.json"))));
    assert_eq!(server.requests().len(), 3);
}

#[test]
fn keeps_the_access_file_the_journal_cannot_read_and_greets_nobody() {
    let root = sandbox();
    let state_dir = root.path().join("state");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(state_dir.join("access.json"), "{oops").unwrap();
    let server = FakeTelegram::start(&pairing_replies());
    let mut setup = quiet_setup(&state_dir, &post_json, &server.root);
    let zeros = |count: usize| Some(vec![0; count]);
    setup.random = &zeros;
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let bot = SavedBot {
        token: "123:FAKE".to_owned(),
        username: "e2e_bot".to_owned(),
        can_join_groups: false,
        screen_refused: false,
    };

    let paired = ensure_pairing(
        &setup,
        &bot,
        &mut quiet_screen(&mut out, &mut err),
        &mut Typed(""),
        &mut Unreadable,
    );

    assert_eq!(paired, Err(not_saved(&state_dir.join("access.json"))));
    assert_eq!(
        fs::read_to_string(state_dir.join("access.json")).unwrap(),
        "{oops"
    );
    assert_eq!(server.requests().len(), 3);
}

#[test]
fn never_reaches_telegram_on_an_interrupted_call() {
    let server = FakeTelegram::start(&[]);
    let interruption = Interruption::new();
    interruption.interrupt();

    let answer = abortable_post_json(&format!("{}/botX/getMe", server.root), "{}", &interruption);
    std::thread::sleep(Duration::from_millis(300));

    assert_eq!(answer, None);
    assert_eq!(server.requests(), Vec::<Value>::new());
}

#[test]
fn stops_waiting_on_an_interruption_for_a_call_that_never_answers() {
    let server = FakeTelegram::start(&[json!({"method": "getUpdates", "hold": true})]);
    let interruption = Interruption::new();
    let interrupting = interruption.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        interrupting.interrupt();
    });
    let started = std::time::Instant::now();

    let answer = abortable_post_json(
        &format!("{}/botX/getUpdates", server.root),
        "{}",
        &interruption,
    );

    assert_eq!(answer, None);
    assert!(started.elapsed() < HOLD_LIMIT / 2);
}

#[test]
fn answers_an_uninterrupted_call_like_the_plain_one() {
    let server = FakeTelegram::start(&[json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":true}",
    })]);

    let answer = abortable_post_json(
        &format!("{}/botX/getMe", server.root),
        "{}",
        &Interruption::new(),
    );

    assert_eq!(answer, Some(b"{\"ok\":true}".to_vec()));
}

#[test]
fn waits_for_a_slow_answer_while_nothing_interrupts() {
    let server = FakeTelegram::start(&[json!({
        "method": "getMe",
        "status": 200,
        "body": "{\"ok\":true}",
        "delayMs": 200,
    })]);

    let answer = abortable_post_json(
        &format!("{}/botX/getMe", server.root),
        "{}",
        &Interruption::new(),
    );

    assert_eq!(answer, Some(b"{\"ok\":true}".to_vec()));
}

#[test]
fn generates_random_codes_of_eight_hex_digits_that_change() {
    let first = pairing_code(&random_bytes).unwrap();
    let second = pairing_code(&random_bytes).unwrap();

    assert_eq!(first.len(), 8);
    assert!(
        first
            .chars()
            .all(|digit| digit.is_ascii_hexdigit() && !digit.is_ascii_uppercase())
    );
    assert_ne!(first, second);
    assert_eq!(random_bytes(0), Some(Vec::new()));
    assert_eq!(random_bytes(13).unwrap().len(), 13);
    assert_ne!(random_bytes(16), random_bytes(16));
    assert_eq!(pairing_code(&|_| None), None);
}

#[test]
fn warns_only_for_a_bot_that_can_join_groups() {
    let bot = SavedBot {
        token: String::new(),
        username: "b".to_owned(),
        can_join_groups: false,
        screen_refused: false,
    };
    let joins = SavedBot {
        can_join_groups: true,
        ..bot.clone()
    };
    let messages = messages_for(Locale::EnUs);

    assert_eq!(groups_warning(&bot, messages, false), None);
    assert_eq!(
        groups_warning(&joins, messages, true),
        Some(format!(
            "\u{1b}[33m⚠ {}\u{1b}[39m",
            (messages.groups_warning)("b")
        ))
    );
}
