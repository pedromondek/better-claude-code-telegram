#![cfg(unix)]
#![cfg(test)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt::Write as _;

use bcct::health::{Check, Entry, Group, Machine, Status};
use bcct::health_fix::{Fix, FixId, apply, newer_of, plan};
use bcct::messages::EN_US;
use bcct::self_install::{Origin, Store};
use bcct::setup::SetupPaths;
use serde_json::json;
use sha2::Digest;

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
        git_version: &|| None,
        has_command: &|_| false,
        claude_output: &|_| String::new(),
        python_works: &|_| false,
        fetch: &|_, _| None,
        update: &|_| Ok(()),
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
fn a_version_that_differs_plans_the_update() {
    assert_eq!(
        planned(
            &[entry(Check::Version, Status::Fail)],
            "/bin/bash",
            None,
            None
        ),
        vec![FixId::Update]
    );
    assert_eq!(
        planned(
            &[entry(Check::Version, Status::Off)],
            "/bin/bash",
            None,
            None
        ),
        Vec::<FixId>::new()
    );
    assert_eq!(FixId::parse("update"), Some(FixId::Update));
    assert_eq!(FixId::Update.check(), Check::Version);
}

#[test]
fn the_update_goes_to_the_newer_of_the_binary_and_the_plugin() {
    assert_eq!(newer_of("0.1.0", "0.2.0"), "0.2.0");
    assert_eq!(newer_of("0.3.0", "0.2.0"), "0.3.0");
    assert_eq!(newer_of("0.2.0", "0.2.0"), "0.2.0");
    assert_eq!(newer_of("0.3.0-beta.1", "0.2.1"), "0.3.0-beta.1");
    assert_eq!(newer_of("odd", "0.2.0"), "0.2.0");
    assert_eq!(newer_of("0.3.0", "odd"), "odd");
}

fn applied_update(
    binary: Option<&str>,
    plugin: &str,
    result: &Result<(), String>,
) -> (Result<(), String>, Vec<String>) {
    let folder = tempfile::tempdir().unwrap();
    let app = folder.path().join("app");

    if let Some(version) = binary {
        let script = folder.path().join("bcct");
        let body = format!("#!/bin/sh\necho 'bcct {version}'\n");
        std::fs::write(&script, &body).unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let hash =
            sha2::Sha256::digest(body.as_bytes())
                .iter()
                .fold(String::new(), |mut text, byte| {
                    write!(text, "{byte:02x}").unwrap();
                    text
                });
        Store::new(&app)
            .install(&script, &hash, Origin::Release)
            .unwrap();
    }

    let variables: HashMap<&str, OsString> =
        HashMap::from([("BETTER_CC_TELEGRAM_DIR", app.clone().into_os_string())]);
    let var = |name: &str| variables.get(name).cloned();
    let list = json!([{
        "id": "telegram-hooks@better-claude-code-telegram",
        "version": plugin,
        "installPath": "/cache/hooks"
    }])
    .to_string();
    let asked = RefCell::new(Vec::new());
    let update = |version: &str| {
        asked.borrow_mut().push(version.to_owned());
        result.clone()
    };
    let machine = Machine {
        var: &var,
        home: folder.path(),
        uid: None,
        now: 0,
        git_version: &|| None,
        has_command: &|name| name == "claude",
        claude_output: &|_| list.clone(),
        python_works: &|_| false,
        fetch: &|_, _| None,
        update: &update,
    };
    let paths = SetupPaths::resolve(&var, folder.path());
    let fix = Fix {
        id: FixId::Update,
        target: app.clone(),
    };

    assert_eq!(fix.action(&EN_US), "run 'bcct update'");

    let outcome = apply(&fix, &machine, &paths, &EN_US);

    (outcome, asked.into_inner())
}

#[test]
fn the_update_fix_runs_bcct_update_with_the_newer_version() {
    assert_eq!(
        applied_update(Some("0.1.0"), "0.2.0", &Ok(())),
        (Ok(()), vec!["0.2.0".to_owned()])
    );
    assert_eq!(
        applied_update(Some("0.3.0"), "0.2.0", &Err("offline".to_owned())),
        (Err("offline".to_owned()), vec!["0.3.0".to_owned()])
    );
    assert_eq!(
        applied_update(None, "0.2.0", &Ok(())),
        (Err("not needed".to_owned()), Vec::new())
    );
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
fn the_token_rule_is_only_recommended_while_deny_is_not_a_list() {
    let protection = [
        entry(Check::Protection, Status::Fail),
        entry(Check::Config, Status::Ok),
    ];

    for deny in ["{}", "5", "true"] {
        let settings = format!(r#"{{"permissions":{{"deny":{deny}}}}}"#);

        assert_eq!(
            planned(&protection, "/bin/bash", None, Some(&settings)),
            vec![],
            "{deny}"
        );
    }

    for deny in ["[]", "\"Read(x)\"", "null"] {
        let settings = format!(r#"{{"permissions":{{"deny":{deny}}}}}"#);

        assert_eq!(
            planned(&protection, "/bin/bash", None, Some(&settings)),
            vec![FixId::Protection],
            "{deny}"
        );
    }
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
