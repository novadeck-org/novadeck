import { constants, setPriority } from "node:os"

/**
 * How far a terminal's programs yield the CPU to the app's window on macOS and Windows:
 * "below normal". On macOS that is nice 10, on Windows BELOW_NORMAL_PRIORITY_CLASS, and a
 * program's children inherit either one when they start (CreateProcess hands on its
 * caller's class by default), so the agent and all it runs sit below the window. Agents'
 * builds and test runs in many terminals at once otherwise starve it, and every hover, key
 * and scroll lags. Where the CPU is idle, the terminals' programs still have all of it.
 * Linux has `terminalCpuWeight` instead.
 */
export const terminalPriority = constants.priority.PRIORITY_BELOW_NORMAL

/**
 * The priority a terminal's programs run at on `platform`, undefined to leave them at the
 * app's. Not on Linux, scopes or none: where scopes work, their CPU weight does this, and
 * a second penalty on top would starve terminals beside other desktop apps; where they
 * don't (no systemd, no user bus), nice does nothing across terminals, as the kernel's
 * autogroups, on by default in desktop distributions, share the CPU between sessions (each
 * terminal is one) and nice only orders programs within a session.
 */
export const priorityFor = (platform: NodeJS.Platform): number | undefined =>
  platform === "darwin" || platform === "win32" ? terminalPriority : undefined

/**
 * Lowers programs' priority as they start, and gives it back to those of the terminal the
 * person is using; it never throws. Windows lets a program's class be raised again by its
 * owner; macOS lets only root lower a nice value, so there a raise is refused and skipped,
 * and a program stays below normal.
 */
export type Priority = {
  lower(pid: number): void
  raise(pid: number): void
}

/**
 * The priority lowering for `platform`, `set` being `os.setPriority` unless a test plays
 * it; undefined where programs keep the app's (see `priorityFor`). A program that has
 * ended, or one the system won't let it touch, is left as it is: no terminal fails for it.
 */
export const terminalPriorities = (
  platform: NodeJS.Platform = process.platform,
  set: (pid: number, priority: number) => void = setPriority,
): Priority | undefined => {
  const priority = priorityFor(platform)
  if (priority === undefined) return undefined
  const change = (pid: number, to: number): void => {
    try {
      set(pid, to)
    } catch {
      // Gone already, or not ours to change.
    }
  }
  return {
    lower: (pid) => change(pid, priority),
    raise: (pid) => change(pid, constants.priority.PRIORITY_NORMAL),
  }
}
