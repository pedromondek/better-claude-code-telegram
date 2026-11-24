use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Number, Value};

use crate::config::{DEFAULT_INBOX_RETENTION_DAYS, VisualMode, read_config};
use crate::files::{FileFailure, create_private_dir, write_private};
use crate::journal::{Journal, link_target};
use crate::js::{
    join_path, js_number, js_template, js_trim, js_truthy, stringify, stringify_pretty,
};
use crate::messages::Messages;
use crate::paths::{CONFIG_FILE, PREVIOUS_STATUSLINE_FILE};
use crate::settings::{
    STATUS_LINE, is_our_statusline, not_removed, not_saved, remove_if_present, with_env_denied,
    with_status_line, without_env_denied, without_our_statusline, write_json_atomic,
};
use crate::setup::{
    ENV_FILE, STATUSLINE_REQUEST_FILE, env_deny_rule, read_settings, statusline_after_command,
    statusline_command,
};
use crate::ui::{skipped, success, warn};

pub const CUSTOMIZED_KEY: &str = "statuslineCustomized";
pub const INBOX_KEY: &str = "inboxRetentionDays";

const REQUESTED_AT: &str = "requestedAt";
#[cfg(unix)]
const BACKUP_MODE: u32 = 0o600;
const MS_PER_SECOND: u64 = 1000;
const SECONDS_PER_DAY: u64 = 86_400;
const SECONDS_PER_HOUR: u64 = 3600;
const SECONDS_PER_MINUTE: u64 = 60;
const DAYS_TO_CIVIL_EPOCH: i64 = 719_468;
const DAYS_PER_ERA: i64 = 146_097;
const YEARS_PER_ERA: i64 = 400;
const FIRST_MONTH_AFTER_FEBRUARY: i64 = 10;
const DAYS_SENTINEL: u64 = u64::MAX;
const MINUTES_UNIT: &str = "min";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    Refused(String),
    File(FileFailure),
}

impl ConfigError {
    #[must_use]
    pub fn message(&self, messages: &Messages) -> String {
        match self {
            Self::Refused(message) => message.clone(),
            Self::File(failure) => failure.message(messages),
        }
    }
}

impl From<FileFailure> for ConfigError {
    fn from(failure: FileFailure) -> Self {
        Self::File(failure)
    }
}

pub struct Printer<'a> {
    out: &'a mut dyn Write,
    colorize: bool,
    pub messages: &'a Messages,
    output_failed: bool,
}

impl std::fmt::Debug for Printer<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Printer")
            .field("colorize", &self.colorize)
            .field("output_failed", &self.output_failed)
            .finish_non_exhaustive()
    }
}

impl<'a> Printer<'a> {
    #[must_use]
    pub fn new(out: &'a mut dyn Write, colorize: bool, messages: &'a Messages) -> Self {
        Self {
            out,
            colorize,
            messages,
            output_failed: false,
        }
    }

    #[must_use]
    pub fn output_failed(&self) -> bool {
        self.output_failed
    }

    pub fn line(&mut self, text: &str) {
        if writeln!(self.out, "{text}").is_err() {
            self.output_failed = true;
        }
    }

    pub fn success(&mut self, text: &str) {
        let line = success(text, self.colorize);
        self.line(&line);
    }

    pub fn skipped(&mut self, text: &str) {
        let line = skipped(text, self.colorize);
        self.line(&line);
    }

    pub fn warn(&mut self, text: &str) {
        let line = warn(text, self.colorize);
        self.line(&line);
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SetupFiles<'a> {
    pub app_dir: &'a Path,
    pub state_dir: &'a Path,
    pub settings_file: &'a Path,
    pub home: &'a str,
}

impl SetupFiles<'_> {
    fn settings_name(&self) -> String {
        self.settings_file.to_string_lossy().into_owned()
    }

    fn save_settings(
        &self,
        settings: &Map<String, Value>,
        journal: &mut Journal,
    ) -> Result<(), FileFailure> {
        write_json_atomic(self.settings_file, self.app_dir, settings, journal)
    }

    fn env_rule(&self) -> (PathBuf, String) {
        let env_file = join_path(self.state_dir, ENV_FILE);
        let rule = env_deny_rule(&env_file, self.home);
        (env_file, rule)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatuslineChoice {
    On,
    After,
    Replace,
    Custom,
    Off,
    Keep,
}

#[must_use]
pub fn iso_time(ms: u64) -> String {
    let seconds = ms / MS_PER_SECOND;
    let days = i64::try_from(seconds / SECONDS_PER_DAY).unwrap_or_default();
    let of_day = seconds % SECONDS_PER_DAY;
    let shifted = days + DAYS_TO_CIVIL_EPOCH;
    let era = shifted.div_euclid(DAYS_PER_ERA);
    let day_of_era = shifted.rem_euclid(DAYS_PER_ERA);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524
        - day_of_era / (DAYS_PER_ERA - 1))
        / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < FIRST_MONTH_AFTER_FEBRUARY {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * YEARS_PER_ERA + i64::from(month <= 2);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / SECONDS_PER_HOUR,
        of_day % SECONDS_PER_HOUR / SECONDS_PER_MINUTE,
        of_day % SECONDS_PER_MINUTE,
        ms % MS_PER_SECOND,
    )
}

pub fn update_config(
    app_dir: &Path,
    patch: &Map<String, Value>,
    journal: &mut Journal,
) -> Result<PathBuf, FileFailure> {
    let config_file = join_path(app_dir, CONFIG_FILE);
    let mut config = read_config(app_dir);

    for (key, value) in patch {
        config.insert(key.clone(), value.clone());
    }

    save_app_file(app_dir, &config_file, &pretty_line(config), journal)?;
    Ok(config_file)
}

pub fn remove_config_key(
    app_dir: &Path,
    key: &str,
    journal: &mut Journal,
) -> Result<PathBuf, FileFailure> {
    let config_file = join_path(app_dir, CONFIG_FILE);
    let mut config = read_config(app_dir);

    if config.remove(key).is_some() {
        save_app_file(app_dir, &config_file, &pretty_line(config), journal)?;
    }

    Ok(config_file)
}

fn pretty_line(config: Map<String, Value>) -> Vec<u8> {
    format!("{}\n", stringify_pretty(&Value::Object(config))).into_bytes()
}

fn save_app_file(
    app_dir: &Path,
    file: &Path,
    contents: &[u8],
    journal: &mut Journal,
) -> Result<(), FileFailure> {
    journal.track_dir(app_dir);
    create_private_dir(app_dir)
        .and_then(|()| journal.track_file(file))
        .and_then(|()| write_private(&link_target(file), contents))
        .map_err(not_saved(file))
}

#[must_use]
pub fn current_inbox_days(app_dir: &Path) -> Option<f64> {
    match read_config(app_dir).get(INBOX_KEY) {
        Some(Value::Null) => None,
        Some(Value::Number(days)) if days.as_f64().is_some_and(|days| days > 0.0) => days.as_f64(),
        _ => Some(f64::from(
            u32::try_from(DEFAULT_INBOX_RETENTION_DAYS).unwrap_or(u32::MAX),
        )),
    }
}

#[must_use]
pub fn inbox_text(days: Option<&Value>, messages: &Messages) -> String {
    days.filter(|days| !days.is_null()).map_or_else(
        || messages.inbox_forever.to_owned(),
        |days| templated_days(messages, &js_template(days)),
    )
}

#[must_use]
pub fn review_name(messages: &Messages, review: bool) -> &'static str {
    let [with_review, sent_directly] = messages.visual_review_names;

    if review { with_review } else { sent_directly }
}

#[must_use]
pub fn visuals_text(messages: &Messages, mode: VisualMode, review: Option<bool>) -> String {
    let [off, prints, video] = messages.visuals_names;
    let name = match mode {
        VisualMode::Off => off,
        VisualMode::Prints => prints,
        VisualMode::Video => video,
    };

    match review {
        Some(review) => format!("{name} · {}", review_name(messages, review)),
        None => name.to_owned(),
    }
}

#[must_use]
pub fn templated_days(messages: &Messages, text: &str) -> String {
    (messages.inbox_days)(DAYS_SENTINEL).replacen(&DAYS_SENTINEL.to_string(), text, 1)
}

#[must_use]
pub fn templated_delay(messages: &Messages, text: &str) -> String {
    let minutes = js_number(text);

    if minutes == 0.0 && !js_trim(text).is_empty() {
        messages.delay_right_away.to_owned()
    } else if minutes.is_finite() && !js_trim(text).is_empty() {
        (messages.delay_label)(minutes)
    } else {
        format!("{text} {MINUTES_UNIT}")
    }
}

pub fn save_inbox_days(
    app_dir: &Path,
    days: Option<f64>,
    journal: &mut Journal,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    let value = days
        .and_then(Number::from_f64)
        .map_or(Value::Null, Value::Number);
    let mut patch = Map::new();
    patch.insert(INBOX_KEY.to_owned(), value.clone());

    let config_file = update_config(app_dir, &patch, journal)?;
    let messages = printer.messages;

    printer.success(&(messages.inbox_saved)(
        &inbox_text(Some(&value), messages),
        &config_file.to_string_lossy(),
    ));
    Ok(())
}

#[must_use]
pub fn statusline_customized(app_dir: &Path) -> bool {
    read_config(app_dir).get(CUSTOMIZED_KEY) == Some(&Value::Bool(true))
}

#[must_use]
pub fn statusline_custom_left(
    app_dir: &Path,
    messages: &Messages,
    colorize: bool,
) -> Option<String> {
    statusline_customized(app_dir).then(|| {
        warn(
            &(messages.statusline_custom_left)(&statusline_command(app_dir)),
            colorize,
        )
    })
}

pub fn request_statusline_custom(
    files: &SetupFiles<'_>,
    current: Option<&Value>,
    now: u64,
    journal: &mut Journal,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    if !current.is_some_and(js_truthy) || is_our_statusline(current, files.app_dir) {
        return Err(ConfigError::Refused(
            printer.messages.statusline_custom_needs_own.to_owned(),
        ));
    }

    let request_file = join_path(files.app_dir, STATUSLINE_REQUEST_FILE);
    let mut request = Map::new();
    request.insert(REQUESTED_AT.to_owned(), Value::String(iso_time(now)));
    let contents = format!("{}\n", stringify(&Value::Object(request)));

    save_app_file(files.app_dir, &request_file, contents.as_bytes(), journal)?;

    printer.success(printer.messages.statusline_custom_requested);
    Ok(())
}

pub fn forget_statusline_request(app_dir: &Path, journal: &mut Journal) -> Result<(), FileFailure> {
    let request_file = join_path(app_dir, STATUSLINE_REQUEST_FILE);

    if fs::metadata(&request_file).is_err() {
        return Ok(());
    }

    journal
        .track_file(&request_file)
        .and_then(|()| remove_if_present(&request_file))
        .map_err(not_removed(&request_file))
}

pub fn forget_statusline_customized(
    app_dir: &Path,
    journal: &mut Journal,
) -> Result<(), FileFailure> {
    let mut config = read_config(app_dir);

    if config.shift_remove(CUSTOMIZED_KEY).is_none() {
        return Ok(());
    }

    let config_file = join_path(app_dir, CONFIG_FILE);

    journal
        .track_file(&config_file)
        .and_then(|()| write_private(&link_target(&config_file), &pretty_line(config)))
        .map_err(not_saved(&config_file))
}

pub fn save_previous_statusline(
    app_dir: &Path,
    status_line: &Value,
    journal: &mut Journal,
) -> Result<(), FileFailure> {
    let previous_file = join_path(app_dir, PREVIOUS_STATUSLINE_FILE);

    save_app_file(
        app_dir,
        &previous_file,
        stringify(status_line).as_bytes(),
        journal,
    )
}

fn read_settings_or_refuse(
    files: &SetupFiles<'_>,
    messages: &Messages,
) -> Result<Map<String, Value>, ConfigError> {
    read_settings(files.settings_file, messages).map_err(ConfigError::Refused)
}

fn back_up(settings_file: &Path, backup: &Path, journal: &mut Journal) -> Result<(), FileFailure> {
    copy_private(settings_file, backup, journal).map_err(not_saved(backup))
}

fn copy_private(source: &Path, copy: &Path, journal: &mut Journal) -> std::io::Result<()> {
    journal.track_file(copy)?;
    fs::copy(source, copy)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(copy, fs::Permissions::from_mode(BACKUP_MODE))?;
    }

    Ok(())
}

fn removal_text(restored: bool, settings_file: &str, messages: &Messages) -> String {
    if restored {
        (messages.statusline_restored)(settings_file)
    } else {
        (messages.statusline_removed)(settings_file)
    }
}

pub fn apply_statusline(
    files: &SetupFiles<'_>,
    choice: StatuslineChoice,
    now: u64,
    journal: &mut Journal,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    let messages = printer.messages;
    let settings = read_settings_or_refuse(files, messages)?;
    let command = statusline_command(files.app_dir);
    let current = settings.get(STATUS_LINE);
    let name = files.settings_name();

    if choice == StatuslineChoice::Custom {
        return request_statusline_custom(files, current, now, journal, printer);
    }

    forget_statusline_request(files.app_dir, journal)?;

    if choice == StatuslineChoice::Off {
        let Some(removed) = without_our_statusline(&settings, files.app_dir)? else {
            printer.line(messages.statusline_skipped);
            return Ok(());
        };

        files.save_settings(&removed.settings, journal)?;
        printer.success(&removal_text(removed.restored, &name, messages));

        return Ok(());
    }

    if is_our_statusline(current, files.app_dir) {
        printer.skipped(messages.statusline_already);
        return Ok(());
    }

    if !current.is_some_and(js_truthy) {
        forget_statusline_customized(files.app_dir, journal)?;
        files.save_settings(&with_status_line(&settings, &command), journal)?;
        printer.success(&(messages.statusline_installed)(&name));
        return Ok(());
    }

    let previous = current.cloned().unwrap_or_default();

    if choice == StatuslineChoice::After {
        let chained = with_status_line(&settings, &statusline_after_command(files.app_dir));

        forget_statusline_customized(files.app_dir, journal)?;
        save_previous_statusline(files.app_dir, &previous, journal)?;
        files.save_settings(&chained, journal)?;
        printer.success(&(messages.statusline_chained)(&name));
        return Ok(());
    }

    if choice == StatuslineChoice::Replace {
        let backup = PathBuf::from(format!("{name}.bak.{now}"));

        forget_statusline_customized(files.app_dir, journal)?;
        back_up(files.settings_file, &backup, journal)?;
        let replaced = with_status_line(&settings, &command);

        save_previous_statusline(files.app_dir, &previous, journal)?;
        files.save_settings(&replaced, journal)?;
        printer.success(&(messages.statusline_replaced)(
            &name,
            &backup.to_string_lossy(),
        ));
        return Ok(());
    }

    printer.skipped(if statusline_customized(files.app_dir) {
        messages.statusline_custom_kept
    } else {
        messages.statusline_kept
    });
    Ok(())
}

pub fn ensure_env_denied(
    files: &SetupFiles<'_>,
    journal: &mut Journal,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    let messages = printer.messages;
    let (env_file, rule) = files.env_rule();
    let env_name = env_file.to_string_lossy();
    let name = files.settings_name();
    let settings = read_settings_or_refuse(files, messages)?;

    let Some(denied) = with_env_denied(&settings, &rule).map_err(ConfigError::Refused)? else {
        printer.skipped(&(messages.env_already_protected)(&env_name, &name));
        return Ok(());
    };

    files.save_settings(&denied, journal)?;
    printer.success(&(messages.env_protected)(&env_name, &name));
    Ok(())
}

pub fn remove_our_settings(
    settings: &Map<String, Value>,
    files: &SetupFiles<'_>,
    journal: &mut Journal,
    printer: &mut Printer<'_>,
) -> Result<(), ConfigError> {
    let messages = printer.messages;
    let name = files.settings_name();
    let mut cleaned = None;

    if let Some(removed) = without_our_statusline(settings, files.app_dir)? {
        let text = removal_text(removed.restored, &name, messages);

        cleaned = Some(removed.settings);
        printer.success(&text);
    }

    let (_, rule) = files.env_rule();

    if let Some(without) = without_env_denied(cleaned.as_ref().unwrap_or(settings), &rule)
        .map_err(ConfigError::Refused)?
    {
        cleaned = Some(without);
        printer.success(&(messages.env_rule_removed)(&name));
    }

    match cleaned {
        Some(cleaned) => Ok(files.save_settings(&cleaned, journal)?),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_the_config_untouched_when_the_key_to_remove_is_missing() {
        let folder = tempfile::tempdir().unwrap();
        let config_file = folder.path().join(CONFIG_FILE);
        let mut journal = Journal::new();

        fs::write(&config_file, "{\"language\":\"pt-br\"}").unwrap();

        let removed = remove_config_key(folder.path(), "delays", &mut journal).unwrap();

        assert_eq!(removed, config_file);
        assert_eq!(
            fs::read_to_string(&config_file).unwrap(),
            "{\"language\":\"pt-br\"}"
        );
        assert_eq!(journal.changes(), Vec::new());
    }

    #[test]
    fn removes_the_config_key_and_keeps_the_other_keys() {
        let folder = tempfile::tempdir().unwrap();
        let config_file = folder.path().join(CONFIG_FILE);
        let mut journal = Journal::new();

        fs::write(&config_file, "{\"language\":\"pt-br\",\"delays\":[1,2,3]}").unwrap();

        let removed = remove_config_key(folder.path(), "delays", &mut journal).unwrap();
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();

        assert_eq!(removed, config_file);
        assert_eq!(saved, serde_json::json!({"language": "pt-br"}));
        assert_eq!(
            journal.changes(),
            [crate::journal::Change {
                kind: crate::journal::ChangeKind::FileChanged,
                target: fs::canonicalize(&config_file)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            }]
        );
    }

    #[cfg(unix)]
    #[test]
    fn fails_to_remove_the_config_key_when_the_config_cannot_be_saved() {
        use std::os::unix::fs::PermissionsExt;

        let folder = tempfile::tempdir().unwrap();
        let config_file = folder.path().join(CONFIG_FILE);
        let mut journal = Journal::new();

        fs::write(&config_file, "{\"delays\":[1,2,3]}").unwrap();
        fs::set_permissions(folder.path(), fs::Permissions::from_mode(0o500)).unwrap();

        let removed = remove_config_key(folder.path(), "delays", &mut journal);

        fs::set_permissions(folder.path(), fs::Permissions::from_mode(0o700)).unwrap();

        assert!(removed.is_err());
        assert_eq!(
            fs::read_to_string(&config_file).unwrap(),
            "{\"delays\":[1,2,3]}"
        );
    }

    #[test]
    fn formats_the_time_like_the_js_date() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_time(4_107_542_399_999), "2100-02-28T23:59:59.999Z");
        assert_eq!(iso_time(1_709_251_199_001), "2024-02-29T23:59:59.001Z");
        assert_eq!(iso_time(1_735_689_600_000), "2025-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_738_367_999_000), "2025-01-31T23:59:59.000Z");

        for (ms, text) in [
            (4_107_542_400_000, "2100-03-01T00:00:00.000Z"),
            (4_139_078_400_000, "2101-03-01T00:00:00.000Z"),
            (7_263_172_800_000, "2200-02-28T12:00:00.000Z"),
            (7_263_216_000_000, "2200-03-01T00:00:00.000Z"),
            (10_418_889_600_000, "2300-03-01T00:00:00.000Z"),
            (13_569_465_599_999, "2399-12-31T23:59:59.999Z"),
            (13_574_563_200_000, "2400-02-29T00:00:00.000Z"),
            (13_574_649_600_000, "2400-03-01T00:00:00.000Z"),
            (3_981_312_000_000, "2096-02-29T00:00:00.000Z"),
            (4_012_934_400_000, "2097-03-01T00:00:00.000Z"),
        ] {
            assert_eq!(iso_time(ms), text, "{ms}");
        }
    }

    #[test]
    fn formats_every_day_of_more_than_four_centuries() {
        let (mut year, mut month, mut day) = (1970_u64, 1_u64, 1_u64);

        for days in 0..160_000_u64 {
            assert_eq!(
                iso_time(days * 86_400_000 + 3_723_004),
                format!("{year:04}-{month:02}-{day:02}T01:02:03.004Z")
            );

            let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            let length = match month {
                2 if leap => 29,
                2 => 28,
                4 | 6 | 9 | 11 => 30,
                _ => 31,
            };

            day += 1;

            if day > length {
                day = 1;
                month += 1;
            }

            if month > 12 {
                month = 1;
                year += 1;
            }
        }
    }

    #[test]
    fn each_failure_has_its_message() {
        let messages = crate::messages::messages_for(crate::locale::Locale::EnUs);

        assert_eq!(ConfigError::Refused("x".to_owned()).message(messages), "x");
        assert_eq!(
            ConfigError::File(FileFailure::NotSaved(PathBuf::from("/x"))).message(messages),
            "Could not save /x."
        );
    }
}
