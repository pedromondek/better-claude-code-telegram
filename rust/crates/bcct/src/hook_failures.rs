use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::config::{read_config, read_locale};
use crate::files::{create_private_dir, read_json, write_private};
use crate::hook::{Abort, Mode};
use crate::js::stringify;
use crate::messages::{EN_US, Messages, messages_for};

pub const FAILURES_FILE: &str = "hook-failures.json";
pub const RECURRENT_COUNT: usize = 3;
pub const RECURRENT_WINDOW_MS: u64 = 86_400_000;
pub const TRANSIENT_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NoPermission,
    DiskFull,
    ReadOnly,
    Quota,
    Busy,
    Input,
}

impl Reason {
    const ALL: [Self; 6] = [
        Self::NoPermission,
        Self::DiskFull,
        Self::ReadOnly,
        Self::Quota,
        Self::Busy,
        Self::Input,
    ];

    #[must_use]
    pub fn of(abort: &Abort) -> Self {
        match abort {
            Abort::Input => Self::Input,
            Abort::Io { kind, .. } => match kind {
                io::ErrorKind::PermissionDenied => Self::NoPermission,
                io::ErrorKind::StorageFull => Self::DiskFull,
                io::ErrorKind::ReadOnlyFilesystem => Self::ReadOnly,
                io::ErrorKind::QuotaExceeded => Self::Quota,
                _ => Self::Busy,
            },
        }
    }

    #[must_use]
    pub fn is_permanent(self) -> bool {
        !matches!(self, Self::Busy | Self::Input)
    }

    fn code(self) -> &'static str {
        match self {
            Self::NoPermission => "no-permission",
            Self::DiskFull => "disk-full",
            Self::ReadOnly => "read-only",
            Self::Quota => "quota",
            Self::Busy => "busy",
            Self::Input => "input",
        }
    }

    fn parse(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.code() == code)
    }

    #[must_use]
    pub fn text(self, messages: &Messages) -> &'static str {
        let reasons = &messages.hook_reasons;

        match self {
            Self::NoPermission => reasons.no_permission,
            Self::DiskFull => reasons.disk_full,
            Self::ReadOnly => reasons.read_only,
            Self::Quota => reasons.quota,
            Self::Busy => reasons.busy,
            Self::Input => reasons.input,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub event: Mode,
    pub reason: Reason,
    pub file: Option<String>,
    pub count: usize,
}

impl Notice {
    #[must_use]
    pub fn user_text(&self, messages: &Messages) -> String {
        let reason = self.reason.text(messages);

        match &self.file {
            Some(file) => (messages.hook_write_failed)(file, reason),
            None => (messages.hook_failed_often)(
                self.event.event_name(),
                u64::try_from(self.count).unwrap_or(u64::MAX),
                reason,
            ),
        }
    }

    #[must_use]
    pub fn claude_text(&self) -> String {
        format!(
            "better-claude-code-telegram: the {} hook failed: {}. Tell the user and recommend running /bcct:health.",
            self.event.event_name(),
            self.user_text(&EN_US).trim_end_matches('.')
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Transient {
    event: Mode,
    reason: Reason,
    at: u64,
}

#[derive(Debug, Default)]
struct State {
    transient: Vec<Transient>,
    notices: BTreeMap<Mode, (Notice, bool)>,
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn parse_transient(value: &Value) -> Option<Transient> {
    Some(Transient {
        event: Mode::from_event_name(text_field(value, "event")?)?,
        reason: Reason::parse(text_field(value, "reason")?)?,
        at: value.get("at")?.as_u64()?,
    })
}

fn parse_notice(event: Mode, value: &Value) -> Option<(Notice, bool)> {
    let notice = Notice {
        event,
        reason: Reason::parse(text_field(value, "reason")?)?,
        file: text_field(value, "file").map(str::to_owned),
        count: value
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or_default(),
    };
    let told = value
        .get("told")
        .and_then(Value::as_bool)
        .unwrap_or_default();

    Some((notice, told))
}

impl State {
    fn load(app_dir: &Path) -> Self {
        let Some(Value::Object(raw)) = read_json(&app_dir.join(FAILURES_FILE)) else {
            return Self::default();
        };
        let transient = raw
            .get("transient")
            .and_then(Value::as_array)
            .map(|entries| entries.iter().filter_map(parse_transient).collect())
            .unwrap_or_default();
        let notices = raw
            .get("notices")
            .and_then(Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|(name, value)| {
                        let event = Mode::from_event_name(name)?;
                        parse_notice(event, value).map(|entry| (event, entry))
                    })
                    .collect()
            })
            .unwrap_or_default();

        Self { transient, notices }
    }

    fn to_value(&self) -> Value {
        let transient: Vec<Value> = self
            .transient
            .iter()
            .map(|entry| {
                json!({
                    "event": entry.event.event_name(),
                    "reason": entry.reason.code(),
                    "at": entry.at,
                })
            })
            .collect();
        let notices: Map<String, Value> = self
            .notices
            .iter()
            .map(|(event, (notice, told))| {
                (
                    event.event_name().to_owned(),
                    json!({
                        "reason": notice.reason.code(),
                        "file": notice.file,
                        "count": notice.count,
                        "told": told,
                    }),
                )
            })
            .collect();

        json!({ "transient": transient, "notices": notices })
    }

    fn save(&self, app_dir: &Path) {
        let _saved = create_private_dir(app_dir).and_then(|()| {
            write_private(
                &app_dir.join(FAILURES_FILE),
                stringify(&self.to_value()).as_bytes(),
            )
        });
    }
}

fn context_value(lines: &[String]) -> Value {
    json!({
        "hookEventName": Mode::Prompt.event_name(),
        "additionalContext": lines.join("\n"),
    })
}

fn failure_output(notice: &Notice, messages: &Messages) -> String {
    let mut output = Map::new();
    output.insert(
        "systemMessage".to_owned(),
        Value::String(notice.user_text(messages)),
    );

    if notice.event == Mode::Prompt {
        output.insert(
            "hookSpecificOutput".to_owned(),
            context_value(&[notice.claude_text()]),
        );
    }

    stringify(&Value::Object(output))
}

#[must_use]
pub fn failed(app_dir: &Path, event: Mode, abort: &Abort, now: u64) -> Option<String> {
    let reason = Reason::of(abort);
    let mut state = State::load(app_dir);

    state
        .transient
        .retain(|entry| now.saturating_sub(entry.at) < RECURRENT_WINDOW_MS);

    let notice = match abort {
        Abort::Io { path, .. } if reason.is_permanent() => Some(Notice {
            event,
            reason,
            file: Some(path.to_string_lossy().into_owned()),
            count: 0,
        }),
        _ => {
            state.transient.push(Transient {
                event,
                reason,
                at: now,
            });
            let excess = state.transient.len().saturating_sub(TRANSIENT_LIMIT);
            state.transient.drain(..excess);

            let count = state
                .transient
                .iter()
                .filter(|entry| entry.event == event && entry.reason == reason)
                .count();

            (count >= RECURRENT_COUNT).then_some(Notice {
                event,
                reason,
                file: None,
                count,
            })
        }
    };

    if let Some(notice) = &notice {
        state
            .notices
            .insert(event, (notice.clone(), event == Mode::Prompt));
    }

    state.save(app_dir);

    notice.map(|notice| failure_output(&notice, messages_for(read_locale(&read_config(app_dir)))))
}

#[must_use]
pub fn open_notices(app_dir: &Path) -> Vec<Notice> {
    State::load(app_dir)
        .notices
        .into_values()
        .map(|(notice, _)| notice)
        .collect()
}

pub fn clear_reason(app_dir: &Path, reason: Reason) {
    let mut state = State::load(app_dir);
    let before = state.notices.len();

    state
        .notices
        .retain(|_, (notice, _)| notice.reason != reason);

    if state.notices.len() != before {
        state.save(app_dir);
    }
}

#[must_use]
pub fn succeeded(app_dir: &Path, event: Mode) -> Option<String> {
    let mut state = State::load(app_dir);
    let cleared = state.notices.remove(&event).is_some();
    let untold: Vec<String> = if event == Mode::Prompt {
        state
            .notices
            .values_mut()
            .filter(|(_, told)| !*told)
            .map(|(notice, told)| {
                *told = true;
                notice.claude_text()
            })
            .collect()
    } else {
        Vec::new()
    };

    if cleared || !untold.is_empty() {
        state.save(app_dir);
    }

    (!untold.is_empty()).then(|| {
        stringify(&json!({
            "hookSpecificOutput": context_value(&untold),
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    const NOW: u64 = 1_731_300_000_000;
    const PING_FILE: &str = "/app/pings/s1.json";

    fn io_at(kind: io::ErrorKind) -> Abort {
        Abort::Io {
            kind,
            path: PathBuf::from(PING_FILE),
        }
    }

    fn app() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn saved(app_dir: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(app_dir.join(FAILURES_FILE)).unwrap()).unwrap()
    }

    fn parsed(output: Option<String>) -> Value {
        serde_json::from_str(&output.unwrap()).unwrap()
    }

    fn set_language(app_dir: &Path, language: &str) {
        fs::write(
            app_dir.join(crate::paths::CONFIG_FILE),
            json!({ "language": language }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn treats_only_the_errors_that_block_writing_as_permanent() {
        let cases = [
            (io::ErrorKind::PermissionDenied, Reason::NoPermission, true),
            (io::ErrorKind::StorageFull, Reason::DiskFull, true),
            (io::ErrorKind::ReadOnlyFilesystem, Reason::ReadOnly, true),
            (io::ErrorKind::QuotaExceeded, Reason::Quota, true),
            (io::ErrorKind::NotFound, Reason::Busy, false),
            (io::ErrorKind::AlreadyExists, Reason::Busy, false),
            (io::ErrorKind::ResourceBusy, Reason::Busy, false),
            (io::ErrorKind::IsADirectory, Reason::Busy, false),
            (io::ErrorKind::Interrupted, Reason::Busy, false),
        ];

        for (kind, reason, permanent) in cases {
            assert_eq!(Reason::of(&io_at(kind)), reason, "{kind:?}");
            assert_eq!(reason.is_permanent(), permanent, "{kind:?}");
        }

        assert_eq!(Reason::of(&Abort::Input), Reason::Input);
        assert!(!Reason::Input.is_permanent());
    }

    #[test]
    fn reads_every_reason_back_from_its_code() {
        for reason in Reason::ALL {
            assert_eq!(Reason::parse(reason.code()), Some(reason));
        }

        assert_eq!(Reason::parse("other"), None);
    }

    #[test]
    fn warns_at_once_in_the_config_language_when_a_write_is_blocked_for_good() {
        let folder = app();
        set_language(folder.path(), "pt-br");

        let output = failed(
            folder.path(),
            Mode::Stop,
            &io_at(io::ErrorKind::StorageFull),
            NOW,
        );

        assert_eq!(
            parsed(output),
            json!({
                "systemMessage": "bcct: não consegui gravar /app/pings/s1.json (disco cheio). As mensagens do Telegram podem não chegar. Rode /bcct:health."
            })
        );
        assert_eq!(
            saved(folder.path()),
            json!({
                "transient": [],
                "notices": {
                    "Stop": {"reason": "disk-full", "file": PING_FILE, "count": 0, "told": false}
                }
            })
        );
    }

    #[test]
    fn tells_claude_at_once_when_the_prompt_hook_cannot_write() {
        let folder = app();

        let output = failed(
            folder.path(),
            Mode::Prompt,
            &io_at(io::ErrorKind::PermissionDenied),
            NOW,
        );

        assert_eq!(
            parsed(output),
            json!({
                "systemMessage": "bcct: could not write /app/pings/s1.json (no write permission). Telegram messages may not arrive. Run /bcct:health.",
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": "better-claude-code-telegram: the UserPromptSubmit hook failed: bcct: could not write /app/pings/s1.json (no write permission). Telegram messages may not arrive. Run /bcct:health. Tell the user and recommend running /bcct:health."
                }
            })
        );
        assert_eq!(
            saved(folder.path())["notices"]["UserPromptSubmit"]["told"],
            json!(true)
        );
    }

    #[test]
    fn stays_silent_until_the_third_passing_failure_in_24_hours() {
        let folder = app();
        let busy = io_at(io::ErrorKind::ResourceBusy);

        assert_eq!(failed(folder.path(), Mode::Post, &busy, NOW), None);
        assert_eq!(failed(folder.path(), Mode::Post, &busy, NOW + 1), None);
        assert!(
            !folder.path().join(FAILURES_FILE).exists()
                || saved(folder.path())["notices"] == json!({})
        );

        let output = failed(folder.path(), Mode::Post, &busy, NOW + 2);

        assert_eq!(
            parsed(output),
            json!({
                "systemMessage": "bcct: the PostToolUse hook failed 3 times in 24 h (file busy or changed by another instance). Run /bcct:health."
            })
        );
        assert_eq!(
            saved(folder.path())["notices"]["PostToolUse"],
            json!({"reason": "busy", "file": null, "count": 3, "told": false})
        );
        assert_eq!(
            saved(folder.path())["transient"],
            json!([
                {"event": "PostToolUse", "reason": "busy", "at": NOW},
                {"event": "PostToolUse", "reason": "busy", "at": NOW + 1},
                {"event": "PostToolUse", "reason": "busy", "at": NOW + 2},
            ])
        );
    }

    #[test]
    fn drops_a_failure_exactly_24_hours_old() {
        let folder = app();

        assert_eq!(failed(folder.path(), Mode::Stop, &Abort::Input, NOW), None);
        assert_eq!(
            failed(folder.path(), Mode::Stop, &Abort::Input, NOW + 1),
            None
        );
        assert_eq!(
            failed(
                folder.path(),
                Mode::Stop,
                &Abort::Input,
                NOW + RECURRENT_WINDOW_MS
            ),
            None
        );
        assert_eq!(
            saved(folder.path())["transient"].as_array().unwrap().len(),
            2
        );

        let output = failed(
            folder.path(),
            Mode::Stop,
            &Abort::Input,
            NOW + RECURRENT_WINDOW_MS,
        );

        assert_eq!(
            parsed(output)["systemMessage"],
            json!(
                "bcct: the Stop hook failed 3 times in 24 h (unexpected input from Claude Code). Run /bcct:health."
            )
        );
    }

    #[test]
    fn counts_a_failure_just_under_24_hours_old() {
        let folder = app();

        assert_eq!(failed(folder.path(), Mode::Stop, &Abort::Input, NOW), None);
        assert_eq!(
            failed(folder.path(), Mode::Stop, &Abort::Input, NOW + 1),
            None
        );

        let output = failed(
            folder.path(),
            Mode::Stop,
            &Abort::Input,
            NOW + RECURRENT_WINDOW_MS - 1,
        );

        assert!(output.is_some());
    }

    #[test]
    fn counts_only_the_same_hook_with_the_same_reason() {
        let folder = app();
        let busy = io_at(io::ErrorKind::ResourceBusy);

        for (event, abort) in [
            (Mode::Stop, &busy),
            (Mode::Stop, &Abort::Input),
            (Mode::Post, &busy),
            (Mode::Stop, &busy),
            (Mode::Permission, &busy),
            (Mode::Stop, &Abort::Input),
        ] {
            assert_eq!(failed(folder.path(), event, abort, NOW), None);
        }

        assert_eq!(saved(folder.path())["notices"], json!({}));
        assert!(failed(folder.path(), Mode::Stop, &busy, NOW).is_some());
    }

    #[test]
    fn keeps_only_the_latest_passing_failures() {
        let folder = app();

        for offset in 0..u64::try_from(TRANSIENT_LIMIT).unwrap() + 5 {
            let _output = failed(folder.path(), Mode::Stop, &Abort::Input, NOW + offset);
        }

        let transient = saved(folder.path())["transient"].clone();

        assert_eq!(transient.as_array().unwrap().len(), TRANSIENT_LIMIT);
        assert_eq!(transient[0]["at"], json!(NOW + 5));
    }

    #[test]
    fn sends_the_permanent_warning_even_when_the_app_folder_cannot_be_written() {
        let folder = app();
        let blocked = folder.path().join("app");
        fs::write(&blocked, "a file where the folder should be").unwrap();

        let output = failed(
            &blocked,
            Mode::Stop,
            &io_at(io::ErrorKind::ReadOnlyFilesystem),
            NOW,
        );

        assert_eq!(
            parsed(output)["systemMessage"],
            json!(
                "bcct: could not write /app/pings/s1.json (read-only file system). Telegram messages may not arrive. Run /bcct:health."
            )
        );
    }

    #[test]
    fn clears_only_its_own_notice_when_the_hook_works_again() {
        let folder = app();
        let full = io_at(io::ErrorKind::QuotaExceeded);
        let _stop = failed(folder.path(), Mode::Stop, &full, NOW);
        let _post = failed(folder.path(), Mode::Post, &full, NOW);

        assert_eq!(succeeded(folder.path(), Mode::Stop), None);

        assert_eq!(
            saved(folder.path())["notices"],
            json!({"PostToolUse": {"reason": "quota", "file": PING_FILE, "count": 0, "told": false}})
        );
    }

    #[test]
    fn tells_claude_once_on_prompt_about_every_notice_still_open() {
        let folder = app();
        set_language(folder.path(), "pt-br");
        let _stop = failed(
            folder.path(),
            Mode::Stop,
            &io_at(io::ErrorKind::StorageFull),
            NOW,
        );
        for offset in 0..3 {
            let _post = failed(folder.path(), Mode::Post, &Abort::Input, NOW + offset);
        }

        let output = succeeded(folder.path(), Mode::Prompt);
        let context = [
            "better-claude-code-telegram: the PostToolUse hook failed: bcct: the PostToolUse hook failed 3 times in 24 h (unexpected input from Claude Code). Run /bcct:health. Tell the user and recommend running /bcct:health.",
            "better-claude-code-telegram: the Stop hook failed: bcct: could not write /app/pings/s1.json (disk full). Telegram messages may not arrive. Run /bcct:health. Tell the user and recommend running /bcct:health.",
        ]
        .join("\n");

        assert_eq!(
            parsed(output),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": context
                }
            })
        );
        assert_eq!(saved(folder.path())["notices"]["Stop"]["told"], json!(true));
        assert_eq!(
            saved(folder.path())["notices"]["PostToolUse"]["told"],
            json!(true)
        );
        assert_eq!(succeeded(folder.path(), Mode::Prompt), None);
    }

    #[test]
    fn clears_the_prompt_notice_without_telling_claude_again() {
        let folder = app();
        let _prompt = failed(
            folder.path(),
            Mode::Prompt,
            &io_at(io::ErrorKind::PermissionDenied),
            NOW,
        );

        assert_eq!(succeeded(folder.path(), Mode::Prompt), None);
        assert_eq!(saved(folder.path())["notices"], json!({}));
    }

    #[test]
    fn writes_nothing_when_a_hook_works_with_nothing_open() {
        let folder = app();
        let app_dir = folder.path().join("app");

        for event in Mode::ALL {
            assert_eq!(succeeded(&app_dir, event), None);
        }

        assert!(!app_dir.exists());
    }

    #[test]
    fn keeps_the_file_as_it_was_when_another_hook_works() {
        let folder = app();
        let _stop = failed(
            folder.path(),
            Mode::Stop,
            &io_at(io::ErrorKind::StorageFull),
            NOW,
        );
        let before = fs::read_to_string(folder.path().join(FAILURES_FILE)).unwrap();

        assert_eq!(succeeded(folder.path(), Mode::Post), None);
        assert_eq!(
            fs::read_to_string(folder.path().join(FAILURES_FILE)).unwrap(),
            before
        );
    }

    #[test]
    fn reads_a_broken_failures_file_as_empty() {
        for broken in [
            "not json".to_owned(),
            json!([1, 2]).to_string(),
            json!({"transient": "x", "notices": []}).to_string(),
            json!({
                "transient": [
                    {"event": "Nope", "reason": "busy", "at": 1},
                    {"event": "Stop", "reason": "nope", "at": 1},
                    {"event": "Stop", "reason": "busy", "at": "1"},
                    {"reason": "busy", "at": 1},
                    {"event": "Stop", "at": 1},
                    {"event": "Stop", "reason": "busy"},
                ],
                "notices": {
                    "Nope": {"reason": "busy"},
                    "Stop": {"reason": "nope"},
                    "PostToolUse": {"file": PING_FILE},
                }
            })
            .to_string(),
        ] {
            let folder = app();
            fs::write(folder.path().join(FAILURES_FILE), &broken).unwrap();

            assert_eq!(succeeded(folder.path(), Mode::Prompt), None, "{broken}");
            assert_eq!(
                failed(folder.path(), Mode::Stop, &Abort::Input, NOW),
                None,
                "{broken}"
            );
            assert_eq!(
                saved(folder.path()),
                json!({
                    "transient": [{"event": "Stop", "reason": "input", "at": NOW}],
                    "notices": {}
                }),
                "{broken}"
            );
        }
    }

    #[test]
    fn reads_a_notice_with_missing_fields_with_defaults() {
        let folder = app();
        fs::write(
            folder.path().join(FAILURES_FILE),
            json!({"notices": {"Stop": {"reason": "busy", "count": "3", "told": "yes"}}})
                .to_string(),
        )
        .unwrap();

        let output = succeeded(folder.path(), Mode::Prompt);

        assert_eq!(
            parsed(output)["hookSpecificOutput"]["additionalContext"],
            json!(
                "better-claude-code-telegram: the Stop hook failed: bcct: the Stop hook failed 0 times in 24 h (file busy or changed by another instance). Run /bcct:health. Tell the user and recommend running /bcct:health."
            )
        );
    }
}
