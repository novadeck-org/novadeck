import { header } from "@novadeck/harness-core/header"
import { cmdAdd, posixAdd } from "@novadeck/harness-core/shim-root"

import { titleSetting } from "./title.js"

// Interactive Codex runs its sessions, and their hooks, in a shared background server
// that knows nothing of the terminal it was started from. While Codex is connected,
// Novadeck's shells run it through this shim, which adds --no-daemon so the session and
// its hook run in the terminal. `codex agents` and --remote need the server, so they go
// unchanged, as does anything outside Novadeck's shells. It also names its terminal
// title's items, so the title tells Novadeck once its prompt shows (`title.ts`). And it passes
// --add-dir for the folder where agents' worktrees live, once that exists, which Codex adds to
// its writable roots; the option goes ahead of any command (`resume` and `exec` take it too).
export const posixShim = (root?: string): string => `#!/bin/sh
${header("#", "shim for codex")}
# Runs the real codex with --no-daemon, so its hooks can tell Novadeck which session runs
# in this terminal, with a title that tells Novadeck once its prompt shows, and with access to
# the folder where agents' worktrees live.
${posixAdd(root)}
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/codex
  # Another Novadeck's shim, as from a runner started in a Novadeck terminal, would call
  # this one back: only the program itself counts.
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for codex"; then
    novadeck_real=$novadeck_candidate
    break
  fi
done
set +f
IFS=$novadeck_ifs
if [ -z "$novadeck_real" ]; then
  echo "codex: command not found" >&2
  exit 127
fi
[ -n "\${NOVADECK_TERMINAL_ID:-}" ] || exec "$novadeck_real" "$@"
# Only while Codex is connected: Novadeck's shells name the harnesses whose shims apply.
case " \${NOVADECK_SHIMS:-} " in *" codex "*) ;; *) exec "$novadeck_real" "$@" ;; esac
novadeck_daemon=--no-daemon
for novadeck_arg in "$@"; do
  case $novadeck_arg in
    agents | --remote | --remote=*) exec "$novadeck_real" "$@" ;;
    # Already without the shared server: only the title is added.
    --no-daemon) novadeck_daemon= ;;
  esac
done
exec "$novadeck_real" \${novadeck_daemon:+"$novadeck_daemon"} \${novadeck_add:+"$novadeck_add"} -c "${titleSetting}" "$@"
`

// `where` lists matches in PATH order, including this shim, and on npm installs an
// extensionless script that only other shells run; the first other runnable one wins.
// `$PATH:` keeps the search to PATH: a plain `where` looks in the current folder first,
// where a cloned repo's `codex.cmd` would be taken for the real one (as Antigravity's shim).
// Its words are walked as Claude Code's are, for the reasons there (`harnesses/claude/src/shim.ts`):
// `for %%a in (%*)` loses its closing bracket to an odd count of quotes, and ends the batch.
export const cmdShim = (root?: string): string => `@echo off
${header("rem", "shim for codex")}
rem Runs the real codex with --no-daemon, so its hooks can tell Novadeck which session
rem runs in this terminal, with a title that tells Novadeck once its prompt shows, and with
rem access to the folder where agents' worktrees live.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:codex 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo codex: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while Codex is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" codex " >nul || goto plain
${cmdAdd(root)}
rem A word that needs the shared server leaves codex alone.
:words
set novadeck_arg=""%1
if "%novadeck_arg:"=#%"=="##" goto session
set "novadeck_arg=%novadeck_arg:"=%"
shift
if /i "%novadeck_arg%"=="agents" goto plain
if /i "%novadeck_arg%"=="--remote" goto plain
if /i "%novadeck_arg%"=="--no-daemon" goto titled
goto words
:session
set "novadeck_arg="
"%novadeck_real%" --no-daemon %novadeck_add% -c "${titleSetting}" %*
exit /b %ERRORLEVEL%
rem Already without the shared server: only the title is added.
:titled
"%novadeck_real%" %novadeck_add% -c "${titleSetting}" %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for codex" "%~1" >nul && exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`
