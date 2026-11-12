//! A pass-through for Windows' PowerShell, for Codex, which finds its shell through PATH
//! (`pwsh`, else `powershell`) and runs each command as `<shell> [-NoProfile] -Command <cmd>`.
//! Installed as `pwsh.exe` and `powershell.exe` in a folder first on Codex's PATH, it starts
//! the real shell of its own name with the command line it was given, untouched, and, where
//! `NOVADECK_CAPTURE` names a folder and its output is a pipe (a command run without a
//! terminal), copies what the shell prints, as it prints it, to a log there as well as on to
//! Codex: `out-<id>.log`, with `out-<id>.json` beside it telling the command line, the folder,
//! when it started and, once it ended, its exit code. A command run in a terminal (Codex's
//! `tty`) writes to a console, which no pipe can read, and is only passed on. So is every
//! command where nothing names a folder, or the log can't be made there.
//!
//! It finds the real shell on PATH past its own folder, then where Codex looks when PATH has
//! none (`C:\Program Files\PowerShell\7\pwsh.exe`, Windows PowerShell in the system folder).
//! The shell doesn't inherit `NOVADECK_CAPTURE`, so a PowerShell a command starts runs as it
//! would without Novadeck.
//!
//! It stands in for the shell to whatever started it, as `novadeck-cmd` does for cmd: the shell
//! runs in a job that ends with the pass-through should it be killed (Codex's `/stop`), Ctrl+C
//! and Ctrl+Break are left to the shell, and its exit code is passed on. Once the shell exits by
//! itself, what it left running goes on, and what that still prints is passed on for a moment.
//!
//! Windows only: elsewhere there is no such PowerShell, and the program does nothing.

#[cfg(windows)]
#[allow(dead_code)]
#[path = "../job.rs"]
mod job;

#[cfg(any(windows, test))]
#[allow(dead_code)]
#[path = "../command_line.rs"]
mod command_line;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// The shell a pass-through stands in for, by its own file name: `pwsh` or `powershell`, in
/// any case, with or without `.exe`.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn shell_of(program: &Path) -> Option<&'static str> {
    let name = program
        .to_str()?
        .rsplit(['\\', '/'])
        .next()?
        .to_ascii_lowercase();
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "pwsh" => Some("pwsh"),
        "powershell" => Some("powershell"),
        _ => None,
    }
}

/// Whether two folders are the same, as Windows compares names: in any case, a trailing
/// separator or none.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn same_folder(a: &Path, b: &Path) -> bool {
    let name = |path: &Path| {
        path.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase()
    };
    name(a) == name(b)
}

/// The real `shell` (`pwsh` or `powershell`): the first `<shell>.exe` on `path` outside `own`
/// (the pass-through's folder), else the first of `fallbacks` there is.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn real_shell(
    shell: &str,
    path: &OsStr,
    own: &Path,
    fallbacks: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let file = format!("{shell}.exe");
    std::env::split_paths(path)
        .filter(|folder| !folder.as_os_str().is_empty() && !same_folder(folder, own))
        .map(|folder| folder.join(&file))
        .chain(fallbacks.iter().cloned())
        .find(|candidate| exists(candidate))
}

/// What names one capture: the pass-through's pid and when it started, in milliseconds.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn capture_id(pid: u32, started: u128) -> String {
    format!("{started}-{pid}")
}

/// The record beside a capture's log: what ran, where and when, and its code once it ended.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn record(
    command_line: &str,
    shell: &Path,
    folder: &Path,
    started: u128,
    code: Option<u32>,
) -> String {
    serde_json::json!({
        "commandLine": command_line,
        "shell": shell.to_string_lossy(),
        "folder": folder.to_string_lossy(),
        "started": started,
        "exit": code,
    })
    .to_string()
}

#[cfg(windows)]
fn main() {
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCommandLineW() -> *const u16;
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
        fn GetStdHandle(stream: u32) -> *mut std::ffi::c_void;
        fn GetFileType(handle: *mut std::ffi::c_void) -> u32;
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    /// STD_OUTPUT_HANDLE, and FILE_TYPE_PIPE from GetFileType.
    const OUTPUT: u32 = -11i32 as u32;
    const PIPE: u32 = 3;
    /// How long what the shell left running may still print, once it exited, before the
    /// pass-through exits too.
    const AFTER_EXIT: Duration = Duration::from_secs(2);

    /// Ctrl+C (0) and Ctrl+Break (1) are the shell's to answer, as in `novadeck-cmd`.
    unsafe extern "system" fn leave_to_shell(event: u32) -> i32 {
        i32::from(event <= 1)
    }
    // SAFETY: the handler is a plain function that lives as long as the process.
    unsafe { SetConsoleCtrlHandler(Some(leave_to_shell), 1) };

    fn fail(message: String) -> ! {
        let _ = writeln!(std::io::stderr(), "novadeck-pwsh: {message}");
        std::process::exit(1)
    }

    // SAFETY: GetCommandLineW returns this process's command line, a NUL-terminated string
    // that lives as long as the process.
    let line = unsafe {
        let start = GetCommandLineW();
        let mut length = 0;
        while *start.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(start, length)
    };
    let arguments = command_line::after_program(line).to_vec();

    let own = std::env::current_exe().unwrap_or_else(|error| fail(format!("{error}")));
    let shell = shell_of(&own).unwrap_or_else(|| {
        fail(format!(
            "{} is no pwsh.exe or powershell.exe",
            own.display()
        ))
    });
    let mut buffer = vec![0u16; 260];
    // SAFETY: the buffer is valid for the size passed with it.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    let system = if length > 0 && length < buffer.len() {
        PathBuf::from(OsString::from_wide(&buffer[..length]))
    } else {
        PathBuf::from(r"C:\Windows\System32")
    };
    let fallbacks = if shell == "pwsh" {
        vec![PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")]
    } else {
        vec![system.join(r"WindowsPowerShell\v1.0\powershell.exe")]
    };
    let real = real_shell(
        shell,
        &std::env::var_os("PATH").unwrap_or_default(),
        own.parent().unwrap_or(Path::new("")),
        &fallbacks,
        Path::is_file,
    )
    .unwrap_or_else(|| fail(format!("no {shell}.exe found past its own")));

    let capture = std::env::var_os("NOVADECK_CAPTURE").filter(|folder| !folder.is_empty());
    // SAFETY: nothing else runs yet, no thread reads the environment.
    unsafe { std::env::remove_var("NOVADECK_CAPTURE") };
    // SAFETY: a standard handle, which GetFileType only reads.
    let piped = unsafe { GetFileType(GetStdHandle(OUTPUT)) } == PIPE;
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    let command = OsString::from_wide(&arguments)
        .to_string_lossy()
        .into_owned();
    let folder = std::env::current_dir().unwrap_or_default();
    // The log and its record, where there is a folder to capture to and a pipe to capture.
    let log = capture.filter(|_| piped).and_then(|capture| {
        let base =
            PathBuf::from(capture).join(format!("out-{}", capture_id(std::process::id(), started)));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(base.with_extension("log"))
            .ok()?;
        std::fs::write(
            base.with_extension("json"),
            record(&command, &real, &folder, started, None),
        )
        .ok()?;
        Some((base, Arc::new(Mutex::new(file))))
    });

    let limits = job::KILL_ON_CLOSE | job::BREAKAWAY_OK;
    let streams = if log.is_some() {
        job::Streams::Captured
    } else {
        job::Streams::Shared
    };
    let code = match job::Job::start(&real, &arguments, streams, limits) {
        Ok((mut child, job)) => {
            // Each stream passed on as it comes, and to the log.
            let (done, finished) = mpsc::channel::<()>();
            let mut copying = 0;
            if let Some((_, file)) = &log {
                let pass = |from: Option<std::fs::File>, errors: bool| {
                    let (file, done) = (Arc::clone(file), done.clone());
                    from.map(|mut from| {
                        std::thread::spawn(move || {
                            let mut chunk = [0u8; 8192];
                            while let Ok(read) = from.read(&mut chunk) {
                                if read == 0 {
                                    break;
                                }
                                let bytes = &chunk[..read];
                                // Its reader gone, the log still takes it.
                                let _ = if errors {
                                    std::io::stderr().write_all(bytes)
                                } else {
                                    let mut out = std::io::stdout().lock();
                                    out.write_all(bytes).and_then(|()| out.flush())
                                };
                                if let Ok(mut file) = file.lock() {
                                    let _ = file.write_all(bytes);
                                }
                            }
                            let _ = done.send(());
                        })
                    })
                };
                copying += usize::from(pass(child.stdout.take(), false).is_some());
                copying += usize::from(pass(child.stderr.take(), true).is_some());
            }
            let status = child.wait();
            // What the shell left running may hold its streams open: passed on a moment more.
            for _ in 0..copying {
                if finished.recv_timeout(AFTER_EXIT).is_err() {
                    break;
                }
            }
            job.let_go();
            status
        }
        // Where Windows refuses the job, nothing ran yet: the shell runs without one, and
        // without a capture, as `novadeck-cmd` runs cmd.
        Err(_) => Command::new(&real)
            .raw_arg(OsString::from_wide(&arguments))
            .spawn()
            .and_then(|mut child| child.wait().map(|status| status.code().unwrap_or(1) as u32)),
    };
    let code = code.unwrap_or_else(|error| fail(format!("cannot run {}: {error}", real.display())));
    if let Some((base, _)) = &log {
        let _ = std::fs::write(
            base.with_extension("json"),
            record(&command, &real, &folder, started, Some(code)),
        );
    }
    std::process::exit(code as i32);
}

#[cfg(not(windows))]
fn main() {}

#[cfg(test)]
mod tests {
    use super::{capture_id, real_shell, record, same_folder, shell_of};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    #[test]
    fn it_stands_in_for_the_shell_its_name_says() {
        assert_eq!(shell_of(Path::new(r"C:\n\pwsh.exe")), Some("pwsh"));
        assert_eq!(
            shell_of(Path::new(r"C:\n\PowerShell.EXE")),
            Some("powershell")
        );
        assert_eq!(shell_of(Path::new("pwsh")), Some("pwsh"));
        assert_eq!(shell_of(Path::new(r"C:\n\novadeck-pwsh.exe")), None);
        assert_eq!(shell_of(Path::new(r"C:\n\cmd.exe")), None);
    }

    #[test]
    fn folders_compare_as_windows_names_them() {
        assert!(same_folder(
            Path::new(r"C:\Data\Bin"),
            Path::new(r"c:\data\bin\")
        ));
        assert!(same_folder(
            Path::new("C:/data/bin"),
            Path::new(r"C:\data\bin")
        ));
        assert!(!same_folder(
            Path::new(r"C:\data\bin"),
            Path::new(r"C:\data\bin2")
        ));
    }

    fn joined(folders: &[&str]) -> OsString {
        std::env::join_paths(folders).unwrap()
    }

    #[test]
    fn the_real_shell_is_the_first_on_path_past_its_own_folder() {
        let own = Path::new("own");
        let path = joined(&["own", "", "a", "b"]);
        let has = |candidate: &Path| candidate != Path::new("a").join("pwsh.exe");
        // Not in its own folder, though one is there; "a" has none; "b" has.
        assert_eq!(
            real_shell("pwsh", &path, own, &[], has),
            Some(Path::new("b").join("pwsh.exe"))
        );
    }

    #[test]
    fn without_one_on_path_the_fallback_is_taken_and_without_either_none() {
        let fallback = PathBuf::from("fallback").join("pwsh.exe");
        let path = joined(&["own"]);
        assert_eq!(
            real_shell(
                "pwsh",
                &path,
                Path::new("own"),
                std::slice::from_ref(&fallback),
                |_| { true }
            ),
            Some(fallback.clone())
        );
        assert_eq!(
            real_shell("pwsh", &path, Path::new("own"), &[fallback], |_| false),
            None
        );
    }

    #[test]
    fn a_capture_is_named_by_its_start_then_its_pid() {
        assert_eq!(capture_id(42, 1_794_476_883_000), "1794476883000-42");
    }

    #[test]
    fn the_record_tells_the_command_and_its_code_once_it_ended() {
        let running: serde_json::Value = serde_json::from_str(&record(
            r#"-NoProfile -Command "sleep 1""#,
            Path::new(r"C:\pwsh.exe"),
            Path::new(r"C:\project"),
            7,
            None,
        ))
        .unwrap();
        assert_eq!(running["commandLine"], r#"-NoProfile -Command "sleep 1""#);
        assert_eq!(running["started"], 7);
        assert!(running["exit"].is_null());
        let ended: serde_json::Value =
            serde_json::from_str(&record("", Path::new("s"), Path::new("f"), 7, Some(3))).unwrap();
        assert_eq!(ended["exit"], 3);
    }
}
