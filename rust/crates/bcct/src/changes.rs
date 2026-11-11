use std::path::Path;

use serde_json::{Map, Value};

use crate::journal::{Change, Journal};
use crate::js::{js_basename, js_template, js_truthy, ordered_entries, parse_json, stringify};
use crate::messages::Messages;
use crate::paths::CONFIG_FILE;
use crate::settings::{ENABLED_PLUGINS, PERMISSIONS, STATUS_LINE, deny_includes};
use crate::setup::{StatuslineKind, read_text, statusline_kind};
use crate::setup_files::{templated_days, templated_delay};
use crate::ui::{green, info, note};

pub const LANGUAGE_ICON: &str = "🌐";
pub const PLUGIN_ICON: &str = "🧩";
pub const DELAY_ICON: &str = "⏳";
pub const QUIET_HOURS_ICON: &str = "🌙";
pub const TRANSCRIPTION_ICON: &str = "🎤";
pub const INBOX_ICON: &str = "📥";
pub const STATUSLINE_ICON: &str = "📊";
pub const SECURITY_RULE_ICON: &str = "🔒";

const SETTINGS_FILE: &str = "settings.json";
const DENY: &str = "deny";
const PROTECTION_FAILED: &str = "((intermediate value) ?? []).includes is not a function";
const CHANGE_SEPARATOR: &str = "\n  • ";
const OPTION_PREFIX: &str = "\n    – ";
const LONE_SURROGATE_TAG: char = '\u{fffd}';

#[derive(Debug, Clone, Copy)]
pub struct ChangeContext<'a> {
    pub env_rule: &'a str,
    pub app_dir: &'a Path,
    pub messages: &'a Messages,
    pub colorize: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfigKey {
    Language,
    Delay,
    QuietHours,
    Transcription,
    Inbox,
}

const CONFIG_KEYS: [(&str, ConfigKey); 5] = [
    ("language", ConfigKey::Language),
    ("delayMinutes", ConfigKey::Delay),
    ("quietHours", ConfigKey::QuietHours),
    ("transcription", ConfigKey::Transcription),
    ("inboxRetentionDays", ConfigKey::Inbox),
];

#[must_use]
pub fn parsed_json(text: Option<&str>) -> Map<String, Value> {
    match parse_json(text.unwrap_or("{}")) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

#[must_use]
pub fn quiet_hours_text(value: &Value) -> String {
    let part = |name: &str| value.get(name).filter(|part| js_truthy(part));

    match (part("start"), part("end")) {
        (Some(start), Some(end)) => format!("{}-{}", js_template(start), js_template(end)),
        _ => String::new(),
    }
}

fn config_setting_text(key: ConfigKey, value: Option<&Value>, messages: &Messages) -> String {
    let Some(value) = value else {
        return messages.not_set.to_owned();
    };

    match key {
        ConfigKey::Delay => templated_delay(messages, &js_template(value)),
        ConfigKey::QuietHours => {
            let text = quiet_hours_text(value);

            if text.is_empty() {
                messages.quiet_off.to_owned()
            } else {
                text
            }
        }
        ConfigKey::Transcription => value
            .get("model")
            .filter(|model| !model.is_null())
            .map_or_else(|| messages.transcription_off_label.to_owned(), js_template),
        ConfigKey::Inbox if value.is_null() => messages.inbox_forever.to_owned(),
        ConfigKey::Inbox => templated_days(messages, &js_template(value)),
        ConfigKey::Language => js_template(value),
    }
}

#[must_use]
pub fn setting_text(key: &str, value: Option<&Value>, messages: &Messages) -> String {
    CONFIG_KEYS
        .iter()
        .find(|(name, _)| *name == key)
        .map_or_else(
            || value.map_or_else(|| messages.not_set.to_owned(), js_template),
            |(_, config_key)| config_setting_text(*config_key, value, messages),
        )
}

fn option_change(
    context: &ChangeContext<'_>,
    icon: &str,
    label: &str,
    before: &str,
    after: &str,
) -> String {
    (context.messages.changed_setting)(
        &info(&format!("{icon} {label}"), context.colorize),
        &note(before, context.colorize),
        &green(after, context.colorize),
    )
}

fn statusline_label(settings: &Map<String, Value>, context: &ChangeContext<'_>) -> &'static str {
    let detail = &context.messages.health_detail.statusline;

    match statusline_kind(settings.get(STATUS_LINE), context.app_dir) {
        StatuslineKind::None => detail.none,
        StatuslineKind::Ours => detail.ours,
        StatuslineKind::OursAfter => detail.ours_after,
        StatuslineKind::Other => detail.other,
    }
}

fn protection_label(
    settings: &Map<String, Value>,
    context: &ChangeContext<'_>,
) -> Result<&'static str, String> {
    let deny = settings
        .get(PERMISSIONS)
        .and_then(Value::as_object)
        .and_then(|permissions| permissions.get(DENY))
        .filter(|deny| !deny.is_null());

    match deny_includes(deny, context.env_rule) {
        Some(true) => Ok(context.messages.rule_on),
        Some(false) => Ok(context.messages.rule_off),
        None => Err(PROTECTION_FAILED.to_owned()),
    }
}

fn unit_value(unit: u16) -> Value {
    Value::String(
        String::from_utf16(&[unit]).unwrap_or_else(|_| format!("{LONE_SURROGATE_TAG}{unit:x}")),
    )
}

fn js_keys(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => ordered_entries(map)
            .into_iter()
            .map(|(key, _)| key.clone())
            .collect(),
        Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        Value::String(text) => (0..text.encode_utf16().count())
            .map(|index| index.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

fn js_index(value: &Value, key: &str) -> Option<Value> {
    let index = || {
        key.parse::<usize>()
            .ok()
            .filter(|index| index.to_string() == key)
    };

    match value {
        Value::Object(map) => map.get(key).cloned(),
        Value::Array(items) => index().and_then(|index| items.get(index)).cloned(),
        Value::String(text) => index()
            .and_then(|index| text.encode_utf16().nth(index))
            .map(unit_value),
        _ => None,
    }
}

fn strictly_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(Value::Number(left)), Some(Value::Number(right))) => left.as_f64() == right.as_f64(),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        _ => left == right,
    }
}

fn plugin_state(value: Option<&Value>, messages: &Messages) -> &'static str {
    match value {
        None => messages.not_set,
        Some(value) if js_truthy(value) => messages.plugin_on,
        Some(_) => messages.plugin_off,
    }
}

fn plugins_of(settings: &Map<String, Value>) -> Value {
    settings
        .get(ENABLED_PLUGINS)
        .filter(|plugins| !plugins.is_null())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

pub fn settings_changes(
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    context: &ChangeContext<'_>,
) -> Result<Vec<String>, String> {
    let messages = context.messages;
    let mut changes = Vec::new();
    let (status_before, status_after) = (
        statusline_label(before, context),
        statusline_label(after, context),
    );

    if status_before != status_after {
        changes.push(option_change(
            context,
            STATUSLINE_ICON,
            messages.settings_keys.status_line,
            status_before,
            status_after,
        ));
    }

    let rule_before = protection_label(before, context)?;
    let rule_after = protection_label(after, context)?;

    if rule_before != rule_after {
        changes.push(option_change(
            context,
            SECURITY_RULE_ICON,
            messages.settings_keys.permissions,
            rule_before,
            rule_after,
        ));
    }

    let before_plugins = plugins_of(before);
    let after_plugins = plugins_of(after);
    let mut plugin_ids: Vec<String> = Vec::new();

    for plugin_id in js_keys(&after_plugins)
        .into_iter()
        .chain(js_keys(&before_plugins))
    {
        if !plugin_ids.contains(&plugin_id) {
            plugin_ids.push(plugin_id);
        }
    }

    for plugin_id in plugin_ids {
        let was = js_index(&before_plugins, &plugin_id);
        let is = js_index(&after_plugins, &plugin_id);

        if !strictly_equal(was.as_ref(), is.as_ref()) {
            changes.push(option_change(
                context,
                PLUGIN_ICON,
                &(messages.plugin_setting)(&plugin_id),
                plugin_state(was.as_ref(), messages),
                plugin_state(is.as_ref(), messages),
            ));
        }
    }

    Ok(changes)
}

fn step_title(key: ConfigKey, messages: &Messages) -> (&'static str, &'static str) {
    let titles = &messages.step_titles;

    match key {
        ConfigKey::Language => (LANGUAGE_ICON, titles.language),
        ConfigKey::Delay => (DELAY_ICON, titles.delay),
        ConfigKey::QuietHours => (QUIET_HOURS_ICON, titles.quiet_hours),
        ConfigKey::Transcription => (TRANSCRIPTION_ICON, titles.transcription),
        ConfigKey::Inbox => (INBOX_ICON, titles.inbox),
    }
}

pub fn changed_options(
    target: &str,
    journal: &Journal,
    context: &ChangeContext<'_>,
) -> Result<Vec<String>, String> {
    let name = js_basename(target);

    if name != CONFIG_FILE && name != SETTINGS_FILE {
        return Ok(Vec::new());
    }

    let before = parsed_json(journal.original(target).flatten());
    let after = parsed_json(read_text(Path::new(target)).as_deref());

    if name == SETTINGS_FILE {
        return settings_changes(&before, &after, context);
    }

    let text = |value: Option<&Value>| value.map(stringify);

    Ok(CONFIG_KEYS
        .iter()
        .filter(|(key, _)| text(before.get(*key)) != text(after.get(*key)))
        .map(|(key, config_key)| {
            let (icon, title) = step_title(*config_key, context.messages);

            option_change(
                context,
                icon,
                title,
                &config_setting_text(*config_key, before.get(*key), context.messages),
                &config_setting_text(*config_key, after.get(*key), context.messages),
            )
        })
        .collect())
}

pub fn describe_changes(
    changes: &[Change],
    journal: &Journal,
    context: &ChangeContext<'_>,
) -> Result<String, String> {
    let mut described = Vec::new();

    for change in changes {
        let options = changed_options(&change.target, journal, context)?;
        let mut text = change.describe(context.messages);

        for option in options {
            text.push_str(OPTION_PREFIX);
            text.push_str(&option);
        }

        described.push(text);
    }

    Ok(described.join(CHANGE_SEPARATOR))
}
