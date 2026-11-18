import type { Activity } from "@novadeck/terminal/pty"

/** How long changes of the terminals in use gather before they reach the system. */
export const activeDelayMs = 150

/**
 * The terminals the person is using, one for each connected window (a session of the wire),
 * and what runs at normal CPU share for them: each pty registers by its terminal's id
 * (`Activity`) and is told whether that terminal is one of them. A window's report replaces
 * its last, and lapses when its connection does, so nothing stays raised for a window that
 * went away. Changes are applied together, at most once for each `activeDelayMs`, however
 * fast a person flips between terminals, so the system sees one call per terminal that
 * really changed: a terminal the person passed through and left in between is never touched.
 */
export class ActiveTerminals implements Activity {
  /** Each window's terminal, as it last said. */
  private readonly wanted = new Map<string, string>()
  /** The terminals told they are in use. */
  private readonly told = new Set<string>()
  private readonly ptys = new Map<string, Set<(active: boolean) => void>>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly delayMs = activeDelayMs) {}

  /** Window `window` uses terminal `terminalId`, or none. */
  report(window: string, terminalId: string | null): void {
    if (terminalId === null) this.wanted.delete(window)
    else this.wanted.set(window, terminalId)
    this.schedule()
  }

  /** The window has gone: its terminal is no longer in use for it. */
  release(window: string): void {
    if (this.wanted.delete(window)) this.schedule()
  }

  register(terminalId: string, set: (active: boolean) => void): () => void {
    const group = this.ptys.get(terminalId) ?? new Set()
    this.ptys.set(terminalId, group)
    group.add(set)
    if (this.told.has(terminalId)) set(true)
    return () => {
      group.delete(set)
      if (group.size === 0 && this.ptys.get(terminalId) === group) this.ptys.delete(terminalId)
    }
  }

  /** Stops waiting to apply changes, as the runner closes. */
  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.apply()
    }, this.delayMs)
    this.timer.unref()
  }

  private apply(): void {
    const now = new Set(this.wanted.values())
    // Those that leave first, so a switch never has two raised at once.
    for (const id of [...this.told].filter((each) => !now.has(each))) this.tell(id, false)
    for (const id of [...now].filter((each) => !this.told.has(each))) this.tell(id, true)
  }

  private tell(terminalId: string, active: boolean): void {
    if (active) this.told.add(terminalId)
    else this.told.delete(terminalId)
    for (const set of this.ptys.get(terminalId) ?? [])
      try {
        set(active)
      } catch {
        // One pty's failure leaves the others.
      }
  }
}
