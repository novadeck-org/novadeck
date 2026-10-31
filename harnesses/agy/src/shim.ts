import { header } from "@novadeck/harness-core/header"

// Antigravity's commands other than a session (`agy --help`, 1.4.8), which take no settings.
export const commands = [
  "agent",
  "agents",
  "changelog",
  "help",
  "install",
  "mcp",
  "mic-serve",
  "models",
  "plugin",
  "plugins",
  "remote-control",
  "update",
]

// While Antigravity is connected, Novadeck's shells run it through this shim. It changes
// nothing, but where the runner wrote launch settings for this terminal (`narrow/<terminal id>.json`,
// beside the shells' files, only when a grant of the person's covers it as the agent starts or
// resumes): then it passes them as `--settings` and sets NOVADECK_NARROW=1, so Novadeck's hook
// narrows every call (see narrow.ts). Anything outside Novadeck's shells, any of its commands
// other than a session, and any terminal without those settings run unchanged. Never written on
// Windows, which has no shim.
export const posixShim = `#!/bin/sh
${header("#", "shim for agy")}
# Runs the real agy, narrowed where Novadeck's runner wrote launch settings for this terminal.
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/agy
  # Another Novadeck's shim, as from a runner started in a Novadeck terminal, would call
  # this one back: only the program itself counts.
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for agy"; then
    novadeck_real=$novadeck_candidate
    break
  fi
done
set +f
IFS=$novadeck_ifs
if [ -z "$novadeck_real" ]; then
  echo "agy: command not found" >&2
  exit 127
fi
# Narrowing is the runner's alone: a value from outside is never kept.
unset NOVADECK_NARROW
[ -n "\${NOVADECK_TERMINAL_ID:-}" ] || exec "$novadeck_real" "$@"
case " \${NOVADECK_SHIMS:-} " in *" agy "*) ;; *) exec "$novadeck_real" "$@" ;; esac
case $NOVADECK_TERMINAL_ID in *[!A-Za-z0-9_-]*) exec "$novadeck_real" "$@" ;; esac
novadeck_settings=$(dirname "$0")/../narrow/$NOVADECK_TERMINAL_ID.json
[ -f "$novadeck_settings" ] || exec "$novadeck_real" "$@"
for novadeck_arg in "$@"; do
  case $novadeck_arg in
    -*) ;;
    ${commands.join(" | ")}) exec "$novadeck_real" "$@" ;;
    *) break ;;
  esac
done
NOVADECK_NARROW=1
export NOVADECK_NARROW
exec "$novadeck_real" --settings "$novadeck_settings" "$@"
`
