//! A harness's allow rules for one launch, with one of Novadeck's added: what a shim passes
//! as the session's own settings (Antigravity's `--settings`), where a list given there
//! replaces the person's list instead of adding to it. The person's settings file is read,
//! never written; the rules go to a file of Novadeck's own that the shim names, one per
//! terminal, which each launch there writes afresh.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// The settings to pass: the person's `permissions.allow` from `settings` (the file's text,
/// or None where there is no file) with `rule` after them, unless it is there already. None
/// where the person's rules can't be read: the file isn't a JSON object (a byte order mark
/// ahead of it aside), or its `permissions` isn't one, or its `allow` isn't a list, as passing
/// any list then would replace rules the harness may still read its own way.
#[cfg(test)]
fn merged(settings: Option<&str>, rule: &str) -> Option<Value> {
    merged_with(settings, &[rule])
}

/// `merged` with several rules after the person's own, each unless it is there already.
pub fn merged_with(settings: Option<&str>, added: &[&str]) -> Option<Value> {
    let parsed: Value = match settings {
        Some(text) => serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?,
        None => json!({}),
    };
    let permissions = match parsed.as_object()?.get("permissions") {
        None | Some(Value::Null) => None,
        Some(Value::Object(permissions)) => Some(permissions),
        Some(_) => return None,
    };
    let mut rules = match permissions.and_then(|permissions| permissions.get("allow")) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(rules)) => rules.clone(),
        Some(_) => return None,
    };
    for rule in added {
        if !rules.iter().any(|one| one.as_str() == Some(rule)) {
            rules.push(Value::String((*rule).to_owned()));
        }
    }
    Some(json!({ "permissions": { "allow": rules } }))
}

/// Writes the settings `merged` makes of the person's `settings` file to `file`, whole, and
/// says whether it did; false where there is nothing to pass.
#[cfg(test)]
fn write(settings: &Path, rule: &str, file: &Path) -> bool {
    write_with(settings, &[rule], file)
}

/// `write` with several rules (see `merged_with`).
pub fn write_with(settings: &Path, rules: &[&str], file: &Path) -> bool {
    let text = match fs::read_to_string(settings) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(_) => return false,
    };
    let Some(content) = merged_with(text.as_deref(), rules).map(|value| value.to_string()) else {
        return false;
    };
    if fs::read_to_string(file).ok().as_deref() == Some(content.as_str()) {
        return true;
    }
    let Some(folder) = file.parent() else {
        return false;
    };
    if fs::create_dir_all(folder).is_err() {
        return false;
    }
    // Whole or not at all: a session started before may read it again.
    let mut temporary = file.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = PathBuf::from(temporary);
    if fs::write(&temporary, &content).is_err() || fs::rename(&temporary, file).is_err() {
        let _ = fs::remove_file(&temporary);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: &str = "mcp(novadeck_novadeck/*)";

    #[test]
    fn adds_the_rule_after_the_persons_own() {
        let settings =
            r#"{"permissions":{"allow":["command(ls)",{"odd":1}],"deny":["x"]},"other":1}"#;
        assert_eq!(
            merged(Some(settings), RULE),
            Some(json!({ "permissions": { "allow": ["command(ls)", { "odd": 1 }, RULE] } }))
        );
    }

    #[test]
    fn adds_several_rules_each_once() {
        let settings = r#"{"permissions":{"allow":["command(ls)","command(gh pr create)"]}}"#;
        assert_eq!(
            merged_with(
                Some(settings),
                &[RULE, "command(gh pr create)", "command(gh pr merge)"]
            ),
            Some(json!({ "permissions": { "allow": [
                "command(ls)", "command(gh pr create)", RULE, "command(gh pr merge)"
            ] } }))
        );
    }

    #[test]
    fn gives_the_rule_alone_without_rules_of_the_persons() {
        let alone = Some(json!({ "permissions": { "allow": [RULE] } }));
        assert_eq!(merged(None, RULE), alone);
        assert_eq!(merged(Some("{}"), RULE), alone);
        assert_eq!(
            merged(Some(r#"{"permissions":{"deny":["x"]}}"#), RULE),
            alone
        );
        assert_eq!(
            merged(Some(r#"{"permissions":{"allow":null}}"#), RULE),
            alone
        );
    }

    #[test]
    fn reads_the_persons_rules_behind_a_byte_order_mark() {
        assert_eq!(
            merged(
                Some("\u{feff}{\"permissions\":{\"allow\":[\"command(ls)\"]}}"),
                RULE
            ),
            Some(json!({ "permissions": { "allow": ["command(ls)", RULE] } }))
        );
    }

    #[test]
    fn keeps_a_rule_the_person_has_once() {
        let settings = format!(r#"{{"permissions":{{"allow":["{RULE}"]}}}}"#);
        assert_eq!(
            merged(Some(&settings), RULE),
            Some(json!({ "permissions": { "allow": [RULE] } }))
        );
    }

    #[test]
    fn passes_nothing_where_the_persons_rules_cant_be_read() {
        assert_eq!(merged(Some("{ not json"), RULE), None);
        assert_eq!(
            merged(Some(r#"{"permissions":{"allow":"command(ls)"}}"#), RULE),
            None
        );
        assert_eq!(merged(Some("[]"), RULE), None);
        assert_eq!(merged(Some(r#"{"permissions":5}"#), RULE), None);
    }

    #[test]
    fn writes_the_rules_to_novadecks_file_and_never_the_persons() {
        let root = std::env::temp_dir().join(format!("novadeck-allow-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        let theirs = r#"{"permissions":{"allow":["command(ls)"]}}"#;
        fs::write(&settings, theirs).unwrap();
        let file = root.join("allow").join("terminal.json");
        let read = || serde_json::from_str::<Value>(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(write(&settings, RULE, &file));
        assert_eq!(fs::read_to_string(&settings).unwrap(), theirs);
        assert_eq!(
            read(),
            json!({ "permissions": { "allow": ["command(ls)", RULE] } })
        );
        // No settings of theirs: the rule alone, over what an earlier launch wrote.
        assert!(write(&root.join("missing.json"), RULE, &file));
        assert_eq!(read(), json!({ "permissions": { "allow": [RULE] } }));
        fs::write(&settings, "{ not json").unwrap();
        assert!(!write(&settings, RULE, &file));
        assert_eq!(fs::read_dir(root.join("allow")).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&root);
    }
}
