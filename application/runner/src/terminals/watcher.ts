import type { TerminalChange, TerminalSummary } from "@novadeck/protocol"

/**
 * One `terminals.watch` stream: every terminal's summary, `synced`, then later changes.
 * It holds at most one pending change per terminal, so a slow reader receives the latest
 * summary instead of every step, and a terminal it never saw leaves without a `removed`.
 */
export class Watcher {
  private readonly initial: TerminalChange[]
  /** Terminals reported to the reader, including those still waiting in `initial`. */
  private readonly known: Set<string>
  private readonly pending = new Map<string, TerminalChange>()
  private finished = false
  private wake: (() => void) | undefined

  constructor(terminals: readonly TerminalSummary[]) {
    this.initial = [
      ...terminals.map((terminal): TerminalChange => ({ type: "changed", terminal })),
      { type: "synced" },
    ]
    this.known = new Set(terminals.map((terminal) => terminal.id))
  }

  changed(terminal: TerminalSummary): void {
    this.queue(terminal.id, { type: "changed", terminal })
  }

  removed(terminal: Pick<TerminalSummary, "id" | "sessionId">): void {
    if (this.known.has(terminal.id)) {
      this.queue(terminal.id, {
        type: "removed",
        terminalId: terminal.id,
        sessionId: terminal.sessionId,
      })
      return
    }
    this.pending.delete(terminal.id)
  }

  /** Ends the stream, dropping anything not yet read. */
  finish(): void {
    this.finished = true
    this.initial.length = 0
    this.pending.clear()
    this.notify()
  }

  async next(): Promise<TerminalChange | undefined> {
    while (true) {
      const first = this.initial.shift()
      if (first) return first
      const [entry] = this.pending
      if (entry) {
        const [id, change] = entry
        this.pending.delete(id)
        if (change.type === "removed") this.known.delete(id)
        else this.known.add(id)
        return change
      }
      if (this.finished) return undefined
      // eslint-disable-next-line no-await-in-loop -- Wait for the next change.
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  /** Moves the terminal to the back of the queue, so older changes are read first. */
  private queue(id: string, change: TerminalChange): void {
    if (this.finished) return
    this.pending.delete(id)
    this.pending.set(id, change)
    this.notify()
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
