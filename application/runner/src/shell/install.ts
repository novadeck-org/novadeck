import { execFile } from "node:child_process"
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

import { relayPath } from "@novadeck/relay"

import { shellFiles, shellPaths, staleShellFiles, type ShellPaths } from "./scripts.js"

/**
 * The shell files as written, with the launchers as NovaDeck's shells name them: the
 * hook's in NOVADECK_HOOK, on Windows by its short name, which holds no spaces or
 * brackets, so cmd runs it unquoted; and on Linux and macOS the MCP server's in
 * NOVADECK_MCP, which agents' plugins start in its place (see `mcpStart`). Windows'
 * plugins start the relay itself, without a shell to read the variable, so it is unset.
 */
export type InstalledShell = ShellPaths & {
  readonly launcher: string
  readonly mcpLauncher: string | undefined
}

export type InstallOptions = {
  /** The relay to copy in for the launchers; the one `@novadeck/relay` built by default. */
  readonly relay?: string
}

/**
 * Writes the shell integration, hook, relay and agent plugins into NovaDeck's own
 * directory, each only when it changed, replacing it whole so a shell starting at that
 * moment reads the old or the new file.
 */
export const installShellFiles = async (
  directory: string,
  { relay = relayPath }: InstallOptions = {},
): Promise<InstalledShell> => {
  const paths = shellPaths(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Without its relay an agent's hooks and MCP server can't start; shells still work.
  await installRelay(relay, paths.relay).catch((error: unknown) => {
    console.error("NovaDeck's relay is unavailable:", error)
  })
  await Promise.all(staleShellFiles(directory).map((stale) => rm(stale, { force: true })))
  for (const file of shellFiles(paths, process.platform)) {
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
    launcher: await shortName(paths.hook),
    mcpLauncher: process.platform === "win32" ? undefined : paths.mcp,
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
