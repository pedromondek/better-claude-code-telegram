use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::config::{read_config, read_locale};
use crate::files::{create_private_dir, read_json, write_private};
use crate::hook::{Abort, Context, millis};
use crate::js::{join_path, js_trim, stringify};
use crate::messages::{FailureCopy, StopFailureTexts, messages_for};
use crate::paths::PINGS_FOLDER;
use crate::settings::SETTINGS_FILE;
use crate::usage_reset::{Moment, Reset, parse};

pub const REPEAT_INTERVAL_MS: u64 = 300_000;
pub const FIRST_NOTICE_AT_FAILURE: u64 = 2;
pub const AUTOMATIC_CONTINUES: u64 = 3;
pub const MARK_SUFFIX: &str = ".failures";
pub const NOTICE_SUFFIX: &str = ".notice.json";
pub const NOTICE_KIND: &str = "failure";
pub const AUTO_CONTINUE_KEY: &str = "autoContinueAtUsageLimit";
pub const AUTOMATIC_CONTINUE_PROMPTS: [&str; 2] = [
    "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.",
    "Your claude.ai usage is available again before the usage-limit reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.",
];

const MANAGED_FILE: &str = "managed-settings.json";
const DROP_IN_FOLDER: &str = "managed-settings.d";
const JSON_SUFFIX: &str = ".json";
const DETAIL_MAX_CHARS: usize = 200;
const CODE_FENCE: char = '`';
const MARKDOWN_MARKUP: [char; 3] = ['\\', '*', CODE_FENCE];
const QUOTE_PREFIX: &str = "> ";
const REASON_EMOJI: &str = "📋";
const BACK_EMOJI: &str = "🕙";
const NEXT_EMOJI: &str = "👉";
const NOT_YOUR_LIMIT: &str = "not your usage limit";
const MODEL_LIMIT_WORDS: [&str; 2] = ["opus", "sonnet"];

#[cfg(target_os = "macos")]
pub const MANAGED_SETTINGS_DIR: &str = "/Library/Application Support/ClaudeCode";
#[cfg(windows)]
pub const MANAGED_SETTINGS_DIR: &str = "C:\\Program Files\\ClaudeCode";
#[cfg(not(any(target_os = "macos", windows)))]
pub const MANAGED_SETTINGS_DIR: &str = "/etc/claude-code";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    Always,
    Guarded,
}

#[derive(Debug, Clone, Copy)]
struct Handling {
    policy: Policy,
    copy: FailureCopy,
    shows_detail: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    UsageLimit,
    Throttle,
    Billing,
    AccountOnHold,
    Authentication,
    OauthOrgNotAllowed,
    InvalidRequest,
    CloudCredential,
    ServerError,
    Unknown,
    ModelNotFound,
    MaxOutputTokens,
}

impl Kind {
    fn of(error: &str, text: &str) -> Self {
        match error {
            "rate_limit" if text.to_lowercase().contains(NOT_YOUR_LIMIT) => Self::Throttle,
            "rate_limit" => Self::UsageLimit,
            "billing_error" => Self::Billing,
            "account_on_hold" => Self::AccountOnHold,
            "authentication_failed" => Self::Authentication,
            "oauth_org_not_allowed" => Self::OauthOrgNotAllowed,
            "invalid_request" => Self::InvalidRequest,
            "cloud_credential_error" => Self::CloudCredential,
            "server_error" => Self::ServerError,
            "model_not_found" => Self::ModelNotFound,
            "max_output_tokens" => Self::MaxOutputTokens,
            _ => Self::Unknown,
        }
    }

    fn handling(self, texts: &StopFailureTexts) -> Option<Handling> {
        let (policy, copy, shows_detail) = match self {
            Self::UsageLimit => (Policy::Always, texts.usage_limit, false),
            Self::Billing => (Policy::Always, texts.billing, false),
            Self::AccountOnHold => (Policy::Always, texts.account_on_hold, false),
            Self::Authentication => (Policy::Always, texts.authentication, false),
            Self::OauthOrgNotAllowed => (Policy::Always, texts.oauth_org_not_allowed, false),
            Self::CloudCredential => (Policy::Always, texts.cloud_credential, false),
            Self::InvalidRequest => (Policy::Always, texts.invalid_request, true),
            Self::Throttle => (Policy::Guarded, texts.throttle, false),
            Self::ServerError => (Policy::Guarded, texts.server_error, false),
            Self::Unknown => (Policy::Guarded, texts.unknown, true),
            Self::ModelNotFound | Self::MaxOutputTokens => return None,
        };

        Some(Handling {
            policy,
            copy,
            shows_detail,
        })
    }

    fn key(self) -> &'static str {
        match self {
            Self::UsageLimit => "usage_limit",
            Self::Throttle => "throttle",
            Self::Billing => "billing",
            Self::AccountOnHold => "account_on_hold",
            Self::Authentication => "authentication",
            Self::OauthOrgNotAllowed => "oauth_org_not_allowed",
            Self::InvalidRequest => "invalid_request",
            Self::CloudCredential => "cloud_credential",
            Self::ServerError => "server_error",
            Self::Unknown => "unknown",
            Self::ModelNotFound => "model_not_found",
            Self::MaxOutputTokens => "max_output_tokens",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Streak {
    count: u64,
    noticed_at: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Mark {
    streaks: BTreeMap<String, Streak>,
    limit_hits: u64,
}

impl Mark {
    fn load(file: &Path) -> Self {
        let Some(Value::Object(raw)) = read_json(file) else {
            return Self::default();
        };
        let streaks = raw
            .get("errors")
            .and_then(Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|(name, value)| {
                        let count = value.get("count").and_then(Value::as_u64)?;
                        let noticed_at = value.get("noticeAt").and_then(Value::as_u64);

                        Some((name.clone(), Streak { count, noticed_at }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let limit_hits = raw
            .get("limitHits")
            .and_then(Value::as_u64)
            .unwrap_or_default();

        Self {
            streaks,
            limit_hits,
        }
    }

    fn is_empty(&self) -> bool {
        self.streaks.is_empty() && self.limit_hits == 0
    }

    fn to_value(&self) -> Value {
        let errors: Map<String, Value> = self
            .streaks
            .iter()
            .map(|(name, streak)| {
                (
                    name.clone(),
                    json!({"count": streak.count, "noticeAt": streak.noticed_at}),
                )
            })
            .collect();

        json!({"errors": errors, "limitHits": self.limit_hits})
    }

    fn save(&self, pings_dir: &Path, key: &str) -> Result<(), Abort> {
        let file = mark_file(pings_dir, key);

        if self.is_empty() {
            return remove_ignoring_missing(&file);
        }

        create_private_dir(pings_dir).map_err(Abort::at(pings_dir))?;
        write_private(&file, stringify(&self.to_value()).as_bytes()).map_err(Abort::at(&file))
    }
}

fn remove_ignoring_missing(file: &Path) -> Result<(), Abort> {
    match fs::remove_file(file) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(Abort::at(file)(error)),
        _ => Ok(()),
    }
}

fn mark_file(pings_dir: &Path, key: &str) -> PathBuf {
    join_path(pings_dir, &format!("{key}{MARK_SUFFIX}"))
}

fn notice_file(pings_dir: &Path, key: &str) -> PathBuf {
    join_path(pings_dir, &format!("{key}{NOTICE_SUFFIX}"))
}

pub(crate) fn clear_after_success(pings_dir: &Path, key: &str) -> Result<(), Abort> {
    let mut mark = Mark::load(&mark_file(pings_dir, key));

    if mark.streaks.is_empty() {
        return Ok(());
    }

    mark.streaks.clear();
    mark.save(pings_dir, key)
}

pub(crate) fn clear_after_prompt(pings_dir: &Path, key: &str) -> Result<(), Abort> {
    remove_ignoring_missing(&mark_file(pings_dir, key))?;
    clear_after_continue(pings_dir, key)
}

pub(crate) fn clear_after_continue(pings_dir: &Path, key: &str) -> Result<(), Abort> {
    remove_ignoring_missing(&notice_file(pings_dir, key))
}

fn text_field<'a>(input: &'a Value, name: &str) -> &'a str {
    input.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(js_trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(DETAIL_MAX_CHARS).collect())
}

fn detail_line(detail: &str) -> String {
    if detail.contains(CODE_FENCE) {
        literal_markdown(detail)
    } else {
        format!("{CODE_FENCE}{detail}{CODE_FENCE}")
    }
}

fn literal_markdown(text: &str) -> String {
    let mut escaped = String::new();

    for character in text.chars() {
        if MARKDOWN_MARKUP.contains(&character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }

    escaped
}

fn read_flag(file: &Path) -> Option<bool> {
    read_json(file)?.get(AUTO_CONTINUE_KEY)?.as_bool()
}

fn managed_flag(folder: &Path) -> Option<bool> {
    let mut drop_ins: Vec<PathBuf> = fs::read_dir(join_path(folder, DROP_IN_FOLDER))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();

                    name.ends_with(JSON_SUFFIX) && !name.starts_with('.')
                })
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    drop_ins.sort();

    std::iter::once(join_path(folder, MANAGED_FILE))
        .chain(drop_ins)
        .fold(None, |winner, file| read_flag(&file).or(winner))
}

fn auto_continue_enabled(ctx: &Context) -> bool {
    managed_flag(&ctx.managed_settings_dir)
        .or_else(|| read_flag(&join_path(&ctx.claude_dir, SETTINGS_FILE)))
        != Some(false)
}

fn mentions_a_model_limit(text: &str) -> bool {
    let lowered = text.to_lowercase();

    MODEL_LIMIT_WORDS.iter().any(|word| lowered.contains(word))
}

fn with_zone(when: String, zone: Option<&str>) -> String {
    match zone {
        Some(name) => format!("{when} ({name})"),
        None => when,
    }
}

struct Outlook {
    back: Option<String>,
    next: String,
}

fn usage_outlook(texts: &StopFailureTexts, text: &str, continues: bool) -> Outlook {
    let will_not_continue = texts.usage_limit.next.to_owned();
    let Some(Reset { moment, zone }) = parse(text) else {
        return Outlook {
            back: None,
            next: will_not_continue,
        };
    };
    let zone = zone.as_deref();

    match moment {
        Moment::Today(clock) => {
            let time = (texts.clock)(clock.hour, clock.minute);
            let back = (texts.back_today)(clock.hour, &with_zone(time.clone(), zone));
            let next = if continues && !mentions_a_model_limit(text) {
                (texts.next_continues_by_itself)(clock.hour, &time)
            } else {
                will_not_continue
            };

            Outlook {
                back: Some(back),
                next,
            }
        }
        Moment::Dated { month, day, clock } => Outlook {
            back: Some(with_zone(
                (texts.date_clock)(month, day, clock.hour, clock.minute),
                zone,
            )),
            next: will_not_continue,
        },
        Moment::Weekday { weekday, clock } => Outlook {
            back: Some(with_zone(
                (texts.weekday_clock)(weekday, clock.hour, clock.minute),
                zone,
            )),
            next: will_not_continue,
        },
    }
}

fn field(emoji: &str, label: &str, value: &str) -> String {
    format!("{QUOTE_PREFIX}{emoji} **{label}:** {value}")
}

fn notice_text(
    texts: &StopFailureTexts,
    handling: &Handling,
    instance: Option<&str>,
    detail: Option<&str>,
    outlook: &Outlook,
) -> String {
    let copy = handling.copy;
    let label = instance.map(literal_markdown);
    let mut lines = vec![
        (texts.title)(copy.head, label.as_deref()),
        field(REASON_EMOJI, texts.reason_label, copy.reason),
    ];

    if handling.shows_detail
        && let Some(line) = detail
    {
        lines.push(format!("{QUOTE_PREFIX}{}", detail_line(line)));
    }

    if let Some(moment) = &outlook.back {
        lines.push(field(BACK_EMOJI, texts.back_label, moment));
    }

    lines.push(field(NEXT_EMOJI, texts.next_label, &outlook.next));

    lines.join("\n")
}

fn due(streak: &mut Streak, now: u64) -> bool {
    streak.count += 1;

    let spaced = streak
        .noticed_at
        .is_none_or(|last| now.saturating_sub(last) >= REPEAT_INTERVAL_MS);
    let notify = streak.count >= FIRST_NOTICE_AT_FAILURE && spaced;

    if notify {
        streak.noticed_at = Some(now);
    }

    notify
}

pub(crate) fn record(
    input: &Value,
    ctx: &Context,
    now: u64,
    session: &str,
    key: &str,
    instance: Option<Value>,
) -> Result<(), Abort> {
    let message = text_field(input, "last_assistant_message");
    let details = text_field(input, "error_details");
    let combined = format!("{message}\n{details}");
    let kind = Kind::of(text_field(input, "error"), &combined);

    let texts = &messages_for(read_locale(&read_config(&ctx.app_dir))).stop_failure;
    let Some(handling) = kind.handling(texts) else {
        return Ok(());
    };

    let pings_dir = ctx.app_dir.join(PINGS_FOLDER);
    let mut mark = Mark::load(&mark_file(&pings_dir, key));
    let before = mark.to_value();

    let notify = match handling.policy {
        Policy::Guarded => {
            let streak = mark.streaks.entry(kind.key().to_owned()).or_insert(Streak {
                count: 0,
                noticed_at: None,
            });

            due(streak, now)
        }
        Policy::Always => true,
    };

    if kind == Kind::UsageLimit {
        mark.limit_hits += 1;
    }

    if notify {
        let label = instance.as_ref().and_then(Value::as_str);
        let detail = first_line(message).or_else(|| first_line(details));
        let outlook = if kind == Kind::UsageLimit {
            let continues = auto_continue_enabled(ctx) && mark.limit_hits <= AUTOMATIC_CONTINUES;

            usage_outlook(texts, &combined, continues)
        } else {
            Outlook {
                back: None,
                next: handling.copy.next.to_owned(),
            }
        };
        let text = notice_text(texts, &handling, label, detail.as_deref(), &outlook);
        let created = millis(now);
        let record = json!({
            "sessionId": session,
            "createdAt": created,
            "dueAt": created,
            "text": text,
            "instance": instance.unwrap_or(Value::Null),
            "kind": NOTICE_KIND,
        });
        let file = notice_file(&pings_dir, key);

        create_private_dir(&pings_dir).map_err(Abort::at(&pings_dir))?;
        write_private(&file, stringify(&record).as_bytes()).map_err(Abort::at(&file))?;
    }

    if mark.to_value() != before {
        mark.save(&pings_dir, key)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::{Mode, handle_event};
    use crate::locale::Locale;
    use std::collections::HashMap;
    use std::ffi::OsString;

    const NOW: u64 = 1_795_003_200_000;
    const SESSION_LIMIT: &str = "You've hit your session limit · resets 2:20pm (America/Sao_Paulo)";
    const TITLE: &str = "🪫 **Quota used up** · Claude stopped";
    const TITLE_PT: &str = "🪫 **Cota esgotada** · o Claude parou";
    const THROTTLE: &str = "🐢 **API slowed down** · Claude stopped";
    const SERVER: &str = "🌩️ **API unstable** · Claude stopped";
    const BILLING: &str = "💲 **Billing** · Claude stopped";
    const ON_HOLD: &str = "🚫 **Account on hold** · Claude stopped";
    const CLOUD: &str = "🔧 **Cloud credentials** · Claude stopped";
    const LOGIN: &str = "🔑 **Login** · Claude stopped";
    const ORGANIZATION: &str = "🏢 **Organization without access** · Claude stopped";
    const INVALID: &str = "⛔ **Request rejected** · Claude stopped";
    const UNEXPECTED: &str = "💥 **Unexpected error** · Claude stopped";
    const SERVER_PT: &str = "🌩️ **API instável** · o Claude parou";
    const BILLING_PT: &str = "💲 **Cobrança** · o Claude parou";
    const ON_HOLD_PT: &str = "🚫 **Conta suspensa** · o Claude parou";
    const CLOUD_PT: &str = "🔧 **Credenciais da nuvem** · o Claude parou";
    const LOGIN_PT: &str = "🔑 **Login** · o Claude parou";
    const ORGANIZATION_PT: &str = "🏢 **Organização sem acesso** · o Claude parou";
    const INVALID_PT: &str = "⛔ **Requisição recusada** · o Claude parou";
    const UNEXPECTED_PT: &str = "💥 **Erro inesperado** · o Claude parou";
    const USAGE_REASON: &str = "Reason: the usage limit of your plan was reached";
    const USAGE_REASON_PT: &str = "Motivo: o limite de uso do seu plano foi atingido";
    const CONTINUES: &str = "Next: continues by itself at 2:20 PM";
    const BACK_TODAY: &str = "Back: at 2:20 PM (America/Sao_Paulo)";
    const WILL_NOT: &str = "Next: does not continue by itself; resume it in the terminal";
    const WILL_NOT_PT: &str = "Depois: não continua sozinho, retome no terminal";

    fn field(line: &str) -> String {
        for (label, emoji) in [
            ("Reason", "📋"),
            ("Back", "🕙"),
            ("Next", "👉"),
            ("Motivo", "📋"),
            ("Volta", "🕙"),
            ("Depois", "👉"),
        ] {
            if let Some(rest) = line.strip_prefix(&format!("{label}: ")) {
                return format!("> {emoji} **{label}:** {rest}");
            }
        }

        format!("> {line}")
    }

    fn card(title: &str, lines: &[&str]) -> String {
        let fields: Vec<String> = lines.iter().map(|line| field(line)).collect();

        format!("{title}\n{}", fields.join("\n"))
    }

    fn usage_card(back: Option<&str>, next: &str) -> String {
        let mut lines = vec![USAGE_REASON];
        lines.extend(back);
        lines.push(next);

        card(TITLE, &lines)
    }

    fn usage_card_pt(back: Option<&str>, next: &str) -> String {
        let mut lines = vec![USAGE_REASON_PT];
        lines.extend(back);
        lines.push(next);

        card(TITLE_PT, &lines)
    }

    struct World {
        folder: tempfile::TempDir,
        ctx: Context,
    }

    impl World {
        fn new() -> Self {
            Self::with(&[])
        }

        fn with(extra: &[(&str, &str)]) -> Self {
            let folder = tempfile::tempdir().unwrap();
            let mut variables: HashMap<String, OsString> = HashMap::from([
                (
                    "BETTER_CC_TELEGRAM_DIR".to_owned(),
                    folder.path().join("app").into_os_string(),
                ),
                (
                    "TELEGRAM_STATE_DIR".to_owned(),
                    folder.path().join("state").into_os_string(),
                ),
                (
                    "CLAUDE_CONFIG_DIR".to_owned(),
                    folder.path().join("claude").into_os_string(),
                ),
                ("BETTER_CC_TELEGRAM".to_owned(), OsString::from("1")),
            ]);

            for (name, value) in extra {
                variables.insert((*name).to_owned(), OsString::from(value));
            }

            let mut ctx = Context::resolve(
                &|name| variables.get(name).cloned(),
                &folder.path().join("home"),
            );
            ctx.managed_settings_dir = folder.path().join("managed");

            Self { folder, ctx }
        }

        fn portuguese() -> Self {
            let world = Self::new();
            world.write("app/better-cc-telegram.json", r#"{"language":"pt-br"}"#);

            world
        }

        fn pings(&self) -> PathBuf {
            self.ctx.app_dir.join("pings")
        }

        fn write(&self, relative: &str, text: &str) {
            let file = self.folder.path().join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, text).unwrap();
        }

        fn user_setting(&self, text: &str) {
            self.write("claude/settings.json", text);
        }

        fn send(&self, mode: Mode, input: &Value) -> Result<(), Abort> {
            handle_event(mode, input, &self.ctx, NOW, &|_| true).map(|_| ())
        }

        fn fail_at(&self, session: &str, error: &str, text: &str, now: u64) {
            let input = json!({
                "session_id": session,
                "error": error,
                "last_assistant_message": text,
            });

            handle_event(Mode::StopFailure, &input, &self.ctx, now, &|_| true).unwrap();
        }

        fn fail(&self, error: &str, text: &str) -> Option<String> {
            self.fail_later(error, text, NOW)
        }

        fn fail_later(&self, error: &str, text: &str, now: u64) -> Option<String> {
            self.fail_at("s1", error, text, now);
            self.take("s1")
        }

        fn take(&self, session: &str) -> Option<String> {
            let file = self.pings().join(format!("{session}.notice.json"));
            let record = read_json(&file)?;
            fs::remove_file(file).unwrap();

            record["text"].as_str().map(str::to_owned)
        }

        fn stop(&self, session: &str) {
            self.send(Mode::Stop, &json!({"session_id": session}))
                .unwrap();
        }

        fn prompt(&self, session: &str) {
            self.send(
                Mode::Prompt,
                &json!({"session_id": session, "prompt": "go on"}),
            )
            .unwrap();
        }

        fn mark(&self, session: &str) -> Option<Value> {
            read_json(&self.pings().join(format!("{session}.failures")))
        }
    }

    #[test]
    fn names_the_streak_of_each_error_type_by_its_key() {
        let keys = [
            (Kind::UsageLimit, "usage_limit"),
            (Kind::Throttle, "throttle"),
            (Kind::Billing, "billing"),
            (Kind::AccountOnHold, "account_on_hold"),
            (Kind::Authentication, "authentication"),
            (Kind::OauthOrgNotAllowed, "oauth_org_not_allowed"),
            (Kind::InvalidRequest, "invalid_request"),
            (Kind::CloudCredential, "cloud_credential"),
            (Kind::ServerError, "server_error"),
            (Kind::Unknown, "unknown"),
            (Kind::ModelNotFound, "model_not_found"),
            (Kind::MaxOutputTokens, "max_output_tokens"),
        ];

        for (kind, key) in keys {
            assert_eq!(kind.key(), key);
        }
    }

    #[test]
    fn writes_the_portuguese_labels_titles_and_moments() {
        let texts = &messages_for(Locale::PtBr).stop_failure;
        let lines = [
            (
                (texts.title)("🪫 **Cota esgotada**", Some("api")),
                "🪫 **Cota esgotada** · o Claude parou · [api]",
            ),
            (
                (texts.title)("🪫 **Cota esgotada**", None),
                "🪫 **Cota esgotada** · o Claude parou",
            ),
            (texts.reason_label.to_owned(), "Motivo"),
            (texts.back_label.to_owned(), "Volta"),
            (texts.next_label.to_owned(), "Depois"),
            (
                (texts.next_continues_by_itself)(1, "13:05"),
                "continua sozinho à 13:05",
            ),
            (
                (texts.next_continues_by_itself)(2, "14:05"),
                "continua sozinho às 14:05",
            ),
            ((texts.back_today)(1, "01:05"), "à 01:05"),
            ((texts.back_today)(2, "14:05"), "às 14:05"),
            ((texts.clock)(9, 5), "09:05"),
            ((texts.date_clock)(11, 20, 9, 5), "20/11 às 09:05"),
            ((texts.date_clock)(11, 20, 1, 5), "20/11 à 01:05"),
            ((texts.weekday_clock)(4, 9, 5), "sex às 09:05"),
            ((texts.weekday_clock)(4, 1, 5), "sex à 01:05"),
            ((texts.weekday_clock)(9, 9, 5), "9 às 09:05"),
            (
                (texts.failure_released)("api", "y"),
                "Aviso de erro de [api] solto: y",
            ),
            (
                (texts.waiting_released)("api"),
                "Aviso de espera de [api] solto",
            ),
        ];

        for (line, expected) in lines {
            assert_eq!(line, expected);
        }
    }

    #[test]
    fn writes_the_english_labels_titles_and_the_hours_around_midnight_and_noon() {
        let texts = &messages_for(Locale::EnUs).stop_failure;

        assert_eq!(
            (texts.title)("🪫 **Quota used up**", Some("api")),
            "🪫 **Quota used up** · Claude stopped · [api]"
        );
        assert_eq!(
            (texts.title)("🪫 **Quota used up**", None),
            "🪫 **Quota used up** · Claude stopped"
        );
        assert_eq!(texts.reason_label, "Reason");
        assert_eq!(texts.back_label, "Back");
        assert_eq!(texts.next_label, "Next");
        assert_eq!(
            (texts.next_continues_by_itself)(14, "2:05 PM"),
            "continues by itself at 2:05 PM"
        );
        assert_eq!((texts.back_today)(14, "2:05 PM"), "at 2:05 PM");
        assert_eq!((texts.clock)(0, 5), "12:05 AM");
        assert_eq!((texts.clock)(12, 5), "12:05 PM");
        assert_eq!((texts.clock)(23, 59), "11:59 PM");
        assert_eq!((texts.date_clock)(11, 20, 9, 5), "Nov 20, 9:05 AM");
        assert_eq!((texts.date_clock)(13, 20, 9, 5), "13 20, 9:05 AM");
        assert_eq!((texts.weekday_clock)(4, 9, 5), "Fri 9:05 AM");
        assert_eq!((texts.weekday_clock)(9, 9, 5), "9 9:05 AM");
    }

    fn render(
        texts: &StopFailureTexts,
        kind: Kind,
        instance: Option<&str>,
        detail: Option<&str>,
    ) -> String {
        let handling = kind.handling(texts).unwrap();
        let outlook = Outlook {
            back: None,
            next: handling.copy.next.to_owned(),
        };

        notice_text(texts, &handling, instance, detail, &outlook)
    }

    #[test]
    fn handles_only_the_kinds_that_notify() {
        for locale in [Locale::PtBr, Locale::EnUs] {
            let texts = &messages_for(locale).stop_failure;
            let policies = [
                (Kind::UsageLimit, Some(Policy::Always)),
                (Kind::Throttle, Some(Policy::Guarded)),
                (Kind::Billing, Some(Policy::Always)),
                (Kind::AccountOnHold, Some(Policy::Always)),
                (Kind::Authentication, Some(Policy::Always)),
                (Kind::OauthOrgNotAllowed, Some(Policy::Always)),
                (Kind::InvalidRequest, Some(Policy::Always)),
                (Kind::CloudCredential, Some(Policy::Always)),
                (Kind::ServerError, Some(Policy::Guarded)),
                (Kind::Unknown, Some(Policy::Guarded)),
                (Kind::ModelNotFound, None),
                (Kind::MaxOutputTokens, None),
            ];

            for (kind, policy) in policies {
                assert_eq!(
                    kind.handling(texts).map(|handling| handling.policy),
                    policy,
                    "{kind:?}"
                );
            }
        }
    }

    #[test]
    fn shows_the_detail_only_for_an_invalid_request_and_an_unexpected_error() {
        let texts = &messages_for(Locale::EnUs).stop_failure;
        let shown = [Kind::InvalidRequest, Kind::Unknown];
        let hidden = [
            Kind::UsageLimit,
            Kind::Throttle,
            Kind::Billing,
            Kind::AccountOnHold,
            Kind::Authentication,
            Kind::OauthOrgNotAllowed,
            Kind::CloudCredential,
            Kind::ServerError,
        ];

        for kind in shown {
            assert!(render(texts, kind, None, Some("d")).contains("\n> `d`\n"));
        }

        for kind in hidden {
            assert!(!render(texts, kind, None, Some("d")).contains("`d`"));
        }
    }

    #[test]
    fn writes_the_full_card_of_each_kind_in_portuguese() {
        let texts = &messages_for(Locale::PtBr).stop_failure;
        let cards = [
            (
                Kind::Throttle,
                None,
                "🐢 **API lenta** · o Claude parou · [p]\n> 📋 **Motivo:** a API está limitando as requisições (não é o limite de uso do seu plano)\n> 👉 **Depois:** tente de novo no terminal",
            ),
            (
                Kind::ServerError,
                None,
                "🌩️ **API instável** · o Claude parou · [p]\n> 📋 **Motivo:** a API continua falhando (erro de servidor)\n> 👉 **Depois:** tente de novo no terminal",
            ),
            (
                Kind::Billing,
                None,
                "💲 **Cobrança** · o Claude parou · [p]\n> 📋 **Motivo:** há um problema de cobrança na sua conta\n> 👉 **Depois:** confira a cobrança do seu plano e retome no terminal",
            ),
            (
                Kind::AccountOnHold,
                None,
                "🚫 **Conta suspensa** · o Claude parou · [p]\n> 📋 **Motivo:** sua conta está suspensa\n> 👉 **Depois:** confira a situação da conta e retome no terminal",
            ),
            (
                Kind::CloudCredential,
                None,
                "🔧 **Credenciais da nuvem** · o Claude parou · [p]\n> 📋 **Motivo:** não foi possível carregar as credenciais do provedor de nuvem\n> 👉 **Depois:** confira as credenciais da nuvem e retome no terminal",
            ),
            (
                Kind::Authentication,
                None,
                "🔑 **Login** · o Claude parou · [p]\n> 📋 **Motivo:** a autenticação falhou\n> 👉 **Depois:** entre de novo no terminal",
            ),
            (
                Kind::OauthOrgNotAllowed,
                None,
                "🏢 **Organização sem acesso** · o Claude parou · [p]\n> 📋 **Motivo:** sua organização não pode usar este login\n> 👉 **Depois:** entre com outra conta no terminal",
            ),
            (
                Kind::InvalidRequest,
                Some("too long"),
                "⛔ **Requisição recusada** · o Claude parou · [p]\n> 📋 **Motivo:** a API recusou a requisição\n> `too long`\n> 👉 **Depois:** revise o pedido e tente de novo no terminal",
            ),
            (
                Kind::Unknown,
                Some("odd"),
                "💥 **Erro inesperado** · o Claude parou · [p]\n> 📋 **Motivo:** erro inesperado da API\n> `odd`\n> 👉 **Depois:** tente de novo no terminal",
            ),
        ];

        for (kind, detail, expected) in cards {
            assert_eq!(render(texts, kind, Some("p"), detail), expected, "{kind:?}");
        }
    }

    #[test]
    fn writes_the_full_card_of_each_kind_in_english() {
        let texts = &messages_for(Locale::EnUs).stop_failure;
        let cards = [
            (
                Kind::Throttle,
                None,
                "🐢 **API slowed down** · Claude stopped\n> 📋 **Reason:** the API is limiting requests (not your plan's usage limit)\n> 👉 **Next:** try again in the terminal",
            ),
            (
                Kind::ServerError,
                None,
                "🌩️ **API unstable** · Claude stopped\n> 📋 **Reason:** the API keeps failing (server error)\n> 👉 **Next:** try again in the terminal",
            ),
            (
                Kind::Billing,
                None,
                "💲 **Billing** · Claude stopped\n> 📋 **Reason:** there is a billing problem with your account\n> 👉 **Next:** check the billing of your plan, then resume in the terminal",
            ),
            (
                Kind::AccountOnHold,
                None,
                "🚫 **Account on hold** · Claude stopped\n> 📋 **Reason:** your account is on hold\n> 👉 **Next:** check the status of your account, then resume in the terminal",
            ),
            (
                Kind::CloudCredential,
                None,
                "🔧 **Cloud credentials** · Claude stopped\n> 📋 **Reason:** the cloud provider credentials could not be loaded\n> 👉 **Next:** check the cloud provider credentials, then resume in the terminal",
            ),
            (
                Kind::Authentication,
                None,
                "🔑 **Login** · Claude stopped\n> 📋 **Reason:** authentication failed\n> 👉 **Next:** log in again in the terminal",
            ),
            (
                Kind::OauthOrgNotAllowed,
                None,
                "🏢 **Organization without access** · Claude stopped\n> 📋 **Reason:** your organization is not allowed to use this login\n> 👉 **Next:** log in with another account in the terminal",
            ),
            (
                Kind::InvalidRequest,
                Some("too long"),
                "⛔ **Request rejected** · Claude stopped\n> 📋 **Reason:** the API rejected the request\n> `too long`\n> 👉 **Next:** review the request and try again in the terminal",
            ),
            (
                Kind::Unknown,
                Some("odd"),
                "💥 **Unexpected error** · Claude stopped\n> 📋 **Reason:** unexpected API error\n> `odd`\n> 👉 **Next:** try again in the terminal",
            ),
        ];

        for (kind, detail, expected) in cards {
            assert_eq!(render(texts, kind, None, detail), expected, "{kind:?}");
        }
    }

    #[test]
    fn writes_the_full_usage_limit_card_in_both_languages() {
        let pt = &messages_for(Locale::PtBr).stop_failure;
        let en = &messages_for(Locale::EnUs).stop_failure;
        let outlook = |back: &str, next: &str| Outlook {
            back: Some(back.to_owned()),
            next: next.to_owned(),
        };

        assert_eq!(
            notice_text(
                pt,
                &Kind::UsageLimit.handling(pt).unwrap(),
                Some("tmp#bcct"),
                Some("ignored"),
                &outlook("25/11 às 10:00 (America/Sao_Paulo)", pt.usage_limit.next)
            ),
            "🪫 **Cota esgotada** · o Claude parou · [tmp#bcct]\n> 📋 **Motivo:** o limite de uso do seu plano foi atingido\n> 🕙 **Volta:** 25/11 às 10:00 (America/Sao_Paulo)\n> 👉 **Depois:** não continua sozinho, retome no terminal"
        );
        assert_eq!(
            notice_text(
                en,
                &Kind::UsageLimit.handling(en).unwrap(),
                None,
                None,
                &outlook("Nov 25, 10:00 AM", en.usage_limit.next)
            ),
            "🪫 **Quota used up** · Claude stopped\n> 📋 **Reason:** the usage limit of your plan was reached\n> 🕙 **Back:** Nov 25, 10:00 AM\n> 👉 **Next:** does not continue by itself; resume it in the terminal"
        );
    }

    #[test]
    fn escapes_the_markup_of_the_instance_label_in_the_card_title() {
        for locale in [Locale::PtBr, Locale::EnUs] {
            let texts = &messages_for(locale).stop_failure;
            let card = render(
                texts,
                Kind::Billing,
                Some("fix `parser` \\ **draft**"),
                None,
            );
            let title = card.lines().next().unwrap();

            assert!(
                title.ends_with("[fix \\`parser\\` \\\\ \\*\\*draft\\*\\*]"),
                "{locale:?}: {title}"
            );
        }
    }

    #[test]
    fn sends_the_card_of_each_error_that_always_notifies() {
        for (error, head, reason, next) in [
            (
                "billing_error",
                BILLING,
                "there is a billing problem with your account",
                "check the billing of your plan, then resume in the terminal",
            ),
            (
                "account_on_hold",
                ON_HOLD,
                "your account is on hold",
                "check the status of your account, then resume in the terminal",
            ),
            (
                "authentication_failed",
                LOGIN,
                "authentication failed",
                "log in again in the terminal",
            ),
            (
                "oauth_org_not_allowed",
                ORGANIZATION,
                "your organization is not allowed to use this login",
                "log in with another account in the terminal",
            ),
            (
                "cloud_credential_error",
                CLOUD,
                "the cloud provider credentials could not be loaded",
                "check the cloud provider credentials, then resume in the terminal",
            ),
            (
                "invalid_request",
                INVALID,
                "the API rejected the request",
                "review the request and try again in the terminal",
            ),
        ] {
            let world = World::new();
            let detail = if error == "invalid_request" {
                "`prompt too long`"
            } else {
                ""
            };
            let reason = format!("Reason: {reason}");
            let next = format!("Next: {next}");
            let mut lines = vec![reason.as_str()];
            lines.extend(Some(detail).filter(|line| !line.is_empty()));
            lines.push(&next);
            let expected = card(head, &lines);

            for round in ["first", "second"] {
                assert_eq!(
                    world.fail(error, "prompt too long").as_deref(),
                    Some(expected.as_str()),
                    "{error} {round}"
                );
            }
        }
    }

    #[test]
    fn sends_the_portuguese_card_of_each_error_that_always_notifies() {
        for (error, head, reason, next) in [
            (
                "billing_error",
                BILLING_PT,
                "há um problema de cobrança na sua conta",
                "confira a cobrança do seu plano e retome no terminal",
            ),
            (
                "account_on_hold",
                ON_HOLD_PT,
                "sua conta está suspensa",
                "confira a situação da conta e retome no terminal",
            ),
            (
                "authentication_failed",
                LOGIN_PT,
                "a autenticação falhou",
                "entre de novo no terminal",
            ),
            (
                "oauth_org_not_allowed",
                ORGANIZATION_PT,
                "sua organização não pode usar este login",
                "entre com outra conta no terminal",
            ),
            (
                "cloud_credential_error",
                CLOUD_PT,
                "não foi possível carregar as credenciais do provedor de nuvem",
                "confira as credenciais da nuvem e retome no terminal",
            ),
            (
                "invalid_request",
                INVALID_PT,
                "a API recusou a requisição",
                "revise o pedido e tente de novo no terminal",
            ),
        ] {
            let detail = if error == "invalid_request" {
                "`prompt too long`"
            } else {
                ""
            };
            let reason = format!("Motivo: {reason}");
            let next = format!("Depois: {next}");
            let mut lines = vec![reason.as_str()];
            lines.extend(Some(detail).filter(|line| !line.is_empty()));
            lines.push(&next);
            let expected = card(head, &lines);

            assert_eq!(
                World::portuguese()
                    .fail(error, "prompt too long")
                    .as_deref(),
                Some(expected.as_str()),
                "{error}"
            );
        }
    }

    #[test]
    fn stays_quiet_for_model_not_found_and_max_output_tokens() {
        let world = World::new();

        for error in ["model_not_found", "max_output_tokens"] {
            for _ in 0..4 {
                assert_eq!(world.fail(error, "API Error: x"), None, "{error}");
            }
        }

        assert!(!world.pings().exists());
    }

    #[test]
    fn holds_the_first_failure_of_a_guarded_error_and_sends_the_second() {
        let world = World::new();

        assert_eq!(world.fail("server_error", "API Error: 529"), None);
        assert_eq!(
            world.fail("server_error", "API Error: 529").as_deref(),
            Some(
                card(
                    SERVER,
                    &[
                        "Reason: the API keeps failing (server error)",
                        "Next: try again in the terminal"
                    ]
                )
                .as_str()
            )
        );
    }

    #[test]
    fn sends_the_portuguese_card_of_a_server_error() {
        let world = World::portuguese();

        world.fail("server_error", "API Error: 529");

        assert_eq!(
            world.fail("server_error", "API Error: 529").as_deref(),
            Some(
                card(
                    SERVER_PT,
                    &[
                        "Motivo: a API continua falhando (erro de servidor)",
                        "Depois: tente de novo no terminal"
                    ]
                )
                .as_str()
            )
        );
    }

    #[test]
    fn repeats_a_guarded_notice_every_interval_until_recovery() {
        let world = World::new();
        let text = "API Error: 529";
        let second = NOW + 1_000;

        assert_eq!(world.fail_later("server_error", text, NOW), None);
        assert!(world.fail_later("server_error", text, second).is_some());
        assert_eq!(world.fail_later("server_error", text, second + 1_000), None);
        assert_eq!(
            world.fail_later("server_error", text, second + REPEAT_INTERVAL_MS - 1),
            None
        );
        assert!(
            world
                .fail_later("server_error", text, second + REPEAT_INTERVAL_MS)
                .is_some()
        );
        assert_eq!(
            world.fail_later("server_error", text, second + REPEAT_INTERVAL_MS + 1),
            None
        );
        assert!(
            world
                .fail_later("server_error", text, second + 2 * REPEAT_INTERVAL_MS)
                .is_some()
        );
    }

    #[test]
    fn restarts_the_streak_after_a_stop() {
        let world = World::new();

        world.fail("server_error", "API Error: 529");
        world.stop("s1");

        assert_eq!(world.fail("server_error", "API Error: 529"), None);
        assert!(world.fail("server_error", "API Error: 529").is_some());
    }

    #[test]
    fn restarts_the_streak_after_a_prompt() {
        let world = World::new();

        world.fail("unknown", "weird");
        world.prompt("s1");

        assert_eq!(world.mark("s1"), None);
        assert_eq!(world.fail("unknown", "weird"), None);
        assert!(world.fail("unknown", "weird").is_some());
    }

    #[test]
    fn drops_the_held_notice_of_the_session_at_the_prompt() {
        let world = World::new();

        world.fail_at("s1", "billing_error", "x", NOW);
        world.fail_at("s2", "billing_error", "x", NOW);
        world.prompt("s1");

        assert!(!world.pings().join("s1.notice.json").exists());
        assert!(world.pings().join("s2.notice.json").exists());
    }

    #[test]
    fn keeps_the_held_notice_at_a_prompt_that_was_not_typed() {
        let world = World::new();

        world.fail_at("s1", "billing_error", "x", NOW);
        world
            .send(
                Mode::Prompt,
                &json!({"session_id": "s1", "prompt": "<channel source=\"plugin:telegram:telegram\">hi"}),
            )
            .unwrap();

        assert!(world.pings().join("s1.notice.json").exists());
    }

    #[test]
    fn drops_the_notice_and_the_mark_together_at_the_prompt() {
        let world = World::new();

        world.fail_at("s1", "server_error", "x", NOW);
        world.fail_at("s1", "server_error", "x", NOW);

        assert!(world.pings().join("s1.notice.json").exists());

        world.prompt("s1");

        assert!(!world.pings().join("s1.notice.json").exists());
        assert_eq!(world.mark("s1"), None);
    }

    #[test]
    fn fails_when_the_notice_cannot_be_removed_at_the_prompt() {
        let world = World::new();
        world.write("app/pings/s1.notice.json/inner", "x");
        let input = json!({"session_id": "s1", "prompt": "go"});

        assert!(matches!(
            world.send(Mode::Prompt, &input),
            Err(Abort::Io { .. })
        ));
    }

    #[test]
    fn counts_each_error_type_and_session_apart() {
        let world = World::new();

        assert_eq!(world.fail("server_error", "x"), None);
        assert_eq!(world.fail("unknown", "x"), None);

        world.fail_at("s2", "server_error", "x", NOW);

        assert_eq!(world.take("s2"), None);
        assert!(world.fail("server_error", "x").is_some());
        assert!(world.fail("unknown", "x").is_some());
    }

    #[test]
    fn treats_a_throttle_like_a_guarded_error() {
        let world = World::new();
        let text =
            "API Error: Request rejected (429) · this is a server-side limit, not your usage limit";

        assert_eq!(world.fail("rate_limit", text), None);
        assert_eq!(
            world.fail("rate_limit", text).as_deref(),
            Some(
                card(
                    THROTTLE,
                    &[
                        "Reason: the API is limiting requests (not your plan's usage limit)",
                        "Next: try again in the terminal"
                    ]
                )
                .as_str()
            )
        );
        assert_eq!(world.mark("s1").unwrap()["limitHits"], json!(0));
    }

    #[test]
    fn adds_the_first_line_of_the_text_for_invalid_request_and_unknown() {
        let world = World::new();

        assert_eq!(
            world
                .fail("invalid_request", "\n  First line  \nsecond line")
                .as_deref(),
            Some(
                card(
                    INVALID,
                    &[
                        "Reason: the API rejected the request",
                        "`First line`",
                        "Next: review the request and try again in the terminal"
                    ]
                )
                .as_str()
            )
        );

        world.fail("unknown", "Odd failure\nmore");

        assert_eq!(
            world.fail("unknown", "Odd failure\nmore").as_deref(),
            Some(
                card(
                    UNEXPECTED,
                    &[
                        "Reason: unexpected API error",
                        "`Odd failure`",
                        "Next: try again in the terminal"
                    ]
                )
                .as_str()
            )
        );
    }

    #[test]
    fn cuts_a_long_first_line() {
        let world = World::new();
        let long = "x".repeat(DETAIL_MAX_CHARS + 50);

        assert_eq!(
            world.fail("invalid_request", &long),
            Some(card(
                INVALID,
                &[
                    "Reason: the API rejected the request",
                    &format!("`{}`", "x".repeat(DETAIL_MAX_CHARS)),
                    "Next: review the request and try again in the terminal"
                ]
            ))
        );
    }

    #[test]
    fn keeps_the_markup_of_the_detail_raw_inside_the_code_span() {
        let world = World::new();

        assert_eq!(
            world.fail("invalid_request", r"bad **field** in C:\tmp \_ <b>"),
            Some(card(
                INVALID,
                &[
                    "Reason: the API rejected the request",
                    r"`bad **field** in C:\tmp \_ <b>`",
                    "Next: review the request and try again in the terminal"
                ]
            ))
        );
    }

    #[test]
    fn escapes_the_detail_as_plain_text_when_it_holds_a_backtick() {
        for (text, escaped) in [
            (
                r"bad **field** `x` in C:\tmp \_",
                r"bad \*\*field\*\* \`x\` in C:\\tmp \\_",
            ),
            ("`", r"\`"),
        ] {
            assert_eq!(
                World::new().fail("invalid_request", text),
                Some(card(
                    INVALID,
                    &[
                        "Reason: the API rejected the request",
                        escaped,
                        "Next: review the request and try again in the terminal"
                    ]
                )),
                "{text}"
            );
            assert_eq!(
                World::portuguese().fail("invalid_request", text),
                Some(card(
                    INVALID_PT,
                    &[
                        "Motivo: a API recusou a requisição",
                        escaped,
                        "Depois: revise o pedido e tente de novo no terminal"
                    ]
                )),
                "{text}"
            );
        }
    }

    #[test]
    fn falls_back_to_the_details_and_then_omits_the_detail() {
        let world = World::new();
        let input = json!({
            "session_id": "s1",
            "error": "invalid_request",
            "error_details": "400 bad things",
        });

        world.send(Mode::StopFailure, &input).unwrap();

        assert_eq!(
            world.take("s1").as_deref(),
            Some(
                card(
                    INVALID,
                    &[
                        "Reason: the API rejected the request",
                        "`400 bad things`",
                        "Next: review the request and try again in the terminal"
                    ]
                )
                .as_str()
            )
        );
        assert_eq!(
            world.fail("invalid_request", "").as_deref(),
            Some(
                card(
                    INVALID,
                    &[
                        "Reason: the API rejected the request",
                        "Next: review the request and try again in the terminal"
                    ]
                )
                .as_str()
            )
        );

        world.fail("unknown", "  \n ");

        assert_eq!(
            world.fail("unknown", "  \n ").as_deref(),
            Some(
                card(
                    UNEXPECTED,
                    &[
                        "Reason: unexpected API error",
                        "Next: try again in the terminal"
                    ]
                )
                .as_str()
            )
        );
    }

    #[test]
    fn writes_the_portuguese_reason_of_an_error_with_and_without_detail() {
        let world = World::portuguese();

        world.fail("brand_new_error", "Odd");

        assert_eq!(
            world.fail("brand_new_error", "Odd").as_deref(),
            Some(
                card(
                    UNEXPECTED_PT,
                    &[
                        "Motivo: erro inesperado da API",
                        "`Odd`",
                        "Depois: tente de novo no terminal"
                    ]
                )
                .as_str()
            )
        );

        let blank = World::portuguese();

        blank.fail("brand_new_error", "");

        assert_eq!(
            blank.fail("brand_new_error", "").as_deref(),
            Some(
                card(
                    UNEXPECTED_PT,
                    &[
                        "Motivo: erro inesperado da API",
                        "Depois: tente de novo no terminal"
                    ]
                )
                .as_str()
            )
        );
        assert_eq!(
            World::portuguese().fail("invalid_request", "").as_deref(),
            Some(
                card(
                    INVALID_PT,
                    &[
                        "Motivo: a API recusou a requisição",
                        "Depois: revise o pedido e tente de novo no terminal"
                    ]
                )
                .as_str()
            )
        );
    }

    #[test]
    fn treats_an_unlisted_or_missing_error_as_unknown() {
        let world = World::new();

        world.fail("brand_new_error", "Odd");

        let expected = card(
            UNEXPECTED,
            &[
                "Reason: unexpected API error",
                "`Odd`",
                "Next: try again in the terminal",
            ],
        );

        assert_eq!(
            world.fail("brand_new_error", "Odd").as_deref(),
            Some(expected.as_str())
        );

        let input = json!({"session_id": "s2", "last_assistant_message": "Odd"});

        world.send(Mode::StopFailure, &input).unwrap();
        assert_eq!(world.take("s2"), None);

        world.send(Mode::StopFailure, &input).unwrap();
        assert_eq!(world.take("s2").as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn says_the_usage_limit_continues_by_itself_with_the_time() {
        let world = World::new();

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT),
            Some(usage_card(Some(BACK_TODAY), CONTINUES))
        );
    }

    #[test]
    fn shows_the_time_in_24_hours_in_pt_br() {
        let world = World::portuguese();

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT),
            Some(usage_card_pt(
                Some("Volta: às 14:20 (America/Sao_Paulo)"),
                "Depois: continua sozinho às 14:20"
            ))
        );

        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT),
            Some(usage_card_pt(
                Some("Volta: às 14:20 (America/Sao_Paulo)"),
                WILL_NOT_PT
            ))
        );
    }

    #[test]
    fn says_it_will_not_continue_when_the_setting_is_false() {
        let world = World::new();
        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT),
            Some(usage_card(Some(BACK_TODAY), WILL_NOT))
        );
    }

    #[test]
    fn continues_when_the_setting_is_true_missing_or_not_a_boolean() {
        for settings in [
            Some(r#"{"autoContinueAtUsageLimit":true}"#),
            Some("{}"),
            Some(r#"{"autoContinueAtUsageLimit":"false"}"#),
            Some(r#"{"autoContinueAtUsageLimit":0}"#),
            Some("{broken"),
            None,
        ] {
            let world = World::new();

            if let Some(text) = settings {
                world.user_setting(text);
            }

            assert!(
                world
                    .fail("rate_limit", SESSION_LIMIT)
                    .unwrap()
                    .ends_with(&field(CONTINUES)),
                "{settings:?}"
            );
        }
    }

    #[test]
    fn lets_the_managed_settings_win_over_the_user_ones() {
        let world = World::new();
        world.user_setting(r#"{"autoContinueAtUsageLimit":true}"#);
        world.write(
            "managed/managed-settings.json",
            r#"{"autoContinueAtUsageLimit":false}"#,
        );

        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(&field(WILL_NOT))
        );

        world.write(
            "managed/managed-settings.json",
            r#"{"autoContinueAtUsageLimit":true}"#,
        );
        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);
        world.prompt("s1");

        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(&field(CONTINUES))
        );
    }

    #[test]
    fn reads_the_managed_drop_ins_after_the_file_in_name_order() {
        let world = World::new();
        let on = r#"{"autoContinueAtUsageLimit":true}"#;
        let off = r#"{"autoContinueAtUsageLimit":false}"#;
        world.write("managed/managed-settings.json", on);
        world.write("managed/managed-settings.d/20-b.json", on);
        world.write("managed/managed-settings.d/10-a.json", off);
        world.write("managed/managed-settings.d/.hidden.json", off);
        world.write("managed/managed-settings.d/30-c.txt", off);

        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(&field(CONTINUES))
        );

        world.write("managed/managed-settings.d/25-d.json", off);
        world.prompt("s1");

        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(&field(WILL_NOT))
        );
    }

    #[test]
    fn stops_promising_after_the_three_automatic_continues_since_the_prompt() {
        let world = World::new();

        for hit in 1..=3 {
            assert!(
                world
                    .fail("rate_limit", SESSION_LIMIT)
                    .unwrap()
                    .ends_with(&field(CONTINUES)),
                "hit {hit}"
            );
        }

        for hit in 4..=5 {
            assert!(
                world
                    .fail("rate_limit", SESSION_LIMIT)
                    .unwrap()
                    .ends_with(&format!("{}\n{}", field(BACK_TODAY), field(WILL_NOT))),
                "hit {hit}"
            );
        }
    }

    #[test]
    fn stops_promising_after_three_continues_even_with_their_prompts_between_hits() {
        for continuation in AUTOMATIC_CONTINUE_PROMPTS {
            let world = World::new();
            let continue_task = || {
                world
                    .send(
                        Mode::Prompt,
                        &json!({"session_id": "s1", "prompt": format!("{continuation}\n")}),
                    )
                    .unwrap();
            };

            for hit in 1..=3 {
                assert!(
                    world
                        .fail("rate_limit", SESSION_LIMIT)
                        .unwrap()
                        .ends_with(&field(CONTINUES)),
                    "hit {hit}"
                );
                continue_task();
                assert_eq!(world.mark("s1").unwrap()["limitHits"], json!(hit));
            }

            for hit in 4..=5 {
                assert!(
                    world
                        .fail("rate_limit", SESSION_LIMIT)
                        .unwrap()
                        .ends_with(&format!("{}\n{}", field(BACK_TODAY), field(WILL_NOT))),
                    "hit {hit}"
                );
                continue_task();
            }
        }
    }

    #[test]
    fn keeps_the_hits_through_a_stop_and_clears_them_at_the_prompt() {
        let world = World::new();

        world.fail("rate_limit", SESSION_LIMIT);
        world.fail("rate_limit", SESSION_LIMIT);
        world.fail("rate_limit", SESSION_LIMIT);
        world.stop("s1");

        assert_eq!(world.mark("s1").unwrap()["limitHits"], json!(3));
        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(&field(WILL_NOT))
        );

        world.prompt("s1");

        assert_eq!(world.mark("s1"), None);
        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(&field(CONTINUES))
        );
    }

    #[test]
    fn removes_the_mark_when_a_stop_leaves_nothing_in_it() {
        let world = World::new();

        world.fail("server_error", "x");

        assert!(world.mark("s1").is_some());

        world.stop("s1");

        assert_eq!(world.mark("s1"), None);
    }

    #[test]
    fn gives_no_time_and_no_promise_without_a_readable_reset() {
        for text in [
            "API Error: Rate limit reached",
            "",
            "You've hit your limit · resets soon",
            "You've hit your limit · resets 25:99pm",
            "You've hit your limit · resets 2:60pm",
            "You've hit your limit · resets 13pm",
        ] {
            assert_eq!(
                World::new().fail("rate_limit", text),
                Some(usage_card(None, WILL_NOT)),
                "{text:?}"
            );
            assert_eq!(
                World::portuguese().fail("rate_limit", text),
                Some(usage_card_pt(None, WILL_NOT_PT)),
                "{text:?}"
            );
        }
    }

    #[test]
    fn shows_the_date_and_the_zone_of_a_dated_reset_without_a_promise() {
        let text = "You've hit your weekly limit · resets Nov 24, 9am (America/Sao_Paulo)";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(usage_card(
                Some("Back: Nov 24, 9:00 AM (America/Sao_Paulo)"),
                WILL_NOT
            ))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", text),
            Some(usage_card_pt(
                Some("Volta: 24/11 às 09:00 (America/Sao_Paulo)"),
                WILL_NOT_PT
            ))
        );
    }

    #[test]
    fn shows_a_dated_reset_without_a_zone_when_the_text_has_none() {
        let text = "You've hit your weekly limit · resets Nov 24, 9am";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(usage_card(Some("Back: Nov 24, 9:00 AM"), WILL_NOT))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", text),
            Some(usage_card_pt(Some("Volta: 24/11 às 09:00"), WILL_NOT_PT))
        );
    }

    #[test]
    fn shows_a_near_dated_reset_with_its_date() {
        for day in [18, 19, 20] {
            let text = format!("You've hit your weekly limit · resets Nov {day}, 9am (UTC)");

            assert_eq!(
                World::new().fail("rate_limit", &text),
                Some(usage_card(
                    Some(&format!("Back: Nov {day}, 9:00 AM (UTC)")),
                    WILL_NOT
                )),
                "{day}"
            );
        }
    }

    #[test]
    fn shows_the_weekday_of_a_weekday_reset_without_a_promise() {
        let with_zone = "You've hit your weekly limit · resets Mon 9am (America/Sao_Paulo)";
        let without_zone = "You've hit your weekly limit · resets Sun 9:30pm";

        assert_eq!(
            World::new().fail("rate_limit", with_zone),
            Some(usage_card(
                Some("Back: Mon 9:00 AM (America/Sao_Paulo)"),
                WILL_NOT
            ))
        );
        assert_eq!(
            World::new().fail("rate_limit", without_zone),
            Some(usage_card(Some("Back: Sun 9:30 PM"), WILL_NOT))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", with_zone),
            Some(usage_card_pt(
                Some("Volta: seg às 09:00 (America/Sao_Paulo)"),
                WILL_NOT_PT
            ))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", without_zone),
            Some(usage_card_pt(Some("Volta: dom às 21:30"), WILL_NOT_PT))
        );
    }

    #[test]
    fn shows_the_time_of_a_same_day_reset_without_a_zone_when_the_text_has_none() {
        let text = "You've hit your session limit · resets 2:20pm";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(usage_card(Some("Back: at 2:20 PM"), CONTINUES))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", text),
            Some(usage_card_pt(
                Some("Volta: às 14:20"),
                "Depois: continua sozinho às 14:20"
            ))
        );

        let world = World::new();
        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", text),
            Some(usage_card(Some("Back: at 2:20 PM"), WILL_NOT))
        );
    }

    #[test]
    fn shows_the_time_of_an_opus_or_sonnet_limit_without_a_promise() {
        for (text, back) in [
            (
                "You've hit your Opus limit · resets 3pm",
                "Back: at 3:00 PM",
            ),
            (
                "You've hit your Sonnet limit · resets 3pm (America/Sao_Paulo)",
                "Back: at 3:00 PM (America/Sao_Paulo)",
            ),
        ] {
            assert_eq!(
                World::new().fail("rate_limit", text),
                Some(usage_card(Some(back), WILL_NOT)),
                "{text}"
            );
        }
    }

    #[test]
    fn says_the_hour_one_with_a_single_article_in_pt_br() {
        let text = "You've hit your session limit · resets 1:00am (America/Sao_Paulo)";
        let world = World::portuguese();

        assert_eq!(
            world.fail("rate_limit", text),
            Some(usage_card_pt(
                Some("Volta: à 01:00 (America/Sao_Paulo)"),
                "Depois: continua sozinho à 01:00"
            ))
        );

        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", text),
            Some(usage_card_pt(
                Some("Volta: à 01:00 (America/Sao_Paulo)"),
                WILL_NOT_PT
            ))
        );
        assert_eq!(
            world
                .fail("rate_limit", "resets 1:45pm")
                .as_deref()
                .map(|line| line.contains("**Volta:** às 13:45")),
            Some(true)
        );
        assert_eq!(
            world
                .fail("rate_limit", "resets 12:00am")
                .as_deref()
                .map(|line| line.contains("**Volta:** às 00:00")),
            Some(true)
        );
        assert_eq!(
            world
                .fail("rate_limit", "resets 2am")
                .as_deref()
                .map(|line| line.contains("**Volta:** às 02:00")),
            Some(true)
        );
    }

    #[test]
    fn keeps_the_english_text_the_same_for_the_hour_one() {
        let text = "You've hit your session limit · resets 1:00am (UTC)";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(usage_card(
                Some("Back: at 1:00 AM (UTC)"),
                "Next: continues by itself at 1:00 AM"
            ))
        );
    }

    #[test]
    fn reads_the_reset_from_the_details_when_the_message_has_none() {
        let world = World::new();
        let input = json!({
            "session_id": "s1",
            "error": "rate_limit",
            "last_assistant_message": "API Error: Rate limit reached",
            "error_details": "resets 3:45pm",
        });

        world.send(Mode::StopFailure, &input).unwrap();

        assert!(
            world
                .take("s1")
                .unwrap()
                .ends_with("> 👉 **Next:** continues by itself at 3:45 PM")
        );
    }

    #[test]
    fn writes_the_notice_due_right_away_for_the_sender() {
        let world = World::new();
        let input = json!({
            "session_id": "abc/def",
            "error": "billing_error",
            "last_assistant_message": "x",
        });

        world.send(Mode::StopFailure, &input).unwrap();

        let record = read_json(&world.pings().join("abc_def.notice.json")).unwrap();

        assert_eq!(record["sessionId"], json!("abc/def"));
        assert_eq!(record["createdAt"].as_f64(), Some(1_795_003_200_000.0));
        assert_eq!(record["dueAt"], record["createdAt"]);
        assert_eq!(record["instance"], Value::Null);
        assert_eq!(record["kind"], json!("failure"));
        assert_eq!(
            record["text"],
            json!(card(
                BILLING,
                &[
                    "Reason: there is a billing problem with your account",
                    "Next: check the billing of your plan, then resume in the terminal"
                ]
            ))
        );
    }

    #[test]
    fn labels_the_instance_outside_a_telegram_session() {
        let world = World::with(&[("BETTER_CC_TELEGRAM", "")]);
        fs::create_dir_all(&world.ctx.state_dir).unwrap();
        fs::write(
            world.ctx.state_dir.join("bot.pid"),
            std::process::id().to_string(),
        )
        .unwrap();
        let input = json!({
            "session_id": "abcdef",
            "cwd": "/x/proj",
            "error": "account_on_hold",
        });

        world.send(Mode::StopFailure, &input).unwrap();

        let record = read_json(&world.pings().join("abcdef.notice.json")).unwrap();

        assert_eq!(record["instance"], json!("proj#abcd"));
        assert_eq!(
            record["text"],
            json!(card(
                "🚫 **Account on hold** · Claude stopped · [proj#abcd]",
                &[
                    "Reason: your account is on hold",
                    "Next: check the status of your account, then resume in the terminal"
                ]
            ))
        );
    }

    #[test]
    fn writes_nothing_when_the_instance_is_not_on_telegram() {
        let world = World::with(&[("BETTER_CC_TELEGRAM", "")]);
        let input = json!({"session_id": "s1", "error": "billing_error"});

        handle_event(Mode::StopFailure, &input, &world.ctx, NOW, &|_| false).unwrap();

        assert!(!world.ctx.app_dir.exists());
    }

    #[test]
    fn uses_the_default_session_name_without_a_session_id() {
        let world = World::new();

        world
            .send(Mode::StopFailure, &json!({"error": "billing_error"}))
            .unwrap();

        assert_eq!(
            read_json(&world.pings().join("session.notice.json")).unwrap()["sessionId"],
            json!("session")
        );
    }

    #[test]
    fn fails_when_the_pings_folder_cannot_be_created() {
        let world = World::new();
        world.write("app/pings", "in the way");
        let input = json!({"session_id": "s1", "error": "billing_error"});

        assert!(matches!(
            world.send(Mode::StopFailure, &input),
            Err(Abort::Io { .. })
        ));
    }

    #[test]
    fn fails_without_counting_when_the_notice_cannot_be_written() {
        let world = World::new();
        world.fail("server_error", "x");
        fs::create_dir(world.pings().join("s1.notice.json")).unwrap();
        let input = json!({"session_id": "s1", "error": "server_error"});

        assert!(matches!(
            world.send(Mode::StopFailure, &input),
            Err(Abort::Io { .. })
        ));
        assert_eq!(
            world.mark("s1").unwrap()["errors"]["server_error"]["count"],
            json!(1)
        );
    }

    #[test]
    fn reads_a_broken_or_odd_mark_as_empty() {
        for text in [
            "{broken",
            "[1]",
            "null",
            r#"{"errors":{"server_error":{"count":"x"}}}"#,
        ] {
            let world = World::new();
            world.write("app/pings/s1.failures", text);

            assert_eq!(world.fail("server_error", "x"), None, "{text}");
            assert!(world.fail("server_error", "x").is_some(), "{text}");
        }
    }

    #[test]
    fn fails_when_the_mark_cannot_be_removed_at_the_prompt() {
        let world = World::new();
        world.write("app/pings/s1.failures/inner", "x");
        let input = json!({"session_id": "s1", "prompt": "go"});

        assert!(matches!(
            world.send(Mode::Prompt, &input),
            Err(Abort::Io { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn fails_when_the_mark_cannot_be_rewritten_at_a_stop() {
        use std::os::unix::fs::PermissionsExt;

        let world = World::new();
        world.write(
            "app/pings/s1.failures",
            r#"{"errors":{"unknown":{"count":1}}}"#,
        );
        fs::set_permissions(world.pings(), fs::Permissions::from_mode(0o500)).unwrap();

        let result = world.send(Mode::Stop, &json!({"session_id": "s1"}));

        fs::set_permissions(world.pings(), fs::Permissions::from_mode(0o700)).unwrap();

        assert!(matches!(result, Err(Abort::Io { .. })));
    }

    #[test]
    fn resolves_the_claude_folder_and_the_managed_folder_of_the_platform() {
        let ctx = Context::resolve(&|_| None, Path::new("/home/u"));

        assert_eq!(
            ctx.managed_settings_dir,
            PathBuf::from(MANAGED_SETTINGS_DIR)
        );
        assert_eq!(ctx.claude_dir, PathBuf::from("/home/u/.claude"));
    }
}
