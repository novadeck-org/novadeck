//! `novadeck-relay autorun` and `autorun-set`: cmd.exe's `AutoRun` value, which cmd runs at
//! the start of every instance and whose output Antigravity's hooks would otherwise take for
//! their own (see the approvals design, Appendix F). The runner reads it here and, when the
//! person clicks, rewrites it here, because Node has no registry API, reg.exe prints in the
//! console's code page (which would break an exact Undo) and PowerShell is blocked on some
//! machines.
//!
//! `autorun` prints a line for each scope that holds the value, the person's first:
//! `user|machine <sz|expand|other> <base64 of the value's raw bytes>`. Raw bytes are what
//! RegQueryValueExW returns, never expanded and never trimmed, so a write can put them back
//! exactly. A scope without the key or the value prints nothing; a key or value that exists
//! but can't be read prints `user unreadable` or `machine unreadable`.
//!
//! `autorun-set <sz|expand> <expected-base64> <new-base64>` is a compare-and-swap on the
//! person's value only: the key and the value name are constants here, and no argument names
//! either, so it can write nothing else. It never creates the key or the value and never
//! deletes. Exit codes: 0 `ok`, 3 `changed` (the value is absent, or its type or bytes are
//! not the expected ones), 4 `unverified` (written, but reading it back gave something
//! else), 5 any other failure (the reason on stderr), 2 a usage error.

#[cfg(windows)]
use std::process::ExitCode;

/// `REG_SZ`, `REG_EXPAND_SZ`.
#[cfg(any(windows, test))]
const SZ: u32 = 1;
#[cfg(any(windows, test))]
const EXPAND_SZ: u32 = 2;

/// Where cmd.exe reads its AutoRun from, per scope.
#[cfg(windows)]
const PATH: &str = r"Software\Microsoft\Command Processor";
#[cfg(windows)]
const NAME: &str = "AutoRun";

/// What `autorun-set` was asked: the type the value must have, its expected bytes and the
/// bytes to put in their place.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq)]
pub struct Swap {
    pub kind: u32,
    pub expected: Vec<u8>,
    pub new: Vec<u8>,
}

/// `<sz|expand> <expected-base64> <new-base64>`; None where it is anything else.
#[cfg(any(windows, test))]
pub fn parse_swap(args: &[String]) -> Option<Swap> {
    let [kind, expected, new] = args else {
        return None;
    };
    let kind = match kind.as_str() {
        "sz" => SZ,
        "expand" => EXPAND_SZ,
        _ => return None,
    };
    Some(Swap {
        kind,
        expected: decode(expected)?,
        new: decode(new)?,
    })
}

/// Standard base64, padded.
#[cfg(any(windows, test))]
const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[cfg(any(windows, test))]
fn encode(bytes: &[u8]) -> String {
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

/// Strict standard base64: padded, nothing outside its alphabet, no stray bits after the
/// last byte. None for anything else, so a corrupted argument can't write a different value.
#[cfg(any(windows, test))]
fn decode(text: &str) -> Option<Vec<u8>> {
    let text = text.as_bytes();
    if text.len() % 4 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    let groups = text.len() / 4;
    for (at, group) in text.chunks(4).enumerate() {
        let padding = group.iter().rev().take_while(|c| **c == b'=').count();
        if padding > 2 || (padding > 0 && at + 1 != groups) {
            return None;
        }
        let mut joined = 0u32;
        for (place, c) in group.iter().enumerate() {
            let digit = if place >= 4 - padding {
                0
            } else {
                DIGITS.iter().position(|d| d == c)? as u32
            };
            joined |= digit << (18 - 6 * place);
        }
        // The bits a padded group leaves over must be zero.
        if (padding == 1 && joined & 0xFF != 0) || (padding == 2 && joined & 0xFFFF != 0) {
            return None;
        }
        bytes.extend_from_slice(&joined.to_be_bytes()[1..4 - padding]);
    }
    Some(bytes)
}

#[cfg(windows)]
mod registry {
    use std::ptr::null_mut;

    pub const LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
    pub const CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    pub const QUERY_VALUE: u32 = 0x1;
    pub const SET_VALUE: u32 = 0x2;
    /// The 64-bit view, so a 32-bit relay reads what the 64-bit cmd.exe reads.
    pub const WOW64_64KEY: u32 = 0x100;
    const SUCCESS: i32 = 0;
    pub const NOT_FOUND: i32 = 2;
    const MORE_DATA: i32 = 234;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(
            key: isize,
            subkey: *const u16,
            options: u32,
            access: u32,
            opened: *mut isize,
        ) -> i32;
        fn RegQueryValueExW(
            key: isize,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            data_bytes: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: isize,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            data_bytes: u32,
        ) -> i32;
        fn RegCloseKey(key: isize) -> i32;
        #[cfg(test)]
        fn RegCreateKeyExW(
            key: isize,
            subkey: *const u16,
            reserved: u32,
            class: *const u16,
            options: u32,
            access: u32,
            security: *const u8,
            opened: *mut isize,
            disposition: *mut u32,
        ) -> i32;
        #[cfg(test)]
        fn RegDeleteKeyW(key: isize, subkey: *const u16) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    /// A key opened for `access`, closed when dropped. Err is the Windows error code.
    pub struct Key(isize);

    impl Key {
        pub fn open(root: isize, path: &str, access: u32) -> Result<Key, i32> {
            let mut key = 0;
            let path = wide(path);
            match unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, access, &mut key) } {
                SUCCESS => Ok(Key(key)),
                code => Err(code),
            }
        }

        /// A value's type and raw bytes, as stored; Ok(None) where there is no such value.
        pub fn value(&self, name: &str) -> Result<Option<(u32, Vec<u8>)>, i32> {
            let name = wide(name);
            let mut data = vec![0u8; 4096];
            loop {
                let mut kind = 0;
                let mut bytes = data.len() as u32;
                let read = unsafe {
                    RegQueryValueExW(
                        self.0,
                        name.as_ptr(),
                        null_mut(),
                        &mut kind,
                        data.as_mut_ptr(),
                        &mut bytes,
                    )
                };
                match read {
                    SUCCESS => {
                        data.truncate(bytes as usize);
                        return Ok(Some((kind, data)));
                    }
                    NOT_FOUND => return Ok(None),
                    // Longer than the buffer: read again with room for it (and for a
                    // value that grew meanwhile).
                    MORE_DATA => data.resize(bytes as usize + 2, 0),
                    code => return Err(code),
                }
            }
        }

        pub fn set(&self, name: &str, kind: u32, data: &[u8]) -> Result<(), i32> {
            let name = wide(name);
            match unsafe {
                RegSetValueExW(
                    self.0,
                    name.as_ptr(),
                    0,
                    kind,
                    data.as_ptr(),
                    data.len() as u32,
                )
            } {
                SUCCESS => Ok(()),
                code => Err(code),
            }
        }
    }

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    /// A scratch key under HKCU for a test, created if need be and deleted on drop.
    #[cfg(test)]
    pub struct Scratch(pub String);

    #[cfg(test)]
    impl Scratch {
        pub fn create(path: &str) -> Scratch {
            use std::ptr::null;
            let (mut key, mut disposition) = (0, 0);
            let wide = wide(path);
            let made = unsafe {
                RegCreateKeyExW(
                    CURRENT_USER,
                    wide.as_ptr(),
                    0,
                    null(),
                    0,
                    QUERY_VALUE | SET_VALUE,
                    null(),
                    &mut key,
                    &mut disposition,
                )
            };
            assert_eq!(made, SUCCESS);
            unsafe { RegCloseKey(key) };
            Scratch(path.to_owned())
        }
    }

    #[cfg(test)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            unsafe { RegDeleteKeyW(CURRENT_USER, wide(&self.0).as_ptr()) };
        }
    }
}

/// The value a scope's line shows: Ok(None) for nothing to print, Err for unreadable.
#[cfg(windows)]
fn read(root: isize, path: &str, access: u32) -> Result<Option<(u32, Vec<u8>)>, i32> {
    match registry::Key::open(root, path, access) {
        Ok(key) => key.value(NAME),
        Err(registry::NOT_FOUND) => Ok(None),
        Err(code) => Err(code),
    }
}

#[cfg(windows)]
fn line(scope: &str, found: Result<Option<(u32, Vec<u8>)>, i32>) -> Option<String> {
    match found {
        Ok(None) => None,
        Err(_) => Some(format!("{scope} unreadable")),
        Ok(Some((kind, bytes))) => {
            let kind = match kind {
                SZ => "sz",
                EXPAND_SZ => "expand",
                _ => "other",
            };
            Some(format!("{scope} {kind} {}", encode(&bytes)))
        }
    }
}

/// Prints the person's AutoRun, then the machine's, where each is set.
#[cfg(windows)]
pub fn print() {
    let user = read(registry::CURRENT_USER, PATH, registry::QUERY_VALUE);
    let machine = read(
        registry::LOCAL_MACHINE,
        PATH,
        registry::QUERY_VALUE | registry::WOW64_64KEY,
    );
    for (scope, found) in [("user", user), ("machine", machine)] {
        if let Some(line) = line(scope, found) {
            println!("{line}");
        }
    }
}

/// What a compare-and-swap came to.
#[cfg(windows)]
#[derive(Debug, PartialEq)]
enum Swapped {
    Ok,
    Changed,
    Unverified,
    Failed(String),
}

/// Writes `swap.new` to `name` under `root\path` if the value there is `swap.kind` with
/// exactly `swap.expected`, and reads it back. Never creates the key or the value.
///
/// The read, the comparison and the write are not one atomic step: another writer can
/// change the value between them. That is accepted: the runner reads the value again
/// afterwards and the person sees the result.
#[cfg(windows)]
fn swap(root: isize, path: &str, name: &str, swap: &Swap) -> Swapped {
    let key = match registry::Key::open(root, path, registry::QUERY_VALUE | registry::SET_VALUE) {
        Ok(key) => key,
        // No key means no value, so nothing is there to change.
        Err(registry::NOT_FOUND) => return Swapped::Changed,
        Err(code) => return Swapped::Failed(format!("can't open the key (error {code})")),
    };
    match key.value(name) {
        Ok(Some((kind, bytes))) if kind == swap.kind && bytes == swap.expected => {}
        Ok(_) => return Swapped::Changed,
        Err(code) => return Swapped::Failed(format!("can't read the value (error {code})")),
    }
    if let Err(code) = key.set(name, swap.kind, &swap.new) {
        return Swapped::Failed(format!("can't write the value (error {code})"));
    }
    match key.value(name) {
        Ok(Some((kind, bytes))) if kind == swap.kind && bytes == swap.new => Swapped::Ok,
        _ => Swapped::Unverified,
    }
}

/// `autorun-set` on the person's AutoRun; its exit code is the contract above.
#[cfg(windows)]
pub fn set(wanted: &Swap) -> ExitCode {
    match swap(registry::CURRENT_USER, PATH, NAME, wanted) {
        Swapped::Ok => {
            println!("ok");
            ExitCode::SUCCESS
        }
        Swapped::Changed => {
            println!("changed");
            ExitCode::from(3)
        }
        Swapped::Unverified => {
            println!("unverified");
            ExitCode::from(4)
        }
        Swapped::Failed(reason) => {
            eprintln!("{reason}");
            ExitCode::from(5)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(each: &[&str]) -> Vec<String> {
        each.iter().map(|one| (*one).to_owned()).collect()
    }

    #[test]
    fn round_trips_base64_of_any_bytes() {
        for len in 0..40usize {
            let bytes: Vec<u8> = (0..len).map(|n| (n * 37 + 11) as u8).collect();
            assert_eq!(decode(&encode(&bytes)), Some(bytes));
        }
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(decode("Zg=="), Some(b"f".to_vec()));
        assert_eq!(decode(""), Some(Vec::new()));
    }

    #[test]
    fn refuses_base64_that_is_not_strictly_standard() {
        for bad in [
            "Zg=", "Zg", "Zm9v=", "Zg==Zg==", "Z===", "====", "Zm9*", "Zm 9", "Zm9v\n", "Zh==",
            "Zm9=", "Zm-_", "=Zg=",
        ] {
            assert_eq!(decode(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn reads_the_swap_arguments_and_refuses_anything_else() {
        assert_eq!(
            parse_swap(&args(&["sz", "Zg==", ""])),
            Some(Swap {
                kind: SZ,
                expected: b"f".to_vec(),
                new: Vec::new()
            })
        );
        assert_eq!(parse_swap(&args(&["expand", "", "Zm8="])).unwrap().kind, 2);
        assert_eq!(parse_swap(&args(&["other", "Zg==", "Zg=="])), None);
        assert_eq!(parse_swap(&args(&["dword", "Zg==", "Zg=="])), None);
        assert_eq!(parse_swap(&args(&["sz", "Zg=="])), None);
        assert_eq!(parse_swap(&args(&["sz", "Zg==", "Zg==", "x"])), None);
        assert_eq!(parse_swap(&args(&["sz", "Zg=", "Zg=="])), None);
        assert_eq!(parse_swap(&args(&["sz", "Zg==", "!!!!"])), None);
    }

    #[cfg(windows)]
    mod scratch {
        use super::super::registry::{CURRENT_USER, Key, QUERY_VALUE, SET_VALUE, Scratch};
        use super::super::*;

        const VALUE: &str = "AutoRun";

        fn units(text: &str, nul: bool) -> Vec<u8> {
            text.encode_utf16()
                .chain(nul.then_some(0))
                .flat_map(u16::to_le_bytes)
                .collect()
        }

        fn scratch(test: &str) -> (Scratch, String) {
            let path = format!(
                r"Software\Novadeck-test-autorun-{}-{test}",
                std::process::id()
            );
            (Scratch::create(&path), path)
        }

        fn put(path: &str, kind: u32, bytes: &[u8]) {
            let key = Key::open(CURRENT_USER, path, QUERY_VALUE | SET_VALUE).unwrap();
            key.set(VALUE, kind, bytes).unwrap();
        }

        fn get(path: &str) -> Option<(u32, Vec<u8>)> {
            let key = Key::open(CURRENT_USER, path, QUERY_VALUE).unwrap();
            key.value(VALUE).unwrap()
        }

        fn run(path: &str, kind: u32, expected: &[u8], new: &[u8]) -> Swapped {
            let wanted = Swap {
                kind,
                expected: expected.to_vec(),
                new: new.to_vec(),
            };
            swap(CURRENT_USER, path, VALUE, &wanted)
        }

        #[test]
        fn swaps_when_the_expected_value_is_there() {
            let (_key, path) = scratch("swaps");
            let before = units("echo hi", true);
            let after = units("(echo hi) >nul 2>&1", true);
            put(&path, SZ, &before);
            assert_eq!(run(&path, SZ, &before, &after), Swapped::Ok);
            assert_eq!(get(&path), Some((SZ, after)));
        }

        #[test]
        fn refuses_when_the_bytes_or_the_type_differ() {
            let (_key, path) = scratch("differs");
            let current = units("echo hi", true);
            put(&path, SZ, &current);
            let other = units("echo ho", true);
            assert_eq!(run(&path, SZ, &other, &other), Swapped::Changed);
            assert_eq!(run(&path, EXPAND_SZ, &current, &other), Swapped::Changed);
            let without_nul = units("echo hi", false);
            assert_eq!(run(&path, SZ, &without_nul, &other), Swapped::Changed);
            assert_eq!(get(&path), Some((SZ, current)));
        }

        #[test]
        fn refuses_when_there_is_no_value_and_creates_none() {
            let (_key, path) = scratch("absent");
            assert_eq!(run(&path, SZ, b"", b"xx"), Swapped::Changed);
            assert_eq!(get(&path), None);
            let missing = format!("{path}-never-made");
            assert_eq!(run(&missing, SZ, b"", b"xx"), Swapped::Changed);
            assert!(Key::open(CURRENT_USER, &missing, QUERY_VALUE).is_err());
        }

        #[test]
        fn keeps_an_expandable_value_expandable_and_unexpanded() {
            let (_key, path) = scratch("expand");
            let before = units("%SystemRoot%\\a.cmd", true);
            let after = units("(%SystemRoot%\\a.cmd) >nul 2>&1", true);
            put(&path, EXPAND_SZ, &before);
            assert_eq!(run(&path, EXPAND_SZ, &before, &after), Swapped::Ok);
            assert_eq!(get(&path), Some((EXPAND_SZ, after)));
        }

        #[test]
        fn writes_non_ascii_text_and_a_missing_or_present_nul_exactly() {
            let (_key, path) = scratch("exact");
            let mut current = units("echo Łukasz 😀", true);
            put(&path, SZ, &current);
            for next in [
                units("echo Łukasz 😀 >nul", false),
                units("echo Łukasz 😀 >nul", true),
                units("", false),
                units("x", true),
            ] {
                assert_eq!(run(&path, SZ, &current, &next), Swapped::Ok);
                assert_eq!(get(&path), Some((SZ, next.clone())));
                current = next;
            }
        }

        #[test]
        fn prints_lines_by_type() {
            let (_key, path) = scratch("lines");
            put(&path, EXPAND_SZ, &units("a", true));
            let found = read(CURRENT_USER, &path, QUERY_VALUE);
            assert_eq!(
                line("user", found),
                Some(format!("user expand {}", encode(&units("a", true))))
            );
            assert_eq!(
                line("user", Ok(Some((4, vec![1, 0, 0, 0])))),
                Some("user other AQAAAA==".into())
            );
            assert_eq!(line("machine", Err(5)), Some("machine unreadable".into()));
            assert_eq!(line("machine", Ok(None)), None);
        }
    }
}
