use std::fs::{self, File, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstArray, CstInputValue, CstNode, CstObject, CstObjectProp, CstRootNode};
use serde_json::{Map, Value};

use crate::files::{FileFailure, create_private_child_dir, open_private, read_json};
use crate::journal::{Journal, resolved_target};
use crate::js::{
    format_number, join_path, js_number, js_string, js_truthy, ordered_entries, parse_json,
    stringify_pretty,
};
use crate::paths::PREVIOUS_STATUSLINE_FILE;
use crate::setup::{StatuslineKind, read_text, statusline_kind};

pub const STATUS_LINE: &str = "statusLine";
pub const PERMISSIONS: &str = "permissions";
pub const ENABLED_PLUGINS: &str = "enabledPlugins";
pub const DENY: &str = "deny";
pub const SETTINGS_FILE: &str = "settings.json";

const COMMAND: &str = "command";
const TYPE: &str = "type";
const COMMAND_TYPE: &str = "command";
const PREVIEW_LIMIT: usize = 60;
#[cfg(unix)]
const NEW_FILE_MODE: u32 = 0o600;
const LOCK_ATTEMPTS: usize = 50;
const LOCK_POLL: Duration = Duration::from_millis(100);
const SETTINGS_LOCK: &str = "locks/settings.json.lock";
const INCLUDES_MISSING: &str = "deny.includes is not a function";
const FILTER_MISSING: &str = "deny.filter is not a function";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockAttempt {
    Held,
    Busy,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    pub settings: Map<String, Value>,
    pub restored: bool,
}

#[must_use]
pub fn status_line_value(command: &str) -> Value {
    let mut status_line = Map::new();
    status_line.insert(TYPE.to_owned(), Value::String(COMMAND_TYPE.to_owned()));
    status_line.insert(COMMAND.to_owned(), Value::String(command.to_owned()));
    Value::Object(status_line)
}

#[must_use]
pub fn is_our_statusline(status_line: Option<&Value>, app_dir: &Path) -> bool {
    matches!(
        statusline_kind(status_line, app_dir),
        StatuslineKind::Ours | StatuslineKind::OursAfter
    )
}

#[must_use]
pub fn statusline_preview(status_line: Option<&Value>) -> String {
    let field = |name: &str| {
        status_line
            .and_then(|value| value.get(name))
            .filter(|value| !value.is_null())
    };
    let command = field(COMMAND)
        .or_else(|| field(TYPE))
        .map(js_string)
        .unwrap_or_default();
    let units: Vec<u16> = command.encode_utf16().collect();

    if units.len() <= PREVIEW_LIMIT {
        return command;
    }

    let kept = units.get(..PREVIEW_LIMIT - 1).unwrap_or_default();
    format!("{}…", String::from_utf16_lossy(kept))
}

#[must_use]
pub fn with_status_line(settings: &Map<String, Value>, command: &str) -> Map<String, Value> {
    let mut updated = settings.clone();
    updated.insert(STATUS_LINE.to_owned(), status_line_value(command));
    updated
}

#[must_use]
pub fn with_statusline(settings: &Map<String, Value>, command: &str) -> Option<Map<String, Value>> {
    if settings.get(STATUS_LINE).is_some_and(js_truthy) {
        return None;
    }

    Some(with_status_line(settings, command))
}

pub fn without_our_statusline(
    settings: &Map<String, Value>,
    app_dir: &Path,
) -> Result<Option<Removal>, FileFailure> {
    if !is_our_statusline(settings.get(STATUS_LINE), app_dir) {
        return Ok(None);
    }

    let previous_file = join_path(app_dir, PREVIOUS_STATUSLINE_FILE);
    let previous = read_json(&previous_file).filter(js_truthy);

    remove_if_present(&previous_file).map_err(not_removed(&previous_file))?;

    let mut rest = settings.clone();
    rest.shift_remove(STATUS_LINE);
    let restored = previous.is_some();

    if let Some(previous) = previous {
        rest.insert(STATUS_LINE.to_owned(), previous);
    }

    Ok(Some(Removal {
        settings: rest,
        restored,
    }))
}

pub fn not_saved(path: &Path) -> impl Fn(io::Error) -> FileFailure + '_ {
    move |_| FileFailure::NotSaved(path.to_path_buf())
}

pub fn not_removed(path: &Path) -> impl Fn(io::Error) -> FileFailure + '_ {
    move |_| FileFailure::NotRemoved(path.to_path_buf())
}

pub fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn deny_of(settings: &Map<String, Value>) -> Option<&Value> {
    settings
        .get(PERMISSIONS)
        .and_then(Value::as_object)
        .and_then(|permissions| permissions.get(DENY))
        .filter(|deny| !deny.is_null())
}

#[must_use]
pub fn deny_includes(deny: Option<&Value>, rule: &str) -> Option<bool> {
    match deny {
        None => Some(false),
        Some(Value::Array(items)) => Some(items.iter().any(|item| item.as_str() == Some(rule))),
        Some(Value::String(text)) => Some(text.contains(rule)),
        Some(_) => None,
    }
}

fn utf16_units(text: &str) -> Vec<Value> {
    text.encode_utf16()
        .map(|unit| Value::String(String::from_utf16_lossy(&[unit])))
        .collect()
}

#[must_use]
pub fn spread_object(value: &Value) -> Map<String, Value> {
    let items = match value {
        Value::Object(map) => return map.clone(),
        Value::Array(items) => items.clone(),
        Value::String(text) => utf16_units(text),
        _ => Vec::new(),
    };

    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| (index.to_string(), item))
        .collect()
}

fn spread_items(deny: Option<&Value>) -> Vec<Value> {
    match deny {
        Some(Value::Array(items)) => items.clone(),
        Some(Value::String(text)) => text
            .chars()
            .map(|character| Value::String(character.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

pub fn with_env_denied(
    settings: &Map<String, Value>,
    rule: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let deny = deny_of(settings);

    if deny_includes(deny, rule).ok_or_else(|| INCLUDES_MISSING.to_owned())? {
        return Ok(None);
    }

    let mut items = spread_items(deny);
    items.push(Value::String(rule.to_owned()));

    let mut permissions = settings
        .get(PERMISSIONS)
        .map(spread_object)
        .unwrap_or_default();
    permissions.insert(DENY.to_owned(), Value::Array(items));

    let mut updated = settings.clone();
    updated.insert(PERMISSIONS.to_owned(), Value::Object(permissions));
    Ok(Some(updated))
}

pub fn without_env_denied(
    settings: &Map<String, Value>,
    rule: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let deny = deny_of(settings);

    if !deny_includes(deny, rule).ok_or_else(|| INCLUDES_MISSING.to_owned())? {
        return Ok(None);
    }

    let remaining: Vec<Value> = deny
        .and_then(Value::as_array)
        .ok_or_else(|| FILTER_MISSING.to_owned())?
        .iter()
        .filter(|item| item.as_str() != Some(rule))
        .cloned()
        .collect();
    let mut kept = settings
        .get(PERMISSIONS)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    kept.shift_remove(DENY);

    if !remaining.is_empty() {
        kept.insert(DENY.to_owned(), Value::Array(remaining));
    }

    let mut rest = settings.clone();
    rest.shift_remove(PERMISSIONS);

    if !kept.is_empty() {
        rest.insert(PERMISSIONS.to_owned(), Value::Object(kept));
    }

    Ok(Some(rest))
}

#[must_use]
pub fn enabled_plugin(settings: &Map<String, Value>, plugin_id: &str) -> Option<bool> {
    settings
        .get(ENABLED_PLUGINS)
        .and_then(Value::as_object)
        .and_then(|plugins| plugins.get(plugin_id))
        .and_then(Value::as_bool)
}

fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|((left_key, left), (right_key, right))| {
                        left_key == right_key && same(left, right)
                    })
        }
        _ => left == right,
    }
}

fn prop_name(prop: &CstObjectProp) -> Option<String> {
    prop.decoded_name()
}

fn node_value(node: &CstNode) -> Value {
    if let Some(object) = node.as_object() {
        let mut map = Map::new();

        for prop in object.properties() {
            if let Some(name) = prop_name(&prop) {
                map.insert(name, prop.value().as_ref().map_or(Value::Null, node_value));
            }
        }

        return Value::Object(map);
    }

    if let Some(array) = node.as_array() {
        return Value::Array(array.elements().iter().map(node_value).collect());
    }

    if let Some(string) = node.as_string_lit() {
        return Value::String(string.decoded_value().unwrap_or_default());
    }

    let raw = node.to_string();

    parse_json(&raw).unwrap_or_else(|| {
        serde_json::Number::from_f64(js_number(&raw)).map_or(Value::Null, Value::Number)
    })
}

fn input_of(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(flag) => CstInputValue::Bool(*flag),
        Value::Number(number) => {
            CstInputValue::Number(format_number(number.as_f64().unwrap_or_default()))
        }
        Value::String(text) => CstInputValue::String(text.clone()),
        Value::Array(items) => CstInputValue::Array(items.iter().map(input_of).collect()),
        Value::Object(map) => CstInputValue::Object(
            ordered_entries(map)
                .into_iter()
                .map(|(key, item)| (key.clone(), input_of(item)))
                .collect(),
        ),
    }
}

fn quoted(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

fn polish(node: &CstNode, value: &Value) {
    if let (Some(string), Value::String(text)) = (node.as_string_lit(), value) {
        string.set_raw_value(quoted(text));
    }

    if let (Some(array), Value::Array(items)) = (node.as_array(), value) {
        if !items.is_empty() {
            array.ensure_multiline();
        }

        for (element, item) in array.elements().iter().zip(items) {
            polish(element, item);
        }
    }

    if let (Some(object), Value::Object(map)) = (node.as_object(), value) {
        for (prop, (key, item)) in object.properties().iter().zip(ordered_entries(map)) {
            polish_prop(prop, key, item);
        }
    }
}

fn polish_prop(prop: &CstObjectProp, key: &str, value: &Value) {
    if let Some(name) = prop.name().and_then(|name| name.as_string_lit()) {
        name.set_raw_value(quoted(key));
    }

    if let Some(node) = prop.value() {
        polish(&node, value);
    }
}

fn set_prop(prop: &CstObjectProp, value: &Value) {
    let current = prop.value();

    match (
        current.as_ref().and_then(CstNode::as_object),
        current.as_ref().and_then(CstNode::as_array),
        value,
    ) {
        (Some(object), _, Value::Object(map)) => reconcile_object(&object, map),
        (_, Some(array), Value::Array(items)) => reconcile_array(&array, items),
        _ => {
            prop.set_value(input_of(value));

            if let Some(node) = prop.value() {
                polish(&node, value);
            }
        }
    }
}

fn reconcile_array(array: &CstArray, items: &[Value]) {
    let mut kept = 0;

    for element in array.elements() {
        if items
            .get(kept)
            .is_some_and(|item| same(&node_value(&element), item))
        {
            kept += 1;
        } else {
            element.remove();
        }
    }

    let added = items.get(kept..).unwrap_or_default();

    if kept == 0 && !added.is_empty() {
        array.ensure_multiline();
    }

    for item in added {
        let node = array.append(input_of(item));
        polish(&node, item);
    }
}

fn reconcile_object(object: &CstObject, settings: &Map<String, Value>) {
    let order: Vec<&String> = ordered_entries(settings)
        .into_iter()
        .map(|(key, _)| key)
        .collect();

    for prop in object.properties() {
        if prop_name(&prop).is_some_and(|name| !settings.contains_key(&name)) {
            prop.remove();
        }
    }

    for (key, value) in ordered_entries(settings) {
        let props: Vec<CstObjectProp> = object
            .properties()
            .into_iter()
            .filter(|prop| prop_name(prop).as_deref() == Some(key.as_str()))
            .collect();
        let Some((first, others)) = props.split_first() else {
            let prop = object.append(key, input_of(value));
            polish_prop(&prop, key, value);
            continue;
        };
        let current = props
            .last()
            .and_then(CstObjectProp::value)
            .as_ref()
            .map(node_value);

        if current.is_some_and(|current| same(&current, value)) {
            continue;
        }

        for other in others {
            other.clone().remove();
        }

        set_prop(first, value);
    }

    let position = |prop: &CstObjectProp| {
        prop_name(prop)
            .and_then(|name| order.iter().position(|key| **key == name))
            .unwrap_or(usize::MAX)
    };
    object.sort_properties().by_key(position);
}

#[must_use]
pub fn edit_settings_text(text: &str, settings: &Map<String, Value>) -> Option<String> {
    let root = CstRootNode::parse(text, &ParseOptions::default()).ok()?;
    let object = root.object_value()?;

    reconcile_object(&object, settings);
    Some(root.to_string())
}

#[must_use]
pub fn settings_text(current: Option<&str>, settings: &Map<String, Value>) -> String {
    current
        .and_then(|text| edit_settings_text(text, settings))
        .unwrap_or_else(|| format!("{}\n", stringify_pretty(&Value::Object(settings.clone()))))
}

#[must_use]
pub fn settings_lock_file(app_dir: &Path) -> PathBuf {
    join_path(app_dir, SETTINGS_LOCK)
}

fn open_lock(lock: &Path) -> io::Result<File> {
    create_private_child_dir(&folder_of(lock))?;
    open_private(lock)
}

fn lock_attempt(result: &Result<(), TryLockError>) -> LockAttempt {
    match result {
        Ok(()) => LockAttempt::Held,
        Err(TryLockError::WouldBlock) => LockAttempt::Busy,
        Err(TryLockError::Error(_)) => LockAttempt::Failed,
    }
}

fn try_lock(file: &File) -> LockAttempt {
    lock_attempt(&file.try_lock())
}

fn lock_when_free(
    lock: &Path,
    attempts: usize,
    attempt: &mut dyn FnMut(&File) -> LockAttempt,
) -> Option<File> {
    let file = open_lock(lock).ok()?;

    for _ in 0..attempts {
        match attempt(&file) {
            LockAttempt::Held => return Some(file),
            LockAttempt::Failed => return None,
            LockAttempt::Busy => std::thread::sleep(LOCK_POLL),
        }
    }

    None
}

fn folder_of(path: &Path) -> PathBuf {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

fn write_locked(
    target: &Path,
    lock: &Path,
    settings: &Map<String, Value>,
    lock_attempts: usize,
) -> io::Result<()> {
    let _lock = lock_when_free(lock, lock_attempts, &mut try_lock);
    let contents = settings_text(read_text(target).as_deref(), settings);
    let mut temporary = tempfile::Builder::new()
        .prefix(".bcct-")
        .tempfile_in(folder_of(target))?;

    temporary.write_all(contents.as_bytes())?;
    temporary.as_file().sync_all()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = fs::metadata(target).map_or(NEW_FILE_MODE, |metadata| {
            metadata.permissions().mode() & 0o777
        });
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(mode))?;
    }

    temporary.persist(target).map_err(io::Error::from)?;
    Ok(())
}

pub fn write_json_atomic(
    file: &Path,
    app_dir: &Path,
    settings: &Map<String, Value>,
    journal: &mut Journal,
) -> Result<(), FileFailure> {
    journal.track_file(file).map_err(not_saved(file))?;
    write_locked(
        &resolved_target(file),
        &settings_lock_file(app_dir),
        settings,
        LOCK_ATTEMPTS,
    )
    .map_err(not_saved(file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    fn pretty(value: &Value) -> String {
        format!("{}\n", stringify_pretty(value))
    }

    #[test]
    fn a_text_that_is_not_an_object_is_written_from_scratch() {
        let settings = map(json!({"a": 1}));

        assert_eq!(settings_text(Some("[1]"), &settings), "{\n  \"a\": 1\n}\n");
        assert_eq!(settings_text(Some("{"), &settings), "{\n  \"a\": 1\n}\n");
        assert_eq!(settings_text(None, &settings), "{\n  \"a\": 1\n}\n");
    }

    #[test]
    fn numbers_compare_by_value_and_containers_by_order() {
        assert!(same(&json!(1), &json!(1.0)));
        assert!(!same(&json!(1), &json!(2)));
        assert!(!same(&json!([1]), &json!([1, 2])));
        assert!(!same(&json!([1]), &json!([2])));
        assert!(same(&json!({"a": [1.0]}), &json!({"a": [1]})));
        assert!(!same(&json!({"a": 1, "b": 2}), &json!({"b": 2, "a": 1})));
        assert!(!same(&json!({"a": 1}), &json!({"a": 2})));
        assert!(!same(&json!({"a": 1}), &json!({"a": 1, "b": 1})));
        assert!(!same(&json!("1"), &json!(1)));
    }

    #[test]
    fn loose_values_read_like_the_json_they_stand_for() {
        let root = CstRootNode::parse(
            "{hex: 0x1F, plus: +2, dot: .5, inf: Infinity, \"\\u00e9\": 1, 7: 'x'}",
            &ParseOptions::default(),
        )
        .unwrap();
        let value = node_value(&root.value().unwrap());

        assert_eq!(value["hex"], json!(31.0));
        assert_eq!(value["plus"], json!(2.0));
        assert_eq!(value["dot"], json!(0.5));
        assert_eq!(value["inf"], Value::Null);
        assert_eq!(value["é"], json!(1));
        assert_eq!(value["7"], json!("x"));
        let root = CstRootNode::parse("{'a': 'b\\'c', d: 1}", &ParseOptions::default()).unwrap();
        let value = node_value(&root.value().unwrap());

        assert_eq!(value, json!({"a": "b'c", "d": 1}));
    }

    #[test]
    fn a_lone_surrogate_cannot_be_edited_in_place_and_the_file_is_written_whole() {
        let text = format!("{{\"a\": \"{}ud83d\"}}\n", '\\');
        let settings = map(json!({"a": "\u{fffd}"}));

        assert_eq!(edit_settings_text(&text, &settings), None);
        assert_eq!(
            settings_text(Some(&text), &settings),
            "{\n  \"a\": \"\u{fffd}\"\n}\n"
        );
    }

    #[test]
    fn a_file_in_the_format_the_js_writes_comes_out_as_the_js_writes_it() {
        let cases = [
            (
                json!({}),
                json!({"statusLine": {"type": "command", "command": "x"}}),
            ),
            (
                json!({"theme": "dark", "statusLine": {"type": "command", "command": "mine", "padding": 1}}),
                json!({"theme": "dark", "statusLine": {"type": "command", "command": "x"}}),
            ),
            (
                json!({"statusLine": {"command": "x"}, "theme": "dark"}),
                json!({"theme": "dark", "statusLine": {"a": [[], {}, [1, [null]], {"b": [true]}], "3": "c"}}),
            ),
            (
                json!({"permissions": {"deny": []}}),
                json!({"permissions": {"deny": ["Read(x)"]}}),
            ),
            (
                json!({"permissions": {"deny": ["a", "Read(x)", "b"], "allow": []}, "z": 1}),
                json!({"z": 1, "permissions": {"allow": [], "deny": ["a", "b"]}}),
            ),
            (
                json!({"permissions": {"deny": ["Read(x)"]}, "z": 1}),
                json!({"z": 1}),
            ),
            (
                json!({"permissions": "ab"}),
                json!({"permissions": {"0": "a", "1": "b", "deny": ["Read(x)"]}}),
            ),
            (json!({"a": {"b": 1}}), json!({"a": [1]})),
            (json!({"a": [1, 2]}), json!({"a": [3]})),
            (json!({"a": "x"}), json!({"a": "y\u{7f}\u{1}\"\\"})),
            (
                json!({"a": 1, "b": 2}),
                json!({"b": 2, "a": 1, "c\u{7f}": 3}),
            ),
        ];

        for (before, after) in cases {
            let text = pretty(&before);

            assert_eq!(
                edit_settings_text(&text, after.as_object().unwrap()),
                Some(pretty(&after)),
                "{before} -> {after}"
            );
        }
    }

    struct Dice(u64);

    impl Dice {
        fn below(&mut self, limit: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            usize::try_from(self.0 % u64::try_from(limit).unwrap()).unwrap()
        }

        fn key(&mut self) -> String {
            let keys = ["a", "b", "c", "1", "10", "é \"x\""];
            keys[self.below(keys.len())].to_owned()
        }

        fn object(&mut self, depth: usize) -> Map<String, Value> {
            let mut map = Map::new();

            for _ in 0..self.below(4) {
                let key = self.key();
                let value = self.value(depth);
                map.insert(key, value);
            }

            map
        }

        fn value(&mut self, depth: usize) -> Value {
            let scalars = [
                Value::Null,
                json!(true),
                json!(false),
                json!(0),
                json!(7),
                json!(1.5),
                json!(-2),
                json!(1e21),
                json!(""),
                json!("x"),
                json!("é\n\"\\"),
                json!("\u{7f}\u{1}"),
            ];
            let containers = if depth == 0 { 0 } else { 4 };
            let choice = self.below(scalars.len() + containers);

            match choice.checked_sub(scalars.len()) {
                None => scalars[choice].clone(),
                Some(0 | 1) => {
                    let length = self.below(4);
                    Value::Array((0..length).map(|_| self.value(depth - 1)).collect())
                }
                Some(_) => Value::Object(self.object(depth - 1)),
            }
        }

        fn changed_object(&mut self, map: &Map<String, Value>) -> Map<String, Value> {
            let mut changed = Map::new();

            for (key, value) in map {
                match self.below(4) {
                    0 => {}
                    1 => {
                        let value = self.value(2);
                        changed.insert(key.clone(), value);
                    }
                    _ => {
                        let value = self.changed(value);
                        changed.insert(key.clone(), value);
                    }
                }
            }

            if self.below(3) == 0 {
                let key = self.key();
                let value = self.value(2);
                changed.insert(key, value);
            }

            changed
        }

        fn changed(&mut self, value: &Value) -> Value {
            match value {
                Value::Object(map) => Value::Object(self.changed_object(map)),
                Value::Array(items) => {
                    let mut changed: Vec<Value> = items
                        .iter()
                        .filter(|_| self.below(3) != 0)
                        .cloned()
                        .collect();

                    if self.below(2) == 0 {
                        changed.push(self.value(1));
                    }

                    Value::Array(changed)
                }
                other if self.below(2) == 0 => other.clone(),
                _ => self.value(1),
            }
        }
    }

    #[test]
    fn any_edit_of_a_file_in_the_js_format_comes_out_as_the_js_writes_it() {
        let mut dice = Dice(0x9e37_79b9_7f4a_7c15);

        for _ in 0..4000 {
            let before = dice.object(3);
            let after = if dice.below(4) == 0 {
                dice.object(3)
            } else {
                dice.changed_object(&before)
            };
            let text = pretty(&Value::Object(before.clone()));

            assert_eq!(
                edit_settings_text(&text, &after),
                Some(pretty(&Value::Object(after.clone()))),
                "{before:?} -> {after:?}"
            );
        }
    }

    #[test]
    fn other_formats_keep_what_was_not_touched() {
        let cases = [
            (
                "{\n    \"theme\": \"dark\", // mine\n    \"n\": 1.0,\n}\n",
                json!({"theme": "dark", "n": 1, "statusLine": {"type": "command", "command": "x"}}),
                "{\n    \"theme\": \"dark\", // mine\n    \"n\": 1.0,\n    \"statusLine\": {\n        \"type\": \"command\",\n        \"command\": \"x\",\n    },\n}\n",
            ),
            (
                "{\"theme\":\"dark\"}",
                json!({"theme": "dark", "statusLine": {"type": "command", "command": "x"}}),
                "{\n  \"theme\":\"dark\",\n  \"statusLine\": {\n    \"type\": \"command\",\n    \"command\": \"x\"\n  }\n}",
            ),
            (
                "{\n\t\"permissions\": {\n\t\t\"deny\": [\"a\"]\n\t}\n}\n",
                json!({"permissions": {"deny": ["a", "b"]}}),
                "{\n\t\"permissions\": {\n\t\t\"deny\": [\"a\", \"b\"]\n\t}\n}\n",
            ),
            (
                "{\n  \"a\": 1,\n  \"a\": 2\n}\n",
                json!({"a": 3}),
                "{\n  \"a\": 3\n}\n",
            ),
            (
                "{\n  \"a\": 1,\n  \"a\": 2\n}\n",
                json!({"a": 2}),
                "{\n  \"a\": 1,\n  \"a\": 2\n}\n",
            ),
            (
                "{\r\n  \"a\": \"\\u00e9\"\r\n}\r\n",
                json!({"a": "é", "b": true}),
                "{\r\n  \"a\": \"\\u00e9\",\r\n  \"b\": true\r\n}\r\n",
            ),
            (
                "{\n  \"b\": 1,\n  \"2\": 0\n}\n",
                json!({"b": 1, "2": 0}),
                "{\n  \"2\": 0,\n  \"b\": 1\n}\n",
            ),
        ];

        for (before, after, expected) in cases {
            assert_eq!(
                edit_settings_text(before, after.as_object().unwrap()).as_deref(),
                Some(expected),
                "{before:?}"
            );
        }
    }

    #[test]
    fn settings_that_did_not_change_keep_every_byte() {
        for text in [
            "{\n  // mine\n  \"a\": 1, /* x */\n  \"b\": [1,2,],\n  \"c\": {\"d\": true},\n}\n",
            "{\"a\":1,\"b\":[1,2],\"c\":{\"d\":true}}",
            "{\r\n\t\"a\": 1,\r\n\t\"b\": [\r\n\t\t1,\r\n\t\t2\r\n\t],\r\n\t\"c\": {\"d\": true}\r\n}",
        ] {
            let settings = map(json!({"a": 1, "b": [1, 2], "c": {"d": true}}));

            assert_eq!(edit_settings_text(text, &settings).as_deref(), Some(text));
        }
    }

    #[test]
    fn a_property_without_a_readable_name_is_kept_after_the_known_ones() {
        let text = "{\n  \"a\": 1\n}\n";
        let root = CstRootNode::parse(text, &ParseOptions::default()).unwrap();
        let object = root.object_value().unwrap();
        let prop = object.properties().into_iter().next().unwrap();
        prop.name()
            .unwrap()
            .as_string_lit()
            .unwrap()
            .set_raw_value("\"\\x\"".to_owned());

        assert_eq!(prop_name(&prop), None);

        reconcile_object(&object, &map(json!({"b": 2})));

        assert_eq!(root.to_string(), "{\n  \"b\": 2,\n  \"\\x\": 1\n}\n");
    }

    struct LockedSettings {
        _folder: tempfile::TempDir,
        file: PathBuf,
        app_dir: PathBuf,
        lock: PathBuf,
    }

    fn locked_settings(text: &str) -> LockedSettings {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("settings.json");
        let app_dir = folder.path().join("app");
        fs::write(&file, text).unwrap();
        fs::create_dir(&app_dir).unwrap();
        let lock = settings_lock_file(&app_dir);

        LockedSettings {
            _folder: folder,
            file,
            app_dir,
            lock,
        }
    }

    fn held_lock(lock: &Path) -> File {
        let holder = open_lock(lock).unwrap();
        holder.lock().unwrap();
        holder
    }

    #[test]
    fn keeps_the_lock_file_inside_the_locks_folder_of_the_app_folder() {
        assert_eq!(
            settings_lock_file(Path::new("/a")),
            PathBuf::from("/a/locks/settings.json.lock")
        );
    }

    #[test]
    fn waits_while_another_writer_holds_the_lock_and_leaves_the_settings_readable() {
        let settings = locked_settings("{\"a\":0}");
        let holder = held_lock(&settings.lock);
        let (target, lock) = (settings.file.clone(), settings.lock.clone());
        let writer =
            std::thread::spawn(move || write_locked(&target, &lock, &map(json!({"a": 1})), 100));
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);

        while !writer.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        assert!(!writer.is_finished());
        assert_eq!(fs::read_to_string(&settings.file).unwrap(), "{\"a\":0}");

        holder.unlock().unwrap();
        writer.join().unwrap().unwrap();

        assert_eq!(fs::read_to_string(&settings.file).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn writes_anyway_when_the_lock_never_comes_free() {
        let settings = locked_settings("{\"a\":0}");
        let holder = held_lock(&settings.lock);

        write_locked(&settings.file, &settings.lock, &map(json!({"a": 1})), 2).unwrap();

        assert_eq!(fs::read_to_string(&settings.file).unwrap(), "{\"a\":1}");
        holder.unlock().unwrap();
    }

    #[test]
    fn keeps_the_comments_of_the_settings_while_holding_the_lock() {
        let settings = locked_settings("{\n  // mine\n  \"a\": 0\n}\n");

        write_locked(&settings.file, &settings.lock, &map(json!({"a": 1})), 2).unwrap();

        assert_eq!(
            fs::read_to_string(&settings.file).unwrap(),
            "{\n  // mine\n  \"a\": 1\n}\n"
        );
    }

    #[test]
    fn creates_the_locks_folder_and_keeps_the_empty_lock_file_after_writing() {
        let settings = locked_settings("{}");

        write_locked(&settings.file, &settings.lock, &map(json!({"a": 1})), 2).unwrap();
        write_locked(&settings.file, &settings.lock, &map(json!({"a": 2})), 2).unwrap();

        assert_eq!(fs::read(&settings.lock).unwrap(), Vec::<u8>::new());
        assert_eq!(
            fs::read_to_string(&settings.file).unwrap(),
            "{\n  \"a\": 2\n}"
        );
    }

    #[test]
    fn writes_without_a_lock_and_without_creating_a_missing_app_folder() {
        let settings = locked_settings("{}");
        let missing = settings.app_dir.join("missing");
        let lock = settings_lock_file(&missing);
        let started = std::time::Instant::now();

        write_locked(&settings.file, &lock, &map(json!({"a": 1})), 50).unwrap();

        assert!(!missing.exists());
        assert!(started.elapsed() < LOCK_POLL * 50);
        assert_eq!(
            fs::read_to_string(&settings.file).unwrap(),
            "{\n  \"a\": 1\n}"
        );
    }

    #[test]
    fn each_result_of_the_lock_says_what_to_do_next() {
        let failure = || TryLockError::Error(io::ErrorKind::Unsupported.into());

        assert_eq!(lock_attempt(&Ok(())), LockAttempt::Held);
        assert_eq!(
            lock_attempt(&Err(TryLockError::WouldBlock)),
            LockAttempt::Busy
        );
        assert_eq!(lock_attempt(&Err(failure())), LockAttempt::Failed);
    }

    #[test]
    fn the_lock_is_tried_until_the_limit_and_a_failure_ends_the_wait() {
        let settings = locked_settings("{}");
        let attempts_until = |results: &[LockAttempt], limit: usize| {
            let mut calls = 0;
            let held = lock_when_free(&settings.lock, limit, &mut |_| {
                calls += 1;
                results[calls - 1]
            });

            (held.is_some(), calls)
        };

        assert_eq!(
            attempts_until(&[LockAttempt::Busy, LockAttempt::Busy], 2),
            (false, 2)
        );
        assert_eq!(
            attempts_until(&[LockAttempt::Busy, LockAttempt::Held], 3),
            (true, 2)
        );
        assert_eq!(attempts_until(&[LockAttempt::Failed], 3), (false, 1));
    }

    #[test]
    fn gives_no_lock_when_the_lock_file_cannot_be_opened() {
        let settings = locked_settings("{}");
        let started = std::time::Instant::now();

        assert!(lock_when_free(&settings.file.join("inside"), 50, &mut try_lock).is_none());
        assert!(lock_when_free(&settings.app_dir, 50, &mut try_lock).is_none());
        assert!(started.elapsed() < LOCK_POLL * 50);
    }

    #[test]
    fn locks_the_lock_file_against_another_handle() {
        let settings = locked_settings("{}");
        let held = lock_when_free(&settings.lock, 2, &mut try_lock).unwrap();

        assert_eq!(
            try_lock(&open_lock(&settings.lock).unwrap()),
            LockAttempt::Busy
        );
        held.unlock().unwrap();
        assert_eq!(
            try_lock(&open_lock(&settings.lock).unwrap()),
            LockAttempt::Held
        );
    }

    #[test]
    fn fails_when_the_target_cannot_be_opened_or_read() {
        let settings = locked_settings("x");
        let lock = &settings.lock;

        assert!(write_locked(&settings.file.join("settings.json"), lock, &Map::new(), 1).is_err());
        assert!(write_locked(&settings.app_dir, lock, &Map::new(), 1).is_err());
        assert_eq!(fs::read_to_string(&settings.file).unwrap(), "x");
    }

    #[test]
    fn a_relative_target_writes_its_temporary_in_the_current_folder() {
        assert_eq!(folder_of(Path::new("settings.json")), PathBuf::from("."));
        assert_eq!(
            folder_of(Path::new("/a/settings.json")),
            PathBuf::from("/a")
        );
    }

    #[test]
    fn a_plugin_counts_as_enabled_or_disabled_only_with_a_boolean() {
        let settings = map(json!({"enabledPlugins": {"a": true, "b": false, "c": 1}}));

        assert_eq!(enabled_plugin(&settings, "a"), Some(true));
        assert_eq!(enabled_plugin(&settings, "b"), Some(false));
        assert_eq!(enabled_plugin(&settings, "c"), None);
        assert_eq!(enabled_plugin(&settings, "d"), None);
        assert_eq!(
            enabled_plugin(&map(json!({"enabledPlugins": [true]})), "0"),
            None
        );
    }

    #[test]
    fn the_preview_cuts_long_commands_on_utf16_units() {
        let long = "x".repeat(70);

        assert_eq!(
            statusline_preview(Some(&json!({"command": long}))),
            format!("{}…", "x".repeat(59))
        );
        assert_eq!(statusline_preview(None), "");
    }
}
