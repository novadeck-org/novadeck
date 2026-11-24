import type { Harness } from "@novadeck/harness-core/harness"
import { header } from "@novadeck/harness-core/header"
import type { KeptFlags } from "@novadeck/harness-core/kept-flags"
import { cmdLaunch, posixLaunch } from "@novadeck/harness-core/launch-mark"

import { extensionFile } from "./plugin.js"

/**
 * pi's commands other than a session, which it reads as the first word alone
 * (src/main.ts:170,659 and src/package-manager-cli.ts of its coding-agent package, 1.6.0): its
 * package manager's, its configuration's, its logins' and its MCP servers'.
 */
export const commands: readonly string[] = [
  "install",
  "remove",
  "uninstall",
  "update",
  "list",
  "config",
  "auth",
  "mcp",
]

/** Its help, version, listing and export flags, anywhere: they start no session. */
export const info: readonly string[] = [
  "-h",
  "--help",
  "-v",
  "--version",
  "--list-models",
  "--export",
]

/** Its options that take a value (src/cli/args.ts, 1.6.0): the word after one is its value. */
export const valued: readonly string[] = [
  "--mode",
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "-n",
  "--name",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "-t",
  "--tools",
  "-xt",
  "--exclude-tools",
  "--thinking",
  "-e",
  "--extension",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--tui-mode",
]

/** Its print flags: such a run answers once and exits, no session of the terminal's. */
export const print: readonly string[] = ["-p", "--print"]

// The modes that print, as `--mode` names them: its JSON events and its RPC protocol.
const printModes = ["json", "rpc"]

/**
 * Where the extension sits: `plugins/pi` in the folder that holds the shim's own `bin` (the
 * runner writes the extension to <shell dir>/plugins/pi and the shim to <shell dir>/bin).
 */
const pluginFolder = "plugins/pi"

/**
 * A shim that runs the real pi with Novadeck's extension loaded for this launch alone: `-e` with
 * its path, before the person's own words. pi loads it beside the person's own extensions,
 * settings, MCP servers and sessions, which stay as they are (probed 2026-11-24, 1.6.0): nothing of
 * theirs is written, and pi's own folder is never moved (`PI_CODING_AGENT_DIR` is theirs alone).
 * Its other commands, help, version, and its print runs go to pi as they are.
 */
export const posixShim = (): string => `#!/bin/sh
${header("#", "shim for pi")}
# Runs the real pi with Novadeck's extension loaded for this launch.
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/pi
  # Another Novadeck's shim, as from a runner started in a Novadeck terminal, would call
  # this one back: only the program itself counts.
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for pi"; then
    novadeck_real=$novadeck_candidate
    break
  fi
done
set +f
IFS=$novadeck_ifs
if [ -z "$novadeck_real" ]; then
  echo "pi: command not found" >&2
  exit 127
fi
[ -n "\${NOVADECK_TERMINAL_ID:-}" ] || exec "$novadeck_real" "$@"
case " \${NOVADECK_SHIMS:-} " in *" pi "*) ;; *) exec "$novadeck_real" "$@" ;; esac
# pi reads its commands as the first word alone.
case \${1:-} in
  ${commands.join(" | ")}) exec "$novadeck_real" "$@" ;;
esac
novadeck_value=
for novadeck_arg in "$@"; do
  if [ -n "$novadeck_value" ]; then
    if [ "$novadeck_value" = mode ]; then
      case $novadeck_arg in ${printModes.join(" | ")}) exec "$novadeck_real" "$@" ;; esac
    fi
    novadeck_value=
    continue
  fi
  case $novadeck_arg in
    --) break ;;
    ${info.join(" | ")}) exec "$novadeck_real" "$@" ;;
    ${print.join(" | ")}) exec "$novadeck_real" "$@" ;;
    --mode) novadeck_value=mode ;;
    ${valued.filter((flag) => flag !== "--mode").join(" | ")}) novadeck_value=1 ;;
  esac
done
# The extension, from this file's own place; pi as it is if it isn't there.
novadeck_extension=
if novadeck_dir=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) && [ -f "$novadeck_dir/${pluginFolder}/${extensionFile}" ]; then
  novadeck_extension=$novadeck_dir/${pluginFolder}/${extensionFile}
fi
[ -n "$novadeck_extension" ] || exec "$novadeck_real" "$@"
${posixLaunch("pi")}
exec "$novadeck_real" -e "$novadeck_extension" "$@"
`

// `where` lists matches in PATH order, this shim included, and the first other runnable one wins
// (as opencode's shim: `$PATH:` keeps the search to PATH). The words are walked with shift, which
// leaves %* whole, so they go to pi as they came; %~dp0 is kept first, as each shift moves %0.
// No `if (...)` blocks are used where a path goes: a ")" in "Program Files (x86)" would end them.
export const makeCmdShim = (): string => `@echo off
${header("rem", "shim for pi")}
rem Runs the real pi with Novadeck's extension loaded for this launch.
setlocal
set "novadeck_here=%~dp0"
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:pi 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo pi: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while pi is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" pi " >nul || goto plain
rem pi reads its commands as the first word alone.
for %%c in (${commands.join(" ")}) do if "%~1"=="%%c" goto plain
:walk
set novadeck_arg=""%1
if "%novadeck_arg:"=#%"=="##" goto session
set "novadeck_arg=%novadeck_arg:"=%"
if not defined novadeck_arg goto session
if "%novadeck_arg%"=="--" goto session
for %%h in (${[...info, ...print].join(" ")}) do if "%novadeck_arg%"=="%%h" goto plain
if "%novadeck_arg%"=="--mode" goto mode
for %%v in (${valued.filter((flag) => flag !== "--mode").join(" ")}) do if "%novadeck_arg%"=="%%v" goto value
shift
goto walk
:mode
for %%m in (${printModes.join(" ")}) do if "%~2"=="%%m" goto plain
:value
shift
shift
goto walk
:session
for %%i in ("%novadeck_here%..\\${pluginFolder.replaceAll("/", "\\")}\\${extensionFile}") do set "novadeck_extension=%%~fi"
if not exist "%novadeck_extension%" goto plain
${cmdLaunch("pi")}
"%novadeck_real%" -e "%novadeck_extension%" %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for pi" "%~1" >nul && exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`

/** Its shims: a POSIX shell script, or on Windows a batch file, put first on PATH. */
export const shims: NonNullable<Harness["shims"]> = (platform) =>
  platform !== "win32"
    ? [{ path: "pi", content: posixShim(), mode: 0o700 }]
    : [{ path: "pi.cmd", content: makeCmdShim() }]

/**
 * What a resume carries over. pi's session brings back its model and thinking level itself
 * (docs/models.md: "Resuming the session restores them"; its `model_change` and
 * `thinking_level_change` records), so neither is given back. Its tool selection, MCP, extension
 * and project-trust flags are the command line's alone, never stored, so they are.
 */
export const kept: KeptFlags = {
  valued: { "--model": "--model", "--thinking": "--thinking" },
  bare: {
    "--no-tools": "--no-tools",
    "-nt": "--no-tools",
    "--no-builtin-tools": "--no-builtin-tools",
    "-nbt": "--no-builtin-tools",
    "--no-mcp": "--no-mcp",
    "--no-extensions": "--no-extensions",
    "-ne": "--no-extensions",
    "--approve": "--approve",
    "-a": "--approve",
    "--no-approve": "--no-approve",
    "-na": "--no-approve",
    "--offline": "--offline",
  },
  forgets: [
    "--no-tools",
    "--no-builtin-tools",
    "--no-mcp",
    "--no-extensions",
    "--approve",
    "--no-approve",
    "--offline",
  ],
  takesValue: valued,
  takesMany: [],
  print,
  sets: (flag) => (flag === "--model" ? "model" : flag === "--thinking" ? "effort" : undefined),
}
