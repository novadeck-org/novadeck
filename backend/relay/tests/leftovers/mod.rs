//! What a program leaves running when it is ended while it starts another, on Windows: the
//! moment a new process exists and no job holds it yet. A program that starts one
//! suspended, to put it in a job and only then let it run, leaves it there for good when it
//! is ended in between: in no job, never resumed, so it can neither be ended with its
//! starter nor exit by itself. Seen as a `cmd.exe` with no child, its parent gone, that
//! outlived Antigravity's deck in the Windows end-to-end tests, three times.
//!
//! The moment is a millisecond or so, and no test can stop a program inside it, so these
//! end the program again and again, at moments swept over when it was seen to start its
//! child. Shared by the tests of both programs that start another in a job.
#![cfg(windows)]

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::thread;
use std::time::{Duration, Instant};

const SNAPSHOT_PROCESSES: u32 = 0x2;
const INVALID_HANDLE: *mut c_void = -1isize as *mut c_void;
const SYNCHRONIZE: u32 = 0x0010_0000;
const QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TERMINATE: u32 = 0x1;
/// WAIT_TIMEOUT: what was waited for, for no time at all, still runs.
const STILL_RUNS: u32 = 0x102;

/// Kernel32's PROCESSENTRY32W.
#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent: u32,
    base_priority: i32,
    flags: u32,
    name: [u16; 260],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn GetProcessTimes(
        process: *mut c_void,
        created: *mut u64,
        exited: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, wait: u32) -> u32;
    fn TerminateProcess(process: *mut c_void, code: u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}

/// When `process` started, as Windows counts time; None where it won't say.
fn created(process: *mut c_void) -> Option<u64> {
    let (mut created, mut other) = (0u64, 0u64);
    let told =
        unsafe { GetProcessTimes(process, &mut created, &mut other, &mut other, &mut other) };
    (told != 0).then_some(created)
}

/// Every process now, as its pid, its recorded parent's pid and its program's name.
fn processes() -> Vec<(u32, u32, String)> {
    let snapshot = (0..5)
        .map(|_| unsafe { CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0) })
        .find(|snapshot| !snapshot.is_null() && *snapshot != INVALID_HANDLE)
        .expect("a snapshot of the processes");
    let mut entry = ProcessEntry {
        size: size_of::<ProcessEntry>() as u32,
        usage: 0,
        pid: 0,
        heap: 0,
        module: 0,
        threads: 0,
        parent: 0,
        base_priority: 0,
        flags: 0,
        name: [0; 260],
    };
    let mut found = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        let length = entry.name.iter().position(|unit| *unit == 0).unwrap_or(0);
        found.push((
            entry.pid,
            entry.parent,
            String::from_utf16_lossy(&entry.name[..length]),
        ));
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    found
}

/// A process one of the programs started, which runs.
struct Left {
    name: String,
    pid: u32,
    handle: *mut c_void,
}

impl Drop for Left {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}

/// The processes `starter` started that run now. The starter is still held, ended or not,
/// so no later process has its pid; one recorded as its child that started before it did is
/// the child of an earlier process the pid named.
fn started_by(starter: &Child) -> Vec<Left> {
    let Some(since) = created(starter.as_raw_handle().cast()) else {
        return Vec::new();
    };
    processes()
        .into_iter()
        // A console's host is started for a program that has none, before the program runs,
        // and ends with its last program: never what the program itself started.
        .filter(|(_, parent, name)| {
            *parent == starter.id() && !name.eq_ignore_ascii_case("conhost.exe")
        })
        .filter_map(|(pid, _, name)| {
            let access = SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE;
            let handle = unsafe { OpenProcess(access, 0, pid) };
            if handle.is_null() {
                return None;
            }
            let left = Left { name, pid, handle };
            let runs = unsafe { WaitForSingleObject(left.handle, 0) } == STILL_RUNS;
            (runs && created(left.handle)? >= since).then_some(left)
        })
        .collect()
}

/// How long after its start a program `start` starts first had a child of its own, at the
/// quickest and the slowest of a few runs. Each program is ended a moment later, well past
/// the moment tested, and kept in `ended` with the rest.
fn starts_its_child_after(
    start: &mut impl FnMut() -> Child,
    ended: &mut Vec<(Child, Duration)>,
) -> (Duration, Duration) {
    let mut times = Vec::new();
    for _ in 0..5 {
        let mut program = start();
        let began = Instant::now();
        while started_by(&program).is_empty() {
            assert!(
                began.elapsed() < Duration::from_secs(30),
                "the program started nothing within 30 s"
            );
            assert!(
                program.try_wait().unwrap().is_none(),
                "the program ended before it started anything"
            );
        }
        let after = began.elapsed();
        times.push(after);
        thread::sleep(Duration::from_millis(300));
        let _ = program.kill();
        let _ = program.wait();
        ended.push((program, after + Duration::from_millis(300)));
    }
    (
        times.iter().copied().min().unwrap(),
        times.iter().copied().max().unwrap(),
    )
}

/// Fails should a program `start` starts, ended as a program that cancels a command ends
/// the one it started (TerminateProcess, on it alone), leave running what it had started:
/// `what` names that in the failure. Ended up to 600 times, each at a moment after its
/// start swept evenly over the time it takes to start its child, from half the quickest
/// seen to a quarter past the slowest, for 40 seconds at most.
///
/// A guard by chance, not a sure one: the moment is a millisecond or so of the tens the
/// sweep covers, so a run meets it a few times where it exists, and now and then not once.
///
/// What `start` starts must run for minutes, so that one left running, suspended or not,
/// still runs when it is looked for.
pub fn nothing_is_left_by_one_ended_as_it_starts(what: &str, mut start: impl FnMut() -> Child) {
    let mut ended = Vec::new();
    let (quickest, slowest) = starts_its_child_after(&mut start, &mut ended);
    let (from, to) = (quickest / 2, slowest + slowest / 4);
    let began = Instant::now();
    for round in 0..600u32 {
        if began.elapsed() > Duration::from_secs(40) {
            break;
        }
        // The golden ratio's multiples, which spread over the span however many are taken.
        let part = (f64::from(round) * 0.618_033_988_749_895).fract();
        let after = from + (to - from).mul_f64(part);
        let mut program = start();
        let started = Instant::now();
        // A sleep is too coarse for a moment this short.
        while started.elapsed() < after {
            std::hint::spin_loop();
        }
        let _ = program.kill();
        let _ = program.wait();
        ended.push((program, after));
    }
    // A job ends what is in it a moment after its last handle closed.
    let until = Instant::now() + Duration::from_secs(10);
    let left = loop {
        let left: Vec<(Left, Duration)> = ended
            .iter()
            .flat_map(|(program, after)| {
                started_by(program)
                    .into_iter()
                    .map(move |left| (left, *after))
            })
            .collect();
        if left.is_empty() || Instant::now() > until {
            break left;
        }
        thread::sleep(Duration::from_millis(250));
    };
    let told: Vec<String> = left
        .iter()
        .map(|(left, after)| {
            unsafe { TerminateProcess(left.handle, 1) };
            format!(
                "{} ({}), whose starter was ended {after:?} after its start",
                left.name, left.pid
            )
        })
        .collect();
    assert!(
        told.is_empty(),
        "{what} ran on after what started it was ended, {} of {} times (its child appeared \
         {quickest:?} to {slowest:?} after its start): {}",
        told.len(),
        ended.len(),
        told.join("; ")
    );
}
