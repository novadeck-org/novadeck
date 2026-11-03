import { execFile, spawn } from "node:child_process"
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

import { cmdShimName, relayPath } from "@novadeck/relay"

import { logs } from "../log.js"
import { withoutInherited } from "./inherited.js"
import { shellFiles, shellPaths, staleShellFiles, type ShellPaths } from "./scripts.js"

const log = logs.for("shell")

/**
 * The shell files as written, with the launchers as Novadeck's shells name them: the
 * hook's in NOVADECK_HOOK, on Windows by its short name, which holds no spaces or
 * brackets, so cmd runs it unquoted; and on Linux and macOS the MCP server's in
 * NOVADECK_MCP, which agents' plugins start in its place (see `mcpStart`), only once the
 * relay it starts is installed. Windows' plugins start the relay itself, without a shell
 * to read the variable, so it is unset.
 */
export type InstalledShell = ShellPaths & {
  readonly launcher: string
  readonly mcpLauncher: string | undefined
  /**
   * Where cmd prints and Novadeck's cmd.exe pass-through is installed, byte for byte what this
   * Novadeck ships: its folder by a path cmd reads unquoted, which Antigravity's shim puts
   * first on PATH in Novadeck's terminals, so their hooks' answers are read. Absent elsewhere.
   */
  readonly cmdShimDir?: string
}

export type InstallOptions = {
  /** The relay to copy in for the launchers; the one `@novadeck/relay` built by default. */
  readonly relay?: string
  /**
   * The cmd.exe pass-through to install (Windows only); the one beside the relay by default.
   */
  readonly cmdShim?: string
  /** For tests: how to tell whether cmd prints (the machine's own check by default). */
  readonly prints?: typeof cmdPrints
  /** For tests: the platform to write the files for, and how a path is shortened. */
  readonly platform?: NodeJS.Platform
  readonly short?: (path: string) => Promise<string>
}

/**
 * Writes the shell integration, hook, relay and agent plugins into Novadeck's own
 * directory, each only when it changed, replacing it whole so a shell starting at that
 * moment reads the old or the new file.
 */
export const installShellFiles = async (
  directory: string,
  {
    relay = relayPath,
    cmdShim = join(dirname(relay), cmdShimName),
    prints: printing = cmdPrints,
    platform = process.platform,
    short = shortName,
  }: InstallOptions = {},
): Promise<InstalledShell> => {
  const paths = shellPaths(directory, platform)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Without its relay an agent's hooks and MCP server can't start; shells still work, and
  // their agents' MCP server is the connecting build's, as NOVADECK_MCP is left unset.
  const relayed = await installRelay(relay, paths.relay).then(
    () => true,
    (error: unknown) => {
      log.error("relay.unavailable", "Novadeck's relay is unavailable", { err: error })
      return false
    },
  )
  await Promise.all(staleShellFiles(directory).map((stale) => rm(stale, { force: true })))
  // An agent that runs its hooks in cmd reads nothing they answer after cmd's own output.
  const prints = platform === "win32" ? await printing() : undefined
  // Where cmd prints, Antigravity's hooks run through Novadeck's own cmd.exe, which starts the
  // real one with /d for them and so skips the AutoRun: once that is installed and is the
  // shipped one, with a path to put on PATH. Without it, as before.
  const cmdShimDir = prints !== undefined ? await installCmdShim(cmdShim, paths, short) : undefined
  const covered = cmdShimDir !== undefined
  if (prints === "prints")
    log.warn(
      "shell.cmd-prints",
      `Novadeck: cmd prints something of its own before every command, as an AutoRun (HKLM or HKCU\\Software\\Microsoft\\Command Processor\\AutoRun) that doesn't send its output to nul does. Antigravity can read none of its hooks' answers then outside Novadeck's terminals, so Novadeck registers no PreToolUse hook for it (the plugin is global), and installs its plugin again where it is connected; its own policy asks before each tool.${
        covered
          ? " In Novadeck's terminals its other hooks run through Novadeck's own cmd.exe, which skips the AutoRun for them, so messaging works there."
          : " Messaging with it won't work until that output goes."
      }`,
    )
  if (prints === "slow")
    log.warn(
      "shell.cmd-slow",
      `Novadeck: cmd took more than 5 seconds to run a command, as a slow AutoRun (HKLM or HKCU\\Software\\Microsoft\\Command Processor\\AutoRun) may on a cold start, so whether it prints anything of its own isn't known. In case it does, which would let Antigravity's tools run unasked, Novadeck registers no PreToolUse hook for it this time; Antigravity's own policy asks before each tool.${
        covered
          ? " In Novadeck's terminals its other hooks run through Novadeck's own cmd.exe."
          : ""
      } It looks again at the next start.`,
    )
  // A shim a start left while cmd printed is gone once it no longer applies.
  if (!covered) await rm(join(paths.bin, "agy.cmd"), { force: true })
  for (const file of shellFiles(paths, platform, undefined, {
    cmdPrints: prints !== undefined,
    ...(cmdShimDir !== undefined && { cmdShimDir }),
  })) {
    // eslint-disable-next-line no-await-in-loop -- A few small files, one after another.
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 })
    // eslint-disable-next-line no-await-in-loop -- Unchanged files are left alone.
    const current = await readFile(file.path, "utf8").catch(() => undefined)
    if (current === file.content) {
      // eslint-disable-next-line no-await-in-loop -- Keeps the launcher runnable.
      await chmod(file.path, file.mode).catch(() => {})
      continue
    }
    const temporary = `${file.path}.${process.pid}.tmp`
    // eslint-disable-next-line no-await-in-loop -- As above.
    await writeFile(temporary, file.content, { mode: file.mode })
    // eslint-disable-next-line no-await-in-loop -- As above; held a moment on Windows, tried again.
    await settled(() => rename(temporary, file.path))
  }
  // A resume command left by a runner that stopped before its shell took it is stale.
  await rm(paths.resume, { recursive: true, force: true })
  await mkdir(paths.resume, { recursive: true, mode: 0o700 })
  return {
    ...paths,
    launcher: await short(paths.hook),
    mcpLauncher: platform !== "win32" && relayed ? paths.mcp : undefined,
    ...(cmdShimDir !== undefined && { cmdShimDir }),
  }
}

/** Whether the file at `path` is byte for byte the `shipped` one. */
const sameFile = async (shipped: string, path: string): Promise<boolean> => {
  try {
    const [ours, theirs] = await Promise.all([readFile(shipped), readFile(path)])
    return ours.equals(theirs)
  } catch {
    return false
  }
}

/**
 * Installs the cmd.exe pass-through as `cmd.exe` in a folder of its own, as the relay is (an
 * upgrade replaces a copy a previous runner's Antigravity still runs: it is moved aside, so
 * the shim stays in use), and returns that folder by a path cmd reads unquoted when the
 * installed copy is the shipped one byte for byte; else undefined, and Antigravity's hooks
 * run as they did. The folder holds nothing else, so putting it first on PATH shadows no
 * other program.
 */
const installCmdShim = async (
  shipped: string,
  paths: ShellPaths,
  short: (path: string) => Promise<string>,
): Promise<string | undefined> => {
  try {
    await mkdir(paths.agyCmdDir, { recursive: true, mode: 0o700 })
    await installRelay(shipped, paths.agyCmd)
    if (!(await sameFile(shipped, paths.agyCmd))) {
      log.warn("shell.cmd-shim-differs", "Novadeck's cmd.exe pass-through is not the shipped one")
      return undefined
    }
    const folder = await short(paths.agyCmdDir)
    return /^[\w.:\\~-]+$/.test(folder) ? folder : undefined
  } catch (error) {
    log.warn("shell.cmd-shim-unavailable", "Novadeck's cmd.exe pass-through is unavailable", {
      err: error,
    })
    return undefined
  }
}

/**
 * Copies the relay to `path` when it differs. Agents run the copy for as long as their
 * sessions last, so it is replaced, never written over: where it runs, the new copy is
 * renamed over it, which POSIX allows, and Windows once the running one is moved aside;
 * copies moved aside earlier go once nothing runs them.
 */
export const installRelay = async (
  relay: string,
  path: string,
  { platform = process.platform, files = relayFiles }: RelayInstall = {},
): Promise<void> => {
  const [binary, current] = await Promise.all([
    files.readFile(relay),
    files.readFile(path).catch(() => undefined),
  ])
  const folder = dirname(path)
  const aside = `${basename(path)}.old-`
  for (const name of await files.readdir(folder)) {
    if (!name.startsWith(aside)) continue
    // eslint-disable-next-line no-await-in-loop -- Rarely more than one; a running one stays.
    await files.rm(join(folder, name), { force: true }).catch(() => {})
  }
  if (current !== undefined && Buffer.from(current).equals(binary)) {
    await files.chmod(path, 0o700)
    return
  }
  const temporary = `${path}.${process.pid}.tmp`
  await files.writeFile(temporary, binary, { mode: 0o700 })
  const moved =
    platform === "win32" && current !== undefined && join(folder, `${aside}${Date.now()}`)
  if (moved) await files.rename(path, moved)
  try {
    await settled(() => files.rename(temporary, path))
  } catch (error) {
    // The running copy goes back, so agents keep a relay until the next start.
    if (moved) await files.rename(moved, path).catch(() => {})
    await files.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** What installing the relay touches, for tests. */
type RelayFiles = {
  readFile(path: string): Promise<Uint8Array>
  readdir(path: string): Promise<string[]>
  rm(path: string, options: { force: true }): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  writeFile(path: string, data: Uint8Array, options: { mode: number }): Promise<void>
  rename(from: string, to: string): Promise<void>
}

type RelayInstall = { readonly platform?: NodeJS.Platform; readonly files?: RelayFiles }

const relayFiles: RelayFiles = { readFile, readdir, rm, chmod, writeFile, rename }

// Windows refuses a rename for a moment while something, as a virus scanner, holds the
// file just written; a few tries a little apart see it through.
const settled = async (move: () => Promise<void>, tries = 5): Promise<void> => {
  try {
    await move()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (tries <= 1 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error
    await new Promise((resolve) => setTimeout(resolve, 100))
    await settled(move, tries - 1)
  }
}

/**
 * Whether cmd prints something of its own before a command, as it runs a hook: `rem`,
 * which prints nothing, run without `/d`, as an agent runs it, so the machine's and the
 * person's AutoRun runs first. "prints" where anything came out, whatever cmd exited with,
 * as an AutoRun that leaves an error level; "slow" where cmd ran past `timeoutMs`, which
 * may yet print; undefined where it printed nothing, or didn't start, and runs no hook
 * either. It answers once cmd's output closes, or by `timeoutMs` whatever cmd leaves
 * running: "slow" where a process the AutoRun started holds that output open, as what
 * cmd printed can't be known to have been read whole. It gets the runner's environment
 * without what
 * children never inherit, as the AutoRun is the person's own code. `program` and `args`
 * are for tests.
 */
export const cmdPrints = ({
  program = process.env.COMSPEC || "cmd.exe",
  args = ["/c", "rem"],
  timeoutMs = 5_000,
}: {
  readonly program?: string
  readonly args?: readonly string[]
  readonly timeoutMs?: number
} = {}): Promise<"prints" | "slow" | undefined> =>
  new Promise((resolve) => {
    let printed = false
    const child = spawn(program, args, {
      env: withoutInherited(process.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(printed ? "prints" : "slow")
    }, timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve(printed ? "prints" : undefined)
    }
    child.stdout.on("data", () => {
      printed = true
    })
    // Not started: no hook runs either.
    child.on("error", () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on("close", done)
  })

// cmd's `for` gives a path's short name, as Windows keeps one on most volumes; a path
// that still needs quoting stays as it is.
const shortName = async (path: string): Promise<string> => {
  if (process.platform !== "win32" || /^[\w.:\\-]+$/.test(path)) return path
  try {
    // Verbatim, as Node would escape the inner quotes in a way cmd does not read.
    const { stdout } = await promisify(execFile)(
      process.env.COMSPEC || "cmd.exe",
      ["/d", "/s", "/c", `"for %A in ("${path}") do @echo %~sA"`],
      { windowsHide: true, windowsVerbatimArguments: true },
    )
    const short = stdout.trim()
    return /^[\w.:\\~-]+$/.test(short) ? short : path
  } catch {
    return path
  }
}
