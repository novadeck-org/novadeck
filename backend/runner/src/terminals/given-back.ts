import type { HarnessEvent } from "@novadeck/harness-core/events"

/** How long after a Stop gave messages back a hook of theirs may still report. */
const lateMs = 60_000

/**
 * How long past the Stop's end a hook may have fired and still be one of the messages it gave
 * back: the person sends the words again only after the Stop told them back, longer than this.
 */
const graceMs = 1_500

/** The most a report waits for a Stop under way, which is bound by itself in any case. */
const waitMs = 5_000

const nothing = (): void => {}

type Given = {
  /** The words handed back, every message queued behind the turn. */
  readonly lines: readonly string[]
  /** When the Stop began and ended: a hook fired between (and just after) is of a message in it. */
  readonly since: number
  readonly endedAt: number
  readonly until: number
  /** The messages already told of, each once. */
  readonly used: Set<string>
}

/** A text with its white space made single spaces: a box wraps rows where a message does not. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim()

/**
 * Whether `rows` of the box hold `message` whole: from a row's start to a row's end, however the
 * box wrapped it over rows.
 */
const holds = (rows: readonly string[], message: string): boolean => {
  const want = flat(message)
  if (want === "") return false
  return rows.some((_, from) => {
    let have = ""
    for (let row = from; row < rows.length && have.length <= want.length; row += 1) {
      have = flat(`${have} ${rows[row]}`)
      if (have === want) return true
    }
    return false
  })
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
      const endedAt = Date.now()
      if (words !== null)
        this.given.set(terminalId, {
          lines: words.split("\n").map((line) => line.trim()),
          since,
          endedAt,
          until: endedAt + lateMs,
          used: new Set(),
        })
      if (this.stopping.get(terminalId) === stop) this.stopping.delete(terminalId)
      end()
    }
  }

  /** Novadeck sent `text` to the terminal's agent: a hook of it is the send's, not a message given back. */
  sent(terminalId: string, text: string): void {
    this.given.get(terminalId)?.used.add(flat(text))
  }

  /** The terminal is gone: what it was given back goes with it. */
  forget(terminalId: string): void {
    this.given.delete(terminalId)
    this.stopping.delete(terminalId)
  }

  /**
   * Whether the report's `events` start the turn of a message given back, by a hook fired
   * after the Stop began and not after its end (give or take `graceMs`): nothing ran, so the
   * report tells of nothing. A message is told of once; the person's own sending of the same
   * words fires after the Stop ended. A Stop still under way is waited for, as its hook may
   * report before it knows what it hands back.
   */
  async late(terminalId: string, events: readonly HarnessEvent[]): Promise<boolean> {
    const starts = events.filter(
      (event): event is Extract<HarnessEvent, { type: "turn-started" }> =>
        event.type === "turn-started" && (event.cause === "prompt" || event.cause === "doorbell"),
    )
    if (starts.length === 0) return false
    // Reported after the Stop began (a hook's shell may fire it long before, as it is queued),
    // and fired no later than its end: a resend fires after.
    const reportedAfter = (since: number, event: (typeof starts)[number]) =>
      event.startedAt >= since
    const firedBy = (until: number, event: (typeof starts)[number]) =>
      (event.firedAt ?? event.startedAt) <= until
    const stop = this.stopping.get(terminalId)
    if (stop && starts.some((event) => reportedAfter(stop.since, event)))
      await Promise.race([
        stop.ended,
        new Promise((resolve) => setTimeout(resolve, waitMs).unref()),
      ])
    const given = this.given.get(terminalId)
    if (!given) return false
    if (given.until < Date.now()) {
      this.given.delete(terminalId)
      return false
    }
    let late = false
    for (const event of starts) {
      if (!reportedAfter(given.since, event) || !firedBy(given.endedAt + graceMs, event)) continue
      const key = event.cause === "doorbell" ? event.nonce : event.prompt
      if (key === undefined || given.used.has(flat(key))) continue
      const told =
        event.cause === "doorbell"
          ? given.lines.some((line) => line.includes(key))
          : holds(given.lines, key)
      if (!told) continue
      given.used.add(flat(key))
      late = true
    }
    return late
  }
}
