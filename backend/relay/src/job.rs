//! A Windows job object a program is started in, which Windows has instead of a process
//! group: the relay's status line runs in one, and so does the real `cmd.exe` that
//! `novadeck-cmd` passes a command on to. Both binaries build this file.

use std::ffi::c_void;
use std::mem::size_of;

const SNAPSHOT_THREADS: u32 = 0x4;
const SUSPEND_RESUME: u32 = 0x2;
const CREATE_SUSPENDED: u32 = 0x4;
const INVALID_HANDLE: *mut c_void = -1isize as *mut c_void;
/// JobObjectExtendedLimitInformation, for SetInformationJobObject.
const EXTENDED_LIMITS: i32 = 9;
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: once the last handle to the job closes, as when the
/// process holding it is killed, every process in it is ended.
pub const KILL_ON_CLOSE: u32 = 0x2000;
/// JOB_OBJECT_LIMIT_BREAKAWAY_OK: a program that starts another with
/// CREATE_BREAKAWAY_FROM_JOB may, where without it Windows refuses to start that one.
/// `novadeck-cmd`'s: a status line has no such program.
#[allow(dead_code)]
pub const BREAKAWAY_OK: u32 = 0x800;

/// Kernel32's JOBOBJECT_BASIC_LIMIT_INFORMATION.
#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    per_process_user_time: i64,
    per_job_user_time: i64,
    flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_processes: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

/// Kernel32's JOBOBJECT_EXTENDED_LIMIT_INFORMATION, its IO_COUNTERS inline.
#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io: [u64; 6],
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
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

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, size: u32)
    -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
    fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Thread32First(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: *mut c_void, entry: *mut ThreadEntry) -> i32;
    fn OpenThread(access: u32, inherit: i32, thread: u32) -> *mut c_void;
    fn ResumeThread(thread: *mut c_void) -> u32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetLastError() -> u32;
}

/// What failed, with the error Windows gave for it.
fn failed(what: &str) -> String {
    format!("{what} failed (error {})", unsafe { GetLastError() })
}

/// A job object that ends every process in it at once, whatever parent each records: as a
/// Git Bash status line's are, where MSYS's `exec` leaves a program's recorded parent a
/// process that has ended. Started with `KILL_ON_CLOSE`, it also ends them all if the
/// process holding it dies first, as Windows closes a killed process's handles; `let_go`
/// leaves what still runs in it running once that process exits as it means to.
pub struct Job {
    handle: *mut c_void,
    limits: u32,
}

impl Job {
    /// `command` started in a new job with `limits` (`KILL_ON_CLOSE`, `BREAKAWAY_OK`):
    /// suspended until it is in the job, so nothing it starts can escape it. Where Windows
    /// refuses any of that, nothing of `command` has run, and the error says which step.
    pub fn start(
        command: &mut std::process::Command,
        limits: u32,
    ) -> Result<(std::process::Child, Job), String> {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;

        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(failed("CreateJobObjectW"));
        }
        let job = Job { handle, limits };
        if !job.limit(limits) {
            return Err(failed("SetInformationJobObject"));
        }
        let mut child = command
            .creation_flags(CREATE_SUSPENDED)
            .spawn()
            .map_err(|error| format!("starting it suspended failed ({error})"))?;
        let refused = if unsafe { AssignProcessToJobObject(job.handle, child.as_raw_handle()) } == 0
        {
            Some(failed("AssignProcessToJobObject"))
        } else if !resume(child.id()) {
            Some(failed("ResumeThread"))
        } else {
            None
        };
        if let Some(refused) = refused {
            let _ = child.kill();
            let _ = child.wait();
            return Err(refused);
        }
        Ok((child, job))
    }

    /// Sets the job's limits to `flags`; false where Windows refuses.
    fn limit(&self, flags: u32) -> bool {
        let limits = ExtendedLimits {
            basic: BasicLimits {
                flags,
                ..BasicLimits::default()
            },
            ..ExtendedLimits::default()
        };
        unsafe {
            SetInformationJobObject(
                self.handle,
                EXTENDED_LIMITS,
                (&raw const limits).cast(),
                size_of::<ExtendedLimits>() as u32,
            ) != 0
        }
    }

    /// Ends every process in the job.
    pub fn end(&self) {
        unsafe { TerminateJobObject(self.handle, 1) };
    }

    /// Closing the job no longer ends what runs in it: for once the program it was for
    /// ended by itself, where what that program left running, such as a program `start`
    /// started, goes on as it would without the job.
    pub fn let_go(&self) {
        self.limit(self.limits & !KILL_ON_CLOSE);
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
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

    #[test]
    fn lays_out_the_limits_as_windows_reads_them() {
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows.
        assert_eq!(size_of::<ExtendedLimits>(), 144);
    }
}
