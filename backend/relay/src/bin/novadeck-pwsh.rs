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
//! It finds the real shell on PATH past its own folder and its own file however PATH spells
//! them, then where Codex looks when PATH has none (`C:\Program Files\PowerShell\7\pwsh.exe`,
//! Windows PowerShell in the system folder). As `pwsh` where there is no PowerShell 7, as on a
//! stock Windows, it runs Windows PowerShell, which Codex would have run had it found no pwsh.
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

/// The shells a pass-through may start, in the order it looks for them, each with where to
/// look when PATH has none: for `pwsh`, PowerShell 7, else Windows PowerShell, as Codex would
/// have run had it found no pwsh at all (a stock Windows has only Windows PowerShell); for
/// `powershell`, Windows PowerShell alone.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn wanted(shell: &str, system: &Path) -> Vec<(&'static str, Vec<PathBuf>)> {
    let windows_powershell = (
        "powershell",
        vec![system.join(r"WindowsPowerShell\v1.0\powershell.exe")],
    );
    if shell == "pwsh" {
        vec![
            (
                "pwsh",
                vec![PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")],
            ),
            windows_powershell,
        ]
    } else {
        vec![windows_powershell]
    }
}

/// The real shell: for each of `wanted` in turn, the first `<shell>.exe` on `path` outside
/// `own` (the pass-through's folder), else the first of its fallbacks, that is `usable` (a
/// file, and not the pass-through itself however its path is spelled).
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn real_shell(
    wanted: &[(&str, Vec<PathBuf>)],
    path: &OsStr,
    own: &Path,
    usable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    wanted.iter().find_map(|(shell, fallbacks)| {
        let file = format!("{shell}.exe");
        std::env::split_paths(path)
            .filter(|folder| !folder.as_os_str().is_empty() && !same_folder(folder, own))
            .map(|folder| folder.join(&file))
            .chain(fallbacks.iter().cloned())
            .find(|candidate| usable(candidate))
    })
}

/// What names one capture: the pass-through's pid and when it started, in milliseconds.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn capture_id(pid: u32, started: u128) -> String {
    format!("{started}-{pid}")
}

/// The record beside a capture's log: what ran, where and when, whether its output reached
/// the log (false where Windows refused the shell its pipes, and it ran uncaptured), and its
/// code once it ended.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn record(
    command_line: &str,
    shell: &Path,
    folder: &Path,
    started: u128,
    captured: bool,
    code: Option<u32>,
) -> String {
    serde_json::json!({
        "commandLine": command_line,
        "shell": shell.to_string_lossy(),
        "folder": folder.to_string_lossy(),
        "started": started,
        "captured": captured,
        "exit": code,
    })
    .to_string()
}

/// Writes a capture's record whole: to a file beside it first, then over it, so a reader
/// never finds it half written.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn write_record(base: &Path, text: &str) -> std::io::Result<()> {
    let temporary = base.with_extension("json.tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, base.with_extension("json"))
}

#[cfg(windows)]
fn main() {
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// STD_OUTPUT_HANDLE and STD_ERROR_HANDLE, and FILE_TYPE_PIPE from GetFileType.
    const OUTPUT: u32 = -11i32 as u32;
    const ERRORS: u32 = -12i32 as u32;
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
    // Itself, by the path Windows resolves it to, whatever spelling of its folder PATH holds
    // (short names, links, `.` and `..`), so it never starts itself.
    let itself = std::fs::canonicalize(&own).ok();
    let usable = |candidate: &Path| {
        candidate.is_file() && (itself.is_none() || std::fs::canonicalize(candidate).ok() != itself)
    };
    let real = real_shell(
        &wanted(shell, &system),
        &std::env::var_os("PATH").unwrap_or_default(),
        own.parent().unwrap_or(Path::new("")),
        usable,
    )
    .unwrap_or_else(|| fail(format!("no {shell}.exe found past its own")));

    let capture = std::env::var_os("NOVADECK_CAPTURE").filter(|folder| !folder.is_empty());
    // SAFETY: nothing else runs yet, no thread reads the environment.
    unsafe { std::env::remove_var("NOVADECK_CAPTURE") };
    // Captured only where both its output and its errors are pipes, so what it passes on goes
    // where it would have gone, byte for byte.
    // SAFETY: standard handles, which GetFileType only reads.
    let piped = unsafe {
        GetFileType(GetStdHandle(OUTPUT)) == PIPE && GetFileType(GetStdHandle(ERRORS)) == PIPE
    };
    let started = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis());
    let command = OsString::from_wide(&arguments)
        .to_string_lossy()
        .into_owned();
    let folder = std::env::current_dir().unwrap_or_default();
    // The log and its record, where there is a folder to capture to and a pipe to capture.
    let log = capture.filter(|_| piped).and_then(|capture| {
        // The terminal's folder, made by whichever command captures first.
        std::fs::create_dir_all(&capture).ok()?;
        let base =
            PathBuf::from(capture).join(format!("out-{}", capture_id(std::process::id(), started)));
        // Its record first, so no log is ever left without one.
        write_record(
            &base,
            &record(&command, &real, &folder, started, true, None),
        )
        .ok()?;
        match std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(base.with_extension("log"))
        {
            Ok(file) => Some((base, Arc::new(Mutex::new(file)))),
            Err(_) => {
                let _ = std::fs::remove_file(base.with_extension("json"));
                None
            }
        }
    });

    let limits = job::KILL_ON_CLOSE | job::BREAKAWAY_OK;
    let streams = if log.is_some() {
        job::Streams::Captured
    } else {
        job::Streams::Shared
    };
    let mut captured = log.is_some();
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
            // What the shell left running goes on, as it would after the shell, even should the
            // pass-through be ended while it passes on what that still prints.
            job.let_go();
            // What the shell left running may hold its streams open: passed on a moment more,
            // the same moment for both.
            let deadline = Instant::now() + AFTER_EXIT;
            for _ in 0..copying {
                let left = deadline.saturating_duration_since(Instant::now());
                if finished.recv_timeout(left).is_err() {
                    break;
                }
            }
            status
        }
        // Where Windows refuses the job, nothing ran yet: the shell runs without one, and
        // without a capture, as `novadeck-cmd` runs cmd.
        Err(_) => {
            captured = false;
            Command::new(&real)
                .raw_arg(OsString::from_wide(&arguments))
                .spawn()
                .and_then(|mut child| child.wait().map(|status| status.code().unwrap_or(1) as u32))
        }
    };
    let code = code.unwrap_or_else(|error| fail(format!("cannot run {}: {error}", real.display())));
    if let Some((base, _)) = &log {
        let _ = write_record(
            base,
            &record(&command, &real, &folder, started, captured, Some(code)),
        );
    }
    std::process::exit(code as i32);
}

#[cfg(not(windows))]
fn main() {}

#[cfg(test)]
mod tests {
    use super::{capture_id, real_shell, record, same_folder, shell_of, wanted, write_record};
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

    fn pwsh_then_powershell() -> Vec<(&'static str, Vec<PathBuf>)> {
        vec![
            ("pwsh", vec![PathBuf::from("ps7").join("pwsh.exe")]),
            (
                "powershell",
                vec![PathBuf::from("system").join("powershell.exe")],
            ),
        ]
    }

    #[test]
    fn the_real_shell_is_the_first_on_path_past_its_own_folder() {
        let own = Path::new("own");
        let path = joined(&["own", "", "a", "b"]);
        let has = |candidate: &Path| candidate != Path::new("a").join("pwsh.exe");
        // Not in its own folder, though one is there; "a" has none; "b" has.
        assert_eq!(
            real_shell(&pwsh_then_powershell(), &path, own, has),
            Some(Path::new("b").join("pwsh.exe"))
        );
    }

    #[test]
    fn without_one_on_path_its_fallback_is_taken() {
        let path = joined(&["own", "a"]);
        let has = |candidate: &Path| candidate == Path::new("ps7").join("pwsh.exe");
        assert_eq!(
            real_shell(&pwsh_then_powershell(), &path, Path::new("own"), has),
            Some(PathBuf::from("ps7").join("pwsh.exe"))
        );
    }

    #[test]
    fn without_any_pwsh_it_runs_windows_powershell_as_codex_would_have() {
        let path = joined(&["own", "a"]);
        // Windows PowerShell on PATH comes before its fallback.
        let on_path = |candidate: &Path| candidate.ends_with("powershell.exe");
        assert_eq!(
            real_shell(&pwsh_then_powershell(), &path, Path::new("own"), on_path),
            Some(Path::new("a").join("powershell.exe"))
        );
        let in_system = |candidate: &Path| candidate.starts_with("system");
        assert_eq!(
            real_shell(&pwsh_then_powershell(), &path, Path::new("own"), in_system),
            Some(PathBuf::from("system").join("powershell.exe"))
        );
        assert_eq!(
            real_shell(&pwsh_then_powershell(), &path, Path::new("own"), |_| false),
            None
        );
    }

    #[test]
    fn a_candidate_that_is_itself_is_passed_over() {
        // Its folder spelled otherwise on PATH, which the folder test misses: what `usable`
        // tells as itself is skipped, and the next one taken.
        let path = joined(&["own2", "b"]);
        let usable = |candidate: &Path| candidate != Path::new("own2").join("pwsh.exe");
        assert_eq!(
            real_shell(&pwsh_then_powershell(), &path, Path::new("own"), usable),
            Some(Path::new("b").join("pwsh.exe"))
        );
    }

    #[test]
    fn powershell_stands_only_for_windows_powershell() {
        let system = Path::new("system");
        let shells: Vec<&str> = wanted("powershell", system)
            .iter()
            .map(|(shell, _)| *shell)
            .collect();
        assert_eq!(shells, ["powershell"]);
        let shells: Vec<&str> = wanted("pwsh", system)
            .iter()
            .map(|(shell, _)| *shell)
            .collect();
        assert_eq!(shells, ["pwsh", "powershell"]);
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
            true,
            None,
        ))
        .unwrap();
        assert_eq!(running["commandLine"], r#"-NoProfile -Command "sleep 1""#);
        assert_eq!(running["started"], 7);
        assert_eq!(running["captured"], true);
        assert!(running["exit"].is_null());
        let ended: serde_json::Value = serde_json::from_str(&record(
            "",
            Path::new("s"),
            Path::new("f"),
            7,
            false,
            Some(3),
        ))
        .unwrap();
        assert_eq!(ended["exit"], 3);
        assert_eq!(ended["captured"], false);
    }

    #[test]
    fn a_record_is_replaced_whole() {
        let dir = std::env::temp_dir().join(format!("novadeck-pwsh-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.join("out-1-2");
        write_record(&base, "first").unwrap();
        write_record(&base, "second").unwrap();
        assert_eq!(
            std::fs::read_to_string(base.with_extension("json")).unwrap(),
            "second"
        );
        assert!(!base.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
