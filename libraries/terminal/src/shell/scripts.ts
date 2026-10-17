import { join } from "node:path"

// The files a shell reads after its user's own setup: each reports the directory at every
// prompt, keeps one folder first on PATH, and runs a startup command once, at the first
// prompt. Their variables and functions are named after the app's prefix: with "acme",
// ACME_BIN, ACME_RESUME and __acme_prompt.

/** Where each shell's file lives, and the prefix it names its variables and functions by. */
export type ShellScriptPaths = {
  /** Lowercase letters and digits, starting with a letter. */
  readonly prefix: string
  readonly bash: string
  /** ZDOTDIR for zsh. */
  readonly zsh: string
  readonly fish: string
  readonly powershell: string
}

export type ShellFile = { readonly path: string; readonly content: string; readonly mode: number }

export const checked = (prefix: string): string => {
  if (!/^[a-z][a-z0-9]*$/.test(prefix))
    throw new Error(`A shell prefix is lowercase letters and digits, not ${JSON.stringify(prefix)}`)
  return prefix
}

export const shellScriptPaths = (directory: string, prefix: string): ShellScriptPaths => ({
  prefix: checked(prefix),
  bash: join(directory, "bash", `${prefix}.bash`),
  zsh: join(directory, "zsh"),
  fish: join(directory, "fish", `${prefix}.fish`),
  powershell: join(directory, "powershell", `${prefix}.ps1`),
})

/**
 * bash, started with `--init-file`: reads the user's own ~/.bashrc as bash would, then
 * reports the directory at each prompt with OSC 7.
 */
const bash = (p: string, v: string) => `
if [ -f ~/.bashrc ]; then . ~/.bashrc; fi
# Your startup files may put other directories first; ${v}_BIN goes back in front.
if [ -n "\${${v}_BIN:-}" ]; then
  case "$PATH" in "$${v}_BIN":*) ;; *) PATH="$${v}_BIN:$PATH" ;; esac
fi

__${p}_prompt() {
  local status=$? LC_ALL=C path=$PWD encoded= char byte i
  # While a startup command waits, this prompt is not the shell's yet; see __${p}_resume.
  [ -z "\${${v}_RESUME:-}" ] || return $status
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
  PROMPT_COMMAND=(__${p}_prompt "\${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__${p}_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi

# The startup command runs at the first prompt, after your own prompt commands, as if
# typed there, but without the typing or a history entry. It waits in the file
# ${v}_RESUME names; removing it first cancels it. The prompt is reported once
# the command exits, so the terminal knows it ended.
__${p}_resume() {
  [ -n "\${${v}_RESUME:-}" ] || return 0
  # Named so the command, which runs in here, sees none of its own as yours.
  local __${p}_file=$${v}_RESUME __${p}_command
  unset ${v}_RESUME
  if [ -f "$__${p}_file" ]; then
    __${p}_command=$(<"$__${p}_file")
    command rm -f -- "$__${p}_file"
    eval "$__${p}_command"
  fi
  __${p}_prompt
}
if [ -n "\${${v}_RESUME:-}" ]; then
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND+=(__${p}_resume)
  else
    PROMPT_COMMAND+=$'\n__${p}_resume'
  fi
fi
`

// zsh reads its startup files from ZDOTDIR, which the launch points here. .zshenv reads
// the user's own with ZDOTDIR as they had it (<PREFIX>_ZDOTDIR, or unset), and notes
// where their .zshenv left it; later files read the user's from there. .zshrc hands
// ZDOTDIR back, so .zlogin and any nested zsh read theirs.
const zshenv = (p: string, v: string) => `
__${p}_zdotdir=$ZDOTDIR
if [[ -n "\${${v}_ZDOTDIR+set}" ]]; then ZDOTDIR=$${v}_ZDOTDIR; else unset ZDOTDIR; fi
if [[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then . "\${ZDOTDIR:-$HOME}/.zshenv"; fi
${v}_ZDOTDIR=\${ZDOTDIR:-$HOME}
ZDOTDIR=$__${p}_zdotdir
unset __${p}_zdotdir
`

const zprofile = (p: string, v: string) => `
if [[ -f "$${v}_ZDOTDIR/.zprofile" ]]; then
  __${p}_zdotdir=$ZDOTDIR
  ZDOTDIR=$${v}_ZDOTDIR
  . "$ZDOTDIR/.zprofile"
  ${v}_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$__${p}_zdotdir
  unset __${p}_zdotdir
fi
`

const zshrc = (p: string, v: string) => `
__${p}_zdotdir=$ZDOTDIR
ZDOTDIR=$${v}_ZDOTDIR
unset ${v}_ZDOTDIR
# A system zshrc read before this one, as macOS's, may have put history here.
if [[ "$HISTFILE" == "$__${p}_zdotdir"/* ]]; then HISTFILE=$ZDOTDIR/.zsh_history; fi
unset __${p}_zdotdir
if [[ -f "$ZDOTDIR/.zshrc" ]]; then . "$ZDOTDIR/.zshrc"; fi
# Your startup files may put other directories first; ${v}_BIN goes back in front.
if [[ -n "$${v}_BIN" && "$PATH" != "$${v}_BIN":* ]]; then PATH="$${v}_BIN:$PATH"; fi

__${p}_prompt() {
  emulate -L zsh
  # While a startup command waits, this prompt is not the shell's yet; see __${p}_resume.
  [[ -z "$${v}_RESUME" ]] || return 0
  setopt extendedglob
  unsetopt multibyte
  local encoded=\${PWD//(#m)[^a-zA-Z0-9\\/._~-]/%\${(l:2::0:)$(( [##16] #MATCH ))}}
  print -rn -- $'\\e]7;file://'"\${HOST}\${encoded}"$'\\e\\\\'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __${p}_prompt

# The startup command runs at the first prompt, after your own precmd hooks, as if
# typed there, but without the typing or a history entry. It waits in the file
# ${v}_RESUME names; removing it first cancels it. The prompt is reported once
# the command exits, so the terminal knows it ended. The command gets the terminal
# itself, as a prompt that draws early may still hold the shell's.
__${p}_resume() {
  add-zsh-hook -d precmd __${p}_resume
  [[ -n "$${v}_RESUME" ]] || return 0
  # Named so the command, which runs in here, sees none of its own as yours.
  local __${p}_file=$${v}_RESUME __${p}_command __${p}_tty
  unset ${v}_RESUME
  if [[ -f "$__${p}_file" ]]; then
    __${p}_command=$(<"$__${p}_file")
    command rm -f -- "$__${p}_file"
    # The terminal by its own name: macOS's kqueue refuses /dev/tty, so a program that
    # watches its input there, as Bun does, would die with EINVAL.
    __${p}_tty=\${TTY:-/dev/tty}
    eval "$__${p}_command" <"$__${p}_tty" >"$__${p}_tty" 2>&1
  fi
  __${p}_prompt
}
if [[ -n "$${v}_RESUME" ]]; then add-zsh-hook precmd __${p}_resume; fi
`

const fish = (p: string, v: string) => `
# Your configuration may put other directories first; ${v}_BIN goes back in front, for
# this shell only.
if set -q ${v}_BIN
    set -gx PATH $${v}_BIN (string match -v -- $${v}_BIN $PATH)
end

function __${p}_prompt --on-event fish_prompt
    # While a startup command waits, this prompt is not the shell's yet; see __${p}_resume.
    set -q ${v}_RESUME; and return
    printf '\\e]7;file://%s%s\\e\\\\' $hostname (string escape --style=url -- $PWD)
end

# The startup command runs at the first prompt, as if typed there, but without the
# typing or a history entry. It waits in the file ${v}_RESUME names; removing it
# first cancels it. The prompt is reported once the command exits, so the terminal
# knows it ended.
function __${p}_resume --on-event fish_prompt
    set -q ${v}_RESUME; or return
    # Named so the command, which runs in here, sees none of its own as yours.
    set -l __${p}_file $${v}_RESUME
    set -e ${v}_RESUME
    functions -e __${p}_resume
    if test -f $__${p}_file
        set -l __${p}_command (string collect < $__${p}_file)
        command rm -f -- $__${p}_file
        eval $__${p}_command
    end
    __${p}_prompt
end
`

// PowerShell loads the user's profile before -Command runs this. The prompt reports
// the directory with OSC 9;9, as Windows Terminal documents, around the user's own.
const powershell = (p: string, v: string) => `
# Your profile may put other directories first; ${v}_BIN goes back in front.
if ($env:${v}_BIN) {
  $__${p}Separator = [IO.Path]::PathSeparator
  if (-not $env:PATH.StartsWith("$env:${v}_BIN$__${p}Separator")) {
    $env:PATH = "$env:${v}_BIN$__${p}Separator$env:PATH"
  }
}
$global:__${p}Prompt = $function:prompt
function global:prompt {
  $prompt = & $global:__${p}Prompt
  $location = $executionContext.SessionState.Path.CurrentLocation
  if ($location.Provider.Name -ne 'FileSystem') { return $prompt }
  "$([char]27)]9;9;\`"$($location.ProviderPath)\`"$([char]27)\\$prompt"
}
# The startup command runs before the first prompt, as if typed there, but without the
# typing or a history entry. It waits in the file ${v}_RESUME names; removing it
# first cancels it.
if ($env:${v}_RESUME) {
  $__${p}Resume = $env:${v}_RESUME
  Remove-Item Env:${v}_RESUME
  if (Test-Path -LiteralPath $__${p}Resume) {
    $__${p}Command = Get-Content -LiteralPath $__${p}Resume -Raw
    Remove-Item -LiteralPath $__${p}Resume
    # Shown as typed at a prompt would show it: the integration around this hides errors.
    try { Invoke-Expression $__${p}Command } catch { $Host.UI.WriteErrorLine($_.ToString()) }
  }
  Remove-Variable __${p}Resume, __${p}Command -ErrorAction SilentlyContinue
}
`

/**
 * Every shell's file, readable by its owner only, each opening with the app's `header`: its
 * `comment` lines, `what` saying which file it is.
 */
export const shellScripts = (
  paths: ShellScriptPaths,
  header: (comment: string, what: string) => string,
): ShellFile[] => {
  const p = checked(paths.prefix)
  const v = p.toUpperCase()
  const file = (path: string, shell: string, body: string): ShellFile => ({
    path,
    content: `${header("#", `shell integration for ${shell}`)}${body}`,
    mode: 0o600,
  })
  return [
    file(paths.bash, "bash", bash(p, v)),
    file(join(paths.zsh, ".zshenv"), "zsh", zshenv(p, v)),
    file(join(paths.zsh, ".zprofile"), "zsh", zprofile(p, v)),
    file(join(paths.zsh, ".zshrc"), "zsh", zshrc(p, v)),
    file(paths.fish, "fish", fish(p, v)),
    file(paths.powershell, "PowerShell", powershell(p, v)),
  ]
}
