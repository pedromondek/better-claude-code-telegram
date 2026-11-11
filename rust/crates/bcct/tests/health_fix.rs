#![cfg(unix)]
#![cfg(test)]

use std::collections::HashMap;
use std::ffi::OsString;

use bcct::health::{Check, Entry, Group, Machine, Status};
use bcct::health_fix::{FixId, plan};
use bcct::messages::EN_US;
use bcct::setup::SetupPaths;

fn entry(check: Check, status: Status) -> Entry {
    Entry {
        group: Group::Install,
        check,
        status,
        detail: "detail".to_owned(),
    }
}

fn planned(results: &[Entry], shell: &str, uid: Option<u32>, settings: Option<&str>) -> Vec<FixId> {
    let folder = tempfile::tempdir().unwrap();
    let home = folder.path().join("home");
    let variables: HashMap<&str, OsString> = HashMap::from([
        ("SHELL", OsString::from(shell)),
        (
            "CLAUDE_CONFIG_DIR",
            folder.path().join("claude").into_os_string(),
        ),
        (
            "BETTER_CC_TELEGRAM_DIR",
            folder.path().join("app").into_os_string(),
        ),
    ]);
    let var = |name: &str| variables.get(name).cloned();
    let machine = Machine {
        var: &var,
        home: &home,
        uid,
        now: 0,
        node_version: &|| None,
        has_command: &|_| false,
        claude_output: &|_| String::new(),
        python_works: &|_| false,
        fetch: &|_, _| None,
    };
    let paths = SetupPaths::resolve(&var, &home);

    if let Some(settings) = settings {
        std::fs::create_dir_all(folder.path().join("claude")).unwrap();
        std::fs::write(&paths.settings_file, settings).unwrap();
    }

    plan(results, &machine, &paths, &EN_US)
        .into_iter()
        .map(|fix| fix.id)
        .collect()
}

#[test]
fn the_token_rule_is_only_recommended_while_the_settings_are_invalid() {
    let protection = entry(Check::Protection, Status::Fail);

    assert_eq!(
        planned(
            &[protection.clone(), entry(Check::Config, Status::Ok)],
            "/bin/bash",
            None,
            None
        ),
        vec![FixId::Protection]
    );
    assert_eq!(
        planned(
            &[protection, entry(Check::Config, Status::Fail)],
            "/bin/bash",
            None,
            None
        ),
        vec![]
    );
}

#[test]
fn the_shell_is_fixed_only_for_a_shell_with_a_known_rc() {
    let shell = entry(Check::Shell, Status::Fail);

    assert_eq!(
        planned(std::slice::from_ref(&shell), "/bin/zsh", None, None),
        vec![FixId::Shell]
    );
    assert_eq!(planned(&[shell], "/usr/bin/fish", None, None), vec![]);
    assert_eq!(
        planned(&[entry(Check::Shell, Status::Ok)], "/bin/bash", None, None),
        vec![]
    );
}

#[test]
fn a_fix_is_planned_only_for_a_check_that_ran() {
    let old = r#"{"statusLine":{"type":"command","command":"node \"/old/plugins/telegram-hooks/statusline.mjs\""}}"#;

    assert_eq!(planned(&[], "/bin/bash", None, None), vec![]);
    assert_eq!(
        planned(
            &[entry(Check::Shell, Status::Ok)],
            "/bin/bash",
            None,
            Some(old)
        ),
        vec![]
    );
    assert_eq!(
        planned(
            &[entry(Check::AppDir, Status::Fail)],
            "/bin/bash",
            Some(0),
            None
        ),
        vec![]
    );
}

#[test]
fn the_status_line_is_left_alone_unless_it_is_an_old_command_of_ours() {
    let shown = [entry(Check::Statusline, Status::Ok)];
    let with = |command: &str| {
        format!(
            r#"{{"statusLine":{{"type":"command","command":{}}}}}"#,
            serde_json::json!(command)
        )
    };

    assert_eq!(
        planned(
            &shown,
            "/bin/bash",
            None,
            Some(&with("node \"/old/plugins/telegram-hooks/statusline.mjs\""))
        ),
        vec![FixId::Statusline]
    );
    assert_eq!(
        planned(
            &shown,
            "/bin/bash",
            None,
            Some(&with(
                "node \"/old/plugins/telegram-hooks/statusline.mjs\" --after-previous"
            ))
        ),
        vec![FixId::Statusline]
    );

    for settings in [
        Some(with("my-own-line")),
        Some("not json".to_owned()),
        Some("{}".to_owned()),
        None,
    ] {
        assert_eq!(
            planned(&shown, "/bin/bash", None, settings.as_deref()),
            vec![],
            "{settings:?}"
        );
    }
}
