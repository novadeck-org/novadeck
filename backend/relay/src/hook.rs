//! An agent hook, run by a connected agent's Novadeck plugin: the relay sends what the
//! hook knows to the runner of the terminal it runs in, unread, and prints what the
//! runner answers, exactly as the agent expects. A Stop or prompt-time hook's answer may
//! deliver agents' messages under a lease, which the relay acknowledges once printed; so may
//! a tool-call hook's, which the runner answers at once.
//! Claude Code's status line runs through the hook too: the relay runs the person's own,
//! as their settings name it, beside the report, and prints it. Outside Novadeck's
//! terminals, or when the runner can't be reached, it prints only what its agent needs,
//! as the runner's configuration names it: Antigravity's JSON, where a PreToolUse answer
//! must say "ask" or Antigravity denies the tool.
//!
//! What it knows of the agents comes from that configuration, `relay.json` beside it,
//! which the runner writes: which events wait the long limit (`asks`), which variables
//! tell agents apart, and what each agent needs printed without Novadeck. Nothing here
//! names an agent but Claude Code, whose status line only the relay can run, and
//! Antigravity, whose PreToolUse must say "ask" even without that configuration.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::endpoint::{self, Terminal};
use crate::{ancestors, epoch_ms, status_line, variable};

/// What the runner tells the relay about the agents, from `relay.json`. Missing or
/// unreadable, it is empty: every hook reports, forwards nothing of its environment, and
/// prints nothing without Novadeck.
#[derive(Default, Debug, PartialEq)]
pub struct Config {
    asks: Value,
    env: Vec<String>,
    fallbacks: Value,
}

impl Config {
    pub fn read(path: Option<&Path>) -> Config {
        path.and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| Config::of(&value))
            .unwrap_or_default()
    }

    fn of(value: &Value) -> Config {
        let names = value.get("env").and_then(Value::as_array);
        Config {
            asks: value.get("asks").cloned().unwrap_or(Value::Null),
            env: names
                .into_iter()
                .flatten()
                .filter_map(|name| name.as_str().map(str::to_owned))
                .collect(),
            fallbacks: value.get("fallbacks").cloned().unwrap_or(Value::Null),
        }
    }

    /// Whether `agent`'s `event` is listed in `asks`, the events that wait the long limit for
    /// the runner's answer. Every hook is sent to the runner and printed its answer; this only
    /// sets how long it may take.
    fn asks(&self, agent: &str, event: &str) -> bool {
        self.asks
            .get(agent)
            .and_then(Value::as_array)
            .is_some_and(|events| events.iter().any(|one| one.as_str() == Some(event)))
    }

    /// What `agent`'s `event` prints when the runner gave nothing to print: the event's
    /// own, else the agent's for any event (`*`), else nothing, except that Antigravity's
    /// PreToolUse always prints "ask" (it denies a tool otherwise), even where the
    /// configuration is unreadable or lacks it.
    fn fallback(&self, agent: &str, event: &str) -> String {
        let named = self.fallbacks.get(agent);
        let text = named
            .and_then(|each| each.get(event).or_else(|| each.get("*")))
            .and_then(Value::as_str)
            .unwrap_or("");
        if text.is_empty() {
            if agent == "agy" && event == "PreToolUse" {
                return "{\"decision\":\"ask\"}\n".to_owned();
            }
            String::new()
        } else {
            format!("{text}\n")
        }
    }

    /// The variables that tell agents apart, by name, as the hook's environment holds them.
    fn env(&self) -> Map<String, Value> {
        self.env
            .iter()
            .filter_map(|name| Some((name.clone(), Value::String(variable(name)?))))
            .collect()
    }

    /// How long a hook may take, from its start: Claude Code's status line the longest,
    /// as it runs the person's own; a hook in `asks` (a Stop or prompt-time one), long enough
    /// for the runner to lease and answer by its deadline; any other, a tool-call hook
    /// among them, the short limit of a report, as the runner answers it at once, with
    /// messages to print or none. The relay tells the runner its deadline for every hook,
    /// so the runner never leases past it.
    fn limit(&self, agent: &str, event: &str) -> Duration {
        Duration::from_millis(match (agent, event) {
            _ if claude_status_line(agent, event) => 5_000,
            _ if self.asks(agent, event) => 4_000,
            _ => 2_000,
        })
    }
}

/// Whether `agent`'s `event` is Claude Code's status line, which runs the person's own.
fn claude_status_line(agent: &str, event: &str) -> bool {
    agent == "claude" && event == "StatusLine"
}

/// The most of an agent's payload the hook takes; past it, it reports nothing.
const MAX_PAYLOAD: u64 = 1_000_000;

/// What the runner answered: what to print, and the lease that delivers it.
#[derive(Default, Debug, PartialEq)]
struct Answer {
    stdout: Option<String>,
    lease: Option<String>,
}

impl Answer {
    /// The runner's answer line; nothing to print where it can't be read.
    fn of(line: &str) -> Answer {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Answer::default();
        };
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        Answer {
            stdout: text("stdout"),
            lease: text("leaseId"),
        }
    }
}

/// Prints what the agent needs, whether or not it got there.
fn say(text: &str) {
    let _ = print(text);
}

/// Prints `text`, saying whether all of it reached the agent.
fn print(text: &str) -> bool {
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(text.as_bytes())
        .and_then(|()| stdout.flush())
        .is_ok()
}

/// Runs the hook for `agent`'s `event`, as `config` describes the agents.
pub fn run(agent: &str, event: &str, config: &Config) {
    // When the hook started, in wall-clock milliseconds: a later hook reports a larger one.
    let started = epoch_ms().unwrap_or(0.0);
    let limit = config.limit(agent, event);
    let deadline = Instant::now() + limit;
    let fallback = || config.fallback(agent, event);
    // The agent's payload, read whole even where it goes unused, so the agent never
    // writes into a closed pipe; within the hook's limit, as an agent may leave it open.
    let payload = read_payload(deadline);
    let Some(terminal) = Terminal::from_env() else {
        return say(&fallback());
    };
    let Some(payload) = payload else {
        return say(&fallback());
    };
    let payload = String::from_utf8_lossy(&payload).into_owned();
    let hello = terminal.hello(
        "hook",
        json!({
            "agent": agent,
            "event": event,
            "seq": started,
            // When this hook gives up, so the runner leases nothing it couldn't print.
            "deadline": started + limit.as_secs_f64() * 1000.0,
            "ancestors": ancestors::of_this_process(),
            "env": config.env(),
            "payload": payload,
        }),
    );
    let own = claude_status_line(agent, event).then(|| own_status_line(payload, deadline));
    let shown = move || own.and_then(|running| running.join().ok().flatten());
    let Ok(runtime) = endpoint::runtime() else {
        return say(&fallback());
    };
    runtime.block_on(async {
        let left = deadline.saturating_duration_since(Instant::now());
        let sent = tokio::time::timeout(left, send(&terminal.endpoint, hello)).await;
        let Ok(Some((answer, mut to_runner))) = sent else {
            return say(&shown().unwrap_or_else(fallback));
        };
        let Some(stdout) = &answer.stdout else {
            return say(&shown().unwrap_or_else(fallback));
        };
        // Printed: what the lease delivers has reached the agent. Otherwise the lease
        // lapses, and the runner delivers its messages again.
        let printed = print(stdout);
        if let Some(lease) = answer.lease.as_ref().filter(|_| printed) {
            acknowledge(&mut to_runner, lease).await;
        }
    });
    runtime.shutdown_background();
}

/// Claude Code's status line: the person's own command, run on a thread of its own beside
/// the report, which it needs nothing of, for what it prints by `deadline`.
fn own_status_line(payload: String, deadline: Instant) -> JoinHandle<Option<String>> {
    let config = variable("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    // Windows names the person's folder in USERPROFILE, where Git Bash hasn't set HOME.
    let home = variable("HOME")
        .or_else(|| variable("USERPROFILE"))
        .map(PathBuf::from);
    thread::spawn(move || {
        status_line::own_command(&payload, config.as_deref(), home.as_deref())
            .map(|command| status_line::run(&command, payload.as_bytes(), deadline))
    })
}

/// The agent's payload, or None once it runs past what the hook takes, or past
/// `deadline`, when what is left goes unread.
fn read_payload(deadline: Instant) -> Option<Vec<u8>> {
    let (sent, received) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut payload = Vec::new();
        let read = io::stdin()
            .lock()
            .take(MAX_PAYLOAD + 1)
            .read_to_end(&mut payload);
        let whole = read.is_ok() && payload.len() as u64 <= MAX_PAYLOAD;
        // Past the most it takes: the rest is drained, unkept.
        if !whole {
            let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        }
        let _ = sent.send(whole.then_some(payload));
    });
    received
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
        .flatten()
}

/// Sends the hook and reads the runner's one-line answer, keeping the connection for
/// the acknowledgement.
async fn send(endpoint: &str, hello: String) -> Option<(Answer, endpoint::Writer)> {
    let (from_runner, mut to_runner) = endpoint::connect(endpoint).await.ok()?;
    to_runner.write_all(hello.as_bytes()).await.ok()?;
    to_runner.flush().await.ok()?;
    let mut reply = String::new();
    BufReader::new(from_runner)
        .read_line(&mut reply)
        .await
        .ok()?;
    Some((Answer::of(&reply), to_runner))
}

/// Tells the runner what `lease` delivers has been printed, giving it half a second.
async fn acknowledge(to_runner: &mut endpoint::Writer, lease: &str) {
    let ack = format!("{}\n", json!({ "ack": lease }));
    let sent = async {
        to_runner.write_all(ack.as_bytes()).await?;
        to_runner.flush().await
    };
    let _ = tokio::time::timeout(Duration::from_millis(500), sent).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config::of(&json!({
            "asks": { "claude": ["Stop", "UserPromptSubmit"], "agy": ["Stop", "PreInvocation"] },
            "env": ["CLAUDE_PID", "CODEX_THREAD_ID"],
            "fallbacks": { "agy": { "PreToolUse": "{\"decision\":\"ask\"}", "*": "{}" } },
        }))
    }

    #[test]
    fn reads_the_runners_answer() {
        assert_eq!(
            Answer::of(r#"{"leaseId":"abc","stdout":"{\"decision\":\"block\"}"}"#),
            Answer {
                stdout: Some("{\"decision\":\"block\"}".into()),
                lease: Some("abc".into()),
            }
        );
        assert_eq!(
            Answer::of(r#"{"leaseId":null,"stdout":null}"#),
            Answer::default()
        );
        assert_eq!(Answer::of("not json"), Answer::default());
    }

    #[test]
    fn prints_what_each_agent_needs_without_novadeck_as_configured() {
        let config = config();
        assert_eq!(
            config.fallback("agy", "PreToolUse"),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(config.fallback("agy", "Stop"), "{}\n");
        assert_eq!(config.fallback("claude", "Stop"), "");
        assert_eq!(config.fallback("codex", "PreToolUse"), "");
        // Without its configuration, it prints nothing, but for what keeps Antigravity
        // from denying every tool.
        assert_eq!(
            Config::default().fallback("agy", "PreToolUse"),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(Config::default().fallback("agy", "Stop"), "");
        // Nor does a configuration without Antigravity's entry.
        let without = Config::of(&json!({ "fallbacks": { "claude": { "*": "" } } }));
        assert_eq!(
            without.fallback("agy", "PreToolUse"),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(without.fallback("agy", "Stop"), "");
        assert_eq!(Config::default().fallback("codex", "PreToolUse"), "");
    }

    #[test]
    fn gives_each_hook_the_time_it_had() {
        let config = config();
        let ms = |agent, event| config.limit(agent, event).as_millis();
        assert_eq!(ms("claude", "StatusLine"), 5_000);
        assert_eq!(ms("claude", "Stop"), 4_000);
        assert_eq!(ms("agy", "PreInvocation"), 4_000);
        assert_eq!(ms("agy", "UserPromptSubmit"), 2_000);
        assert_eq!(ms("codex", "Stop"), 2_000);
        assert_eq!(ms("claude", "PostToolUse"), 2_000);
        assert_eq!(Config::default().limit("claude", "Stop").as_millis(), 2_000);
    }

    #[test]
    fn reads_no_configuration_as_an_empty_one() {
        assert_eq!(Config::read(None), Config::default());
        assert_eq!(
            Config::read(Some(Path::new("/no/such/relay.json"))),
            Config::default()
        );
    }
}
