//! A pass-through for Windows' `cmd.exe`, for the programs that find `cmd` through PATH and
//! run their hooks as `cmd /c "<command>"` (Antigravity's Go does). It starts the real
//! `cmd.exe` with `/d`, which skips the machine's AutoRun, so AutoRun's output cannot break
//! a hook's answer. Only for Novadeck's own hook commands (`is_hook`): its folder is on the
//! PATH of everything Antigravity starts, and any other `cmd` (the agent's tools') must still
//! run the person's AutoRun, so that one is passed on with the arguments it was given. The
//! command line it passes on is the one it was given, untouched, with `/d ` before it for a hook.
//!
//! It finds the real `cmd.exe` in the system directory Windows reports
//! (`GetSystemDirectoryW`), never through PATH, which would find itself, nor through
//! `%SystemRoot%`, which the environment of the process that started it can set.
//! With `NOVADECK_CMD_LOG` set to a file, it appends the arguments it passes on there
//! (for tests; nothing in Novadeck sets it).
//!
//! Windows only: elsewhere there is no cmd, and the program does nothing.

/// What follows the program name in a raw Windows command line, as the C runtime reads
/// argv[0]: a name in quotes ends at the next quote (no escapes), any other at the first
/// space or tab. The blanks after the name are dropped; the rest is kept as it is.
#[cfg(any(windows, test))]
fn after_program(line: &[u16]) -> &[u16] {
    let quote = u16::from(b'"');
    let blank = |unit: &u16| *unit == u16::from(b' ') || *unit == u16::from(b'\t');
    let name_end = if line.first() == Some(&quote) {
        line[1..]
            .iter()
            .position(|unit| *unit == quote)
            .map_or(line.len(), |at| at + 2)
    } else {
        line.iter().position(blank).unwrap_or(line.len())
    };
    let rest = &line[name_end..];
    &rest[rest.iter().take_while(|unit| blank(unit)).count()..]
}

/// Whether `rest` (the arguments `cmd` was given) is one of Novadeck's hook commands. The
/// Antigravity plugin writes its hooks as `if defined NOVADECK_HOOK (...)`, and a narrowed
/// terminal's PreToolUse as the relay alone, `<folder>\novadeck-relay.exe hook --config ...`
/// (only its folder is ever shortened, never the file's name). Antigravity runs either as
/// `cmd /c <that>`, with or without quotes round it. cmd's own case rules apply to the names.
#[cfg(any(windows, test))]
fn is_hook(rest: &[u16]) -> bool {
    let lower = |unit: u16| match u8::try_from(unit) {
        Ok(byte) => u16::from(byte.to_ascii_lowercase()),
        Err(_) => unit,
    };
    ["if defined novadeck_hook", "\\novadeck-relay.exe hook "]
        .iter()
        .any(|marker| {
            let marker: Vec<u16> = marker.encode_utf16().collect();
            rest.windows(marker.len()).any(|window| {
                window
                    .iter()
                    .zip(&marker)
                    .all(|(unit, want)| lower(*unit) == *want)
            })
        })
}

/// The arguments the real `cmd.exe` gets: `rest` as it is, with `/d ` before it for a hook.
#[cfg(any(windows, test))]
fn passed_on(rest: &[u16]) -> Vec<u16> {
    let mut arguments: Vec<u16> = if is_hook(rest) {
        "/d ".encode_utf16().collect()
    } else {
        Vec::new()
    };
    arguments.extend_from_slice(rest);
    arguments
}

/// The system directory as Windows fills it in: `call` is `GetSystemDirectoryW` over the
/// buffer it gets, and returns the length written without the final NUL, or, when the buffer
/// is too small, the length needed with it; 0 means failure. Tries again with a larger buffer.
#[cfg(any(windows, test))]
fn system_directory(mut call: impl FnMut(&mut [u16]) -> u32) -> Option<Vec<u16>> {
    let mut buffer = vec![0u16; 260];
    for _ in 0..2 {
        let length = call(&mut buffer) as usize;
        if length == 0 {
            return None;
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Some(buffer);
        }
        buffer = vec![0u16; length + 1];
    }
    None
}

/// Appends `rest` and a newline to the file at `path`, when it can.
#[cfg(any(windows, test))]
fn append_log(path: &std::path::Path, rest: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(format!("{rest}\n").as_bytes());
    }
}

#[cfg(windows)]
fn main() {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCommandLineW() -> *const u16;
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
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
    let arguments = passed_on(after_program(line));

    if let Some(path) = std::env::var_os("NOVADECK_CMD_LOG").filter(|path| !path.is_empty()) {
        append_log(
            &PathBuf::from(path),
            &OsString::from_wide(&arguments).to_string_lossy(),
        );
    }

    // SAFETY: the buffer is valid for the size passed with it.
    let system = system_directory(|buffer| unsafe {
        GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
    })
    .map_or_else(
        || PathBuf::from(r"C:\Windows\System32"),
        |wide| PathBuf::from(OsString::from_wide(&wide)),
    );
    let cmd = system.join("cmd.exe");
    let code = match Command::new(&cmd)
        .raw_arg(OsString::from_wide(&arguments))
        .status()
    {
        Ok(status) => status.code().unwrap_or(1),
        Err(error) => {
            eprintln!("novadeck-cmd: cannot run {}: {error}", cmd.display());
            1
        }
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {}

#[cfg(test)]
mod tests {
    use super::{after_program, append_log, is_hook, passed_on, system_directory};

    fn rest(line: &str) -> String {
        let wide: Vec<u16> = line.encode_utf16().collect();
        String::from_utf16(after_program(&wide)).unwrap()
    }

    #[test]
    fn an_unquoted_name_ends_at_the_first_blank() {
        assert_eq!(rest(r#"cmd /c "echo hi""#), r#"/c "echo hi""#);
        assert_eq!(rest("cmd\t/c x"), "/c x");
    }

    #[test]
    fn a_quoted_name_may_hold_spaces() {
        assert_eq!(
            rest(r#""C:\Program Files\x\cmd.exe" /c "a  b""#),
            r#"/c "a  b""#
        );
    }

    #[test]
    fn a_quoted_name_is_not_split_by_quotes_in_the_rest() {
        assert_eq!(rest(r#""cmd" /c "x" "y""#), r#"/c "x" "y""#);
    }

    #[test]
    fn the_rest_keeps_its_inner_blanks_and_trailing_ones() {
        assert_eq!(rest("cmd   /c  a  b  "), "/c  a  b  ");
    }

    #[test]
    fn a_name_alone_leaves_an_empty_rest() {
        assert_eq!(rest("cmd"), "");
        assert_eq!(rest(r#""C:\a b\cmd.exe""#), "");
        assert_eq!(rest(r#""C:\a b\cmd.exe"  "#), "");
        assert_eq!(rest(""), "");
    }

    #[test]
    fn an_unclosed_quote_takes_the_whole_line_as_the_name() {
        assert_eq!(rest(r#""cmd /c x"#), "");
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn passed(rest: &str) -> String {
        String::from_utf16(&passed_on(&wide(rest))).unwrap()
    }

    #[test]
    fn a_hook_command_gets_d_and_is_otherwise_untouched() {
        let hook = r#"/c "if defined NOVADECK_HOOK (if exist %NOVADECK_HOOK% (%NOVADECK_HOOK% agy Stop) else (echo {})) else (echo {})""#;
        assert!(is_hook(&wide(hook)));
        assert_eq!(passed(hook), format!("/d {hook}"));
        // Unquoted, and in any case.
        assert!(is_hook(&wide("/c IF DEFINED novadeck_hook (echo {})")));
        // A narrowed terminal's PreToolUse: the relay alone, by its shortened folder.
        let narrowed = r#"/c "C:\Users\RUNNER~1\AppData\Roaming\NOVADE~1\shell\novadeck-relay.exe hook --config C:\Users\RUNNER~1\AppData\Roaming\NOVADE~1\shell\relay.json""#;
        assert!(is_hook(&wide(narrowed)));
        assert_eq!(passed(narrowed), format!("/d {narrowed}"));
        assert!(is_hook(&wide(
            r"/c C:\X\NOVADECK-RELAY.EXE HOOK --config y"
        )));
    }

    #[test]
    fn any_other_command_runs_the_persons_autorun_with_its_arguments_unchanged() {
        for rest in [
            r#"/c "echo hi""#,
            r#"/s /c "node C:\a\marker.cjs""#,
            "/c echo %NOVADECK_HOOK%",
            // The relay in any other mode, or a file merely named like it, is not a hook.
            r"/c C:\X\novadeck-relay.exe mcp --config y",
            r"/c type C:\X\novadeck-relay.exe.hook",
            "",
            "/k",
        ] {
            assert!(!is_hook(&wide(rest)), "{rest}");
            assert_eq!(passed(rest), rest);
        }
    }

    #[test]
    fn the_system_directory_is_what_the_call_wrote() {
        let path = wide(r"C:\Windows\System32");
        let found = system_directory(|buffer| {
            buffer[..path.len()].copy_from_slice(&path);
            path.len() as u32
        });
        assert_eq!(found, Some(path));
    }

    #[test]
    fn a_buffer_too_small_is_asked_again_larger() {
        let path = wide(&format!(r"C:\{}", "a".repeat(300)));
        let mut sizes = Vec::new();
        let found = system_directory(|buffer| {
            sizes.push(buffer.len());
            if buffer.len() <= path.len() {
                return path.len() as u32 + 1;
            }
            buffer[..path.len()].copy_from_slice(&path);
            path.len() as u32
        });
        assert_eq!(found, Some(path.clone()));
        assert_eq!(sizes, vec![260, path.len() + 2]);
    }

    #[test]
    fn a_failing_call_gives_nothing() {
        assert_eq!(system_directory(|_| 0), None);
    }

    #[test]
    fn the_log_gets_one_line_per_run() {
        let dir = std::env::temp_dir().join(format!("novadeck-cmd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("log.txt");
        append_log(&log, r#"/c "a  b""#);
        append_log(&log, "/c x");
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "/c \"a  b\"\n/c x\n"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
