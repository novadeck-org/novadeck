//! The built `novadeck-cmd`, as a program that finds `cmd` through PATH runs it: on
//! Windows alone, where it passes a command on to the real `cmd.exe`.
#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const CMD: &str = env!("CARGO_BIN_EXE_novadeck-cmd");

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("novadeck-cmd-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The pass-through, given `arguments` as cmd would be.
fn cmd(arguments: &str) -> Command {
    let mut command = Command::new(CMD);
    command.raw_arg(arguments).stdout(Stdio::null());
    command
}

/// A batch file in `dir` that marks `started`, waits about two seconds, then marks `mark`.
fn slow(dir: &Path, started: &Path, mark: &Path) -> PathBuf {
    let script = dir.join("slow.cmd");
    std::fs::write(
        &script,
        format!(
            "@echo x> \"{}\"\r\n@ping -n 3 127.0.0.1 >nul\r\n@echo x> \"{}\"\r\n",
            started.display(),
            mark.display()
        ),
    )
    .unwrap();
    script
}

fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < until, "{what}: not within {within:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn passes_on_cmds_exit_code() {
    assert_eq!(cmd("/c exit 7").status().unwrap().code(), Some(7));
    assert_eq!(cmd("/c exit 0").status().unwrap().code(), Some(0));
}

#[test]
fn ending_it_ends_the_cmd_it_passed_the_command_on_to() {
    let dir = scratch("ended");
    let (started, mark) = (dir.join("started"), dir.join("mark"));
    let script = slow(&dir, &started, &mark);
    let mut shim = cmd(&format!("/c \"{}\"", script.display()))
        .spawn()
        .unwrap();
    wait_until("the command started", Duration::from_secs(20), || {
        started.exists()
    });
    // As a program that cancels a command ends the cmd it started: TerminateProcess.
    shim.kill().unwrap();
    let _ = shim.wait();
    thread::sleep(Duration::from_secs(4));
    assert!(!mark.exists(), "cmd ran on after the pass-through ended");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn what_cmd_started_goes_on_once_cmd_is_done() {
    let dir = scratch("started");
    let (started, mark) = (dir.join("started"), dir.join("mark"));
    let script = slow(&dir, &started, &mark);
    let status = cmd(&format!(
        "/c start \"\" /b cmd /d /c \"{}\"",
        script.display()
    ))
    .status()
    .unwrap();
    assert!(status.success());
    wait_until("what cmd started finished", Duration::from_secs(20), || {
        mark.exists()
    });
    let _ = std::fs::remove_dir_all(&dir);
}
