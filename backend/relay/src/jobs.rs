//! `novadeck-relay jobs`: the runner's keeper of its terminals' job objects, which Windows
//! has where Linux has a terminal's systemd scope. It runs as long as the runner keeps its
//! input open, and holds a job for each terminal: the shell is put in it as soon as the
//! runner knows its pid, and from then on everything the shell starts is in it too, however
//! it is started (`start /b`, `Start-Process`, a daemon), and stays in it once the program
//! that started it has ended, where its recorded parent leads nowhere. So the runner can
//! find, as a terminal closes, what an agent left running there detached.
//!
//! A job here only holds; it never ends anything. It is made without `KILL_ON_CLOSE`, so
//! the keeper's exit, or a terminal's job let go, leaves every process in it running; the
//! runner ends what it chooses by pid and start (`end`). It allows no breakaway: Git Bash's
//! runtime (MSYS, as Cygwin's) starts every program with `CREATE_BREAKAWAY_FROM_JOB` where
//! its job allows that, so with it everything Claude Code's Bash tool runs would leave the
//! job (measured with its e2e tests). A program that asks to break away without looking
//! first is refused, and doesn't start. Jobs nest (Windows 8 and later), so a job a program in the terminal
//! makes for itself, as `novadeck-cmd` does, sits inside this one, and is listed with it.
//!
//! It reads a line for each ask and answers each with a JSON line, in order, naming the
//! ask's number:
//!
//! - `<n> hold <terminal> <pid>[:<started-ms>]`: puts that process in a new job for the
//!   terminal: `{"n":<n>,"held":true}`, or `{"n":<n>,"held":false,"error":"..."}` where it
//!   has ended or Windows refuses. A terminal already held keeps its job.
//! - `<n> members <terminal>`: the processes in its job now, as `tree` prints them:
//!   `{"n":<n>,"processes":[...]}`, or `"processes":null` for a terminal with no job, or one
//!   Windows won't list.
//! - `<n> release <terminal>`: lets its job go: `{"n":<n>,"released":true}`. What still
//!   runs in it runs on; the job itself goes once the last of it has ended.
//! - `<n> end <pid>:<started-ms>...`: ends each process still running that started then, as
//!   `novadeck-relay end` does, without a process started for it: `{"n":<n>,"ended":true}`.
//!
//! An ask it can't read is answered `{"n":<n>,"error":"..."}`, with the number where it has
//! one.

use std::collections::HashMap;
use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::job::{ASSIGNABLE, Job};
use crate::processes;

/// The answer to one ask, given the jobs held so far.
fn answer(line: &str, jobs: &mut HashMap<String, Job>) -> Value {
    let words: Vec<&str> = line.split_whitespace().collect();
    let Some((number, rest)) = words.split_first() else {
        return json!({ "error": "an empty ask" });
    };
    let Ok(n) = number.parse::<u64>() else {
        return json!({ "error": format!("no ask number in {line:?}") });
    };
    match rest {
        ["hold", terminal, process] => {
            let Some((pid, started)) = crate::pid_and_start(process) else {
                return json!({ "n": n, "error": format!("not a process: {process}") });
            };
            if jobs.contains_key(*terminal) {
                return json!({ "n": n, "held": true });
            }
            let held = Job::empty(0).and_then(|job| {
                processes::with_running(pid, ASSIGNABLE, started, |process| job.assign(process))?;
                Ok(job)
            });
            match held {
                Ok(job) => {
                    jobs.insert((*terminal).to_owned(), job);
                    json!({ "n": n, "held": true })
                }
                Err(error) => json!({ "n": n, "held": false, "error": error }),
            }
        }
        ["members", terminal] => {
            let processes = jobs.get(*terminal).and_then(|job| {
                job.pids()
                    .and_then(|pids| processes::describe(&pids, |process| job.holds(process)))
            });
            json!({ "n": n, "processes": processes })
        }
        ["release", terminal] => {
            jobs.remove(*terminal);
            json!({ "n": n, "released": true })
        }
        ["end", named @ ..] if !named.is_empty() => {
            let members: Option<Vec<processes::Member>> = named
                .iter()
                .map(|one| match crate::pid_and_start(one)? {
                    (pid, Some(started)) => Some(processes::Member { pid, started }),
                    (_, None) => None,
                })
                .collect();
            match members {
                Some(members) => {
                    processes::end(&members);
                    json!({ "n": n, "ended": true })
                }
                None => json!({ "n": n, "error": format!("not processes: {line:?}") }),
            }
        }
        _ => json!({ "n": n, "error": format!("not an ask: {line:?}") }),
    }
}

/// Answers asks from `input` on `output` until the input ends or the output can't be
/// written, as once the runner has gone. Every job is let go then, ending nothing.
fn serve(input: impl BufRead, mut output: impl Write) {
    let mut jobs = HashMap::new();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = answer(&line, &mut jobs);
        if writeln!(output, "{answer}")
            .and_then(|()| output.flush())
            .is_err()
        {
            break;
        }
    }
}

/// `novadeck-relay jobs`, on this process's own input and output.
pub fn run() {
    serve(std::io::stdin().lock(), std::io::stdout().lock());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answers(asks: &str) -> Vec<Value> {
        let mut output = Vec::new();
        serve(asks.as_bytes(), &mut output);
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn holds_a_terminal_and_lists_what_runs_in_its_job_until_it_is_let_go() {
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let me = child.id();
        let found = answers(&format!(
            "1 members t\n2 hold t {me}\n3 hold t {me}\n4 members t\n5 release t\n6 members t\n"
        ));
        assert_eq!(found[0], json!({ "n": 1, "processes": null }));
        assert_eq!(found[1], json!({ "n": 2, "held": true }));
        assert_eq!(found[2], json!({ "n": 3, "held": true }));
        let listed = found[3]["processes"].as_array().unwrap();
        assert!(
            listed.iter().any(|one| one["pid"] == json!(me)),
            "{listed:?}"
        );
        assert_eq!(found[4], json!({ "n": 5, "released": true }));
        assert_eq!(found[5], json!({ "n": 6, "processes": null }));
        // Let go, it runs on, until it is ended by its start.
        assert!(child.try_wait().unwrap().is_none());
        let mine = listed.iter().find(|one| one["pid"] == json!(me)).unwrap();
        let started = mine["startedAt"].as_u64().unwrap();
        let ended = answers(&format!(
            "1 end {me}:{}\n2 end {me}:{started}\n",
            started + 1
        ));
        assert_eq!(ended[0], json!({ "n": 1, "ended": true }));
        assert_eq!(ended[1], json!({ "n": 2, "ended": true }));
        assert_eq!(child.wait().unwrap().code(), Some(1));
    }

    #[test]
    fn holds_a_process_only_as_the_one_that_started_then() {
        let mut child = std::process::Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let found = answers(&format!("1 hold t {pid}:1\n2 members t\n"));
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(found[0]["held"], json!(false));
        assert!(
            found[0]["error"]
                .as_str()
                .unwrap()
                .contains("another process")
        );
        assert_eq!(found[1]["processes"], Value::Null);
    }

    #[test]
    fn says_why_a_process_isnt_held_and_answers_an_ask_it_cant_read() {
        let found = answers("1 hold t 4294967295\n2 hold t x\nnope\n3 jump\n");
        assert_eq!(found[0]["held"], json!(false));
        assert!(found[0]["error"].is_string());
        assert!(
            found[1]["error"]
                .as_str()
                .unwrap()
                .contains("not a process")
        );
        assert!(
            found[2]["error"]
                .as_str()
                .unwrap()
                .contains("no ask number")
        );
        assert!(found[3]["error"].as_str().unwrap().contains("not an ask"));
    }
}
