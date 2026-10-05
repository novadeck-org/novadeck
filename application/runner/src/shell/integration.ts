import { basename, delimiter } from "node:path"

import type { InstalledShell } from "./install.js"
import { fishQuote, psQuote } from "./scripts.js"

/**
 * How to start a shell so it loads NovaDeck's integration after the user's own setup;
 * `integrated` when it will report its prompts, and `resumes` when it runs the startup
 * command. `resumeFile` is where the caller writes that command for the shell to read.
 */
export type ShellLaunch = {
  /** The shell's arguments, or on Windows its whole command line, which cmd needs as is. */
  readonly args: readonly string[] | string
  readonly env: NodeJS.ProcessEnv
  readonly integrated: boolean
  readonly resumes: boolean
  readonly resumeFile?: string | undefined
}

// "/bin/zsh", "-zsh" and "pwsh.exe" name "zsh" and "pwsh".
const shellName = (shell: string): string =>
  basename(shell.replaceAll("\\", "/"))
    .replace(/^-/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase()

// The shells whose integration runs a startup command.
const startingShells = new Set(["bash", "zsh", "fish", "pwsh", "powershell", "cmd"])

/** Whether NovaDeck's integration for `shell` runs a startup command; see `shellLaunch`. */
export const startsCommands = (shell: string): boolean => startingShells.has(shellName(shell))

// Windows keeps PATH as "Path"; whichever spelling the environment uses is the one to set.
const pathKey = (env: NodeJS.ProcessEnv): string =>
  Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"

/**
 * Arguments and environment that load the integration for shells NovaDeck knows, the
 * way VS Code does: bash reads it as its rc file, zsh finds it through ZDOTDIR, fish
 * runs it as an init command, PowerShell dot-sources it after the profile, and cmd
 * reports through its PROMPT. Each first loads the user's own startup files. Other
 * shells start as they are. Every shell gets the hook's launcher in NOVADECK_HOOK, the
 * MCP server's in NOVADECK_MCP (on Linux and macOS, as `installShellFiles` gives it), and with `shims`
 * the connected harnesses whose shims, as Codex's, go first on PATH.
 *
 * A `startup` command runs once as the shell starts, as if typed at its first prompt:
 * an agent's resume, plain words from the harness's `resume`, or the command line a new
 * terminal was opened with. The integration reads it from the file NOVADECK_RESUME
 * names, which it removes, and unsets the variable first, so nothing the command starts
 * runs it again; removing the file first cancels it. bash, zsh and fish run it at the
 * first prompt, PowerShell after its profile. cmd runs the command line with /k.
 */
export const shellLaunch = (
  shell: string,
  paths: InstalledShell,
  env: NodeJS.ProcessEnv,
  {
    shims = [],
    startup,
  }: {
    readonly shims?: readonly string[]
    readonly startup?: { readonly command: string; readonly file: string } | undefined
  } = {},
): ShellLaunch => {
  const key = pathKey(env)
  const path = env[key]
  // Connected agents' hooks name the launcher through NOVADECK_HOOK; see `hookCommand`.
  // On Linux and macOS their MCP server starts from NOVADECK_MCP, so it is this
  // runner's relay whichever build connected them; see `mcpStart`.
  // With shims, their folder goes first on PATH, and the integration puts it back
  // there after the user's startup files. NOVADECK_SHIMS names the harnesses whose shims
  // apply; any other shim there runs its program unchanged.
  const withHook = {
    ...env,
    NOVADECK_HOOK: paths.launcher,
    ...(paths.mcpLauncher !== undefined && { NOVADECK_MCP: paths.mcpLauncher }),
    ...(shims.length > 0 && {
      [key]: path ? `${paths.bin}${delimiter}${path}` : paths.bin,
      NOVADECK_BIN: paths.bin,
      NOVADECK_SHIMS: shims.join(" "),
    }),
  }
  const resuming = startup ? { ...withHook, NOVADECK_RESUME: startup.file } : withHook
  const fromFile = { resumes: startup !== undefined, resumeFile: startup?.file }
  switch (shellName(shell)) {
    case "bash":
      return {
        args: ["--init-file", paths.bash],
        env: resuming,
        integrated: true,
        ...fromFile,
      }
    case "zsh":
      // The user's ZDOTDIR, only when they have one: an unset one reads from home.
      return {
        args: [],
        env: {
          ...resuming,
          ZDOTDIR: paths.zsh,
          ...(env.ZDOTDIR ? { NOVADECK_ZDOTDIR: env.ZDOTDIR } : {}),
        },
        integrated: true,
        ...fromFile,
      }
    case "fish":
      return {
        args: ["--init-command", `source ${fishQuote(paths.fish)}`],
        env: resuming,
        integrated: true,
        ...fromFile,
      }
    case "pwsh":
    case "powershell":
      // A script policy that forbids the integration leaves the shell as it is.
      return {
        args: ["-NoExit", "-Command", `try { . ${psQuote(paths.powershell)} } catch {}`],
        env: resuming,
        integrated: true,
        ...fromFile,
      }
    case "cmd":
      // $e]9;9;$P$e\ is OSC 9;9 with the current directory, ahead of the usual prompt.
      return {
        // As a raw command line, so the command reaches cmd as typed: with /s, cmd strips
        // only the outer quotes and runs the rest unchanged, inner quotes and all.
        args: startup ? `/s /k "${startup.command}"` : [],
        env: { ...withHook, PROMPT: `$e]9;9;$P$e\\${env.PROMPT || "$P$G"}` },
        integrated: true,
        resumes: startup !== undefined,
      }
    default:
      return { args: [], env: withHook, integrated: false, resumes: false }
  }
}
