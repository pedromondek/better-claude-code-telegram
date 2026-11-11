use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::predicate;

#[test]
fn prints_the_package_version_with_the_binary_name() {
    let folder = tempfile::tempdir().unwrap();

    cargo_bin_cmd!("bcct")
        .arg("--version")
        .env("HOME", folder.path())
        .env("CLAUDE_CONFIG_DIR", folder.path().join("claude"))
        .env_remove("BETTER_CC_TELEGRAM_DIR")
        .assert()
        .success()
        .stdout(format!("bcct {}\n", env!("CARGO_PKG_VERSION")))
        .stderr("");
}

#[test]
fn refuses_an_unknown_argument_with_exit_code_2_and_nothing_on_stdout() {
    cargo_bin_cmd!("bcct")
        .arg("--nope")
        .assert()
        .code(2)
        .stdout("")
        .stderr(predicate::str::contains("--nope"));
}

#[test]
fn refuses_to_run_without_a_subcommand_with_exit_code_2() {
    cargo_bin_cmd!("bcct").assert().code(2).stdout("");
}
