import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { isLaunchProgram, launchSettings } from "@novadeck/harness-agy/narrow"

import { harnesses } from "../harnesses/registry.js"

/**
 * What the runner needs of the grants to start Antigravity narrowed (approvals-design.md,
 * Appendix B1): the programs the grants covering a terminal name, as `command(<program>)`
 * launch settings allow them unasked.
 */
export type LaunchGrants = {
  /** The bare program names the live grants covering the terminal name; none when none does. */
  readonly launchPrograms: (terminalId: string) => readonly string[]
}

export type NarrowingOptions = {
  readonly grants: LaunchGrants
  /**
   * Whether Antigravity's installed plugin is verified: connected, byte for byte what this
   * Novadeck renders, with no reinstall pending, and on Windows the relay it runs too. A stale
   * copy may still answer "ask", which under a launch grant runs a program unasked.
   */
  readonly verified: () => Promise<boolean>
}

// A terminal's id names its settings file; anything that could leave the folder is refused.
const safeId = /^[A-Za-z0-9_-]+$/

/** Whether a command line starts Antigravity: its first word is the program it launches as. */
export const startsAgy = (command: string): boolean =>
  command.trim().split(/\s+/)[0] === harnesses.agy.launch.start[0]

/**
 * Antigravity terminals started under a grant. The settings file the agy shim reads exists
 * only for a terminal started, or resumed, while a live grant covers it and the plugin is
 * verified, and the programs it allows are this terminal's launch set: kept in memory, so a
 * terminal the runner no longer knows (after a restart, while Antigravity keeps running) is
 * narrowed with an empty set, and every command asks.
 */
export class Narrowing {
  private readonly sets = new Map<string, ReadonlySet<string>>()
  /** Where the launch settings go (`ShellPaths.narrow`), once the shell files say. */
  private directory: string | undefined

  constructor(private readonly options: NarrowingOptions) {}

  private get enabled(): boolean {
    return this.directory !== undefined
  }

  /**
   * Whether a launch may give grants now; the launch waits behind the harnesses' queue, so a
   * plugin reinstall can't race it. Asked before the shell starts, with `directory`, where
   * the shell files put the launch settings (none without them).
   */
  async verify(directory: string | undefined): Promise<boolean> {
    this.directory = directory
    return this.enabled && (await this.options.verified().catch(() => false))
  }

  /**
   * Writes, or removes, the terminal's launch settings for the agent it is about to start or
   * resume, and keeps its launch set. `verified` is what `verify` said before the shell
   * started; `starts` whether the command it runs is Antigravity. Synchronous, and after the
   * terminal is registered as its lead's teammate: the grants covering it depend on that.
   */
  launch(terminalId: string, verified: boolean, starts: boolean): void {
    const { directory } = this
    this.forget(terminalId)
    if (!verified || !starts || directory === undefined || !this.enabled) return
    if (!safeId.test(terminalId)) return
    const programs = [
      ...new Set(this.options.grants.launchPrograms(terminalId).filter(isLaunchProgram)),
    ]
    if (programs.length === 0) return
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, `${terminalId}.json`), launchSettings(programs), {
        mode: 0o600,
      })
    } catch {
      // No settings, no launch grants: the agent starts as it always did.
      return
    }
    this.sets.set(terminalId, new Set(programs))
  }

  /** The programs the terminal's launch allowed; undefined for one the runner didn't narrow. */
  launchSet(terminalId: string): ReadonlySet<string> | undefined {
    return this.sets.get(terminalId)
  }

  /** The terminals whose agent was started narrowed. */
  narrowed(): readonly string[] {
    return [...this.sets.keys()]
  }

  /** Drops the terminal's launch settings and set, as it closes or starts again. */
  forget(terminalId: string): void {
    this.sets.delete(terminalId)
    const { directory } = this
    if (directory !== undefined && safeId.test(terminalId))
      rmSync(join(directory, `${terminalId}.json`), { force: true })
  }
}
