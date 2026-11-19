use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::config::{read_config, read_locale};
use crate::files::{create_private_dir, read_json, write_private};
use crate::hook::{Abort, Context, millis};
use crate::js::{join_path, js_trim, stringify};
use crate::messages::{StopFailureTexts, messages_for};
use crate::usage_reset::{Moment, Reset, parse};

pub const REPEAT_INTERVAL_MS: u64 = 300_000;
pub const FIRST_NOTICE_AT_FAILURE: u64 = 2;
pub const AUTOMATIC_CONTINUES: u64 = 3;
pub const MARK_SUFFIX: &str = ".failures";
pub const NOTICE_SUFFIX: &str = ".notice.json";
pub const NOTICE_KIND: &str = "failure";
pub const AUTO_CONTINUE_KEY: &str = "autoContinueAtUsageLimit";

const SETTINGS_FILE: &str = "settings.json";
const MANAGED_FILE: &str = "managed-settings.json";
const DROP_IN_FOLDER: &str = "managed-settings.d";
const JSON_SUFFIX: &str = ".json";
const DETAIL_MAX_CHARS: usize = 200;
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
    Never,
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

    fn policy(self) -> Policy {
        match self {
            Self::UsageLimit
            | Self::Billing
            | Self::AccountOnHold
            | Self::Authentication
            | Self::OauthOrgNotAllowed
            | Self::InvalidRequest
            | Self::CloudCredential => Policy::Always,
            Self::Throttle | Self::ServerError | Self::Unknown => Policy::Guarded,
            Self::ModelNotFound | Self::MaxOutputTokens => Policy::Never,
        }
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

fn usage_tail(texts: &StopFailureTexts, text: &str, continues: bool) -> String {
    let Some(Reset { moment, zone }) = parse(text) else {
        return String::new();
    };
    let zone = zone.as_deref();

    match moment {
        Moment::Today(clock) => {
            let when = with_zone((texts.clock)(clock.hour, clock.minute), zone);

            if continues && !mentions_a_model_limit(text) {
                (texts.continues_by_itself)(clock.hour, &when)
            } else {
                (texts.back_will_not_continue)(clock.hour, &when)
            }
        }
        Moment::Dated { month, day, clock } => (texts.back_on_will_not_continue)(&with_zone(
            (texts.date_clock)(month, day, clock.hour, clock.minute),
            zone,
        )),
        Moment::Weekday { weekday, clock } => (texts.back_weekday_will_not_continue)(&with_zone(
            (texts.weekday_clock)(weekday, clock.hour, clock.minute),
            zone,
        )),
    }
}

fn notice_text(
    texts: &StopFailureTexts,
    kind: Kind,
    who: &str,
    detail: Option<&str>,
    tail: &str,
) -> String {
    let head = match kind {
        Kind::UsageLimit => (texts.usage_limit)(who),
        Kind::Throttle => (texts.throttle)(who),
        Kind::Billing => (texts.billing)(who),
        Kind::AccountOnHold => (texts.account_on_hold)(who),
        Kind::Authentication => (texts.authentication)(who),
        Kind::OauthOrgNotAllowed => (texts.oauth_org_not_allowed)(who),
        Kind::InvalidRequest => (texts.invalid_request)(who, detail),
        Kind::CloudCredential => (texts.cloud_credential)(who),
        Kind::ServerError => (texts.server_error)(who),
        Kind::Unknown | Kind::ModelNotFound | Kind::MaxOutputTokens => (texts.unknown)(who, detail),
    };

    format!("{head}{tail}")
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

    if kind.policy() == Policy::Never {
        return Ok(());
    }

    let pings_dir = ctx.app_dir.join("pings");
    let mut mark = Mark::load(&mark_file(&pings_dir, key));
    let before = mark.to_value();

    let notify = match kind.policy() {
        Policy::Guarded => {
            let streak = mark.streaks.entry(kind.key().to_owned()).or_insert(Streak {
                count: 0,
                noticed_at: None,
            });

            due(streak, now)
        }
        Policy::Always | Policy::Never => true,
    };

    if kind == Kind::UsageLimit {
        mark.limit_hits += 1;
    }

    if notify {
        let texts = &messages_for(read_locale(&read_config(&ctx.app_dir))).stop_failure;
        let who = (texts.who)(instance.as_ref().and_then(Value::as_str));
        let detail = first_line(message).or_else(|| first_line(details));
        let tail = if kind == Kind::UsageLimit {
            let continues = auto_continue_enabled(ctx) && mark.limit_hits <= AUTOMATIC_CONTINUES;

            usage_tail(texts, &combined, continues)
        } else {
            String::new()
        };
        let text = notice_text(texts, kind, &who, detail.as_deref(), &tail);
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
    const USAGE_HEAD: &str = "⚠️ Claude stopped: the usage limit of your plan was reached";
    const CONTINUES: &str = "it continues by itself at 2:20 PM (America/Sao_Paulo)";
    const BACK_TODAY: &str = "back at 2:20 PM (America/Sao_Paulo)";
    const WILL_NOT: &str = "will not continue by itself";

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
    fn writes_every_portuguese_line() {
        let texts = &messages_for(Locale::PtBr).stop_failure;
        let lines = [
            (
                (texts.usage_limit)("X"),
                "⚠️ X parou: o limite de uso do seu plano foi atingido",
            ),
            (
                (texts.throttle)("X"),
                "⚠️ X parou: a API está limitando as requisições (não é o limite de uso do seu plano)",
            ),
            (
                (texts.billing)("X"),
                "⚠️ X parou: há um problema de cobrança na sua conta",
            ),
            (
                (texts.account_on_hold)("X"),
                "⚠️ X parou: sua conta está suspensa",
            ),
            (
                (texts.authentication)("X"),
                "⚠️ X parou: a autenticação falhou, entre de novo",
            ),
            (
                (texts.oauth_org_not_allowed)("X"),
                "⚠️ X parou: sua organização não pode usar este login",
            ),
            (
                (texts.cloud_credential)("X"),
                "⚠️ X parou: não foi possível carregar as credenciais do provedor de nuvem",
            ),
            (
                (texts.server_error)("X"),
                "⚠️ X parou: a API continua falhando (erro de servidor)",
            ),
            (
                (texts.invalid_request)("X", Some("y")),
                "⚠️ X parou: a API recusou a requisição (y)",
            ),
            (
                (texts.invalid_request)("X", None),
                "⚠️ X parou: a API recusou a requisição",
            ),
            ((texts.unknown)("X", Some("y")), "⚠️ X parou por um erro: y"),
            (
                (texts.unknown)("X", None),
                "⚠️ X parou por um erro desconhecido",
            ),
            ((texts.who)(Some("api")), "A instância [api] do Claude"),
            ((texts.who)(None), "O Claude"),
            (
                (texts.continues_by_itself)(1, "13:05"),
                " · continua sozinho à 13:05",
            ),
            (
                (texts.back_will_not_continue)(2, "14:05"),
                " · volta às 14:05 · não continua sozinho",
            ),
            (
                (texts.back_on_will_not_continue)("20/11 09:00"),
                " · volta em 20/11 09:00 · não continua sozinho",
            ),
            (
                (texts.back_weekday_will_not_continue)("sex 09:00"),
                " · volta sex 09:00 · não continua sozinho",
            ),
            ((texts.clock)(9, 5), "09:05"),
            ((texts.date_clock)(11, 20, 9, 5), "20/11 09:05"),
            ((texts.weekday_clock)(4, 9, 5), "sex 09:05"),
            ((texts.weekday_clock)(9, 9, 5), "9 09:05"),
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
    fn writes_the_english_instance_and_the_hours_around_midnight_and_noon() {
        let texts = &messages_for(Locale::EnUs).stop_failure;

        assert_eq!((texts.who)(Some("api")), "The Claude instance [api]");
        assert_eq!((texts.clock)(0, 5), "12:05 AM");
        assert_eq!((texts.clock)(12, 5), "12:05 PM");
        assert_eq!((texts.clock)(23, 59), "11:59 PM");
        assert_eq!((texts.date_clock)(11, 20, 9, 5), "Nov 20, 9:05 AM");
        assert_eq!((texts.date_clock)(13, 20, 9, 5), "13 20, 9:05 AM");
        assert_eq!((texts.weekday_clock)(4, 9, 5), "Fri 9:05 AM");
        assert_eq!((texts.weekday_clock)(9, 9, 5), "9 9:05 AM");
    }

    #[test]
    fn sends_the_line_of_each_error_that_always_notifies() {
        for (error, expected) in [
            (
                "billing_error",
                "⚠️ Claude stopped: there is a billing problem with your account",
            ),
            (
                "account_on_hold",
                "⚠️ Claude stopped: your account is on hold",
            ),
            (
                "authentication_failed",
                "⚠️ Claude stopped: authentication failed, log in again",
            ),
            (
                "oauth_org_not_allowed",
                "⚠️ Claude stopped: your organization is not allowed to use this login",
            ),
            (
                "cloud_credential_error",
                "⚠️ Claude stopped: the cloud provider credentials could not be loaded",
            ),
            (
                "invalid_request",
                "⚠️ Claude stopped: the API rejected the request (prompt too long)",
            ),
        ] {
            let world = World::new();

            for round in ["first", "second"] {
                assert_eq!(
                    world.fail(error, "prompt too long").as_deref(),
                    Some(expected),
                    "{error} {round}"
                );
            }
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
            Some("⚠️ Claude stopped: the API keeps failing (server error)")
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
            Some("⚠️ Claude stopped: the API is limiting requests (not your plan's usage limit)")
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
            Some("⚠️ Claude stopped: the API rejected the request (First line)")
        );

        world.fail("unknown", "Odd failure\nmore");

        assert_eq!(
            world.fail("unknown", "Odd failure\nmore").as_deref(),
            Some("⚠️ Claude stopped on an error: Odd failure")
        );
    }

    #[test]
    fn cuts_a_long_first_line() {
        let world = World::new();
        let long = "x".repeat(DETAIL_MAX_CHARS + 50);

        assert_eq!(
            world.fail("invalid_request", &long),
            Some(format!(
                "⚠️ Claude stopped: the API rejected the request ({})",
                "x".repeat(DETAIL_MAX_CHARS)
            ))
        );
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
            Some("⚠️ Claude stopped: the API rejected the request (400 bad things)")
        );
        assert_eq!(
            world.fail("invalid_request", "").as_deref(),
            Some("⚠️ Claude stopped: the API rejected the request")
        );

        world.fail("unknown", "  \n ");

        assert_eq!(
            world.fail("unknown", "  \n ").as_deref(),
            Some("⚠️ Claude stopped on an unknown error")
        );
    }

    #[test]
    fn treats_an_unlisted_or_missing_error_as_unknown() {
        let world = World::new();

        world.fail("brand_new_error", "Odd");

        assert_eq!(
            world.fail("brand_new_error", "Odd").as_deref(),
            Some("⚠️ Claude stopped on an error: Odd")
        );

        let input = json!({"session_id": "s2", "last_assistant_message": "Odd"});

        world.send(Mode::StopFailure, &input).unwrap();
        assert_eq!(world.take("s2"), None);

        world.send(Mode::StopFailure, &input).unwrap();
        assert_eq!(
            world.take("s2").as_deref(),
            Some("⚠️ Claude stopped on an error: Odd")
        );
    }

    #[test]
    fn says_the_usage_limit_continues_by_itself_with_the_time() {
        let world = World::new();

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT),
            Some(format!("{USAGE_HEAD} · {CONTINUES}"))
        );
    }

    #[test]
    fn shows_the_time_in_24_hours_in_pt_br() {
        let world = World::portuguese();

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · continua sozinho às 14:20 (America/Sao_Paulo)"
            )
        );

        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · volta às 14:20 (America/Sao_Paulo) · não continua sozinho"
            )
        );
    }

    #[test]
    fn says_it_will_not_continue_when_the_setting_is_false() {
        let world = World::new();
        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", SESSION_LIMIT),
            Some(format!("{USAGE_HEAD} · {BACK_TODAY} · it {WILL_NOT}"))
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
                    .ends_with(CONTINUES),
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
                .ends_with(WILL_NOT)
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
                .ends_with(CONTINUES)
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
                .ends_with(CONTINUES)
        );

        world.write("managed/managed-settings.d/25-d.json", off);
        world.prompt("s1");

        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(WILL_NOT)
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
                    .ends_with(CONTINUES),
                "hit {hit}"
            );
        }

        for hit in 4..=5 {
            assert!(
                world
                    .fail("rate_limit", SESSION_LIMIT)
                    .unwrap()
                    .ends_with(&format!("{BACK_TODAY} · it {WILL_NOT}")),
                "hit {hit}"
            );
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
                .ends_with(WILL_NOT)
        );

        world.prompt("s1");

        assert_eq!(world.mark("s1"), None);
        assert!(
            world
                .fail("rate_limit", SESSION_LIMIT)
                .unwrap()
                .ends_with(CONTINUES)
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
            let world = World::new();

            assert_eq!(
                world.fail("rate_limit", text).as_deref(),
                Some(USAGE_HEAD),
                "{text:?}"
            );
        }
    }

    #[test]
    fn shows_the_date_and_the_zone_of_a_dated_reset_without_a_promise() {
        let text = "You've hit your weekly limit · resets Nov 24, 9am (America/Sao_Paulo)";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(format!(
                "{USAGE_HEAD} · back on Nov 24, 9:00 AM (America/Sao_Paulo) · it {WILL_NOT}"
            ))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", text).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · volta em 24/11 09:00 (America/Sao_Paulo) · não continua sozinho"
            )
        );
    }

    #[test]
    fn shows_a_dated_reset_without_a_zone_when_the_text_has_none() {
        let text = "You've hit your weekly limit · resets Nov 24, 9am";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(format!(
                "{USAGE_HEAD} · back on Nov 24, 9:00 AM · it {WILL_NOT}"
            ))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", text).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · volta em 24/11 09:00 · não continua sozinho"
            )
        );
    }

    #[test]
    fn shows_a_near_dated_reset_with_its_date() {
        for day in [18, 19, 20] {
            let text = format!("You've hit your weekly limit · resets Nov {day}, 9am (UTC)");

            assert_eq!(
                World::new().fail("rate_limit", &text),
                Some(format!(
                    "{USAGE_HEAD} · back on Nov {day}, 9:00 AM (UTC) · it {WILL_NOT}"
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
            Some(format!(
                "{USAGE_HEAD} · back Mon 9:00 AM (America/Sao_Paulo) · it {WILL_NOT}"
            ))
        );
        assert_eq!(
            World::new().fail("rate_limit", without_zone),
            Some(format!("{USAGE_HEAD} · back Sun 9:30 PM · it {WILL_NOT}"))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", with_zone).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · volta seg 09:00 (America/Sao_Paulo) · não continua sozinho"
            )
        );
        assert_eq!(
            World::portuguese()
                .fail("rate_limit", without_zone)
                .as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · volta dom 21:30 · não continua sozinho"
            )
        );
    }

    #[test]
    fn shows_the_time_of_a_same_day_reset_without_a_zone_when_the_text_has_none() {
        let text = "You've hit your session limit · resets 2:20pm";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(format!("{USAGE_HEAD} · it continues by itself at 2:20 PM"))
        );
        assert_eq!(
            World::portuguese().fail("rate_limit", text).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · continua sozinho às 14:20"
            )
        );

        let world = World::new();
        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", text),
            Some(format!("{USAGE_HEAD} · back at 2:20 PM · it {WILL_NOT}"))
        );
    }

    #[test]
    fn shows_the_time_of_an_opus_or_sonnet_limit_without_a_promise() {
        for (text, back) in [
            ("You've hit your Opus limit · resets 3pm", "back at 3:00 PM"),
            (
                "You've hit your Sonnet limit · resets 3pm (America/Sao_Paulo)",
                "back at 3:00 PM (America/Sao_Paulo)",
            ),
        ] {
            assert_eq!(
                World::new().fail("rate_limit", text),
                Some(format!("{USAGE_HEAD} · {back} · it {WILL_NOT}")),
                "{text}"
            );
        }
    }

    #[test]
    fn says_the_hour_one_with_a_single_article_in_pt_br() {
        let text = "You've hit your session limit · resets 1:00am (America/Sao_Paulo)";
        let world = World::portuguese();

        assert_eq!(
            world.fail("rate_limit", text).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · continua sozinho à 01:00 (America/Sao_Paulo)"
            )
        );

        world.user_setting(r#"{"autoContinueAtUsageLimit":false}"#);

        assert_eq!(
            world.fail("rate_limit", text).as_deref(),
            Some(
                "⚠️ O Claude parou: o limite de uso do seu plano foi atingido · volta à 01:00 (America/Sao_Paulo) · não continua sozinho"
            )
        );
        assert_eq!(
            world
                .fail("rate_limit", "resets 1:45pm")
                .as_deref()
                .map(|line| line.contains("volta às 13:45")),
            Some(true)
        );
        assert_eq!(
            world
                .fail("rate_limit", "resets 12:00am")
                .as_deref()
                .map(|line| line.contains("volta às 00:00")),
            Some(true)
        );
        assert_eq!(
            world
                .fail("rate_limit", "resets 2am")
                .as_deref()
                .map(|line| line.contains("volta às 02:00")),
            Some(true)
        );
    }

    #[test]
    fn keeps_the_english_text_the_same_for_the_hour_one() {
        let text = "You've hit your session limit · resets 1:00am (UTC)";

        assert_eq!(
            World::new().fail("rate_limit", text),
            Some(format!(
                "{USAGE_HEAD} · it continues by itself at 1:00 AM (UTC)"
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
                .ends_with("it continues by itself at 3:45 PM")
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
            json!("⚠️ Claude stopped: there is a billing problem with your account")
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
            json!("⚠️ The Claude instance [proj#abcd] stopped: your account is on hold")
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
