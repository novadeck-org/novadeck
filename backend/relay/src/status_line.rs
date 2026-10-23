//! The person's own Claude Code status line, which Novadeck's status line shows: their
//! command, as Claude Code's settings name it, run as Claude Code runs it, with the same
//! input, in a process group of its own, so a deadline ends everything it started. The
//! relay finds and runs it itself, beside reporting to the runner, so it shows even when
//! the runner can't be reached, as from a terminal multiplexer that outlived Novadeck.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::Value;

/// A setting's text, when it holds some.
fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// The person's own status line command: the project's local settings, the project's,
/// then the person's (`config_dir`, or `~/.claude`). Novadeck's own, which names the
/// hook, never counts.
pub fn own_command(
    payload: &str,
    config_dir: Option<&Path>,
    home: Option<&Path>,
) -> Option<String> {
    let payload: Value = serde_json::from_str(payload).ok()?;
    let project = text(
        payload
            .get("workspace")
            .and_then(|workspace| workspace.get("project_dir")),
    )
    .or_else(|| text(payload.get("cwd")))
    .map(PathBuf::from);
    let person = config_dir
        .map(Path::to_path_buf)
        .or_else(|| home.map(|home| home.join(".claude")));
    let files = project
        .iter()
        .flat_map(|project| {
            [
                project.join(".claude").join("settings.local.json"),
                project.join(".claude").join("settings.json"),
            ]
        })
        .chain(person.map(|folder| folder.join("settings.json")));
    files.into_iter().find_map(|file| {
        let settings: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
        let line = settings.get("statusLine")?;
        let command = text(line.get("command"))?;
        (line.get("type").and_then(Value::as_str) == Some("command")
            && !command.contains("NOVADECK_HOOK"))
        .then(|| command.to_owned())
    })
}

/// The most of its output kept.
pub const MOST: usize = 65_536;

/// What the command printed by the time it ended, or by `deadline`, when it and whatever
/// it started are ended.
pub fn run(command: &str, input: &[u8], deadline: Instant) -> String {
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::thread;

    let Some((mut child, started)) = start(command) else {
        return String::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        let input = input.to_vec();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let Some(mut stdout) = child.stdout.take() else {
        return String::new();
    };
    let (sent, printed) = mpsc::channel::<Vec<u8>>();
    let (ended, closed) = mpsc::channel::<()>();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        // Read to its end, keeping only what may be shown.
        let mut kept = 0;
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) if kept < MOST => {
                    kept += read;
                    if sent.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
            }
        }
        let _ = ended.send(());
    });
    // Its output ends once it and everything it started let go of it.
    let finished = closed
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .is_ok();
    if !finished {
        end(&started);
    }
    thread::spawn(move || child.wait());
    let mut kept = Vec::new();
    while let Ok(chunk) = printed.try_recv() {
        if kept.len() < MOST {
            kept.extend_from_slice(&chunk);
        }
    }
    kept.truncate(MOST);
    String::from_utf8_lossy(&kept).into_owned()
}

/// The command started as Claude Code starts it, `/bin/sh -c`, in a process group of its
/// own, and that group, to end at the deadline.
#[cfg(unix)]
fn start(command: &str) -> Option<(std::process::Child, i32)> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let child = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let group = child.id() as i32;
    Some((child, group))
}

#[cfg(unix)]
fn end(group: &i32) {
    unsafe { libc::kill(-group, libc::SIGTERM) };
}

/// The command started as Claude Code starts it on Windows, in Git Bash as `bash -c`
/// (probed 2026-10-23, 2.1.309), in a job of its own to end at the deadline, as Windows
/// has no process group to signal.
#[cfg(windows)]
fn start(command: &str) -> Option<(std::process::Child, crate::processes::Job)> {
    use std::process::{Command, Stdio};

    crate::processes::Job::start(
        Command::new(git_bash()?)
            .arg("-c")
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
}

#[cfg(windows)]
fn end(job: &crate::processes::Job) {
    job.end();
}

/// The Git Bash Claude Code runs its status line in: the one it is told of; else the first
/// on PATH, as Git Bash running Novadeck's status line puts its own first there, though
/// never Windows' own, which starts WSL; else the one beside Git's `git.exe`.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let told = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    let system = std::env::var_os("SystemRoot").map(|root| root.to_string_lossy().to_lowercase());
    let folders: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let on_path = || {
        folders
            .iter()
            .filter(|folder| {
                let folder = folder.to_string_lossy().to_lowercase();
                !system
                    .as_ref()
                    .is_some_and(|system| folder.starts_with(system))
            })
            .map(|folder| folder.join("bash.exe"))
            .find(|path| path.is_file())
    };
    // Git's `cmd` folder, which its installer puts on PATH, beside its `bin`.
    let beside_git = || {
        folders
            .iter()
            .filter(|folder| folder.join("git.exe").is_file())
            .filter_map(|folder| Some(folder.parent()?.join("bin").join("bash.exe")))
            .find(|path| path.is_file())
    };
    told.or_else(on_path).or_else(beside_git)
}

#[cfg(test)]
mod lookup {
    use std::fs;

    use super::*;

    fn settings(folder: &Path, file: &str, command: &str) {
        fs::create_dir_all(folder).unwrap();
        let line = serde_json::json!({ "statusLine": { "type": "command", "command": command } });
        fs::write(folder.join(file), line.to_string()).unwrap();
    }

    #[test]
    fn finds_the_project_s_local_then_the_project_s_then_the_person_s() {
        let root = std::env::temp_dir().join(format!("novadeck-status-{}", std::process::id()));
        let project = root.join("project");
        let home = root.join("home");
        let payload = serde_json::json!({ "cwd": project }).to_string();
        let found = || own_command(&payload, None, Some(&home));
        assert_eq!(found(), None);
        settings(&home.join(".claude"), "settings.json", "theirs");
        assert_eq!(found().as_deref(), Some("theirs"));
        settings(&project.join(".claude"), "settings.json", "project's");
        assert_eq!(found().as_deref(), Some("project's"));
        // Novadeck's own never counts.
        settings(
            &project.join(".claude"),
            "settings.local.json",
            "\"$NOVADECK_HOOK\" claude",
        );
        assert_eq!(found().as_deref(), Some("project's"));
        settings(&project.join(".claude"), "settings.local.json", "local");
        assert_eq!(found().as_deref(), Some("local"));
        // Claude Code's own folder, when it names one, stands for the person's.
        let config = root.join("config");
        settings(&config, "settings.json", "configured");
        let elsewhere =
            serde_json::json!({ "workspace": { "project_dir": root.join("none") } }).to_string();
        assert_eq!(
            own_command(&elsewhere, Some(&config), Some(&home)).as_deref(),
            Some("configured")
        );
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn prints_what_the_command_printed_from_the_same_input() {
        let printed = run(
            "cat; printf ' done'",
            b"{\"model\":1}",
            Instant::now() + Duration::from_secs(5),
        );
        assert_eq!(printed, "{\"model\":1} done");
    }

    #[test]
    fn ends_a_command_still_running_at_the_deadline_and_shows_what_it_printed() {
        let began = Instant::now();
        let printed = run(
            "printf partly; sleep 30",
            b"",
            began + Duration::from_millis(300),
        );
        assert_eq!(printed, "partly");
        assert!(began.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn keeps_at_most_sixty_four_kibibytes() {
        let printed = run(
            "head -c 200000 /dev/zero | tr '\\0' x",
            b"",
            Instant::now() + Duration::from_secs(5),
        );
        assert_eq!(printed.len(), MOST);
    }
}
