//! `novadeck-relay environment`: the machine's and the person's environment variables as
//! Windows' registry holds them now, unexpanded, for the runner to build a new terminal's
//! PATH from (see the runner's shell/windows-path.ts). A Windows program keeps the
//! environment it started with, so the app's PATH lacks what was installed since; the
//! registry has it. The relay reads it where the runner would otherwise need PowerShell,
//! which some machines block (AppLocker, WDAC, Constrained Language Mode) and which starts
//! slowly on a cold boot.
//!
//! A line for each text value of `HKLM\SYSTEM\CurrentControlSet\Control\Session
//! Manager\Environment`, then of `HKCU\Environment`: `machine` or `user`, the value's name
//! and its text, each in base64 of its UTF-8, so no console code page touches a folder's
//! name, nor a space splits one. Values of other kinds are left out, and a key that can't
//! be opened gives no lines.

use std::ptr::null_mut;

const LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
const CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
const READ: u32 = 0x2_0019;
const TEXT: u32 = 1;
const EXPANDABLE_TEXT: u32 = 2;
const SUCCESS: i32 = 0;
const MORE_DATA: i32 = 234;
/// The longest value name the registry allows, with its terminating nul.
const NAME_UNITS: usize = 16_384;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegOpenKeyExW(
        key: isize,
        subkey: *const u16,
        options: u32,
        access: u32,
        opened: *mut isize,
    ) -> i32;
    fn RegEnumValueW(
        key: isize,
        index: u32,
        name: *mut u16,
        name_units: *mut u32,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        data_bytes: *mut u32,
    ) -> i32;
    fn RegCloseKey(key: isize) -> i32;
}

/// A key's text values, by name, as written: RegEnumValueW never expands `%NAME%`.
fn values(root: isize, path: &str) -> Vec<(String, String)> {
    let wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    let mut key = 0;
    if unsafe { RegOpenKeyExW(root, wide.as_ptr(), 0, READ, &mut key) } != SUCCESS {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut name = vec![0u16; NAME_UNITS];
    let mut data = vec![0u8; 64 * 1024];
    let mut index = 0;
    loop {
        let mut name_units = NAME_UNITS as u32;
        let mut data_bytes = data.len() as u32;
        let mut kind = 0;
        let read = unsafe {
            RegEnumValueW(
                key,
                index,
                name.as_mut_ptr(),
                &mut name_units,
                null_mut(),
                &mut kind,
                data.as_mut_ptr(),
                &mut data_bytes,
            )
        };
        if read == MORE_DATA {
            // A value longer than the buffer: read the same one again, with room for it.
            data.resize(data_bytes as usize + 2, 0);
            continue;
        }
        if read != SUCCESS {
            break;
        }
        if kind == TEXT || kind == EXPANDABLE_TEXT {
            let name = String::from_utf16_lossy(&name[..name_units as usize]);
            found.push((name, text(&data[..data_bytes as usize])));
        }
        index += 1;
    }
    unsafe { RegCloseKey(key) };
    found
}

/// A value's UTF-16 text, without the nuls that end it.
fn text(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

/// Standard base64, padded.
fn base64(text: &str) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let joined = chunk.iter().enumerate().fold(0u32, |all, (at, byte)| {
            all | u32::from(*byte) << (16 - 8 * at)
        });
        for place in 0..4 {
            if place <= chunk.len() {
                encoded.push(DIGITS[(joined >> (18 - 6 * place) & 63) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
    }
    encoded
}

fn line(scope: &str, name: &str, value: &str) -> String {
    format!("{scope} {} {}", base64(name), base64(value))
}

/// Prints the machine's variables, then the person's, a line each.
pub fn print() {
    let keys = [
        (
            "machine",
            LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
        ("user", CURRENT_USER, "Environment"),
    ];
    for (scope, root, path) in keys {
        for (name, value) in values(root, path) {
            println!("{}", line(scope, &name, &value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64_as_the_runner_decodes_it() {
        assert_eq!(base64(""), "");
        assert_eq!(base64("f"), "Zg==");
        assert_eq!(base64("fo"), "Zm8=");
        assert_eq!(base64("foo"), "Zm9v");
        assert_eq!(base64("Path"), "UGF0aA==");
        assert_eq!(base64(r"C:\Users\Łukasz"), "QzpcVXNlcnNcxYF1a2Fzeg==");
    }

    #[test]
    fn writes_a_line_with_its_spaces_kept_for_an_empty_value() {
        assert_eq!(line("user", "EMPTY", ""), "user RU1QVFk= ");
    }

    #[test]
    fn reads_text_up_to_its_terminating_nul() {
        let bytes: Vec<u8> = "%JAVA_HOME%\\bin\0\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(text(&bytes), "%JAVA_HOME%\\bin");
    }

    #[test]
    fn reads_the_machine_s_path_unexpanded() {
        let machine = values(
            LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        );
        let path = machine
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("Path"))
            .map(|(_, value)| value.as_str())
            .expect("the machine's PATH");
        assert!(path.to_lowercase().contains("system32"), "{path}");
    }
}
