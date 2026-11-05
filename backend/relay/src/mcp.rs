//! In a Novadeck terminal, the MCP server is the runner's: the relay names the terminal
//! once, waits for the runner to take the session, then carries the agent's lines to the
//! runner and its answers back unchanged. A runner that doesn't take it, as one that
//! speaks another version of the protocol, leaves the relay to answer by itself, with no
//! tools: nothing of the agent's has been read yet, so the session is whole.

use std::io;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::endpoint::{self, Terminal};
use crate::{PROTOCOL, idle};

/// What the relay sends once the agent has closed its side, as Windows' named pipes
/// can't be half closed: the runner answers the calls under way, then closes.
const END: &str = "{\"relay\":\"eof\"}\n";

/// How long the runner has to take the session before the relay answers by itself,
/// reaching it included (on Windows, connecting waits up to two seconds while every
/// instance of the pipe is busy): long, as a runner busy restoring terminals answers late,
/// and a session given up on stays without tools for as long as its agent runs; within the
/// ten seconds an agent such as Codex gives a server to start. A runner that refuses the
/// session says so at once.
const TAKEN_WITHIN: Duration = Duration::from_millis(8_000);

/// Whether a line is the runner taking the session, in this relay's protocol.
fn taken(line: &str) -> bool {
    serde_json::from_str::<Value>(line).is_ok_and(|value| {
        value.get("relay").and_then(Value::as_u64) == Some(u64::from(PROTOCOL))
            && value.get("ok") == Some(&Value::Bool(true))
    })
}

pub fn run(server: &str, versions: &[String]) {
    // Outside Novadeck's terminals there is nothing to say: no tools is what's meant.
    let Some(terminal) = Terminal::from_env() else {
        return idle::serve(server, versions);
    };
    // In one, the agent's log says why Novadeck's tools are missing.
    let idle = |why: &str| {
        crate::complain(&format!("Novadeck's relay offers no tools: {why}."));
        idle::serve(server, versions);
    };
    let Ok(runtime) = endpoint::runtime() else {
        return idle("it couldn't start");
    };
    let hello = terminal.hello("mcp", json!({}));
    let opened = open(endpoint::connect(&terminal.endpoint), hello, TAKEN_WITHIN);
    match runtime.block_on(opened) {
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

/// Connects (`connecting`), names the terminal, and waits for the runner to take the
/// session, all of it `within` that long.
async fn open(
    connecting: impl Future<Output = io::Result<(endpoint::Reader, endpoint::Writer)>>,
    hello: String,
    within: Duration,
) -> Result<Session, &'static str> {
    let opening = async {
        let (from_runner, mut to_runner) = connecting
            .await
            .map_err(|_| "Novadeck's runner can't be reached")?;
        to_runner
            .write_all(hello.as_bytes())
            .await
            .map_err(|_| "Novadeck's runner went away")?;
        let mut from_runner = BufReader::new(from_runner);
        let mut line = String::new();
        match from_runner.read_line(&mut line).await {
            Ok(read) if read > 0 && taken(&line) => Ok((from_runner, to_runner)),
            _ => Err("Novadeck's runner speaks another version of the relay's protocol"),
        }
    };
    tokio::time::timeout(within, opening)
        .await
        .unwrap_or(Err("Novadeck's runner didn't answer"))
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

    /// A runner that is reached after `reached`, and takes the session `takes` after its
    /// first line.
    async fn runner(
        reached: Duration,
        takes: Duration,
    ) -> io::Result<(endpoint::Reader, endpoint::Writer)> {
        tokio::time::sleep(reached).await;
        let (relay, runner) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            let (from_relay, mut to_relay) = tokio::io::split(runner);
            let mut hello = String::new();
            let _ = BufReader::new(from_relay).read_line(&mut hello).await;
            tokio::time::sleep(takes).await;
            let _ = to_relay.write_all(b"{\"relay\":2,\"ok\":true}\n").await;
            std::future::pending::<()>().await;
        });
        let (from_runner, to_runner) = tokio::io::split(relay);
        Ok((Box::new(from_runner), Box::new(to_runner)))
    }

    #[test]
    fn waits_for_the_runner_reaching_it_included_no_longer_than_it_may() {
        let runtime = endpoint::runtime().unwrap();
        let ms = Duration::from_millis;
        let opened = |reached, takes, within| {
            runtime
                .block_on(open(runner(reached, takes), "{}\n".into(), within))
                .map(|_| ())
        };
        assert_eq!(opened(ms(0), ms(0), ms(2_000)), Ok(()));
        // Reaching the runner, as Windows' busy pipe waits, counts toward the limit.
        assert_eq!(
            opened(ms(300), ms(300), ms(450)),
            Err("Novadeck's runner didn't answer")
        );
        assert_eq!(opened(ms(300), ms(300), ms(2_000)), Ok(()));
    }
}
