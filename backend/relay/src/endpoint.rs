//! How the relay reaches the runner: the terminal it runs in, as its environment names
//! it, the first line of each connection, and the runtime a connection runs on. The
//! runner's endpoint for its terminals is a Unix socket in a private directory, or a
//! named pipe on Windows. Both are read and written at once, as answers come back while
//! the agent still writes; Windows serialises blocking reads and writes on one pipe
//! handle, so the pipe is opened for overlapped I/O, which tokio does.

use std::io;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::runtime::Runtime;

use crate::{PROTOCOL, variable};

/// The Novadeck terminal the relay runs in, as its shell's environment names it: the
/// terminal, the runner's endpoint for it, and its token.
pub struct Terminal {
    id: String,
    pub endpoint: String,
    token: String,
}

impl Terminal {
    /// None outside Novadeck's terminals, where any of them is missing.
    pub fn from_env() -> Option<Terminal> {
        Some(Terminal {
            id: variable("NOVADECK_TERMINAL_ID")?,
            endpoint: variable("NOVADECK_REPORT")?,
            token: variable("NOVADECK_REPORT_TOKEN")?,
        })
    }

    /// A connection's first line: the relay's protocol first, so the runner knows the line
    /// as a relay's, then what the connection carries (`kind`), the terminal and its token,
    /// then `fields`, an object's.
    pub fn hello(&self, kind: &str, fields: Value) -> String {
        let mut hello = json!({
            "relay": PROTOCOL,
            "kind": kind,
            "terminalId": self.id,
            "token": self.token,
        });
        if let (Some(hello), Value::Object(fields)) = (hello.as_object_mut(), fields) {
            hello.extend(fields);
        }
        format!("{hello}\n")
    }
}

/// The runtime a connection runs on: one thread, as the relay carries one connection.
pub fn runtime() -> io::Result<Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
}

pub type Reader = Box<dyn AsyncRead + Unpin + Send>;
pub type Writer = Box<dyn AsyncWrite + Unpin + Send>;

#[cfg(unix)]
pub async fn connect(endpoint: &str) -> io::Result<(Reader, Writer)> {
    let stream = tokio::net::UnixStream::connect(endpoint).await?;
    let (reader, writer) = stream.into_split();
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(windows)]
pub async fn connect(endpoint: &str) -> io::Result<(Reader, Writer)> {
    use std::time::Duration;

    use tokio::net::windows::named_pipe::ClientOptions;

    // Every instance busy: another agent's relay or hook is connecting this moment.
    const PIPE_BUSY: i32 = 231;
    let mut tries = 0;
    let pipe = loop {
        match ClientOptions::new().open(endpoint) {
            Ok(pipe) => break pipe,
            Err(error) if error.raw_os_error() == Some(PIPE_BUSY) && tries < 40 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    };
    let (reader, writer) = tokio::io::split(pipe);
    Ok((Box::new(reader), Box::new(writer)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_protocol_first_so_the_runner_knows_its_line() {
        let terminal = Terminal {
            id: "t1".into(),
            endpoint: "/tmp/reports".into(),
            token: "secret".into(),
        };
        assert_eq!(
            terminal.hello("mcp", json!({})),
            "{\"relay\":2,\"kind\":\"mcp\",\"terminalId\":\"t1\",\"token\":\"secret\"}\n"
        );
        assert_eq!(
            terminal.hello("hook", json!({ "agent": "claude", "event": "Stop" })),
            "{\"relay\":2,\"kind\":\"hook\",\"terminalId\":\"t1\",\"token\":\"secret\",\"agent\":\"claude\",\"event\":\"Stop\"}\n"
        );
    }
}
