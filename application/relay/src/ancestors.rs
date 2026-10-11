//! The processes a hook runs under, nearest first, so the runner can tell which agent
//! process ran it: up to eight, each by its pid and name, where the platform tells.

use serde_json::Value;

#[cfg(unix)]
pub fn of_this_process() -> Vec<Value> {
    const MOST: usize = 8;
    let mut found = Vec::new();
    let mut pid = std::os::unix::process::parent_id();
    while found.len() < MOST && pid > 1 {
        let Some((name, parent)) = process(pid) else {
            break;
        };
        found.push(serde_json::json!({ "pid": pid, "name": name }));
        pid = parent;
    }
    found
}

/// On Windows, from a snapshot of every process, which tells each one's parent and the
/// file name of its program: a hook's relay starts once per hook, so a snapshot's few
/// milliseconds go unnoticed. A program's name goes without its `.exe`, as the agents'
/// names do.
#[cfg(windows)]
pub fn of_this_process() -> Vec<Value> {
    const MOST: usize = 8;
    let processes = windows::snapshot();
    let mut found = Vec::new();
    let mut pid = std::process::id();
    while found.len() < MOST {
        let Some(&parent) = processes.get(&pid).map(|(_, parent)| parent) else {
            break;
        };
        // A parent that ended may have left its pid to a newer process, even one of its
        // own descendants: a pid seen before ends the walk.
        if parent == 0 || parent == pid || found.iter().any(|each: &Value| each["pid"] == parent) {
            break;
        }
        let Some((name, _)) = processes.get(&parent) else {
            break;
        };
        found.push(serde_json::json!({ "pid": parent, "name": program(name) }));
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

#[cfg(windows)]
mod windows {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem::size_of;

    const SNAPSHOT_PROCESSES: u32 = 0x2;
    const INVALID_HANDLE: *mut c_void = -1isize as *mut c_void;

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

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut Entry) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// Every process's program file name and parent, by its pid; empty where Windows
    /// refuses the snapshot.
    pub fn snapshot() -> HashMap<u32, (String, u32)> {
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
            let name = String::from_utf16_lossy(&entry.file[..length]);
            processes.insert(entry.pid, (name, entry.parent));
            more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        processes
    }
}

/// A process's name and parent, from `/proc`.
#[cfg(target_os = "linux")]
fn process(pid: u32) -> Option<(String, u32)> {
    stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// A `/proc/<pid>/stat` line's name, which may hold spaces and brackets, and parent.
#[cfg(any(target_os = "linux", test))]
fn stat(line: &str) -> Option<(String, u32)> {
    let name = &line[line.find('(')? + 1..line.rfind(')')?];
    let rest = &line[line.rfind(')')? + 2..];
    let parent = rest.split(' ').nth(1)?.parse().ok()?;
    Some((name.to_owned(), parent))
}

/// A process's name and parent, from the kernel. The name is the file name of the path
/// it was started by, as `ps` names it: a program started through a symlink, as
/// Homebrew installs them, goes by the symlink's name, not the file it points to.
#[cfg(target_os = "macos")]
fn process(pid: u32) -> Option<(String, u32)> {
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
    let parent = unsafe { info.assume_init() }.pbi_ppid;
    let name = started_by(pid).or_else(|| executable(pid))?;
    Some((name, parent))
}

/// The path a process was started by, from its arguments' record: its argument count,
/// then that path.
#[cfg(target_os = "macos")]
fn started_by(pid: u32) -> Option<String> {
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
    let path = record.get(size_of::<libc::c_int>()..length)?;
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
fn process(_pid: u32) -> Option<(String, u32)> {
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
    fn reads_a_name_with_spaces_and_brackets() {
        assert_eq!(
            stat("4242 (my (odd) agent) S 4100 4242 4100 0"),
            Some(("my (odd) agent".into(), 4100))
        );
        assert_eq!(stat("garbled"), None);
    }

    #[test]
    fn names_a_windows_program_without_its_exe() {
        assert_eq!(program("agy.exe"), "agy");
        assert_eq!(program("Codex.EXE"), "codex");
        assert_eq!(program("exe"), "exe");
        assert_eq!(program("codex"), "codex");
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
    }
}
