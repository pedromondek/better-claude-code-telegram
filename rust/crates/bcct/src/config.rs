use std::path::Path;

use serde_json::{Map, Value};

use crate::files::read_json;
use crate::js::{js_number, js_string, js_trim};
use crate::locale::Locale;
use crate::paths::CONFIG_FILE;

pub const DEFAULT_DELAY_MINUTES: f64 = 4.0;
pub const DEFAULT_REMINDER_MINUTES: f64 = 3.0;
pub const DEFAULT_INBOX_RETENTION_DAYS: u64 = 7;
pub const DELAY_ENV: &str = "BETTER_CC_TELEGRAM_DELAY_MS";

const MS_PER_MINUTE: f64 = 60_000.0;

#[must_use]
pub fn read_config(app_dir: &Path) -> Map<String, Value> {
    match read_json(&app_dir.join(CONFIG_FILE)) {
        Some(Value::Object(config)) => config,
        _ => Map::new(),
    }
}

#[must_use]
pub fn read_locale(config: &Map<String, Value>) -> Locale {
    config
        .get("language")
        .and_then(Value::as_str)
        .and_then(Locale::parse)
        .unwrap_or_default()
}

fn env_delay_ms(env_delay: Option<&str>) -> Option<f64> {
    env_delay
        .map(js_trim)
        .filter(|raw| !raw.is_empty())
        .map(js_number)
        .filter(|ms| ms.is_finite() && *ms >= 0.0)
}

#[must_use]
pub fn delay_ms(config: &Map<String, Value>, env_delay: Option<&str>) -> f64 {
    if let Some(from_env) = env_delay_ms(env_delay) {
        return from_env;
    }

    let raw = config.get("delayMinutes");
    let minutes = raw.map_or(f64::NAN, js_to_number);
    let right_away =
        raw.is_some_and(|value| value.as_f64() == Some(0.0) || value.as_str() == Some("0"));

    if minutes.is_finite() && (minutes > 0.0 || right_away) {
        minutes * MS_PER_MINUTE
    } else {
        DEFAULT_DELAY_MINUTES * MS_PER_MINUTE
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DelayKind {
    Questions,
    Permissions,
    Waiting,
    Reminder,
}

impl DelayKind {
    pub const ALL: [Self; 4] = [
        Self::Questions,
        Self::Permissions,
        Self::Waiting,
        Self::Reminder,
    ];
    pub const PER_KIND: [Self; 3] = [Self::Questions, Self::Permissions, Self::Waiting];

    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Questions => "questions",
            Self::Permissions => "permissions",
            Self::Waiting => "waiting",
            Self::Reminder => "reminder",
        }
    }
}

#[must_use]
pub fn kind_minutes(config: &Map<String, Value>, kind: DelayKind) -> Option<f64> {
    config
        .get("delays")
        .and_then(Value::as_object)
        .and_then(|delays| delays.get(kind.key()))
        .and_then(Value::as_f64)
        .filter(|minutes| minutes.is_finite() && *minutes >= 0.0)
}

#[must_use]
pub fn has_per_kind_delays(config: &Map<String, Value>) -> bool {
    config
        .get("delays")
        .is_some_and(|delays| match delays.as_object() {
            Some(saved) => {
                saved.is_empty() || saved.keys().any(|key| key != DelayKind::Reminder.key())
            }
            None => true,
        })
}

#[must_use]
pub fn delay_ms_for(config: &Map<String, Value>, env_delay: Option<&str>, kind: DelayKind) -> f64 {
    env_delay_ms(env_delay).unwrap_or_else(|| {
        kind_minutes(config, kind).map_or_else(
            || {
                if kind == DelayKind::Reminder {
                    DEFAULT_REMINDER_MINUTES * MS_PER_MINUTE
                } else {
                    delay_ms(config, None)
                }
            },
            |minutes| minutes * MS_PER_MINUTE,
        )
    })
}

pub const VISUALS_KEY: &str = "visuals";
pub const VISUAL_REVIEW_KEY: &str = "visualReview";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisualMode {
    Off,
    Prints,
    Video,
}

impl VisualMode {
    pub const ALL: [Self; 3] = [Self::Off, Self::Prints, Self::Video];

    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Prints => "prints",
            Self::Video => "video",
        }
    }

    #[must_use]
    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.key() == key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Visuals {
    pub mode: VisualMode,
    pub review: bool,
}

#[must_use]
pub fn read_visuals(config: &Map<String, Value>) -> Visuals {
    Visuals {
        mode: config
            .get(VISUALS_KEY)
            .and_then(Value::as_str)
            .and_then(VisualMode::parse)
            .unwrap_or(VisualMode::Off),
        review: config.get(VISUAL_REVIEW_KEY) != Some(&Value::Bool(false)),
    }
}

#[must_use]
pub fn js_to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => js_number(text),
        Value::Array(items) => match items.as_slice() {
            [] => 0.0,
            [single] => js_number(&js_string(single)),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> Map<String, Value> {
        serde_json::from_value(value).unwrap_or_default()
    }

    #[test]
    fn reads_the_config_object_from_the_app_folder() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join(CONFIG_FILE), r#"{"language":"pt-br"}"#).unwrap();

        assert_eq!(
            read_config(folder.path()),
            config(json!({"language": "pt-br"}))
        );
    }

    #[test]
    fn a_missing_broken_or_non_object_config_reads_as_empty() {
        let folder = tempfile::tempdir().unwrap();
        assert_eq!(read_config(folder.path()), Map::new());

        for text in ["{broken", "[1,2]", "\"text\"", "null", "7"] {
            std::fs::write(folder.path().join(CONFIG_FILE), text).unwrap();
            assert_eq!(read_config(folder.path()), Map::new(), "{text}");
        }
    }

    #[test]
    fn the_locale_comes_from_language_or_falls_back_to_en_us() {
        assert_eq!(
            read_locale(&config(json!({"language": "pt-br"}))),
            Locale::PtBr
        );
        assert_eq!(
            read_locale(&config(json!({"language": "en-us"}))),
            Locale::EnUs
        );

        for language in [json!("fr"), json!(1), json!(null), json!(["pt-br"])] {
            assert_eq!(
                read_locale(&config(json!({ "language": language }))),
                Locale::EnUs
            );
        }
        assert_eq!(read_locale(&Map::new()), Locale::EnUs);
    }

    #[test]
    fn reads_each_delay_like_the_channel() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../plugins/telegram/extensions/__tests__/fixtures/delays.json"
        ))
        .unwrap();

        assert_eq!(
            DelayKind::ALL.map(DelayKind::key),
            ["questions", "permissions", "waiting", "reminder"]
        );
        assert_eq!(cases.len(), 14);

        for case in &cases {
            let config = config(case["config"].clone());
            let env = case["env"].as_str();

            for kind in DelayKind::ALL {
                let label = format!("{}: {}", case["name"], kind.key());

                assert_eq!(
                    delay_ms_for(&config, env, kind),
                    case["expected"][kind.key()].as_f64().unwrap(),
                    "{label}"
                );
            }
        }
    }

    #[test]
    fn waits_the_reminder_minutes_of_the_channel_when_the_reminder_has_none() {
        let channel = include_str!("../../../../plugins/telegram/extensions/config.ts");

        assert_eq!(DEFAULT_REMINDER_MINUTES, 3.0);
        assert!(channel.contains(&format!(
            "export const DEFAULT_REMINDER_MINUTES = {DEFAULT_REMINDER_MINUTES};"
        )));
        assert_eq!(
            delay_ms_for(
                &config(json!({"delayMinutes": 9})),
                None,
                DelayKind::Reminder
            ),
            180_000.0
        );
    }

    #[test]
    fn tells_the_delay_per_kind_from_a_reminder_saved_alone() {
        let saved = |value: Value| has_per_kind_delays(&config(json!({ "delays": value })));

        assert!(saved(json!({"questions": 1})));
        assert!(saved(json!({"reminder": 2, "waiting": 1})));
        assert!(saved(json!({})));
        assert!(saved(json!([1, 2, 3])));
        assert!(saved(json!(4)));
        assert!(!saved(json!({"reminder": 2})));
        assert!(!has_per_kind_delays(&config(json!({"delayMinutes": 4}))));
        assert!(!has_per_kind_delays(&Map::new()));
    }

    #[test]
    fn reads_the_visuals_like_the_channel() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../plugins/telegram/extensions/__tests__/fixtures/visuals.json"
        ))
        .unwrap();

        assert_eq!(
            VisualMode::ALL.map(VisualMode::key),
            ["off", "prints", "video"]
        );
        assert_eq!(cases.len(), 7);

        for case in &cases {
            let visuals = read_visuals(&config(case["config"].clone()));
            let label = case["name"].to_string();

            assert_eq!(
                visuals.mode.key(),
                case["expected"]["visuals"].as_str().unwrap(),
                "{label}"
            );
            assert_eq!(
                visuals.review,
                case["expected"]["review"].as_bool().unwrap(),
                "{label}"
            );
        }
    }

    #[test]
    fn parses_a_visual_mode_only_by_its_key() {
        for mode in VisualMode::ALL {
            assert_eq!(VisualMode::parse(mode.key()), Some(mode));
        }

        for key in ["", "Prints", " video", "gif", "on"] {
            assert_eq!(VisualMode::parse(key), None, "{key:?}");
        }
    }

    #[test]
    fn the_env_delay_in_ms_wins_when_it_is_a_finite_number_not_below_zero() {
        let five_minutes = config(json!({"delayMinutes": 5}));

        assert_eq!(delay_ms(&five_minutes, Some("1500")), 1500.0);
        assert_eq!(delay_ms(&five_minutes, Some(" 0 ")), 0.0);
        assert_eq!(delay_ms(&five_minutes, Some("1.5e3")), 1500.0);
    }

    #[test]
    fn an_empty_negative_or_non_numeric_env_delay_falls_back_to_the_config() {
        let five_minutes = config(json!({"delayMinutes": 5}));

        for raw in ["", "   ", "\u{feff}", "-1", "abc", "Infinity", "1ms"] {
            assert_eq!(delay_ms(&five_minutes, Some(raw)), 300_000.0, "{raw:?}");
        }
        assert_eq!(delay_ms(&five_minutes, None), 300_000.0);
    }

    #[test]
    fn reads_the_config_minutes_like_js_number_with_zero_as_right_away() {
        let cases = [
            (json!(2), 120_000.0),
            (json!("3"), 180_000.0),
            (json!(0.5), 30_000.0),
            (json!(true), 60_000.0),
            (json!([2]), 120_000.0),
            (json!(0), 0.0),
            (json!("0"), 0.0),
            (json!(""), 240_000.0),
            (json!(false), 240_000.0),
            (json!([]), 240_000.0),
            (json!(-2), 240_000.0),
            (json!(null), 240_000.0),
            (json!("x"), 240_000.0),
            (json!({}), 240_000.0),
        ];

        for (minutes, expected) in cases {
            assert_eq!(
                delay_ms(&config(json!({ "delayMinutes": minutes })), None),
                expected,
                "{minutes}"
            );
        }
        assert_eq!(delay_ms(&Map::new(), None), 240_000.0);
    }

    #[test]
    fn js_number_matches_the_javascript_number_function() {
        let cases: [(&str, f64); 25] = [
            ("42", 42.0),
            ("  42\n", 42.0),
            ("\u{feff}7", 7.0),
            ("-3.5", -3.5),
            ("+3", 3.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("1e3", 1000.0),
            ("1E-2", 0.01),
            ("2e+2", 200.0),
            ("0x1A", 26.0),
            ("0XfF", 255.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            ("", 0.0),
            ("   ", 0.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("+Infinity", f64::INFINITY),
            ("007", 7.0),
            ("0", 0.0),
            ("-0", -0.0),
            ("\u{1680}5", 5.0),
            ("\u{2028}5", 5.0),
            ("\u{3000}5", 5.0),
        ];

        for (text, expected) in cases {
            assert_eq!(js_number(text), expected, "{text:?}");
        }
    }

    #[test]
    fn js_number_is_nan_where_javascript_gives_nan() {
        for text in [
            "abc",
            "1a",
            "1 2",
            "inf",
            "infinity",
            "NaN",
            "nan",
            "e3",
            "1e",
            "1e+",
            ".",
            "+",
            "-",
            "--1",
            "0x",
            "0xG",
            "-0x10",
            "+0b1",
            "1_000",
            "1,5",
            "0b2",
            "0o8",
            "\u{85}5",
            "5\u{85}",
            "\u{180e}5",
            "\u{200b}5",
        ] {
            assert!(js_number(text).is_nan(), "{text:?}");
        }
    }

    #[test]
    fn js_to_number_coerces_each_json_type_like_javascript() {
        assert_eq!(js_to_number(&json!(null)), 0.0);
        assert_eq!(js_to_number(&json!(false)), 0.0);
        assert_eq!(js_to_number(&json!(true)), 1.0);
        assert_eq!(js_to_number(&json!(2.5)), 2.5);
        assert_eq!(js_to_number(&json!(" 9 ")), 9.0);
        assert_eq!(js_to_number(&json!([])), 0.0);
        assert_eq!(js_to_number(&json!([4])), 4.0);
        assert_eq!(js_to_number(&json!(["6"])), 6.0);
        assert_eq!(js_to_number(&json!([null])), 0.0);
        assert_eq!(js_to_number(&json!([[]])), 0.0);
        assert_eq!(js_to_number(&json!([[3]])), 3.0);
        assert!(js_to_number(&json!([true])).is_nan());
        assert!(js_to_number(&json!([1, 2])).is_nan());
        assert!(js_to_number(&json!([{}])).is_nan());
        assert!(js_to_number(&json!({})).is_nan());
    }
}
