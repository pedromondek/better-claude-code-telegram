#![cfg(unix)]
#![cfg(test)]

mod support;

use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::self_install::{
    Channel, InstallError, Kept, LAUNCHER_CMD, LAUNCHER_SH, Origin, RemoveError, Store,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use support::sandbox;

fn hash_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut out, byte| {
            write!(out, "{byte:02x}").unwrap();
            out
        })
}

fn fake_binary(folder: &Path, answer: &str) -> (PathBuf, String) {
    let path = folder.join(format!("fake-{}", hash_of(answer.as_bytes())));
    let script = format!(
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{answer}'; exit 0; fi\necho \"ran $*\"\n"
    );
    fs::write(&path, &script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();

    (path, hash_of(script.as_bytes()))
}

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn entries(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(path)
        .map(|list| {
            list.map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn install(store: &Store, root: &Path, version: &str) {
    let (binary, hash) = fake_binary(root, &format!("bcct {version}"));
    store.install(&binary, &hash, Origin::Release).unwrap();
}

#[test]
fn the_channel_comes_from_the_suffix_of_the_version() {
    assert_eq!(Channel::of("0.1.0"), Channel::Stable);
    assert_eq!(Channel::of("1.2.3"), Channel::Stable);
    assert_eq!(Channel::of("0.1.0-alpha.1"), Channel::Alpha);
    assert_eq!(Channel::of("0.1.0-beta.2"), Channel::Beta);
    assert_eq!(Channel::of("0.1.0-rc.1"), Channel::Beta);

    assert_eq!(Channel::Stable.folder(), "stable");
    assert_eq!(Channel::Beta.folder(), "unstable/beta");
    assert_eq!(Channel::Alpha.folder(), "unstable/alpha");

    assert!(!Channel::Stable.is_unstable());
    assert!(Channel::Beta.is_unstable());
    assert!(Channel::Alpha.is_unstable());

    assert_eq!(Channel::Stable.name(), "stable");
    assert_eq!(Channel::Beta.name(), "beta");
    assert_eq!(Channel::Alpha.name(), "alpha");
}

#[test]
fn installing_a_version_copies_it_checks_it_and_makes_it_the_active_one() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    let (binary, hash) = fake_binary(root, "bcct 0.2.0-beta.1");

    let installed = store.install(&binary, &hash, Origin::Npm).unwrap();

    assert_eq!(installed.version, "0.2.0-beta.1");
    assert_eq!(installed.channel, Channel::Beta);

    let bin = app_dir.join("bin");
    let version_dir = bin.join("versions/unstable/beta/0.2.0-beta.1");
    assert_eq!(entries(&version_dir), vec![".verified", "bcct"]);
    assert_eq!(mode_of(&version_dir.join("bcct")), 0o755);
    assert_eq!(
        fs::read_to_string(version_dir.join(".verified")).unwrap(),
        format!("{hash}\n")
    );
    assert_eq!(
        fs::read(version_dir.join("bcct")).unwrap(),
        fs::read(&binary).unwrap()
    );
    assert_eq!(
        fs::read_to_string(bin.join("current")).unwrap(),
        "unstable/beta/0.2.0-beta.1\n"
    );
    assert_eq!(store.current().as_deref(), Some("0.2.0-beta.1"));

    let receipt: Value =
        serde_json::from_str(&fs::read_to_string(bin.join("install.json")).unwrap()).unwrap();
    assert_eq!(
        receipt,
        serde_json::json!({"origin": "npm", "version": "0.2.0-beta.1", "channel": "beta"})
    );

    assert_eq!(fs::read_to_string(bin.join("bcct")).unwrap(), LAUNCHER_SH);
    assert_eq!(mode_of(&bin.join("bcct")), 0o755);
    assert_eq!(
        fs::read_to_string(bin.join("bcct.cmd")).unwrap(),
        LAUNCHER_CMD
    );
    assert_eq!(
        entries(&bin.join("versions/unstable/beta")),
        vec!["0.2.0-beta.1"]
    );
}

#[test]
fn a_file_that_does_not_match_the_hash_is_refused_and_leaves_nothing_behind() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    let (binary, _) = fake_binary(root, "bcct 0.2.0");

    let failure = store
        .install(&binary, &"0".repeat(64), Origin::Release)
        .unwrap_err();

    assert!(matches!(failure, InstallError::HashMismatch));
    assert!(!app_dir.join("bin/current").exists());
    assert_eq!(
        entries(&app_dir.join("bin/versions/stable")),
        Vec::<String>::new()
    );
}

#[test]
fn the_hash_is_compared_without_caring_about_letter_case() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&root.join("app"));
    let (binary, hash) = fake_binary(root, "bcct 0.2.0");

    let installed = store
        .install(&binary, &hash.to_uppercase(), Origin::Release)
        .unwrap();

    assert_eq!(installed.version, "0.2.0");
}

#[test]
fn a_file_that_does_not_answer_as_bcct_is_refused_and_leaves_nothing_behind() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);

    for answer in ["other 0.2.0", "bcct not-a-version", "bcct", ""] {
        let (binary, hash) = fake_binary(root, answer);
        let failure = store.install(&binary, &hash, Origin::Release).unwrap_err();

        assert!(matches!(failure, InstallError::NotBcct), "{answer}");
    }

    assert!(!app_dir.join("bin/current").exists());
    for channel in [Channel::Stable, Channel::Beta, Channel::Alpha] {
        assert_eq!(
            entries(&app_dir.join("bin/versions").join(channel.folder())),
            Vec::<String>::new()
        );
    }
}

#[test]
fn a_missing_file_is_refused_as_unreadable() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&root.join("app"));

    let failure = store
        .install(&root.join("missing"), &"0".repeat(64), Origin::Release)
        .unwrap_err();

    assert!(matches!(failure, InstallError::Io(_)));
}

#[test]
fn each_folder_keeps_the_two_newest_versions_and_never_drops_the_active_one() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    let stable = app_dir.join("bin/versions/stable");

    install(&store, root, "0.1.0");
    install(&store, root, "0.10.0");
    install(&store, root, "0.2.0");
    assert_eq!(entries(&stable), vec!["0.10.0", "0.2.0"]);
    assert_eq!(store.current().as_deref(), Some("0.2.0"));

    install(&store, root, "0.1.5");
    assert_eq!(entries(&stable), vec!["0.1.5", "0.10.0"]);
    assert_eq!(store.current().as_deref(), Some("0.1.5"));
}

#[test]
fn the_unstable_folders_are_kept_apart_and_counted_together() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);

    install(&store, root, "0.1.0");
    install(&store, root, "0.2.0-alpha.1");
    install(&store, root, "0.2.0-beta.1");
    install(&store, root, "0.2.0-rc.1");
    install(&store, root, "0.2.0-rc.2");

    assert_eq!(
        entries(&app_dir.join("bin/versions/unstable/beta")),
        vec!["0.2.0-rc.1", "0.2.0-rc.2"]
    );
    assert_eq!(
        entries(&app_dir.join("bin/versions/unstable/alpha")),
        vec!["0.2.0-alpha.1"]
    );
    assert_eq!(
        store.unstable_versions(),
        vec!["0.2.0-alpha.1", "0.2.0-rc.1", "0.2.0-rc.2"]
    );
    assert_eq!(entries(&app_dir.join("bin/versions/stable")), vec!["0.1.0"]);
}

#[test]
fn the_kept_versions_come_by_channel_with_the_newest_first() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&root.join("app"));

    assert_eq!(store.kept(), Vec::<Kept>::new());

    for version in [
        "0.2.0",
        "0.2.1",
        "0.3.0-beta.1",
        "0.4.0-alpha.1",
        "0.3.0-beta.2",
    ] {
        install(&store, root, version);
    }

    assert_eq!(
        store.kept(),
        vec![
            Kept {
                channel: Channel::Stable,
                versions: vec!["0.2.1".to_owned(), "0.2.0".to_owned()],
            },
            Kept {
                channel: Channel::Beta,
                versions: vec!["0.3.0-beta.2".to_owned(), "0.3.0-beta.1".to_owned()],
            },
            Kept {
                channel: Channel::Alpha,
                versions: vec!["0.4.0-alpha.1".to_owned()],
            },
        ]
    );
}

#[test]
fn removing_a_kept_version_deletes_only_its_folder() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);

    install(&store, root, "0.3.0-beta.1");
    install(&store, root, "0.2.1");

    store.remove("0.3.0-beta.1").unwrap();

    assert_eq!(
        entries(&app_dir.join("bin/versions/unstable/beta")),
        Vec::<String>::new()
    );
    assert_eq!(entries(&app_dir.join("bin/versions/stable")), vec!["0.2.1"]);
    assert_eq!(store.current().as_deref(), Some("0.2.1"));
}

#[test]
fn removing_the_active_or_a_missing_version_is_refused() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);

    install(&store, root, "0.2.1");

    assert!(matches!(store.remove("0.2.1"), Err(RemoveError::Active)));
    assert!(matches!(store.remove("9.9.9"), Err(RemoveError::Missing)));
    assert!(matches!(
        store.remove("0.2.1-rc.1"),
        Err(RemoveError::Missing)
    ));
    assert_eq!(entries(&app_dir.join("bin/versions/stable")), vec!["0.2.1"]);
}

#[test]
fn a_version_that_cannot_be_deleted_reports_the_file_error() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    let beta = app_dir.join("bin/versions/unstable/beta");

    install(&store, root, "0.3.0-beta.1");
    install(&store, root, "0.2.1");
    fs::set_permissions(&beta, fs::Permissions::from_mode(0o555)).unwrap();

    let removed = store.remove("0.3.0-beta.1");
    fs::set_permissions(&beta, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(removed, Err(RemoveError::Io(_))));
}

#[test]
fn a_binary_that_answers_more_lines_after_its_version_is_still_accepted() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&root.join("app"));
    let (binary, hash) = fake_binary(root, "bcct 0.5.0\nInstalled:");

    let installed = store.install(&binary, &hash, Origin::Release).unwrap();

    assert_eq!(installed.version, "0.5.0");
}

#[test]
fn installing_the_same_version_again_reuses_it_or_replaces_a_different_file() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    let version_dir = app_dir.join("bin/versions/stable/0.2.0");

    install(&store, root, "0.2.0");
    let first_copy = fs::metadata(version_dir.join("bcct")).unwrap().ino();
    install(&store, root, "0.3.0");
    install(&store, root, "0.2.0");
    assert_eq!(store.current().as_deref(), Some("0.2.0"));
    assert_eq!(
        fs::metadata(version_dir.join("bcct")).unwrap().ino(),
        first_copy
    );

    let other = root.join("other");
    let script = "#!/bin/sh\necho 'bcct 0.2.0'\n";
    fs::write(&other, script).unwrap();
    fs::set_permissions(&other, fs::Permissions::from_mode(0o755)).unwrap();
    store
        .install(&other, &hash_of(script.as_bytes()), Origin::Release)
        .unwrap();

    assert_eq!(
        fs::read_to_string(version_dir.join("bcct")).unwrap(),
        script
    );
    assert_eq!(
        fs::read_to_string(version_dir.join(".verified")).unwrap(),
        format!("{}\n", hash_of(script.as_bytes()))
    );
    assert_eq!(
        entries(&app_dir.join("bin/versions/stable")),
        vec!["0.2.0", "0.3.0"]
    );
}

#[test]
fn the_launcher_runs_the_active_version_with_every_argument() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    install(&store, root, "0.2.0");

    let output = Command::new(app_dir.join("bin/bcct"))
        .args(["hook", "post", "with space"])
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "ran hook post with space\n"
    );
}

#[test]
fn the_launcher_without_an_active_version_explains_in_both_languages_and_exits_127() {
    let folder = sandbox();
    let root = folder.path();
    let app_dir = root.join("app");
    let store = Store::new(&app_dir);
    install(&store, root, "0.2.0");

    for broken in ["missing", "gone"] {
        if broken == "missing" {
            fs::remove_file(app_dir.join("bin/current")).unwrap();
        } else {
            fs::write(app_dir.join("bin/current"), "stable/9.9.9\n").unwrap();
        }

        let output = Command::new(app_dir.join("bin/bcct")).output().unwrap();

        assert_eq!(output.status.code(), Some(127), "{broken}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "");
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            "bcct: no installed version found. Run: npx better-claude-code-telegram\n\
             bcct: nenhuma versão instalada encontrada. Rode: npx better-claude-code-telegram\n"
        );
    }
}

#[test]
fn the_windows_launcher_reads_the_same_file_and_runs_the_exe() {
    assert!(LAUNCHER_CMD.starts_with("@echo off\r\n"));
    assert!(LAUNCHER_CMD.contains("set /p current=<\"%~dp0current\""));
    assert!(LAUNCHER_CMD.contains("set \"current=%current:/=\\%\""));
    assert!(LAUNCHER_CMD.contains("\"%~dp0versions\\%current%\\bcct.exe\" %*"));
    assert!(LAUNCHER_CMD.contains("exit /b 127"));
    assert!(LAUNCHER_CMD.contains("npx better-claude-code-telegram"));
    assert!(!LAUNCHER_CMD.replace("\r\n", "").contains('\n'));
}

fn self_install(root: &Path, args: &[&str]) -> std::process::Output {
    cargo_bin_cmd!("bcct")
        .arg("self-install")
        .args(args)
        .env("HOME", root.join("home"))
        .env("CLAUDE_CONFIG_DIR", root.join("claude"))
        .env_remove("BETTER_CC_TELEGRAM_DIR")
        .env_remove("LC_MESSAGES")
        .env_remove("LANG")
        .env_remove("LC_ALL")
        .output()
        .unwrap()
}

#[test]
fn the_self_install_command_installs_into_the_app_folder_and_says_what_it_did() {
    let folder = sandbox();
    let root = folder.path();
    let (binary, hash) = fake_binary(root, "bcct 0.3.0-alpha.2");

    let output = self_install(
        root,
        &[binary.to_str().unwrap(), "--sha256", &hash, "--from", "npm"],
    );

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "bcct 0.3.0-alpha.2 installed (alpha).\n\
         This is a test version (alpha): it may change or break before the stable one.\n"
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");

    let bin = root.join("claude/better-claude-code-telegram/bin");
    assert_eq!(
        fs::read_to_string(bin.join("current")).unwrap(),
        "unstable/alpha/0.3.0-alpha.2\n"
    );
    let receipt: Value =
        serde_json::from_str(&fs::read_to_string(bin.join("install.json")).unwrap()).unwrap();
    assert_eq!(receipt["origin"], "npm");
}

#[test]
fn the_self_install_command_records_a_manual_origin_by_default_and_stays_quiet_on_stable() {
    let folder = sandbox();
    let root = folder.path();
    let (binary, hash) = fake_binary(root, "bcct 0.3.0");

    let output = self_install(root, &[binary.to_str().unwrap(), "--sha256", &hash]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "bcct 0.3.0 installed (stable).\n"
    );

    let receipt: Value = serde_json::from_str(
        &fs::read_to_string(root.join("claude/better-claude-code-telegram/bin/install.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(receipt["origin"], "manual");
}

#[test]
fn the_self_install_command_explains_each_refusal_and_exits_1() {
    let folder = sandbox();
    let root = folder.path();
    let (binary, hash) = fake_binary(root, "other 1.0.0");
    let (good, _) = fake_binary(root, "bcct 0.3.0");
    let zeros = "0".repeat(64);
    let missing = root.join("missing");

    let cases = [
        (
            vec![good.to_str().unwrap(), "--sha256", zeros.as_str()],
            "The file does not match the expected hash; nothing was installed.\n",
        ),
        (
            vec![binary.to_str().unwrap(), "--sha256", hash.as_str()],
            "The file did not answer as bcct; nothing was installed.\n",
        ),
        (
            vec![missing.to_str().unwrap(), "--sha256", zeros.as_str()],
            "Could not install bcct: the file or the app folder could not be read or written.\n",
        ),
    ];

    for (args, message) in cases {
        let output = self_install(root, &args);

        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "");
        assert_eq!(String::from_utf8_lossy(&output.stderr), message);
    }
}

#[test]
fn the_self_install_command_shows_the_usage_on_wrong_arguments_and_exits_2() {
    let folder = sandbox();
    let root = folder.path();
    let usage = "Usage: bcct self-install <file> --sha256 <hash> [--from npm|release|manual]\n";

    for args in [
        vec![],
        vec!["file"],
        vec!["file", "--sha256"],
        vec!["--sha256", "abc"],
        vec!["file", "--sha256", "abc", "--from", "ftp"],
        vec!["file", "--sha256", "abc", "--odd"],
        vec!["--odd", "--sha256", "abc"],
        vec!["file", "other", "--sha256", "abc"],
    ] {
        let output = self_install(root, &args);

        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "");
        assert_eq!(String::from_utf8_lossy(&output.stderr), usage);
    }
}
