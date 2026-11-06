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

// Its options that take a value, as 2.1.318's `--help` lists them: the word after one is its
// value, never a command, to this shim and to the runner's reading of a command line.
export const valued = [
  "--add-dir",
  "--agent",
  "--agents",
  "--allowed-tools",
  "--allowedTools",
  "--append-system-prompt",
  "--autocompact",
  "--betas",
  "--debug-file",
  "--disallowed-tools",
  "--disallowedTools",
  "--effort",
  "--environment",
  "--fallback-model",
  "--file",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "-n",
  "--name",
  "--output-format",
  "--permission-mode",
  "--permission-prompts",
  "--plugin-dir",
  "--plugin-url",
  "--remote-control-session-name-prefix",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--system-prompt-snapshot",
  "--tools",
]

// Those of them that take a list, as `<directories...>` in 2.1.316's `--help`: more words are
// theirs up to the next option. A lone `-` is a value and `--add-dir=a` takes that one only.
export const many = [
  "--add-dir",
  "--allowed-tools",
  "--allowedTools",
  "--betas",
  "--disallowed-tools",
  "--disallowedTools",
  "--file",
  "--mcp-config",
  "--tools",
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
novadeck_value=
novadeck_list=
for novadeck_arg in "$@"; do
  if [ -n "$novadeck_value" ]; then
    novadeck_value=
    continue
  fi
  if [ -n "$novadeck_list" ]; then
    case $novadeck_arg in
      -?*) novadeck_list= ;;
      *) continue ;;
    esac
  fi
  case $novadeck_arg in
    ${many.join(" | ")}) novadeck_value=1 novadeck_list=1 ;;
    ${valued.join(" | ")}) novadeck_value=1 ;;
    -*) ;;
    ${commands.join(" | ")}) exec "$novadeck_real" "$@" ;;
    *) break ;;
  esac
done
exec "$novadeck_real" --settings "$novadeck_settings" "$@"
`

// The same on Windows, as Codex's (`harnesses/codex/src/shim.ts`): `where` lists matches in PATH
// order, this shim included, and the first other runnable one wins. `$PATH:` keeps the search
// to PATH: a plain `where` looks in the current folder first, where a cloned repo's
// `claude.cmd` would be taken for the real one. Claude Code reads its keys raw, so Ctrl+C
// reaches it as a key and never has cmd ask to end this batch file.
export const cmdShim = `@echo off
${header("rem", "shim for claude")}
rem Runs the real claude with Novadeck's status line, which passes on the person's own.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:claude 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo claude: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while Claude Code is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" claude " >nul || goto plain
set "novadeck_settings=%~dp0..\\plugins\\claude\\statusline.json"
if not exist "%novadeck_settings%" goto plain
rem Set beside the line that runs claude, the line as typed parses as that one does.
set novadeck_line=%*
call :command %* && (
  set "novadeck_line="
  goto plain
)
set "novadeck_line="
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
rem Succeeds where the first argument that isn't an option, or an option's value, is another
rem of its commands.
:command
if "%~1"=="" exit /b 1
set "novadeck_arg=%~1"
for %%v in (${many.join(" ")}) do if "%novadeck_arg%"=="%%v" goto list
for %%v in (${valued.join(" ")}) do if "%novadeck_arg%"=="%%v" goto value
if "%novadeck_arg:~0,1%"=="-" (
  shift
  goto command
)
for %%c in (${commands.join(" ")}) do if "%novadeck_arg%"=="%%c" exit /b 0
exit /b 1
:value
shift
shift
goto command
rem cmd splits a word at =, so --add-dir=a arrives as two, and that form takes one value: only
rem the line as typed tells it from --add-dir a, read delayed so that no quote in it can expose
rem a command separator. That is the option's first mention, and cmd splits its value at a comma
rem too: where either misleads, a session goes without the status line, or a command gets one.
:list
shift
shift
setlocal enabledelayedexpansion
set "novadeck_after=!novadeck_line:*%novadeck_arg%=!"
if "!novadeck_after:~0,1!"=="=" (
  endlocal
  goto command
)
endlocal
:more
if "%~1"=="" exit /b 1
set "novadeck_arg=%~1"
if "%novadeck_arg:~0,1%"=="-" if not "%novadeck_arg%"=="-" goto command
shift
goto more
`
