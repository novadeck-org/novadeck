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
 * The longest a stop holds wakes off while its agent exits, in milliseconds: its end waits for
 * the agent's processes, which have a few seconds' grace; a wake goes ahead past that.
 */
export const turnMs = 5_000

/**
 * The longest a wake holds stops off while its agent starts, in milliseconds, if it never says
 * it started (its agent bound): its shell, its typed resume and the agent's own start come
 * before the agent opens its store, which takes seconds on a slow Windows host.
 */
export const startMs = 30_000

/** A turn taken: `end` gives it back early; `over` settles once it is given back. */
export type Turn = { readonly end: () => void; readonly over: Promise<void> }

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

/**
 * The turns of Novadeck's own stops and wakes of an agent that shares its store
 * (`sharesStore`): a wake starts once no stop is ending, and a stop ends its agent once no wake
 * is starting. Wakes don't wait for each other, nor stops. A stop's turn lasts until its agent
 * ended or `turnMs`, a wake's until its agent started or `startMs`; a wait can outlast one turn
 * when another of the same kind comes meanwhile.
 */
export class StoreTurns {
  private readonly stops = new Set<Promise<void>>()
  private readonly wakes = new Set<Promise<void>>()

  constructor(
    private readonly stopMs = turnMs,
    private readonly wakeMs = startMs,
  ) {}

  /** Before a wake's shell starts: waits out the stops ending, then holds stops off. */
  async wake(): Promise<Turn> {
    await this.clear(this.stops)
    return this.take(this.wakes, this.wakeMs)
  }

  /** Before a stop ends its agent: waits out the wakes starting, then holds wakes off. */
  async stop(): Promise<Turn> {
    await this.clear(this.wakes)
    return this.take(this.stops, this.stopMs)
  }

  // Checked again after each wait, as another may have taken its turn meanwhile.
  private async clear(holds: Set<Promise<void>>): Promise<void> {
    // eslint-disable-next-line no-await-in-loop -- Until none is left.
    while (holds.size > 0) await Promise.all(holds)
  }

  private take(holds: Set<Promise<void>>, ms: number): Turn {
    let end!: () => void
    const ended = new Promise<void>((resolve) => (end = resolve))
    const over = Promise.race([ended, delay(ms)]).finally(() => holds.delete(over))
    holds.add(over)
    return { end, over }
  }
}
