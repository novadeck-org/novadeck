//! A Windows job object a program is started in, which Windows has instead of a process
//! group: the relay's status line runs in one, and so does the real `cmd.exe` that
//! `novadeck-cmd` passes a command on to. Both binaries build this file.
//!
//! The program is created inside its job (`PROC_THREAD_ATTRIBUTE_JOB_LIST`, Windows 10 and
//! later), so there is no instant it runs, or waits to, outside it. Keep it so. Started
//! first and put in the job after, as Rust's `Command` allows (it can't name a job), the
//! program has to start suspended, or what it starts at once escapes the job; and a
//! starter that is ended between the two steps, as a harness ends a hook or a status line
//! it gives up on, leaves a program that is in no job and never resumed: nothing ends it
//! with its starter, and it can't exit by itself. Antigravity's Windows end-to-end tests
//! found such a `cmd.exe` three times in the day that order was in. A job the starter put
//! itself in first would close that gap too, but a process never leaves a job: the starter
//! would be ended with every program it ends.

use std::ffi::c_void;
use std::fs::File;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;

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
/// PROC_THREAD_ATTRIBUTE_JOB_LIST: the jobs a new process is in from its first instant.
const JOB_LIST: usize = 0x0002_000D;
/// EXTENDED_STARTUPINFO_PRESENT: the startup information ends with an attribute list.
const EXTENDED_STARTUP: u32 = 0x0008_0000;
/// CREATE_UNICODE_ENVIRONMENT, as Rust's `Command` starts a program.
const UNICODE_ENVIRONMENT: u32 = 0x400;
/// STARTF_USESTDHANDLES: the startup information names the program's three streams.
const USE_STREAMS: u32 = 0x100;
const DUPLICATE_SAME_ACCESS: u32 = 0x2;
const INFINITE: u32 = u32::MAX;
/// STD_INPUT_HANDLE, STD_OUTPUT_HANDLE and STD_ERROR_HANDLE, for GetStdHandle.
const STREAMS: [u32; 3] = [-10i32 as u32, -11i32 as u32, -12i32 as u32];
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const SHARE_READ_WRITE: u32 = 0x3;
const OPEN_EXISTING: u32 = 3;

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

/// Kernel32's STARTUPINFOW.
#[repr(C)]
struct Startup {
    size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    columns: u32,
    rows: u32,
    fill: u32,
    flags: u32,
    show_window: u16,
    reserved_size: u16,
    reserved_bytes: *mut u8,
    input: *mut c_void,
    output: *mut c_void,
    errors: *mut c_void,
}

/// Kernel32's STARTUPINFOEXW.
#[repr(C)]
struct ExtendedStartup {
    startup: Startup,
    attributes: *mut c_void,
}

/// Kernel32's PROCESS_INFORMATION.
#[repr(C)]
struct Created {
    process: *mut c_void,
    thread: *mut c_void,
    pid: u32,
    thread_id: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, info: *const c_void, size: u32)
    -> i32;
    fn TerminateJobObject(job: *mut c_void, code: u32) -> i32;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *const c_void,
        size: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        command_line: *mut u16,
        process_attributes: *mut c_void,
        thread_attributes: *mut c_void,
        inherit: i32,
        flags: u32,
        environment: *mut c_void,
        directory: *const u16,
        startup: *mut ExtendedStartup,
        created: *mut Created,
    ) -> i32;
    fn CreatePipe(
        read: *mut *mut c_void,
        write: *mut *mut c_void,
        attributes: *mut c_void,
        size: u32,
    ) -> i32;
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut c_void,
        disposition: u32,
        flags: u32,
        template: *mut c_void,
    ) -> *mut c_void;
    fn DuplicateHandle(
        from_process: *mut c_void,
        handle: *mut c_void,
        to_process: *mut c_void,
        duplicate: *mut *mut c_void,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn GetCurrentProcess() -> *mut c_void;
    fn GetStdHandle(stream: u32) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, wait: u32) -> u32;
    fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetLastError() -> u32;
}

/// Held while a program's streams are made and it is created (see `Job::start`).
static STARTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// What failed, with the error Windows gave for it.
fn failed(what: &str) -> String {
    format!("{what} failed (error {})", unsafe { GetLastError() })
}

/// A handle this process owns, closed once dropped.
fn owned(handle: *mut c_void) -> OwnedHandle {
    // SAFETY: every caller passes a handle Windows just gave it, open and no one else's.
    unsafe { OwnedHandle::from_raw_handle(handle) }
}

/// Another handle to what `handle` names, which a program this process starts inherits;
/// None where there is nothing to name, or Windows won't duplicate it.
fn inherited(handle: RawHandle) -> Option<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE {
        return None;
    }
    let mut duplicate = std::ptr::null_mut();
    let process = unsafe { GetCurrentProcess() };
    let done = unsafe {
        DuplicateHandle(
            process,
            handle,
            process,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    };
    (done != 0).then(|| owned(duplicate))
}

/// A pipe's two ends, the one read from first, neither inherited by a program started.
fn pipe() -> Result<(OwnedHandle, OwnedHandle), String> {
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) } == 0 {
        return Err(failed("CreatePipe"));
    }
    Ok((owned(read), owned(write)))
}

/// What a started program reads and writes.
pub enum Streams {
    /// What its starter does: the starter's own input, output and errors.
    #[allow(dead_code)]
    Shared,
    /// Its input and its output piped from and to its starter (`Process::stdin` and
    /// `stdout`), its errors dropped.
    #[allow(dead_code)]
    Piped,
}

/// The starter's ends of a program's streams, then the program's own three, inherited.
type Opened = (Option<File>, Option<File>, [Option<OwnedHandle>; 3]);

impl Streams {
    fn open(&self) -> Result<Opened, String> {
        match self {
            // One the starter has none of, or that can't be duplicated, the program has
            // none of either.
            Streams::Shared => Ok((
                None,
                None,
                STREAMS.map(|stream| inherited(unsafe { GetStdHandle(stream) })),
            )),
            Streams::Piped => {
                let (input, stdin) = pipe()?;
                let (stdout, output) = pipe()?;
                let name: Vec<u16> = "NUL\0".encode_utf16().collect();
                let nowhere = unsafe {
                    CreateFileW(
                        name.as_ptr(),
                        GENERIC_READ | GENERIC_WRITE,
                        SHARE_READ_WRITE,
                        std::ptr::null_mut(),
                        OPEN_EXISTING,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if nowhere == INVALID_HANDLE {
                    return Err(failed("opening NUL"));
                }
                let nowhere = owned(nowhere);
                // Each asked for as soon as it is refused, while the error is still its own.
                let its = |handle: &OwnedHandle| {
                    inherited(handle.as_raw_handle()).ok_or_else(|| failed("DuplicateHandle"))
                };
                let theirs = [
                    Some(its(&input)?),
                    Some(its(&output)?),
                    Some(its(&nowhere)?),
                ];
                Ok((Some(File::from(stdin)), Some(File::from(stdout)), theirs))
            }
        }
    }
}

/// One argument of a command line, as the C runtime's rules read it back whole and as
/// Rust's `Command::arg` writes it: in quotes where it is empty or holds a blank, a quote
/// in it escaped, and the backslashes before a quote doubled.
#[allow(dead_code)]
pub fn argument(text: &str) -> Vec<u16> {
    let (quote, backslash) = (u16::from(b'"'), u16::from(b'\\'));
    let quoted = text.is_empty() || text.contains([' ', '\t']);
    let mut written = Vec::new();
    if quoted {
        written.push(quote);
    }
    let mut backslashes = 0;
    for unit in text.encode_utf16() {
        if unit == backslash {
            backslashes += 1;
        } else {
            if unit == quote {
                // One more than those before it, so they and it are read as written.
                written.extend(std::iter::repeat_n(backslash, backslashes + 1));
            }
            backslashes = 0;
        }
        written.push(unit);
    }
    if quoted {
        // Those before the closing quote again, so it still closes.
        written.extend(std::iter::repeat_n(backslash, backslashes));
        written.push(quote);
    }
    written
}

/// A program started in a job: Rust's `Child`, as far as its starters use one.
pub struct Process {
    /// What it reads, where its streams are `Piped`.
    pub stdin: Option<File>,
    /// What it prints, where its streams are `Piped`.
    pub stdout: Option<File>,
    handle: OwnedHandle,
}

impl Process {
    /// Waits for it to end, its input closed first as `Child::wait` closes it, and gives
    /// the code it ended with.
    pub fn wait(&mut self) -> std::io::Result<u32> {
        drop(self.stdin.take());
        let handle = self.handle.as_raw_handle();
        let mut code = 0;
        if unsafe { WaitForSingleObject(handle, INFINITE) } != 0
            || unsafe { GetExitCodeProcess(handle, &mut code) } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(code)
    }
}

impl AsRawHandle for Process {
    fn as_raw_handle(&self) -> RawHandle {
        self.handle.as_raw_handle()
    }
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
    /// `program` started with `arguments`, the rest of its command line as it is to read
    /// it, in a new job with `limits` (`KILL_ON_CLOSE`, `BREAKAWAY_OK`), which holds it
    /// from its first instant (see the top of this file), in its starter's folder and
    /// environment. Where Windows refuses any of that, nothing of the program has run, and
    /// the error says which step.
    pub fn start(
        program: &Path,
        arguments: &[u16],
        streams: Streams,
        limits: u32,
    ) -> Result<(Process, Job), String> {
        if arguments.contains(&0) {
            return Err("its arguments hold a NUL".to_owned());
        }
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(failed("CreateJobObjectW"));
        }
        let job = Job { handle, limits };
        if !job.limit(limits) {
            return Err(failed("SetInformationJobObject"));
        }
        // One start at a time, from its streams to its creation: a program inherits every
        // handle its starter holds to be inherited just then, and one that got another
        // program's end of a pipe would hold that pipe open for as long as it ran.
        let _starting = STARTING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (stdin, stdout, theirs) = streams.open()?;

        // The program's name in quotes, as it is its own first argument, then the rest.
        let quote = u16::from(b'"');
        let application: Vec<u16> = program.as_os_str().encode_wide().chain([0]).collect();
        let mut line = vec![quote];
        line.extend(program.as_os_str().encode_wide());
        line.push(quote);
        if !arguments.is_empty() {
            line.push(u16::from(b' '));
            line.extend_from_slice(arguments);
        }
        line.push(0);

        // The list of one attribute, the job, in memory Windows sizes and lays out itself.
        let mut size = 0;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let mut list = vec![0usize; size.div_ceil(size_of::<usize>()).max(1)];
        let attributes = list.as_mut_ptr().cast::<c_void>();
        if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut size) } == 0 {
            return Err(failed("InitializeProcThreadAttributeList"));
        }
        // Read when the program is created, so it lives until then.
        let jobs = [job.handle];
        let stream = |index: usize| {
            theirs[index]
                .as_ref()
                .map_or(std::ptr::null_mut(), AsRawHandle::as_raw_handle)
        };
        // SAFETY: STARTUPINFOEXW is integers and pointers, for which zero is "none".
        let mut startup: ExtendedStartup = unsafe { std::mem::zeroed() };
        startup.startup.size = size_of::<ExtendedStartup>() as u32;
        startup.attributes = attributes;
        if theirs.iter().any(Option::is_some) {
            startup.startup.flags = USE_STREAMS;
            startup.startup.input = stream(0);
            startup.startup.output = stream(1);
            startup.startup.errors = stream(2);
        }
        let mut created = Created {
            process: std::ptr::null_mut(),
            thread: std::ptr::null_mut(),
            pid: 0,
            thread_id: 0,
        };
        let listed = unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                JOB_LIST,
                jobs.as_ptr().cast(),
                size_of::<*mut c_void>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } != 0;
        // It inherits the handles made for it, and whatever else this process holds to be
        // inherited, as a program Rust's `Command` starts does. `Command` keeps a lock of
        // its own for that, which nothing here can take: a starter that also starts
        // programs with `Command`, on another thread, could hand one of them these ends.
        // Neither binary does (the relay's tests do, which only slows them).
        let refused = if !listed {
            Some(failed("UpdateProcThreadAttribute"))
        } else if unsafe {
            CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                EXTENDED_STARTUP | UNICODE_ENVIRONMENT,
                std::ptr::null_mut(),
                std::ptr::null(),
                &mut startup,
                &mut created,
            )
        } == 0
        {
            Some(failed("CreateProcessW"))
        } else {
            None
        };
        unsafe { DeleteProcThreadAttributeList(attributes) };
        if let Some(refused) = refused {
            return Err(refused);
        }
        unsafe { CloseHandle(created.thread) };
        // Its own ends close here with `theirs`, so its output ends once it and all it
        // started let go of theirs.
        let process = Process {
            stdin,
            stdout,
            handle: owned(created.process),
        };
        Ok((process, job))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lays_out_the_limits_as_windows_reads_them() {
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows.
        assert_eq!(size_of::<ExtendedLimits>(), 144);
    }

    #[test]
    fn lays_out_what_starts_a_program_as_windows_reads_it() {
        // STARTUPINFOEXW is 112 bytes on 64-bit Windows, PROCESS_INFORMATION 24.
        assert_eq!(size_of::<ExtendedStartup>(), 112);
        assert_eq!(size_of::<Created>(), 24);
    }

    fn written(text: &str) -> String {
        String::from_utf16(&argument(text)).unwrap()
    }

    #[test]
    fn an_argument_is_quoted_only_where_it_is_empty_or_holds_a_blank() {
        assert_eq!(written("-c"), "-c");
        assert_eq!(written(r"C:\a\b"), r"C:\a\b");
        assert_eq!(written(""), r#""""#);
        assert_eq!(written("a b"), r#""a b""#);
        assert_eq!(written("a\tb"), "\"a\tb\"");
    }

    #[test]
    fn an_arguments_quotes_and_the_backslashes_before_them_are_escaped() {
        assert_eq!(written(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(written(r#"a\"b"#), r#"a\\\"b"#);
        // Before the closing quote they double; anywhere else they stay as written.
        assert_eq!(written(r"a b\"), r#""a b\\""#);
        assert_eq!(written(r"a\b c"), r#""a\b c""#);
    }

    /// The system's own cmd, as `novadeck-cmd` finds it.
    fn cmd() -> std::path::PathBuf {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        Path::new(&root).join("System32").join("cmd.exe")
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn a_program_is_started_with_its_arguments_and_tells_how_it_ended() {
        let (mut program, _job) = Job::start(
            &cmd(),
            &wide("/d /c exit 7"),
            Streams::Shared,
            KILL_ON_CLOSE,
        )
        .unwrap();
        assert_eq!(program.wait().unwrap(), 7);
    }

    #[test]
    fn a_piped_program_reads_what_it_is_written_and_what_it_prints_is_read() {
        use std::io::{Read, Write};

        let (mut program, _job) = Job::start(
            &cmd(),
            &wide("/d /c findstr x"),
            Streams::Piped,
            KILL_ON_CLOSE,
        )
        .unwrap();
        let mut stdin = program.stdin.take().unwrap();
        stdin.write_all(b"one x\r\ntwo\r\n").unwrap();
        // Its input ends, and so does it, once the starter's end closes.
        drop(stdin);
        let mut printed = String::new();
        program
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut printed)
            .unwrap();
        assert_eq!(printed.trim(), "one x");
        assert_eq!(program.wait().unwrap(), 0);
    }

    #[test]
    fn a_program_is_in_its_job_before_it_runs() {
        // Ended through its job alone, at once: one not yet in it would run on, and end
        // with its own code.
        let (mut program, job) = Job::start(
            &cmd(),
            &wide("/d /c ping -n 30 127.0.0.1 >nul & exit 7"),
            Streams::Shared,
            KILL_ON_CLOSE,
        )
        .unwrap();
        job.end();
        assert_eq!(program.wait().unwrap(), 1);
    }

    #[test]
    fn a_refusal_says_which_step_windows_refused() {
        let nowhere = Path::new(r"C:\no\such\program.exe");
        let refused = Job::start(nowhere, &[], Streams::Shared, KILL_ON_CLOSE)
            .err()
            .unwrap();
        assert!(refused.starts_with("CreateProcessW failed"), "{refused}");
    }
}
