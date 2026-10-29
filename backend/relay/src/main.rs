//! Novadeck's relay: what an agent starts for Novadeck's MCP server and its hooks. It
//! carries the agent's messages to the runner of the terminal it runs in, and the
//! runner's answers back, and answers by itself outside Novadeck's terminals. The runner
//! reads everything; the relay only carries it, so it stays small and starts at once,
//! for as long as an agent runs and for every hook it runs.
//!
//! On Windows it also reads for the runner what it would otherwise start PowerShell or
//! taskkill for: the registry's environment, and a terminal's process tree, which it ends.

mod ancestors;
mod endpoint;
mod hook;
mod idle;
mod mcp;
#[cfg(windows)]
mod processes;
#[cfg(windows)]
mod registry;
mod status_line;

use std::collections::HashMap;
use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

/// The version of the protocol the relay and the runner speak (see docs/backend-api.md,
/// "Relay protocol"); the runner takes the versions it knows.
pub const PROTOCOL: u32 = 2;

/// An environment variable's value, where it holds one.
pub fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// Wall-clock milliseconds since the Unix epoch, with their fraction; None on a clock set
/// before it.
pub fn epoch_ms() -> Option<f64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_secs_f64() * 1000.0)
}

const USAGE: &str = "usage: novadeck-relay mcp <server-version> <protocol-version>...
       novadeck-relay hook [--config <relay.json>] [--<option> <value>]... <agent> [event]
       novadeck-relay --version
       novadeck-relay environment                    (Windows)
       novadeck-relay tree <pid>[:<started-ms>]...   (Windows)
       novadeck-relay end <pid>:<started-ms>...      (Windows)";

/// The leading `--name value` options, and the arguments after them. Every option takes a
/// value, so one this relay doesn't know, from a newer runner's launcher, is passed over
/// whole rather than read as the agent.
fn options(args: &[String]) -> (HashMap<&str, &str>, &[String]) {
    let mut found = HashMap::new();
    let mut rest = args;
    while let [name, value, after @ ..] = rest {
        if !name.starts_with("--") {
            break;
        }
        found.insert(name.as_str(), value.as_str());
        rest = after;
    }
    (found, rest)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((mode, _)) if mode == "--version" => {
            println!(
                "novadeck-relay {} (protocol {PROTOCOL})",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::SUCCESS
        }
        // A hook always succeeds, so its agent never treats Novadeck as failing.
        Some((mode, rest)) if mode == "hook" => {
            let (options, rest) = options(rest);
            // What the runner tells it of the agents, from the file its launcher names.
            let config = hook::Config::read(options.get("--config").map(Path::new));
            let agent = rest.first().map_or("", String::as_str);
            let event = rest.get(1).map_or("", String::as_str);
            hook::run(agent, event, &config);
            ExitCode::SUCCESS
        }
        Some((mode, rest)) if mode == "mcp" => match rest.split_first() {
            Some((server, versions)) if !versions.is_empty() => {
                mcp::run(server, versions);
                ExitCode::SUCCESS
            }
            _ => usage(),
        },
        #[cfg(windows)]
        Some((mode, _)) if mode == "environment" => {
            registry::print();
            ExitCode::SUCCESS
        }
        #[cfg(windows)]
        Some((mode, rest)) if mode == "tree" => match roots(rest) {
            Some(roots) if processes::print_trees(&roots) => ExitCode::SUCCESS,
            // Windows refused the snapshot: no tree is known, so the runner falls back.
            Some(_) => ExitCode::FAILURE,
            None => usage(),
        },
        #[cfg(windows)]
        Some((mode, rest)) if mode == "end" => match members(rest) {
            Some(members) => {
                processes::end(&members);
                ExitCode::SUCCESS
            }
            None => usage(),
        },
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

/// A process as `<pid>` or `<pid>:<started-ms>`; None where it is neither.
#[cfg(any(windows, test))]
fn process(arg: &str) -> Option<(u32, Option<u64>)> {
    match arg.split_once(':') {
        Some((pid, started)) => Some((pid.parse().ok()?, Some(started.parse().ok()?))),
        None => Some((arg.parse().ok()?, None)),
    }
}

/// Each argument as `read` reads it, one or more; None where any can't be read.
#[cfg(any(windows, test))]
fn each<T>(args: &[String], read: impl Fn(&str) -> Option<T>) -> Option<Vec<T>> {
    let found: Option<Vec<T>> = args.iter().map(|arg| read(arg)).collect();
    found.filter(|found| !found.is_empty())
}

/// Roots as `<pid>` or `<pid>:<started-ms>`, each beside the argument that named it.
#[cfg(windows)]
fn roots(args: &[String]) -> Option<Vec<(String, processes::Root)>> {
    each(args, |arg| {
        let (pid, started) = process(arg)?;
        Some((arg.to_owned(), processes::Root { pid, started }))
    })
}

/// Processes as `<pid>:<started-ms>`.
#[cfg(windows)]
fn members(args: &[String]) -> Option<Vec<processes::Member>> {
    each(args, |arg| match process(arg)? {
        (pid, Some(started)) => Some(processes::Member { pid, started }),
        (_, None) => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(each: &[&str]) -> Vec<String> {
        each.iter().map(|one| (*one).to_owned()).collect()
    }

    #[test]
    fn passes_over_options_it_doesnt_know_rather_than_read_them_as_the_agent() {
        let given = args(&["--config", "relay.json", "--newer", "x", "agy", "Stop"]);
        let (found, rest) = options(&given);
        assert_eq!(found.get("--config"), Some(&"relay.json"));
        assert_eq!(rest, args(&["agy", "Stop"]));
        let plain = args(&["claude", "Stop"]);
        assert_eq!(options(&plain).1, plain);
    }

    #[test]
    fn reads_processes_by_pid_or_by_pid_and_start_and_refuses_anything_else() {
        let processes = |given: &[&str]| each(&args(given), process);
        assert_eq!(
            processes(&["12", "34:5600"]),
            Some(vec![(12, None), (34, Some(5600))])
        );
        assert_eq!(processes(&[]), None);
        assert_eq!(processes(&["12", "x"]), None);
        assert_eq!(processes(&["12:x"]), None);
        assert_eq!(processes(&["12:"]), None);
    }
}
