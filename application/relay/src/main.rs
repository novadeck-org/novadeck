//! Novadeck's relay: what an agent starts for Novadeck's MCP server and its hooks. It
//! carries the agent's messages to the runner of the terminal it runs in, and the
//! runner's answers back, and answers by itself outside Novadeck's terminals. The runner
//! reads everything; the relay only carries it, so it stays small and starts at once,
//! for as long as an agent runs and for every hook it runs.

mod ancestors;
mod endpoint;
mod hook;
mod idle;
mod mcp;
mod status_line;

use std::collections::HashMap;
use std::path::Path;
use std::process::ExitCode;

/// The version of the protocol the relay and the runner speak (see docs/backend-api.md,
/// "Relay protocol"); the runner takes the versions it knows.
pub const PROTOCOL: u32 = 2;

const USAGE: &str = "usage: novadeck-relay mcp <server-version> <protocol-version>...
       novadeck-relay hook [--config <relay.json>] [--<option> <value>]... <agent> [event]
       novadeck-relay --version";

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
            _ => {
                eprintln!("{USAGE}");
                ExitCode::from(2)
            }
        },
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
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
}
