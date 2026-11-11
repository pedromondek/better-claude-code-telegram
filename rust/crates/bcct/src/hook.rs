use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Number, Value, json};

use crate::config::{DELAY_ENV, delay_ms, read_config};
use crate::files::{create_private_dir, read_json, write_private};
use crate::hook_failures;
use crate::js::{
    is_js_whitespace, join_path, js_number, js_string, js_trim, js_truthy, normalize_path,
    parse_json, stringify,
};
use crate::paths::Paths;

pub const ANSWER_POLL: Duration = Duration::from_millis(1000);

const TELEGRAM_FLAG: &str = "BETTER_CC_TELEGRAM";
const TRANSCRIPT_TAIL_BYTES: usize = 4_194_304;
const LAST_PROMPT_FILE: &str = "last-prompt";
const DEFAULT_SESSION: &str = "session";
const JSON_SUFFIX: &str = ".json";
const SKIPPED_SUFFIXES: [&str; 2] = [".telegram.json", ".answer.json"];
const LABEL_SESSION_UNITS: usize = 4;
const DEFAULT_FOLDER_LABEL: &str = "claude";
const LOWEST_REAL_PID: f64 = 1.0;
const NOT_TYPED_PROMPT_PREFIXES: [&str; 3] = [
    "Another Claude session sent a message:",
    "[Cross-session ",
    "<channel source=\"plugin:telegram",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Abort {
    Input,
    Io { kind: io::ErrorKind, path: PathBuf },
}

impl Abort {
    fn at(path: &Path) -> impl FnOnce(io::Error) -> Self + '_ {
        move |error| Self::Io {
            kind: error.kind(),
            path: path.to_path_buf(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mode {
    Permission,
    Prompt,
    Post,
    Stop,
}

impl Mode {
    pub const ALL: [Self; 4] = [Self::Permission, Self::Prompt, Self::Post, Self::Stop];

    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "permission" => Some(Self::Permission),
            "prompt" => Some(Self::Prompt),
            "post" => Some(Self::Post),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }

    #[must_use]
    pub fn event_name(self) -> &'static str {
        match self {
            Self::Permission => "PermissionRequest",
            Self::Prompt => "UserPromptSubmit",
            Self::Post => "PostToolUse",
            Self::Stop => "Stop",
        }
    }

    #[must_use]
    pub fn from_event_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.event_name() == name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    pub app_dir: PathBuf,
    pub state_dir: PathBuf,
    pub telegram_instance: bool,
    pub delay_env: Option<String>,
}

impl Context {
    #[must_use]
    pub fn resolve(var: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> Self {
        let paths = Paths::resolve(var, home);

        Self {
            app_dir: normalize_path(&paths.app_dir),
            state_dir: normalize_path(&paths.telegram_state_dir),
            telegram_instance: var(TELEGRAM_FLAG).is_some_and(|flag| flag == "1"),
            delay_env: var(DELAY_ENV).map(|raw| raw.to_string_lossy().into_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub id: String,
    pub record: Value,
}

fn entry_type(value: &Value) -> Option<&str> {
    value.get("type").and_then(Value::as_str)
}

fn safe_file_name(raw: &str) -> String {
    raw.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character.to_string()
            } else {
                "_".repeat(character.len_utf16())
            }
        })
        .collect()
}

fn first_units(text: &str, units: usize) -> String {
    let mut used = 0;

    text.chars()
        .take_while(|character| {
            used += character.len_utf16();
            used <= units
        })
        .collect()
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
}

pub(crate) fn millis(now: u64) -> f64 {
    Number::from(now).as_f64().unwrap_or_default()
}

fn number(value: f64) -> Value {
    Number::from_f64(value).map_or(Value::Null, Value::Number)
}

#[must_use]
pub fn is_active(ctx: &Context, is_alive: &dyn Fn(f64) -> bool) -> bool {
    ctx.telegram_instance || bot_alive(ctx, is_alive)
}

fn bot_alive(ctx: &Context, is_alive: &dyn Fn(f64) -> bool) -> bool {
    let Ok(bytes) = fs::read(join_path(&ctx.state_dir, "bot.pid")) else {
        return false;
    };
    let pid = js_number(&String::from_utf8_lossy(&bytes));

    pid.fract() == 0.0 && pid > LOWEST_REAL_PID && is_alive(pid)
}

#[must_use]
pub fn process_alive(pid: f64) -> bool {
    #[cfg(unix)]
    {
        pid.to_string()
            .parse::<u32>()
            .ok()
            .and_then(|raw| i32::try_from(raw).ok())
            .and_then(rustix::process::Pid::from_raw)
            .is_some_and(|target| rustix::process::test_kill_process(target).is_ok())
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn read_transcript(input: &Value) -> String {
    let Some(Value::String(path)) = input.get("transcript_path") else {
        return String::new();
    };
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(TRANSCRIPT_TAIL_BYTES);

    String::from_utf8_lossy(bytes.get(start..).unwrap_or_default()).into_owned()
}

fn parse_entries(text: &str) -> Vec<Value> {
    text.split('\n')
        .filter(|line| !js_trim(line).is_empty())
        .map(|line| parse_json(line).unwrap_or(Value::Null))
        .collect()
}

fn block_text(block: &Value) -> Result<Option<String>, Abort> {
    if block.is_null() {
        return Err(Abort::Input);
    }

    if entry_type(block) != Some("text") {
        return Ok(None);
    }

    match block.get("text") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let trimmed = js_trim(text);
            Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
        }
        Some(_) => Err(Abort::Input),
    }
}

fn context_from(entries: &[Value]) -> Result<Option<String>, Abort> {
    let mut texts: Vec<String> = Vec::new();

    for entry in entries.iter().rev() {
        if entry_type(entry) == Some("user") {
            break;
        }

        let content = if entry_type(entry) == Some("assistant") {
            entry
                .get("message")
                .and_then(|message| message.get("content"))
        } else {
            None
        };
        let Some(Value::Array(blocks)) = content else {
            continue;
        };
        let found = blocks
            .iter()
            .map(block_text)
            .collect::<Result<Vec<_>, _>>()?;

        texts.splice(0..0, found.into_iter().flatten());
    }

    Ok((!texts.is_empty()).then(|| texts.join("\n\n")))
}

fn latest(entries: &[Value], kind: &str, field: &str) -> Option<Value> {
    entries.iter().rev().find_map(|entry| {
        if entry_type(entry) == Some(kind) {
            entry.get(field).filter(|value| js_truthy(value)).cloned()
        } else {
            None
        }
    })
}

fn session_name(entries: &[Value]) -> Option<Value> {
    [
        ("agent-name", "agentName"),
        ("custom-title", "customTitle"),
        ("ai-title", "aiTitle"),
    ]
    .into_iter()
    .find_map(|(kind, field)| latest(entries, kind, field))
}

fn instance_from(
    input: &Value,
    telegram_instance: bool,
    entries: &[Value],
) -> Result<Option<Value>, Abort> {
    if telegram_instance {
        return Ok(None);
    }

    if let Some(name) = session_name(entries) {
        return Ok(Some(name));
    }

    let folder = match input.get("cwd") {
        Some(cwd) if js_truthy(cwd) => basename(cwd.as_str().ok_or(Abort::Input)?),
        _ => DEFAULT_FOLDER_LABEL,
    };
    let session = input.get("session_id").map(js_string).unwrap_or_default();

    Ok(Some(Value::String(format!(
        "{folder}#{}",
        first_units(&session, LABEL_SESSION_UNITS)
    ))))
}

pub fn context_before_tool(text: &str) -> Result<Option<String>, Abort> {
    context_from(&parse_entries(text))
}

#[must_use]
pub fn session_name_from_transcript(text: &str) -> Option<Value> {
    session_name(&parse_entries(text))
}

pub fn instance_label(
    input: &Value,
    telegram_instance: bool,
    text: &str,
) -> Result<Option<Value>, Abort> {
    instance_from(input, telegram_instance, &parse_entries(text))
}

fn option_value(option: &Value) -> Result<Value, Abort> {
    if option.is_null() {
        return Err(Abort::Input);
    }

    let mut out = Map::new();
    out.insert(
        "label".to_owned(),
        Value::String(option.get("label").map(js_string).unwrap_or_default()),
    );
    copy_present(option, "description", &mut out);
    copy_present(option, "preview", &mut out);

    Ok(Value::Object(out))
}

fn copy_present(source: &Value, key: &str, target: &mut Map<String, Value>) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_owned(), value.clone());
    }
}

fn question_value(question: &Value) -> Result<Value, Abort> {
    if question.is_null() {
        return Err(Abort::Input);
    }

    let options = match question.get("options") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(option_value)
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(Abort::Input),
    };
    let mut out = Map::new();
    out.insert(
        "question".to_owned(),
        Value::String(question.get("question").map(js_string).unwrap_or_default()),
    );
    copy_present(question, "header", &mut out);
    out.insert(
        "multiSelect".to_owned(),
        Value::Bool(question.get("multiSelect").is_some_and(js_truthy)),
    );
    out.insert("options".to_owned(), Value::Array(options));

    Ok(Value::Object(out))
}

fn build_ask(
    input: &Value,
    ctx: &Context,
    now: u64,
    session: Option<&str>,
    context: Option<String>,
    instance: Option<Value>,
) -> Result<Option<Ask>, Abort> {
    let questions = match input
        .get("tool_input")
        .and_then(|tool_input| tool_input.get("questions"))
    {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return Ok(None),
    };
    let id = safe_file_name(&format!("{}-{now}", session.unwrap_or(DEFAULT_SESSION)));
    let questions = questions
        .iter()
        .map(question_value)
        .collect::<Result<Vec<_>, _>>()?;
    let created = millis(now);
    let mut record = Map::new();
    record.insert("id".to_owned(), Value::String(id.clone()));
    record.insert(
        "sessionId".to_owned(),
        session.map_or(Value::Null, |name| Value::String(name.to_owned())),
    );
    record.insert("createdAt".to_owned(), number(created));
    record.insert("dueAt".to_owned(), number(created + due_delay(ctx)));
    record.insert("instance".to_owned(), instance.unwrap_or(Value::Null));
    record.insert(
        "context".to_owned(),
        context.map_or(Value::Null, Value::String),
    );
    record.insert("questions".to_owned(), Value::Array(questions));

    Ok(Some(Ask {
        id,
        record: Value::Object(record),
    }))
}

fn due_delay(ctx: &Context) -> f64 {
    delay_ms(&read_config(&ctx.app_dir), ctx.delay_env.as_deref())
}

fn permission(
    input: &Value,
    ctx: &Context,
    now: u64,
    session: Option<&str>,
) -> Result<Option<Ask>, Abort> {
    let entries = parse_entries(&read_transcript(input));
    let context = context_from(&entries)?;
    let instance = instance_from(input, ctx.telegram_instance, &entries)?;
    let Some(ask) = build_ask(input, ctx, now, session, context, instance)? else {
        return Ok(None);
    };
    let asks_dir = ctx.app_dir.join("asks");
    let record_file = join_path(&asks_dir, &format!("{}.json", ask.id));

    create_private_dir(&asks_dir).map_err(Abort::at(&asks_dir))?;
    write_private(&record_file, stringify(&ask.record).as_bytes())
        .map_err(Abort::at(&record_file))?;

    Ok(Some(ask))
}

fn stop(
    input: &Value,
    ctx: &Context,
    now: u64,
    session: Option<&str>,
    ping_file: &Path,
) -> Result<(), Abort> {
    let entries = parse_entries(&read_transcript(input));
    let instance = instance_from(input, ctx.telegram_instance, &entries)?;
    let Some(Value::String(message)) = input.get("last_assistant_message") else {
        return Ok(());
    };
    let text = js_trim(message);

    if text.is_empty() {
        return Ok(());
    }

    let created = millis(now);
    let mut ping = Map::new();
    ping.insert(
        "sessionId".to_owned(),
        Value::String(session.unwrap_or(DEFAULT_SESSION).to_owned()),
    );
    ping.insert("createdAt".to_owned(), number(created));
    ping.insert("dueAt".to_owned(), number(created + due_delay(ctx)));
    ping.insert("text".to_owned(), Value::String(text.to_owned()));
    ping.insert("instance".to_owned(), instance.unwrap_or(Value::Null));

    let pings_dir = ctx.app_dir.join("pings");

    create_private_dir(&pings_dir).map_err(Abort::at(&pings_dir))?;
    write_private(ping_file, stringify(&Value::Object(ping)).as_bytes())
        .map_err(Abort::at(ping_file))?;

    Ok(())
}

fn prompt(ctx: &Context, now: u64, ping_file: &Path) -> Result<(), Abort> {
    let pings_dir = ctx.app_dir.join("pings");
    let last_prompt_file = pings_dir.join(LAST_PROMPT_FILE);

    create_private_dir(&pings_dir).map_err(Abort::at(&pings_dir))?;

    match fs::remove_file(ping_file) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(Abort::at(ping_file)(error));
        }
        _ => {}
    }

    if ctx.telegram_instance {
        write_private(&last_prompt_file, now.to_string().as_bytes())
            .map_err(Abort::at(&last_prompt_file))?;
    }

    Ok(())
}

#[must_use]
pub fn typed_at_terminal(prompt: Option<&Value>) -> bool {
    let Some(Value::String(text)) = prompt else {
        return true;
    };
    let start = text.trim_start_matches(is_js_whitespace);

    !NOT_TYPED_PROMPT_PREFIXES
        .iter()
        .any(|prefix| start.starts_with(prefix))
}

fn closable_ids(asks_dir: &Path, session: Option<&str>) -> Vec<String> {
    let Ok(entries) = fs::read_dir(asks_dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.ends_with(JSON_SUFFIX)
                && !SKIPPED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
        })
        .collect();
    names.sort();

    names
        .iter()
        .filter_map(|name| read_json(&asks_dir.join(name)))
        .filter_map(|record| {
            let Some(Value::String(id)) = record.get("id") else {
                return None;
            };
            let same_session = match record.get("sessionId") {
                Some(Value::Null) => true,
                Some(Value::String(owner)) => Some(owner.as_str()) == session,
                _ => false,
            };

            same_session.then(|| id.clone())
        })
        .collect()
}

fn close_asks(asks_dir: &Path, session: Option<&str>) -> Result<(), Abort> {
    for id in closable_ids(asks_dir, session) {
        let closed_file = join_path(asks_dir, &format!("{id}.closed"));

        write_private(&closed_file, b"").map_err(Abort::at(&closed_file))?;
    }

    Ok(())
}

fn session_of(input: &Value) -> Result<Option<&str>, Abort> {
    if input.is_null() {
        return Err(Abort::Input);
    }

    match input.get("session_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(session)) => Ok(Some(session)),
        Some(_) => Err(Abort::Input),
    }
}

pub fn handle_event(
    mode: Mode,
    input: &Value,
    ctx: &Context,
    now: u64,
    is_alive: &dyn Fn(f64) -> bool,
) -> Result<Option<Ask>, Abort> {
    if !is_active(ctx, is_alive) {
        return Ok(None);
    }

    dispatch(mode, input, ctx, now)
}

fn dispatch(mode: Mode, input: &Value, ctx: &Context, now: u64) -> Result<Option<Ask>, Abort> {
    let session = session_of(input)?;
    let asks_dir = ctx.app_dir.join("asks");
    let ping_file = join_path(
        &ctx.app_dir.join("pings"),
        &format!(
            "{}.json",
            safe_file_name(session.unwrap_or(DEFAULT_SESSION))
        ),
    );

    match mode {
        Mode::Permission => permission(input, ctx, now, session),
        Mode::Stop => stop(input, ctx, now, session, &ping_file).map(|()| None),
        Mode::Prompt if !typed_at_terminal(input.get("prompt")) => Ok(None),
        Mode::Prompt => {
            prompt(ctx, now, &ping_file)?;
            close_asks(&asks_dir, session).map(|()| None)
        }
        Mode::Post => close_asks(&asks_dir, session).map(|()| None),
    }
}

fn read_answers(answer_file: &Path) -> Option<Value> {
    let Value::Object(parsed) = read_json(answer_file)? else {
        return None;
    };

    parsed
        .get("answers")
        .filter(|answers| answers.is_object() || answers.is_array())
        .cloned()
}

#[must_use]
pub fn wait_for_answer(asks_dir: &Path, id: &str, pause: &dyn Fn()) -> Option<Value> {
    let answer_file = join_path(asks_dir, &format!("{id}.answer.json"));
    let closed_file = join_path(asks_dir, &format!("{id}.closed"));
    let record_file = join_path(asks_dir, &format!("{id}.json"));

    loop {
        if closed_file.exists() || !record_file.exists() {
            return None;
        }

        if let Some(answers) = read_answers(&answer_file) {
            return Some(answers);
        }

        pause();
    }
}

#[must_use]
pub fn decision_output(tool_input: &Value, answers: &Value) -> String {
    let mut updated = tool_input.as_object().cloned().unwrap_or_default();
    updated.insert("answers".to_owned(), answers.clone());

    stringify(&json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "allow",
                "updatedInput": updated
            }
        }
    }))
}

#[must_use]
pub fn read_input(stdin: &mut dyn Read) -> Value {
    let mut bytes = Vec::new();

    match stdin.read_to_end(&mut bytes) {
        Ok(_) => parse_json(&String::from_utf8_lossy(&bytes)),
        Err(_) => None,
    }
    .unwrap_or_else(|| Value::Object(Map::new()))
}

pub fn run(
    mode: Option<&str>,
    stdin: &mut dyn Read,
    stdout: &mut dyn Write,
    ctx: &Context,
    now: u64,
    is_alive: &dyn Fn(f64) -> bool,
    pause: &dyn Fn(),
) {
    let input = read_input(stdin);
    let Some(mode) = mode.and_then(Mode::parse) else {
        return;
    };

    if !is_active(ctx, is_alive) {
        return;
    }

    let ask = match dispatch(mode, &input, ctx, now) {
        Ok(ask) => ask,
        Err(abort) => {
            write_output(
                stdout,
                hook_failures::failed(&ctx.app_dir, mode, &abort, now),
            );
            return;
        }
    };

    write_output(stdout, hook_failures::succeeded(&ctx.app_dir, mode));

    let Some(ask) = ask else {
        return;
    };
    let tool_input = input.get("tool_input").unwrap_or(&Value::Null);

    if let Some(answers) = wait_for_answer(&ctx.app_dir.join("asks"), &ask.id, pause) {
        write_output(stdout, Some(decision_output(tool_input, &answers)));
    }
}

fn write_output(stdout: &mut dyn Write, output: Option<String>) {
    if let Some(output) = output {
        let _written = stdout
            .write_all(output.as_bytes())
            .and_then(|()| stdout.flush());
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

pub fn run_process(mode: Option<&str>, stdout: &mut dyn Write) {
    let home = std::env::home_dir().unwrap_or_default();
    let ctx = Context::resolve(&|name| std::env::var_os(name), &home);

    run(
        mode,
        &mut io::stdin().lock(),
        stdout,
        &ctx,
        now_ms(),
        &process_alive,
        &pause_between_polls,
    );
}

fn pause_between_polls() {
    std::thread::sleep(ANSWER_POLL);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::time::Instant;

    fn context_in(folder: &Path, extra: &[(&str, &str)]) -> Context {
        let mut variables: HashMap<String, OsString> = HashMap::from([
            (
                "BETTER_CC_TELEGRAM_DIR".to_owned(),
                folder.join("app").into_os_string(),
            ),
            (
                "TELEGRAM_STATE_DIR".to_owned(),
                folder.join("state").into_os_string(),
            ),
            ("BETTER_CC_TELEGRAM".to_owned(), OsString::from("1")),
        ]);
        for (name, value) in extra {
            variables.insert((*name).to_owned(), OsString::from(value));
        }

        Context::resolve(&|name| variables.get(name).cloned(), &folder.join("home"))
    }

    fn input(value: &Value) -> Vec<u8> {
        value.to_string().into_bytes()
    }

    fn ask_input() -> Value {
        json!({
            "session_id": "s1",
            "tool_input": {"questions": [{"question": "Q?"}], "extra": 1}
        })
    }

    fn limited_pause(calls: &Cell<u32>, limit: u32) -> impl Fn() + '_ {
        move || {
            calls.set(calls.get() + 1);
            assert!(calls.get() <= limit, "the wait never ended");
        }
    }

    struct Unreadable;

    impl Read for Unreadable {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    struct Unwritable;

    impl Write for Unwritable {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
    }

    #[test]
    fn the_limited_pause_counts_its_calls() {
        let calls = Cell::new(0);
        let pause = limited_pause(&calls, 2);

        pause();
        pause();

        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn every_mode_name_parses_and_any_other_spelling_does_not() {
        assert_eq!(Mode::parse("permission"), Some(Mode::Permission));
        assert_eq!(Mode::parse("prompt"), Some(Mode::Prompt));
        assert_eq!(Mode::parse("post"), Some(Mode::Post));
        assert_eq!(Mode::parse("stop"), Some(Mode::Stop));

        for name in ["", "Stop", "STOP", "stop ", "bogus"] {
            assert_eq!(Mode::parse(name), None, "{name:?}");
        }
    }

    #[test]
    fn the_context_reads_the_flag_the_delay_and_normalized_folders() {
        let folder = Path::new("/base");
        let flagged = |value: &str| context_in(folder, &[("BETTER_CC_TELEGRAM", value)]);

        assert!(flagged("1").telegram_instance);

        for value in ["0", "", "true", "11", " 1"] {
            assert!(!flagged(value).telegram_instance, "{value:?}");
        }

        let variables: HashMap<&str, &str> = HashMap::from([
            ("BETTER_CC_TELEGRAM_DIR", "/x/./y/../z/"),
            ("BETTER_CC_TELEGRAM_DELAY_MS", " 15 "),
        ]);
        let plain = Context::resolve(
            &|name| variables.get(name).map(OsString::from),
            Path::new("/home/u"),
        );

        assert!(!plain.telegram_instance);
        assert_eq!(plain.delay_env.as_deref(), Some(" 15 "));
        assert_eq!(plain.app_dir, PathBuf::from("/x/z"));
        assert_eq!(
            plain.state_dir,
            PathBuf::from("/home/u/.claude/channels/telegram")
        );
        assert_eq!(
            Context::resolve(&|_| None, Path::new("/home/u")).delay_env,
            None
        );
    }

    #[test]
    fn a_failing_or_invalid_stdin_reads_as_an_empty_object() {
        assert_eq!(read_input(&mut Unreadable), json!({}));
        assert_eq!(read_input(&mut &b"not json"[..]), json!({}));
        assert_eq!(read_input(&mut &b""[..]), json!({}));
        assert_eq!(read_input(&mut &b"null"[..]), Value::Null);
        assert_eq!(
            read_input(&mut &b"{\"a\":\"\xff\"}"[..]),
            json!({"a": "\u{fffd}"})
        );
    }

    #[test]
    fn a_lone_surrogate_in_stdin_keeps_the_rest_of_the_input() {
        assert_eq!(
            read_input(&mut &br#"{"session_id":"s1","prompt":"cut \ud83d here"}"#[..]),
            json!({"session_id": "s1", "prompt": "cut \u{fffd} here"})
        );
    }

    #[test]
    fn a_transcript_line_with_a_lone_surrogate_still_gives_the_context() {
        let transcript = concat!(
            r#"{"type":"user"}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"cut \ud83d"}]}}"#
        );

        assert_eq!(
            context_before_tool(transcript),
            Ok(Some("cut \u{fffd}".to_owned()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn closing_through_a_symlinked_closed_file_leaves_its_target_intact() {
        let folder = tempfile::tempdir().unwrap();
        let asks = folder.path().join("asks");
        fs::create_dir(&asks).unwrap();
        fs::write(asks.join("a.json"), r#"{"id":"a","sessionId":"s1"}"#).unwrap();
        fs::write(asks.join("b.json"), r#"{"id":"b","sessionId":"x"}"#).unwrap();
        std::os::unix::fs::symlink(asks.join("b.json"), asks.join("a.closed")).unwrap();

        close_asks(&asks, Some("s1")).unwrap();

        assert_eq!(
            fs::read_to_string(asks.join("b.json")).unwrap(),
            r#"{"id":"b","sessionId":"x"}"#
        );
        assert!(
            !fs::symlink_metadata(asks.join("a.closed"))
                .unwrap()
                .is_symlink()
        );
        assert_eq!(fs::read_to_string(asks.join("a.closed")).unwrap(), "");
    }

    #[test]
    fn the_wait_ends_without_an_answer_when_the_request_is_closed_or_gone() {
        let folder = tempfile::tempdir().unwrap();
        let calls = Cell::new(0);
        let pause = limited_pause(&calls, 0);

        assert_eq!(wait_for_answer(folder.path(), "a", &pause), None);

        fs::write(folder.path().join("a.json"), "{}").unwrap();
        fs::write(folder.path().join("a.closed"), "").unwrap();
        fs::write(
            folder.path().join("a.answer.json"),
            r#"{"answers":{"Q":"A"}}"#,
        )
        .unwrap();

        assert_eq!(wait_for_answer(folder.path(), "a", &pause), None);
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn the_wait_keeps_polling_until_the_answer_is_an_object_or_an_array() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("a.json"), "{}").unwrap();
        let answer = folder.path().join("a.answer.json");
        let steps = RefCell::new(
            [
                "{broken",
                "null",
                "5",
                "\"text\"",
                "[1]",
                r#"{"answers":null}"#,
                r#"{"answers":"s"}"#,
                r#"{"answers":5}"#,
                r#"{"answers":true}"#,
                r#"{"other":1}"#,
                r#"{"answers":{"Q":"A"}}"#,
            ]
            .into_iter(),
        );
        let calls = Cell::new(0);
        let pause = || {
            calls.set(calls.get() + 1);
            fs::write(&answer, steps.borrow_mut().next().unwrap()).unwrap();
        };

        assert_eq!(
            wait_for_answer(folder.path(), "a", &pause),
            Some(json!({"Q": "A"}))
        );
        assert_eq!(calls.get(), 11);

        fs::write(&answer, r#"{"answers":["x"]}"#).unwrap();
        assert_eq!(
            wait_for_answer(folder.path(), "a", &pause_between_polls),
            Some(json!(["x"]))
        );

        fs::write(&answer, r#"{"answers":{}}"#).unwrap();
        assert_eq!(
            wait_for_answer(folder.path(), "a", &pause_between_polls),
            Some(json!({}))
        );
    }

    #[test]
    fn a_permission_run_prints_the_decision_once_the_answer_arrives() {
        let folder = tempfile::tempdir().unwrap();
        let ctx = context_in(folder.path(), &[]);
        let asks = folder.path().join("app/asks");
        let calls = Cell::new(0);
        let mut out = Vec::new();
        let pause = || {
            calls.set(calls.get() + 1);
            assert!(calls.get() <= 3, "the wait never ended");
            fs::write(
                asks.join("s1-1000.answer.json"),
                r#"{"answers":{"Q?":"A"}}"#,
            )
            .unwrap();
        };

        run(
            Some("permission"),
            &mut input(&ask_input()).as_slice(),
            &mut out,
            &ctx,
            1000,
            &|_| false,
            &pause,
        );

        assert_eq!(
            String::from_utf8(out).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":[{"question":"Q?"}],"extra":1,"answers":{"Q?":"A"}}}}}"#
        );
        assert_eq!(calls.get(), 1);
        assert!(asks.join("s1-1000.json").exists());
    }

    #[test]
    fn a_failing_stdout_does_not_stop_the_run() {
        let folder = tempfile::tempdir().unwrap();
        let ctx = context_in(folder.path(), &[]);
        let asks = folder.path().join("app/asks");
        let calls = Cell::new(0);
        let limit = limited_pause(&calls, 3);
        let pause = || {
            limit();
            fs::write(asks.join("s1-1000.answer.json"), r#"{"answers":{}}"#).unwrap();
        };

        run(
            Some("permission"),
            &mut input(&ask_input()).as_slice(),
            &mut Unwritable,
            &ctx,
            1000,
            &|_| false,
            &pause,
        );

        assert!(asks.join("s1-1000.json").exists());
    }

    #[test]
    fn a_closed_request_prints_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let ctx = context_in(folder.path(), &[]);
        let asks = folder.path().join("app/asks");
        let calls = Cell::new(0);
        let limit = limited_pause(&calls, 3);
        let pause = || {
            limit();
            fs::write(asks.join("s1-1000.closed"), "").unwrap();
        };
        let mut out = Vec::new();

        run(
            Some("permission"),
            &mut input(&ask_input()).as_slice(),
            &mut out,
            &ctx,
            1000,
            &|_| false,
            &pause,
        );

        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn modes_that_wait_for_nothing_and_unknown_modes_return_without_output() {
        let folder = tempfile::tempdir().unwrap();
        let ctx = context_in(folder.path(), &[]);
        let calls = Cell::new(0);
        let pause = limited_pause(&calls, 0);
        let stop = json!({"session_id": "s1", "last_assistant_message": "hi"});

        for mode in [
            None,
            Some("bogus"),
            Some("stop"),
            Some("post"),
            Some("prompt"),
        ] {
            let mut out = Vec::new();
            run(
                mode,
                &mut input(&stop).as_slice(),
                &mut out,
                &ctx,
                1000,
                &|_| false,
                &pause,
            );
            assert_eq!(out, Vec::<u8>::new(), "{mode:?}");
            assert_eq!(
                folder.path().join("app/pings/s1.json").exists(),
                matches!(mode, Some("stop" | "post")),
                "{mode:?}"
            );
        }
    }

    #[test]
    fn a_permission_without_questions_returns_without_waiting() {
        let folder = tempfile::tempdir().unwrap();
        let ctx = context_in(folder.path(), &[]);
        let calls = Cell::new(0);
        let mut out = Vec::new();

        run(
            Some("permission"),
            &mut input(&json!({"session_id": "s1"})).as_slice(),
            &mut out,
            &ctx,
            1000,
            &|_| false,
            &limited_pause(&calls, 0),
        );

        assert_eq!(out, Vec::<u8>::new());
    }

    #[test]
    fn the_current_process_is_alive_and_impossible_pids_are_not() {
        assert!(process_alive(f64::from(std::process::id())));

        for pid in [2_147_483_646.0, 2_147_483_648.0, 3e9, 0.0, -5.0, 2.5] {
            assert!(!process_alive(pid), "{pid}");
        }
    }

    #[test]
    fn the_clock_is_the_unix_time_in_milliseconds() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let now = u128::from(now_ms());
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();

        assert!(before <= now && now <= after);
    }

    #[test]
    fn the_poll_pause_lasts_one_second() {
        let start = Instant::now();

        pause_between_polls();

        assert!(start.elapsed() >= ANSWER_POLL);
        assert!(start.elapsed() < ANSWER_POLL * 5);
    }
}
