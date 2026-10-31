import type { AgentName } from "@novadeck/protocol"

/**
 * The shell a harness runs a hook command in, as each was probed:
 * - `sh`: every harness on Linux and macOS, as `sh -c "<command>"`;
 * - `powershell`: Claude Code (its `shell: "powershell"`) and Codex on Windows, PowerShell
 *   7 where installed, Codex with `-NoProfile`, as its binary passes PowerShell (0.159.3:
 *   `%COMSPEC%` stayed as written, `$PSVersionTable` read);
 * - `cmd`: Antigravity on Windows, as `cmd /c "<command>"` without `/d`, its double quotes
 *   escaped as `\"`, which cmd keeps (probed 2026-10-11, 1.2.14).
 */
export type Dialect = "sh" | "powershell" | "cmd"

/**
 * The programs a dialect's shell runs as, by their file names without `.exe`, as the
 * relay names a hook's ancestors.
 */
export const dialectPrograms: Readonly<Record<Dialect, readonly string[]>> = {
  sh: ["sh", "bash", "dash", "zsh"],
  powershell: ["pwsh", "powershell"],
  cmd: ["cmd"],
}

/** What a hook command runs: Novadeck's launcher, for `agent`'s `event`. */
type HookCall = {
  readonly agent: AgentName
  readonly event: string
  /**
   * What the command prints where the launcher can't run: unset, or set but gone, as a
   * variable that outlives its Novadeck (a plugin is global; tmux carries variables on).
   * Without one it prints nothing there, and exits 0 whatever the launcher did.
   */
  readonly fallback?: string | undefined
  /**
   * For a hook whose answer must never be missing or foreign in a narrowed terminal (one with
   * NOVADECK_NARROW set; `sh` only, since a narrowed terminal is never on Windows): the
   * command captures the launcher's output and prints it only when the launcher exited 0 and
   * printed exactly one of `passes` (its line end allowed); anything else, and a launcher
   * that is missing, prints `answer`. Outside a narrowed terminal it runs as without this.
   */
  readonly narrowed?: { readonly answer: string; readonly passes: readonly string[] } | undefined
}

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

// What cmd's `echo` prints as written, in a parenthesised block: no quote, which the
// harness escapes where cmd keeps the escape, and nothing cmd reads as syntax.
const cmdSafe = /^[^"&|<>^%()\r\n]*$/

/**
 * The command a harness's plugin runs for a hook, in the harness's shell. It runs the
 * launcher Novadeck's shells name in NOVADECK_HOOK, with the agent and the event. Outside
 * Novadeck's shells, or with a launcher set but gone, it prints `fallback`, or nothing,
 * and never fails the harness:
 * - `sh` and `powershell` check the launcher is there first.
 * - `cmd` holds no double quote, and reads the launcher unquoted, as Novadeck's shells name
 *   it by its short name, without spaces. A launcher whose path still has one, or `&`,
 *   which cmd splits a line at once it has put the path in, breaks the line. Without a
 *   fallback the command runs in a cmd of its own (`/d`, so no AutoRun), then exits 0
 *   whatever that did: with no runnable launcher, a broken line included, it prints
 *   nothing. Antigravity's PreToolUse needs that, as an answer that isn't JSON, or a
 *   non-zero exit, let the tool run unasked, where none left it to the person's policy.
 */
export const hookCommand = (
  dialect: Dialect,
  { agent, event, fallback, narrowed }: HookCall,
): string => {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error(`A hook event is a word: ${event}`)
  const run = `${agent} ${event}`
  if (narrowed !== undefined && dialect !== "sh")
    throw new Error("A narrowed hook is sh's: a narrowed terminal is never on Windows")
  switch (dialect) {
    case "sh":
      if (narrowed !== undefined) return narrowedSh(run, fallback, narrowed)
      return fallback === undefined
        ? `[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" ${run} || true`
        : `if [ -x "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" ${run}; else echo ${shQuote(fallback)}; fi`
    case "powershell": {
      const found = `if ($env:NOVADECK_HOOK -and (Test-Path -LiteralPath $env:NOVADECK_HOOK)) { & $env:NOVADECK_HOOK ${run} }`
      return fallback === undefined ? found : `${found} else { ${psQuote(fallback)} }`
    }
    case "cmd": {
      if (fallback === undefined)
        return `cmd /d /c if defined NOVADECK_HOOK (if exist %NOVADECK_HOOK% (%NOVADECK_HOOK% ${run})) & exit /b 0`
      if (!cmdSafe.test(fallback) || fallback.trim() !== fallback || fallback === "")
        throw new Error(`cmd can't echo this hook's fallback as written: ${fallback}`)
      return `if defined NOVADECK_HOOK (if exist %NOVADECK_HOOK% (%NOVADECK_HOOK% ${run}) else (echo ${fallback})) else (echo ${fallback})`
    }
  }
}

// The sh command of a hook with a narrowed answer. `$(...)` strips the launcher's line end, so
// the comparison allows it; the launcher's exit is read from the same assignment.
const narrowedSh = (
  run: string,
  fallback: string | undefined,
  { answer, passes }: NonNullable<HookCall["narrowed"]>,
): string => {
  const cases = passes.map(shQuote).join(" | ")
  const outside =
    fallback === undefined
      ? `[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" ${run} || true`
      : `if [ -x "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" ${run}; else echo ${shQuote(fallback)}; fi`
  const narrow =
    `novadeck_out=$([ -x "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" ${run}) && ` +
    `case "$novadeck_out" in ${cases}) printf '%s\\n' "$novadeck_out"; exit 0;; esac; ` +
    `echo ${shQuote(answer)}`
  return `if [ -n "$NOVADECK_NARROW" ]; then ${narrow}; else ${outside}; fi`
}

/**
 * How much later than elsewhere a hook may reach the runner on `platform`, for the shell
 * it runs in, in milliseconds: on Windows the hook starts in PowerShell (Claude Code,
 * Codex) or cmd (Antigravity), which takes most of 15 s to start cold on a busy CI runner,
 * where a Codex hook dropped for it carried none of the messages waiting; elsewhere a
 * shell starts at once. Every wait on a hook's arrival grows by it.
 */
export const hookShellSlackMs = (platform: NodeJS.Platform): number =>
  platform === "win32" ? 20_000 : 0

/**
 * How long a harness lets one of Novadeck's hooks run, in seconds; one slower is dropped
 * silently. Well above the hook's own limit, so the hook always ends by itself, and more by
 * the time its shell may take to start.
 */
export const hookSeconds = (platform: NodeJS.Platform): number =>
  10 + hookShellSlackMs(platform) / 1000
