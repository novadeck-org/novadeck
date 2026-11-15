import { header } from "@novadeck/harness-core/header"
import { cmdAdd, posixAdd } from "@novadeck/harness-core/shim-root"

/**
 * The rule that lets a session run Novadeck's own tools without asking: its plugin's server,
 * every tool of it. Antigravity takes a session's own settings from `--settings` alone, and a
 * `permissions.allow` there replaces the person's from settings.json for the session instead
 * of adding to it; their other permissions (`deny` and the rest) stay theirs. So at each start
 * and resume the shim has Novadeck's relay read their list, never writing it, and write it
 * with this rule added to a file of Novadeck's own, one per terminal in `allowFolder`, which
 * it passes; where their list can't be read it passes nothing, and asks as before. Probed
 * 2026-11-15 (1.5.7 and 1.5.9, e2e/probes/tools-unasked.e2e.ts), with no setting allowing
 * them: a bare session asked before `describe`; with this rule in `--settings` it ran unasked,
 * in plan mode too; with the rule in settings.json and another `--settings` allow list, it
 * asked; with only a `deny` in `--settings` the settings.json allow held; of two `--settings`,
 * the last held. A PreToolUse hook answering "allow" still asked, and `permissionOverrides`
 * only named the asked tool otherwise. A command the person then always allowed, persisted,
 * went to their settings.json alone (`command(echo)` beside their own rule, Novadeck's not
 * written there), the shim's file left as it was, and the next launch passed it on.
 */
export const allowNovadeck = "mcp(novadeck_novadeck/*)"

/**
 * The folder in Novadeck's shell files, beside the shims' own, where the relay writes the rules
 * a launch passes, as `<terminal id>.json`; the runner empties it as it starts.
 */
export const allowFolder = "allow"

// Antigravity's commands other than a session (`agy --help`, 1.5.3), and its options that take a
// value: the word after one is its value, never a command, to the shims and to the runner's
// reading of a command line.
export const commands = [
  "acp",
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

export const valued = [
  "--add-dir",
  "--agent",
  "--conversation",
  "--effort",
  "-i",
  "--input-format",
  "--json-schema",
  "--log-file",
  "--mode",
  "--model",
  "--output-format",
  "--print-timeout",
  "--project",
  "--prompt-interactive",
  "--settings",
  "-v",
]

// On Linux and macOS, while Antigravity is connected, Novadeck's shells run it through this
// shim, which passes --add-dir for the folder where agents' worktrees live, once that exists,
// so a session may write there as in its own folder, under the person's own permission mode,
// and the person's allow rules with Novadeck's own tools added (`allowNovadeck`).
// Its commands, and anything outside Novadeck's shells, run unchanged.
export const posixShim = (root?: string): string => `#!/bin/sh
${header("#", "shim for agy")}
# Runs the real agy with access to the folder where agents' worktrees live, and with
# Novadeck's own tools allowed beside the person's own rules.
${posixAdd(root)}
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
[ -n "\${NOVADECK_TERMINAL_ID:-}" ] || exec "$novadeck_real" "$@"
case " \${NOVADECK_SHIMS:-} " in *" agy "*) ;; *) exec "$novadeck_real" "$@" ;; esac
novadeck_value=
for novadeck_arg in "$@"; do
  if [ -n "$novadeck_value" ]; then
    novadeck_value=
    continue
  fi
  case $novadeck_arg in
    ${valued.join(" | ")}) novadeck_value=1 ;;
    -*) ;;
    ${commands.join(" | ")}) exec "$novadeck_real" "$@" ;;
    *) break ;;
  esac
done
# The person's allow rules with Novadeck's added, read afresh: nothing where they can't be read,
# nor without a home to read them in. The file's path is whole, as agy may change its folder.
novadeck_settings=
if [ -n "\${HOME:-}" ] && novadeck_dir=$(cd "$(dirname "$0")/.." && pwd); then
  novadeck_settings=$novadeck_dir/${allowFolder}/$NOVADECK_TERMINAL_ID.json
  "$novadeck_dir/novadeck-relay" allow "$HOME/.gemini/antigravity-cli/settings.json" '${allowNovadeck}' "$novadeck_settings" >/dev/null 2>&1 ||
    novadeck_settings=
fi
exec "$novadeck_real" \${novadeck_add:+"$novadeck_add"} \${novadeck_settings:+--settings "$novadeck_settings"} "$@"
`

// Where cmd's AutoRun prints, Antigravity's hooks (which it runs as "cmd /c <command>" through
// whatever "cmd" PATH names first; Go does not read ComSpec, and adds no "/d") stand behind
// that output, and no answer reads as JSON. While Antigravity is connected, Novadeck's
// Windows shells run it through this shim, which puts `cmdShimDir` first on PATH for
// Antigravity alone: a folder holding Novadeck's cmd.exe pass-through as "cmd.exe" (see
// backend/relay). That folder reaches everything Antigravity starts, so the pass-through adds
// "/d" only to Novadeck's own hook command ("if defined NOVADECK_HOOK ..."); any other "cmd"
// runs with the arguments it got, AutoRun included, as the person's commands always did.
//
// `where` lists matches in PATH order, this shim included, and the first other runnable one
// wins. `$PATH:` keeps the search to PATH: a plain `where` looks in the current folder first,
// where a cloned repo's `agy.cmd` would be taken for the real one. The folder goes on PATH
// only inside a Novadeck terminal that names this shim (NOVADECK_TERMINAL_ID and
// NOVADECK_SHIMS), and under `setlocal`, so the terminal's shell keeps its PATH. Where cmd's
// AutoRun prints no output of its own there is no folder to put first. Either way it passes
// --add-dir for the folder where agents' worktrees live, once that exists, as the other shims do,
// and the person's allow rules with Novadeck's own tools added, as the POSIX shim does: in a
// file, as cmd would read the quotes of JSON, which the relay writes and says it did by its exit
// code, so nothing it prints is read back through cmd.
export const makeCmdShim = ({
  cmdShimDir,
  root,
}: {
  readonly cmdShimDir?: string | undefined
  readonly root?: string | undefined
}): string => `@echo off
${header("rem", "shim for agy")}
rem Runs the real agy with access to the folder where agents' worktrees live, with Novadeck's own
rem tools allowed beside the person's own rules, and with Novadeck's cmd.exe pass-through first
rem on PATH, for agy alone.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:agy 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo agy: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while Antigravity is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" agy " >nul || goto plain
${cmdAdd(root)}${cmdShimDir === undefined ? "" : `\nset "PATH=${cmdShimDir};%PATH%"`}
set "novadeck_settings=%~dp0..\\${allowFolder}\\%NOVADECK_TERMINAL_ID%.json"
set "novadeck_with="
"%~dp0..\\novadeck-relay.exe" allow "%USERPROFILE%\\.gemini\\antigravity-cli\\settings.json" "${allowNovadeck}" "%novadeck_settings%" >nul 2>nul && set novadeck_with=--settings "%novadeck_settings%"
"%novadeck_real%" %novadeck_add% %novadeck_with% %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for agy" "%~1" >nul && exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`
