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
    /// The shipping gate is on (`"gate": true`): the rules it has the shim write are in force.
    gated: bool,
    /// A configuration was named and couldn't be read: whether the gate is on isn't known.
    unreadable: bool,
}

impl Config {
    pub fn read(path: Option<&Path>) -> Config {
        let read = path
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|value| Config::of(&value));
        match (read, path) {
            (Some(config), _) => config,
            (None, Some(_)) => Config {
                unreadable: true,
                ..Config::default()
            },
            (None, None) => Config::default(),
        }
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
            gated: value.get("gate").and_then(Value::as_bool) == Some(true),
            unreadable: false,
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
    ///
    /// `payload` is what the hook was sent where it was read (its start where it was too big),
    /// None where it wasn't. Antigravity's PreToolUse prints "ask" whatever the configuration says,
    /// even a non-empty answer: it denies a tool whose answer names no decision (`{}` included).
    /// But where the shipping gate is on (or isn't known to be off) and the command is one of
    /// `SHIPPING_RULES`, which the shim has agy allow, "ask" would run it unasked, so it prints
    /// a deny, and does the same where it can't tell what the command is.
    ///
    /// opencode's PreToolUse (its plugin's, for a `bash` call) is read the same way, but for what
    /// counts: its built-in default allows a shell command (agent/agent.ts `"*": "allow"`, 1.19.6),
    /// so a hook that said nothing runs the command with no dialog. Where the runner gave no
    /// answer, any command that looks like git or gh shipping (`command_looks_shipping`, coarser
    /// than the rules) is refused, and its plugin throws the reason. Any other answer it gets is
    /// the configuration's (silence).
    fn fallback(&self, agent: &str, event: &str, payload: Option<&str>) -> String {
        if (agent == "agy" || agent == "opencode") && event == "PreToolUse" {
            let guarded =
                (self.gated || self.unreadable) && payload.is_none_or(|text| ships(agent, text));
            if guarded {
                return format!("{}\n", json!({ "decision": "deny", "reason": REFUSED }));
            }
            if agent == "agy" {
                return "{\"decision\":\"ask\"}\n".to_owned();
            }
        }
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
            // Antigravity's PreToolUse comes before every tool, and only a shell command's is
            // asked of the runner: the others keep a report's short limit (`limit_for`).
            ("agy", "PreToolUse") => 2_000,
            // The same for opencode's: its plugin reports every tool, and only `bash` is asked.
            ("opencode", "PreToolUse") => 2_000,
            _ if self.asks(agent, event) => 4_000,
            _ => 2_000,
        })
    }

    /// How long a hook may take once its payload is read: `limit`, but for Antigravity's
    /// PreToolUse of a `run_command` call and opencode's of a `bash` call, listed in `asks`, which
    /// the runner answers (the shipping gate) and so get the long limit a Stop does.
    fn limit_for(&self, agent: &str, event: &str, payload: &str) -> Duration {
        let shell = match agent {
            "agy" => runs_command(payload),
            "opencode" => runs_bash(payload),
            _ => false,
        };
        if shell && event == "PreToolUse" && self.asks(agent, event) {
            return Duration::from_millis(4_000);
        }
        self.limit(agent, event)
    }
}

/// What a refused shipping command is told where the runner gave no answer.
const REFUSED: &str = "Novadeck: its runner didn't answer, so this command, which ships work, \
isn't allowed now. Run it again in a moment, on its own.";

/// The rules the shim has Antigravity allow while the shipping gate is on, which the relay may
/// never answer "ask" for (`harnesses/agy/src/shim.ts` holds the same list, and a test pins them).
pub const SHIPPING_RULES: [&str; 2] = ["command(gh pr create)", "command(gh pr merge)"];

/// Whether a command, as one line or several, holds a segment of a `SHIPPING_RULES` shape. Coarse:
/// by segment (split at `;`, `&`, `|` and line ends, quotes ignored), the program is the rule's
/// and its other words come in order among the rest, so `cd x && gh -R o/r pr create …` counts and
/// more is read as shipping than the rules allow, never less.
fn command_ships(command: &str) -> bool {
    command.split([';', '&', '|', '\n', '\r']).any(|segment| {
        let mut words = segment
            .split_whitespace()
            .skip_while(|word| word.contains('=') && !word.starts_with('-'));
        let program = words
            .next()
            .map(|word| word.rsplit(['/', '\\']).next().unwrap_or(word));
        let rest: Vec<&str> = words.collect();
        SHIPPING_RULES.iter().any(|rule| {
            let wanted: Vec<&str> = rule
                .trim_start_matches("command(")
                .trim_end_matches(')')
                .split_whitespace()
                .collect();
            let [head, tail @ ..] = wanted.as_slice() else {
                return false;
            };
            let mut next = tail.iter().peekable();
            for word in &rest {
                if next.peek().is_some_and(|want| *word == **want) {
                    next.next();
                }
            }
            program == Some(*head) && next.peek().is_none()
        })
    })
}

/// Whether `command` holds a segment that looks like git or gh shipping, read coarsely: split at
/// `;`, `&`, `|` and line ends, with quotes and backslashes taken out, a `git` or `gh` word and after it, in the same
/// segment, one of the verbs the runner's reader reads (`shippingVerbs` in
/// `backend/runner/src/shipping/reader.ts`, with `fetch`). More counts than the reader reads as
/// shipping (`git branch`, `echo git push`), never less, and `command_ships`' shapes are among it.
/// The runner's `shipsCoarsely` reads the same; both are tested against `rule-cases.json`.
fn command_looks_shipping(command: &str) -> bool {
    const VERBS: [&str; 15] = [
        "fetch",
        "push",
        "merge",
        "rebase",
        "pull",
        "cherry-pick",
        "reset",
        "checkout",
        "switch",
        "branch",
        "update-ref",
        "pr",
        "api",
        "release",
        "workflow",
    ];
    command.split([';', '&', '|', '\n', '\r']).any(|segment| {
        // The shell drops quotes and backslashes it reads (`g''it`, `pu\sh`, `"g"it`), which the
        // runner's reader reads past too: without them, nothing it reads as shipping slips by.
        let segment: String = segment
            .chars()
            .filter(|c| !matches!(c, '\'' | '"' | '\\'))
            .collect();
        let segment = segment.as_str();
        // The first git or gh word: any verb after a later one comes after it too.
        let first = ["git", "gh"]
            .iter()
            .filter_map(|word| find_word(segment, word, 0).map(|at| at + word.len()))
            .min();
        first.is_some_and(|from| {
            VERBS
                .iter()
                .any(|verb| find_word(segment, verb, from).is_some())
        })
    })
}

/// Where `word` first stands in `text` at or after `from` as a whole word (`\b` on both sides, as
/// a regular expression reads it: a letter, digit or `_` is part of a word).
fn find_word(text: &str, word: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let inside = |at: usize| {
        bytes
            .get(at)
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
    };
    text.match_indices(word)
        .map(|(at, _)| at)
        .find(|&at| at >= from && (at == 0 || !inside(at - 1)) && !inside(at + word.len()))
}

/// The string a payload names under `key` (Antigravity's `CommandLine`, opencode's `command`),
/// read leniently, where the payload was cut: the string after its key, up to its end or the
/// cut, and whether it ended (a cut one may hide any shape).
fn command_in(text: &str, key: &str) -> Option<(String, bool)> {
    let key = format!("\"{key}\"");
    let at = text.find(&key)? + key.len();
    let rest = text[at..]
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let mut out = String::new();
    let mut ended = false;
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                ended = true;
                break;
            }
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('u') => {
                    for _ in 0..4 {
                        chars.next();
                    }
                    out.push(' ');
                }
                Some(other) => out.push(other),
                None => break,
            },
            c => out.push(c),
        }
    }
    Some((out, ended))
}

/// Whether an Antigravity or opencode PreToolUse payload is a shell command of a shipping shape,
/// or one that can't be told apart from it: a payload cut before its command, or one that names
/// no tool. Antigravity's is its `run_command` call's `CommandLine`; opencode's is its plugin's
/// report of the `bash` tool: `tool_name` and `tool_input.command`.
fn ships(agent: &str, payload: &str) -> bool {
    let (tool, command, key) = if agent == "opencode" {
        ("bash", "command", "command")
    } else {
        ("run_command", "CommandLine", "CommandLine")
    };
    // opencode's refusal is wider than the shim's rules: it has no rule, and its default runs
    // what its hook doesn't refuse.
    let looks: fn(&str) -> bool = if agent == "opencode" {
        command_looks_shipping
    } else {
        command_ships
    };
    match serde_json::from_str::<Value>(payload) {
        Ok(value) => {
            let (name, line) = if agent == "opencode" {
                (&value["tool_name"], &value["tool_input"][command])
            } else {
                (
                    &value["toolCall"]["name"],
                    &value["toolCall"]["args"][command],
                )
            };
            match name.as_str() {
                Some(named) if named == tool => line.as_str().is_none_or(looks),
                Some(_) => false,
                // No tool named: not a tool call this relay can read.
                None => true,
            }
        }
        // Cut or not JSON: the command as far as it goes, or unknown, which counts.
        Err(_) => command_in(payload, key).is_none_or(|(command, ended)| !ended || looks(&command)),
    }
}

/// Whether an Antigravity hook payload is about a `run_command` call.
fn runs_command(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| {
            value["toolCall"]["name"]
                .as_str()
                .map(|name| name == "run_command")
        })
        .unwrap_or(false)
}

/// Whether an opencode hook payload is about a `bash` call.
fn runs_bash(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| value["tool_name"].as_str().map(|name| name == "bash"))
        .unwrap_or(false)
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
    let begun = Instant::now();
    let deadline = begun + config.limit(agent, event);
    // The agent's payload, read whole even where it goes unused, so the agent never
    // writes into a closed pipe; within the hook's limit, as an agent may leave it open.
    let Some((payload, whole)) = read_payload(deadline) else {
        return say(&config.fallback(agent, event, None));
    };
    let payload = String::from_utf8_lossy(&payload).into_owned();
    let fallback = || config.fallback(agent, event, Some(&payload));
    // Too big to send: what the fallback prints goes by its start.
    if !whole {
        return say(&fallback());
    }
    // What the payload says may lengthen the limit (see `limit_for`).
    let limit = config.limit_for(agent, event, &payload);
    let deadline = begun + limit;
    // Claude Code's status line shows the person's own wherever it runs: outside a terminal
    // Novadeck can reach as within one.
    let own = claude_status_line(agent, event).then(|| own_status_line(payload.clone(), deadline));
    let shown = move || own.and_then(|running| running.join().ok().flatten());
    let Some(terminal) = Terminal::from_env() else {
        return say(&shown().unwrap_or_else(fallback));
    };
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
    let Ok(runtime) = endpoint::runtime() else {
        return say(&shown().unwrap_or_else(fallback));
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

/// The agent's payload, with whether it was whole: past the most the hook takes, its start
/// (`PREFIX`) is kept for the fallback. None once it runs past `deadline`, when what is left
/// goes unread.
fn read_payload(deadline: Instant) -> Option<(Vec<u8>, bool)> {
    let (sent, received) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut payload = Vec::new();
        let read = io::stdin()
            .lock()
            .take(MAX_PAYLOAD + 1)
            .read_to_end(&mut payload);
        let whole = read.is_ok() && payload.len() as u64 <= MAX_PAYLOAD;
        // Past the most it takes: the rest is drained, unkept but for its start.
        if !whole {
            payload.truncate(PREFIX);
            let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        }
        let _ = sent.send((payload, whole));
    });
    received
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
}

/// How much of a payload too big to send the fallback reads.
const PREFIX: usize = 64 * 1024;

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
            config.fallback("agy", "PreToolUse", Some("{}")),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(config.fallback("agy", "Stop", None), "{}\n");
        assert_eq!(config.fallback("claude", "Stop", None), "");
        assert_eq!(config.fallback("codex", "PreToolUse", None), "");
        // Without its configuration, it prints nothing, but for what keeps Antigravity
        // from denying every tool.
        assert_eq!(
            Config::default().fallback("agy", "PreToolUse", Some("{}")),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(Config::default().fallback("agy", "Stop", None), "");
        // Nor does a configuration without Antigravity's entry.
        let without = Config::of(&json!({ "fallbacks": { "claude": { "*": "" } } }));
        assert_eq!(
            without.fallback("agy", "PreToolUse", Some("{}")),
            "{\"decision\":\"ask\"}\n"
        );
        assert_eq!(without.fallback("agy", "Stop", None), "");
        assert_eq!(Config::default().fallback("codex", "PreToolUse", None), "");
    }

    #[test]
    fn only_antigravitys_shell_commands_wait_the_long_limit_for_the_runner() {
        let config = Config::of(&json!({ "asks": { "agy": ["Stop", "PreToolUse"] } }));
        let run = r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"git push"}}}"#;
        let read = r#"{"toolCall":{"name":"read_file","args":{}}}"#;
        let ms = |payload: &str| config.limit_for("agy", "PreToolUse", payload).as_millis();
        assert_eq!(ms(run), 4_000);
        assert_eq!(ms(read), 2_000);
        assert_eq!(ms("not json"), 2_000);
        // Before its payload is read it is the short one, and without the event in `asks` too.
        assert_eq!(config.limit("agy", "PreToolUse").as_millis(), 2_000);
        let unlisted = Config::of(&json!({ "asks": { "agy": ["Stop"] } }));
        assert_eq!(
            unlisted.limit_for("agy", "PreToolUse", run).as_millis(),
            2_000
        );
        assert_eq!(config.limit_for("agy", "Stop", run).as_millis(), 4_000);
    }

    const GUARDED: &str =
        r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"gh pr create --body x"}}}"#;
    const SAFE: &str = r#"{"toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}"#;
    const ASK: &str = "{\"decision\":\"ask\"}\n";

    fn gated() -> Config {
        Config::of(&json!({ "gate": true }))
    }

    fn denied(printed: &str) -> bool {
        serde_json::from_str::<Value>(printed.trim())
            .is_ok_and(|value| value["decision"] == "deny" && value["reason"].is_string())
    }

    #[test]
    fn reads_the_shapes_as_the_runners_cases_do() {
        let cases: Value = serde_json::from_str(include_str!("rule-cases.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let command = case["command"].as_str().unwrap();
            assert_eq!(
                command_ships(command),
                case["ships"].as_bool().unwrap(),
                "{command:?}"
            );
        }
    }

    #[test]
    fn reads_what_looks_like_shipping_as_the_runners_cases_do() {
        let cases: Value = serde_json::from_str(include_str!("rule-cases.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let command = case["command"].as_str().unwrap();
            assert_eq!(
                command_looks_shipping(command),
                case["coarse"].as_bool().unwrap(),
                "{command:?}"
            );
            // The shim's rules are among what it refuses.
            if case["ships"].as_bool().unwrap() {
                assert!(command_looks_shipping(command), "{command:?}");
            }
        }
    }

    /// opencode's plugin's report of a `bash` call, as `tool.execute.before` makes it.
    fn opencode_report(command: &str) -> String {
        json!({
            "hook_event_name": "PreToolUse",
            "cwd": "/w",
            "session_id": "ses_1",
            "tool_name": "bash",
            "call_id": "toolu_1",
            "tool_input": { "command": command, "description": "d" },
        })
        .to_string()
    }

    #[test]
    fn reads_the_shapes_in_opencodes_report_as_the_runners_cases_do() {
        let cases: Value = serde_json::from_str(include_str!("rule-cases.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let command = case["command"].as_str().unwrap();
            let ships_it = case["coarse"].as_bool().unwrap();
            assert_eq!(
                ships("opencode", &opencode_report(command)),
                ships_it,
                "{command:?}"
            );
            // Cut in the middle of the command: what may hide the shape counts as shipping.
            if ships_it {
                let report = opencode_report(command);
                let from = report.find("\"command\":\"").unwrap() + "\"command\":\"".len();
                let cut: String = report.chars().take(from + 5).collect();
                assert!(ships("opencode", &cut), "{command:?}");
            }
        }
    }

    // opencode's own default allows a shell command, so what its hook doesn't refuse runs with no
    // dialog: where the runner gave no answer the relay refuses what looks like shipping, read
    // coarsely, and prints what opencode's plugin reads as a deny.
    #[test]
    fn refuses_opencodes_shipping_command_where_the_runner_gave_no_answer_while_the_gate_is_on() {
        let gated = gated();
        let guarded = opencode_report("gh pr create --title t --body x");
        assert!(denied(&gated.fallback(
            "opencode",
            "PreToolUse",
            Some(&guarded)
        )));
        // Cut after its tool but inside its command, and cut before its command.
        let cut = &guarded[..guarded.len() - 25];
        assert!(denied(&gated.fallback("opencode", "PreToolUse", Some(cut))));
        let early = &guarded[..guarded.find("tool_input").unwrap()];
        assert!(denied(&gated.fallback(
            "opencode",
            "PreToolUse",
            Some(early)
        )));
        assert!(denied(&gated.fallback("opencode", "PreToolUse", None)));
        // Too big to send, kept by its start.
        let big = format!("{{\"prompt\":\"{}\",{}", "x".repeat(70_000), &guarded[1..]);
        assert!(denied(&gated.fallback(
            "opencode",
            "PreToolUse",
            Some(&big[..64 * 1024])
        )));
        // Every shape the reader reads as shipping, not only the shim's two.
        for command in [
            "git push origin main",
            "git push -f origin main",
            "gh pr edit 5 --base release",
            "gh release create v1",
            "gh api -X POST repos/o/r/git/refs",
            "git reset --hard origin/main",
        ] {
            assert!(
                denied(&gated.fallback("opencode", "PreToolUse", Some(&opencode_report(command)))),
                "{command:?}"
            );
        }
        // Any other command, other tool and other event gets what its configuration says.
        let safe = opencode_report("ls");
        assert_eq!(gated.fallback("opencode", "PreToolUse", Some(&safe)), "");
        let status = opencode_report("git status");
        assert_eq!(gated.fallback("opencode", "PreToolUse", Some(&status)), "");
        let read = json!({ "tool_name": "read", "tool_input": { "command": "gh pr create" } });
        assert_eq!(
            gated.fallback("opencode", "PreToolUse", Some(&read.to_string())),
            ""
        );
        assert_eq!(
            gated.fallback("opencode", "PermissionRequest", Some(&guarded)),
            ""
        );
        let silent =
            Config::of(&json!({ "gate": true, "fallbacks": { "opencode": { "*": "{}" } } }));
        assert_eq!(
            silent.fallback("opencode", "PreToolUse", Some(&safe)),
            "{}\n"
        );
        assert!(denied(&silent.fallback(
            "opencode",
            "PreToolUse",
            Some(&guarded)
        )));
        // Off, or not known to be on, as before.
        let off = Config::of(&json!({ "asks": {} }));
        assert_eq!(off.fallback("opencode", "PreToolUse", Some(&guarded)), "");
        let missing = Config::read(Some(Path::new("/no/such/relay.json")));
        assert!(denied(&missing.fallback(
            "opencode",
            "PreToolUse",
            Some(&guarded)
        )));
        assert_eq!(missing.fallback("opencode", "PreToolUse", Some(&safe)), "");
    }

    // The shim writes these rules while the gate is on, and agy runs what a rule covers when the
    // hook says "ask": where the runner gave no answer the relay must refuse, never ask.
    #[test]
    fn refuses_a_shipping_command_where_the_runner_gave_no_answer_while_the_gate_is_on() {
        let gated = gated();
        // Every path that gives no answer prints the fallback; the payload is what it was sent.
        assert!(denied(&gated.fallback("agy", "PreToolUse", Some(GUARDED))));
        // A payload too big to send, kept by its start: its command, a start that cuts one, and
        // one cut before the command, which can't be told apart.
        let big = format!(
            "{{\"lastUserInput\":\"{}\",{}",
            "x".repeat(70_000),
            &GUARDED[1..]
        );
        let prefix = &big[..64 * 1024];
        assert!(denied(&gated.fallback("agy", "PreToolUse", Some(prefix))));
        let cut = &GUARDED[..GUARDED.len() - 20];
        assert!(denied(&gated.fallback("agy", "PreToolUse", Some(cut))));
        // No payload read at all.
        assert!(denied(&gated.fallback("agy", "PreToolUse", None)));
        // Any other command, and any other tool, is asked, as ever.
        assert_eq!(gated.fallback("agy", "PreToolUse", Some(SAFE)), ASK);
        assert_eq!(
            gated.fallback(
                "agy",
                "PreToolUse",
                Some(r#"{"toolCall":{"name":"read_file","args":{"Path":"gh pr create"}}}"#)
            ),
            ASK
        );
        assert_eq!(gated.fallback("claude", "PreToolUse", Some(GUARDED)), "");
        assert_eq!(gated.fallback("agy", "Stop", Some(GUARDED)), "");
    }

    #[test]
    fn only_opencodes_shell_commands_wait_the_long_limit_for_the_runner() {
        let config = Config::of(&json!({
            "asks": { "opencode": ["Stop", "PreToolUse", "PermissionRequest"] }
        }));
        let ms =
            |event: &str, payload: &str| config.limit_for("opencode", event, payload).as_millis();
        assert_eq!(ms("PreToolUse", &opencode_report("git push")), 4_000);
        let read = json!({ "tool_name": "read", "tool_input": { "filePath": "/a" } }).to_string();
        assert_eq!(ms("PreToolUse", &read), 2_000);
        assert_eq!(ms("PreToolUse", "not json"), 2_000);
        // Before its payload is read, and for its other events, as listed.
        assert_eq!(config.limit("opencode", "PreToolUse").as_millis(), 2_000);
        assert_eq!(ms("PermissionRequest", &read), 4_000);
        assert_eq!(ms("Stop", &read), 4_000);
        let unlisted = Config::of(&json!({ "asks": { "opencode": ["Stop"] } }));
        assert_eq!(
            unlisted
                .limit_for("opencode", "PreToolUse", &opencode_report("git push"))
                .as_millis(),
            2_000
        );
    }

    #[test]
    fn asks_as_ever_while_the_gate_is_off_and_refuses_where_it_cant_be_told() {
        let off = Config::of(&json!({ "asks": {} }));
        assert_eq!(off.fallback("agy", "PreToolUse", Some(GUARDED)), ASK);
        assert_eq!(
            Config::read(None).fallback("agy", "PreToolUse", Some(GUARDED)),
            ASK
        );
        // A configuration named and unreadable: the gate may be on.
        let missing = Config::read(Some(Path::new("/no/such/relay.json")));
        assert!(denied(&missing.fallback(
            "agy",
            "PreToolUse",
            Some(GUARDED)
        )));
        assert_eq!(missing.fallback("agy", "PreToolUse", Some(SAFE)), ASK);
    }

    #[test]
    fn keeps_the_shims_rules_and_its_own_equal() {
        // harnesses/agy/src/shim.ts's `shippingRules`, which a test there compares to this.
        assert_eq!(
            SHIPPING_RULES,
            ["command(gh pr create)", "command(gh pr merge)"]
        );
    }

    // The shipping gate leans on this (architecture/grants.md): where the runner gives Antigravity
    // no answer to a PreToolUse (no terminal, a payload too big, no connection, a timeout, an
    // unheard or failed ask), it prints `ask`, so its own dialog waits for the person. Silence
    // would let a rule or its default run the command unasked, and no configuration may empty it.
    #[test]
    fn antigravitys_pre_tool_use_never_falls_back_to_silence() {
        // Whatever the configuration says, even a non-empty answer, which Antigravity would
        // take as no decision and deny the tool for, or as a decision of the runner's.
        for text in ["", "{}", "{\"decision\":\"allow\"}"] {
            let config =
                Config::of(&json!({ "fallbacks": { "agy": { "PreToolUse": text, "*": text } } }));
            assert_eq!(
                config.fallback("agy", "PreToolUse", Some("{}")),
                "{\"decision\":\"ask\"}\n"
            );
        }
        // Its other events keep the configuration's.
        let other = Config::of(&json!({ "fallbacks": { "agy": { "Stop": "{}" } } }));
        assert_eq!(other.fallback("agy", "Stop", None), "{}\n");
        // An unheard ask, a runner that answers no stdout, is the same fallback.
        assert_eq!(Answer::of(r#"{"leaseId":null,"stdout":null}"#).stdout, None);
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
        // One named and missing is empty too, but for the mark that the gate's state isn't known.
        assert_eq!(
            Config::read(Some(Path::new("/no/such/relay.json"))),
            Config {
                unreadable: true,
                ..Config::default()
            }
        );
    }
}
