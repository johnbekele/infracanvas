//! The CLI is Gate 6's entry point, so `--version` and `--help` exiting zero is
//! a contract rather than a convenience.

use std::process::Command;

fn engine() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ic-engine"))
}

#[test]
fn version_flag_exits_zero_and_reports_a_version() {
    let output = engine().arg("--version").output().unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains(ic_engine::version()), "got: {stdout}");
}

#[test]
fn help_flag_exits_zero() {
    let output = engine().arg("--help").output().unwrap();

    assert!(output.status.success());
}

#[test]
fn no_arguments_reports_the_version_rather_than_failing() {
    let output = engine().output().unwrap();

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("ic-engine"), "got: {stdout}");
}

#[test]
fn an_unknown_subcommand_exits_non_zero() {
    let output = engine().arg("definitely-not-a-command").output().unwrap();

    assert!(!output.status.success());
}
