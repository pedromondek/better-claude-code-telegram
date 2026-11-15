#![cfg(unix)]
#![cfg(test)]

mod support;

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use assert_cmd::cargo::cargo_bin_cmd;
use bcct::locale::Locale;
use bcct::messages::messages_for;
use bcct::self_install::{Origin, Store, write_version};
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

fn install(store: &Store, root: &Path, version: &str) {
    let path = root.join(format!("fake-{version}"));
    let script = format!("#!/bin/sh\necho 'bcct {version}'\n");
    fs::write(&path, &script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    store
        .install(&path, &hash_of(script.as_bytes()), Origin::Release)
        .unwrap();
}

fn rendered(version: &str, store: &Store, locale: Locale) -> (String, String) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    write_version(
        version,
        store,
        messages_for(locale),
        false,
        &mut stdout,
        &mut stderr,
    )
    .unwrap();

    (
        String::from_utf8(stdout).unwrap(),
        String::from_utf8(stderr).unwrap(),
    )
}

fn kept_store(root: &Path) -> Store {
    let store = Store::new(&root.join("app"));

    for version in [
        "0.2.0",
        "0.2.1",
        "0.4.0-alpha.1",
        "0.3.0-beta.1",
        "0.3.0-beta.2",
    ] {
        install(&store, root, version);
    }

    store
}

#[test]
fn a_binary_outside_the_app_folder_shows_only_its_version() {
    let folder = sandbox();
    let store = Store::new(&folder.path().join("app"));

    assert_eq!(
        rendered("0.2.1", &store, Locale::PtBr),
        ("bcct 0.2.1\n".to_owned(), String::new())
    );
}

#[test]
fn the_version_lists_the_kept_ones_by_channel_and_how_to_remove_them() {
    let folder = sandbox();
    let store = kept_store(folder.path());

    assert_eq!(
        rendered("0.3.0-beta.2", &store, Locale::PtBr),
        (
            "bcct 0.3.0-beta.2\n\
             Instaladas:\n  \
             estável  0.2.1, 0.2.0\n  \
             beta     0.3.0-beta.2 (ativa), 0.3.0-beta.1\n  \
             alpha    0.4.0-alpha.1\n\
             Para apagar uma guardada: npx @pedromondek/better-claude-code-telegram uninstall <versão>\n\
             Para desinstalar tudo: npx @pedromondek/better-claude-code-telegram uninstall\n"
                .to_owned(),
            "⚠ Versão de teste (beta). Para a estável: 'bcct update stable'.\n".to_owned()
        )
    );
    assert_eq!(
        rendered("0.3.0-beta.2", &store, Locale::EnUs),
        (
            "bcct 0.3.0-beta.2\n\
             Installed:\n  \
             stable  0.2.1, 0.2.0\n  \
             beta    0.3.0-beta.2 (active), 0.3.0-beta.1\n  \
             alpha   0.4.0-alpha.1\n\
             To delete a kept one: npx @pedromondek/better-claude-code-telegram uninstall <version>\n\
             To uninstall everything: npx @pedromondek/better-claude-code-telegram uninstall\n"
                .to_owned(),
            "⚠ Test version (beta). For the stable one: 'bcct update stable'.\n".to_owned()
        )
    );
}

#[test]
fn a_stable_version_has_no_warning_and_marks_the_active_one_in_its_channel() {
    let folder = sandbox();
    let root = folder.path();
    let store = kept_store(root);
    install(&store, root, "0.2.0");

    let (stdout, stderr) = rendered("0.2.0", &store, Locale::EnUs);

    assert!(
        stdout.contains("  stable  0.2.1, 0.2.0 (active)\n"),
        "{stdout}"
    );
    assert!(
        stdout.contains("  beta    0.3.0-beta.2, 0.3.0-beta.1\n"),
        "{stdout}"
    );
    assert_eq!(stderr, "");
}

#[test]
fn an_alpha_version_names_its_channel_in_the_warning() {
    let folder = sandbox();
    let store = Store::new(&folder.path().join("app"));

    assert_eq!(
        rendered("0.4.0-alpha.1", &store, Locale::EnUs).1,
        "⚠ Test version (alpha). For the stable one: 'bcct update stable'.\n"
    );
}

struct Closed;

impl Write for Closed {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> io::Result<()> {
        Err(io::ErrorKind::BrokenPipe.into())
    }
}

#[test]
fn a_closed_stdout_is_reported_as_an_error() {
    let folder = sandbox();
    let store = kept_store(folder.path());
    let mut stderr = Vec::new();

    let written = write_version(
        "0.2.1",
        &store,
        messages_for(Locale::EnUs),
        false,
        &mut Closed,
        &mut stderr,
    );

    assert!(written.is_err());
}

fn app_dir(root: &Path) -> PathBuf {
    root.join("claude/better-claude-code-telegram")
}

fn bcct(root: &Path, args: &[&str]) -> std::process::Output {
    cargo_bin_cmd!("bcct")
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
fn every_version_flag_prints_the_same_lines() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&app_dir(root));
    install(&store, root, "0.2.0");
    let expected = format!(
        "bcct {}\n\
         Installed:\n  \
         stable  0.2.0 (active)\n\
         To delete a kept one: npx @pedromondek/better-claude-code-telegram uninstall <version>\n\
         To uninstall everything: npx @pedromondek/better-claude-code-telegram uninstall\n",
        env!("CARGO_PKG_VERSION")
    );

    for flag in ["-v", "-V", "-version", "--version", "--v"] {
        let output = bcct(root, &[flag]);

        assert_eq!(output.status.code(), Some(0), "{flag}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), expected, "{flag}");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "", "{flag}");
    }
}

#[test]
fn uninstalling_a_kept_version_deletes_it_and_says_so() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&app_dir(root));
    install(&store, root, "0.3.0-beta.1");
    install(&store, root, "0.2.1");

    let output = bcct(root, &["uninstall", "0.3.0-beta.1"]);

    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "✔ Deleted 0.3.0-beta.1.\n"
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "");
    assert!(
        !app_dir(root)
            .join("bin/versions/unstable/beta/0.3.0-beta.1")
            .exists()
    );
}

#[test]
fn uninstalling_the_active_or_a_missing_version_is_refused_with_exit_1() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&app_dir(root));
    install(&store, root, "0.2.1");

    for (version, message) in [
        (
            "0.2.1",
            "✘ 0.2.1 is in use. Switch first with 'bcct update'.\n",
        ),
        ("9.9.9", "✘ 9.9.9 is not installed.\n"),
    ] {
        let output = bcct(root, &["uninstall", version]);

        assert_eq!(output.status.code(), Some(1), "{version}");
        assert_eq!(String::from_utf8_lossy(&output.stdout), "", "{version}");
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            message,
            "{version}"
        );
    }

    assert!(
        app_dir(root)
            .join("bin/versions/stable/0.2.1/bcct")
            .exists()
    );
}

#[test]
fn a_version_that_cannot_be_deleted_names_the_folder() {
    let folder = sandbox();
    let root = folder.path();
    let store = Store::new(&app_dir(root));
    let beta = app_dir(root).join("bin/versions/unstable/beta");
    install(&store, root, "0.3.0-beta.1");
    install(&store, root, "0.2.1");
    fs::set_permissions(&beta, fs::Permissions::from_mode(0o555)).unwrap();

    let output = bcct(root, &["uninstall", "0.3.0-beta.1"]);
    fs::set_permissions(&beta, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&output.stderr),
        format!(
            "✘ Could not remove {}.\n",
            beta.join("0.3.0-beta.1").display()
        )
    );
}
