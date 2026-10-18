//! In a Novadeck terminal, the MCP server is the runner's: the relay names the terminal
//! once, waits for the runner to take the session, then carries the agent's lines to the
//! runner and its answers back unchanged. A runner that doesn't take it, as one that
//! speaks another version of the protocol, leaves the relay to answer by itself, with no
//! tools: nothing of the agent's has been read yet, so the session is whole.

use std::env;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::{PROTOCOL, endpoint, idle};

/// What the relay sends once the agent has closed its side, as Windows' named pipes
/// can't be half closed: the runner answers the calls under way, then closes.
pub const END: &str = "{\"relay\":\"eof\"}\n";

/// How long the runner has to take the session before the relay answers by itself: long,
/// as a runner busy restoring terminals answers late, and a session given up on stays
/// without tools for as long as its agent runs; within the ten seconds an agent such as
/// Codex gives a server to start. A runner that refuses the session says so at once.
const TAKEN_WITHIN: Duration = Duration::from_millis(8_000);

/// Whether a line is the runner taking the session, in this relay's protocol.
pub fn taken(line: &str) -> bool {
    serde_json::from_str::<Value>(line).is_ok_and(|value| {
        value.get("relay").and_then(Value::as_u64) == Some(u64::from(PROTOCOL))
            && value.get("ok") == Some(&Value::Bool(true))
    })
}

pub fn run(server: &str, versions: &[String]) {
    let terminal = [
        "NOVADECK_TERMINAL_ID",
        "NOVADECK_REPORT",
        "NOVADECK_REPORT_TOKEN",
    ]
    .map(|name| env::var(name).ok().filter(|value| !value.is_empty()));
    // Outside Novadeck's terminals there is nothing to say: no tools is what's meant.
    let [Some(terminal), Some(endpoint), Some(token)] = terminal else {
        return idle::serve(server, versions);
    };
    // In one, the agent's log says why Novadeck's tools are missing.
    let idle = |why: &str| {
        eprintln!("Novadeck's relay offers no tools: {why}.");
        idle::serve(server, versions);
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
    let Ok(runtime) = runtime else {
        return idle("it couldn't start");
    };
    let hello = json!({ "relay": PROTOCOL, "kind": "mcp", "terminalId": terminal, "token": token });
    match runtime.block_on(open(&endpoint, format!("{hello}\n"))) {
        Ok(session) => runtime.block_on(carry(session)),
        Err(why) => {
            runtime.shutdown_background();
            return idle(why);
        }
    }
    // The agent's input may still be read on a thread of its own, which can't be
    // cancelled; the process ends without waiting for it.
    runtime.shutdown_background();
}

type Session = (BufReader<endpoint::Reader>, endpoint::Writer);

/// Connects, names the terminal, and waits for the runner to take the session.
async fn open(endpoint: &str, hello: String) -> Result<Session, &'static str> {
    let (from_runner, mut to_runner) = endpoint::connect(endpoint)
        .await
        .map_err(|_| "Novadeck's runner can't be reached")?;
    to_runner
        .write_all(hello.as_bytes())
        .await
        .map_err(|_| "Novadeck's runner went away")?;
    let mut from_runner = BufReader::new(from_runner);
    let mut line = String::new();
    let read = tokio::time::timeout(TAKEN_WITHIN, from_runner.read_line(&mut line)).await;
    match read {
        Ok(Ok(read)) if read > 0 && taken(&line) => Ok((from_runner, to_runner)),
        Ok(_) => Err("Novadeck's runner speaks another version of the relay's protocol"),
        Err(_) => Err("Novadeck's runner didn't answer"),
    }
}

async fn carry((mut from_runner, mut to_runner): Session) {
    let answers = async {
        let mut stdout = tokio::io::stdout();
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match from_runner.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    let written = stdout.write_all(&buffer[..read]).await;
                    if written.is_err() || stdout.flush().await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    let messages = async {
        let mut stdin = tokio::io::stdin();
        let mut buffer = vec![0u8; 16 * 1024];
        // Whether what went last ends a line, so the end goes on a line of its own.
        let mut whole = true;
        loop {
            match stdin.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    whole = buffer[read - 1] == b'\n';
                    if to_runner.write_all(&buffer[..read]).await.is_err() {
                        return;
                    }
                }
            }
        }
        let tail = if whole {
            END.to_owned()
        } else {
            format!("\n{END}")
        };
        let _ = to_runner.write_all(tail.as_bytes()).await;
        let _ = to_runner.flush().await;
        // The runner closes once it has answered; until then, its answers still come.
        std::future::pending::<()>().await
    };
    // Done when the runner closes: after the end, or when it goes away.
    tokio::select! {
        () = answers => {}
        () = messages => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_session_only_in_its_own_protocol() {
        assert!(taken("{\"relay\":2,\"ok\":true}\n"));
        assert!(!taken("{\"relay\":3,\"ok\":true}\n"));
        assert!(!taken("{\"relay\":2,\"ok\":false}\n"));
        assert!(!taken("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"));
        assert!(!taken(""));
    }
}
