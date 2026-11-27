//! A launcher's: has the runner of the terminal it runs in fetch one of Novadeck's own agents
//! (`pi`, Nova), as Nova's launcher does each time it starts. What the runner says of its
//! progress shows on the terminal (stderr): on a terminal each line over the last, elsewhere one
//! under the other. It succeeds once the runner says the program is in place, and fails with the
//! runner's reason, or its own, otherwise. On success stdout holds the variables the runner gives
//! the agent (its model service's, for a Nova started by hand), one `NAME=value` a line, which the
//! launcher takes; each is checked first (`variable`), and one that isn't plain is left out.
//!
//! The runner answers with lines of JSON: `{"progress": "<line>"}` as it goes, then
//! `{"ready": true}`, with `"env": {"NAME": "value"}` where it gives any, or
//! `{"error": "<reason>"}`, and ends the connection.

use std::io::{self, IsTerminal, Write};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::endpoint::{self, Terminal};

/// What the runner said last: a line of progress, the program in place (with the variables it
/// gives the agent), or why it isn't.
#[derive(Debug, PartialEq)]
pub enum Said {
    Progress(String),
    Ready(Vec<(String, String)>),
    Failed(String),
}

/// A variable the launcher may take as it is: a name of capitals, digits and `_`, and a value of
/// a URL's or a key's plain characters alone, nothing a shell or cmd reads (no quote, space, `%`,
/// `$`, `!` or newline), so no line of it can be more than one variable.
pub fn variable(name: &str, value: &str) -> bool {
    let named = name.starts_with(|c: char| c.is_ascii_uppercase())
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    let plain = !value.is_empty()
        && value.len() <= 2048
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.:/@+=".contains(c));
    named && plain
}

/// One line of the runner's answer; None for a line this relay doesn't know.
pub fn said(line: &str) -> Option<Said> {
    let value: Value = serde_json::from_str(line).ok()?;
    if let Some(progress) = value.get("progress").and_then(Value::as_str) {
        return Some(Said::Progress(progress.to_owned()));
    }
    if value.get("ready").and_then(Value::as_bool) == Some(true) {
        let env = value
            .get("env")
            .and_then(Value::as_object)
            .map(|env| {
                env.iter()
                    .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
                    .filter(|(name, value)| variable(name, value))
                    .collect()
            })
            .unwrap_or_default();
        return Some(Said::Ready(env));
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

/// The agent as Novadeck's app calls it: Novadeck's own `pi` is Nova (GLOSSARY.md).
fn titled(name: &str) -> &str {
    match name {
        "pi" => "Nova",
        other => other,
    }
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
            "{titled} starts only in a Novadeck terminal."
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
        Ok(env) => {
            shown.end(None);
            let mut out = io::stdout().lock();
            for (name, value) in env {
                let _ = writeln!(out, "{name}={value}");
            }
            let _ = out.flush();
            true
        }
        Err(reason) => {
            shown.end(Some(&format!("Novadeck couldn't get {titled}: {reason}")));
            false
        }
    }
}

async fn fetch(
    terminal: &Terminal,
    name: &str,
    shown: &mut Shown,
) -> Result<Vec<(String, String)>, String> {
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
                Some(Said::Ready(env)) => return Ok(env),
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
        assert_eq!(said(r#"{"ready":true}"#), Some(Said::Ready(vec![])));
        assert_eq!(
            said(
                r#"{"ready":true,"env":{"NOVADECK_PI_BASE_URL":"https://novadeck.dev/tour/v1","NOVADECK_PI_KEY":"ndt_a-B_1"}}"#
            ),
            Some(Said::Ready(vec![
                (
                    "NOVADECK_PI_BASE_URL".to_owned(),
                    "https://novadeck.dev/tour/v1".to_owned()
                ),
                ("NOVADECK_PI_KEY".to_owned(), "ndt_a-B_1".to_owned()),
            ]))
        );
        assert_eq!(
            said(r#"{"error":"Could not reach github.com."}"#),
            Some(Said::Failed("Could not reach github.com.".to_owned()))
        );
        assert_eq!(said(r#"{"later":1}"#), None);
        assert_eq!(said("not json"), None);
    }

    #[test]
    fn takes_plain_variables_alone() {
        assert!(variable("NOVADECK_PI_KEY", "ndt_a-B_1"));
        assert!(variable(
            "NOVADECK_PI_BASE_URL",
            "http://127.0.0.1:9/tour/v1"
        ));
        assert!(!variable("novadeck", "x"));
        assert!(!variable("_X", "x"));
        assert!(!variable("X", ""));
        for value in [
            "a b", "a\nB=1", "%PATH%", "$(id)", "a'b", "a\"b", "a!b", "a;b", "a&b",
        ] {
            assert!(!variable("X", value), "{value}");
        }
        let env = said(r#"{"ready":true,"env":{"X":"a b","Y":"ok","z":"ok","N":1}}"#);
        assert_eq!(
            env,
            Some(Said::Ready(vec![("Y".to_owned(), "ok".to_owned())]))
        );
    }
}
