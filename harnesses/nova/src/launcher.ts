import { header } from "@novadeck/harness-core/header"
import { cmdLaunch, posixLaunch } from "@novadeck/harness-core/launch-mark"

import { novaService } from "./model.js"

/**
 * Nova, which its launcher starts: the pinned pi (`pin.ts`) that Novadeck
 * downloads into its own data folder (the runner's harnesses/nova.ts), apart from the
 * person's pi on PATH, which pi's shim starts and these files leave as it is.
 */
export type NovaFiles = {
  /** Its program, once in place. */
  readonly program: string
  /** Its agent folder, pi's `PI_CODING_AGENT_DIR`: Novadeck's, never the person's `~/.pi/agent`. */
  readonly home: string
  /** Novadeck's relay, which has the runner fetch the program where it isn't in place yet. */
  readonly relay: string
  /** Novadeck's extension, as the shim gives the person's pi. */
  readonly extension: string
}

/**
 * The word a command line starts Nova with, in place of its launcher's path: the runner stores
 * and compares commands with it, and turns it into the launcher's path, in the form the
 * terminal's shell runs (`programWord`, `novaStartup`), as the shell starts the command. It is
 * Novadeck's own and on no PATH, so no program a person runs (another `nova`, say) is ever
 * taken for it; agent `pi` is its agent.
 */
export const novaProgram = "novadeck-nova"

/**
 * Says to Novadeck's extension that it runs in Nova: what it writes for the
 * person's pi (the models their picker offers) it leaves alone.
 */
export const novaMark = "NOVADECK_NOVA"

/**
 * The field the extension adds to each hook's payload in Nova: the runner counts
 * such a report's agent as connected, as Novadeck launched it with its extension, whether or not
 * the person connected their own pi.
 */
export const novaField = "novadeck_nova"

/** Whether a hook's payload comes from Nova (`novaField`). */
export const fromNova = (payload: { readonly [key: string]: unknown }): boolean =>
  payload[novaField] === true

/**
 * The tools Nova starts with on Windows where it finds no bash: pi's `powershell` in
 * place of its `bash`, which there runs only through Git Bash or another bash on PATH, and fails
 * without one (docs/windows.md, 1.6.0: it doesn't fall back by itself). For that launch alone,
 * on its command line; its `!` commands still need a bash.
 */
export const powershellTools = ["--tools", "-bash,+powershell"] as const

// A path in single quotes, for sh.
const quoted = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`

/**
 * The launcher for Linux and macOS: asks the runner for the program each time
 * (`novadeck-relay fetch nova`), which refuses while Nova is switched off in Preferences >
 * Experimental, answers at once when it is in place, and otherwise fetches it, the relay showing
 * the progress. The relay prints the variables of Nova's model service the runner gives every
 * Nova (the ticket the runner's Novas share), one `NAME=value` a line, and only the service's two are taken (`novaService`). Then it starts the
 * program with Novadeck's extension and its own agent folder, with pi's check for a newer version
 * off, as Novadeck pins the version. Novadeck types its path, and `nova` on the PATH of Novadeck's
 * terminals starts it while Nova is on (`novaShim`).
 */
export const posixLauncher = (pi: NovaFiles): string => `#!/bin/sh
${header("#", "launcher for Nova")}
# Starts Nova once the runner says it is on and in place, fetching it first.
novadeck_program=${quoted(pi.program)}
novadeck_service=$(${quoted(pi.relay)} fetch nova) || exit 1
while IFS= read -r novadeck_line; do
  case "$novadeck_line" in
    ${novaService.baseUrl}=*|${novaService.key}=*) export "$novadeck_line" ;;
  esac
done <<novadeck_end
$novadeck_service
novadeck_end
PI_CODING_AGENT_DIR=${quoted(pi.home)}
PI_SKIP_VERSION_CHECK=1
${novaMark}=1
export PI_CODING_AGENT_DIR PI_SKIP_VERSION_CHECK ${novaMark}
[ -f ${quoted(pi.extension)} ] || exec "$novadeck_program" "$@"
${posixLaunch("pi")}
exec "$novadeck_program" -e ${quoted(pi.extension)} "$@"
`

/**
 * The launcher for Windows, as the POSIX one, which also gives pi `powershellTools` where pi
 * would find no bash of Windows' own, looking where pi looks, in its order (docs/windows.md,
 * 1.6.0): Git Bash in Program Files, then in Program Files (x86), then `bash.exe` on PATH
 * (`$PATH:`, so not the current folder, which pi doesn't search), but for WSL's launchers in
 * System32 and WindowsApps, which pi would take, and which run the agent's commands in Linux,
 * where the project's Windows paths don't hold: told by the name of the folder holding it
 * (`"%%~dpb."`, its folder with no trailing separator), whatever form its path takes. No `if (...)` blocks hold a path: a ")" in
 * "Program Files (x86)" would end them (a `for` variable's value is put in after a line is read,
 * so one doesn't).
 */
// A path as cmd reads it in a batch file, in double quotes: a `%` doubled, so no variable is
// read in it; `call` reads its line twice, so a path it runs takes four (`called`).
const cmdPath = (path: string, called = false): string =>
  path.replaceAll("%", called ? "%%%%" : "%%")

export const cmdLauncher = (pi: NovaFiles): string => `@echo off
${header("rem", "launcher for Nova")}
rem Starts Nova once the runner says it is on and in place, fetching it first.
setlocal
set "novadeck_program=${cmdPath(pi.program)}"
set "novadeck_service=%TEMP%\\novadeck-nova-%NOVADECK_TERMINAL_ID%-%RANDOM%%RANDOM%.env"
call "${cmdPath(pi.relay, true)}" fetch nova >"%novadeck_service%"
if errorlevel 1 goto failed
for /f "usebackq tokens=1* delims==" %%a in ("%novadeck_service%") do call :service "%%a" "%%b"
del "%novadeck_service%" 2>nul
set "novadeck_service="
set "PI_CODING_AGENT_DIR=${cmdPath(pi.home)}"
set "PI_SKIP_VERSION_CHECK=1"
set "${novaMark}=1"
set "novadeck_tools="
if exist "%ProgramFiles%\\Git\\bin\\bash.exe" goto tools
if exist "%ProgramFiles(x86)%\\Git\\bin\\bash.exe" goto tools
for /f "delims=" %%b in ('where $PATH:bash.exe 2^>nul') do for %%d in ("%%~dpb.") do if /i not "%%~nxd"=="System32" if /i not "%%~nxd"=="WindowsApps" goto tools
set "novadeck_tools=${powershellTools.join(" ")}"
:tools
if not exist "${cmdPath(pi.extension)}" goto plain
${cmdLaunch("pi")}
"%novadeck_program%" -e "${cmdPath(pi.extension)}" %novadeck_tools% %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_program%" %novadeck_tools% %*
exit /b %ERRORLEVEL%
:failed
del "%novadeck_service%" 2>nul
exit /b 1
rem Takes the model service's two variables alone of what the runner gave.
:service
if "%~1"=="${novaService.baseUrl}" set "${novaService.baseUrl}=%~2"
if "%~1"=="${novaService.key}" set "${novaService.key}=%~2"
exit /b 0
`

/** The command Nova is on the PATH of Novadeck's terminals: its shim, in the shims' folder. */
export const novaCommand = "nova"

/** What a launch of Nova while it is switched off says (the runner's refusal, too). */
export const turnOnLine = "Turn on Nova in Preferences > Experimental."

/** Where `nova` finds Nova's launcher, and the file that says Nova is switched on. */
export type NovaShimPaths = {
  /** Nova's launcher (`novaLauncher`), under the shell folder's `nova` folder. */
  readonly launcher: string
  /** The file the runner keeps while Nova is switched on, and removes when it is switched off. */
  readonly on: string
}

/**
 * `nova` for Linux and macOS: Nova's launcher while Nova is switched on (`on`); while it is off,
 * another program named `nova` on PATH, as it would run without Novadeck (Panic's Nova, OpenStack's
 * client), or, with none, what turns Nova on.
 */
export const posixNovaShim = ({ launcher, on }: NovaShimPaths): string => `#!/bin/sh
${header("#", "shim for nova")}
# Starts Nova while it is switched on; otherwise another nova, as it would run.
[ -f ${quoted(on)} ] && exec ${quoted(launcher)} "$@"
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/nova
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for nova"; then
    exec "$novadeck_candidate" "$@"
  fi
done
echo "${turnOnLine}" >&2
exit 1
`

/**
 * `nova` for Windows, as the POSIX one: `where` lists the matches in PATH order, this shim among
 * them, and the first other runnable one that isn't another Novadeck's shim wins. No `if (...)`
 * block holds a path: a ")" in "Program Files (x86)" would end it.
 */
export const cmdNovaShim = ({ launcher, on }: NovaShimPaths): string => `@echo off
${header("rem", "shim for nova")}
rem Starts Nova while it is switched on; otherwise another nova, as it would run.
setlocal
if exist "${cmdPath(on)}" goto nova
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:nova 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real goto off
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:nova
"${cmdPath(launcher)}" %*
exit /b %ERRORLEVEL%
:off
echo ${turnOnLine.replace(">", "^>")} 1>&2
exit /b 1
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for nova" "%~1" >nul && exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`

/** `nova`'s file for `platform`, in the shims' folder, first on PATH in Novadeck's terminals. */
export const novaShim = (
  platform: NodeJS.Platform,
  paths: NovaShimPaths,
): { readonly path: string; readonly content: string; readonly mode?: number } =>
  platform === "win32"
    ? { path: `${novaCommand}.cmd`, content: cmdNovaShim(paths) }
    : { path: novaCommand, content: posixNovaShim(paths), mode: 0o700 }

/** The launcher's file for `platform`, under the shell folder's `nova` folder. */
export const novaLauncher = (
  platform: NodeJS.Platform,
  pi: NovaFiles,
): { readonly path: string; readonly content: string; readonly mode?: number } =>
  platform === "win32"
    ? { path: "nova.cmd", content: cmdLauncher(pi) }
    : { path: "nova", content: posixLauncher(pi), mode: 0o700 }
