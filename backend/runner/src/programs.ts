import { spawn } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { extname, join, posix, win32 } from "node:path"

// A variable of a Windows environment by name, whatever its case: a copy of `process.env`
// keeps Windows' own spelling, such as `ComSpec`.
const variable = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env)
    .filter((each) => each.toUpperCase() === name)
    .toSorted()[0]
  return key === undefined ? undefined : env[key]
}

/**
 * The PATH of `env`. On Windows names have no case, and a child gets the one of several
 * spellings that sorts first, as Node passes it on, so that is the one searched.
 */
const pathOf = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string =>
  (platform === "win32" ? variable(env, "PATH") : env.PATH) ?? ""

/**
 * Where `name` is on the PATH of `env`, as an absolute path; undefined when no absolute
 * entry of it holds the program. Windows (libuv's search and cmd's alike) looks in the
 * working folder before PATH, so a program named without a path would run a `git.exe` or a
 * `claude.cmd` that a cloned repository brings along: callers run this path instead. A
 * relative entry is skipped for the same reason. On Windows the name takes each of
 * `extensions` (PATHEXT's by default) in turn, and is tried bare only when it has one of its
 * own, so npm's extensionless sh script beside `claude.cmd` is never taken for it.
 */
export const findProgram = (
  name: string,
  {
    env = process.env,
    platform = process.platform,
    extensions,
  }: {
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
    /** On Windows, the extensions to try; PATHEXT's when omitted. */
    readonly extensions?: readonly string[]
  } = {},
): string | undefined => {
  const windows = platform === "win32"
  const absolute = windows ? win32.isAbsolute : posix.isAbsolute
  const suffixes = windows
    ? [
        ...(extname(name) === "" ? [] : [""]),
        // Windows' names have no case; lower case finds them where a test stands in for it.
        ...(extensions ?? (variable(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";"))
          .filter(Boolean)
          .map((extension) => extension.toLowerCase()),
      ]
    : [""]
  for (const entry of pathOf(env, platform).split(windows ? ";" : ":")) {
    // Windows' PATH may quote a folder.
    const folder = windows ? entry.trim().replace(/^"(.*)"$/, "$1") : entry
    if (folder === "" || !absolute(folder)) continue
    for (const suffix of suffixes) {
      const candidate = join(folder, `${name}${suffix}`)
      try {
        if (!statSync(candidate).isFile()) continue
        if (!windows) accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here, or not runnable.
      }
    }
  }
  return undefined
}

/** Windows' own cmd.exe, by its absolute path, never one in the working folder. */
export const cmdPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const named = variable(env, "COMSPEC")
  if (named && win32.isAbsolute(named)) return named
  return `${variable(env, "SYSTEMROOT") ?? "C:\\Windows"}\\System32\\cmd.exe`
}

/**
 * Ends a process and what it started: its whole group on POSIX, so the child must have been
 * spawned `detached`, and its tree on Windows, where ending cmd.exe alone leaves the program
 * it ran going.
 */
export const killTree = (pid: number | undefined, platform = process.platform): void => {
  if (pid === undefined) return
  if (platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`
    spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      .on("error", () => {})
      .unref()
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}
