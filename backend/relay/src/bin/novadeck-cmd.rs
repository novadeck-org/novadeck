//! A pass-through for Windows' `cmd.exe`, for the programs that find `cmd` through PATH and
//! run their hooks as `cmd /c "<command>"` (Antigravity's Go does). It starts the real
//! `cmd.exe` with `/d`, which skips the machine's AutoRun, so AutoRun's output cannot break
//! a hook's answer. The command line it passes on is the one it was given, untouched.
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

#[cfg(windows)]
fn main() {
    use std::ffi::OsString;
    use std::io::Write;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCommandLineW() -> *const u16;
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
    let rest = OsString::from_wide(after_program(line));

    if let Some(path) = std::env::var_os("NOVADECK_CMD_LOG").filter(|path| !path.is_empty()) {
        let mut text = rest.to_string_lossy().into_owned();
        text.push('\n');
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = file.write_all(text.as_bytes());
        }
    }

    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let cmd = PathBuf::from(root).join("System32").join("cmd.exe");
    let mut arguments: Vec<u16> = "/d ".encode_utf16().collect();
    arguments.extend(rest.encode_wide());

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
    use super::after_program;

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
}
