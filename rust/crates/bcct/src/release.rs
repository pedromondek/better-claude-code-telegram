use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{Map, Number, Value};

use crate::config::{read_config, read_locale};
use crate::files::{FileFailure, read_json, write_private};
use crate::hook::{millis, now_ms};
use crate::js::{join_path, js_string, js_trim, js_truthy, normalize_path, stringify};
use crate::messages::messages_for;
use crate::paths::Paths;

const JSON_SUFFIX: &str = ".json";
const SKIPPED_SUFFIXES: [&str; 2] = [".telegram.json", ".answer.json"];
const MARKERS: [&str; 3] = [".telegram.json", ".closed", ".answer.json"];
const DEFAULT_INSTANCE: &str = "telegram";
const FAILURE: u8 = 1;

fn pending_ask_ids(asks_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(asks_dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();

    names
        .into_iter()
        .filter(|name| !SKIPPED_SUFFIXES.iter().any(|suffix| name.ends_with(suffix)))
        .filter_map(|name| name.strip_suffix(JSON_SUFFIX).map(str::to_owned))
        .filter(|id| {
            !MARKERS
                .iter()
                .any(|marker| join_path(asks_dir, &format!("{id}{marker}")).exists())
        })
        .collect()
}

fn session_of(record: &Map<String, Value>, id: &Value) -> String {
    match record.get("sessionId") {
        None | Some(Value::Null) => js_string(id),
        Some(session) => js_string(session),
    }
}

pub fn release_pending_asks(
    app_dir: &Path,
    prefix: &str,
    now: u64,
) -> Result<Vec<Value>, FileFailure> {
    let asks_dir = join_path(app_dir, "asks");
    let mut released = Vec::new();

    for id in pending_ask_ids(&asks_dir) {
        let file = join_path(&asks_dir, &format!("{id}{JSON_SUFFIX}"));
        let Some(Value::Object(record)) = read_json(&file) else {
            continue;
        };
        let (Some(record_id @ Value::String(_)), Some(Value::Number(due))) =
            (record.get("id"), record.get("dueAt"))
        else {
            continue;
        };

        if due.as_f64().unwrap_or_default() <= millis(now)
            || !session_of(&record, record_id).starts_with(prefix)
        {
            continue;
        }

        let mut updated = record.clone();
        updated.insert("dueAt".to_owned(), Value::Number(Number::from(now)));
        write_private(&file, stringify(&Value::Object(updated)).as_bytes())
            .map_err(|_| FileFailure::NotSaved(file))?;
        released.push(Value::Object(record));
    }

    Ok(released)
}

#[must_use]
pub fn headers_of(record: &Value) -> String {
    let Some(Value::Array(questions)) = record.get("questions") else {
        return String::new();
    };

    questions
        .iter()
        .filter_map(|question| {
            [question.get("header"), question.get("question")]
                .into_iter()
                .flatten()
                .find(|value| !value.is_null())
        })
        .filter(|value| js_truthy(value))
        .map(js_string)
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn run(
    prefix: Option<&str>,
    var: &dyn Fn(&str) -> Option<OsString>,
    home: &Path,
    now: u64,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> u8 {
    let app_dir = normalize_path(&Paths::resolve(var, home).app_dir);
    let messages = messages_for(read_locale(&read_config(&app_dir)));
    let prefix = js_trim(prefix.unwrap_or_default());
    let released = match release_pending_asks(&app_dir, prefix, now) {
        Ok(released) => released,
        Err(failure) => {
            let _written = stderr.write_all(format!("{}\n", failure.message(messages)).as_bytes());
            return FAILURE;
        }
    };
    let mut out = String::new();

    if released.is_empty() {
        out.push_str(&(messages.nothing_pending)(Some(prefix)));
        out.push('\n');
    }

    for record in &released {
        let instance = match record.get("instance") {
            None | Some(Value::Null) => DEFAULT_INSTANCE.to_owned(),
            Some(instance) => js_string(instance),
        };

        out.push_str(&(messages.question_released)(
            &instance,
            &headers_of(record),
        ));
        out.push('\n');
    }

    let _written = stdout
        .write_all(out.as_bytes())
        .and_then(|()| stdout.flush());

    0
}

pub fn run_process(prefix: Option<&str>, stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    let home = std::env::home_dir().unwrap_or_default();

    run(
        prefix,
        &|name| std::env::var_os(name),
        &home,
        now_ms(),
        stdout,
        stderr,
    )
}
