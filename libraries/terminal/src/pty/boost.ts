import { withBelow, type Listing } from "./descendants.js"
import type { Priority } from "./priority.js"
import { activeCpuWeight, terminalCpuWeight, type Scope } from "./scopes.js"
import type { Member } from "./trees.js"

/**
 * Who knows which terminals the person is using, as the runner tells its ptys: each pty
 * registers by its terminal's id and is told at once, and on each change, whether its
 * terminal is the one in use. The stop ends the registration.
 */
export type Activity = {
  register(terminalId: string, set: (active: boolean) => void): () => void
}

/** A pty's share of the machine, normal while its terminal is in use and lowered otherwise. */
export type Boost = {
  /** Whether it is raised now, or about to be: a program started now starts raised. */
  readonly active: boolean
  set(active: boolean): void
  /**
   * The shell's pid has become known: a terminal in use since before then, when nothing could
   * be changed, is raised now.
   */
  known(): void
}

export type BoostParts = {
  readonly scope: Pick<Scope, "weigh"> | undefined
  readonly priority: Priority | undefined
  readonly platform: NodeJS.Platform
  /** The shell's pid, once known. */
  readonly shell: () => number | undefined
  /** Whether its program still runs. */
  readonly running: () => boolean
  /** A Windows shell's programs, as the relay reads them. */
  readonly trees?: { read(root: number): Promise<readonly Member[] | undefined> }
  /** Linux's and macOS's process list. */
  readonly listing?: Listing
}

/** The shell and every process under it now, as far as they can be told; never rejects. */
const programsOf = async (parts: BoostParts, shell: number): Promise<readonly number[]> => {
  try {
    if (parts.platform === "win32")
      return [shell, ...((await parts.trees?.read(shell)) ?? []).map((member) => member.pid)]
    const rows = await parts.listing?.()
    const root = rows?.find((row) => row.pid === shell)
    return rows && root
      ? withBelow(rows, [root])
          .filter((row) => !row.zombie)
          .map((row) => row.pid)
      : [shell]
  } catch {
    return [shell]
  }
}

/**
 * Where a scope is there, the terminal's whole tree weighs `activeCpuWeight` while it is in
 * use and `terminalCpuWeight` otherwise. Where priorities are, the shell and every process
 * under it now go to normal and back below it; what starts under them meanwhile inherits
 * the class they have. A process that ended or isn't ours to change is skipped.
 */
export const boosting = (parts: BoostParts): Boost => {
  let active = false
  const apply = (): void => {
    if (!parts.running()) return
    void parts.scope?.weigh(active ? activeCpuWeight : terminalCpuWeight)
    const { priority } = parts
    const shell = parts.shell()
    if (!priority || shell === undefined) return
    void programsOf(parts, shell).then((pids) => {
      // The state when the list came, as it may have changed meanwhile.
      for (const pid of new Set(pids))
        if (active) priority.raise(pid)
        else priority.lower(pid)
    })
  }
  return {
    get active() {
      return active
    },
    set(next) {
      if (next === active) return
      active = next
      apply()
    },
    known() {
      if (active) apply()
    },
  }
}
