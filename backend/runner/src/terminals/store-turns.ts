import type { AgentName } from "@novadeck/protocol"

/**
 * Whether the agent's sessions share one database on the machine that an exiting process
 * locks as it closes: opencode's (1.19.6), whose start fails at once on that lock ("database
 * is locked") rather than wait, as it sets its wait for a lock only after its first statement
 * (core/src/database/database.ts). Novadeck's own stops and wakes of it take turns
 * (`StoreTurns`), so none of its wakes starts as one of its stops ends.
 */
export const sharesStore = (agent: AgentName | undefined): boolean => agent === "opencode"

/**
 * How long a wake holds stops off while its agent starts, and the longest a stop holds wakes
 * off while its agent exits, in milliseconds: opencode opens its database within a second of
 * starting, on Windows too (seen on CI, 2026-11-23), and a stop ends in under one.
 */
export const turnMs = 5_000

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/**
 * The turns of Novadeck's own stops and wakes of an agent that shares its store
 * (`sharesStore`): a wake starts once no stop is ending, and a stop ends its agent once no wake
 * is starting. Wakes don't wait for each other, nor stops; each hold lasts `turnMs` at most.
 */
export class StoreTurns {
  private readonly stops = new Set<Promise<void>>()
  private readonly wakes = new Set<Promise<void>>()

  constructor(private readonly holdMs = turnMs) {}

  /** Before a wake's shell starts: waits out the stops ending, then holds stops off a while. */
  async wake(): Promise<void> {
    await this.clear(this.stops)
    this.hold(this.wakes, delay(this.holdMs))
  }

  /**
   * Before a stop ends its agent: waits out the wakes starting, then holds wakes off until
   * the returned end is called, once the agent's processes ended, or `turnMs` passed.
   */
  async stop(): Promise<() => void> {
    await this.clear(this.wakes)
    let end!: () => void
    const ended = new Promise<void>((resolve) => (end = resolve))
    this.hold(this.stops, Promise.race([ended, delay(this.holdMs)]))
    return end
  }

  // Checked again after each wait, as another may have taken its turn meanwhile.
  private async clear(holds: Set<Promise<void>>): Promise<void> {
    // eslint-disable-next-line no-await-in-loop -- Until none is left.
    while (holds.size > 0) await Promise.all(holds)
  }

  private hold(holds: Set<Promise<void>>, until: Promise<void>): void {
    const held = until.finally(() => holds.delete(held))
    holds.add(held)
  }
}
