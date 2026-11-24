#![cfg(unix)]
#![cfg(test)]

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use bcct::config::delay_ms;
use bcct::hook::{
    Context, Mode, context_before_tool, decision_output, handle_event, instance_label, is_active,
    read_input, session_name_from_transcript,
};
use bcct::js::{js_number, stringify};
use serde_json::{Map, Value};

const FIXTURE: &str = include_str!("fixtures/hook.json");
const PRIVATE_FILE_MODE: &str = "600";

type Tree = BTreeMap<String, (Option<String>, String)>;

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn list<'a>(fixture: &'a Value, key: &str) -> &'a Vec<Value> {
    fixture[key].as_array().unwrap()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn substitute(text: &str, root: &Path) -> String {
    text.replace("{root}", &root.to_string_lossy())
}

fn default_file_mode() -> String {
    let folder = tempfile::tempdir().unwrap();
    let probe = folder.path().join("probe");
    fs::File::create(&probe).unwrap();

    format!(
        "{:o}",
        fs::metadata(probe).unwrap().permissions().mode() & 0o777
    )
}

fn ensure_folder(root: &Path, folder: &Path) {
    let mut current = root.to_path_buf();

    for part in folder.strip_prefix(root).unwrap().components() {
        current.push(part);

        if fs::symlink_metadata(&current).is_err() {
            fs::create_dir(&current).unwrap();
            fs::set_permissions(&current, fs::Permissions::from_mode(0o750)).unwrap();
        }
    }
}

fn body_of(spec: &Value, root: &Path) -> Vec<u8> {
    if let Some(content) = spec.as_str() {
        return substitute(content, root).into_bytes();
    }

    if let Some(bytes) = spec.get("bytes") {
        return bytes
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
            .collect();
    }

    let unit = spec.get("padUnit").and_then(Value::as_str).unwrap_or("a");
    let pad = spec.get("pad").and_then(Value::as_u64).unwrap_or(0);
    let padding = if pad == 0 {
        String::new()
    } else {
        format!(
            "{}\n",
            unit.repeat(usize::try_from(pad).unwrap() / unit.len())
        )
    };
    let head = spec.get("head").and_then(Value::as_str).unwrap_or("");
    let content = spec.get("content").and_then(Value::as_str).unwrap_or("");

    format!("{head}{padding}{}", substitute(content, root)).into_bytes()
}

fn materialize(root: &Path, files: &Map<String, Value>) -> BTreeSet<String> {
    let mut hidden = BTreeSet::new();

    for (path, spec) in files {
        let target = root.join(path);

        if path.ends_with('/') {
            ensure_folder(root, &target);
            continue;
        }

        ensure_folder(root, target.parent().unwrap());
        fs::write(&target, body_of(spec, root)).unwrap();

        let mode = spec
            .get("mode")
            .and_then(Value::as_u64)
            .map_or(0o600, |mode| u32::try_from(mode).unwrap());
        fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();

        if spec.get("pad").is_some() {
            hidden.insert(path.clone());
        }
    }

    hidden
}

fn walk(root: &Path, folder: &Path, hidden: &BTreeSet<String>, out: &mut Tree) {
    let mut names: Vec<_> = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();

    for name in names {
        let full = folder.join(name);
        let relative = full
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let metadata = fs::symlink_metadata(&full).unwrap();
        let mode = format!("{:o}", metadata.permissions().mode() & 0o777);

        if metadata.is_dir() {
            out.insert(format!("{relative}/"), (None, mode));
            walk(root, &full, hidden, out);
        } else if !hidden.contains(&relative) {
            let content = String::from_utf8_lossy(&fs::read(&full).unwrap()).into_owned();
            out.insert(relative, (Some(content), mode));
        }
    }
}

fn snapshot(root: &Path, hidden: &BTreeSet<String>) -> Tree {
    let mut out = Tree::new();
    walk(root, root, hidden, &mut out);
    out
}

fn expected_tree(after: &Value, written: &Value, default_mode: &str) -> Tree {
    let written: BTreeSet<&str> = written
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path.as_str().unwrap())
        .collect();

    after
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, entry)| {
            let mode = match text(entry, "mode") {
                _ if written.contains(path.as_str()) => PRIVATE_FILE_MODE,
                "644" => default_mode,
                mode => mode,
            };

            (
                path.clone(),
                (
                    entry
                        .get("content")
                        .map(|content| content.as_str().unwrap().to_owned()),
                    mode.to_owned(),
                ),
            )
        })
        .collect()
}

fn environment(env: &Value, root: &Path) -> HashMap<String, OsString> {
    env.as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                OsString::from(substitute(value.as_str().unwrap(), root)),
            )
        })
        .collect()
}

fn resolve_absolute(variables: &HashMap<String, OsString>, home: &Path) -> Context {
    let context = Context::resolve(&|name| variables.get(name).cloned(), home);

    for (name, folder) in [("app", &context.app_dir), ("state", &context.state_dir)] {
        assert!(
            folder.is_absolute(),
            "the {name} folder is relative ({}): the test would write inside the repository",
            folder.display()
        );
    }

    context
}

fn context(env: &Value, root: &Path) -> Context {
    resolve_absolute(&environment(env, root), &root.join("home"))
}

#[test]
#[should_panic(expected = "the app folder is relative")]
fn refuses_a_relative_app_folder() {
    let variables = HashMap::from([(
        "BETTER_CC_TELEGRAM_DIR".to_owned(),
        OsString::from("relative/app"),
    )]);

    resolve_absolute(&variables, Path::new("/home/u"));
}

#[test]
#[should_panic(expected = "the state folder is relative")]
fn refuses_a_relative_state_folder() {
    let variables = HashMap::from([(
        "TELEGRAM_STATE_DIR".to_owned(),
        OsString::from("relative/state"),
    )]);

    resolve_absolute(&variables, Path::new("/home/u"));
}

struct Handled {
    threw: bool,
    returned: Value,
    files: Tree,
}

fn handled(scenario: &Value, now: u64, alive: f64) -> Handled {
    let root = tempfile::tempdir().unwrap();
    let hidden = materialize(root.path(), scenario["files"].as_object().unwrap());
    let ctx = context(&scenario["env"], root.path());
    let input = read_input(&mut substitute(text(scenario, "stdin"), root.path()).as_bytes());
    let result = Mode::parse(text(scenario, "mode")).map_or(Ok(None), |mode| {
        handle_event(mode, &input, &ctx, now, &|pid| {
            pid.to_bits() == alive.to_bits()
        })
    });
    let returned = match &result {
        Err(_) => Value::Null,
        Ok(Some(ask)) => Value::String(stringify(&ask.record)),
        Ok(None) => Value::String("null".to_owned()),
    };

    Handled {
        threw: result.is_err(),
        returned,
        files: snapshot(root.path(), &hidden),
    }
}

#[test]
fn leaves_the_files_and_returns_the_record_the_fixture_recorded() {
    let fixture = fixture();
    let now = fixture["now"].as_u64().unwrap();
    let alive = fixture["alivePid"].as_f64().unwrap();
    let default_mode = default_file_mode();
    let scenarios = list(&fixture, "scenarios");

    assert!(scenarios.len() > 600);

    for scenario in scenarios {
        let name = text(scenario, "name");
        let outcome = handled(scenario, now, alive);

        assert_eq!(
            outcome.threw,
            scenario["threw"].as_bool().unwrap(),
            "{name}: threw"
        );
        assert_eq!(outcome.returned, scenario["returned"], "{name}: returned");
        assert_eq!(
            outcome.files,
            expected_tree(&scenario["after"], &scenario["written"], &default_mode),
            "{name}: files"
        );
    }
}

fn blessing() -> bool {
    std::env::var_os("BCCT_BLESS").is_some_and(|flag| flag == "1")
}

#[test]
fn blessing_rewrites_the_hook_fixture_from_the_binary() {
    if !blessing() {
        return;
    }

    let mut fixture = fixture();
    let now = fixture["now"].as_u64().unwrap();
    let alive = fixture["alivePid"].as_f64().unwrap();
    let default_mode = default_file_mode();

    for scenario in fixture["scenarios"].as_array_mut().unwrap() {
        let outcome = handled(scenario, now, alive);

        scenario["threw"] = Value::Bool(outcome.threw);
        scenario["returned"] = outcome.returned;

        if outcome.files != expected_tree(&scenario["after"], &scenario["written"], &default_mode) {
            scenario["written"] = Value::Array(Vec::new());
            scenario["after"] = outcome
                .files
                .iter()
                .map(|(path, (content, mode))| {
                    let mut entry = Map::new();

                    if let Some(content) = content {
                        entry.insert("content".to_owned(), Value::String(content.clone()));
                    }

                    entry.insert("mode".to_owned(), Value::String(mode.clone()));
                    (path.clone(), Value::Object(entry))
                })
                .collect::<Map<String, Value>>()
                .into();
        }
    }

    for entry in fixture["delays"].as_array_mut().unwrap() {
        let config = match serde_json::from_str::<Value>(text(entry, "config")) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let computed = delay_ms(&config, entry["env"].as_str());

        if computed.to_bits() != js_number(text(entry, "out")).to_bits() {
            entry["out"] = Value::String(stringify(&serde_json::json!(computed)));
        }
    }

    fs::write(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hook.json"),
        stringify(&fixture)
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029"),
    )
    .unwrap();
}

#[test]
fn asks_about_the_same_pids_and_answers_like_the_fixture() {
    let fixture = fixture();
    let alive = fixture["alivePid"].as_f64().unwrap();

    for entry in list(&fixture, "gate") {
        let name = text(entry, "name");
        let root = tempfile::tempdir().unwrap();
        materialize(root.path(), entry["files"].as_object().unwrap());
        let mut env = Map::new();
        env.insert(
            "TELEGRAM_STATE_DIR".to_owned(),
            Value::String("{root}/state".to_owned()),
        );
        for (key, value) in entry["env"].as_object().unwrap() {
            if value.is_null() {
                env.remove(key);
            } else {
                env.insert(key.clone(), value.clone());
            }
        }
        let ctx = context(&Value::Object(env), root.path());
        let calls = RefCell::new(Vec::new());

        let active = is_active(&ctx, &|pid| {
            calls.borrow_mut().push(pid);
            pid.to_bits() == alive.to_bits()
        });

        let expected: Vec<f64> = entry["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pid| pid.as_f64().unwrap())
            .collect();

        assert_eq!(active, entry["out"].as_bool().unwrap(), "{name}: active");
        assert_eq!(calls.into_inner(), expected, "{name}: calls");
    }
}

#[test]
fn computes_each_delay_the_fixture_recorded() {
    let fixture = fixture();

    for entry in list(&fixture, "delays") {
        let config = match serde_json::from_str::<Value>(text(entry, "config")) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let env = entry["env"].as_str();

        assert_eq!(
            delay_ms(&config, env),
            js_number(text(entry, "out")),
            "{entry}"
        );
    }
}

#[test]
fn reads_the_context_before_the_tool_like_the_fixture_for_every_transcript() {
    let fixture = fixture();
    let texts = list(&fixture, "texts");

    for entry in list(&fixture, "contexts") {
        let source = texts[usize::try_from(entry["text"].as_u64().unwrap()).unwrap()]
            .as_str()
            .unwrap();
        let result = context_before_tool(source);

        assert_eq!(
            result.is_err(),
            entry["threw"].as_bool().unwrap(),
            "{entry}"
        );

        if let Ok(context) = result {
            assert_eq!(
                context.map_or(Value::Null, Value::String),
                entry["out"],
                "{entry}"
            );
        }
    }
}

#[test]
fn names_the_session_like_the_fixture_for_every_transcript() {
    let fixture = fixture();
    let texts = list(&fixture, "texts");

    for entry in list(&fixture, "names") {
        let source = texts[usize::try_from(entry["text"].as_u64().unwrap()).unwrap()]
            .as_str()
            .unwrap();
        let name = session_name_from_transcript(source);

        assert_eq!(
            name.map_or_else(|| "null".to_owned(), |value| stringify(&value)),
            text(entry, "out"),
            "{entry}"
        );
    }
}

#[test]
fn labels_the_instance_like_the_fixture_for_every_transcript_and_input() {
    let fixture = fixture();
    let texts = list(&fixture, "texts");
    let instances = list(&fixture, "instances");

    assert!(instances.len() > 600);

    for entry in instances {
        let source = texts[usize::try_from(entry["text"].as_u64().unwrap()).unwrap()]
            .as_str()
            .unwrap();
        let input: Value = serde_json::from_str(text(entry, "input")).unwrap();
        let result = instance_label(&input, entry["telegram"].as_bool().unwrap(), source);

        assert_eq!(
            result.is_err(),
            entry["threw"].as_bool().unwrap(),
            "{entry}"
        );

        if let Ok(label) = result {
            assert_eq!(
                label.map_or_else(|| "null".to_owned(), |value| stringify(&value)),
                text(entry, "out"),
                "{entry}"
            );
        }
    }
}

#[test]
fn serializes_the_permission_decision_byte_for_byte_like_json_stringify() {
    let fixture = fixture();

    for entry in list(&fixture, "decisions") {
        let tool_input: Value = serde_json::from_str(text(entry, "toolInput")).unwrap();
        let answers: Value = serde_json::from_str(text(entry, "answers")).unwrap();

        assert_eq!(
            decision_output(&tool_input, &answers),
            text(entry, "out"),
            "{entry}"
        );
    }
}
