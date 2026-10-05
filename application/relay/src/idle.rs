//! The MCP server as it answers outside NovaDeck's terminals, or once their runner is
//! gone: the handshake, and no tools. Agents start the server in every session, so the
//! agent sees a working server it has nothing to call.

use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

/// The answer to one line from the agent, or None when it needs none.
pub fn answer(line: &str, server: &str, versions: &[String]) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let reply = |id: Value, body: (&str, Value)| {
        let mut message = json!({ "jsonrpc": "2.0", "id": id });
        message[body.0] = body.1;
        Some(message.to_string())
    };
    let error = |code: i32, message: String| ("error", json!({ "code": code, "message": message }));
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return reply(Value::Null, error(-32700, "Parse error".into()));
    };
    // One request per line: a batch, or anything but an object, is refused.
    let Some(request) = message.as_object() else {
        return reply(Value::Null, error(-32600, "Invalid Request".into()));
    };
    // Notifications, such as notifications/initialized, need no answer; nor do answers.
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request.get("method").and_then(Value::as_str)?;
    if id.is_null() {
        return None;
    }
    match method {
        "initialize" => {
            let asked = request
                .get("params")
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str);
            // A version it doesn't know is answered with the newest it does, listed first.
            let version = asked
                .filter(|asked| versions.iter().any(|known| known == asked))
                .unwrap_or(&versions[0]);
            reply(
                id,
                (
                    "result",
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "novadeck", "version": server },
                    }),
                ),
            )
        }
        "ping" => reply(id, ("result", json!({}))),
        "tools/list" => reply(id, ("result", json!({ "tools": [] }))),
        // With no tools, any named is unknown.
        "tools/call" => {
            let name = request.get("params").and_then(|params| params.get("name"));
            let name = match name {
                Some(Value::String(name)) => name.clone(),
                Some(other) => other.to_string(),
                None => "undefined".into(),
            };
            reply(id, error(-32602, format!("Unknown tool: {name}")))
        }
        _ => reply(id, error(-32601, format!("Method not found: {method}"))),
    }
}

/// Answers the agent, one line at a time, until it closes its side.
pub fn serve(server: &str, versions: &[String]) {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { return };
        if let Some(answer) = answer(&line, server, versions) {
            if writeln!(stdout, "{answer}")
                .and_then(|_| stdout.flush())
                .is_err()
            {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions() -> Vec<String> {
        vec!["2025-11-25".into(), "2025-06-18".into()]
    }

    fn parsed(line: &str) -> Value {
        serde_json::from_str(&answer(line, "1.2.0", &versions()).expect("an answer")).unwrap()
    }

    #[test]
    fn answers_the_handshake_with_the_version_asked() {
        let hello = parsed(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        );
        assert_eq!(
            hello,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "novadeck", "version": "1.2.0" },
                },
            })
        );
    }

    #[test]
    fn answers_a_version_it_does_not_know_with_the_newest() {
        let hello = parsed(
            r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#,
        );
        assert_eq!(hello["id"], "a");
        assert_eq!(hello["result"]["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn offers_no_tools_and_answers_pings() {
        let tools = parsed(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        assert_eq!(tools["result"], json!({ "tools": [] }));
        let ping = parsed(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#);
        assert_eq!(ping["result"], json!({}));
    }

    #[test]
    fn needs_no_answer_for_notifications_answers_or_blank_lines() {
        let quiet = |line: &str| answer(line, "1.2.0", &versions());
        assert_eq!(
            quiet(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
            None
        );
        assert_eq!(quiet(r#"{"jsonrpc":"2.0","id":4,"result":{}}"#), None);
        assert_eq!(quiet("   "), None);
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        assert_eq!(parsed("{not json")["error"]["code"], -32700);
        assert_eq!(
            parsed(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#)["error"]["code"],
            -32600
        );
        let unknown = parsed(r#"{"jsonrpc":"2.0","id":5,"method":"resources/list"}"#);
        assert_eq!(
            unknown["error"],
            json!({ "code": -32601, "message": "Method not found: resources/list" })
        );
        let call =
            parsed(r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"show"}}"#);
        assert_eq!(
            call["error"],
            json!({ "code": -32602, "message": "Unknown tool: show" })
        );
    }
}
