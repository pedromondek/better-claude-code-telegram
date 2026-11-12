#![cfg(unix)]
#![cfg(test)]

mod support;

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::thread;

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::locale::Locale;
use bcct::messages::messages_for;
use bcct::prompt::{FakePrompter, Reply};
use bcct::self_install::{Channel, Origin, Store};
use bcct::update::{
    Newest, Request, Screen, Wanted, World, asset_name, failure_line, hash_from_checksums,
    http_download, http_get, npm_platform, parse_dist_tags, parse_plugins, parse_request, platform,
    reason_of, recommended, run_with,
};

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::sandbox;

const NPM: &str = "https://npm.test";
const RELEASES: &str = "https://releases.test";
const DIST_TAGS: &str = "https://npm.test/-/package/better-claude-code-telegram/dist-tags";
const PACKAGE_URL: &str = "https://npm.test/better-claude-code-telegram/";
const HOOKS: &str = "telegram-hooks@better-claude-code-telegram";
const CHANNEL: &str = "telegram@better-claude-code-telegram";
const BCCT: &str = "bcct@better-claude-code-telegram";

fn hash_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut out, byte| {
            write!(out, "{byte:02x}").unwrap();
            out
        })
}

fn binary_answering(version: &str) -> Vec<u8> {
    format!("#!/bin/sh\necho 'bcct {version}'\n").into_bytes()
}

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

struct Fake {
    root: PathBuf,
    app: PathBuf,
    plugins_before: Value,
    plugins_after: RefCell<Option<Value>>,
    updated: RefCell<bool>,
    calls: RefCell<Vec<String>>,
    failing_call: Option<String>,
    responses: HashMap<String, Result<(u16, Vec<u8>), String>>,
    assets: HashMap<String, Result<(u16, Vec<u8>), String>>,
    has_git: bool,
    has_claude: bool,
    lock_versions_after_download: bool,
}

struct Outcome {
    code: u8,
    out: String,
    err: String,
    calls: Vec<String>,
    prompts: Vec<String>,
}

fn plugin_list(version: &str, path: &Path, disabled: &[&str]) -> Value {
    Value::Array(
        [CHANNEL, HOOKS, BCCT, "other@elsewhere"]
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "version": version,
                    "enabled": !disabled.contains(id),
                    "installPath": path.join(version).display().to_string(),
                })
            })
            .collect(),
    )
}

impl Fake {
    fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            app: root.join("app"),
            plugins_before: Value::Null,
            plugins_after: RefCell::new(None),
            updated: RefCell::new(false),
            calls: RefCell::new(Vec::new()),
            failing_call: None,
            responses: HashMap::new(),
            assets: HashMap::new(),
            has_git: true,
            has_claude: true,
            lock_versions_after_download: false,
        }
    }

    fn active(&self, version: &str) {
        let path = self.root.join(format!("installed-{version}"));
        let bytes = binary_answering(version);
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        Store::new(&self.app)
            .install(&path, &hash_of(&bytes), Origin::Npm)
            .unwrap();
    }

    fn tags(mut self, tags: &Value) -> Self {
        self.responses.insert(
            DIST_TAGS.to_owned(),
            Ok((200, tags.to_string().into_bytes())),
        );
        self
    }

    fn plugins(mut self, before: &str, after: Option<&str>, disabled: &[&str]) -> Self {
        let cache = self.root.join("cache");
        self.plugins_before = plugin_list(before, &cache, disabled);
        *self.plugins_after.borrow_mut() = after.map(|after| plugin_list(after, &cache, disabled));
        self
    }

    fn release(mut self, version: &str, answers: &str, recorded_hash: Option<&str>) -> Self {
        let bytes = binary_answering(answers);
        let hash = recorded_hash.map_or_else(|| hash_of(&bytes), str::to_owned);
        let folder = self.root.join("cache").join(version);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("checksums.txt"),
            format!(
                "# version asset sha256\n{version} {} {hash}\n",
                asset_name()
            ),
        )
        .unwrap();
        self.assets.insert(
            format!("{RELEASES}/v{version}/{}", asset_name()),
            Ok((200, bytes)),
        );
        self
    }

    fn run(&self, list: &[&str], replies: Vec<Reply>, interactive: bool) -> Outcome {
        let claude = |call: &[&str]| {
            let joined = call.join(" ");
            self.calls.borrow_mut().push(joined.clone());

            if self
                .failing_call
                .as_deref()
                .is_some_and(|failing| joined.starts_with(failing))
            {
                return format!("Working…\n✘ Failed: {joined}\n");
            }

            if joined == "plugin list --json" {
                let after = self.plugins_after.borrow();
                let list = if *self.updated.borrow() {
                    after.as_ref().unwrap_or(&self.plugins_before)
                } else {
                    &self.plugins_before
                };
                return list.to_string();
            }

            if joined.starts_with("plugin update") || joined.starts_with("plugin install") {
                *self.updated.borrow_mut() = true;
            }

            "✔ Done\n".to_owned()
        };
        let has_command = |name: &str| match name {
            "git" => self.has_git,
            "claude" => self.has_claude,
            _ => false,
        };
        let get = |url: &str| {
            self.responses.get(url).cloned().unwrap_or_else(|| {
                if url.starts_with(PACKAGE_URL) {
                    Ok((404, Vec::new()))
                } else {
                    Err("unexpected".to_owned())
                }
            })
        };
        let download = |url: &str, file: &Path| match self.assets.get(url) {
            Some(Ok((status, bytes))) => {
                fs::write(file, bytes).unwrap();

                if self.lock_versions_after_download {
                    set_mode(&self.app.join("bin/versions"), 0o555);
                }

                Ok(*status)
            }
            Some(Err(reason)) => Err(reason.clone()),
            None => Ok(404),
        };
        let world = World {
            app_dir: &self.app,
            running: "0.1.0",
            claude: &claude,
            has_command: &has_command,
            get: &get,
            download: &download,
            npm_root: NPM,
            releases_root: RELEASES,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut ask = FakePrompter::new(interactive).with_replies(replies);
        let code = run_with(
            &args(list),
            &world,
            messages_for(Locale::EnUs),
            Screen {
                out: &mut out,
                err: &mut err,
                colorize_out: false,
                colorize_err: false,
            },
            &mut ask,
        );
        let prompts = ask.calls().iter().map(|call| format!("{call:?}")).collect();

        Outcome {
            code,
            out: String::from_utf8(out).unwrap(),
            err: String::from_utf8(err).unwrap(),
            calls: self.calls.borrow().clone(),
            prompts,
        }
    }
}

const REPO: &str = "pedromondek/better-claude-code-telegram";

#[test]
fn the_request_takes_one_channel_or_version_and_the_check_flag() {
    let parsed = |list: &[&str]| parse_request(&args(list));

    assert_eq!(
        parsed(&[]),
        Some(Request {
            wanted: Wanted::Default,
            check: false
        })
    );
    assert_eq!(
        parsed(&["beta", "--check"]),
        Some(Request {
            wanted: Wanted::Channel(Channel::Beta),
            check: true
        })
    );
    assert_eq!(
        parsed(&["v0.3.0"]).map(|request| request.wanted),
        Some(Wanted::Version("0.3.0".to_owned()))
    );
    assert_eq!(
        parsed(&["stable"]).map(|request| request.wanted),
        Some(Wanted::Channel(Channel::Stable))
    );
    assert_eq!(
        parsed(&["alpha"]).map(|request| request.wanted),
        Some(Wanted::Channel(Channel::Alpha))
    );
    assert_eq!(parsed(&["beta", "stable"]), None);
    assert_eq!(parsed(&["--yes"]), None);
    assert_eq!(parsed(&["nightly"]), None);
}

#[test]
fn the_dist_tags_give_the_newest_of_each_channel() {
    assert_eq!(
        parse_dist_tags(
            br#"{"latest":"0.2.1","next":"0.3.0-rc.1","beta":"0.3.0-beta.2","alpha":"0.4.0-alpha.1","dev":"9.0.0"}"#
        ),
        Some(Newest {
            stable: Some("0.2.1".to_owned()),
            beta: Some("0.3.0-rc.1".to_owned()),
            alpha: Some("0.4.0-alpha.1".to_owned()),
        })
    );
    assert_eq!(
        parse_dist_tags(br#"{"beta":"0.3.0-beta.2","next":"0.3.0-beta.1"}"#),
        Some(Newest {
            stable: None,
            beta: Some("0.3.0-beta.2".to_owned()),
            alpha: None,
        })
    );
    for tags in [
        br#"{"beta":"0.3.0-beta.1","next":"0.3.0-rc.1"}"#.as_slice(),
        br#"{"next":"0.3.0-rc.1","beta":"0.3.0-beta.1"}"#.as_slice(),
    ] {
        assert_eq!(
            parse_dist_tags(tags).and_then(|newest| newest.beta),
            Some("0.3.0-rc.1".to_owned())
        );
    }
    assert_eq!(
        parse_dist_tags(br#"{"latest":"0.3.0-beta.1","alpha":"1.0.0"}"#),
        Some(Newest::default())
    );
    assert_eq!(parse_dist_tags(br#"{"latest":"<html>"}"#), None);
    assert_eq!(parse_dist_tags(br#"{"latest":3}"#), None);
    assert_eq!(parse_dist_tags(b"[]"), None);
    assert_eq!(parse_dist_tags(b"not json"), None);
}

#[test]
fn the_recommended_channel_is_the_own_one_until_a_stable_catches_up() {
    let newest = Newest {
        stable: Some("0.2.1".to_owned()),
        beta: Some("0.3.0-rc.1".to_owned()),
        alpha: Some("0.4.0-alpha.1".to_owned()),
    };

    assert_eq!(recommended("0.3.0-beta.2", &newest), Channel::Beta);
    assert_eq!(recommended("0.4.0-alpha.1", &newest), Channel::Alpha);
    assert_eq!(recommended("0.2.1-rc.1", &newest), Channel::Stable);
    assert_eq!(
        recommended(
            "0.3.0-beta.2",
            &Newest {
                stable: Some("0.3.0-beta.2".to_owned()),
                ..newest.clone()
            }
        ),
        Channel::Stable
    );
    assert_eq!(
        recommended(
            "0.3.0-beta.2",
            &Newest {
                stable: None,
                beta: None,
                alpha: None
            }
        ),
        Channel::Stable
    );
}

#[test]
fn the_asset_follows_the_npm_platform_names() {
    let expected_os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };

    assert!(
        platform().starts_with(&format!("{expected_os}-")),
        "{}",
        platform()
    );
    assert_eq!(asset_name(), format!("bcct-{}", platform()));
}

#[test]
fn the_checksums_file_is_read_by_version_and_asset() {
    let text = "# version asset sha256\n0.2.0 bcct-linux-x64 aaa\n0.3.0 bcct-darwin-arm64 bbb\n0.3.0 bcct-linux-x64 ccc\nbroken line\n";

    assert_eq!(
        hash_from_checksums(text, "0.3.0", "bcct-linux-x64").as_deref(),
        Some("ccc")
    );
    assert_eq!(hash_from_checksums(text, "0.4.0", "bcct-linux-x64"), None);
    assert_eq!(
        hash_from_checksums("# 0.3.0 bcct-linux-x64 ddd", "0.3.0", "bcct-linux-x64"),
        None
    );
}

#[test]
fn the_plugin_list_keeps_ours_and_the_hooks_folder() {
    let folder = PathBuf::from("/cache");
    let parsed = parse_plugins(&plugin_list("0.2.1", &folder, &[BCCT]).to_string()).unwrap();

    assert_eq!(
        parsed.ids,
        vec![
            (CHANNEL.to_owned(), true),
            (HOOKS.to_owned(), true),
            (BCCT.to_owned(), false)
        ]
    );
    assert_eq!(parsed.hooks_version, "0.2.1");
    assert_eq!(parsed.hooks_path, folder.join("0.2.1"));
    let mixed = json!([
        { "id": CHANNEL, "version": "0.1.0", "installPath": "/cache/channel" },
        { "id": HOOKS, "version": "0.2.1", "installPath": "/cache/hooks" },
        { "id": BCCT, "version": "0.1.9", "installPath": "/cache/bcct" },
    ]);
    let hooks = parse_plugins(&mixed.to_string()).unwrap();

    assert_eq!(hooks.hooks_version, "0.2.1");
    assert_eq!(hooks.hooks_path, PathBuf::from("/cache/hooks"));
    assert_eq!(parse_plugins("[]"), None);
    assert_eq!(parse_plugins("{}"), None);
    assert_eq!(parse_plugins("nope"), None);
    assert_eq!(
        parse_plugins(&json!([{ "id": HOOKS, "version": "0.2.1" }]).to_string()),
        None
    );
}

#[test]
fn the_failure_line_is_the_first_one_with_the_cross() {
    assert_eq!(
        failure_line("Cloning…\n  ✘ Failed to add marketplace: x\n✘ second\n").as_deref(),
        Some("Failed to add marketplace: x")
    );
    assert_eq!(failure_line("✔ Successfully updated\n"), None);
}

#[test]
fn a_newer_stable_updates_the_plugins_in_place_and_then_the_binary() {
    let folder = sandbox();
    let fake = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.3.0" }))
        .plugins("0.2.1", Some("0.3.0"), &[])
        .release("0.3.0", "0.3.0", None);
    fake.active("0.2.1");

    let outcome = fake.run(&[], Vec::new(), false);

    assert_eq!(outcome.err, "");
    assert_eq!(outcome.code, 0);
    assert_eq!(
        outcome.out,
        "Looking for versions on npm\n\
         ✔ Plugins: 0.2.1 → 0.3.0\n\
         ✔ Binary: 0.2.1 → 0.3.0\n\
         It applies to new Claude Code sessions; in open ones, run /reload-plugins.\n"
    );
    assert_eq!(
        outcome.calls,
        vec![
            "plugin list --json".to_owned(),
            "plugin marketplace update better-claude-code-telegram".to_owned(),
            format!("plugin update {CHANNEL}"),
            format!("plugin update {HOOKS}"),
            format!("plugin update {BCCT}"),
            "plugin list --json".to_owned(),
        ]
    );
    assert_eq!(Store::new(&fake.app).current().as_deref(), Some("0.3.0"));
}

#[test]
fn the_newest_stable_already_in_place_changes_nothing() {
    let folder = sandbox();
    let fake = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.2.1" }))
        .plugins("0.2.1", None, &[]);
    fake.active("0.2.1");

    let outcome = fake.run(&[], Vec::new(), false);

    assert_eq!(outcome.code, 0);
    assert_eq!(
        outcome.out,
        "Looking for versions on npm\n○ Already on 0.2.1, the newest stable.\n"
    );
    assert_eq!(outcome.calls, vec!["plugin list --json".to_owned()]);

    let mut by_name = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.3.0" }))
        .plugins("0.2.1", None, &[]);
    by_name
        .responses
        .insert(format!("{PACKAGE_URL}0.2.1"), Ok((200, b"{}".to_vec())));

    assert_eq!(
        by_name.run(&["0.2.1"], Vec::new(), false).out,
        "Looking for versions on npm\n○ Already on 0.2.1.\n"
    );
}

#[test]
fn the_check_only_says_what_would_change() {
    let folder = sandbox();
    let fake = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.3.0" }))
        .plugins("0.2.1", None, &[]);
    fake.active("0.2.1");

    let outcome = fake.run(&["--check"], Vec::new(), false);

    assert_eq!(outcome.code, 0);
    assert_eq!(
        outcome.out,
        "Looking for versions on npm\nWould update from 0.2.1 to 0.3.0 (plugins and binary).\n"
    );
    assert_eq!(outcome.calls, vec!["plugin list --json".to_owned()]);
}

#[test]
fn switching_to_a_test_version_registers_the_marketplace_again_and_keeps_what_was_off() {
    let folder = sandbox();
    let fake = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.2.1", "beta": "0.3.0-beta.2" }))
        .plugins("0.2.1", Some("0.3.0-beta.2"), &[BCCT])
        .release("0.3.0-beta.2", "0.3.0-beta.2", None);
    fake.active("0.2.1");

    let outcome = fake.run(&["beta"], Vec::new(), false);

    assert_eq!(outcome.err, "");
    assert_eq!(outcome.code, 0);
    assert_eq!(
        outcome.out,
        "Looking for versions on npm\n\
         ℹ Switching channel: #stable → #v0.3.0-beta.2\n\
         ✔ Plugins: 0.2.1 → 0.3.0-beta.2\n\
         ✔ Binary: 0.2.1 → 0.3.0-beta.2\n\
         It applies to new Claude Code sessions; in open ones, run /reload-plugins.\n\
         ⚠ Test version (beta). For the stable one: 'bcct update stable'.\n"
    );
    assert_eq!(
        outcome.calls,
        vec![
            "plugin list --json".to_owned(),
            "plugin marketplace remove better-claude-code-telegram".to_owned(),
            format!("plugin marketplace add {REPO}#v0.3.0-beta.2"),
            format!("plugin install {CHANNEL} --scope user"),
            format!("plugin install {HOOKS} --scope user"),
            format!("plugin install {BCCT} --scope user"),
            format!("plugin disable {BCCT} --scope user"),
            "plugin list --json".to_owned(),
        ]
    );
}

fn unstable_fake(root: &Path) -> Fake {
    let fake = Fake::new(root)
        .tags(&json!({
            "latest": "0.2.1",
            "beta": "0.3.0-beta.2",
            "alpha": "0.4.0-alpha.1"
        }))
        .plugins("0.3.0-beta.1", Some("0.3.0-beta.2"), &[])
        .release("0.3.0-beta.2", "0.3.0-beta.2", None);
    fake.active("0.4.0-alpha.1");
    fake.active("0.3.0-beta.1");

    fake
}

#[test]
fn a_test_version_asks_which_channel_and_offers_to_clean_the_old_ones() {
    let folder = sandbox();
    let fake = unstable_fake(folder.path());

    let outcome = fake.run(
        &[],
        vec![
            Reply::Text("9".to_owned()),
            Reply::Text("x".to_owned()),
            Reply::Text(String::new()),
            Reply::Text("s".to_owned()),
        ],
        true,
    );

    assert_eq!(outcome.err, "");
    assert_eq!(outcome.code, 0);
    assert_eq!(
        outcome.out,
        "Looking for versions on npm\n\
         You are on a test version (beta 0.3.0-beta.1).\n  \
         1. Newest alpha: 0.4.0-alpha.1\n  \
         2. Newest beta: 0.3.0-beta.2\n  \
         3. Newest stable: 0.2.1\n\
         ℹ Switching channel: #v0.3.0-beta.1 → #v0.3.0-beta.2\n\
         ✔ Plugins: 0.3.0-beta.1 → 0.3.0-beta.2\n\
         ✔ Binary: 0.3.0-beta.1 → 0.3.0-beta.2\n\
         ✔ Deleted 0.3.0-beta.1 and 0.4.0-alpha.1.\n\
         It applies to new Claude Code sessions; in open ones, run /reload-plugins.\n\
         ⚠ Test version (beta). For the stable one: 'bcct update stable'.\n"
    );
    assert_eq!(outcome.prompts.len(), 4, "{:?}", outcome.prompts);
    assert!(
        outcome.prompts[0].contains("Which one? (1, 2, 3; Enter: 2):"),
        "{:?}",
        outcome.prompts
    );
    assert!(
        outcome.prompts[3].contains(
            "There are 3 test versions kept (0.3.0-beta.1, 0.3.0-beta.2, 0.4.0-alpha.1). Delete the ones not in use? (y/N):"
        ),
        "{:?}",
        outcome.prompts
    );
    assert_eq!(
        Store::new(&fake.app).unstable_versions(),
        vec!["0.3.0-beta.2"]
    );
}

#[test]
fn outside_a_terminal_the_cleanup_is_never_asked() {
    let folder = sandbox();
    let fake = unstable_fake(folder.path());

    let outcome = fake.run(&["beta"], Vec::new(), false);

    assert_eq!(outcome.code, 0, "{}", outcome.err);
    assert_eq!(outcome.prompts, Vec::<String>::new());
    assert_eq!(Store::new(&fake.app).unstable_versions().len(), 3);
}

#[test]
fn a_test_version_picked_by_number_and_a_declined_cleanup_keep_everything() {
    let folder = sandbox();
    let fake = unstable_fake(folder.path());

    let outcome = fake.run(
        &[],
        vec![Reply::Text(" 2 ".to_owned()), Reply::Text("n".to_owned())],
        true,
    );

    assert_eq!(outcome.code, 0);
    assert!(!outcome.out.contains("Deleted"), "{}", outcome.out);
    assert_eq!(Store::new(&fake.app).unstable_versions().len(), 3);
}

#[test]
fn a_cancelled_choice_or_cleanup_stops_quietly() {
    let folder = sandbox();
    let fake = unstable_fake(folder.path());

    let cancelled = fake.run(&[], vec![Reply::Cancel], true);

    assert_eq!(cancelled.code, 0);
    assert_eq!(cancelled.calls, Vec::<String>::new());

    let kept = fake.run(&[], vec![Reply::Text("2".to_owned()), Reply::Cancel], true);

    assert_eq!(kept.code, 0);
    assert!(!kept.out.contains("Deleted"), "{}", kept.out);
}

#[test]
fn the_current_test_version_is_marked_when_nothing_newer_exists() {
    let folder = sandbox();
    let fake = Fake::new(folder.path())
        .tags(&json!({ "beta": "0.3.0-beta.1" }))
        .plugins("0.3.0-beta.1", None, &[]);
    fake.active("0.3.0-beta.1");

    let outcome = fake.run(&[], vec![Reply::Text(String::new())], true);

    assert_eq!(outcome.code, 0);
    assert!(
        outcome
            .out
            .contains("  1. Newest beta: 0.3.0-beta.1 (the current one)\n"),
        "{}",
        outcome.out
    );
    assert!(
        outcome.out.ends_with("○ Already on 0.3.0-beta.1.\n"),
        "{}",
        outcome.out
    );
}

#[test]
fn outside_a_terminal_a_test_version_only_shows_the_commands() {
    let folder = sandbox();
    let fake = unstable_fake(folder.path());

    let outcome = fake.run(&[], Vec::new(), false);

    assert_eq!(outcome.code, 0);
    assert_eq!(
        outcome.out,
        "Looking for versions on npm\n\
         ○ Test version 0.3.0-beta.1. Pick with 'bcct update alpha' (0.4.0-alpha.1), 'bcct update beta' (0.3.0-beta.2) or 'bcct update stable' (0.2.1).\n"
    );
    assert_eq!(outcome.calls, Vec::<String>::new());
}

fn failed(fake: &Fake, list: &[&str]) -> String {
    let outcome = fake.run(list, Vec::new(), false);

    assert_eq!(outcome.code, 1, "{}", outcome.out);
    outcome.err
}

#[test]
fn a_broken_version_list_is_reported_without_changing_anything() {
    let folder = sandbox();
    let mut fake = Fake::new(folder.path()).plugins("0.2.1", None, &[]);

    fake.responses
        .insert(DIST_TAGS.to_owned(), Err("timed out".to_owned()));
    assert_eq!(
        failed(&fake, &[]),
        "✘ Could not fetch the versions from npm (timed out). Try again.\n"
    );

    fake.responses
        .insert(DIST_TAGS.to_owned(), Ok((500, Vec::new())));
    assert_eq!(
        failed(&fake, &[]),
        "✘ Could not fetch the versions from npm (HTTP 500). Try again.\n"
    );

    let bad = "✘ The version list came in an unexpected format. Try again in a moment.\n";

    fake.responses
        .insert(DIST_TAGS.to_owned(), Ok((404, Vec::new())));
    assert_eq!(failed(&fake, &[]), bad);

    fake.responses
        .insert(DIST_TAGS.to_owned(), Ok((200, b"<html>".to_vec())));
    assert_eq!(failed(&fake, &[]), bad);
    assert_eq!(fake.calls.borrow().len(), 0);
}

#[test]
fn a_missing_version_or_channel_names_what_exists() {
    let folder = sandbox();
    let mut fake = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.2.1", "beta": "0.3.0-rc.1" }))
        .plugins("0.2.1", None, &[]);

    assert_eq!(
        failed(&fake, &["9.9.9"]),
        "✘ Version 9.9.9 does not exist. Newest: stable 0.2.1, beta 0.3.0-rc.1.\n"
    );
    assert_eq!(
        failed(&fake, &["alpha"]),
        "✘ There is no alpha version yet.\n"
    );

    fake.responses.insert(
        format!("{PACKAGE_URL}9.9.9"),
        Err("connection failed".to_owned()),
    );
    assert_eq!(
        failed(&fake, &["9.9.9"]),
        "✘ Could not fetch the versions from npm (connection failed). Try again.\n"
    );

    let empty = Fake::new(folder.path())
        .tags(&json!({}))
        .plugins("0.2.1", None, &[]);
    assert_eq!(failed(&empty, &[]), "✘ There is no stable version yet.\n");
}

#[test]
fn missing_plugins_claude_or_git_stop_before_any_change() {
    let folder = sandbox();
    let base = || {
        Fake::new(folder.path())
            .tags(&json!({ "latest": "0.3.0" }))
            .plugins("0.2.1", None, &[])
    };
    let no_plugins = "✘ The plugins are not installed. Run 'npx better-claude-code-telegram'.\n";

    let mut without_claude = base();
    without_claude.has_claude = false;
    assert_eq!(failed(&without_claude, &[]), no_plugins);

    let mut without_hooks = base();
    without_hooks.plugins_before = json!([{ "id": CHANNEL, "version": "0.2.1" }]);
    assert_eq!(failed(&without_hooks, &[]), no_plugins);

    let mut without_git = base();
    without_git.has_git = false;
    assert_eq!(
        failed(&without_git, &[]),
        "✘ git is not installed, and Claude Code needs it to update the plugins. Install git and run 'bcct update' again.\n"
    );
    assert_eq!(without_git.calls.borrow().len(), 1);
}

#[test]
fn a_claude_step_that_fails_stops_with_its_line() {
    let folder = sandbox();
    let mut fake = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.3.0" }))
        .plugins("0.2.1", Some("0.3.0"), &[]);
    fake.failing_call = Some(format!("plugin update {HOOKS}"));

    assert_eq!(
        failed(&fake, &[]),
        format!("✘ Plugins: Failed: plugin update {HOOKS}. Run 'bcct update' again.\n")
    );
    assert!(
        !fake
            .calls
            .borrow()
            .contains(&format!("plugin update {BCCT}"))
    );
}

#[test]
fn plugins_that_stay_behind_or_bring_no_hash_stop_before_the_binary() {
    let folder = sandbox();
    let stayed = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.3.0" }))
        .plugins("0.2.1", Some("0.2.1"), &[]);

    assert_eq!(
        failed(&stayed, &[]),
        "✘ The telegram-hooks plugin stayed on 0.2.1, not 0.3.0. Run 'bcct update' again.\n"
    );

    let no_hash = Fake::new(folder.path())
        .tags(&json!({ "latest": "0.3.0" }))
        .plugins("0.2.1", Some("0.3.0"), &[]);

    assert_eq!(
        failed(&no_hash, &[]),
        format!("✘ Plugin 0.3.0 has no binary hash for {}.\n", platform())
    );
}

#[test]
fn a_binary_that_fails_to_download_or_install_keeps_the_old_one_active() {
    let folder = sandbox();
    let make = |answers: &str, hash: Option<&str>| {
        let fake = Fake::new(folder.path())
            .tags(&json!({ "latest": "0.3.0" }))
            .plugins("0.3.0", None, &[])
            .release("0.3.0", answers, hash);
        fake.active("0.2.1");
        fake
    };
    let tail = "The plugins are already on 0.3.0. Run 'bcct update' again.\n";

    let mut unreachable = make("0.3.0", None);
    unreachable.assets.insert(
        format!("{RELEASES}/v0.3.0/{}", asset_name()),
        Err("timed out".to_owned()),
    );
    assert_eq!(
        failed(&unreachable, &[]),
        format!("✘ Binary: could not download 0.3.0 from GitHub (timed out). {tail}")
    );

    let mut missing = make("0.3.0", None);
    missing.assets.clear();
    assert_eq!(
        failed(&missing, &[]),
        format!("✘ Binary: could not download 0.3.0 from GitHub (HTTP 404). {tail}")
    );

    let zeros = "0".repeat(64);
    assert_eq!(
        failed(&make("0.3.0", Some(&zeros)), &[]),
        format!("✘ Binary: could not install 0.3.0 (hash mismatch). {tail}")
    );
    assert_eq!(
        failed(&make("other", None), &[]),
        format!("✘ Binary: could not install 0.3.0 (did not answer as bcct 0.3.0). {tail}")
    );
    assert_eq!(
        Store::new(&folder.path().join("app")).current().as_deref(),
        Some("0.2.1")
    );
}

#[test]
fn a_versions_folder_without_write_permission_fails_the_binary_step() {
    let folder = sandbox();
    let tail = "The plugins are already on 0.3.0. Run 'bcct update' again.\n";
    let make = || {
        let fake = Fake::new(folder.path())
            .tags(&json!({ "latest": "0.3.0" }))
            .plugins("0.3.0", None, &[])
            .release("0.3.0", "0.3.0", None);
        fake.active("0.2.1");
        fake
    };
    let versions = folder.path().join("app/bin/versions");

    let before = make();
    set_mode(&versions, 0o555);
    let locked = failed(&before, &[]);
    set_mode(&versions, 0o755);

    assert_eq!(
        locked,
        format!("✘ Binary: could not download 0.3.0 from GitHub (permission denied). {tail}")
    );

    let mut during = make();
    during.lock_versions_after_download = true;
    let installing = failed(&during, &[]);
    set_mode(&versions, 0o755);

    assert_eq!(
        installing,
        format!("✘ Binary: could not install 0.3.0 (permission denied). {tail}")
    );
}

#[test]
fn a_single_test_channel_is_offered_alone_outside_a_terminal() {
    let folder = sandbox();
    let fake = Fake::new(folder.path())
        .tags(&json!({ "beta": "0.3.0-beta.2" }))
        .plugins("0.3.0-beta.1", None, &[]);
    fake.active("0.3.0-beta.1");

    assert_eq!(
        fake.run(&[], Vec::new(), false).out,
        "Looking for versions on npm\n\
         ○ Test version 0.3.0-beta.1. Pick with 'bcct update beta' (0.3.0-beta.2).\n"
    );
}

#[test]
fn the_npm_platform_names_follow_the_npm_packages() {
    assert_eq!(npm_platform("linux", "x86_64"), "linux-x64");
    assert_eq!(npm_platform("macos", "aarch64"), "darwin-arm64");
    assert_eq!(npm_platform("windows", "x86_64"), "win32-x64");
    assert_eq!(npm_platform("freebsd", "riscv64"), "freebsd-riscv64");
}

#[test]
fn the_http_errors_become_a_short_reason() {
    assert_eq!(
        reason_of(&ureq::Error::Timeout(ureq::Timeout::Global)),
        "timed out"
    );
    assert_eq!(
        reason_of(&ureq::Error::Io(std::io::Error::from(
            std::io::ErrorKind::ConnectionRefused
        ))),
        "connection refused"
    );
    assert_eq!(reason_of(&ureq::Error::HostNotFound), "host not found");
    assert_eq!(
        reason_of(&ureq::Error::ConnectionFailed),
        "connection failed"
    );
    assert_eq!(reason_of(&ureq::Error::TooManyRedirects), "request failed");
}

#[test]
fn the_world_and_the_screen_show_only_their_plain_fields() {
    let folder = sandbox();
    let world = World {
        app_dir: folder.path(),
        running: "0.1.0",
        claude: &|_| String::new(),
        has_command: &|_| false,
        get: &|_| Err(String::new()),
        download: &|_, _| Ok(200),
        npm_root: NPM,
        releases_root: RELEASES,
    };
    let mut out = Vec::new();
    let mut err = Vec::new();
    let screen = Screen {
        out: &mut out,
        err: &mut err,
        colorize_out: true,
        colorize_err: false,
    };

    assert!(format!("{world:?}").contains("npm_root: \"https://npm.test\""));
    assert!(format!("{screen:?}").contains("colorize_out: true"));
}

#[test]
fn wrong_arguments_show_the_usage_and_exit_2() {
    let folder = sandbox();
    let fake = Fake::new(folder.path());

    for list in [vec!["--yes"], vec!["beta", "alpha"], vec!["nightly"]] {
        let outcome = fake.run(&list, Vec::new(), false);

        assert_eq!(outcome.code, 2, "{list:?}");
        assert_eq!(
            outcome.err,
            "Usage: bcct update [stable|beta|alpha|<version>] [--check]\n"
        );
        assert_eq!(outcome.out, "");
    }
}

fn serve(responses: Vec<String>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();

    thread::spawn(move || {
        for (stream, response) in listener.incoming().zip(responses) {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();

            while reader.read_line(&mut line).unwrap() > 0 && line != "\r\n" {
                line.clear();
            }

            let _written = stream.write_all(response.as_bytes());
        }
    });

    format!("http://{address}")
}

fn response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn the_http_helpers_return_the_status_and_the_body() {
    let root = serve(vec![
        response("200 OK", "{\"latest\":\"0.3.0\"}"),
        response("404 Not Found", ""),
        response("200 OK", "binary bytes"),
        response("404 Not Found", ""),
    ]);
    let folder = sandbox();
    let file = folder.path().join("downloaded");

    assert_eq!(
        http_get(&format!("{root}/tags")),
        Ok((200, b"{\"latest\":\"0.3.0\"}".to_vec()))
    );
    assert_eq!(
        http_get(&format!("{root}/missing")).map(|(status, _)| status),
        Ok(404)
    );
    assert_eq!(http_download(&format!("{root}/asset"), &file), Ok(200));
    assert_eq!(fs::read(&file).unwrap(), b"binary bytes");
    assert_eq!(
        http_download(&format!("{root}/gone"), &folder.path().join("gone")),
        Ok(404)
    );
    assert!(!folder.path().join("gone").exists());
}

#[test]
fn the_http_helpers_take_a_list_and_a_binary_bigger_than_a_few_kilobytes() {
    let list = format!("{{\"latest\":\"{}\"}}", "0".repeat(8 * 1024));
    let binary = "b".repeat(2 * 1024 * 1024);
    let root = serve(vec![response("200 OK", &list), response("200 OK", &binary)]);
    let folder = sandbox();
    let file = folder.path().join("big");

    assert_eq!(
        http_get(&format!("{root}/tags")).map(|(_, body)| body.len()),
        Ok(list.len())
    );
    assert_eq!(http_download(&format!("{root}/asset"), &file), Ok(200));
    assert_eq!(fs::metadata(&file).unwrap().len(), 2 * 1024 * 1024);
}

#[test]
fn the_http_helpers_fail_on_a_body_too_big_cut_short_or_with_nowhere_to_go() {
    let big = "x".repeat(2 * 1024 * 1024);
    let root = serve(vec![
        response("200 OK", &big),
        response("200 OK", "binary"),
        "HTTP/1.1 200 OK\r\ncontent-length: 100\r\nconnection: close\r\n\r\nshort".to_owned(),
    ]);
    let folder = sandbox();

    assert_eq!(
        http_get(&format!("{root}/tags")),
        Err("request failed".to_owned())
    );
    assert_eq!(
        http_download(
            &format!("{root}/asset"),
            &folder.path().join("missing/file")
        ),
        Err("entity not found".to_owned())
    );
    assert!(http_download(&format!("{root}/cut"), &folder.path().join("cut")).is_err());
}

#[test]
fn the_http_helpers_turn_connection_errors_into_a_short_reason() {
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let folder = sandbox();

    assert!(http_get(&format!("{closed}/tags")).is_err());
    assert!(http_download(&format!("{closed}/asset"), &folder.path().join("x")).is_err());
    assert!(http_get("http://bcct.invalid/tags").is_err());
}

#[test]
fn the_update_command_reads_the_roots_from_the_environment() {
    let folder = sandbox();
    let root = serve(vec![response("500 Internal Server Error", "")]);

    let output = cargo_bin_cmd!("bcct")
        .arg("update")
        .env("HOME", folder.path().join("home"))
        .env("CLAUDE_CONFIG_DIR", folder.path().join("claude"))
        .env("BETTER_CC_TELEGRAM_NPM_ROOT", format!("{root}/"))
        .env("BETTER_CC_TELEGRAM_RELEASES_ROOT", "")
        .env_remove("BETTER_CC_TELEGRAM_DIR")
        .env_remove("LC_MESSAGES")
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "Looking for versions on npm\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        "✘ Could not fetch the versions from npm (HTTP 500). Try again.\n"
    );

    let bin = folder.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let called = folder.path().join("claude-called");
    fs::write(
        bin.join("claude"),
        format!(
            "#!/bin/sh\n: > '{}'\necho '[]'\necho 'note' >&2\n",
            called.display()
        ),
    )
    .unwrap();
    set_mode(&bin.join("claude"), 0o755);
    std::os::unix::fs::symlink("/bin/sh", bin.join("sh")).unwrap();
    let tags = serve(vec![response("200 OK", "{\"latest\":\"0.3.0\"}")]);
    let listed = cargo_bin_cmd!("bcct")
        .arg("update")
        .env("PATH", &bin)
        .env("HOME", folder.path().join("home"))
        .env("CLAUDE_CONFIG_DIR", folder.path().join("claude"))
        .env("BETTER_CC_TELEGRAM_NPM_ROOT", &tags)
        .env_remove("BETTER_CC_TELEGRAM_DIR")
        .env_remove("LC_MESSAGES")
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .output()
        .unwrap();

    assert_eq!(listed.status.code(), Some(1));
    assert!(called.exists());
    assert_eq!(
        String::from_utf8_lossy(&listed.stderr),
        "✘ The plugins are not installed. Run 'npx better-claude-code-telegram'.\n"
    );

    let usage = cargo_bin_cmd!("bcct")
        .args(["update", "--yes"])
        .env("HOME", folder.path().join("home"))
        .env("CLAUDE_CONFIG_DIR", folder.path().join("claude"))
        .env_remove("BETTER_CC_TELEGRAM_DIR")
        .output()
        .unwrap();

    assert_eq!(usage.status.code(), Some(2));
}
