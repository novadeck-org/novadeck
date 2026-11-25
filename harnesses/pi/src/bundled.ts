import { header } from "@novadeck/harness-core/header"
import { cmdLaunch, posixLaunch } from "@novadeck/harness-core/launch-mark"

/**
 * Novadeck's own pi (backend/runner's bundled/pi.ts), which its launcher starts: a pinned pi
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
 * Says to Novadeck's extension that it runs in Novadeck's own pi: what it writes for the
 * person's pi (the models their picker offers) it leaves alone.
 */
export const bundledMark = "NOVADECK_PI"

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
 * The launcher for Linux and macOS: fetches the program through the runner where it isn't in
 * place, showing its progress (`novadeck-relay fetch pi`), then starts it with Novadeck's
 * extension and its own agent folder, with pi's check for a newer version off, as Novadeck pins
 * the version. Not on PATH: Novadeck types its path.
 */
export const posixLauncher = (pi: BundledPi): string => `#!/bin/sh
${header("#", "launcher for its own pi")}
# Starts Novadeck's own pi, fetching it first where it isn't in place.
novadeck_program=${quoted(pi.program)}
if ! [ -x "$novadeck_program" ]; then
  ${quoted(pi.relay)} fetch pi || exit 1
fi
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
 * Bash in Program Files, then in Program Files (x86), then `bash.exe` on PATH. No `if (...)`
 * blocks hold a path: a ")" in "Program Files (x86)" would end them.
 */
export const cmdLauncher = (pi: BundledPi): string => `@echo off
${header("rem", "launcher for its own pi")}
rem Starts Novadeck's own pi, fetching it first where it isn't in place.
setlocal
set "novadeck_program=${pi.program}"
if exist "%novadeck_program%" goto have
call "${pi.relay}" fetch pi || exit /b 1
:have
set "PI_CODING_AGENT_DIR=${pi.home}"
set "PI_SKIP_VERSION_CHECK=1"
set "${bundledMark}=bundled"
set "novadeck_tools="
if exist "%ProgramFiles%\\Git\\bin\\bash.exe" goto tools
if exist "%ProgramFiles(x86)%\\Git\\bin\\bash.exe" goto tools
where bash.exe >nul 2>nul && goto tools
set "novadeck_tools=${powershellTools.join(" ")}"
:tools
if not exist "${pi.extension}" goto plain
${cmdLaunch("pi")}
"%novadeck_program%" -e "${pi.extension}" %novadeck_tools% %*
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
