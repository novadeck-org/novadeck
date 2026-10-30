import { basename, delimiter } from "node:path"

import { fishQuote, psQuote } from "./quote.js"
import { checked, type ShellScriptPaths } from "./scripts.js"
import { pathKey } from "./windows-path.js"

/**
 * How to start a shell so it loads its integration after the person's own setup;
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

/** Whether the integration for `shell` runs a startup command; see `shellLaunch`. */
export const startsCommands = (shell: string): boolean => startingShells.has(shellName(shell))

export type ShellLaunchOptions = {
  readonly shell: string
  /** Where `shellScripts` wrote the files, under its prefix. */
  readonly scripts: ShellScriptPaths
  readonly env: NodeJS.ProcessEnv
  /** A folder that goes first on PATH, and back there after the person's startup files. */
  readonly pathFirst?: string | undefined
  readonly startup?: { readonly command: string; readonly file: string } | undefined
}

/**
 * Arguments and environment that load the integration for shells it knows, the way VS
 * Code does: bash reads it as its rc file, zsh finds it through ZDOTDIR, fish runs it as
 * an init command, PowerShell dot-sources it after the profile, and cmd reports through
 * its PROMPT. Each first loads the person's own startup files. Other shells start as they
 * are, with `env` and `pathFirst`.
 *
 * A `startup` command runs once as the shell starts, as if typed at its first prompt.
 * The integration reads it from the file <PREFIX>_RESUME names, which it removes, and
 * unsets the variable first, so nothing the command starts runs it again; removing the
 * file first cancels it. bash, zsh and fish run it at the first prompt, PowerShell after
 * its profile. cmd runs the command line with /k.
 */
export const shellLaunch = ({
  shell,
  scripts,
  env,
  pathFirst,
  startup,
}: ShellLaunchOptions): ShellLaunch => {
  const variable = checked(scripts.prefix).toUpperCase()
  const key = pathKey(env)
  const path = env[key]
  const ordered =
    pathFirst === undefined
      ? env
      : {
          ...env,
          [key]: path ? `${pathFirst}${delimiter}${path}` : pathFirst,
          [`${variable}_BIN`]: pathFirst,
        }
  const resuming = startup ? { ...ordered, [`${variable}_RESUME`]: startup.file } : ordered
  const fromFile = { resumes: startup !== undefined, resumeFile: startup?.file }
  switch (shellName(shell)) {
    case "bash":
      return {
        args: ["--init-file", scripts.bash],
        env: resuming,
        integrated: true,
        ...fromFile,
      }
    case "zsh":
      // The person's ZDOTDIR, only when they have one: an unset one reads from home.
      return {
        args: [],
        env: {
          ...resuming,
          ZDOTDIR: scripts.zsh,
          ...(env.ZDOTDIR ? { [`${variable}_ZDOTDIR`]: env.ZDOTDIR } : {}),
        },
        integrated: true,
        ...fromFile,
      }
    case "fish":
      return {
        args: ["--init-command", `source ${fishQuote(scripts.fish)}`],
        env: resuming,
        integrated: true,
        ...fromFile,
      }
    case "pwsh":
    case "powershell":
      // A script policy that forbids the integration leaves the shell as it is.
      return {
        args: ["-NoExit", "-Command", `try { . ${psQuote(scripts.powershell)} } catch {}`],
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
        env: { ...ordered, PROMPT: `$e]9;9;$P$e\\${env.PROMPT || "$P$G"}` },
        integrated: true,
        resumes: startup !== undefined,
      }
    default:
      return { args: [], env: ordered, integrated: false, resumes: false }
  }
}
