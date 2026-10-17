import type { TerminalChange, TerminalSummary } from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

/** One `terminals.watch` stream: every terminal's summary, `synced`, then later changes. */
export class TerminalWatcher {
  private readonly watcher: KeyedChanges<string, TerminalChange>

  constructor(terminals: readonly TerminalSummary[]) {
    this.watcher = new KeyedChanges<string, TerminalChange>(
      terminals.map((terminal) => [terminal.id, { type: "changed", terminal }] as const),
      { type: "synced" },
    )
  }

  changed(terminal: TerminalSummary): void {
    this.watcher.changed(terminal.id, { type: "changed", terminal })
  }

  removed(terminal: Pick<TerminalSummary, "id" | "sessionId">): void {
    this.watcher.removed(terminal.id, {
      type: "removed",
      terminalId: terminal.id,
      sessionId: terminal.sessionId,
    })
  }

  finish(): void {
    this.watcher.finish()
  }

  next(): Promise<TerminalChange | undefined> {
    return this.watcher.next()
  }
}
