import { header } from "@novadeck/harness-core/header"

// Claude Code's commands other than a session, which a status line has no part in.
export const commands = [
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
  "purge",
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

// The same on Windows, as Codex's (`harnesses/codex/src/shim.ts`): `where` lists matches in PATH
// order, this shim included, and the first other runnable one wins. Claude Code reads its
// keys raw, so Ctrl+C reaches it as a key and never has cmd ask to end this batch file.
export const cmdShim = `@echo off
${header("rem", "shim for claude")}
rem Runs the real claude with Novadeck's status line, which passes on the person's own.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where claude 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo claude: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while Claude Code is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" claude " >nul || goto plain
set "novadeck_settings=%~dp0..\\plugins\\claude\\statusline.json"
if not exist "%novadeck_settings%" goto plain
call :command %* && goto plain
"%novadeck_real%" --settings "%novadeck_settings%" %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for claude" "%~1" >nul && exit /b
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
