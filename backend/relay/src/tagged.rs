//! macOS's processes by a variable of the environment they started with: which terminal each
//! was started in, as Novadeck names it in every shell it starts (`NOVADECK_TERMINAL_ID`). A
//! process keeps the environment it was started with through `setsid`, `nohup` and a double
//! fork, and passes it on to what it starts, so a program an agent left detached still names
//! its terminal once launchd has adopted it. macOS has no cgroup to hold a terminal's
//! processes, as a Linux scope does; this stands in for one.
//!
//! Only processes of the relay's own resource coalition count, which is the app's: a process
//! stays in its parent's coalition however it detached, but what launchd starts gets one of
//! its own. An app an agent opens, with `open`, `osascript` or any LaunchServices call, starts
//! with the caller's environment, its terminal named in it, yet in a coalition of its own, so it
//! is never the terminal's; nor is a launchd job (`launchctl`, `brew services`).
//!
//! What it can't read: a process whose code signature is restricted (`CS_RESTRICT`: every
//! Apple program, and apps with restricted entitlements), whose environment macOS keeps from
//! other processes, and one that wrote over its own (a `setproctitle`, as redis's and
//! postgres's), which names nothing. Those are left out, as are processes of other users.

use std::io::Write;
use std::mem::{size_of, zeroed};

use serde_json::json;

/// A process found with the variable, and when it started, in microseconds since the Unix
/// epoch: the wall clock as it read when the process forked.
pub struct Tagged {
    pub pid: i32,
    pub started_us: i64,
    pub value: String,
}

/// The value of `name` in a `KERN_PROCARGS2` buffer: the argument count, the executable's
/// path and its padding, the arguments, then the environment up to an empty string. None
/// where the buffer holds no environment, or not the variable.
pub fn value_in(buffer: &[u8], name: &str) -> Option<String> {
    let count = usize::try_from(i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?)).ok()?;
    let mut at = 4;
    // The executable's path, then the NULs that pad it.
    while buffer.get(at).is_some_and(|byte| *byte != 0) {
        at += 1;
    }
    while buffer.get(at) == Some(&0) {
        at += 1;
    }
    let prefix = format!("{name}=");
    buffer
        .get(at..)?
        .split(|byte| *byte == 0)
        .skip(count)
        .take_while(|each| !each.is_empty())
        .find_map(|each| each.strip_prefix(prefix.as_bytes()))
        .map(|value| String::from_utf8_lossy(value).into_owned())
}

/// `pid`'s `KERN_PROCARGS2`, read into `buffer`; None where macOS refuses it, as for a process
/// that has ended or isn't the user's.
fn arguments(pid: i32, buffer: &mut [u8]) -> Option<&[u8]> {
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buffer.len();
    // SAFETY: `name` holds three ints, and `size` is `buffer`'s length, which sysctl writes
    // no further than.
    let failed = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0;
    if failed { None } else { buffer.get(..size) }
}

/// The largest arguments and environment a process can start with, which bounds a
/// `KERN_PROCARGS2` read.
fn argument_max() -> usize {
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut max: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    // SAFETY: `max` is an int, as KERN_ARGMAX answers, and `size` its size.
    let read = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&raw mut max).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } == 0;
    usize::try_from(max)
        .ok()
        .filter(|max| read && *max > 0)
        .unwrap_or(1024 * 1024)
}

/// Every pid now; an empty list where macOS lists none.
fn pids() -> Vec<i32> {
    // SAFETY: a null buffer asks for the count alone.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let Ok(count) = usize::try_from(count) else {
        return Vec::new();
    };
    // Room for what starts between the two calls.
    let mut pids = vec![0i32; count + 64];
    let bytes = i32::try_from(pids.len() * size_of::<i32>()).unwrap_or(i32::MAX);
    // SAFETY: `pids` holds `bytes` bytes.
    let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(usize::try_from(listed).unwrap_or(0));
    pids
}

/// `proc_pidinfo`'s `PROC_PIDCOALITIONINFO`, which `sys/proc_info.h` keeps private: the
/// process's coalition of each type, resource first.
const PROC_PIDCOALITIONINFO: libc::c_int = 20;

#[repr(C)]
struct CoalitionInfo {
    ids: [u64; 2],
    reserved: [u64; 3],
}

/// `pid`'s resource coalition; None where it can't be read.
fn coalition(pid: i32) -> Option<u64> {
    let mut info = CoalitionInfo {
        ids: [0; 2],
        reserved: [0; 3],
    };
    let size = i32::try_from(size_of::<CoalitionInfo>()).ok()?;
    // SAFETY: `info` is `size` bytes.
    let read =
        unsafe { libc::proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, (&raw mut info).cast(), size) };
    (read == size && info.ids[0] != 0).then_some(info.ids[0])
}

/// `pid`'s owner and start; None where it has ended.
fn info(pid: i32) -> Option<(u32, i64)> {
    // SAFETY: proc_bsdinfo is plain data, valid zeroed.
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let size = i32::try_from(size_of::<libc::proc_bsdinfo>()).ok()?;
    // SAFETY: `info` is `size` bytes.
    let read =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    if read != size {
        return None;
    }
    let seconds = i64::try_from(info.pbi_start_tvsec).ok()?;
    let micros = i64::try_from(info.pbi_start_tvusec).ok()?;
    Some((info.pbi_uid, seconds * 1_000_000 + micros))
}

/// The user's processes of the relay's own coalition that started with `name` set, with its
/// value; None where the relay's own coalition can't be read. Each process's start is read
/// before and after its environment, and one whose start changed meanwhile, its pid taken by
/// another, is left out.
pub fn find(name: &str) -> Option<Vec<Tagged>> {
    // SAFETY: getuid and getpid can't fail.
    let (user, own) = unsafe { (libc::getuid(), libc::getpid()) };
    let own = coalition(own)?;
    let mut buffer = vec![0u8; argument_max()];
    let found = pids()
        .into_iter()
        .filter(|pid| *pid > 1)
        .filter_map(|pid| {
            let (owner, started_us) = info(pid)?;
            if owner != user || coalition(pid)? != own {
                return None;
            }
            let value = value_in(arguments(pid, &mut buffer)?, name)?;
            (info(pid)? == (owner, started_us)).then_some(Tagged {
                pid,
                started_us,
                value,
            })
        })
        .collect();
    Some(found)
}

/// Prints each process `find` finds as a JSON line: `{"pid","startedUs","value"}`. False
/// where its coalition can't be read or the output can't be written.
pub fn print(name: &str) -> bool {
    let Some(found) = find(name) else {
        return false;
    };
    let mut out = std::io::stdout().lock();
    found.iter().all(|each| {
        let line = json!({ "pid": each.pid, "startedUs": each.started_us, "value": each.value });
        writeln!(out, "{line}").is_ok()
    }) && out.flush().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A KERN_PROCARGS2 buffer as macOS lays one out.
    fn buffer(path: &str, args: &[&str], env: &[&str], padding: usize) -> Vec<u8> {
        let mut out = i32::try_from(args.len()).unwrap().to_ne_bytes().to_vec();
        out.extend(path.as_bytes());
        out.extend(std::iter::repeat_n(0, 1 + padding));
        for each in args.iter().chain(env) {
            out.extend(each.as_bytes());
            out.push(0);
        }
        // The empty string that ends the environment, then the strings the kernel adds.
        out.push(0);
        out.extend(b"executable_path=/bin/x\0");
        out
    }

    #[test]
    fn reads_the_variable_from_the_environment() {
        let read = buffer(
            "/usr/local/bin/node",
            &["node", "server.js"],
            &["HOME=/Users/a", "NOVADECK_TERMINAL_ID=t-1", "PATH=/bin"],
            3,
        );
        assert_eq!(
            value_in(&read, "NOVADECK_TERMINAL_ID").as_deref(),
            Some("t-1")
        );
    }

    #[test]
    fn never_takes_an_argument_for_the_variable() {
        let read = buffer(
            "/bin/echo",
            &["echo", "NOVADECK_TERMINAL_ID=t-2"],
            &["HOME=/Users/a"],
            0,
        );
        assert_eq!(value_in(&read, "NOVADECK_TERMINAL_ID"), None);
    }

    #[test]
    fn counts_empty_arguments_as_arguments() {
        let read = buffer(
            "/bin/x",
            &["x", "", "NOVADECK_TERMINAL_ID=no"],
            &["NOVADECK_TERMINAL_ID=t-3"],
            1,
        );
        assert_eq!(
            value_in(&read, "NOVADECK_TERMINAL_ID").as_deref(),
            Some("t-3")
        );
    }

    #[test]
    fn finds_nothing_past_the_environment_or_in_a_name_that_only_starts_alike() {
        let read = buffer("/bin/x", &["x"], &["NOVADECK_TERMINAL_IDS=t-4"], 0);
        assert_eq!(value_in(&read, "NOVADECK_TERMINAL_ID"), None);
        assert_eq!(value_in(&read, "executable_path"), None);
    }

    #[test]
    fn reads_nothing_from_a_hidden_or_short_buffer() {
        // A restricted process's: its arguments, and no environment.
        let hidden = buffer("/bin/sleep", &["sleep", "9"], &[], 0);
        assert_eq!(value_in(&hidden, "NOVADECK_TERMINAL_ID"), None);
        assert_eq!(value_in(&[1, 0], "NOVADECK_TERMINAL_ID"), None);
        assert_eq!(value_in(&[], "NOVADECK_TERMINAL_ID"), None);
    }

    /// What `finds_…` starts: this test binary again, which is unrestricted (Apple's programs
    /// hide their environment), waiting until it is ended.
    #[test]
    #[ignore = "started by finds_a_process_started_with_the_variable_and_not_one_without"]
    fn waits_while_tagged() {
        if std::env::var_os("NOVADECK_RELAY_WAIT").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }

    #[test]
    fn finds_a_process_started_with_the_variable_and_not_one_without() {
        use std::process::{Command, Stdio};
        let value = format!("relay-test-{}", std::process::id());
        let start = |tagged: bool| {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "tagged::tests::waits_while_tagged", "--ignored"])
                .env("NOVADECK_RELAY_WAIT", "1")
                .env_remove("NOVADECK_RELAY_TEST")
                .stdout(Stdio::null());
            if tagged {
                command.env("NOVADECK_RELAY_TEST", &value);
            }
            command.spawn().unwrap()
        };
        let mut with = start(true);
        let mut without = start(false);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let found = find("NOVADECK_RELAY_TEST").unwrap();
        for child in [&mut with, &mut without] {
            let _ = child.kill();
            let _ = child.wait();
        }
        let pid = |child: &std::process::Child| i32::try_from(child.id()).unwrap();
        let mine: Vec<&Tagged> = found.iter().filter(|each| each.value == value).collect();
        assert_eq!(
            mine.iter().map(|each| each.pid).collect::<Vec<_>>(),
            [pid(&with)]
        );
        assert!(!found.iter().any(|each| each.pid == pid(&without)));
        // Started this past second, in microseconds since the epoch.
        let now_us = i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_micros(),
        )
        .unwrap();
        assert!((now_us - 5_000_000..now_us).contains(&mine[0].started_us));
    }
}
