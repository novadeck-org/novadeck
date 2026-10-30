//! Windows' processes, as the relay reads them: a snapshot of every process's parent and
//! program, when each started, and a process tree that trusts no recorded parent older
//! than its child. The runner ends a terminal's programs through it (`tree`, then `end`),
//! where Windows has no process group to signal and a dead parent's pid may name another.
//! The relay ends a status line that ran past its deadline through a job (`Job`).

use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;

use serde_json::{Value, json};

const SNAPSHOT_PROCESSES: u32 = 0x2;
const SNAPSHOT_THREADS: u32 = 0x4;
const SUSPEND_RESUME: u32 = 0x2;
const CREATE_SUSPENDED: u32 = 0x4;
const INVALID_HANDLE: *mut c_void = -1isize as *mut c_void;
const QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TERMINATE: u32 = 0x1;
/// The exit code of a process still running.
const STILL_ACTIVE: u32 = 259;
/// FILETIME's epoch, 1601, before Unix's, in milliseconds.
const FILETIME_TO_UNIX_MS: u64 = 11_644_473_600_000;

/// Kernel32's PROCESSENTRY32W.
#[repr(C)]
struct Entry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    priority: i32,
    flags: u32,
    file: [u16; 260],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut Entry) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut Entry) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn GetProcessTimes(
        process: *mut c_void,
        created: *mut FileTime,
        exited: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
    fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32;
    fn OpenThread(access: u32, inherit: i32, thread: u32) -> *mut c_void;
    fn ResumeThread(thread: *mut c_void) -> u32;
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
}

/// A process as the snapshot found it: its program's file name and its recorded parent.
pub struct Process {
    pub file: String,
    pub parent: u32,
}

/// Every process's program file name and parent, by its pid; empty where Windows refuses
/// the snapshot.
pub fn snapshot() -> HashMap<u32, Process> {
    let mut processes = HashMap::new();
    let snapshot = unsafe { CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE {
        return processes;
    }
    let mut entry = Entry {
        size: size_of::<Entry>() as u32,
        usage: 0,
        pid: 0,
        heap: 0,
        module: 0,
        threads: 0,
        parent: 0,
        priority: 0,
        flags: 0,
        file: [0; 260],
    };
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        let length = entry.file.iter().position(|unit| *unit == 0).unwrap_or(260);
        let file = String::from_utf16_lossy(&entry.file[..length]);
        processes.insert(
            entry.pid,
            Process {
                file,
                parent: entry.parent,
            },
        );
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    processes
}

/// A process opened with `access`, closed when dropped.
struct Handle(*mut c_void);

impl Handle {
    fn open(pid: u32, access: u32) -> Option<Handle> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        (!handle.is_null()).then_some(Handle(handle))
    }

    /// When the process started, in whole milliseconds since the Unix epoch.
    fn started(&self) -> Option<u64> {
        let mut created = FileTime::default();
        let mut other = [FileTime::default(); 3];
        let [exited, kernel, user] = &mut other;
        let read = unsafe { GetProcessTimes(self.0, &mut created, exited, kernel, user) };
        if read == 0 {
            return None;
        }
        let ticks = (u64::from(created.high) << 32) | u64::from(created.low);
        (ticks / 10_000).checked_sub(FILETIME_TO_UNIX_MS)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// When process `pid` started, in milliseconds since the Unix epoch; None where it is gone
/// or Windows won't say, as for another user's.
pub fn started(pid: u32) -> Option<u64> {
    let handle = Handle::open(pid, QUERY_LIMITED_INFORMATION)?;
    // One that has exited keeps its process object while anything holds a handle to it, as
    // the program that started it may: it runs no longer.
    let mut code = 0;
    let read = unsafe { GetExitCodeProcess(handle.0, &mut code) };
    if read == 0 || code != STILL_ACTIVE {
        return None;
    }
    handle.started()
}

/// A process of a tree: its pid and when it started, which together name it alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Member {
    pub pid: u32,
    pub started: u64,
}

/// Where a tree is walked from: a process by its pid, and, for one read before, the start
/// it had then, which names it alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Root {
    pub pid: u32,
    pub started: Option<u64>,
}

/// The tree under `root`, from the processes' recorded parents and starts, the root first
/// where it still runs as the process it names. A process counts as a child only if it
/// started no earlier than its parent did, and no later than the snapshot was taken
/// (`before`): one whose parent has ended may record a pid that now names an older,
/// unrelated process, and one started since may have taken the pid of a process the
/// snapshot listed. A process that has ended is walked through, by its parent's start,
/// so what it left running is found. A root named by its start is walked from even once
/// it has ended, or its pid names another process, then only to children started before
/// that other one. Empty where a root named by its pid alone is gone. `started` is for
/// tests.
fn tree(
    root: Root,
    parents: &HashMap<u32, u32>,
    started: &impl Fn(u32) -> Option<u64>,
    before: u64,
) -> Vec<Member> {
    let live = started(root.pid).filter(|start| *start <= before);
    let (from, until, alive) = match (root.started, live) {
        (None, None) => return Vec::new(),
        (None, Some(start)) => (start, before, true),
        (Some(known), Some(start)) if start == known => (known, before, true),
        // Its pid names a later process: only children older than that one were its own.
        (Some(known), Some(start)) => (known, start.saturating_sub(1).min(before), false),
        (Some(known), None) => (known, before, false),
    };
    let mut found = Vec::new();
    if alive {
        found.push(Member {
            pid: root.pid,
            started: from,
        });
    }
    // Each process to look under, with the earliest a child of it may have started and
    // the latest; an ended one is looked under too, though it isn't ended itself.
    let mut walk = vec![(root.pid, from, until)];
    let mut seen = vec![root.pid];
    while let Some((parent, earliest, latest)) = walk.pop() {
        for (&pid, &recorded) in parents {
            if recorded != parent || seen.contains(&pid) {
                continue;
            }
            match started(pid) {
                Some(start) if start >= earliest && start <= latest => {
                    seen.push(pid);
                    found.push(Member {
                        pid,
                        started: start,
                    });
                    walk.push((pid, start, before));
                }
                // Ended since the snapshot: what it started is looked for all the same.
                None => {
                    seen.push(pid);
                    walk.push((pid, earliest, latest));
                }
                Some(_) => {}
            }
        }
    }
    found
}

/// Milliseconds since the Unix epoch, now.
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// `novadeck-relay tree <pid>[:<started-ms>]...`: each root's tree, as JSON, a line for
/// each root as it was named: `{"root":"<pid>[:<started-ms>]","processes":[{"pid":<pid>,
/// "startedAt":<ms>},...]}`. False where Windows refused the snapshot, which tells nothing
/// of any tree.
pub fn print_trees(roots: &[(String, Root)]) -> bool {
    let before = now();
    let processes = snapshot();
    if processes.is_empty() {
        return false;
    }
    let parents: HashMap<u32, u32> = processes
        .into_iter()
        .map(|(pid, process)| (pid, process.parent))
        .collect();
    for (named, root) in roots {
        let members: Vec<Value> = tree(*root, &parents, &started, before)
            .into_iter()
            .map(|member| json!({ "pid": member.pid, "startedAt": member.started }))
            .collect();
        println!("{}", json!({ "root": named, "processes": members }));
    }
    true
}

/// `novadeck-relay end <pid>:<started-ms>...`: ends each process still running that
/// started then, and no other that has its pid since.
pub fn end(members: &[Member]) {
    for member in members {
        let Some(handle) = Handle::open(member.pid, TERMINATE | QUERY_LIMITED_INFORMATION) else {
            continue;
        };
        if handle.started() == Some(member.started) {
            unsafe { TerminateProcess(handle.0, 1) };
        }
    }
}

/// A job object that ends every process in it at once, whatever parent each records: as a
/// Git Bash status line's are, where MSYS's `exec` leaves a program's recorded parent a
/// process that has ended. Closing it ends nothing.
pub struct Job(*mut c_void);

impl Job {
    /// `command` started in a new job: suspended until it is in the job, so nothing it
    /// starts can escape it. None where Windows refuses any of that, when nothing runs.
    pub fn start(command: &mut std::process::Command) -> Option<(std::process::Child, Job)> {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;

        let job = Job(unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) });
        if job.0.is_null() {
            return None;
        }
        let mut child = command.creation_flags(CREATE_SUSPENDED).spawn().ok()?;
        let assigned = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } != 0;
        if !assigned || !resume(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        Some((child, job))
    }

    /// Ends every process in the job.
    pub fn end(&self) {
        unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// Kernel32's THREADENTRY32.
#[repr(C)]
struct ThreadEntry {
    size: u32,
    usage: u32,
    thread: u32,
    process: u32,
    base_priority: i32,
    delta_priority: i32,
    flags: u32,
}

/// Resumes the threads of process `pid`, started suspended; false where none resumed.
fn resume(pid: u32) -> bool {
    let snapshot = unsafe { CreateToolhelp32Snapshot(SNAPSHOT_THREADS, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE {
        return false;
    }
    let mut entry = ThreadEntry {
        size: size_of::<ThreadEntry>() as u32,
        usage: 0,
        thread: 0,
        process: 0,
        base_priority: 0,
        delta_priority: 0,
        flags: 0,
    };
    let mut resumed = false;
    let mut more = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while more {
        if entry.process == pid {
            let thread = unsafe { OpenThread(SUSPEND_RESUME, 0, entry.thread) };
            if !thread.is_null() {
                resumed |= unsafe { ResumeThread(thread) } != u32::MAX;
                unsafe { CloseHandle(thread) };
            }
        }
        more = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    resumed
}

#[cfg(test)]
mod tests {
    use super::*;

    // Process starts by pid, and the tree a root has in them, as pids.
    fn pids(
        root: Root,
        parents: &HashMap<u32, u32>,
        starts: &HashMap<u32, u64>,
        before: u64,
    ) -> Vec<u32> {
        let started = |pid: u32| starts.get(&pid).copied();
        let mut found: Vec<u32> = tree(root, parents, &started, before)
            .iter()
            .map(|member| member.pid)
            .collect();
        found.sort_unstable();
        found
    }

    fn by_pid(pid: u32) -> Root {
        Root { pid, started: None }
    }

    #[test]
    fn walks_only_to_children_newer_than_their_parent() {
        // 10 started the shell 11, which started 12; 20 is older than 11 but records it as
        // its parent, as one whose parent died and left 11 to the shell.
        let parents = HashMap::from([(11, 10), (12, 11), (20, 11), (21, 20), (30, 99)]);
        let starts = HashMap::from([(10, 100), (11, 200), (12, 300), (20, 150), (21, 160)]);
        assert_eq!(pids(by_pid(11), &parents, &starts, 1_000), vec![11, 12]);
        assert!(pids(by_pid(42), &parents, &starts, 1_000).is_empty());
    }

    #[test]
    fn takes_no_process_started_after_the_snapshot() {
        // 12 ended after the snapshot listed it, and 12's pid went to a later process.
        let parents = HashMap::from([(11, 10), (12, 11)]);
        let starts = HashMap::from([(11, 200), (12, 900)]);
        assert_eq!(pids(by_pid(11), &parents, &starts, 500), vec![11]);
    }

    #[test]
    fn walks_through_an_ended_process_to_what_it_left_running() {
        // The agent 11 ran `cmd /c` 12, which ended, leaving pwsh 13 behind.
        let parents = HashMap::from([(11, 10), (12, 11), (13, 12), (40, 12)]);
        let starts = HashMap::from([(11, 200), (13, 300), (40, 100)]);
        assert_eq!(pids(by_pid(11), &parents, &starts, 1_000), vec![11, 13]);
    }

    #[test]
    fn walks_from_a_root_known_by_its_start_once_it_has_ended() {
        // The agent 11, read before at 200, has ended; the hook it started as it closed,
        // 14, runs on. 50 is older, an unrelated process that records 11 as its parent.
        let parents = HashMap::from([(14, 11), (50, 11)]);
        let starts = HashMap::from([(14, 400), (50, 100)]);
        let known = Root {
            pid: 11,
            started: Some(200),
        };
        assert_eq!(pids(known, &parents, &starts, 1_000), vec![14]);
        // Its pid now names a process started at 600: only children before that were its.
        let starts = HashMap::from([(11, 600), (14, 400), (15, 700)]);
        let parents = HashMap::from([(14, 11), (15, 11)]);
        assert_eq!(pids(known, &parents, &starts, 1_000), vec![14]);
        // Still the same process: itself too.
        let starts = HashMap::from([(11, 200), (14, 400)]);
        assert_eq!(pids(known, &parents, &starts, 1_000), vec![11, 14]);
    }

    #[test]
    fn reads_when_this_process_started() {
        let now = now();
        let mine = started(std::process::id()).unwrap();
        assert!(mine <= now && now - mine < 600_000);
    }

    #[test]
    fn finds_a_tree_it_started_and_ends_it_by_start() {
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let parents: HashMap<u32, u32> = snapshot()
            .into_iter()
            .map(|(pid, process)| (pid, process.parent))
            .collect();
        let mine = tree(by_pid(std::process::id()), &parents, &started, now());
        let found = mine
            .iter()
            .find(|member| member.pid == child.id())
            .copied()
            .unwrap();
        // A start that isn't its own ends nothing.
        end(&[Member {
            pid: found.pid,
            started: found.started + 1,
        }]);
        assert!(child.try_wait().unwrap().is_none());
        end(&[found]);
        assert!(child.wait().unwrap().code() == Some(1));
    }
}
