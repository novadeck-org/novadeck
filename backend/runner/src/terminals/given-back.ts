import type { HarnessEvent } from "@novadeck/harness-core/events"

/** How long after a Stop gave messages back a hook of theirs may still report. */
const lateMs = 60_000

const nothing = (): void => {}

type Given = {
  /** The words handed back, every message queued behind the turn. */
  readonly words: string
  /** When the Stop began: a hook that started before it told of its message in time. */
  readonly since: number
  readonly until: number
}

/**
 * The messages a Stop took back out of an agent's queue, to tell their prompt hooks that report
 * late. Claude Code runs a queued message's hook as it is queued and, on a Stop, no longer waits
 * for it; where nothing ends the hook's process (Windows, whose PowerShell is still starting it)
 * it goes on and reports a turn begun for a message that never ran, which no Stop would end.
 */
export class GivenBack {
  private readonly given = new Map<string, Given>()
  /** The Stops under way, which a hook that started meanwhile may report before they end. */
  private readonly stopping = new Map<
    string,
    { readonly since: number; readonly ended: Promise<void> }
  >()

  /**
   * A Stop begins at `since`. The returned function ends it, with the words it handed back from
   * the terminal's agent, or null for none.
   */
  begin(terminalId: string, since: number): (words: string | null) => void {
    let end = nothing
    const ended = new Promise<void>((resolve) => (end = resolve))
    const stop = { since, ended }
    this.stopping.set(terminalId, stop)
    return (words) => {
      if (words !== null) this.given.set(terminalId, { words, since, until: Date.now() + lateMs })
      if (this.stopping.get(terminalId) === stop) this.stopping.delete(terminalId)
      end()
    }
  }

  /**
   * Whether the report's `events` start the turn of a message given back, by a hook that started
   * after the Stop did: nothing ran, so the report tells of nothing. A Stop still under way is
   * waited for, as its hook may report before it knows what it hands back.
   */
  async late(terminalId: string, events: readonly HarnessEvent[]): Promise<boolean> {
    const starts = events.filter(
      (event): event is Extract<HarnessEvent, { type: "turn-started" }> =>
        event.type === "turn-started" && (event.cause === "prompt" || event.cause === "doorbell"),
    )
    if (starts.length === 0) return false
    const stop = this.stopping.get(terminalId)
    if (stop && starts.some((event) => event.startedAt >= stop.since)) await stop.ended
    const given = this.given.get(terminalId)
    if (!given) return false
    if (given.until < Date.now()) {
      this.given.delete(terminalId)
      return false
    }
    return starts.some((event) => {
      if (event.startedAt < given.since) return false
      if (event.cause === "doorbell")
        return event.nonce !== undefined && given.words.includes(event.nonce)
      return event.prompt !== undefined && given.words.includes(event.prompt)
    })
  }
}
