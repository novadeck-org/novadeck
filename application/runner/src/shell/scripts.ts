import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

// The files NovaDeck puts in shells it starts, and the plugins agents install when the
// person connects them, as text. They are written into NovaDeck's own data directory;
// only connecting an agent installs anything elsewhere, through the agent's own commands.

/** Where each file lives under the shell directory. */
export type ShellPaths = {
  /** Put first on PATH while Codex is connected: the `codex` shim. */
  readonly bin: string
  readonly bash: string
  /** ZDOTDIR for zsh. */
  readonly zsh: string
  readonly fish: string
  readonly powershell: string
  /**
   * The plugin sources each agent installs from when the person connects it: a local
   * marketplace for Claude Code and Codex, a plugin folder for Antigravity.
   */
  readonly plugins: { readonly claude: string; readonly codex: string; readonly agy: string }
  /** Where a fresh shell finds the command that resumes its agent, one file per shell. */
  readonly resume: string
  /** The hook's launcher. */
  readonly hook: string
  readonly hookScript: string
}

export const shellPaths = (directory: string, platform = process.platform): ShellPaths => ({
  bin: join(directory, "bin"),
  bash: join(directory, "bash", "novadeck.bash"),
  zsh: join(directory, "zsh"),
  fish: join(directory, "fish", "novadeck.fish"),
  powershell: join(directory, "powershell", "novadeck.ps1"),
  plugins: {
    claude: join(directory, "plugins", "claude"),
    codex: join(directory, "plugins", "codex"),
    agy: join(directory, "plugins", "agy", "novadeck"),
  },
  resume: join(directory, "resume"),
  hook: join(directory, platform === "win32" ? "hook.cmd" : "hook"),
  hookScript: join(directory, "hook.mjs"),
})

// Quoting for each language a path is written into.
const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
export const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
export const fishQuote = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
// Batch files expand %VAR% even inside quotes; a path cannot hold a double quote.
const cmdQuote = (value: string): string => `"${value.replaceAll("%", "%%")}"`

const header = (comment: string, what: string): string =>
  [
    `${comment} NovaDeck ${what}.`,
    `${comment} Written by NovaDeck into its own data directory, and overwritten on each start.`,
    `${comment} Only NovaDeck's shells, and agents you connected, use it.`,
  ].join("\n")

/**
 * bash, started with `--init-file`: reads the user's own ~/.bashrc as bash would, then
 * reports the directory at each prompt with OSC 7.
 */
const bash = `${header("#", "shell integration for bash")}
if [ -f ~/.bashrc ]; then . ~/.bashrc; fi
# Your startup files may put other directories first; the Codex shim goes back in front.
if [ -n "\${NOVADECK_BIN:-}" ]; then
  case "$PATH" in "$NOVADECK_BIN":*) ;; *) PATH="$NOVADECK_BIN:$PATH" ;; esac
fi

__novadeck_prompt() {
  local status=$? LC_ALL=C path=$PWD encoded= char byte i
  # While a resume waits, this prompt is not the shell's yet; see __novadeck_resume.
  [ -z "\${NOVADECK_RESUME:-}" ] || return $status
  for (( i = 0; i < \${#path}; i++ )); do
    char=\${path:i:1}
    case $char in
      [a-zA-Z0-9/._~-]) encoded+=$char ;;
      # bash 3.2, as macOS ships, reads a byte above 127 as negative.
      *) printf -v byte '%d' "'$char"; printf -v char '%%%02X' $(( byte & 255 )); encoded+=$char ;;
    esac
  done
  printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME:-}" "$encoded"
  return $status
}

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__novadeck_prompt "\${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__novadeck_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

# A restored terminal resumes its agent at the first prompt, after your own prompt
# commands, as if typed there, but without the typing or a history entry. The command
# waits in the file NOVADECK_RESUME names, which NovaDeck removes if you type first.
# The prompt is reported once the agent exits, so NovaDeck knows it ended.
__novadeck_resume() {
  [ -n "\${NOVADECK_RESUME:-}" ] || return 0
  local file=$NOVADECK_RESUME resume
  unset NOVADECK_RESUME
  if [ -f "$file" ]; then
    resume=$(<"$file")
    command rm -f -- "$file"
    eval "$resume"
  fi
  __novadeck_prompt
}
if [ -n "\${NOVADECK_RESUME:-}" ]; then
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND+=(__novadeck_resume)
  else
    PROMPT_COMMAND+=$'\n__novadeck_resume'
  fi
fi
`

// zsh reads its startup files from ZDOTDIR, which NovaDeck points here. .zshenv reads
// the user's own with ZDOTDIR as they had it (NOVADECK_ZDOTDIR, or unset), and notes
// where their .zshenv left it; later files read the user's from there. .zshrc hands
// ZDOTDIR back, so .zlogin and any nested zsh read theirs.
const zshenv = `${header("#", "shell integration for zsh")}
__novadeck_zdotdir=$ZDOTDIR
if [[ -n "\${NOVADECK_ZDOTDIR+set}" ]]; then ZDOTDIR=$NOVADECK_ZDOTDIR; else unset ZDOTDIR; fi
if [[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then . "\${ZDOTDIR:-$HOME}/.zshenv"; fi
NOVADECK_ZDOTDIR=\${ZDOTDIR:-$HOME}
ZDOTDIR=$__novadeck_zdotdir
unset __novadeck_zdotdir
`

const zprofile = `${header("#", "shell integration for zsh")}
if [[ -f "$NOVADECK_ZDOTDIR/.zprofile" ]]; then
  __novadeck_zdotdir=$ZDOTDIR
  ZDOTDIR=$NOVADECK_ZDOTDIR
  . "$ZDOTDIR/.zprofile"
  NOVADECK_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$__novadeck_zdotdir
  unset __novadeck_zdotdir
fi
`

const zshrc = `${header("#", "shell integration for zsh")}
__novadeck_zdotdir=$ZDOTDIR
ZDOTDIR=$NOVADECK_ZDOTDIR
unset NOVADECK_ZDOTDIR
# A system zshrc read before this one, as macOS's, may have put history here.
if [[ "$HISTFILE" == "$__novadeck_zdotdir"/* ]]; then HISTFILE=$ZDOTDIR/.zsh_history; fi
unset __novadeck_zdotdir
if [[ -f "$ZDOTDIR/.zshrc" ]]; then . "$ZDOTDIR/.zshrc"; fi
# Your startup files may put other directories first; the Codex shim goes back in front.
if [[ -n "$NOVADECK_BIN" && "$PATH" != "$NOVADECK_BIN":* ]]; then PATH="$NOVADECK_BIN:$PATH"; fi

__novadeck_prompt() {
  emulate -L zsh
  # While a resume waits, this prompt is not the shell's yet; see __novadeck_resume.
  [[ -z "$NOVADECK_RESUME" ]] || return 0
  setopt extendedglob
  unsetopt multibyte
  local encoded=\${PWD//(#m)[^a-zA-Z0-9\\/._~-]/%\${(l:2::0:)$(( [##16] #MATCH ))}}
  print -rn -- $'\\e]7;file://'"\${HOST}\${encoded}"$'\\e\\\\'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __novadeck_prompt

# A restored terminal resumes its agent at the first prompt, after your own precmd
# hooks, as if typed there, but without the typing or a history entry. The command
# waits in the file NOVADECK_RESUME names, which NovaDeck removes if you type first.
# The prompt is reported once the agent exits, so NovaDeck knows it ended. The agent
# gets the terminal itself, as a prompt that draws early may still hold the shell's.
__novadeck_resume() {
  add-zsh-hook -d precmd __novadeck_resume
  [[ -n "$NOVADECK_RESUME" ]] || return 0
  local file=$NOVADECK_RESUME resume
  unset NOVADECK_RESUME
  if [[ -f "$file" ]]; then
    resume=$(<"$file")
    command rm -f -- "$file"
    eval "$resume" </dev/tty >/dev/tty 2>/dev/tty
  fi
  __novadeck_prompt
}
if [[ -n "$NOVADECK_RESUME" ]]; then add-zsh-hook precmd __novadeck_resume; fi
`

const fish = `${header("#", "shell integration for fish")}
# Your configuration may put other directories first; the Codex shim goes back in front,
# for this shell only.
if set -q NOVADECK_BIN
    set -gx PATH $NOVADECK_BIN (string match -v -- $NOVADECK_BIN $PATH)
end

function __novadeck_prompt --on-event fish_prompt
    # While a resume waits, this prompt is not the shell's yet; see __novadeck_resume.
    set -q NOVADECK_RESUME; and return
    printf '\\e]7;file://%s%s\\e\\\\' $hostname (string escape --style=url -- $PWD)
end

# A restored terminal resumes its agent at the first prompt, as if typed there, but
# without the typing or a history entry. The command waits in the file NOVADECK_RESUME
# names, which NovaDeck removes if you type first. The prompt is reported once the
# agent exits, so NovaDeck knows it ended.
function __novadeck_resume --on-event fish_prompt
    set -q NOVADECK_RESUME; or return
    set -l file $NOVADECK_RESUME
    set -e NOVADECK_RESUME
    functions -e __novadeck_resume
    if test -f $file
        set -l resume (string collect < $file)
        command rm -f -- $file
        eval $resume
    end
    __novadeck_prompt
end
`

// PowerShell loads the user's profile before -Command runs this. The prompt reports
// the directory with OSC 9;9, as Windows Terminal documents, around the user's own.
const powershell = `${header("#", "shell integration for PowerShell")}
# Your profile may put other directories first; the Codex shim goes back in front.
if ($env:NOVADECK_BIN) {
  $__NovaDeckSeparator = [IO.Path]::PathSeparator
  if (-not $env:PATH.StartsWith("$env:NOVADECK_BIN$__NovaDeckSeparator")) {
    $env:PATH = "$env:NOVADECK_BIN$__NovaDeckSeparator$env:PATH"
  }
}
$global:__NovaDeckPrompt = $function:prompt
function global:prompt {
  $prompt = & $global:__NovaDeckPrompt
  $location = $executionContext.SessionState.Path.CurrentLocation
  if ($location.Provider.Name -ne 'FileSystem') { return $prompt }
  "$([char]27)]9;9;\`"$($location.ProviderPath)\`"$([char]27)\\$prompt"
}
# A restored terminal resumes its agent before the first prompt, as if typed there, but
# without the typing or a history entry. The command waits in the file NOVADECK_RESUME
# names, which NovaDeck removes if you type first.
if ($env:NOVADECK_RESUME) {
  $__NovaDeckResume = $env:NOVADECK_RESUME
  Remove-Item Env:NOVADECK_RESUME
  if (Test-Path -LiteralPath $__NovaDeckResume) {
    $__NovaDeckCommand = Get-Content -LiteralPath $__NovaDeckResume -Raw
    Remove-Item -LiteralPath $__NovaDeckResume
    Invoke-Expression $__NovaDeckCommand
  }
  Remove-Variable __NovaDeckResume, __NovaDeckCommand -ErrorAction SilentlyContinue
}
`

// Interactive Codex runs its sessions, and their hooks, in a shared background server
// that knows nothing of the terminal it was started from. While Codex is connected,
// NovaDeck's shells run it through this shim, which adds --no-daemon so the session and
// its hook run in the terminal. `codex agents` and --remote need the server, so they go
// unchanged, as does anything outside NovaDeck's shells.
const posixCodexShim = `#!/bin/sh
${header("#", "shim for codex")}
# Runs the real codex with --no-daemon, so its hooks can tell NovaDeck which session runs
# in this terminal.
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/codex
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ]; then
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
for novadeck_arg in "$@"; do
  case $novadeck_arg in
    agents | --remote | --remote=* | --no-daemon) exec "$novadeck_real" "$@" ;;
  esac
done
exec "$novadeck_real" --no-daemon "$@"
`

// `where` lists matches in PATH order, including this shim, and on npm installs an
// extensionless script that only other shells run; the first other runnable one wins.
const cmdCodexShim = `@echo off
${header("rem", "shim for codex")}
rem Runs the real codex with --no-daemon, so its hooks can tell NovaDeck which session
rem runs in this terminal.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where codex 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo codex: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
for %%a in (%*) do (
  if /i "%%~a"=="agents" goto plain
  if /i "%%~a"=="--remote" goto plain
  if /i "%%~a"=="--no-daemon" goto plain
)
"%novadeck_real%" --no-daemon %*
exit /b %ERRORLEVEL%
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`

/**
 * The hook command each agent's plugin runs, through the agent's own shell: sh (Claude
 * Code, Antigravity) or the login shell (Codex) elsewhere; on Windows, PowerShell for
 * Claude Code and cmd for the others. Outside NovaDeck's shells NOVADECK_HOOK is unset
 * and the command does nothing, so a plugin left behind never gets in the way.
 * Antigravity expects JSON back even then. Codex and Antigravity trust a hook by its
 * definition, so these strings must never change.
 */
export const hookCommand = (agent: AgentName, platform = process.platform): string => {
  if (platform === "win32") {
    // Unquoted: an agent may escape inner quotes in a way cmd does not read.
    if (agent === "claude") return "if ($env:NOVADECK_HOOK) { & $env:NOVADECK_HOOK claude }"
    if (agent === "agy") return "if defined NOVADECK_HOOK (%NOVADECK_HOOK% agy) else (echo {})"
    return "if defined NOVADECK_HOOK %NOVADECK_HOOK% codex"
  }
  if (agent === "agy")
    return `if [ -n "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" agy; else echo '{}'; fi`
  return `[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" ${agent} || true`
}

const plugin = {
  name: "novadeck",
  version: "1.0.0",
  description: "Tells NovaDeck which session runs in its terminal, so it can resume it.",
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// Claude Code and Codex install from a marketplace; both read this local one.
const marketplace = json({
  name: "novadeck",
  owner: { name: "NovaDeck" },
  plugins: [{ name: "novadeck", source: "./novadeck", description: plugin.description }],
})

const claudeHooks = (platform: NodeJS.Platform) => ({
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand("claude", platform),
            ...(platform === "win32" && { shell: "powershell" }),
          },
        ],
      },
    ],
  },
})

const codexHooks = (platform: NodeJS.Platform) => ({
  hooks: {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [{ type: "command", command: hookCommand("codex", platform) }],
      },
    ],
  },
})

// Antigravity runs PreInvocation hooks before each model call, the first time with the
// conversation's first message.
const agyHooks = (platform: NodeJS.Platform) => ({
  novadeck: { PreInvocation: [{ type: "command", command: hookCommand("agy", platform) }] },
})

// The launcher runs the hook on NovaDeck's own runtime: Electron acting as Node, or Node
// itself for a standalone runner. It is rewritten on each start, as that path moves.
const posixLauncher = (runtime: string, paths: ShellPaths): string => `#!/bin/sh
${header("#", "agent hook launcher")}
ELECTRON_RUN_AS_NODE=1
export ELECTRON_RUN_AS_NODE
exec ${shQuote(runtime)} ${shQuote(paths.hookScript)} "$@"
`

const cmdLauncher = (runtime: string, paths: ShellPaths): string => `@echo off
${header("rem", "agent hook launcher")}
set ELECTRON_RUN_AS_NODE=1
${cmdQuote(runtime)} ${cmdQuote(paths.hookScript)} %*
`

export type ShellFile = { readonly path: string; readonly content: string; readonly mode: number }

const file = (path: string, content: string, mode = 0o600): ShellFile => ({ path, content, mode })

/** Every file for this platform, with the permissions each needs. */
export const shellFiles = (
  paths: ShellPaths,
  runtime: string,
  hookScript: string,
  platform = process.platform,
): ShellFile[] => {
  const { claude, codex, agy } = paths.plugins
  const common = [
    file(paths.bash, bash),
    file(join(paths.zsh, ".zshenv"), zshenv),
    file(join(paths.zsh, ".zprofile"), zprofile),
    file(join(paths.zsh, ".zshrc"), zshrc),
    file(paths.fish, fish),
    file(paths.powershell, powershell),
    file(join(claude, ".claude-plugin", "marketplace.json"), marketplace),
    file(join(claude, "novadeck", ".claude-plugin", "plugin.json"), json(plugin)),
    file(join(claude, "novadeck", "hooks", "hooks.json"), json(claudeHooks(platform))),
    file(join(codex, ".claude-plugin", "marketplace.json"), marketplace),
    file(
      join(codex, "novadeck", ".codex-plugin", "plugin.json"),
      json({ ...plugin, hooks: "./hooks/hooks.json" }),
    ),
    file(join(codex, "novadeck", "hooks", "hooks.json"), json(codexHooks(platform))),
    file(join(agy, "plugin.json"), json({ name: plugin.name })),
    file(join(agy, "hooks.json"), json(agyHooks(platform))),
    file(paths.hookScript, hookScript),
  ]
  return platform === "win32"
    ? [
        ...common,
        file(paths.hook, cmdLauncher(runtime, paths)),
        file(join(paths.bin, "codex.cmd"), cmdCodexShim),
      ]
    : [
        ...common,
        file(paths.hook, posixLauncher(runtime, paths), 0o700),
        file(join(paths.bin, "codex"), posixCodexShim, 0o700),
      ]
}
