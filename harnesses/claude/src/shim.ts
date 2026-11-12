import { header } from "@novadeck/harness-core/header"
import { cmdAdd, posixAdd } from "@novadeck/harness-core/shim-root"

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
// context, then shows the person's own status line. It also passes --add-dir for the folder
// where agents' worktrees live, once that exists, so the session may write there as in its
// own folder; it never passes a second --settings, which would replace the first.
// Its other commands, and anything outside Novadeck's shells, run unchanged.
export const posixShim = (root?: string): string => `#!/bin/sh
${header("#", "shim for claude")}
# Runs the real claude with Novadeck's status line, which passes on the person's own, and with
# access to the folder where agents' worktrees live.
${posixAdd(root)}
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
[ -f "$novadeck_settings" ] || novadeck_settings=
[ -n "$novadeck_settings$novadeck_add" ] || exec "$novadeck_real" "$@"
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
exec "$novadeck_real" \${novadeck_settings:+--settings "$novadeck_settings"} \${novadeck_add:+"$novadeck_add"} "$@"
`

// The same on Windows, as Codex's (`harnesses/codex/src/shim.ts`): `where` lists matches in PATH
// order, this shim included, and the first other runnable one wins. `$PATH:` keeps the search
// to PATH: a plain `where` looks in the current folder first, where a cloned repo's
// `claude.cmd` would be taken for the real one. Claude Code reads its keys raw, so Ctrl+C
// reaches it as a key and never has cmd ask to end this batch file.
//
// A word of `%*` can hold a lone quote, as cmd doesn't know `\"`: `"say \"hi there\" now"` is
// `"say \"hi` and `there\" now"`, and `"%~1"` then ends the batch with a syntax error. So a word is
// set as it stands, which parses as the line it came from did, and tested once its quotes are gone.
// The empty pair ahead of it keeps that count even and `set` from seeing a bare `/?`, which it would
// answer with its help, and paging at a console. Only the end of the words leaves that pair alone,
// which tells it from an empty word. A `/?` later in `%*` can still reach `set`, which `>nul` quiets.
// And `%*` ends its line: after an odd count of quotes, the rest of that line is in quotes too.
// The walk stays out of a `call`, which reads `%*` a second time: `/?` would print its help, `%~`
// an error, and a `%` could uncover a `&`. `shift` leaves `%*` as it was, for the line that runs it.
export const cmdShim = (root?: string): string => `@echo off
${header("rem", "shim for claude")}
rem Runs the real claude with Novadeck's status line, which passes on the person's own, and with
rem access to the folder where agents' worktrees live.
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
${cmdAdd(root)}
set "novadeck_settings=%~dp0..\\plugins\\claude\\statusline.json"
set "novadeck_with="
if exist "%novadeck_settings%" set novadeck_with=--settings "%novadeck_settings%"
if not defined novadeck_with if not defined novadeck_add goto plain
rem The first word that isn't an option or an option's value may be another command.
:command
set novadeck_arg=""%1
if "%novadeck_arg:"=#%"=="##" goto session
set "novadeck_arg=%novadeck_arg:"=%"
if not defined novadeck_arg goto session
for %%v in (${many.join(" ")}) do if "%novadeck_arg%"=="%%v" goto list
for %%v in (${valued.join(" ")}) do if "%novadeck_arg%"=="%%v" goto value
if "%novadeck_arg:~0,1%"=="-" (
  shift
  goto command
)
for %%c in (${commands.join(" ")}) do if "%novadeck_arg%"=="%%c" goto plain
goto session
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
>nul set novadeck_line=""%*
setlocal enabledelayedexpansion
set "novadeck_after=!novadeck_line:*%novadeck_arg%=!"
if "!novadeck_after:~0,1!"=="=" (
  endlocal
  set "novadeck_line="
  goto command
)
endlocal
set "novadeck_line="
:more
set novadeck_arg=""%1
if "%novadeck_arg:"=#%"=="##" goto session
set "novadeck_arg=%novadeck_arg:"=%"
if defined novadeck_arg if "%novadeck_arg:~0,1%"=="-" if not "%novadeck_arg%"=="-" goto command
shift
goto more
:session
set "novadeck_arg="
"%novadeck_real%" %novadeck_with% %novadeck_add% %*
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
`
