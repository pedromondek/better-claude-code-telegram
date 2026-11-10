#![cfg(unix)]
#![cfg(test)]

mod support;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use bcct::changes::{ChangeContext, describe_changes, parsed_json, setting_text};
use bcct::journal::{Change, ChangeKind, Journal};
use bcct::js::{parse_json, stringify_pretty};
use bcct::locale::Locale;
use bcct::messages::{Messages, messages_for};
use bcct::settings::{
    is_our_statusline, statusline_preview, with_env_denied, with_statusline, without_env_denied,
};
use bcct::setup::{
    SetupPaths, StatuslineKind, env_deny_rule, read_settings, shell_file, shell_rc_files,
    statusline_kind,
};
use bcct::setup_files::{
    ConfigError, Printer, SetupFiles, StatuslineChoice, apply_statusline, current_inbox_days,
    ensure_env_denied, forget_statusline_customized, forget_statusline_request,
    remove_our_settings, request_statusline_custom, save_inbox_days, save_previous_statusline,
    update_config,
};
use bcct::shell_rc::{
    install_shell_function, rc_files_without_shell_line, rc_loads, remove_shell_lines, source_line,
    with_shell_block, without_shell_block,
};
use serde_json::{Map, Value, json};
use support::{
    Tree, default_file_mode, list, lookup, materialize, object, placeholders, release_form,
    repo_root, sandbox, snapshot, substitute, text,
};

const FIXTURE: &str = include_str!("fixtures/setup-files.json");
const SETTINGS_NAME: &str = "settings.json";
const PRIVATE_APP_FILES: [&str; 3] = [
    "better-cc-telegram.json",
    "statusline-previous.json",
    "statusline-customize.json",
];

fn fixture() -> Value {
    parse_json(&release_form(FIXTURE)).unwrap()
}

fn environment(env: &Value, root: &Path) -> HashMap<String, OsString> {
    let set: Map<String, Value> = object(env)
        .iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();

    support::environment(&Value::Object(set), root)
}

fn repo_text(value: &str) -> String {
    value.replace("{repo}", &repo_root().to_string_lossy())
}

fn optional(entry: &Value) -> Option<Value> {
    if entry.get("absent").is_some() {
        None
    } else {
        Some(entry["value"].clone())
    }
}

fn locale_of(entry: &Value) -> &'static Messages {
    messages_for(Locale::parse(text(entry, "locale")).unwrap())
}

fn deep_substitute(value: &Value, root: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(substitute(text, root)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| deep_substitute(item, root))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), deep_substitute(item, root)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn change_kind(name: &str) -> ChangeKind {
    match name {
        "fileCreated" => ChangeKind::FileCreated,
        "fileChanged" => ChangeKind::FileChanged,
        "dirCreated" => ChangeKind::DirCreated,
        "marketplaceAdded" => ChangeKind::MarketplaceAdded,
        "pluginInstalled" => ChangeKind::PluginInstalled,
        "pluginRemoved" => ChangeKind::PluginRemoved,
        "toolInstalled" => ChangeKind::ToolInstalled,
        other => panic!("unknown change kind {other}"),
    }
}

fn kind_name(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::FileCreated => "fileCreated",
        ChangeKind::FileChanged => "fileChanged",
        ChangeKind::DirCreated => "dirCreated",
        ChangeKind::MarketplaceAdded => "marketplaceAdded",
        ChangeKind::PluginInstalled => "pluginInstalled",
        ChangeKind::PluginRemoved => "pluginRemoved",
        ChangeKind::ToolInstalled => "toolInstalled",
    }
}

fn changes_json(changes: &[Change], root: &Path) -> Value {
    Value::Array(
        changes
            .iter()
            .map(|change| json!({"kind": kind_name(change.kind), "target": placeholders(&change.target, root)}))
            .collect(),
    )
}

fn outcome(result: Result<String, String>, root: &Path) -> Value {
    match result {
        Ok(value) => json!({"value": placeholders(&value, root)}),
        Err(error) => json!({"error": placeholders(&error, root)}),
    }
}

fn caught(value: Result<Option<Map<String, Value>>, String>) -> Value {
    match value {
        Ok(Some(map)) => json!({"value": map}),
        Ok(None) => json!({"value": null}),
        Err(error) => json!({"error": error}),
    }
}

#[test]
fn the_shell_lines_match_the_js() {
    for entry in list(&fixture(), "shell") {
        let rc_text = repo_text(text(entry, "text"));
        let shell = repo_text(text(entry, "shellFile"));
        let expected = |key: &str| entry[key].as_str().map(repo_text);

        assert_eq!(
            source_line(&shell),
            repo_text(text(entry, "sourceLine")),
            "{entry}"
        );
        assert_eq!(
            rc_loads(&rc_text, &shell),
            entry["loads"].as_bool().unwrap(),
            "{entry}"
        );
        assert_eq!(
            with_shell_block(&rc_text, &shell),
            expected("withBlock"),
            "{entry}"
        );
        assert_eq!(
            without_shell_block(&rc_text, &shell),
            expected("withoutBlock"),
            "{entry}"
        );
    }
}

#[test]
fn the_deny_rules_match_the_js() {
    for entry in list(&fixture(), "denyRules") {
        assert_eq!(
            env_deny_rule(Path::new(text(entry, "envFile")), text(entry, "home")),
            text(entry, "rule"),
            "{entry}"
        );
    }
}

#[test]
fn adding_and_removing_the_deny_rule_match_the_js() {
    let fixture = fixture();
    let rule = text(&fixture, "rule");

    for entry in list(&fixture, "envDenied") {
        let settings = object(&entry["settings"]);

        assert_eq!(
            caught(with_env_denied(settings, rule)),
            entry["with"],
            "{entry}"
        );
        assert_eq!(
            caught(without_env_denied(settings, rule)),
            entry["without"],
            "{entry}"
        );
    }
}

fn kind_text(kind: StatuslineKind) -> &'static str {
    match kind {
        StatuslineKind::None => "none",
        StatuslineKind::Ours => "ours",
        StatuslineKind::OursAfter => "ours-after",
        StatuslineKind::Other => "other",
    }
}

#[test]
fn the_status_line_helpers_match_the_js() {
    let repo = repo_root();

    for entry in list(&fixture(), "statuslines") {
        let status_line = optional(&deep_substitute(&entry["statusLine"], &repo));
        let mut settings = Map::new();
        settings.insert("theme".to_owned(), json!("dark"));

        if let Some(status_line) = &status_line {
            settings.insert("statusLine".to_owned(), status_line.clone());
        }

        let expected = deep_substitute(&entry["withStatusline"], &repo);

        if let Some(preview) = entry["preview"].as_str() {
            assert_eq!(statusline_preview(status_line.as_ref()), preview, "{entry}");
        }
        assert_eq!(
            is_our_statusline(status_line.as_ref(), &repo),
            entry["ours"].as_bool().unwrap(),
            "{entry}"
        );
        assert_eq!(
            kind_text(statusline_kind(status_line.as_ref(), &repo)),
            text(entry, "kind"),
            "{entry}"
        );
        assert_eq!(
            with_statusline(&settings, "node x").map_or(Value::Null, Value::Object),
            expected,
            "{entry}"
        );
    }
}

#[test]
fn the_setting_texts_match_the_js() {
    for entry in list(&fixture(), "settingTexts") {
        let value = optional(&entry["value"]);
        let key = text(entry, "key");

        assert_eq!(
            setting_text(key, value.as_ref(), messages_for(Locale::EnUs)),
            text(entry, "en"),
            "{entry}"
        );
        assert_eq!(
            setting_text(key, value.as_ref(), messages_for(Locale::PtBr)),
            text(entry, "pt"),
            "{entry}"
        );
    }
}

#[test]
fn parsed_json_matches_the_js() {
    for entry in list(&fixture(), "parsed") {
        let parsed = Value::Object(parsed_json(entry["text"].as_str()));
        let expected = match &entry["out"] {
            Value::Object(_) => entry["out"].clone(),
            _ => json!({}),
        };

        assert_eq!(parsed, expected, "{entry}");
    }
}

#[test]
fn the_rc_files_match_the_js() {
    for entry in list(&fixture(), "rcFiles") {
        let root = sandbox();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();

        for name in entry["files"].as_array().unwrap() {
            fs::write(home.join(name.as_str().unwrap()), "").unwrap();
        }

        let files = shell_rc_files(
            &home.to_string_lossy(),
            entry["shell"].as_str(),
            text(entry, "platform") == "darwin",
        );
        let path = |file: &PathBuf| placeholders(&file.to_string_lossy(), root.path());

        assert_eq!(
            json!({
                "primary": files.primary.as_ref().map(path),
                "others": files.others.iter().map(path).collect::<Vec<_>>(),
                "unsupported": files.unsupported,
            }),
            entry["out"],
            "{entry}"
        );
    }
}

fn make_links(root: &Path, links: &Value) {
    for (link, target) in object(links) {
        let link = root.join(link);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target.as_str().unwrap(), link).unwrap();
    }
}

fn is_js_format(source: &str) -> bool {
    parse_json(source).is_some_and(|value| format!("{}\n", stringify_pretty(&value)) == source)
}

fn keeps_its_own_format(entry: &Value) -> bool {
    object(&entry["files"]).iter().any(|(path, spec)| {
        let content = spec
            .as_str()
            .or_else(|| spec.get("content").and_then(Value::as_str));

        path.ends_with(SETTINGS_NAME) && content.is_some_and(|content| !is_js_format(content))
    })
}

fn expected_tree(after: &Value, default_mode: &str) -> Tree {
    object(after)
        .iter()
        .map(|(path, entry)| {
            let mode = match text(entry, "mode") {
                "644" => default_mode.to_owned(),
                mode => mode.to_owned(),
            };

            (
                path.clone(),
                (
                    entry
                        .get("content")
                        .map(|content| content.as_str().unwrap().to_owned()),
                    mode,
                ),
            )
        })
        .collect()
}

fn same_json(left: &str, right: &str) -> bool {
    match (parse_json(left), parse_json(right)) {
        (Some(left), Some(right)) => stringify_pretty(&left) == stringify_pretty(&right),
        _ => false,
    }
}

fn assert_tree(actual: &Tree, expected: &Tree, own_format: bool, name: &str) {
    assert_eq!(
        actual.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>(),
        "{name}"
    );

    for (path, (content, mode)) in expected {
        let (actual_content, actual_mode) = &actual[path];
        let private_app_file =
            PRIVATE_APP_FILES.iter().any(|file| path.ends_with(file)) && actual_mode == "600";

        assert!(
            actual_mode == mode || private_app_file,
            "{name}: {path} {actual_mode} {mode}"
        );

        if actual_content == content {
            continue;
        }

        assert!(
            own_format
                && path.ends_with(SETTINGS_NAME)
                && same_json(
                    actual_content.as_deref().unwrap(),
                    content.as_deref().unwrap()
                ),
            "{name}: {path}\n{actual_content:?}\n{content:?}"
        );
    }
}

fn choice_of(name: &str) -> StatuslineChoice {
    match name {
        "on" => StatuslineChoice::On,
        "after" => StatuslineChoice::After,
        "replace" => StatuslineChoice::Replace,
        "custom" => StatuslineChoice::Custom,
        "off" => StatuslineChoice::Off,
        _ => StatuslineChoice::Keep,
    }
}

struct Run {
    value: Value,
    error: Option<ConfigError>,
    output_failed: bool,
}

fn run_operation(
    entry: &Value,
    root: &Path,
    variables: &HashMap<String, OsString>,
    journal: &mut Journal,
    out: &mut dyn std::io::Write,
) -> Run {
    let messages = locale_of(entry);
    let args = deep_substitute(&entry["args"], root);
    let var = |name: &str| variables.get(name).cloned();
    let home = variables["HOME"].to_string_lossy().into_owned();
    let paths = SetupPaths::resolve(&var, Path::new(&home));
    let app_dir = PathBuf::from(&variables["BETTER_CC_TELEGRAM_DIR"]);
    let state_dir = PathBuf::from(&variables["TELEGRAM_STATE_DIR"]);
    let repo = repo_root();
    let files = SetupFiles {
        app_dir: &app_dir,
        state_dir: &state_dir,
        settings_file: &paths.settings_file,
        home: &home,
        repo: &repo,
    };
    let now = 1_700_000_000_123;
    let mut printer = Printer::new(out, entry["colorize"].as_bool().unwrap(), messages);
    let default_shell = shell_file(&repo);
    let shell_path = args["shellFile"]
        .as_str()
        .map_or(default_shell, PathBuf::from);
    let mut value = Value::Null;
    let result = match text(entry, "op") {
        "applyStatusline" => apply_statusline(
            &files,
            choice_of(text(&args, "choice")),
            now,
            journal,
            &mut printer,
        ),
        "ensureEnvDenied" => ensure_env_denied(&files, journal, &mut printer),
        "installShellFunction" => install_shell_function(
            &home,
            args["shell"].as_str(),
            text(&args, "platform") == "darwin",
            &shell_path,
            journal,
            &mut printer,
        ),
        "removeShellLines" => remove_shell_lines(&home, &shell_path, &mut printer),
        "rcFilesWithoutShellLine" => {
            let shell = variables
                .get("SHELL")
                .map(|shell| shell.to_string_lossy().into_owned());
            let files = rc_files_without_shell_line(&home, shell.as_deref(), false, &shell_path);
            value = json!(
                files
                    .iter()
                    .map(|file| placeholders(&file.to_string_lossy(), root))
                    .collect::<Vec<_>>()
            );
            Ok(())
        }
        "removeOurSettings" => read_settings(&paths.settings_file, messages)
            .map_err(ConfigError::Refused)
            .and_then(|settings| remove_our_settings(&settings, &files, journal, &mut printer)),
        "updateConfig" => update_config(&app_dir, object(&args["patch"]), journal)
            .map(|file| value = json!(placeholders(&file.to_string_lossy(), root)))
            .map_err(ConfigError::File),
        "saveInboxDays" => save_inbox_days(&app_dir, args["days"].as_f64(), journal, &mut printer),
        "currentInboxDays" => {
            value = current_inbox_days(&app_dir).map_or(Value::Null, |days| json!(days));
            Ok(())
        }
        "requestStatuslineCustom" => {
            let current = Some(&args["current"]).filter(|current| !current.is_null());
            request_statusline_custom(&files, current, now, journal, &mut printer)
        }
        "forgetStatuslineRequest" => {
            forget_statusline_request(&app_dir, journal).map_err(ConfigError::File)
        }
        "forgetStatuslineCustomized" => {
            forget_statusline_customized(&app_dir, journal).map_err(ConfigError::File)
        }
        "savePreviousStatusline" => {
            save_previous_statusline(&app_dir, &args["statusLine"], journal)
                .map_err(ConfigError::File)
        }
        "writeJsonAtomic" => {
            bcct::settings::write_json_atomic(&paths.settings_file, object(&args["data"]), journal)
                .map_err(ConfigError::File)
        }
        other => panic!("unknown operation {other}"),
    };

    Run {
        value,
        error: result.err(),
        output_failed: printer.output_failed(),
    }
}

fn names_a_system_error(error: &str) -> bool {
    error
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|word| {
            word.len() > 3
                && word.starts_with('E')
                && word.chars().all(|letter| letter.is_ascii_uppercase())
        })
}

fn assert_lines(out: &[u8], expected: &Value, root: &Path, name: &str) {
    let mut lines = String::new();

    for line in expected["lines"].as_array().unwrap() {
        lines.push_str(line.as_str().unwrap());
        lines.push('\n');
    }

    assert_eq!(
        placeholders(std::str::from_utf8(out).unwrap(), root),
        lines,
        "{name}"
    );
}

fn assert_result(run: &Run, expected: &Value, root: &Path, messages: &Messages, name: &str) {
    match (&run.error, expected.get("error").and_then(Value::as_str)) {
        (None, None) => {
            let value = expected["value"].clone();
            let value = if value.is_number() {
                json!(value.as_f64())
            } else {
                value
            };
            assert_eq!(run.value, value, "{name}");
        }
        (Some(ConfigError::File(_)), Some(error)) if names_a_system_error(error) => {}
        (Some(error), Some(expected)) => {
            assert_eq!(
                placeholders(&error.message(messages), root),
                expected,
                "{name}"
            );
        }
        (actual, expected) => panic!("{name}: {actual:?} instead of {expected:?}"),
    }
}

#[test]
fn every_file_operation_matches_the_js_and_undoes_like_it() {
    let default_mode = default_file_mode();
    let fixture = fixture();
    let operations = list(&fixture, "operations");
    let workers = std::thread::available_parallelism().map_or(1, usize::from);

    std::thread::scope(|scope| {
        for chunk in operations.chunks(operations.len().div_ceil(workers)) {
            let default_mode = &default_mode;
            scope.spawn(move || {
                for entry in chunk {
                    check_operation(entry, default_mode);
                }
            });
        }
    });
}

fn check_operation(entry: &Value, default_mode: &str) {
    {
        let name = text(entry, "name");
        let root = sandbox();
        materialize(root.path(), &entry["files"]);
        make_links(root.path(), &entry["links"]);

        let variables = environment(&entry["env"], root.path());
        let messages = locale_of(entry);
        let mut journal = Journal::new();
        let mut out = Vec::new();
        let run = run_operation(entry, root.path(), &variables, &mut journal, &mut out);
        let changes = journal.changes();
        let home = variables["HOME"].to_string_lossy().into_owned();
        let rule = env_deny_rule(
            &PathBuf::from(&variables["TELEGRAM_STATE_DIR"]).join(".env"),
            &home,
        );
        let repo = repo_root();
        let context = ChangeContext {
            env_rule: &rule,
            repo: &repo,
            messages,
            colorize: entry["colorize"].as_bool().unwrap(),
        };
        let own_format = keeps_its_own_format(entry);

        assert_lines(&out, &entry["result"], root.path(), name);
        assert!(!run.output_failed, "{name}");
        assert_result(&run, &entry["result"], root.path(), messages, name);
        assert_eq!(
            changes_json(&changes, root.path()),
            entry["changes"],
            "{name}"
        );
        assert_eq!(
            outcome(describe_changes(&changes, &journal, &context), root.path()),
            entry["described"],
            "{name}"
        );
        assert_tree(
            &snapshot(root.path()),
            &expected_tree(&entry["after"], default_mode),
            own_format,
            name,
        );

        let left = journal.undo_all(&mut |_| {}, &mut |_, _| {});

        assert_eq!(changes_json(&left, root.path()), entry["left"], "{name}");
        assert_tree(
            &snapshot(root.path()),
            &expected_tree(&entry["afterUndo"], default_mode),
            false,
            name,
        );
    }
}

fn check_operation_with_a_closed_output(entry: &Value, default_mode: &str) {
    let name = text(entry, "name");
    let root = sandbox();
    materialize(root.path(), &entry["files"]);
    make_links(root.path(), &entry["links"]);

    let variables = environment(&entry["env"], root.path());
    let mut journal = Journal::new();
    let mut closed = ClosedOutput;
    let run = run_operation(entry, root.path(), &variables, &mut journal, &mut closed);
    let printed = !entry["result"]["lines"].as_array().unwrap().is_empty();

    assert_eq!(run.output_failed, printed, "{name}");
    assert_result(&run, &entry["result"], root.path(), locale_of(entry), name);
    assert_eq!(
        changes_json(&journal.changes(), root.path()),
        entry["changes"],
        "{name}"
    );
    assert_tree(
        &snapshot(root.path()),
        &expected_tree(&entry["after"], default_mode),
        keeps_its_own_format(entry),
        name,
    );

    let left = journal.undo_all(&mut |_| {}, &mut |_, _| {});

    assert_eq!(changes_json(&left, root.path()), entry["left"], "{name}");
    assert_tree(
        &snapshot(root.path()),
        &expected_tree(&entry["afterUndo"], default_mode),
        false,
        name,
    );
}

#[test]
fn a_closed_output_never_stops_a_file_operation_halfway() {
    let default_mode = default_file_mode();

    for entry in list(&fixture(), "operations") {
        check_operation_with_a_closed_output(entry, &default_mode);
    }
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

type Order = std::rc::Rc<std::cell::RefCell<Vec<Value>>>;

fn run_steps(entry: &Value, root: &Path, journal: &mut Journal, order: &Order) -> Vec<Value> {
    let mut originals = Vec::new();
    let path = |relative: &Value| root.join(relative.as_str().unwrap());

    for step in entry["steps"].as_array().unwrap() {
        if let Some(file) = step.get("trackFile") {
            journal.track_file(&path(file)).unwrap();
        }
        if let Some(dir) = step.get("trackDir") {
            journal.track_dir(&path(dir));
        }
        if let Some(file) = step.get("write") {
            fs::write(path(file), substitute(text(step, "content"), root)).unwrap();
        }
        if let Some(dir) = step.get("mkdir") {
            fs::create_dir_all(path(dir)).unwrap();
        }
        if let Some(file) = step.get("chmod") {
            set_mode(
                &path(file),
                u32::try_from(step["mode"].as_u64().unwrap()).unwrap(),
            );
        }
        if let Some(file) = step.get("remove") {
            fs::remove_file(path(file)).unwrap();
        }
        if let Some(file) = step.get("original") {
            let target = path(file).to_string_lossy().into_owned();
            originals.push(match journal.original(&target) {
                None => json!({"absent": true}),
                Some(original) => json!({"value": original}),
            });
        }
        if let Some(kind) = step.get("record") {
            let target = text(step, "target").to_owned();
            let undo: Option<bcct::journal::UndoAction> = step["undo"].as_str().map(|undo| {
                let order = std::rc::Rc::clone(order);
                let succeeds = undo == "ok";
                let target = target.clone();
                Box::new(move || {
                    order.borrow_mut().push(Value::String(target));
                    succeeds
                }) as bcct::journal::UndoAction
            });
            journal.record(change_kind(kind.as_str().unwrap()), &target, undo);
        }
    }

    originals
}

#[test]
fn every_journal_script_matches_the_js() {
    let default_mode = default_file_mode();

    for entry in list(&fixture(), "journals") {
        let name = text(entry, "name");
        let root = sandbox();
        materialize(root.path(), &entry["files"]);
        make_links(root.path(), &entry["links"]);

        let variables = environment(&entry["env"], root.path());
        let var = lookup(&variables);
        let messages = locale_of(entry);
        let mut journal = Journal::new();
        let order: Order = std::rc::Rc::default();
        let originals = run_steps(entry, root.path(), &mut journal, &order);
        let home = var("HOME").unwrap().to_string_lossy().into_owned();
        let rule = env_deny_rule(
            &PathBuf::from(var("TELEGRAM_STATE_DIR").unwrap()).join(".env"),
            &home,
        );
        let repo = repo_root();
        let context = ChangeContext {
            env_rule: &rule,
            repo: &repo,
            messages,
            colorize: entry["colorize"].as_bool().unwrap(),
        };
        let changes = journal.changes();
        let described = outcome(describe_changes(&changes, &journal, &context), root.path());
        let mut events = Vec::new();
        let left = {
            let events_start = std::cell::RefCell::new(&mut events);
            let mut on_start = |change: &Change| {
                events_start.borrow_mut().push(format!(
                    "start {}",
                    placeholders(&change.target, root.path())
                ));
            };
            let mut on_done = |change: &Change, done: bool| {
                events_start.borrow_mut().push(format!(
                    "done {} {done}",
                    placeholders(&change.target, root.path())
                ));
            };
            journal.undo_all(&mut on_start, &mut on_done)
        };

        assert_eq!(
            changes_json(&changes, root.path()),
            entry["changes"],
            "{name}"
        );
        assert_eq!(Value::Array(originals), entry["originals"], "{name}");
        assert_eq!(described, entry["described"], "{name}");
        assert_eq!(json!(events), entry["events"], "{name}");
        assert_eq!(
            Value::Array(order.borrow().clone()),
            entry["order"],
            "{name}"
        );
        assert_eq!(changes_json(&left, root.path()), entry["left"], "{name}");
        assert_eq!(
            outcome(describe_changes(&left, &journal, &context), root.path()),
            entry["leftDescribed"],
            "{name}"
        );
        assert_tree(
            &snapshot(root.path()),
            &expected_tree(&entry["afterUndo"], &default_mode),
            false,
            name,
        );
    }
}

struct ClosedOutput;

impl std::io::Write for ClosedOutput {
    fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
        Err(std::io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_closed_output_is_kept_for_the_flow_to_ask_and_the_settings_are_written_anyway() {
    let root = sandbox();
    let app_dir = root.path().join("app");
    let state_dir = root.path().join("state");
    let settings_file = root.path().join("settings.json");
    let repo = repo_root();
    let ours = json!({"statusLine": {"type": "command", "command": bcct::setup::statusline_command(&repo)}});
    fs::write(&settings_file, format!("{}\n", stringify_pretty(&ours))).unwrap();
    let files = SetupFiles {
        app_dir: &app_dir,
        state_dir: &state_dir,
        settings_file: &settings_file,
        home: "/nowhere",
        repo: &repo,
    };
    let mut closed = ClosedOutput;
    let mut printer = Printer::new(&mut closed, false, messages_for(Locale::EnUs));
    let mut journal = Journal::new();

    assert!(!printer.output_failed());
    assert_eq!(
        remove_our_settings(object(&ours), &files, &mut journal, &mut printer),
        Ok(())
    );
    assert!(printer.output_failed());
    assert_eq!(fs::read_to_string(&settings_file).unwrap(), "{}\n");
    assert!(format!("{printer:?}").starts_with("Printer { colorize: false, output_failed: true"));
    assert!(std::io::Write::flush(&mut ClosedOutput).is_ok());
}

struct FailsOnce {
    failed: bool,
    written: Vec<u8>,
}

impl std::io::Write for FailsOnce {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.failed {
            self.written.extend_from_slice(buf);
            return Ok(buf.len());
        }

        self.failed = true;
        Err(std::io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_failed_output_stays_failed_even_if_a_later_line_gets_through() {
    let mut out = FailsOnce {
        failed: false,
        written: Vec::new(),
    };
    let mut printer = Printer::new(&mut out, false, messages_for(Locale::EnUs));

    printer.line("first");
    assert!(printer.output_failed());
    printer.line("second");
    assert!(printer.output_failed());
    assert!(std::io::Write::flush(&mut out).is_ok());
    assert_eq!(out.written, b"second\n");
}

#[test]
fn a_file_failure_reads_as_the_catalog_line() {
    let failure = ConfigError::File(bcct::files::FileFailure::NotSaved(PathBuf::from("/x")));

    assert_eq!(
        failure.message(messages_for(Locale::PtBr)),
        (messages_for(Locale::PtBr).file_not_saved)("/x")
    );
    assert_eq!(
        ConfigError::from(bcct::files::FileFailure::NotRemoved(PathBuf::from("/y"))),
        ConfigError::File(bcct::files::FileFailure::NotRemoved(PathBuf::from("/y")))
    );
}

#[test]
fn warns_that_the_status_line_claude_customized_still_calls_the_indicator() {
    let root = sandbox();
    let repo = repo_root();
    let en = messages_for(Locale::EnUs);
    let command = bcct::setup::statusline_command(&repo);

    assert_eq!(
        bcct::setup_files::statusline_custom_left(root.path(), &repo, en, false),
        None
    );

    fs::write(
        root.path().join("better-cc-telegram.json"),
        r#"{"statuslineCustomized":"yes"}"#,
    )
    .unwrap();
    assert_eq!(
        bcct::setup_files::statusline_custom_left(root.path(), &repo, en, false),
        None
    );

    fs::write(
        root.path().join("better-cc-telegram.json"),
        r#"{"statuslineCustomized":true}"#,
    )
    .unwrap();
    assert_eq!(
        bcct::setup_files::statusline_custom_left(root.path(), &repo, en, true),
        Some(bcct::ui::warn(&(en.statusline_custom_left)(&command), true))
    );
    assert_eq!(
        (messages_for(Locale::PtBr).statusline_custom_left)("node \"/s.mjs\""),
        "A sua statusline ainda chama o indicador do Telegram, que o Claude juntou a ela. Peça ao Claude para tirar esta chamada:\n  node \"/s.mjs\""
    );
}
