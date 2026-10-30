import { maxTurnError, replyPreviewLength } from "@novadeck/protocol"
import type { AgentActivity } from "@novadeck/protocol"

import { escapeVerdictMs, summary as activitySummary } from "../harnesses/activity.js"
import type { LastTurn } from "../harnesses/activity.js"
import { logs } from "../log.js"
import type { Inbox, TurnFields, TurnOwner } from "../messaging/inbox.js"
import type { Record } from "./record.js"
import type { TranscriptRedactor } from "./redaction.js"

const log = logs.for("inbox")

/**
 * How long a completed end waits before it is stored: a harness that took the person's
 * Escape just after its reply fires its Stop, then records the interruption within about
 * half a second of the key (docs/harness-coverage.md), and the end is only a finish if it
 * still stands then. Mirrors the client's constant of the same name (core's `agents/finish`).
 */
export const finishGraceMs = 700

/** What the recorder reaches beyond the bindings: the Inbox's entries and the redactor. */
export type TurnsHost = {
  readonly inbox: Inbox
  /** Absent where records are off: the text is kept as it is, and nothing persists there. */
  readonly redactor: TranscriptRedactor | undefined
}

export type TurnEndsHost = {
  readonly turns: () => TurnsHost
  /** Whose the terminal's agent session is, for an entry; undefined while none is known. */
  readonly owner: (terminalId: string) => TurnOwner | undefined
}

/** An end the recorder has seen: waiting out its grace, being stored, or stored. */
type Seen = {
  readonly at: number
  readonly record: Record
  readonly owner: TurnOwner
  outcome: "completed" | "failed"
  reply: string | null
  error: string | null
  files: readonly string[]
  /** The end turned out otherwise (interrupted, unknown, limited): nothing is stored. */
  corrected: boolean
  /** Its binding ended: it is stored without waiting, whatever is shown there now. */
  flushed: boolean
  /** Its text is being redacted. */
  settling: boolean
  /** Its entry exists. */
  row: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  /** The text as last redacted, with what it was redacted from. */
  masked: (Text & { from: string }) | undefined
}

/** The text of an end that is stored: all of it redacted. */
type Text = { reply: string | null; error: string | null }

type Ends = {
  readonly seen: Map<number, Seen>
  /** The end last looked at, stored or not, so one is decided once. */
  considered: number | undefined
}

/** One line for the redactor, which reads its text as a screen would: no control characters. */
// eslint-disable-next-line no-control-regex -- Control characters are what it removes.
const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim()

const key = (seen: Seen): string => JSON.stringify([seen.reply, seen.error])
const raw = (seen: Seen): string =>
  JSON.stringify([seen.outcome, seen.reply, seen.error, seen.files])

/**
 * Stores each completed or failed turn end of an agent as an Inbox entry (`Inbox.recordTurn`),
 * where it stays until the person reads it. A failed end is stored at once; a completed one
 * after `finishGraceMs`, once the agent is not working and no Escape's verdict is due, so an
 * end the harness then corrects to an interruption is never stored. An end an Escape settled
 * waits the verdict's window out too. Ends with a request waiting on the person, ends
 * that were interrupted, are unknown or hit a usage limit (a state, not an entry), and ends
 * of an agent that bound no Inbox owner are not stored.
 *
 * An end whose binding ends within its grace is stored all the same, by `flush`, without
 * its text until that is redacted. The text (`reply`, `error`) goes through the transcript
 * redactor first and is stored as nothing where that fails.
 */
export class TurnEnds {
  private readonly ends = new Map<string, Ends>()
  constructor(private readonly host: TurnEndsHost) {}

  /** Looks at what the terminal's agent shows now: never throws, as it runs on the report path. */
  sight(record: Record, activity: AgentActivity | null): void {
    try {
      this.look(record, activity)
    } catch (error) {
      log.error("inbox.turn-failed", "Novadeck could not record a finished turn", { err: error })
    }
  }

  /**
   * The binding of the terminal ended: the ends still in their grace are stored now, as
   * the harness can say no more of them, unless one corrected them already. It never reads
   * the record's binding, which has ended or been replaced by now.
   */
  flush(terminalId: string): void {
    try {
      const ends = this.ends.get(terminalId)
      if (!ends) return
      const { inbox } = this.host.turns()
      for (const seen of ends.seen.values()) {
        if (seen.corrected || seen.flushed || seen.row) continue
        clearTimeout(seen.timer)
        seen.timer = undefined
        seen.flushed = true
        if (!inbox.accepts(terminalId)) continue
        this.write(seen, { reply: null, error: null })
        // The text follows once redacted, if Inbox is still open then.
        if (!seen.settling) void this.settle(seen)
      }
      this.ends.delete(terminalId)
    } catch (error) {
      log.error("inbox.turn-failed", "Novadeck could not record a finished turn", { err: error })
    }
  }

  private look(record: Record, activity: AgentActivity | null): void {
    const id = record.summary.id
    const last = record.bound?.activity.lastTurn
    if (!last || !activity || activity.state === "working") return
    const { inbox } = this.host.turns()
    const ends = this.ends.get(id) ?? { seen: new Map<number, Seen>(), considered: undefined }
    if (!inbox.accepts(id)) {
      for (const seen of ends.seen.values()) this.retire(seen)
      this.ends.delete(id)
      return
    }
    this.ends.set(id, ends)
    const at = last.at
    const stored = last.outcome === "completed" || last.outcome === "failed"
    const ok = stored && !last.limited
    // Another end replaces one still in its grace, as the Escape's correction does.
    for (const seen of ends.seen.values())
      if (seen.at !== at && this.waiting(seen)) this.retire(seen)
    // Older ends stored, or given up with nothing stored, are not kept: `considered` holds the rest.
    for (const seen of ends.seen.values())
      if (seen.at < at && (seen.row || seen.corrected) && !seen.settling) ends.seen.delete(seen.at)
    const known = ends.seen.get(at)
    if (known) {
      this.update(known, last, ok, id, inbox)
      return
    }
    if (ends.considered === at) return
    ends.considered = at
    // A request that holds the agent replaces its end; one asked without waiting doesn't.
    if (!ok || activity.attention.pending > (activity.attention.detached ?? 0)) return
    const owner = this.host.owner(id)
    if (!owner) return
    const seen: Seen = {
      at,
      record,
      owner,
      outcome: last.outcome === "failed" ? "failed" : "completed",
      reply: last.reply,
      error: last.error ?? null,
      files: [...last.files],
      corrected: false,
      flushed: false,
      settling: false,
      row: false,
      timer: undefined,
      masked: undefined,
    }
    ends.seen.set(at, seen)
    if (seen.outcome === "failed") {
      void this.settle(seen)
      return
    }
    // An end the Escape settled still waits for the harness's interruption record.
    const verdict = last.escaped?.settled ? last.escaped.key + escapeVerdictMs - Date.now() : 0
    seen.timer = setTimeout(() => this.due(seen), Math.max(finishGraceMs, verdict))
    seen.timer.unref()
  }

  /** The same end told again: it fills in its reply, error and files, or is corrected. */
  private update(seen: Seen, last: LastTurn, ok: boolean, id: string, inbox: Inbox): void {
    if (seen.corrected) return
    if (!ok) {
      this.retire(seen)
      inbox.amendTurn(id, seen.at, null)
      return
    }
    const before = raw(seen)
    this.take(seen, last)
    if (raw(seen) !== before && seen.row && !seen.settling) void this.settle(seen)
  }

  private take(seen: Seen, last: LastTurn): void {
    seen.outcome = last.outcome === "failed" ? "failed" : "completed"
    seen.reply = last.reply
    seen.error = last.error ?? null
    seen.files = [...last.files]
  }

  /** Whether the end sits in its grace, with nothing stored of it. */
  private waiting(seen: Seen): boolean {
    return !seen.row && !seen.flushed && !seen.settling && !seen.corrected
  }

  /** Gives the end up: nothing is stored of it. */
  private retire(seen: Seen): void {
    seen.corrected = true
    clearTimeout(seen.timer)
    seen.timer = undefined
  }

  /** The grace is over: the end is stored if its agent still shows it, resting. */
  private due(seen: Seen): void {
    seen.timer = undefined
    try {
      if (!this.waiting(seen)) return
      const { bound } = seen.record
      if (bound) {
        const live = bound.activity.lastTurn
        if (
          !live ||
          live.at !== seen.at ||
          live.outcome !== "completed" ||
          live.limited ||
          (live.escaped && !live.escaped.settled) ||
          activitySummary(bound.activity).state === "working"
        ) {
          this.retire(seen)
          return
        }
        this.take(seen, live)
      }
      void this.settle(seen)
    } catch (error) {
      log.error("inbox.turn-failed", "Novadeck could not record a finished turn", { err: error })
    }
  }

  /** Redacts the end's text and stores it, again while it changes meanwhile. */
  private async settle(seen: Seen): Promise<void> {
    const id = seen.owner.terminalId
    const { inbox } = this.host.turns()
    seen.settling = true
    try {
      for (;;) {
        const before = raw(seen)
        // eslint-disable-next-line no-await-in-loop -- Each pass starts from what the end holds now.
        const text = await this.masked(seen)
        if (seen.corrected || !inbox.accepts(id)) return
        if (raw(seen) !== before) continue
        this.write(seen, text)
        return
      }
    } catch (error) {
      log.error("inbox.turn-failed", "Novadeck could not record a finished turn", { err: error })
    } finally {
      seen.settling = false
    }
  }

  private write(seen: Seen, text: Text): void {
    const { inbox } = this.host.turns()
    const fields: TurnFields = {
      outcome: seen.outcome,
      reply: text.reply,
      error: seen.error === null ? null : text.error,
      files: [...seen.files],
    }
    if (seen.row) inbox.amendTurn(seen.owner.terminalId, seen.at, fields)
    else inbox.recordTurn(seen.owner, seen.at, fields)
    seen.row = true
  }

  /** The end's text with its secrets masked; null where it could not be, never the text unmasked. */
  private async masked(seen: Seen): Promise<Text> {
    const from = key(seen)
    if (seen.masked?.from === from) return seen.masked
    const { redactor } = this.host.turns()
    const one = async (text: string | null, max: number): Promise<string | null> => {
      if (text === null) return null
      if (!redactor) return text
      const line = plain(text)
      if (!line) return null
      try {
        const out = await redactor.redact({
          text: line,
          // Wide characters take two columns.
          cols: line.length * 2,
          rows: 1,
          lines: 1,
          maxChars: max,
        })
        return out ? out : null
      } catch {
        return null
      }
    }
    const reply = await one(seen.reply, replyPreviewLength)
    const error = await one(seen.error, maxTurnError)
    seen.masked = { reply, error, from }
    return seen.masked
  }
}
