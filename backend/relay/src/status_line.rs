//! The person's own Claude Code status line, which Novadeck's status line shows: their
//! command, as Claude Code's settings name it, run as Claude Code runs it, with the same
//! input, in a process group of its own, so a deadline ends everything it started. The
//! relay finds and runs it itself, beside reporting to the runner, so it shows even when
//! the runner can't be reached, as from a terminal multiplexer that outlived Novadeck.
//! The command never outlives the relay's deadline. A relay itself ended before it ends
//! the command too: on Windows its job ends every process in it once the relay's handle
//! closes; elsewhere the signal that ends the relay (TERM, INT or HUP) ends the group
//! first. Only a SIGKILL, which nothing can catch, leaves the command running. Whether the
//! relay is ended at all depends on how its caller stops a run: one that ends only the
//! shell that started the hook leaves the relay to its deadline.

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
/// SIGKILL ends what is left of it, then the most time SIGKILL is sent again for while its
/// output stays open.
const SETTLE: Duration = Duration::from_millis(100);

/// How often SIGKILL is sent again to a group whose output stays open.
#[cfg(unix)]
const AGAIN: Duration = Duration::from_millis(10);

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
    let closing = closing(&started);
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
        closing();
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
    let mut ended = closed.recv_timeout(SETTLE).is_ok();
    end_outright(*group, |wait| {
        ended = ended || closed.recv_timeout(wait).is_ok();
        ended
    });
}

/// Sends the group SIGKILL, then again every `AGAIN` until `closed_within` (which waits up
/// to the time it is given) says its output closed, once more after that, and for no longer
/// than `SETTLE`. Only async-signal-safe calls, as the relay's signal handler runs it too.
///
/// Keep the repeat: one SIGKILL isn't enough on macOS. XNU's killpg(2) (`pgrp_iterate`, in
/// bsd/kern/kern_proc.c) takes the group's pids, then looks each one up, and a process still
/// being forked (`P_REF_NEW`) isn't found: it is passed over, and once its fork is done it
/// runs on, a member of the group that nothing signals again. Linux has no such gap (a fork
/// that a group's signal meets is started over). A command that ignores SIGTERM is still
/// running, and may be forking, when SIGKILL comes: on its first macOS run, the test of one
/// saw what it started outlive the deadline. What a fork makes holds the output open, as
/// the process it was forked from did, so the output closes only once a later SIGKILL ended
/// it too.
#[cfg(unix)]
fn end_outright(group: i32, mut closed_within: impl FnMut(Duration) -> bool) {
    let mut closed = false;
    for _ in 0..SETTLE.as_millis() / AGAIN.as_millis() {
        unsafe { libc::kill(-group, libc::SIGKILL) };
        if closed {
            return;
        }
        closed = closed_within(AGAIN);
    }
}

/// What tells the relay's signal handler, once the command's output closed, that its group
/// needs no more SIGKILLs.
#[cfg(unix)]
fn closing(group: &i32) -> impl FnOnce() + Send + 'static {
    let group = *group;
    move || group::closed(group)
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

    /// The last group whose output closed.
    static CLOSED: AtomicI32 = AtomicI32::new(0);

    pub fn running(group: i32) {
        RUNNING.store(group, Ordering::SeqCst);
    }

    pub fn closed(group: i32) {
        CLOSED.store(group, Ordering::SeqCst);
    }

    /// Ends the group, then the relay, by the signal that came: the handler is reset as
    /// it runs (`SA_RESETHAND`), and the signal isn't held back (`SA_NODEFER`), so raising
    /// it again ends the relay as it would have ended without this. The group is sent
    /// SIGKILL as at the deadline, again while its output stays open, so for up to `SETTLE`.
    /// Only async-signal-safe calls.
    extern "C" fn ended(signal: libc::c_int) {
        let group = RUNNING.load(Ordering::SeqCst);
        if group > 0 {
            super::end_outright(group, |wait| {
                let closed = || CLOSED.load(Ordering::SeqCst) == group;
                if !closed() {
                    let wait = libc::timespec {
                        tv_sec: 0,
                        tv_nsec: wait.subsec_nanos() as libc::c_long,
                    };
                    unsafe { libc::nanosleep(&wait, std::ptr::null_mut()) };
                }
                closed()
            });
        }
        unsafe { libc::raise(signal) };
    }

    /// From now on, a TERM, INT or HUP that ends the relay ends the group first. One the
    /// relay was started ignoring, as under `nohup`, it goes on ignoring. A signal in the
    /// microseconds between the command's start and `running` misses its group.
    pub fn watch() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
                unsafe {
                    let mut action: libc::sigaction = std::mem::zeroed();
                    action.sa_sigaction = ended as extern "C" fn(libc::c_int) as usize;
                    action.sa_flags = libc::SA_RESETHAND | libc::SA_NODEFER;
                    libc::sigemptyset(&mut action.sa_mask);
                    let mut before: libc::sigaction = std::mem::zeroed();
                    libc::sigaction(signal, &action, &mut before);
                    if before.sa_sigaction == libc::SIG_IGN {
                        libc::sigaction(signal, &before, std::ptr::null_mut());
                    }
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
    .ok()
}

#[cfg(windows)]
fn end(job: &crate::job::Job, closed: &mpsc::Receiver<()>) {
    job.end();
    let _ = closed.recv_timeout(SETTLE);
}

#[cfg(windows)]
fn closing(_job: &crate::job::Job) -> impl FnOnce() + Send + 'static {
    || {}
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
        ends_at_the_deadline("plain", |mark, later| {
            format!("printf partly; ({}); :", leaves_a_mark(mark, later))
        });
    }

    #[test]
    fn ends_a_command_that_ignores_being_asked_to() {
        ends_at_the_deadline("deaf", |mark, later| {
            format!(
                "trap '' TERM; printf partly; ({}); :",
                leaves_a_mark(mark, later)
            )
        });
    }

    /// As a process macOS' killpg(2) passes over while it is forked: out of the group when
    /// the first SIGKILL comes, in it again just after (`tests/rejoins.pl`).
    #[cfg(unix)]
    #[test]
    fn ends_what_the_first_kill_passes_over() {
        let rejoins = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/rejoins.pl");
        ends_at_the_deadline("passed-over", |mark, later| {
            format!(
                "trap '' TERM; perl '{}' /dev/null '{mark}' {later} & sleep {later}",
                quoted(Path::new(rejoins))
            )
        });
    }

    /// A path as a shell (Git Bash on Windows) reads it in single quotes.
    fn quoted(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .replace('\'', r"'\''")
    }

    /// After `later` seconds, the mark: the group the command started in, and what of it is
    /// still running, so a mark found says what outlived the deadline (or, where `ps` can't
    /// say, as Git Bash's, at least that something did).
    fn leaves_a_mark(mark: &str, later: &str) -> String {
        format!(
            "sleep {later}; {{ echo \"group $$\"; ps -A -o pid=,ppid=,pgid=,stat=,command= \
             | awk -v group=$$ '$3 == group'; }} > '{mark}' 2>&1"
        )
    }

    /// Runs `command`, given its mark's path, quoted, and the time after which a process it
    /// started leaves it, twice the deadline, and checks the deadline ended it all and kept
    /// what it printed, "partly", by then.
    fn ends_at_the_deadline(name: &str, command: impl Fn(&str, &str) -> String) {
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
            let command = command(&quoted(&mark), &format!("{:.1}", (wait * 2).as_secs_f64()));
            let began = Instant::now();
            let printed = run(&command, b"", began + wait);
            let ended = began.elapsed();
            assert!(ended < wait + Duration::from_secs(5));
            if printed == "partly" {
                // It printed by the time it was ended, so had it lived it would have left
                // the mark soon after three times the deadline.
                std::thread::sleep(
                    (began + wait * 3 + Duration::from_secs(1))
                        .saturating_duration_since(Instant::now()),
                );
                let left = std::fs::read_to_string(&mark);
                let _ = std::fs::remove_file(&mark);
                if let Ok(left) = left {
                    panic!(
                        "the command outlived its deadline of {wait:?}: run returned after \
                         {ended:?}, and it left\n{left}"
                    );
                }
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
