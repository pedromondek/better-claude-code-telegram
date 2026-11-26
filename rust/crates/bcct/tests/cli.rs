mod stage;

use std::path::Path;

use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::predicate;

const KEPT_VARIABLES: [&str; 2] = ["LLVM_PROFILE_FILE", "SYSTEMROOT"];

fn bcct(home: &Path) -> assert_cmd::Command {
    let kept = KEPT_VARIABLES
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (name, value)));
    let mut command = cargo_bin_cmd!("bcct");
    command
        .env_clear()
        .envs(kept)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("CLAUDE_CONFIG_DIR", home.join("claude"));
    command
}

#[test]
fn prints_the_package_version_with_the_binary_name() {
    let folder = tempfile::tempdir().unwrap();

    bcct(folder.path())
        .arg("--version")
        .assert()
        .success()
        .stdout(format!("bcct {}\n", env!("CARGO_PKG_VERSION")))
        .stderr(stage::built_version_notice());
}

#[test]
fn refuses_an_unknown_argument_with_exit_code_2_and_nothing_on_stdout() {
    let folder = tempfile::tempdir().unwrap();

    bcct(folder.path())
        .arg("--nope")
        .assert()
        .code(2)
        .stdout("")
        .stderr(predicate::str::contains("--nope"));
}

#[test]
fn refuses_to_run_without_a_subcommand_with_exit_code_2() {
    let folder = tempfile::tempdir().unwrap();

    bcct(folder.path()).assert().code(2).stdout("");
}
