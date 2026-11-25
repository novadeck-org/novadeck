//! A launcher's: has the runner of the terminal it runs in fetch one of Novadeck's own agents
//! (`pi`), as the launcher of Novadeck's pi does when its program isn't in place yet. What the
//! runner says of its progress shows on the terminal (stderr): on a terminal each line over the
//! last, elsewhere one under the other. It succeeds once the runner says the program is in
//! place, and fails with the runner's reason, or its own, otherwise. stdout stays empty.
//!
//! The runner answers with lines of JSON: `{"progress": "<line>"}` as it goes, then
//! `{"ready": true}` or `{"error": "<reason>"}`, and ends the connection.

use std::io::{self, IsTerminal, Write};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::endpoint::{self, Terminal};

/// What the runner said last: a line of progress, the program in place, or why it isn't.
#[derive(Debug, PartialEq)]
pub enum Said {
    Progress(String),
    Ready,
    Failed(String),
}

/// One line of the runner's answer; None for a line this relay doesn't know.
pub fn said(line: &str) -> Option<Said> {
    let value: Value = serde_json::from_str(line).ok()?;
    if let Some(progress) = value.get("progress").and_then(Value::as_str) {
        return Some(Said::Progress(progress.to_owned()));
    }
    if value.get("ready").and_then(Value::as_bool) == Some(true) {
        return Some(Said::Ready);
    }
    value
        .get("error")
        .and_then(Value::as_str)
        .map(|error| Said::Failed(error.to_owned()))
}

/// Where the progress shows: on a terminal, one line kept up to date.
struct Shown {
    terminal: bool,
    open: bool,
}

impl Shown {
    fn progress(&mut self, line: &str) {
        let mut err = io::stderr().lock();
        let _ = if self.terminal {
            // Back to the line's start, and clear what an earlier, longer line left there.
            write!(err, "\r\x1b[K{line}")
        } else {
            writeln!(err, "{line}")
        };
        let _ = err.flush();
        self.open = self.terminal;
    }

    fn end(&mut self, error: Option<&str>) {
        let mut err = io::stderr().lock();
        if self.open {
            let _ = writeln!(err);
            self.open = false;
        }
        if let Some(error) = error {
            let _ = writeln!(err, "{error}");
        }
    }
}

/// The agent's name as Novadeck's app shows it, with a capital (`pi` → `Pi`).
fn titled(name: &str) -> String {
    let mut chars = name.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// Fetches `name` through the terminal's runner; false, with its reason on stderr, if it fails.
pub fn run(name: &str) -> bool {
    let titled = titled(name);
    let mut shown = Shown {
        terminal: io::stderr().is_terminal(),
        open: false,
    };
    let Some(terminal) = Terminal::from_env() else {
        shown.end(Some(&format!(
            "Novadeck's {titled} starts only in a Novadeck terminal."
        )));
        return false;
    };
    let Ok(runtime) = endpoint::runtime() else {
        shown.end(Some(&format!(
            "Novadeck couldn't get {titled}: no runtime."
        )));
        return false;
    };
    let result = runtime.block_on(fetch(&terminal, name, &mut shown));
    runtime.shutdown_background();
    match result {
        Ok(()) => {
            shown.end(None);
            true
        }
        Err(reason) => {
            shown.end(Some(&format!("Novadeck couldn't get {titled}: {reason}")));
            false
        }
    }
}

async fn fetch(terminal: &Terminal, name: &str, shown: &mut Shown) -> Result<(), String> {
    let unreachable = || "Novadeck isn't answering. Restart Novadeck and try again.".to_owned();
    let (reader, mut writer) = endpoint::connect(&terminal.endpoint)
        .await
        .map_err(|_| unreachable())?;
    let hello = terminal.hello("fetch", json!({ "name": name }));
    writer
        .write_all(hello.as_bytes())
        .await
        .map_err(|_| unreachable())?;
    let _ = writer.flush().await;
    // The writer stays open until the answer: Windows' named pipes end both ways at once.
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => match said(&line) {
                Some(Said::Progress(line)) => shown.progress(&line),
                Some(Said::Ready) => return Ok(()),
                Some(Said::Failed(reason)) => return Err(reason),
                None => {}
            },
            _ => return Err("Novadeck stopped answering while it fetched it.".to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_runners_lines() {
        assert_eq!(
            said(r#"{"progress":"Downloading pi 1.6.0: 1.0 of 59.0 MB (1%)"}"#),
            Some(Said::Progress(
                "Downloading pi 1.6.0: 1.0 of 59.0 MB (1%)".to_owned()
            ))
        );
        assert_eq!(said(r#"{"ready":true}"#), Some(Said::Ready));
        assert_eq!(
            said(r#"{"error":"Could not reach github.com."}"#),
            Some(Said::Failed("Could not reach github.com.".to_owned()))
        );
        assert_eq!(said(r#"{"later":1}"#), None);
        assert_eq!(said("not json"), None);
    }
}
