import type { Machine } from "@novadeck/harness-core/harness"
import { header } from "@novadeck/harness-core/header"
import { cmdLaunch, posixLaunch } from "@novadeck/harness-core/launch-mark"
import { cmdValue, shQuote } from "@novadeck/harness-core/shim-root"

import { rootsFile } from "./plugin.js"
import { titleSetting } from "./title.js"

// Interactive Codex runs its sessions, and their hooks, in a shared background server
// that knows nothing of the terminal it was started from. While Codex is connected,
// Novadeck's shells run it through this shim, which adds --no-daemon so the session and
// its hook run in the terminal. `codex agents` and --remote need the server, so they go
// unchanged, as does anything outside Novadeck's shells. It also names its terminal
// title's items, so the title tells Novadeck once its prompt shows (`title.ts`), and lets the
// session run Novadeck's own tools without asking (`approveNovadeck`), fresh at every start
// and resume. And once the folder where agents' worktrees live exists, it gives that folder to
// the session to write, as the setting Novadeck wrote for it (`rootsFile`, `rootsSetting`): its
// writable roots with the person's own, ahead of any command (`resume` and `exec` take it too).
// Not as --add-dir, which Codex 0.163.0 and later exit at under a read-only sandbox (its default
// in a folder not yet trusted). Where the person names a profile, which may set roots of its own
// that the setting would replace, it passes none (probed 2026-11-17, e2e/probes/codex-roots.e2e.ts).
// Codex writes what its commands print nowhere Novadeck can read while they run, so where the
// terminal names a folder to capture to (NOVADECK_CAPTURE), the shim has Codex give its commands
// Novadeck's capture (backend/runner/src/shell/capture.ts): on Linux and macOS through the
// environment their shell starts with (BASH_ENV, ZDOTDIR, with the person's own passed on), on
// Windows through Novadeck's PowerShell first on PATH, as Codex finds its shell there. As a
// session starts, with or without --no-daemon, it tells Novadeck so (`posixLaunch`, `cmdLaunch`).

/**
 * What lets a session run Novadeck's own tools without asking, a word for `-c`: its plugin's
 * server approves its tools by default, for this launch alone, written to no file. The key is
 * dotted bare, as the app server's `config/batchWrite` takes it. Probed 2026-11-15 (0.167.0 and
 * 0.169.0, e2e/probes/tools-unasked.e2e.ts), with no setting approving them: a bare session
 * asked before `describe`; with this it ran unasked, with `--sandbox read-only` too; with the
 * key's plugin in TOML's quotes (`plugins."novadeck@novadeck"`) it still asked. It is one plain
 * word, as the title's is, so every shell passes it whole.
 */
export const approveNovadeck =
  "plugins.novadeck@novadeck.mcp_servers.novadeck.default_tools_approval_mode=approve"

/** The setting giving Codex's commands `name` as `value`, a word for `-c`. */
const commandsGet = (name: string, value: string): string =>
  `shell_environment_policy.set.${name}=${value}`

/**
 * What the POSIX shim adds ahead of Codex's own words where the terminal captures: its
 * commands' shell loads the capture, and the person's own BASH_ENV and ZDOTDIR after it. Where
 * the person's Codex config (theirs, or the project's) sets its commands' environment
 * (\`shell_environment_policy\`), which an \`include_only\` or their own BASH_ENV there would
 * fight with, it adds nothing, and their commands go uncaptured.
 * Each value stays a plain string: Codex reads a `-c` value as TOML only where it is TOML.
 */
const posixCapture = (capture: NonNullable<Machine["capture"]>): string => `
# Codex's commands capture what they print where this terminal names a folder for it, unless
# the person's Codex sets its commands' environment itself, which the capture would change.
if [ -n "\${NOVADECK_CAPTURE:-}" ] &&
  ! grep -qs shell_environment_policy "\${CODEX_HOME:-$HOME/.codex}/config.toml" .codex/config.toml; then
  set -- -c ${commandsGet("BASH_ENV", shQuote(capture.bashEnv))} \\
    -c ${commandsGet("ZDOTDIR", shQuote(capture.zdotdir))} \\
    -c "${commandsGet("NOVADECK_CAPTURE", "$NOVADECK_CAPTURE")}" \\
    -c "${commandsGet("NOVADECK_USER_BASH_ENV", "${BASH_ENV:-}")}" \\
    -c "${commandsGet("NOVADECK_USER_ZDOTDIR", "${ZDOTDIR:-}")}" "$@"
fi`

export const posixShim = (root?: string, capture?: Machine["capture"]): string => `#!/bin/sh
${header("#", "shim for codex")}
# Runs the real codex with --no-daemon, so its hooks can tell Novadeck which session runs
# in this terminal, with a title that tells Novadeck once its prompt shows, with Novadeck's
# own tools approved, and with access to the folder where agents' worktrees live.
novadeck_root=${root === undefined ? "" : shQuote(root)}
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
novadeck_roots=
novadeck_file=$(dirname "$0")/../plugins/codex/${rootsFile}
[ -n "$novadeck_root" ] && [ -d "$novadeck_root" ] && [ -f "$novadeck_file" ] &&
  novadeck_roots=$(cat "$novadeck_file")
for novadeck_arg in "$@"; do
  case $novadeck_arg in
    agents | --remote | --remote=*) exec "$novadeck_real" "$@" ;;
    # Already without the shared server: only the title is added.
    --no-daemon) novadeck_daemon= ;;
    # A profile's own roots stand, which the setting would replace.
    -p* | --profile | --profile=*) novadeck_roots= ;;
  esac
done${capture ? posixCapture(capture) : ""}
${posixLaunch("codex")}
exec "$novadeck_real" \${novadeck_daemon:+"$novadeck_daemon"} \${novadeck_roots:+-c} \${novadeck_roots:+"$novadeck_roots"} -c "${titleSetting}" -c ${approveNovadeck} "$@"
`

// `where` lists matches in PATH order, including this shim, and on npm installs an
// extensionless script that only other shells run; the first other runnable one wins.
// `$PATH:` keeps the search to PATH: a plain `where` looks in the current folder first,
// where a cloned repo's `codex.cmd` would be taken for the real one (as Antigravity's shim).
// Its words are walked as Claude Code's are, for the reasons there (`harnesses/claude/src/shim.ts`):
// `for %%a in (%*)` loses its closing bracket to an odd count of quotes, and ends the batch.
// Where Novadeck's PowerShell pass-through is installed, a session's Codex finds it first on
// PATH, and its commands capture through it; `agents` and --remote run as they would. A real
// codex that is itself a batch file, as npm's codex.cmd is, is called: started without `call`
// it would end this one, and with it the `setlocal` that holds PATH, before codex starts (seen
// on CI: Codex ran Microsoft's pwsh). `%%*` hands its words on only at call's second reading,
// after call has doubled the carets of the line, so they arrive as typed. A codex.exe runs as
// before, while this file still holds PATH.
const launchLine = (args: string, pwshShimDir: string | undefined, label: string): string =>
  pwshShimDir === undefined
    ? `"%novadeck_real%" ${args} %*`
    : `set "PATH=${pwshShimDir};%PATH%"
if /i "%novadeck_real:~-4%"==".exe" goto ${label}_exe
call "%novadeck_real%" ${args} %%*
exit /b %ERRORLEVEL%
:${label}_exe
"%novadeck_real%" ${args} %*`

export const cmdShim = (root?: string, pwshShimDir?: string): string => {
  return `@echo off
${header("rem", "shim for codex")}
rem Runs the real codex with --no-daemon, so its hooks can tell Novadeck which session
rem runs in this terminal, with a title that tells Novadeck once its prompt shows, with
rem Novadeck's own tools approved, and with access to the folder where agents' worktrees live.
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
set "novadeck_add="
set "novadeck_roots="
set "novadeck_titled="
${
  root === undefined
    ? ""
    : `set "novadeck_root=${cmdValue(root)}"
set "novadeck_file=%~dp0..\\plugins\\codex\\${rootsFile}"
rem The test with a trailing backslash is one only a directory passes. The setting holds no
rem double quote (\`rootsSetting\`), so it goes whole in one.
if exist "%novadeck_root%\\" if exist "%novadeck_file%" set /p novadeck_roots=<"%novadeck_file%"
if defined novadeck_roots set novadeck_add=-c "%novadeck_roots%"
`
}rem A word that needs the shared server leaves codex alone.
:words
set novadeck_arg=""%1
if "%novadeck_arg:"=#%"=="##" goto session
set "novadeck_arg=%novadeck_arg:"=%"
shift
if /i "%novadeck_arg%"=="agents" goto plain
if /i "%novadeck_arg%"=="--remote" goto plain
rem A profile's own roots stand, which the setting would replace, wherever it is named.
if "%novadeck_arg:~0,2%"=="-p" set "novadeck_add="
if /i "%novadeck_arg%"=="--profile" set "novadeck_add="
if /i "%novadeck_arg%"=="--no-daemon" set "novadeck_titled=1"
goto words
:session
set "novadeck_arg="
if defined novadeck_titled goto titled
${cmdLaunch("codex")}
${launchLine(`--no-daemon %novadeck_add% -c "${titleSetting}" -c ${approveNovadeck}`, pwshShimDir, "session")}
exit /b %ERRORLEVEL%
rem Already without the shared server: only the title is added.
:titled
${cmdLaunch("codex")}
${launchLine(`%novadeck_add% -c "${titleSetting}" -c ${approveNovadeck}`, pwshShimDir, "titled")}
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
}
