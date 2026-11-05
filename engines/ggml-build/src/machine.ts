import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The computer the engine is built on, and how the build runs its commands and handles its
// files there.

/** A computer the engine is built on, as the build's rules read it. */
export type Machine = {
  readonly platform: NodeJS.Platform
  readonly arch: string
  /** Where the Vulkan SDK is, when `VULKAN_SDK` names it. */
  readonly vulkanSdk: string | undefined
}

/** This computer. */
export const machine: Machine = {
  platform: process.platform,
  arch: process.arch,
  vulkanSdk: process.env.VULKAN_SDK,
}

export const windows = machine.platform === "win32"
export const macos = machine.platform === "darwin"

// Windows ships bsdtar in System32; the `tar` first on a CI runner's PATH may be GNU tar
// from Git, which reads `C:` in a path as a host name.
export const tarOf = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string =>
  platform === "win32" ? join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"

export const tar = tarOf(machine.platform, process.env)

// The Azure service principal Windows signing authenticates with. Only the signing call is
// given it: CMake, the build and git run upstream's scripts, pinned by commit but not audited.
const credentialNames = new Set(["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"])

/** The environment without the signing credentials (named in any case, as Windows reads them). */
export const withoutCredentials = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !credentialNames.has(name.toUpperCase())),
  )

export const has = (command: string, flag = "--version"): boolean =>
  !spawnSync(command, [flag], { stdio: "ignore", env: withoutCredentials(process.env) }).error

export type Run = (
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
    /** Whether the command is given the signing credentials: only the signing call is. */
    readonly credentials?: boolean
  },
) => void

/**
 * Runs the build's commands in `root` unless told otherwise, without the signing credentials
 * unless told to give them, and throws when one fails.
 */
export const commands =
  (label: string, root: string): Run =>
  (command, args, { cwd = root, env = process.env, credentials = false } = {}) => {
    const result = spawnSync(command, args, {
      cwd,
      env: credentials ? env : withoutCredentials(env),
      stdio: "inherit",
    })
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

/** What the command prints, for a check that reads it; it is run without the signing credentials. */
export const output = (command: string, args: readonly string[]): string => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: withoutCredentials(process.env),
    stdio: ["ignore", "pipe", "inherit"],
  })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
  return result.stdout
}

/** Replaces the file whole, so a reader meanwhile sees the old one or the new one. */
export const replaceFile = async (path: string, data: string | Uint8Array): Promise<void> => {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, path)
}

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex")
