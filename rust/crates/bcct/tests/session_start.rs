#![cfg(unix)]
#![cfg(test)]

mod support;

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::Path;

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::locale::Locale;
use bcct::messages::messages_for;
use bcct::session_start::{PLUGIN_DIR_ENV, notice, plugin_version, run};
use serde_json::{Value, json};
use support::sandbox;

fn plugin_at(root: &Path, version: &str) -> std::path::PathBuf {
    let dir = root.join("plugin");
    fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
    fs::write(
        dir.join(".claude-plugin/plugin.json"),
        json!({ "name": "telegram-hooks", "version": version }).to_string(),
    )
    .unwrap();
    dir
}

fn shown(root: &Path, variables: &[(&str, OsString)], binary: &str) -> String {
    let variables: HashMap<String, OsString> = variables
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect();
    let mut out = Vec::new();

    run(
        &|name| variables.get(name).cloned(),
        &root.join("app"),
        binary,
        &mut out,
    );

    String::from_utf8(out).unwrap()
}

#[test]
fn the_plugin_version_comes_from_its_manifest() {
    let folder = sandbox();
    let root = folder.path();

    assert_eq!(
        plugin_version(&plugin_at(root, "0.3.0")).as_deref(),
        Some("0.3.0")
    );
    assert_eq!(plugin_version(&root.join("missing")), None);

    fs::write(root.join("plugin/.claude-plugin/plugin.json"), "{").unwrap();
    assert_eq!(plugin_version(&root.join("plugin")), None);

    fs::write(root.join("plugin/.claude-plugin/plugin.json"), "{}").unwrap();
    assert_eq!(plugin_version(&root.join("plugin")), None);
}

#[test]
fn a_different_version_warns_the_user_and_tells_claude() {
    let output: Value =
        serde_json::from_str(&notice("0.2.0", "0.1.0", messages_for(Locale::PtBr)).unwrap())
            .unwrap();

    assert_eq!(
        output,
        json!({
            "systemMessage": "bcct: o plugin está na 0.2.0 e o binário na 0.1.0. Rode 'bcct update'.",
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": "better-claude-code-telegram: plugin 0.2.0, binary 0.1.0. Tell the user and recommend running 'bcct update'."
            }
        })
    );
    assert!(
        notice("0.2.0", "0.1.0", messages_for(Locale::EnUs))
            .unwrap()
            .contains("bcct: the plugin is on 0.2.0 and the binary on 0.1.0. Run 'bcct update'.")
    );
    assert_eq!(notice("0.2.0", "0.2.0", messages_for(Locale::EnUs)), None);
}

#[test]
fn the_hook_stays_quiet_when_the_versions_match_or_the_plugin_is_unknown() {
    let folder = sandbox();
    let root = folder.path();
    let plugin = plugin_at(root, "0.2.0").into_os_string();

    assert_eq!(
        shown(root, &[(PLUGIN_DIR_ENV, plugin.clone())], "0.2.0"),
        ""
    );
    assert_eq!(shown(root, &[], "0.1.0"), "");
    assert_eq!(
        shown(
            root,
            &[(PLUGIN_DIR_ENV, root.join("missing").into_os_string())],
            "0.1.0"
        ),
        ""
    );
    assert!(shown(root, &[(PLUGIN_DIR_ENV, plugin)], "0.1.0").starts_with("{\"systemMessage\":"));
}

#[test]
fn the_hook_subcommand_compares_the_plugin_with_the_running_binary() {
    let folder = sandbox();
    let root = folder.path();
    let plugin = plugin_at(root, "9.9.9");

    let output = cargo_bin_cmd!("bcct")
        .args(["hook", "session-start"])
        .env("HOME", root.join("home"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env(PLUGIN_DIR_ENV, &plugin)
        .env_remove("BETTER_CC_TELEGRAM_DIR")
        .env_remove("BETTER_CC_TELEGRAM")
        .env_remove("LC_MESSAGES")
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .write_stdin("{\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}")
        .output()
        .unwrap();
    let shown: Value = serde_json::from_slice(&output.stdout).unwrap();

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        shown["systemMessage"],
        format!(
            "bcct: the plugin is on 9.9.9 and the binary on {}. Run 'bcct update'.",
            env!("CARGO_PKG_VERSION")
        )
    );
}
