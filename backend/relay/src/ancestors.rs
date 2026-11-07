//! The processes a hook runs under, nearest first, so the runner can tell which agent
//! process ran it, and when the agent fired the hook: up to eight, each by its pid, name
//! and start in milliseconds since the Unix epoch, where the platform tells. The start of
//! the one just below the agent is when the agent started the hook's shell, which on
//! Windows comes seconds before the relay, behind a cold PowerShell or cmd. The runner
//! reads the starts only there; on Linux and macOS, where a shell starts at once, they
//! are sent for what they tell, as the relay reads every platform alike. Each also carries
//! the words it was started with where the platform tells (`args`, a program's arguments
//! without the program; on Windows `commandLine`, the one line it is given), cut short
//! past `MOST_ARGS`: from the agent's, the runner learns the flags it was launched with.

use serde_json::{Map, Value};

const MOST: usize = 8;

/// The most of a process's arguments an ancestor carries, in bytes: its flags come first,
/// and a long prompt or settings text after them is of no use.
const MOST_ARGS: usize = 4096;

/// What the platform tells of the words a process was started with.
#[derive(Debug, PartialEq)]
enum Args {
    /// Its arguments, one by one, without its program.
    #[cfg_attr(windows, allow(dead_code))]
    Words(Vec<String>),
    /// The one line it was given, program first, as Windows keeps it.
    #[cfg_attr(not(windows), allow(dead_code))]
    Line(String),
}

/// An ancestor as the runner reads it; its start and arguments are left out where unknown.
fn entry(pid: u32, name: String, started: Option<f64>, args: Option<Args>) -> Value {
    let mut fields = Map::new();
    fields.insert("pid".into(), pid.into());
    fields.insert("name".into(), name.into());
    if let Some(started) = started.and_then(serde_json::Number::from_f64) {
        fields.insert("startedAt".into(), Value::Number(started));
    }
    match args {
        Some(Args::Words(words)) => {
            fields.insert("args".into(), words.into());
        }
        Some(Args::Line(line)) => {
            fields.insert("commandLine".into(), line.into());
        }
        None => {}
    }
    Value::Object(fields)
}

/// The words of a process's arguments that fit `MOST_ARGS`, whole words only.
#[cfg(any(unix, test))]
fn fitting(words: impl Iterator<Item = String>) -> Vec<String> {
    let mut used = 0;
    let mut kept = Vec::new();
    for word in words {
        used += word.len() + 1;
        if used > MOST_ARGS {
            break;
        }
        kept.push(word);
    }
    kept
}

/// A command line cut to `MOST_ARGS` bytes at a character boundary.
#[cfg(any(windows, test))]
fn fitting_line(line: &str) -> String {
    let mut end = line.len().min(MOST_ARGS);
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    line[..end].to_owned()
}

/// A process as the platform tells it: its name, its parent, and when it started.
#[cfg(unix)]
struct Process {
    name: String,
    parent: u32,
    started: Option<f64>,
}

/// On Linux and macOS a parent that ends leaves its children to another, so a recorded
/// parent is always the live one.
#[cfg(unix)]
pub fn of_this_process() -> Vec<Value> {
    let clock = Clock::now();
    let mut found = Vec::new();
    let mut pid = std::os::unix::process::parent_id();
    while found.len() < MOST && pid > 1 {
        let Some(process) = process(pid, clock.as_ref()) else {
            break;
        };
        found.push(entry(pid, process.name, process.started, arguments(pid)));
        pid = process.parent;
    }
    found
}

/// On Windows, from a snapshot of every process, which tells each one's parent and the
/// file name of its program: a hook's relay starts once per hook, so a snapshot's few
/// milliseconds go unnoticed. A program's name goes without its `.exe`, as the agents'
/// names do. Windows keeps a process's parent pid after that parent ends, when another
/// process may get it: a parent that started after its child is such a one, and ends the
/// walk.
#[cfg(windows)]
pub fn of_this_process() -> Vec<Value> {
    use crate::processes;

    let snapshot = processes::snapshot();
    let mut found = Vec::new();
    let mut pid = std::process::id();
    let mut child_started = processes::started(pid);
    while found.len() < MOST {
        let Some(parent) = snapshot.get(&pid).map(|process| process.parent) else {
            break;
        };
        // A pid seen before ends the walk too, as a cycle of reused pids would.
        if parent == 0 || parent == pid || found.iter().any(|each: &Value| each["pid"] == parent) {
            break;
        }
        let Some(process) = snapshot.get(&parent) else {
            break;
        };
        let started = processes::started(parent);
        match (started, child_started) {
            (Some(started), Some(child)) if started > child => break,
            _ => {}
        }
        found.push(entry(
            parent,
            program(&process.file),
            started.map(|ms| ms as f64),
            processes::command_line(parent).map(|line| Args::Line(fitting_line(&line))),
        ));
        child_started = started;
        pid = parent;
    }
    found
}

/// A program's file name without its `.exe`, in lower case, as Windows names files in
/// any case and the agents' names are lower case.
#[cfg(any(windows, test))]
fn program(file: &str) -> String {
    let cut = file.len().saturating_sub(4);
    let name = match file.get(cut..) {
        Some(end) if end.eq_ignore_ascii_case(".exe") => &file[..cut],
        _ => file,
    };
    name.to_lowercase()
}

/// What turns a Linux process's start, in clock ticks since boot, into wall-clock time:
/// when the machine booted, from how long it has been up, and how long a tick is.
#[cfg(target_os = "linux")]
struct Clock {
    boot_ms: f64,
    tick_ms: f64,
}

#[cfg(target_os = "linux")]
impl Clock {
    fn now() -> Option<Clock> {
        let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
        let up_ms = uptime.split_whitespace().next()?.parse::<f64>().ok()? * 1000.0;
        let now_ms = crate::epoch_ms()?;
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        (hz > 0).then(|| Clock {
            boot_ms: now_ms - up_ms,
            tick_ms: 1000.0 / hz as f64,
        })
    }
}

/// macOS tells each process's start in wall-clock time itself.
#[cfg(all(unix, not(target_os = "linux")))]
struct Clock;

#[cfg(all(unix, not(target_os = "linux")))]
impl Clock {
    fn now() -> Option<Clock> {
        Some(Clock)
    }
}

/// A process's name, parent and start, from `/proc`.
#[cfg(target_os = "linux")]
fn process(pid: u32, clock: Option<&Clock>) -> Option<Process> {
    let (name, parent, ticks) = stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
    let started = clock
        .zip(ticks)
        .map(|(clock, ticks)| clock.boot_ms + ticks as f64 * clock.tick_ms);
    Some(Process {
        name,
        parent,
        started,
    })
}

/// A process's arguments without its program, from `/proc`: its command line is those words,
/// each ended by a zero byte.
#[cfg(target_os = "linux")]
fn arguments(pid: u32) -> Option<Args> {
    let line = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(Args::Words(words_of(&line)))
}

/// The words of a zero-ended command line, its program left out.
#[cfg(any(target_os = "linux", test))]
fn words_of(line: &[u8]) -> Vec<String> {
    let line = line.strip_suffix(&[0]).unwrap_or(line);
    fitting(
        line.split(|byte| *byte == 0)
            .skip(1)
            .map(|word| String::from_utf8_lossy(word).into_owned()),
    )
}

/// A `/proc/<pid>/stat` line's name, which may hold spaces and brackets, parent (field 4)
/// and start in clock ticks after boot (field 22), where the line has it. The name is the
/// kernel's `comm`: at most 15 bytes, and what a program sets as its title, where macOS
/// names a process by the path it was started by. None for a line of any other shape.
#[cfg(any(target_os = "linux", test))]
fn stat(line: &str) -> Option<(String, u32, Option<u64>)> {
    let close = line.rfind(')')?;
    let name = line.get(line.find('(')? + 1..close)?;
    let rest: Vec<&str> = line.get(close + 2..)?.split(' ').collect();
    let parent = rest.get(1)?.parse().ok()?;
    let started = rest.get(19).and_then(|ticks| ticks.parse().ok());
    Some((name.to_owned(), parent, started))
}

/// A process's name, parent and start, from the kernel. The name is the file name of the
/// path it was started by, as `ps` names it: a program started through a symlink, as
/// Homebrew installs them, goes by the symlink's name, not the file it points to.
#[cfg(target_os = "macos")]
fn process(pid: u32, _clock: Option<&Clock>) -> Option<Process> {
    use std::mem::{MaybeUninit, size_of};

    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let started = info.pbi_start_tvsec as f64 * 1000.0 + info.pbi_start_tvusec as f64 / 1000.0;
    let name = started_by(pid).or_else(|| executable(pid))?;
    Some(Process {
        name,
        parent: info.pbi_ppid,
        started: Some(started),
    })
}

/// A process's arguments without its program, from the kernel's record of them.
#[cfg(target_os = "macos")]
fn arguments(pid: u32) -> Option<Args> {
    let record = arguments_record(pid)?;
    Some(Args::Words(record_words(&record)?))
}

/// The words of a kernel arguments record: its count, the path the process was started by
/// and the padding after it, then each argument ended by a zero byte, the program first.
#[cfg(any(target_os = "macos", test))]
fn record_words(record: &[u8]) -> Option<Vec<String>> {
    let count = i32::from_ne_bytes(record.get(..4)?.try_into().ok()?);
    let rest = record.get(4..)?;
    let rest = &rest[rest.iter().position(|byte| *byte == 0)?..];
    let rest = &rest[rest
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(rest.len())..];
    let words = rest
        .split(|byte| *byte == 0)
        .take(usize::try_from(count).ok()?)
        .skip(1)
        .map(|word| String::from_utf8_lossy(word).into_owned());
    Some(fitting(words))
}

/// The kernel's record of a process's arguments (`KERN_PROCARGS2`): its argument count,
/// then the path it was started by, and the arguments after.
#[cfg(target_os = "macos")]
fn arguments_record(pid: u32) -> Option<Vec<u8>> {
    use std::mem::size_of;
    use std::ptr::null_mut;

    let mut most: libc::c_int = 0;
    let mut length = size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let asked = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut most).cast(),
            &mut length,
            null_mut(),
            0,
        )
    };
    if asked != 0 || most <= 0 {
        return None;
    }
    let mut record = vec![0u8; most as usize];
    let mut length = record.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let asked = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            record.as_mut_ptr().cast(),
            &mut length,
            null_mut(),
            0,
        )
    };
    if asked != 0 {
        return None;
    }
    record.truncate(length);
    Some(record)
}

/// The path a process was started by, from its arguments' record.
#[cfg(target_os = "macos")]
fn started_by(pid: u32) -> Option<String> {
    let record = arguments_record(pid)?;
    let path = record.get(std::mem::size_of::<libc::c_int>()..)?;
    let path = &path[..path.iter().position(|byte| *byte == 0)?];
    file_name(&String::from_utf8_lossy(path))
}

/// The file a process runs, its symlinks followed: where its arguments can't be read.
#[cfg(target_os = "macos")]
fn executable(pid: u32) -> Option<String> {
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid as i32, path.as_mut_ptr().cast(), path.len() as u32) };
    if length <= 0 {
        return None;
    }
    path.truncate(length as usize);
    file_name(&String::from_utf8_lossy(&path))
}

#[cfg(any(target_os = "macos", test))]
fn file_name(path: &str) -> Option<String> {
    path.rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// Elsewhere the platform doesn't tell, and the runner goes without.
#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process(_pid: u32, _clock: Option<&Clock>) -> Option<Process> {
    None
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn arguments(_pid: u32) -> Option<Args> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_program_by_its_path_s_file_name() {
        assert_eq!(
            file_name("/opt/homebrew/bin/codex").as_deref(),
            Some("codex")
        );
        assert_eq!(file_name("codex").as_deref(), Some("codex"));
        assert_eq!(file_name("/opt/homebrew/bin/"), None);
    }

    #[test]
    fn reads_a_name_with_spaces_and_brackets_and_its_start() {
        let line = "4242 (my (odd) agent) S 4100 4242 4100 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000";
        assert_eq!(
            stat(line),
            Some(("my (odd) agent".into(), 4100, Some(98765)))
        );
        assert_eq!(
            stat("4242 (agent) S 4100 4242 4100 0"),
            Some(("agent".into(), 4100, None))
        );
        assert_eq!(stat("garbled"), None);
        // Cut short, or out of order: nothing, rather than a panic that aborts the hook.
        assert_eq!(stat("1 (x)"), None);
        assert_eq!(stat("1 (x) "), None);
        assert_eq!(stat("1 )("), None);
    }

    #[test]
    fn names_a_windows_program_without_its_exe() {
        assert_eq!(program("agy.exe"), "agy");
        assert_eq!(program("Codex.EXE"), "codex");
        assert_eq!(program("exe"), "exe");
        assert_eq!(program("codex"), "codex");
    }

    #[test]
    fn leaves_out_a_start_it_doesnt_know() {
        assert_eq!(
            entry(7, "sh".into(), None, None),
            serde_json::json!({ "pid": 7, "name": "sh" })
        );
        assert_eq!(
            entry(7, "sh".into(), Some(12.5), None),
            serde_json::json!({ "pid": 7, "name": "sh", "startedAt": 12.5 })
        );
    }

    #[test]
    fn carries_the_words_a_process_started_with() {
        let words = Args::Words(vec!["--model".into(), "opus".into()]);
        assert_eq!(
            entry(7, "claude".into(), None, Some(words)),
            serde_json::json!({ "pid": 7, "name": "claude", "args": ["--model", "opus"] })
        );
        let line = Args::Line("claude.exe --model opus".into());
        assert_eq!(
            entry(7, "claude".into(), None, Some(line)),
            serde_json::json!({ "pid": 7, "name": "claude", "commandLine": "claude.exe --model opus" })
        );
    }

    #[test]
    fn reads_a_command_line_s_words_without_its_program() {
        assert_eq!(
            words_of(b"/bin/claude\0--model\0opus\0--effort=high\0"),
            ["--model", "opus", "--effort=high"]
        );
        assert_eq!(words_of(b"claude\0"), Vec::<String>::new());
        assert_eq!(words_of(b""), Vec::<String>::new());
        // An empty word is a word.
        assert_eq!(words_of(b"claude\0\0x\0"), ["", "x"]);
    }

    #[test]
    fn reads_a_kernel_arguments_record_s_words() {
        let mut record = 3i32.to_ne_bytes().to_vec();
        record.extend(b"/opt/bin/claude\0\0\0");
        record.extend(b"claude\0--model\0opus\0");
        record.extend(b"HOME=/x\0");
        assert_eq!(record_words(&record).unwrap(), ["--model", "opus"]);
        assert_eq!(record_words(b"\x01"), None);
    }

    #[test]
    fn keeps_whole_words_within_the_most() {
        let long = "x".repeat(MOST_ARGS);
        let kept = fitting(["--model".to_owned(), "opus".to_owned(), long].into_iter());
        assert_eq!(kept, ["--model", "opus"]);
        assert_eq!(fitting_line(&"é".repeat(MOST_ARGS)).len(), MOST_ARGS);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reads_the_arguments_of_a_process_it_started() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 30", "name", "--model=opus"])
            .spawn()
            .unwrap();
        // A process spawned moments ago may not have run its program yet.
        let mut found = arguments(child.id());
        for _ in 0..100 {
            if found != Some(Args::Words(Vec::new())) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
            found = arguments(child.id());
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(
            found,
            Some(Args::Words(vec![
                "-c".into(),
                "sleep 30".into(),
                "name".into(),
                "--model=opus".into()
            ]))
        );
    }

    // Each ancestor started before the relay, and at most a while before.
    fn started_in_order(found: &[Value]) {
        let now = crate::epoch_ms().unwrap();
        let mut later = now + 100.0;
        for each in found {
            let started = each["startedAt"].as_f64().expect("a start");
            assert!(started <= later + 100.0 && now - started < 30.0 * 24.0 * 3_600_000.0);
            later = started;
        }
    }

    #[cfg(windows)]
    #[test]
    fn finds_the_processes_this_one_runs_under_on_windows() {
        let found = of_this_process();
        assert!(!found.is_empty() && found.len() <= 8);
        assert!(
            found
                .iter()
                .all(|each| each["pid"].as_u64().is_some_and(|pid| pid > 0))
        );
        assert!(
            found
                .iter()
                .all(|each| !each["name"].as_str().unwrap().ends_with(".exe"))
        );
        // Its parent, cargo's test runner, is this user's own, so its start is told.
        started_in_order(&found[..1]);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn finds_the_processes_this_one_runs_under() {
        let parent = std::os::unix::process::parent_id();
        let found = of_this_process();
        assert_eq!(
            found.first().and_then(|first| first["pid"].as_u64()),
            Some(u64::from(parent))
        );
        assert!(found.len() <= 8);
        started_in_order(&found[..1]);
    }
}
