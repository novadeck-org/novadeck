import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { promisify } from "node:util"

import { hookScript } from "./hook.js"
import { shellFiles, shellPaths, type ShellPaths } from "./scripts.js"

/**
 * The shell files as written, with the launcher as NovaDeck's shells name it in
 * NOVADECK_HOOK: on Windows its short name, which holds no spaces or brackets, so cmd
 * runs it unquoted.
 */
export type InstalledShell = ShellPaths & { readonly launcher: string }

/**
 * Writes the shell integration, hook and agent plugins into NovaDeck's own
 * directory, each only when it changed, replacing it whole so a shell starting at that
 * moment reads the old or the new file.
 */
export const installShellFiles = async (
  directory: string,
  runtime = process.execPath,
): Promise<InstalledShell> => {
  const paths = shellPaths(directory)
  for (const file of shellFiles(paths, runtime, hookScript)) {
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
    // eslint-disable-next-line no-await-in-loop -- As above.
    await rename(temporary, file.path)
  }
  // A resume command left by a runner that stopped before its shell took it is stale.
  await rm(paths.resume, { recursive: true, force: true })
  await mkdir(paths.resume, { recursive: true, mode: 0o700 })
  return { ...paths, launcher: await launcher(paths.hook) }
}

// cmd's `for` gives a file's short name, as Windows keeps one on most volumes; a path
// that still needs quoting stays as it is.
const launcher = async (hook: string): Promise<string> => {
  if (process.platform !== "win32" || /^[\w.:\\-]+$/.test(hook)) return hook
  try {
    // Verbatim, as Node would escape the inner quotes in a way cmd does not read.
    const { stdout } = await promisify(execFile)(
      process.env.COMSPEC || "cmd.exe",
      ["/d", "/s", "/c", `"for %A in ("${hook}") do @echo %~sA"`],
      { windowsHide: true, windowsVerbatimArguments: true },
    )
    const short = stdout.trim()
    return /^[\w.:\\~-]+$/.test(short) ? short : hook
  } catch {
    return hook
  }
}
