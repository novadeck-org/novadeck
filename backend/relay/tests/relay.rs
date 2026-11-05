//! The built relay, as an agent starts it: what it prints, and what it leaves running,
//! where the runner's own end-to-end tests (backend/runner's hook.test.ts, mcp.test.ts)
//! can't reach.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod leftovers;

const RELAY: &str = env!("CARGO_BIN_EXE_novadeck-relay");

/// The relay, outside any Novadeck terminal and Claude Code folder the tests run in.
fn relay(args: &[&str]) -> Command {
    let mut command = Command::new(RELAY);
    command.args(args);
    for name in [
        "NOVADECK_TERMINAL_ID",
        "NOVADECK_REPORT",
        "NOVADECK_REPORT_TOKEN",
        "CLAUDE_CONFIG_DIR",
    ] {
        command.env_remove(name);
    }
    command
}

/// A new, empty folder for one test.
fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("novadeck-relay-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A path as a shell (Git Bash on Windows) reads it in single quotes.
fn sh(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', r"'\''")
}

/// The person's status line command, in Claude Code's folder `dir`.
fn status_line(dir: &Path, command: &str) {
    let settings = serde_json::json!({ "statusLine": { "type": "command", "command": command } });
    std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
}

/// Claude Code's status line hook, started with its payload written and closed.
fn status_line_hook(dir: &Path) -> Child {
    let mut hook = relay(&["hook", "claude", "StatusLine"])
        .env("CLAUDE_CONFIG_DIR", dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let payload = serde_json::json!({ "cwd": dir }).to_string();
    hook.stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    hook
}

fn wait_until(what: &str, within: Duration, mut done: impl FnMut() -> bool) {
    let until = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < until, "{what}: not within {within:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

/// Ends the relay as Claude Code ends a status line it no longer needs: SIGTERM, as Node's
/// `kill()` sends, or on Windows, TerminateProcess.
fn end(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_status_line_ends_with_a_relay_ended_before_its_deadline() {
    let dir = scratch("ended");
    let (started, mark) = (dir.join("started"), dir.join("mark"));
    // Well within the status line's five seconds, so only the relay's end can end it.
    status_line(
        &dir,
        &format!(
            "cat >/dev/null; touch '{}'; sleep 3; touch '{}'",
            sh(&started),
            sh(&mark)
        ),
    );
    let mut hook = status_line_hook(&dir);
    // Git Bash can be slow to start on a busy Windows runner.
    wait_until("the status line started", Duration::from_secs(20), || {
        started.exists()
    });
    end(&mut hook);
    thread::sleep(Duration::from_secs(4));
    assert!(!mark.exists(), "the status line outlived its relay");
    let _ = std::fs::remove_dir_all(&dir);
}

/// As Claude Code ends a status line it no longer needs, for a newer one, at whatever
/// moment that comes: also the one in which the relay has started the person's status line
/// and nothing else holds it. Windows only: elsewhere the relay's own end ends the group.
#[cfg(windows)]
#[test]
fn a_relay_ended_as_it_starts_a_status_line_leaves_none_behind() {
    let dir = scratch("ended-starting");
    status_line(&dir, "cat >/dev/null; sleep 200");
    leftovers::nothing_is_left_by_one_ended_as_it_starts("the status line", || {
        status_line_hook(&dir)
    });
    let _ = std::fs::remove_dir_all(&dir);
}

/// As a process macOS' killpg(2) passes over while it is forked: out of the status line's
/// group when the relay's end sends it SIGKILL, in it again just after (`rejoins.pl`).
#[cfg(unix)]
#[test]
fn a_status_line_ends_with_its_relay_even_what_the_first_kill_passes_over() {
    let dir = scratch("passed-over");
    let (left, mark, rejoined) = (dir.join("left"), dir.join("mark"), dir.join("rejoined"));
    let rejoins = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/rejoins.pl");
    status_line(
        &dir,
        &format!(
            "cat >/dev/null; perl '{}' '{}' '{}' 3 '{}' & sleep 4",
            sh(&rejoins),
            sh(&left),
            sh(&mark),
            sh(&rejoined)
        ),
    );
    let mut hook = status_line_hook(&dir);
    wait_until("the status line started", Duration::from_secs(20), || {
        left.exists()
    });
    end(&mut hook);
    thread::sleep(Duration::from_secs(4));
    let outlived = std::fs::read_to_string(&mark);
    // Else nothing was passed over, and its end proves nothing.
    let rejoined = rejoined.exists();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(rejoined, "it never rejoined the group");
    if let Ok(outlived) = outlived {
        panic!("the status line outlived its relay: {outlived}");
    }
}

#[test]
fn shows_the_persons_status_line_outside_a_novadeck_terminal() {
    let dir = scratch("outside");
    status_line(&dir, "cat >/dev/null; echo mine");
    let hook = status_line_hook(&dir);
    let printed = hook.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&printed.stdout).trim(), "mine");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn takes_an_agents_payload_past_its_most_whole_and_prints_what_the_agent_needs() {
    let mut hook = relay(&["hook", "agy", "PreToolUse"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = hook.stdin.take().unwrap();
    // Half again what the hook takes, far past what a pipe holds: the hook reads it all,
    // so the agent's write never meets a closed pipe.
    let writing = thread::spawn(move || stdin.write_all(&vec![b'x'; 1_500_000]));
    let printed = hook.wait_with_output().unwrap();
    assert!(writing.join().unwrap().is_ok(), "the agent's write failed");
    assert_eq!(
        String::from_utf8_lossy(&printed.stdout),
        "{\"decision\":\"ask\"}\n"
    );
}

/// The MCP relay's first answer, to `initialize`.
fn initialize(mcp: &mut Child) -> String {
    let request = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#;
    let stdin = mcp.stdin.as_mut().unwrap();
    writeln!(stdin, "{request}").unwrap();
    let mut answer = String::new();
    BufReader::new(mcp.stdout.as_mut().unwrap())
        .read_line(&mut answer)
        .unwrap();
    answer
}

/// A pipe no one reads any longer: the input of a process that has already ended.
fn gone() -> Stdio {
    let mut ended = relay(&["--version"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    // Taken first: waiting closes it.
    let input = ended.stdin.take().unwrap();
    ended.wait().unwrap();
    Stdio::from(input)
}

#[test]
fn answers_with_no_tools_where_its_stderr_is_gone() {
    let dir = scratch("stderr");
    let missing = if cfg!(windows) {
        format!(r"\\.\pipe\novadeck-missing-{}", std::process::id())
    } else {
        dir.join("missing.sock").to_string_lossy().into_owned()
    };
    let mut mcp = relay(&["mcp", "1.0.0", "2025-06-18"])
        .env("NOVADECK_TERMINAL_ID", "t1")
        .env("NOVADECK_REPORT", &missing)
        .env("NOVADECK_REPORT_TOKEN", "token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(gone())
        .spawn()
        .unwrap();
    let answer: serde_json::Value = serde_json::from_str(&initialize(&mut mcp))
        .unwrap_or_else(|_| panic!("no answer: {:?}", mcp.wait()));
    assert_eq!(answer["result"]["serverInfo"]["name"], "novadeck");
    drop(mcp.stdin.take());
    assert!(mcp.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A fake runner on a Unix socket: each test's own.
#[cfg(unix)]
mod runner {
    use std::os::unix::net::{UnixListener, UnixStream};

    use super::*;

    pub struct Runner {
        pub listener: UnixListener,
        pub socket: PathBuf,
        dir: PathBuf,
    }

    impl Runner {
        pub fn new(name: &str) -> Runner {
            let dir = scratch(name);
            let socket = dir.join("r.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            Runner {
                listener,
                socket,
                dir,
            }
        }

        /// The relay, in the terminal this runner serves.
        pub fn relay(&self, args: &[&str]) -> Command {
            let mut command = relay(args);
            command
                .env("NOVADECK_TERMINAL_ID", "t1")
                .env("NOVADECK_REPORT", &self.socket)
                .env("NOVADECK_REPORT_TOKEN", "token");
            command
        }

        /// The relay's connection, and its first line.
        pub fn accept(&self) -> (UnixStream, String) {
            let (stream, _) = self.listener.accept().unwrap();
            let mut hello = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut hello)
                .unwrap();
            (stream, hello)
        }
    }

    impl Drop for Runner {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// A Stop hook whose answer delivers under a lease, and what the runner then read.
#[cfg(unix)]
fn leased_stop(printable: bool) -> (String, String) {
    use std::io::Read;

    let runner = runner::Runner::new(if printable { "acked" } else { "unacked" });
    let mut hook = runner
        .relay(&["hook", "claude", "Stop"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // The agent stopped reading: nothing the hook prints reaches it.
    if !printable {
        drop(hook.stdout.take());
    }
    hook.stdin.take().unwrap().write_all(b"{}").unwrap();
    let (mut stream, hello) = runner.accept();
    assert!(hello.contains("\"kind\":\"hook\""), "{hello}");
    stream
        .write_all(b"{\"stdout\":\"delivered\\n\",\"leaseId\":\"lease-1\"}\n")
        .unwrap();
    let mut after = String::new();
    let _ = stream.read_to_string(&mut after);
    let printed = hook.wait_with_output().unwrap();
    (String::from_utf8_lossy(&printed.stdout).into_owned(), after)
}

#[cfg(unix)]
#[test]
fn acknowledges_a_lease_once_printed_and_only_then() {
    let (printed, after) = leased_stop(true);
    assert_eq!(printed, "delivered\n");
    assert_eq!(after, "{\"ack\":\"lease-1\"}\n");
    // Not printed: the lease lapses, and the runner delivers its messages again.
    let (_, after) = leased_stop(false);
    assert_eq!(after, "");
}

#[cfg(unix)]
#[test]
fn ends_an_mcp_session_the_runner_closes_after_carrying_what_it_sent() {
    use std::io::Read;

    let runner = runner::Runner::new("closed");
    let mut mcp = runner
        .relay(&["mcp", "1.0.0", "2025-06-18"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let (mut stream, hello) = runner.accept();
    assert!(hello.contains("\"kind\":\"mcp\""), "{hello}");
    let message = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n";
    stream
        .write_all(format!("{{\"relay\":2,\"ok\":true}}\n{message}").as_bytes())
        .unwrap();
    // The runner goes away while the agent still runs, its input open.
    drop(stream);
    wait_until("the relay ended", Duration::from_secs(5), || {
        mcp.try_wait().unwrap().is_some()
    });
    let mut carried = String::new();
    mcp.stdout
        .take()
        .unwrap()
        .read_to_string(&mut carried)
        .unwrap();
    assert_eq!(carried, message);
}

#[cfg(unix)]
#[test]
fn a_status_line_keeps_ignoring_a_signal_its_relay_was_started_ignoring() {
    use std::os::unix::process::CommandExt;

    let dir = scratch("nohup");
    let started = dir.join("started");
    status_line(
        &dir,
        &format!(
            "cat >/dev/null; touch '{}'; sleep 3; echo mine",
            sh(&started)
        ),
    );
    let mut hook = relay(&["hook", "claude", "StatusLine"]);
    // As under `nohup`.
    unsafe {
        hook.pre_exec(|| {
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            Ok(())
        });
    }
    let mut hook = hook
        .env("CLAUDE_CONFIG_DIR", &dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let payload = serde_json::json!({ "cwd": dir }).to_string();
    hook.stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    wait_until("the status line started", Duration::from_secs(20), || {
        started.exists()
    });
    unsafe { libc::kill(hook.id() as i32, libc::SIGHUP) };
    let printed = hook.wait_with_output().unwrap();
    assert!(printed.status.success());
    assert_eq!(String::from_utf8_lossy(&printed.stdout).trim(), "mine");
    let _ = std::fs::remove_dir_all(&dir);
}
