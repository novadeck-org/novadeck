import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { header } from "@novadeck/harness-core/header"
import type { KeptFlags } from "@novadeck/harness-core/kept-flags"
import { cmdLaunch, posixLaunch } from "@novadeck/harness-core/launch-mark"

/** The file of Novadeck's plugin, in the folder the runner writes it to (`plugins/opencode`). */
export const pluginFile = "novadeck.mjs"

/** Its interface's plugin, and the `tui.json` naming it, in the same folder. */
export const tuiPluginFile = "novadeck-tui.mjs"
export const tuiConfig = "tui.json"

/**
 * The plugin as opencode's `OPENCODE_CONFIG_DIR` finds it, relative to the plugin's folder.
 * opencode auto-loads only `{plugin,plugins}/*.{ts,js}` of a config folder, never `.mjs`
 * (config/plugin.ts:21, 1.19.6; probed 2026-11-22: a `.mjs` there did not load, a `.js` did), so
 * the file there is a `.js` that re-exports the real one.
 */
export const configPlugin = "config/plugins/novadeck.js"

// opencode's commands other than the TUI (`opencode --help`, 1.19.6, with the hidden `generate` and
// `console`, packages/opencode/src/index.ts:76-100, cli/cmd/account.ts:238), and its options that
// take a value: the word after one is its value, never a command. `--cors` takes a list (`array`,
// cli/network.ts:25), which the Harness's `nonSession.takesMany` says.
export const commands = [
  "completion",
  "acp",
  "mcp",
  "attach",
  "run",
  "generate",
  "debug",
  "console",
  "providers",
  "auth",
  "agent",
  "upgrade",
  "uninstall",
  "serve",
  "web",
  "models",
  "stats",
  "export",
  "import",
  "github",
  "pr",
  "session",
  "plugin",
  "plug",
  "db",
]

export const valued = [
  "--log-level",
  "--port",
  "--hostname",
  "--mdns-domain",
  "--cors",
  "-m",
  "--model",
  "-s",
  "--session",
  "--prompt",
  "--agent",
  "--replay-limit",
  // Novadeck's own word, which its shim strips before opencode reads the line (opencode's CLI is
  // strict, index.ts:116, so it must never reach it): the effort as a variant, see `launchConfig`.
  "--variant",
]

/** Its help and version flags, anywhere: they start no session. */
export const info = ["-h", "--help", "-v", "--version"]

// The ones whose value the shims read.
const sessionFlags = ["-s", "--session"]
const otherValued = valued.filter(
  (flag) => ![...sessionFlags, "-m", "--model", "--variant"].includes(flag),
)

/**
 * Where the plugin sits: `plugins/opencode` in the folder that holds the shim's own `bin`
 * (the runner writes the plugin to <shell dir>/plugins/opencode and the shim to <shell dir>/bin).
 */
const pluginFolder = "plugins/opencode"

// How a session gets Novadeck's plugin, for this launch alone and with no file of the person's
// written (opencode writes none for these: config/config.ts:264 skips even its own default config
// when any of them is set):
// 1. `OPENCODE_CONFIG_CONTENT`, a config of its own that opencode merges over the person's
//    (config/config.ts:482), naming the plugin by its absolute path. A path is a plugin spec
//    (plugin/shared.ts:171), and one with a space loaded (probed 2026-11-22, 1.19.6).
// 2. Where the person set that one, `OPENCODE_CONFIG_DIR`, whose `plugins` folder opencode scans
//    (config/config.ts:432-480): the folder Novadeck made for it, `configPlugin`. Opencode also
//    tries to install its plugin package into that folder, in the background.
// 3. Where they set both, none: the plugin can't load (`hooksTrusted` says so).
// A path that couldn't sit in JSON (a quote, a backslash, a line break) gets 2 as well.
export const posixShim = (root?: string): string => {
  // opencode has no `--add-dir`; the plugin gives the worktrees' folder to the session as a permission.
  void root
  return `#!/bin/sh
${header("#", "shim for opencode")}
# Runs the real opencode with Novadeck's plugin loaded for this launch, and tells the plugin
# which session the command line named, which a plugin can't read.
novadeck_real=
novadeck_ifs=$IFS
IFS=:
set -f
for novadeck_dir in $PATH; do
  [ -n "$novadeck_dir" ] || continue
  novadeck_candidate=$novadeck_dir/opencode
  # Another Novadeck's shim, as from a runner started in a Novadeck terminal, would call
  # this one back: only the program itself counts.
  if [ -f "$novadeck_candidate" ] && [ -x "$novadeck_candidate" ] && ! [ "$novadeck_candidate" -ef "$0" ] &&
    ! head -c 256 "$novadeck_candidate" 2>/dev/null | grep -qi "novadeck shim for opencode"; then
    novadeck_real=$novadeck_candidate
    break
  fi
done
set +f
IFS=$novadeck_ifs
if [ -z "$novadeck_real" ]; then
  echo "opencode: command not found" >&2
  exit 127
fi
[ -n "\${NOVADECK_TERMINAL_ID:-}" ] || exec "$novadeck_real" "$@"
case " \${NOVADECK_SHIMS:-} " in *" opencode "*) ;; *) exec "$novadeck_real" "$@" ;; esac
# What an outer Novadeck session of opencode left in the environment is not this launch's.
unset NOVADECK_OPENCODE_SESSION NOVADECK_OPENCODE_CONTINUE NOVADECK_OPENCODE_FORK
novadeck_session=
novadeck_continue=
novadeck_fork=
novadeck_model=
novadeck_variant=
novadeck_strip=
novadeck_value=
novadeck_first=1
for novadeck_arg in "$@"; do
  if [ -n "$novadeck_value" ]; then
    case $novadeck_value in
      session) novadeck_session=$novadeck_arg ;;
      model) novadeck_model=$novadeck_arg ;;
      variant) novadeck_variant=$novadeck_arg ;;
    esac
    novadeck_value=
    continue
  fi
  case $novadeck_arg in
    --) break ;;
    ${info.join(" | ")}) exec "$novadeck_real" "$@" ;;
    ${sessionFlags.join(" | ")}) novadeck_value=session ;;
    --session=*) novadeck_session=\${novadeck_arg#--session=} ;;
    -m | --model) novadeck_value=model ;;
    --model=*) novadeck_model=\${novadeck_arg#--model=} ;;
    -m=*) novadeck_model=\${novadeck_arg#-m=} ;;
    --variant) novadeck_value=variant novadeck_strip=1 ;;
    --variant=*) novadeck_variant=\${novadeck_arg#--variant=} novadeck_strip=1 ;;
    -c | --continue) novadeck_continue=1 ;;
    --fork) novadeck_fork=1 ;;
    ${otherValued.join(" | ")}) novadeck_value=1 ;;
    -*) ;;
    ${commands.join(" | ")}) [ -z "$novadeck_first" ] || exec "$novadeck_real" "$@"; novadeck_first= ;;
    *) novadeck_first= ;;
  esac
done
# Novadeck's own --variant word never reaches opencode, whose CLI is strict. With the launch's
# model it becomes the variant of its agents, in the configuration the plugin merges over the
# loaded one; a configuration already in the environment wins, and the variant is dropped.
if [ -n "$novadeck_strip" ]; then
  novadeck_pass=
  novadeck_n=$#
  while [ "$novadeck_n" -gt 0 ]; do
    novadeck_arg=$1
    shift
    novadeck_n=$((novadeck_n - 1))
    case $novadeck_pass in
      variant) novadeck_pass=; continue ;;
      copy) novadeck_pass=; set -- "$@" "$novadeck_arg"; continue ;;
      rest) set -- "$@" "$novadeck_arg"; continue ;;
    esac
    case $novadeck_arg in
      --) novadeck_pass=rest; set -- "$@" "$novadeck_arg" ;;
      --variant) novadeck_pass=variant ;;
      --variant=*) ;;
      -m | --model | -s | --session | ${otherValued.join(" | ")}) novadeck_pass=copy; set -- "$@" "$novadeck_arg" ;;
      *) set -- "$@" "$novadeck_arg" ;;
    esac
  done
  case "$novadeck_model:$novadeck_variant" in
    *[!A-Za-z0-9._:/-]* | :* | *:) ;;
    *)
      [ -n "\${NOVADECK_OPENCODE_CONFIG:-}" ] || {
        novadeck_agent="{\\"model\\":\\"$novadeck_model\\",\\"variant\\":\\"$novadeck_variant\\"}"
        export NOVADECK_OPENCODE_CONFIG="{\\"agent\\":{\\"build\\":$novadeck_agent,\\"plan\\":$novadeck_agent}}"
      }
      ;;
  esac
fi
[ -z "$novadeck_session" ] || export NOVADECK_OPENCODE_SESSION=$novadeck_session
[ -z "$novadeck_continue" ] || export NOVADECK_OPENCODE_CONTINUE=1
[ -z "$novadeck_fork" ] || export NOVADECK_OPENCODE_FORK=1
# The plugin's folder, from this file's own place; none if it isn't there.
novadeck_plugin=
if novadeck_dir=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) && [ -f "$novadeck_dir/${pluginFolder}/${pluginFile}" ]; then
  novadeck_plugin=$novadeck_dir/${pluginFolder}
fi
if [ -n "$novadeck_plugin" ]; then
  novadeck_config=
  if [ -z "\${OPENCODE_CONFIG_CONTENT:-}" ]; then
    case $novadeck_plugin in
      *[\\"\\\\]* | *'
'*) novadeck_config=dir ;;
      *) export OPENCODE_CONFIG_CONTENT="{\\"plugin\\":[\\"$novadeck_plugin/${pluginFile}\\"]}" ;;
    esac
  else
    novadeck_config=dir
  fi
  if [ "$novadeck_config" = dir ] && [ -z "\${OPENCODE_CONFIG_DIR:-}" ] && [ -f "$novadeck_plugin/${configPlugin}" ]; then
    export OPENCODE_CONFIG_DIR=$novadeck_plugin/config
  fi
fi
# Its interface's plugin, which tells a session left for home (/new): a tui.json for this launch,
# where the person named none of their own.
if [ -n "$novadeck_plugin" ] && [ -z "\${OPENCODE_TUI_CONFIG:-}" ] && [ -f "$novadeck_plugin/${tuiConfig}" ]; then
  export OPENCODE_TUI_CONFIG=$novadeck_plugin/${tuiConfig}
fi
${posixLaunch("opencode")}
exec "$novadeck_real" "$@"
`
}

// `where` lists matches in PATH order, this shim included, and the first other runnable one wins
// (as Antigravity's shim: `$PATH:` keeps the search to PATH, where a cloned repo's `opencode.cmd`
// would be found first). The words are walked as Claude Code's are (harnesses/claude/src/shim.ts),
// and %* keeps them all. The plugin's path is made whole with `for %%~f`, and goes into the JSON with
// forward slashes, which Windows takes as it does backslashes. No `if (...)` blocks are used where a
// path goes: a ")" in "Program Files (x86)" would end them.
export const makeCmdShim = (_options?: {
  readonly cmdShimDir?: string | undefined
  readonly root?: string | undefined
}): string => `@echo off
${header("rem", "shim for opencode")}
rem Runs the real opencode with Novadeck's plugin loaded for this launch, and tells the plugin
rem which session the command line named, which a plugin can't read.
setlocal
set "novadeck_real="
for /f "delims=" %%i in ('where $PATH:opencode 2^>nul') do call :consider "%%~fi"
if not defined novadeck_real (
  echo opencode: command not found 1>&2
  exit /b 9009
)
if not defined NOVADECK_TERMINAL_ID goto plain
rem Only while opencode is connected: Novadeck's shells name the harnesses whose shims apply.
echo " %NOVADECK_SHIMS% " | findstr /c:" opencode " >nul || goto plain
set "NOVADECK_OPENCODE_SESSION="
set "NOVADECK_OPENCODE_CONTINUE="
set "NOVADECK_OPENCODE_FORK="
set "novadeck_seen="
set "novadeck_model="
set "novadeck_variant="
set "novadeck_strip="
set "novadeck_args="
rem The first word that isn't an option or an option's value may be another command, which
rem starts no session, so it doesn't tell Novadeck one starts; it runs as a session does. The
rem words kept for opencode are gathered as they are walked, as Novadeck's own --variant word,
rem which opencode's strict command line would refuse, is left out of them.
:command
set novadeck_arg=""%1
if "%novadeck_arg:"=#%"=="##" goto session
set "novadeck_arg=%novadeck_arg:"=%"
if not defined novadeck_arg goto session
if "%novadeck_arg%"=="-s" set "NOVADECK_OPENCODE_SESSION=%~2"
if "%novadeck_arg%"=="--session" set "NOVADECK_OPENCODE_SESSION=%~2"
if "%novadeck_arg:~0,10%"=="--session=" set "NOVADECK_OPENCODE_SESSION=%novadeck_arg:~10%"
if "%novadeck_arg%"=="-c" set "NOVADECK_OPENCODE_CONTINUE=1"
if "%novadeck_arg%"=="--continue" set "NOVADECK_OPENCODE_CONTINUE=1"
if "%novadeck_arg%"=="--fork" set "NOVADECK_OPENCODE_FORK=1"
if "%novadeck_arg%"=="-m" set "novadeck_model=%~2"
if "%novadeck_arg%"=="--model" set "novadeck_model=%~2"
if "%novadeck_arg:~0,8%"=="--model=" set "novadeck_model=%novadeck_arg:~8%"
if "%novadeck_arg:~0,3%"=="-m=" set "novadeck_model=%novadeck_arg:~3%"
if "%novadeck_arg%"=="--variant" goto variant
if "%novadeck_arg:~0,10%"=="--variant=" goto variantequals
for %%h in (${info.join(" ")}) do if "%novadeck_arg%"=="%%h" goto run
for %%v in (${valued.join(" ")}) do if "%novadeck_arg%"=="%%v" goto value
if "%novadeck_arg:~0,1%"=="-" goto option
if defined novadeck_seen goto option
for %%c in (${commands.join(" ")}) do if "%novadeck_arg%"=="%%c" goto run
set "novadeck_seen=1"
:option
set "novadeck_args=%novadeck_args% %1"
shift
goto command
:value
set "novadeck_args=%novadeck_args% %1 %2"
shift
shift
goto command
:variant
set "novadeck_variant=%~2"
set "novadeck_strip=1"
shift
shift
goto command
:variantequals
set "novadeck_variant=%novadeck_arg:~10%"
set "novadeck_strip=1"
shift
goto command
:session
for %%i in ("%~dp0..\\${pluginFolder.replaceAll("/", "\\")}") do set "novadeck_plugin=%%~fi"
if not exist "%novadeck_plugin%\\${pluginFile}" goto config
set "novadeck_slash=%novadeck_plugin:\\=/%"
if defined OPENCODE_CONFIG_CONTENT goto dir
set "OPENCODE_CONFIG_CONTENT={"plugin":["%novadeck_slash%/${pluginFile}"]}"
goto config
:dir
if defined OPENCODE_CONFIG_DIR goto config
if exist "%novadeck_plugin%\\${configPlugin.replaceAll("/", "\\")}" set "OPENCODE_CONFIG_DIR=%novadeck_plugin%\\config"
rem The variant is the agents' own in the configuration the plugin merges over the loaded one,
rem where one isn't set already, and only from a model and a variant of plain characters.
:config
rem Its interface's plugin, which tells a session left for home (/new): a tui.json for this launch,
rem where the person named none of their own.
if defined OPENCODE_TUI_CONFIG goto tuiset
if not defined novadeck_plugin goto tuiset
if exist "%novadeck_plugin%\\${tuiConfig}" set "OPENCODE_TUI_CONFIG=%novadeck_plugin%\\${tuiConfig}"
:tuiset
if not defined novadeck_strip goto launch
if not defined novadeck_model goto launch
if not defined novadeck_variant goto launch
if defined NOVADECK_OPENCODE_CONFIG goto launch
echo "%novadeck_model%"| findstr /r "^\\"[A-Za-z0-9._:/-][A-Za-z0-9._:/-]*\\"$" >nul || goto launch
echo "%novadeck_variant%"| findstr /r "^\\"[A-Za-z0-9._:/-][A-Za-z0-9._:/-]*\\"$" >nul || goto launch
set "novadeck_agent={"model":"%novadeck_model%","variant":"%novadeck_variant%"}"
set "NOVADECK_OPENCODE_CONFIG={"agent":{"build":%novadeck_agent%,"plan":%novadeck_agent%}}"
:launch
${cmdLaunch("opencode")}
if defined novadeck_strip goto stripped
:run
set "novadeck_arg="
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:stripped
"%novadeck_real%"%novadeck_args%
exit /b %ERRORLEVEL%
:plain
"%novadeck_real%" %*
exit /b %ERRORLEVEL%
:consider
if defined novadeck_real exit /b
if /i "%~dp1"=="%~dp0" exit /b
rem Another Novadeck's shim would call this one back: only the program itself counts.
if /i "%~x1"==".cmd" findstr /b /i /c:"rem novadeck shim for opencode" "%~1" >nul && exit /b
if /i "%~x1"==".exe" set "novadeck_real=%~1"
if /i "%~x1"==".cmd" set "novadeck_real=%~1"
if /i "%~x1"==".bat" set "novadeck_real=%~1"
exit /b
`

/**
 * Whether Novadeck's plugin can load for a session started in this terminal: not where the
 * person runs opencode with `--pure` through its variable (`OPENCODE_PURE`, index.ts:62, no
 * external plugins), nor where they set both of the variables the shim would use
 * (`OPENCODE_CONFIG_CONTENT` and `OPENCODE_CONFIG_DIR`), nor where the plugin file isn't there.
 * It reads `where.env` alone and runs no command.
 */
export const hooksTrusted: NonNullable<Harness["hooksTrusted"]> = async (where) => {
  const { env } = where
  if (env.OPENCODE_PURE && env.OPENCODE_PURE !== "0" && env.OPENCODE_PURE !== "false") return false
  if (env.OPENCODE_CONFIG_CONTENT && env.OPENCODE_CONFIG_DIR) return false
  const { access } = await import("node:fs/promises")
  return access(join(where.plugin, pluginFile)).then(
    () => true,
    () => false,
  )
}

/**
 * What a resume carries over. By the source (1.19.6): a session brings back its agent, model and
 * variant itself, as the TUI sets them from the session's last user message (tui prompt/index.tsx:
 * 311-329), so none of those is given back. `--auto` is a command-line flag alone (tui
 * context/permission.tsx:12), never stored, so it is given back. Novadeck's own `--variant` is read
 * so a resume never takes it for a prompt.
 */
export const kept: KeptFlags = {
  valued: { "-m": "--model", "--model": "--model", "--agent": "--agent", "--variant": "--variant" },
  bare: { "--auto": "--auto" },
  forgets: ["--auto"],
  takesValue: valued,
  takesMany: ["--cors"],
  print: [],
  sets: (flag) => (flag === "--model" ? "model" : flag === "--variant" ? "effort" : undefined),
}
