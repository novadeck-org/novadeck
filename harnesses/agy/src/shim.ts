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
// other than a session, and any terminal without those settings run unchanged.
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

// The same on Windows, as Claude Code's (`harnesses/claude/src/shim.ts`): `where` lists matches in
// PATH order, this shim included, and the first other runnable one wins. The terminal's id names
// its settings file, so it is read through `set`, which prints a value without cmd reading it
// again, and only an id of plain characters counts. Everything set here is local (`setlocal`),
// so NOVADECK_NARROW reaches Antigravity alone.
export const cmdShim = `@echo off
${header("rem", "shim for agy")}
rem Runs the real agy, narrowed where Novadeck's runner wrote launch settings for this terminal.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where agy 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo agy: command not found 1>&2
  exit /b 9009
)
rem Narrowing is the runner's alone: a value from outside is never kept.
set "NOVADECK_NARROW="
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while Antigravity is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" agy " >nul || goto plain
set NOVADECK_TERMINAL_ID | findstr /r /x /c:"NOVADECK_TERMINAL_ID=[A-Za-z0-9_-][A-Za-z0-9_-]*" >nul || goto plain
set "novadeck_settings=%~dp0..\\narrow\\%NOVADECK_TERMINAL_ID%.json"
if not exist "%novadeck_settings%" goto plain
call :command %* && goto plain
set "NOVADECK_NARROW=1"
"%novadeck_real%" --settings "%novadeck_settings%" %*
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
rem Succeeds where the first argument that isn't an option is another of its commands.
:command
if "%~1"=="" exit /b 1
set "novadeck_arg=%~1"
if "%novadeck_arg:~0,1%"=="-" (
  shift
  goto command
)
for %%c in (${commands.join(" ")}) do if /i "%novadeck_arg%"=="%%c" exit /b 0
exit /b 1
`
