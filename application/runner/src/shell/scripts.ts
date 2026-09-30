import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { plugin, type Launchers } from "../harnesses/harness.js"
import { agents, harnesses } from "../harnesses/registry.js"
import { header } from "./header.js"
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
  /** The hook's launcher. */
  readonly hook: string
  readonly hookScript: string
  /** The MCP server's launcher, which connected agents' plugins start. */
  readonly mcp: string
  readonly mcpScript: string
  /** On Windows, what answers for the MCP server outside NovaDeck's terminals. */
  readonly mcpIdle: string
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
  hookScript: join(directory, "hook.mjs"),
  mcp: join(directory, platform === "win32" ? "mcp.cmd" : "mcp"),
  mcpScript: join(directory, "mcp.mjs"),
  mcpIdle: join(directory, "mcp-idle.js"),
})

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

// A launcher runs a script on NovaDeck's own runtime: Electron acting as Node, or Node
// itself for a standalone runner. It is rewritten on each start, as that path moves.
const posixLauncher = (runtime: string, script: string, what: string): string => `#!/bin/sh
${header("#", what)}
ELECTRON_RUN_AS_NODE=1
export ELECTRON_RUN_AS_NODE
exec ${shQuote(runtime)} ${shQuote(script)} "$@"
`

const cmdLauncher = (runtime: string, script: string, what: string): string => `@echo off
${header("rem", what)}
set ELECTRON_RUN_AS_NODE=1
${cmdQuote(runtime)} ${cmdQuote(script)} %*
`

// The MCP server's launcher runs the server on NovaDeck's runtime only in NovaDeck's
// terminals, while that runtime is there. Agents start it in every session, and a
// packaged NovaDeck's runtime can live in a folder that goes when it quits (an AppImage's
// mount, a portable build's unpacked copy), so otherwise the launcher answers itself:
// the handshake, and no tools. The agent sees a working server it has nothing to call.
const posixMcpLauncher = (runtime: string, script: string): string => `#!/bin/sh
${header("#", "MCP server launcher")}
if [ -n "\${NOVADECK_TERMINAL_ID:-}" ] && [ -n "\${NOVADECK_REPORT:-}" ] &&
  [ -n "\${NOVADECK_REPORT_TOKEN:-}" ] && [ -x ${shQuote(runtime)} ]; then
  ELECTRON_RUN_AS_NODE=1
  export ELECTRON_RUN_AS_NODE
  exec ${shQuote(runtime)} ${shQuote(script)} "$@"
fi
# One request per line. Agents write the id last or before the params, and none of these
# requests' params holds an "id", so the last "id" is the request's.
while IFS= read -r novadeck_line || [ -n "$novadeck_line" ]; do
  novadeck_id=$(printf '%s\\n' "$novadeck_line" |
    sed -nE 's/.*"id"[[:space:]]*:[[:space:]]*(-?[0-9]+|"[^"\\\\]*").*/\\1/p')
  novadeck_method=$(printf '%s\\n' "$novadeck_line" |
    sed -nE 's/.*"method"[[:space:]]*:[[:space:]]*"([^"]*)".*/\\1/p')
  # Notifications, and anything but a request, need no answer.
  [ -n "$novadeck_id" ] && [ -n "$novadeck_method" ] || continue
  case $novadeck_method in
    initialize)
      novadeck_version=$(printf '%s\\n' "$novadeck_line" |
        sed -nE 's/.*"protocolVersion"[[:space:]]*:[[:space:]]*"([^"]*)".*/\\1/p')
      case $novadeck_version in
        ${mcpVersions.join(" | ")}) ;;
        *) novadeck_version=${mcpVersions[0]} ;;
      esac
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"novadeck","version":"${plugin.version}"}}}\\n' \\
        "$novadeck_id" "$novadeck_version"
      ;;
    ping) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\\n' "$novadeck_id" ;;
    tools/list) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[]}}\\n' "$novadeck_id" ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\\n' \\
        "$novadeck_id"
      ;;
  esac
done
`

// cmd reads a batch file's labels reliably only with CRLF line endings.
const crlf = (text: string): string => text.replaceAll("\n", "\r\n")

const cmdMcpLauncher = (runtime: string, script: string, idle: string): string =>
  crlf(`@echo off
${header("rem", "MCP server launcher")}
if not defined NOVADECK_TERMINAL_ID goto idle
if not defined NOVADECK_REPORT goto idle
if not defined NOVADECK_REPORT_TOKEN goto idle
if not exist ${cmdQuote(runtime)} goto idle
set ELECTRON_RUN_AS_NODE=1
${cmdQuote(runtime)} ${cmdQuote(script)} %*
exit /b %ERRORLEVEL%
:idle
cscript.exe //nologo //E:jscript ${cmdQuote(idle)}
`)

// Windows Script Host's JScript, which starts at once where PowerShell can take seconds.
// Like the sh loop, it reads each request by pattern: agents write the id last or before
// the params, and none of these requests' params holds an "id".
const mcpIdle = `${header("//", "MCP server, as it answers outside NovaDeck's terminals")}
var versions = ${JSON.stringify(mcpVersions)}
var input = WScript.StdIn
var output = WScript.StdOut
function field(line, pattern) {
  var found = pattern.exec(line)
  return found ? found[1] : null
}
function known(version) {
  for (var i = 0; i < versions.length; i++) if (versions[i] === version) return true
  return false
}
while (!input.AtEndOfStream) {
  var line = input.ReadLine()
  var id = field(line, /^.*"id"\\s*:\\s*(-?\\d+|"[^"\\\\]*")/)
  var method = field(line, /"method"\\s*:\\s*"([^"]*)"/)
  // Notifications, and anything but a request, need no answer.
  if (id === null || method === null) continue
  var answer
  if (method === "initialize") {
    var version = field(line, /"protocolVersion"\\s*:\\s*"([^"]*)"/)
    if (!known(version)) version = versions[0]
    answer = '"result":{"protocolVersion":"' + version + '","capabilities":{"tools":{}},' +
      '"serverInfo":{"name":"novadeck","version":"${plugin.version}"}}'
  } else if (method === "ping") answer = '"result":{}'
  else if (method === "tools/list") answer = '"result":{"tools":[]}'
  else answer = '"error":{"code":-32601,"message":"Method not found"}'
  output.Write('{"jsonrpc":"2.0","id":' + id + "," + answer + "}\\n")
}
`

export type ShellFile = { readonly path: string; readonly content: string; readonly mode: number }

const file = (path: string, content: string, mode = 0o600): ShellFile => ({ path, content, mode })

/**
 * Every file for this platform, with the permissions each needs. Plugins start the MCP
 * launcher by `launchers.mcp`, which on Windows can be its short name.
 */
export const shellFiles = (
  paths: ShellPaths,
  runtime: string,
  hookScript: string,
  mcpScript: string,
  platform = process.platform,
  launchers: Launchers = { mcp: paths.mcp },
): ShellFile[] => {
  const common = [
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
    file(paths.hookScript, hookScript),
    file(paths.mcpScript, mcpScript),
  ]
  // Every harness's shims, which the shells put first on PATH only while one is connected.
  const shims = agents.flatMap((agent) => harnesses[agent].shims?.(platform) ?? [])
  const bin = shims.map((each) => file(join(paths.bin, each.path), each.content, each.mode))
  return platform === "win32"
    ? [
        ...common,
        file(paths.hook, cmdLauncher(runtime, paths.hookScript, "agent hook launcher")),
        file(paths.mcp, cmdMcpLauncher(runtime, paths.mcpScript, paths.mcpIdle)),
        file(paths.mcpIdle, mcpIdle),
        ...bin,
      ]
    : [
        ...common,
        file(paths.hook, posixLauncher(runtime, paths.hookScript, "agent hook launcher"), 0o700),
        file(paths.mcp, posixMcpLauncher(runtime, paths.mcpScript), 0o700),
        ...bin,
      ]
}
