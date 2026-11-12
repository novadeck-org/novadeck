import { tmpdir } from "node:os"
import { join } from "node:path"

import { header } from "@novadeck/harness-core/header"
import { shQuote } from "@novadeck/terminal/shell"

// Novadeck's capture of what an agent's commands print, for a harness that writes it nowhere
// Novadeck can read while it runs (Codex). Each terminal has a folder of its own, named in
// its shells' NOVADECK_CAPTURE, where each command the agent runs without a terminal leaves:
//
//   out-<id>.log      what it prints, its output and its errors, as it prints them
//   out-<id>.command  (Linux and macOS) the script its shell was given, as the shell has it
//   out-<id>.json     (Windows, novadeck-pwsh) {commandLine, shell, folder, started, captured, exit}
//
// The folder is in the system's temporary folder, the one the agent's commands get as
// TMPDIR or TEMP: Codex's sandbox lets its commands write there, and nowhere in the home.
// On Linux and macOS a command's shell loads the scripts below (bash through BASH_ENV, zsh
// through the .zshenv of ZDOTDIR), which Codex's shim sets for its commands alone; on
// Windows, novadeck-pwsh stands in for PowerShell (backend/relay/src/bin/novadeck-pwsh.rs).
// bash skips BASH_ENV for a command whose input is a socket, taking itself for one ssh
// started (Debian's and Ubuntu's build reads .bashrc then); Codex gives its commands no input.

/** The variable naming the folder a terminal's agent's commands capture to. */
export const captureVariable = "NOVADECK_CAPTURE"

/** The folder terminal `terminalId`'s agent's commands capture to. */
export const captureFolder = (terminalId: string, temporary = tmpdir()): string =>
  join(temporary, "novadeck-capture", terminalId)

/** The capture scripts' files, under the shell directory's `capture` folder. */
export type CapturePaths = {
  /** What a command's bash loads through BASH_ENV. */
  readonly bashEnv: string
  /** The folder a command's zsh is given as ZDOTDIR, holding its `.zshenv`. */
  readonly zdotdir: string
  /** What both load: the capture itself. */
  readonly script: string
}

export const capturePaths = (directory: string): CapturePaths => ({
  bashEnv: join(directory, "capture", "bash-env"),
  zdotdir: join(directory, "capture", "zsh"),
  script: join(directory, "capture", "capture.sh"),
})

/**
 * The capture, sourced by a command's shell (bash or zsh) as it starts: where NOVADECK_CAPTURE
 * names a folder and the command's output is no terminal, it records the script the shell
 * was given and copies what the command prints to a log there, as it prints it, while
 * passing it on unchanged. Its variables go first, so nothing the command starts captures
 * again. bash 3.2 (macOS's) under Codex's sandbox may not open /dev/fd/N, which `>(...)`
 * needs: there two named pipes in the folder carry the output and the errors instead. Where
 * anything fails, the command runs as it would without Novadeck.
 */
export const captureScript = (): string => `${header("#", "capture of an agent's command")}
novadeck_folder=\${${captureVariable}-}
unset ${captureVariable}
if [ -n "$novadeck_folder" ] && [ ! -t 1 ] && mkdir -p "$novadeck_folder" 2>/dev/null; then
  novadeck_base=$novadeck_folder/out-$(date +%s)-$$-$RANDOM$RANDOM
  if printf '%s' "\${BASH_EXECUTION_STRING:-\${ZSH_EXECUTION_STRING:-}}" > "$novadeck_base.command" 2>/dev/null &&
    : > "$novadeck_base.log" 2>/dev/null; then
    if (exec 9> >(cat > /dev/null)) 2>/dev/null; then
      exec > >(tee -a "$novadeck_base.log") 2> >(tee -a "$novadeck_base.log" >&2)
    elif mkfifo "$novadeck_base.out" "$novadeck_base.err" 2>/dev/null; then
      tee -a "$novadeck_base.log" < "$novadeck_base.out" &
      tee -a "$novadeck_base.log" < "$novadeck_base.err" >&2 &
      exec > "$novadeck_base.out" 2> "$novadeck_base.err"
      rm -f "$novadeck_base.out" "$novadeck_base.err"
    fi
  fi
  unset novadeck_base
fi
unset novadeck_folder
`

/**
 * What a command's bash loads through BASH_ENV: the capture, then the person's own BASH_ENV,
 * which the shim passes on as NOVADECK_USER_BASH_ENV, put back for what the command starts.
 */
export const bashEnvScript = (
  paths: CapturePaths,
): string => `${header("#", "BASH_ENV of an agent's commands")}
novadeck_user=\${NOVADECK_USER_BASH_ENV-}
unset BASH_ENV NOVADECK_USER_BASH_ENV
. ${shQuote(paths.script)}
if [ -n "$novadeck_user" ]; then
  BASH_ENV=$novadeck_user
  export BASH_ENV
  . "$novadeck_user"
fi
unset novadeck_user
`

/**
 * What a command's zsh loads as its .zshenv: the person's ZDOTDIR put back first (passed on
 * as NOVADECK_USER_ZDOTDIR), so their own .zshenv runs and their .zprofile and the rest are
 * read from it, then the capture.
 */
export const zshenvScript = (
  paths: CapturePaths,
): string => `${header("#", ".zshenv of an agent's commands")}
if [ -n "\${NOVADECK_USER_ZDOTDIR-}" ]; then
  ZDOTDIR=$NOVADECK_USER_ZDOTDIR
  export ZDOTDIR
else
  unset ZDOTDIR
fi
unset NOVADECK_USER_ZDOTDIR
[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ] && . "\${ZDOTDIR:-$HOME}/.zshenv"
. ${shQuote(paths.script)}
`
