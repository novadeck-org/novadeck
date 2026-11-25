import { header } from "@novadeck/harness-core/header"
import { cmdLaunch, posixLaunch } from "@novadeck/harness-core/launch-mark"

/**
 * Novadeck's own pi (backend/runner's harnesses/bundled-pi.ts), which its launcher starts: a pinned pi
 * that Novadeck downloads into its own data folder, apart from the person's pi on PATH, which
 * the shim starts and these files leave as it is.
 */
export type BundledPi = {
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
 * The word a command line starts Novadeck's own pi with, in place of its launcher's path: the
 * runner stores and compares commands with it, and turns it into the launcher's path, in the
 * form the terminal's shell runs (`programWord`), as the shell starts the command. It is on no
 * PATH, so a person who types it runs nothing; agent `pi` is its agent.
 */
export const ownProgram = "novadeck-pi"

/**
 * Says to Novadeck's extension that it runs in Novadeck's own pi: what it writes for the
 * person's pi (the models their picker offers) it leaves alone.
 */
export const bundledMark = "NOVADECK_PI"

/**
 * The field the extension adds to each hook's payload in Novadeck's own pi: the runner counts
 * such a report's agent as connected, as Novadeck launched it with its extension, whether or not
 * the person connected their own pi.
 */
export const ownField = "novadeck_own"

/** Whether a hook's payload comes from Novadeck's own pi (`ownField`). */
export const fromOwnPi = (payload: { readonly [key: string]: unknown }): boolean =>
  payload[ownField] === true

/**
 * The tools Novadeck's pi starts with on Windows where it finds no bash: pi's `powershell` in
 * place of its `bash`, which there runs only through Git Bash or another bash on PATH, and fails
 * without one (docs/windows.md, 1.6.0: it doesn't fall back by itself). For that launch alone,
 * on its command line; its `!` commands still need a bash.
 */
export const powershellTools = ["--tools", "-bash,+powershell"] as const

// A path in single quotes, for sh.
const quoted = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`

/**
 * The launcher for Linux and macOS: asks the runner for the program each time
 * (`novadeck-relay fetch pi`), which refuses while Novadeck's pi is switched off in Preferences >
 * Experimental, answers at once when it is in place, and otherwise fetches it, the relay showing
 * the progress. Then it starts it with Novadeck's extension and its own agent folder, with pi's
 * check for a newer version off, as Novadeck pins the version. Not on PATH: Novadeck types its path.
 */
export const posixLauncher = (pi: BundledPi): string => `#!/bin/sh
${header("#", "launcher for its own pi")}
# Starts Novadeck's own pi once the runner says it is on and in place, fetching it first.
novadeck_program=${quoted(pi.program)}
${quoted(pi.relay)} fetch pi || exit 1
PI_CODING_AGENT_DIR=${quoted(pi.home)}
PI_SKIP_VERSION_CHECK=1
${bundledMark}=bundled
export PI_CODING_AGENT_DIR PI_SKIP_VERSION_CHECK ${bundledMark}
[ -f ${quoted(pi.extension)} ] || exec "$novadeck_program" "$@"
${posixLaunch("pi")}
exec "$novadeck_program" -e ${quoted(pi.extension)} "$@"
`

/**
 * The launcher for Windows, as the POSIX one, which also gives pi `powershellTools` where pi
 * would find no bash, looking where pi looks, in its order (docs/windows.md, 1.6.0): Git
 * Bash in Program Files, then in Program Files (x86), then `bash.exe` on PATH (`$PATH:`, so not
 * the current folder, which pi doesn't search). No `if (...)`
 * blocks hold a path: a ")" in "Program Files (x86)" would end them.
 */
// A path as cmd reads it in a batch file, in double quotes: a `%` doubled, so no variable is
// read in it; `call` reads its line twice, so a path it runs takes four (`called`).
const cmdPath = (path: string, called = false): string =>
  path.replaceAll("%", called ? "%%%%" : "%%")

export const cmdLauncher = (pi: BundledPi): string => `@echo off
${header("rem", "launcher for its own pi")}
rem Starts Novadeck's own pi once the runner says it is on and in place, fetching it first.
setlocal
set "novadeck_program=${cmdPath(pi.program)}"
call "${cmdPath(pi.relay, true)}" fetch pi || exit /b 1
set "PI_CODING_AGENT_DIR=${cmdPath(pi.home)}"
set "PI_SKIP_VERSION_CHECK=1"
set "${bundledMark}=bundled"
set "novadeck_tools="
if exist "%ProgramFiles%\\Git\\bin\\bash.exe" goto tools
if exist "%ProgramFiles(x86)%\\Git\\bin\\bash.exe" goto tools
where $PATH:bash.exe >nul 2>nul && goto tools
set "novadeck_tools=${powershellTools.join(" ")}"
:tools
if not exist "${cmdPath(pi.extension)}" goto plain
${cmdLaunch("pi")}
"%novadeck_program%" -e "${cmdPath(pi.extension)}" %novadeck_tools% %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_program%" %novadeck_tools% %*
exit /b %ERRORLEVEL%
`

/** The launcher's file for `platform`, under the shell folder's `bundled` folder. */
export const bundledLauncher = (
  platform: NodeJS.Platform,
  pi: BundledPi,
): { readonly path: string; readonly content: string; readonly mode?: number } =>
  platform === "win32"
    ? { path: "pi.cmd", content: cmdLauncher(pi) }
    : { path: "pi", content: posixLauncher(pi), mode: 0o700 }
