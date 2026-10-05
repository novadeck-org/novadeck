import { header } from "../../shell/header.js"

// Claude Code's commands other than a session, which a status line has no part in.
const commands = [
  "agents",
  "attach",
  "auth",
  "auto-mode",
  "doctor",
  "gateway",
  "import",
  "install",
  "kill",
  "logs",
  "mcp",
  "plugin",
  "plugins",
  "project",
  "respawn",
  "rm",
  "setup-token",
  "stop",
  "ultrareview",
  "update",
  "upgrade",
]

// While Claude Code is connected, Novadeck's shells run it through this shim, which adds
// Novadeck's settings: a status line that tells Novadeck the session's rate limits and
// context, then shows the person's own status line. Its other commands, and anything
// outside Novadeck's shells, run unchanged.
export const posixShim = `#!/bin/sh
${header("#", "shim for claude")}
# Runs the real claude with Novadeck's status line, which passes on the person's own.
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/claude
  # Another Novadeck's shim, as from a runner started in a Novadeck terminal, would call
  # this one back: only the program itself counts.
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for claude"; then
    novadeck_real=$novadeck_candidate
    break
  fi
done
set +f
IFS=$novadeck_ifs
if [ -z "$novadeck_real" ]; then
  echo "claude: command not found" >&2
  exit 127
fi
[ -n "\${NOVADECK_TERMINAL_ID:-}" ] || exec "$novadeck_real" "$@"
case " \${NOVADECK_SHIMS:-} " in *" claude "*) ;; *) exec "$novadeck_real" "$@" ;; esac
novadeck_settings=$(dirname "$0")/../plugins/claude/statusline.json
[ -f "$novadeck_settings" ] || exec "$novadeck_real" "$@"
for novadeck_arg in "$@"; do
  case $novadeck_arg in
    -*) ;;
    ${commands.join(" | ")}) exec "$novadeck_real" "$@" ;;
    *) break ;;
  esac
done
exec "$novadeck_real" --settings "$novadeck_settings" "$@"
`
