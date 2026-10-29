import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The computer the engine is built on, and how the build runs its commands and handles its
// files there.

export const windows = process.platform === "win32"
export const macos = process.platform === "darwin"

// Windows ships bsdtar in System32; the `tar` first on a CI runner's PATH may be GNU tar
// from Git, which reads `C:` in a path as a host name.
export const tar = windows
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar"

export const has = (command: string, flag = "--version"): boolean =>
  !spawnSync(command, [flag], { stdio: "ignore" }).error

export type Run = (
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) => void

/** Runs the build's commands in `root` unless told otherwise, and throws when one fails. */
export const commands =
  (label: string, root: string): Run =>
  (command, args, { cwd = root, env = process.env } = {}) => {
    const result = spawnSync(command, args, { cwd, env, stdio: "inherit" })
    if (result.error) {
      const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      throw new Error(
        missing
          ? `Building the ${label} needs ${command} on the PATH.`
          : `${command} failed to start: ${result.error.message}`,
      )
    }
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
  }

/** Replaces the file whole, so a reader meanwhile sees the old one or the new one. */
export const replaceFile = async (path: string, data: string | Uint8Array): Promise<void> => {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")
