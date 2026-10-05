import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { plugin, type Launchers, type Start } from "../harnesses/harness.js"
import { agents, harnesses } from "../harnesses/registry.js"
import { header } from "./header.js"
import { hookVariables } from "./hook.js"
import { mcpVersions } from "./mcp.js"

// The files NovaDeck puts in shells it starts, and the plugins agents install when the
// person connects them, as text. They are written into NovaDeck's own data directory;
// only connecting an agent installs anything elsewhere, through the agent's own commands.

/** Where each file lives under the shell directory. */
export type ShellPaths = {
  /** Put first on PATH while a harness with shims is connected, as Codex's `codex`. */
  readonly bin: string
  readonly bash: string
  /** ZDOTDIR for zsh. */
  readonly zsh: string
  readonly fish: string
  readonly powershell: string
  /** The plugin sources each agent installs from when the person connects it. */
  readonly plugins: { readonly [agent in AgentName]: string }
  /** Where a fresh shell finds the command that resumes its agent, one file per shell. */
  readonly resume: string
  /** The hook's launcher, which connected agents' plugins run. */
  readonly hook: string
  /** The MCP server's launcher, which connected agents' plugins start. */
  readonly mcp: string
  /** NovaDeck's copy of the relay the launchers start (see application/relay). */
  readonly relay: string
  /** What the runner tells the relay about the agents, which the hook launcher names. */
  readonly relayConfig: string
}

export const shellPaths = (directory: string, platform = process.platform): ShellPaths => ({
  bin: join(directory, "bin"),
  bash: join(directory, "bash", "novadeck.bash"),
  zsh: join(directory, "zsh"),
  fish: join(directory, "fish", "novadeck.fish"),
  powershell: join(directory, "powershell", "novadeck.ps1"),
  plugins: Object.fromEntries(
    agents.map((agent) => [agent, join(directory, "plugins", harnesses[agent].plugin)]),
  ) as ShellPaths["plugins"],
  resume: join(directory, "resume"),
  hook: join(directory, platform === "win32" ? "hook.cmd" : "hook"),
  mcp: join(directory, platform === "win32" ? "mcp.cmd" : "mcp"),
  relay: join(directory, platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"),
  relayConfig: join(directory, "relay.json"),
})

/** What older versions wrote beside these files and nothing reads any more. */
export const staleShellFiles = (directory: string): string[] => [
  join(directory, "hook.mjs"),
  join(directory, "mcp.mjs"),
  join(directory, "mcp-idle.js"),
]

// Quoting for each language a path is written into.
const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
export const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
export const fishQuote = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
// Batch files expand %VAR% even inside quotes; a path cannot hold a double quote.
const cmdQuote = (value: string): string => `"${value.replaceAll("%", "%%")}"`

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
  # Named so the command, which runs in here, sees none of its own as yours.
  local __novadeck_file=$NOVADECK_RESUME __novadeck_command
  unset NOVADECK_RESUME
  if [ -f "$__novadeck_file" ]; then
    __novadeck_command=$(<"$__novadeck_file")
    command rm -f -- "$__novadeck_file"
    eval "$__novadeck_command"
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
  # Named so the command, which runs in here, sees none of its own as yours.
  local __novadeck_file=$NOVADECK_RESUME __novadeck_command
  unset NOVADECK_RESUME
  if [[ -f "$__novadeck_file" ]]; then
    __novadeck_command=$(<"$__novadeck_file")
    command rm -f -- "$__novadeck_file"
    eval "$__novadeck_command" </dev/tty >/dev/tty 2>/dev/tty
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
    # Named so the command, which runs in here, sees none of its own as yours.
    set -l __novadeck_file $NOVADECK_RESUME
    set -e NOVADECK_RESUME
    functions -e __novadeck_resume
    if test -f $__novadeck_file
        set -l __novadeck_command (string collect < $__novadeck_file)
        command rm -f -- $__novadeck_file
        eval $__novadeck_command
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
    # Shown as typed at a prompt would show it: the integration around this hides errors.
    try { Invoke-Expression $__NovaDeckCommand } catch { $Host.UI.WriteErrorLine($_.ToString()) }
  }
  Remove-Variable __NovaDeckResume, __NovaDeckCommand -ErrorAction SilentlyContinue
}
`

// The launchers start NovaDeck's relay (see application/relay), which carries an agent's
// hooks and MCP messages to the runner of the terminal it runs in, or, outside NovaDeck's
// terminals, answers itself: for the MCP server, the handshake with no tools. Its copy
// lives here, beside them, so it stays when the app's own folder goes (an AppImage's
// mount, a portable build's unpacked copy). The MCP server answers as this version of
// it: its plugin's version, then the MCP versions it speaks, newest first.

// What a hook prints with nothing from NovaDeck, by agent and event, as each harness's
// messaging names it, without the line's end.
const silentAnswers = Object.fromEntries(
  agents.map((agent) => [
    agent,
    Object.fromEntries(
      Object.entries(harnesses[agent].messaging.silent).map(([event, text]) => [
        event,
        text.trimEnd(),
      ]),
    ),
  ]),
)

/**
 * What the relay knows of the agents, as `relay.json` holds it: which events ask, as
 * each waits longer for its answer, what of a hook's environment it forwards, and what
 * each prints without NovaDeck.
 */
export const relayConfig = {
  asks: Object.fromEntries(
    agents.map((agent) => [agent, Object.keys(harnesses[agent].messaging.asks)]),
  ),
  env: [...hookVariables],
  fallbacks: silentAnswers,
}

const relayArguments = (paths: ShellPaths) =>
  ({
    hook: ["hook", "--config", paths.relayConfig],
    mcp: ["mcp", plugin.version, ...mcpVersions],
  }) as const

type Mode = keyof ReturnType<typeof relayArguments>

// Each argument as it is, or quoted where the shell would read more into it.
const relayLine = (paths: ShellPaths, mode: Mode, quote: (value: string) => string) => {
  const args: readonly string[] = relayArguments(paths)[mode]
  return args.map((each) => (/^[\w.-]+$/.test(each) ? each : quote(each))).join(" ")
}

// Each agent's answers without NovaDeck, events of their own first: as sh's cases, and as
// cmd's lines, which hold none of cmd's own special characters.
const silentCases = (each: (agent: string, event: string, text: string) => string) =>
  agents.flatMap((agent) =>
    Object.entries(silentAnswers[agent] ?? {})
      .filter(([, text]) => text !== "")
      .toSorted(([one], [other]) => Number(one === "*") - Number(other === "*"))
      .map(([event, text]) => {
        if (/[&|<>^%]/.test(text)) throw new Error(`cmd can't print ${text} as it is`)
        return each(agent, event, text)
      }),
  )

const posixLauncher = (paths: ShellPaths, mode: Mode, what: string) =>
  mode === "mcp"
    ? `#!/bin/sh
${header("#", what)}
if [ ! -x ${shQuote(paths.relay)} ]; then
  printf '%s\\n' ${shQuote(`NovaDeck's relay is missing at ${paths.relay}; restarting NovaDeck puts it back.`)} >&2
  exit 1
fi
exec ${shQuote(paths.relay)} ${relayLine(paths, mode, shQuote)} "$@"
`
    : `#!/bin/sh
${header("#", what)}
if [ -x ${shQuote(paths.relay)} ] && [ -r ${shQuote(paths.relayConfig)} ]; then
  exec ${shQuote(paths.relay)} ${relayLine(paths, mode, shQuote)} "$@"
fi
# Without its relay or what it reads, as when NovaDeck couldn't put them in place: the
# hook takes the agent's input and prints what the agent needs, as Antigravity denies a
# tool otherwise.
cat >/dev/null
case "$1 $2" in
${silentCases(
  (agent, event, text) =>
    `  ${event === "*" ? `"${agent} "*` : `"${agent} ${event}"`}) printf '%s\\n' ${shQuote(text)} ;;`,
).join("\n")}
esac
`

// cmd reads a batch file's blocks reliably only with CRLF line endings.
const crlf = (text: string): string => text.replaceAll("\n", "\r\n")

const cmdLauncher = (paths: ShellPaths, mode: Mode, what: string) =>
  crlf(
    mode === "mcp"
      ? `@echo off
${header("rem", what)}
${cmdQuote(paths.relay)} ${relayLine(paths, mode, cmdQuote)} %*
`
      : `@echo off
${header("rem", what)}
if exist ${cmdQuote(paths.relay)} if exist ${cmdQuote(paths.relayConfig)} (
  ${cmdQuote(paths.relay)} ${relayLine(paths, mode, cmdQuote)} %*
  exit /b 0
)
rem Without its relay or what it reads: the agent's input taken, as it may not write into a
rem closed pipe, and what the agent needs printed, as Antigravity denies a tool otherwise.
findstr "^" >nul 2>nul
${silentCases(
  (agent, event, text) =>
    `if /i "%~1"=="${agent}" ${event === "*" ? "" : `if /i "%~2"=="${event}" `}(echo ${text}&exit /b 0)`,
).join("\n")}
`,
  )

/**
 * How agents start NovaDeck's MCP server: on Linux and macOS its launcher, which the
 * relay replaces, as it is started; on Windows the relay itself, as a launcher there
 * needs cmd, which stays running beside it, costing each agent several megabytes.
 */
export const mcpStart = (paths: ShellPaths, platform = process.platform): Start =>
  platform === "win32"
    ? { command: paths.relay, args: [...relayArguments(paths).mcp] }
    : { command: paths.mcp }

export type ShellFile = { readonly path: string; readonly content: string; readonly mode: number }

const file = (path: string, content: string, mode = 0o600): ShellFile => ({ path, content, mode })

/**
 * Every file for this platform, with the permissions each needs. Plugins start the MCP
 * server as `launchers.mcp` says.
 */
export const shellFiles = (
  paths: ShellPaths,
  platform = process.platform,
  launchers: Launchers = { mcp: mcpStart(paths, platform) },
): ShellFile[] => {
  const common = [
    file(paths.relayConfig, `${JSON.stringify(relayConfig, null, 2)}\n`),
    file(paths.bash, bash),
    file(join(paths.zsh, ".zshenv"), zshenv),
    file(join(paths.zsh, ".zprofile"), zprofile),
    file(join(paths.zsh, ".zshrc"), zshrc),
    file(paths.fish, fish),
    file(paths.powershell, powershell),
    ...agents.flatMap((agent) =>
      harnesses[agent]
        .files(platform, launchers)
        .map((each) => file(join(paths.plugins[agent], each.path), each.content, each.mode)),
    ),
  ]
  // Every harness's shims, which the shells put first on PATH only while one is connected.
  const shims = agents.flatMap((agent) => harnesses[agent].shims?.(platform) ?? [])
  const bin = shims.map((each) => file(join(paths.bin, each.path), each.content, each.mode))
  return platform === "win32"
    ? [
        ...common,
        file(paths.hook, cmdLauncher(paths, "hook", "agent hook launcher")),
        // Agents connected before NovaDeck started the relay itself on Windows keep their
        // plugin's copy, which starts the MCP server through cmd and this launcher.
        file(paths.mcp, cmdLauncher(paths, "mcp", "MCP server launcher")),
        ...bin,
      ]
    : [
        ...common,
        file(paths.hook, posixLauncher(paths, "hook", "agent hook launcher"), 0o700),
        file(paths.mcp, posixLauncher(paths, "mcp", "MCP server launcher"), 0o700),
        ...bin,
      ]
}
