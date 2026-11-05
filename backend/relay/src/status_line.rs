//! The person's own Claude Code status line, which Novadeck's status line shows: their
//! command, as Claude Code's settings name it, run as Claude Code runs it, with the same
//! input, in a process group of its own, so a deadline ends everything it started. The
//! relay finds and runs it itself, beside reporting to the runner, so it shows even when
//! the runner can't be reached, as from a terminal multiplexer that outlived Novadeck.
//! A relay ended before its deadline, as Claude Code ends a status line it no longer
//! needs, ends the command with it: on Windows its job ends every process in it once the
//! relay's handle closes; elsewhere the signal that ends the relay (TERM, INT or HUP) ends
//! the group first. Only a SIGKILL, which nothing can catch, leaves it running.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
const MOST: usize = 65_536;

/// How long, once the deadline ended it, what it printed has to come through the pipe: it
/// closes as soon as everything it started has ended, so this is spent only on a command
/// that outlives its end. On Unix, the time the group has to end on SIGTERM, before
/// SIGKILL ends what is left of it.
const SETTLE: Duration = Duration::from_millis(100);

/// What the command printed by the time it ended, or by `deadline`, when it and whatever
/// it started are ended.
pub fn run(command: &str, input: &[u8], deadline: Instant) -> String {
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
        // What it printed just before may still be on its way from the pipe.
        end(&started, &closed);
    }
    // Before it is reaped, and its pid may name another: nothing of it is ended after.
    let_go(&started);
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
/// own, and that group, to end at the deadline, or when the relay is signalled to end.
#[cfg(unix)]
fn start(command: &str) -> Option<(std::process::Child, i32)> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    group::watch();
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
    group::running(group);
    Some((child, group))
}

/// Asks the group to end, and once `SETTLE` has passed, or its output closed, ends
/// whatever is left of it outright: a command that ignores SIGTERM, or one of its own that
/// let go of the output and runs on. Its leader isn't reaped yet, so its pid still names
/// the group.
#[cfg(unix)]
fn end(group: &i32, closed: &mpsc::Receiver<()>) {
    unsafe { libc::kill(-group, libc::SIGTERM) };
    let ended = closed.recv_timeout(SETTLE).is_ok();
    unsafe { libc::kill(-group, libc::SIGKILL) };
    if !ended {
        let _ = closed.recv_timeout(SETTLE);
    }
}

#[cfg(unix)]
fn let_go(_group: &i32) {
    group::running(0);
}

/// The group of the command that runs, which a signal ending the relay ends first.
#[cfg(unix)]
mod group {
    use std::sync::Once;
    use std::sync::atomic::{AtomicI32, Ordering};

    /// The group, or 0 while none runs.
    static RUNNING: AtomicI32 = AtomicI32::new(0);

    pub fn running(group: i32) {
        RUNNING.store(group, Ordering::SeqCst);
    }

    /// Ends the group, then the relay, by the signal that came: the handler is reset as
    /// it runs (`SA_RESETHAND`), and the signal isn't held back (`SA_NODEFER`), so raising
    /// it again ends the relay as it would have ended without this. Only async-signal-safe
    /// calls.
    extern "C" fn ended(signal: libc::c_int) {
        let group = RUNNING.load(Ordering::SeqCst);
        if group > 0 {
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        unsafe { libc::raise(signal) };
    }

    /// From now on, a TERM, INT or HUP that ends the relay ends the group first.
    pub fn watch() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
                unsafe {
                    let mut action: libc::sigaction = std::mem::zeroed();
                    action.sa_sigaction = ended as extern "C" fn(libc::c_int) as usize;
                    action.sa_flags = libc::SA_RESETHAND | libc::SA_NODEFER;
                    libc::sigemptyset(&mut action.sa_mask);
                    libc::sigaction(signal, &action, std::ptr::null_mut());
                }
            }
        });
    }
}

/// The command started as Claude Code starts it on Windows, in Git Bash as `bash -c`
/// (probed 2026-10-23, 2.1.309), in a job of its own to end at the deadline, as Windows
/// has no process group to signal, and which ends with the relay, should it be killed.
#[cfg(windows)]
fn start(command: &str) -> Option<(std::process::Child, crate::job::Job)> {
    use std::process::{Command, Stdio};

    crate::job::Job::start(
        Command::new(git_bash()?)
            .arg("-c")
            .arg(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
        crate::job::KILL_ON_CLOSE,
    )
}

#[cfg(windows)]
fn end(job: &crate::job::Job, closed: &mpsc::Receiver<()>) {
    job.end();
    let _ = closed.recv_timeout(SETTLE);
}

/// What the command left running once it was done goes on, as it would under Claude Code.
#[cfg(windows)]
fn let_go(job: &crate::job::Job) {
    job.let_go();
}

/// The Git Bash Claude Code runs its status line in: the one it is told of; else the first
/// on PATH, as Git Bash running Novadeck's status line puts its own first there, though
/// never Windows' own, which starts WSL; else the one beside Git's `git.exe`.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let told = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    let system = std::env::var_os("SystemRoot").map(|root| root.to_string_lossy().into_owned());
    let folders: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let on_path = || {
        folders
            .iter()
            .filter(|folder| may_hold_git_bash(folder, system.as_deref()))
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

/// Whether a folder on PATH may hold Git Bash's `bash.exe`: not Windows' own folders
/// (under `system`, `%SystemRoot%`), nor the Store's app aliases, where WSL may put one;
/// either `bash.exe` starts WSL.
#[cfg(any(windows, test))]
fn may_hold_git_bash(folder: &Path, system: Option<&str>) -> bool {
    let folder = folder.to_string_lossy().to_lowercase().replace('/', "\\");
    let folder = folder.trim_end_matches('\\');
    let under_system = system.is_some_and(|system| folder.starts_with(&system.to_lowercase()));
    !under_system && !folder.ends_with("\\microsoft\\windowsapps")
}

#[cfg(test)]
mod tests {
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
        ends_at_the_deadline("", "plain");
    }

    #[test]
    fn ends_a_command_that_ignores_being_asked_to() {
        ends_at_the_deadline("trap '' TERM; ", "deaf");
    }

    /// Runs a command that prints, then starts a process that would leave a mark later,
    /// each after `prefix`, and checks the deadline ended it all and kept what it printed.
    fn ends_at_the_deadline(prefix: &str, name: &str) {
        // A shell can be slow to start (Git Bash on a busy Windows runner took over 300 ms),
        // and a deadline that comes before it printed shows nothing: each such run is tried
        // again with a longer deadline. A process the command started leaves a mark at twice
        // the deadline, which it never reaches if the deadline ended everything the command
        // started, not the shell alone (the `:` keeps the shell from becoming that process).
        for (round, wait) in [300, 1_000, 3_000, 10_000]
            .map(Duration::from_millis)
            .into_iter()
            .enumerate()
        {
            let mark = std::env::temp_dir().join(format!(
                "novadeck-status-line-{name}-{}-{round}",
                std::process::id()
            ));
            let _ = std::fs::remove_file(&mark);
            let command = format!(
                "{prefix}printf partly; (sleep {:.1}; touch '{}'); :",
                (wait * 2).as_secs_f64(),
                mark.to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', r"'\''")
            );
            let began = Instant::now();
            let printed = run(&command, b"", began + wait);
            assert!(began.elapsed() < wait + Duration::from_secs(5));
            if printed == "partly" {
                // It printed before the deadline, so had it lived it would have left the mark
                // soon after three times the deadline.
                std::thread::sleep(
                    (began + wait * 3 + Duration::from_secs(1))
                        .saturating_duration_since(Instant::now()),
                );
                let left = mark.exists();
                let _ = std::fs::remove_file(&mark);
                assert!(!left, "the command outlived its deadline");
                return;
            }
            assert_eq!(
                printed, "",
                "what it printed is shown whole, or not yet at all"
            );
        }
        panic!("the command printed nothing by any deadline");
    }

    #[test]
    fn looks_for_git_bash_outside_windows_own_folders_and_the_stores_aliases() {
        let system = Some(r"C:\Windows");
        let may = |folder: &str| may_hold_git_bash(Path::new(folder), system);
        assert!(may(r"C:\Program Files\Git\usr\bin"));
        assert!(may("/usr/bin"));
        assert!(!may(r"c:\windows\System32"));
        assert!(!may(r"C:\Users\a\AppData\Local\Microsoft\WindowsApps"));
        assert!(!may(r"C:\Users\a\AppData\Local\Microsoft\WindowsApps\"));
        assert!(!may("C:/Users/a/AppData/Local/Microsoft/WindowsApps"));
        assert!(may_hold_git_bash(Path::new(r"C:\Windows\x"), None));
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
