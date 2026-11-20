use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::files::{create_private_dir, read_json, write_private};
use semver::Version;

use crate::health::{
    Check, Entry, Group, Machine, Screen, Status, collect, entries_json, first_blocked,
    installed_versions, owner_of, status_of, write_all,
};
use crate::hook::Abort;
use crate::hook_failures::{Reason, clear_reason};
use crate::journal::Journal;
use crate::js::stringify_pretty;
use crate::messages::Messages;
use crate::prompt::Prompter;
use crate::settings::{DENY, PERMISSIONS, STATUS_LINE};
use crate::setup::{
    SetupPaths, StatuslineKind, command_on_path, read_settings, shell_file, shell_rc_files,
    shell_script, statusline_is_current, statusline_kind,
};
use crate::setup_files::{
    Printer, SetupFiles, StatuslineChoice, apply_statusline, ensure_env_denied,
};
use crate::shell_rc::install_shell_function;
use crate::ui::{fail, success};

const ALL_ANSWERS: [&str; 3] = ["todos", "tudo", "all"];
const NOT_NEEDED: &str = "not needed";
const OWNER_WRITE: u32 = 0o700;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixId {
    Shell,
    Protection,
    Statusline,
    AppDir,
    Update,
}

impl FixId {
    pub const ALL: [Self; 5] = [
        Self::Shell,
        Self::Protection,
        Self::Statusline,
        Self::AppDir,
        Self::Update,
    ];

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Protection => "protection",
            Self::Statusline => "statusline",
            Self::AppDir => "app",
            Self::Update => "update",
        }
    }

    #[must_use]
    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|fix| fix.as_str() == id)
    }

    #[must_use]
    pub fn check(self) -> Check {
        match self {
            Self::Shell => Check::Shell,
            Self::Protection => Check::Protection,
            Self::Statusline => Check::Statusline,
            Self::AppDir => Check::AppDir,
            Self::Update => Check::Version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fix {
    pub id: FixId,
    pub target: PathBuf,
}

impl Fix {
    #[must_use]
    pub fn action(&self, messages: &Messages) -> String {
        let target = self.target.to_string_lossy();
        let texts = &messages.fix;

        match self.id {
            FixId::Shell => (texts.shell)(&target),
            FixId::Protection => (texts.protection)(&target),
            FixId::Statusline => (texts.statusline)(&target),
            FixId::AppDir => (texts.app_dir)(&target),
            FixId::Update => texts.update.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FixRequest {
    pub yes: bool,
    pub only: Vec<FixId>,
}

impl FixRequest {
    fn applies(&self) -> bool {
        self.yes || !self.only.is_empty()
    }

    fn picks(&self, fix: &Fix) -> bool {
        self.only.is_empty() || self.only.contains(&fix.id)
    }
}

pub fn parse_only(ids: &[String], messages: &Messages) -> Result<Vec<FixId>, String> {
    let unknown: Vec<&str> = ids
        .iter()
        .map(String::as_str)
        .filter(|id| FixId::parse(id).is_none())
        .collect();

    if !unknown.is_empty() {
        let valid: Vec<&str> = FixId::ALL.iter().map(|fix| fix.as_str()).collect();

        return Err((messages.fix.unknown)(
            &unknown.join(", "),
            &valid.join(", "),
        ));
    }

    Ok(ids.iter().filter_map(|id| FixId::parse(id)).collect())
}

#[must_use]
pub fn parse_answer(answer: &str, count: usize) -> Option<Vec<usize>> {
    let answer = answer.trim().to_lowercase();

    if answer.is_empty() {
        return Some(Vec::new());
    }

    if ALL_ANSWERS.contains(&answer.as_str()) {
        return Some((0..count).collect());
    }

    let mut picked: Vec<usize> = answer
        .split(|character: char| character == ',' || character.is_whitespace())
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.parse::<usize>()
                .ok()
                .filter(|number| (1..=count).contains(number))
                .map(|number| number - 1)
        })
        .collect::<Option<_>>()?;

    picked.sort_unstable();
    picked.dedup();

    Some(picked)
}

fn failed(results: &[Entry], check: Check) -> bool {
    results
        .iter()
        .any(|entry| entry.check == check && entry.status == Status::Fail)
}

fn shown(results: &[Entry], check: Check) -> bool {
    results.iter().any(|entry| entry.check == check)
}

fn text_var(machine: &Machine<'_>, name: &str) -> Option<String> {
    (machine.var)(name).map(|value| value.to_string_lossy().into_owned())
}

fn deny_is_usable(paths: &SetupPaths) -> bool {
    let deny = read_json(&paths.settings_file).and_then(|settings| {
        settings
            .get(PERMISSIONS)
            .and_then(|permissions| permissions.get(DENY))
            .cloned()
    });

    !matches!(
        deny,
        Some(Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Object(_))
    )
}

fn statusline_is_old(paths: &SetupPaths, messages: &Messages) -> bool {
    let Ok(settings) = read_settings(&paths.settings_file, messages) else {
        return false;
    };
    let current = settings.get(STATUS_LINE);
    let kind = statusline_kind(current, &paths.app_dir);

    (kind == StatuslineKind::Ours || kind == StatuslineKind::OursAfter)
        && !statusline_is_current(current, &paths.app_dir)
}

#[must_use]
pub fn plan(
    results: &[Entry],
    machine: &Machine<'_>,
    paths: &SetupPaths,
    messages: &Messages,
) -> Vec<Fix> {
    let mut fixes = Vec::new();

    if failed(results, Check::AppDir)
        && let Some((folder, kind)) = first_blocked(&paths.app_dir)
        && Reason::of(&Abort::Io {
            kind,
            path: folder.clone(),
        }) == Reason::NoPermission
        && owner_of(&folder).is_some_and(|owner| Some(owner) == machine.uid)
    {
        fixes.push(Fix {
            id: FixId::AppDir,
            target: folder,
        });
    }

    if failed(results, Check::Shell) {
        let home = machine.home.to_string_lossy();
        let shell = text_var(machine, "SHELL");

        if let Some(rc) = shell_rc_files(&home, shell.as_deref(), cfg!(target_os = "macos")).primary
        {
            fixes.push(Fix {
                id: FixId::Shell,
                target: rc,
            });
        }
    }

    if failed(results, Check::Protection)
        && read_settings(&paths.settings_file, messages).is_ok()
        && deny_is_usable(paths)
    {
        fixes.push(Fix {
            id: FixId::Protection,
            target: paths.settings_file.clone(),
        });
    }

    if shown(results, Check::Statusline) && statusline_is_old(paths, messages) {
        fixes.push(Fix {
            id: FixId::Statusline,
            target: paths.settings_file.clone(),
        });
    }

    if failed(results, Check::Version) {
        fixes.push(Fix {
            id: FixId::Update,
            target: paths.app_dir.clone(),
        });
    }

    fixes
}

#[must_use]
pub fn newer_of(binary: &str, plugin: &str) -> String {
    let parsed = |text: &str| Version::parse(text).ok();

    match (parsed(binary), parsed(plugin)) {
        (Some(binary_version), Some(plugin_version)) => {
            binary_version.max(plugin_version).to_string()
        }
        _ => plugin.to_owned(),
    }
}

fn give_write_permission(folder: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = std::fs::metadata(folder)?.permissions().mode();

        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(mode | OWNER_WRITE))
    }

    #[cfg(not(unix))]
    {
        let _ = (folder, OWNER_WRITE);
        Err(io::ErrorKind::Unsupported.into())
    }
}

pub fn apply(
    fix: &Fix,
    machine: &Machine<'_>,
    paths: &SetupPaths,
    messages: &'static Messages,
) -> Result<(), String> {
    let mut journal = Journal::new();
    let mut silent = Vec::new();
    let mut printer = Printer::new(&mut silent, false, messages);
    let home = machine.home.to_string_lossy();
    let files = SetupFiles {
        app_dir: &paths.app_dir,
        state_dir: &paths.state_dir,
        settings_file: &paths.settings_file,
        home: &home,
    };
    let refused = |error: crate::setup_files::ConfigError| error.message(messages);
    let io_failed = |error: io::Error| {
        Reason::of(&Abort::Io {
            kind: error.kind(),
            path: fix.target.clone(),
        })
        .text(messages)
        .to_owned()
    };

    match fix.id {
        FixId::Shell => {
            let script = shell_file(&paths.app_dir);
            let contents = shell_script(&paths.app_dir, command_on_path(&paths.app_dir));

            create_private_dir(&paths.app_dir)
                .and_then(|()| write_private(&script, contents.as_bytes()))
                .map_err(io_failed)?;
            install_shell_function(
                &home,
                text_var(machine, "SHELL").as_deref(),
                cfg!(target_os = "macos"),
                &script,
                &mut journal,
                &mut printer,
            )
            .map_err(refused)
        }
        FixId::Protection => ensure_env_denied(&files, &mut journal, &mut printer).map_err(refused),
        FixId::Statusline => apply_statusline(
            &files,
            StatuslineChoice::On,
            machine.now,
            &mut journal,
            &mut printer,
        )
        .map_err(refused),
        FixId::AppDir => {
            give_write_permission(&fix.target).map_err(io_failed)?;
            clear_reason(&paths.app_dir, Reason::NoPermission);
            Ok(())
        }
        FixId::Update => {
            let (binary, plugin) =
                installed_versions(machine, &paths.app_dir).ok_or_else(|| NOT_NEEDED.to_owned())?;

            (machine.update)(&newer_of(&binary, &plugin))
        }
    }
}

struct Outcome {
    applied: Vec<FixId>,
    skipped: Vec<(FixId, String)>,
}

fn apply_all(
    chosen: &[&Fix],
    machine: &Machine<'_>,
    paths: &SetupPaths,
    messages: &'static Messages,
) -> Outcome {
    let mut outcome = Outcome {
        applied: Vec::new(),
        skipped: Vec::new(),
    };

    for fix in chosen {
        match apply(fix, machine, paths, messages) {
            Ok(()) => outcome.applied.push(fix.id),
            Err(error) => outcome.skipped.push((fix.id, error)),
        }
    }

    outcome
}

fn plan_text(fixes: &[Fix], results: &[Entry], messages: &Messages) -> String {
    let texts = &messages.fix;
    let covered: Vec<Check> = fixes.iter().map(|fix| fix.id.check()).collect();
    let recommended: Vec<String> = results
        .iter()
        .filter(|entry| entry.status == Status::Fail && !covered.contains(&entry.check))
        .map(|entry| format!("  - {}: {}\n", entry.check.label(messages), entry.detail))
        .collect();
    let mut text = String::from("\n");

    if fixes.is_empty() {
        text.push_str(texts.nothing);
        text.push('\n');
    } else {
        text.push_str(texts.can_fix);
        text.push('\n');

        for (index, fix) in fixes.iter().enumerate() {
            let _written = writeln!(
                text,
                "  {}. {}: {}",
                index + 1,
                fix.id.check().label(messages),
                fix.action(messages)
            );
        }
    }

    if !recommended.is_empty() {
        text.push_str(texts.only_recommend);
        text.push('\n');
        text.extend(recommended);
    }

    text
}

fn choose<'a>(
    fixes: &'a [Fix],
    request: &FixRequest,
    ask: Option<&mut dyn Prompter>,
    messages: &'static Messages,
) -> Option<Vec<&'a Fix>> {
    if request.applies() {
        return Some(fixes.iter().filter(|fix| request.picks(fix)).collect());
    }

    let ask = ask.filter(|ask| ask.interactive())?;

    loop {
        let Ok(answer) = ask.line(messages.fix.question, messages) else {
            return Some(Vec::new());
        };

        if let Some(picked) = parse_answer(&answer, fixes.len()) {
            return Some(
                picked
                    .into_iter()
                    .filter_map(|index| fixes.get(index))
                    .collect(),
            );
        }

        let count = u64::try_from(fixes.len()).unwrap_or(u64::MAX);
        let _reported = ask.report(&(messages.fix.invalid_answer)(count));
    }
}

fn fixes_json(
    fixes: &[Fix],
    outcome: &Outcome,
    request: &FixRequest,
    messages: &Messages,
) -> Value {
    let available: Vec<Value> = fixes
        .iter()
        .map(|fix| {
            json!({
                "id": fix.id.as_str(),
                "check": fix.id.check().as_str(),
                "action": fix.action(messages),
            })
        })
        .collect();
    let mut skipped: Vec<Value> = outcome
        .skipped
        .iter()
        .map(|(id, reason)| json!({"id": id.as_str(), "reason": reason}))
        .collect();

    for id in &request.only {
        if !fixes.iter().any(|fix| fix.id == *id) {
            skipped.push(json!({"id": id.as_str(), "reason": NOT_NEEDED}));
        }
    }

    json!({
        "available": available,
        "applied": outcome.applied.iter().map(|id| id.as_str()).collect::<Vec<_>>(),
        "skipped": skipped,
    })
}

#[derive(Debug)]
pub struct FixRun<'a, 'b> {
    pub groups: &'a [Group],
    pub machine: &'a Machine<'a>,
    pub paths: &'a SetupPaths,
    pub messages: &'static Messages,
    pub screen: &'a mut Screen<'b>,
    pub json: bool,
}

pub fn run_fix(
    run: FixRun<'_, '_>,
    results: Vec<Entry>,
    request: &FixRequest,
    ask: Option<&mut dyn Prompter>,
) -> Result<u8, String> {
    let FixRun {
        groups,
        machine,
        paths,
        messages,
        screen,
        json,
    } = run;
    let fixes = plan(&results, machine, paths, messages);
    let not_shown = |_| messages.health_not_shown.to_owned();

    if json {
        let chosen: Vec<&Fix> = if request.applies() {
            fixes.iter().filter(|fix| request.picks(fix)).collect()
        } else {
            Vec::new()
        };
        let outcome = apply_all(&chosen, machine, paths, messages);
        let last = if outcome.applied.is_empty() {
            results
        } else {
            collect(groups, machine, messages, paths, screen, false)?
        };
        let output = json!({
            "results": entries_json(&last),
            "fixes": fixes_json(&fixes, &outcome, request, messages),
        });

        write_all(screen.out, &format!("{}\n", stringify_pretty(&output))).map_err(not_shown)?;

        return Ok(status_of(&last));
    }

    write_all(screen.out, &plan_text(&fixes, &results, messages)).map_err(not_shown)?;

    if fixes.is_empty() {
        return Ok(status_of(&results));
    }

    let Some(chosen) = choose(&fixes, request, ask, messages) else {
        write_all(screen.out, &format!("{}\n", messages.fix.how_to_apply)).map_err(not_shown)?;
        return Ok(status_of(&results));
    };

    if chosen.is_empty() {
        return Ok(status_of(&results));
    }

    let colorize = screen.colorize_out;

    for fix in &chosen {
        let line = match apply(fix, machine, paths, messages) {
            Ok(()) => success(&(messages.fix.fixed)(&fix.action(messages)), colorize),
            Err(error) => fail(
                &(messages.fix.could_not)(&fix.action(messages), &error),
                colorize,
            ),
        };

        write_all(screen.out, &format!("{line}\n")).map_err(not_shown)?;
    }

    write_all(screen.out, &format!("\n{}\n", messages.fix.checking_again)).map_err(not_shown)?;

    let last = collect(groups, machine, messages, paths, screen, true)?;

    Ok(status_of(&last))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{EN_US, PT_BR};

    #[test]
    fn an_empty_answer_picks_nothing_and_all_picks_every_item() {
        assert_eq!(parse_answer("", 3), Some(vec![]));
        assert_eq!(parse_answer("   ", 3), Some(vec![]));

        for all in ["todos", "tudo", "all", " ALL ", "Todos"] {
            assert_eq!(parse_answer(all, 3), Some(vec![0, 1, 2]), "{all}");
        }
    }

    #[test]
    fn numbers_pick_their_items_once_in_order() {
        assert_eq!(parse_answer("1", 3), Some(vec![0]));
        assert_eq!(parse_answer("3, 1", 3), Some(vec![0, 2]));
        assert_eq!(parse_answer("2 2,2", 3), Some(vec![1]));
        assert_eq!(parse_answer("1,,3", 3), Some(vec![0, 2]));
    }

    #[test]
    fn a_number_outside_the_list_or_a_word_is_refused() {
        for answer in ["0", "4", "x", "1, x", "-1", "1.5", "nenhum"] {
            assert_eq!(parse_answer(answer, 3), None, "{answer}");
        }
    }

    #[test]
    fn every_fix_id_reads_back_and_points_to_its_check() {
        let checks = [
            Check::Shell,
            Check::Protection,
            Check::Statusline,
            Check::AppDir,
        ];

        for (fix, check) in FixId::ALL.into_iter().zip(checks) {
            assert_eq!(FixId::parse(fix.as_str()), Some(fix));
            assert_eq!(fix.check(), check);
        }

        assert_eq!(FixId::parse("nope"), None);
    }

    #[test]
    fn only_lists_the_unknown_ids_with_the_valid_ones_in_the_config_language() {
        let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();

        assert_eq!(
            parse_only(&ids(&["app", "shell"]), &EN_US),
            Ok(vec![FixId::AppDir, FixId::Shell])
        );
        assert_eq!(parse_only(&[], &EN_US), Ok(vec![]));
        assert_eq!(
            parse_only(&ids(&["x", "shell", "y"]), &PT_BR),
            Err("Consertos desconhecidos: x, y. Os possíveis são: shell, protection, statusline, app, update.".to_owned())
        );
    }

    #[test]
    fn a_request_applies_with_yes_or_with_only_and_picks_by_id() {
        let shell = Fix {
            id: FixId::Shell,
            target: PathBuf::from("/rc"),
        };
        let neither = FixRequest::default();
        let only = FixRequest {
            yes: false,
            only: vec![FixId::Protection],
        };

        assert!(!neither.applies());
        assert!(neither.picks(&shell));
        assert!(
            FixRequest {
                yes: true,
                only: vec![]
            }
            .applies()
        );
        assert!(only.applies());
        assert!(!only.picks(&shell));
    }
}
