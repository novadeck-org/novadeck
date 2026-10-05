//! An agent hook, run by a connected agent's NovaDeck plugin: the relay sends what the
//! hook knows to the runner of the terminal it runs in, unread, and prints what the
//! runner answers, exactly as the agent expects. A Stop or prompt-time hook's answer may
//! deliver agents' messages under a lease, which the relay acknowledges once printed.
//! Claude Code's status line runs through the hook too: the relay runs the person's own,
//! as their settings name it, beside the report, and prints it. Outside NovaDeck's
//! terminals, or when the runner can't be reached, it prints only what its agent needs,
//! as the runner's configuration names it: Antigravity's JSON, where a PreToolUse answer
//! must say "ask" or Antigravity denies the tool.
//!
//! What it knows of the agents comes from that configuration, `relay.json` beside it,
//! which the runner writes: which events ask, which variables tell agents apart, and what
//! each agent needs printed without NovaDeck. Nothing here names an agent but Claude Code,
//! whose status line only the relay can run.

use std::env;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::{PROTOCOL, ancestors, endpoint, status_line};

/// What the runner tells the relay about the agents, from `relay.json`. Missing or
/// unreadable, it is empty: every hook reports, forwards nothing of its environment, and
/// prints nothing without NovaDeck.
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

    pub fn of(value: &Value) -> Config {
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

    /// Whether `agent`'s `event` asks the runner what to print.
    fn asks(&self, agent: &str, event: &str) -> bool {
        self.asks
            .get(agent)
            .and_then(Value::as_array)
            .is_some_and(|events| events.iter().any(|one| one.as_str() == Some(event)))
    }

    /// What `agent`'s `event` prints when the runner gave nothing to print: the event's
    /// own, else the agent's for any event (`*`), else nothing.
    pub fn fallback(&self, agent: &str, event: &str) -> String {
        let named = self.fallbacks.get(agent);
        let text = named
            .and_then(|each| each.get(event).or_else(|| each.get("*")))
            .and_then(Value::as_str)
            .unwrap_or("");
        if text.is_empty() {
            String::new()
        } else {
            format!("{text}\n")
        }
    }

    /// The variables that tell agents apart, by name, as the hook's environment holds them.
    fn env(&self) -> Map<String, Value> {
        self.env
            .iter()
            .filter_map(|name| {
                let value = env::var(name).ok().filter(|value| !value.is_empty())?;
                Some((name.clone(), Value::String(value)))
            })
            .collect()
    }

    /// How long a hook may take, from its start: Claude Code's status line the longest,
    /// as it runs the person's own; a hook that asks, long enough for the runner to lease
    /// and answer by its deadline; any other only reports, which the runner answers at
    /// once. The relay tells the runner its deadline, so the runner never leases past it.
    pub fn limit(&self, agent: &str, event: &str) -> Duration {
        Duration::from_millis(match (agent, event) {
            ("claude", "StatusLine") => 5_000,
            _ if self.asks(agent, event) => 4_000,
            _ => 2_000,
        })
    }
}

/// The most of an agent's payload the hook takes; past it, it reports nothing.
const MAX_PAYLOAD: u64 = 1_000_000;

/// What the runner answered: what to print, and the lease that delivers it.
#[derive(Default, Debug, PartialEq)]
pub struct Answer {
    pub stdout: Option<String>,
    pub lease: Option<String>,
}

pub fn answer_of(line: &str) -> Answer {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Answer::default();
    };
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Answer {
        stdout: text("stdout"),
        lease: text("leaseId"),
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
    let seq = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0);
    let limit = config.limit(agent, event);
    let deadline = Instant::now() + limit;
    let fallback = || config.fallback(agent, event);
    // The agent's payload, read whole even where it goes unused, so the agent never
    // writes into a closed pipe; within the hook's limit, as an agent may leave it open.
    let payload = read_input(deadline);
    let terminal = [
        "NOVADECK_TERMINAL_ID",
        "NOVADECK_REPORT",
        "NOVADECK_REPORT_TOKEN",
    ]
    .map(|name| env::var(name).ok().filter(|value| !value.is_empty()));
    let [Some(terminal), Some(endpoint), Some(token)] = terminal else {
        return say(&fallback());
    };
    let Some(payload) = payload else {
        return say(&fallback());
    };
    let payload = String::from_utf8_lossy(&payload).into_owned();
    let message = json!({
        "relay": PROTOCOL,
        "kind": "hook",
        "terminalId": terminal,
        "token": token,
        "agent": agent,
        "event": event,
        "seq": seq,
        // When this hook gives up, so the runner leases nothing it couldn't print.
        "deadline": seq + limit.as_secs_f64() * 1000.0,
        "ancestors": ancestors::of_this_process(),
        "env": config.env(),
        "payload": payload,
    });
    // Claude Code's status line: the person's own runs beside the report, which it needs
    // nothing of, and shows whatever the runner does.
    let variable = |name: &str| env::var(name).ok().filter(|value| !value.is_empty());
    let own = (agent == "claude" && event == "StatusLine").then(|| {
        let config = variable("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        let home = variable("HOME").map(PathBuf::from);
        let input = payload.clone();
        std::thread::spawn(move || {
            status_line::own_command(&input, config.as_deref(), home.as_deref())
                .map(|command| status_line::run(&command, input.as_bytes(), deadline))
        })
    });
    let shown = move || own.and_then(|running| running.join().ok().flatten());
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return say(&fallback());
    };
    runtime.block_on(async {
        let left = deadline.saturating_duration_since(Instant::now());
        let asked = tokio::time::timeout(left, ask(&endpoint, format!("{message}\n"))).await;
        let Ok(Some((answer, mut to_runner))) = asked else {
            return say(&shown().unwrap_or_else(fallback));
        };
        if let Some(stdout) = &answer.stdout {
            // Printed: what the lease delivers has reached the agent. Otherwise the lease
            // lapses, and the runner delivers its messages again.
            let printed = print(stdout);
            if let Some(lease) = answer.lease.as_ref().filter(|_| printed) {
                let ack = format!("{}\n", json!({ "ack": lease }));
                let sent = async {
                    to_runner.write_all(ack.as_bytes()).await?;
                    to_runner.flush().await
                };
                let _ = tokio::time::timeout(Duration::from_millis(500), sent).await;
            }
            return;
        }
        say(&shown().unwrap_or_else(fallback));
    });
    runtime.shutdown_background();
}

/// The agent's payload, or None once it runs past what the hook takes, or past
/// `deadline`, when what is left goes unread.
fn read_input(deadline: Instant) -> Option<Vec<u8>> {
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
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
async fn ask(endpoint: &str, line: String) -> Option<(Answer, endpoint::Writer)> {
    let (from_runner, mut to_runner) = endpoint::connect(endpoint).await.ok()?;
    to_runner.write_all(line.as_bytes()).await.ok()?;
    to_runner.flush().await.ok()?;
    let mut reply = String::new();
    BufReader::new(from_runner)
        .read_line(&mut reply)
        .await
        .ok()?;
    Some((answer_of(&reply), to_runner))
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
            answer_of(r#"{"leaseId":"abc","stdout":"{\"decision\":\"block\"}"}"#),
            Answer {
                stdout: Some("{\"decision\":\"block\"}".into()),
                lease: Some("abc".into()),
            }
        );
        assert_eq!(
            answer_of(r#"{"leaseId":null,"stdout":null}"#),
            Answer::default()
        );
        assert_eq!(answer_of("not json"), Answer::default());
    }

    #[test]
    fn prints_what_each_agent_needs_without_nova_deck_as_configured() {
        let config = config();
        assert_eq!(
            config.fallback("agy", "PreToolUse"),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(config.fallback("agy", "Stop"), "{}\n");
        assert_eq!(config.fallback("claude", "Stop"), "");
        assert_eq!(config.fallback("codex", "PreToolUse"), "");
        // Without its configuration, it prints nothing.
        assert_eq!(Config::default().fallback("agy", "PreToolUse"), "");
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

    #[test]
    fn names_itself_first_so_the_runner_knows_its_line() {
        let hello = json!({ "relay": PROTOCOL, "kind": "hook", "agent": "claude" }).to_string();
        assert!(hello.starts_with("{\"relay\":2,"));
    }
}
