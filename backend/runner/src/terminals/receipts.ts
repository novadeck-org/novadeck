import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"

import { followLines } from "@novadeck/harness-core/follow"
import type { Harness } from "@novadeck/harness-core/harness"
import { agentLimits, shellCommand, type AgentName, type PromptReceipt } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { inBox, missingAt, promptLines, settledBy, type Turns } from "./receipt-match.js"

const log = logs.for("chat")

/** The root session's record a terminal's receipts read, as its binding names it. */
export type ReceiptSource = {
  /** What tells the session apart: a new one starts the receipts over. */
  readonly key: string
  readonly agent: AgentName
  /** The version of the harness that writes the record, where known. */
  readonly version: string | null
  /** The root's transcript. */
  readonly path: string
  /** Its harness's decoder, the one the chat's transcript comes from. */
  readonly items: NonNullable<Harness["transcripts"]>["items"]
}

/** What the receipts need of the terminals. */
export type ReceiptsHost = {
  /** The bound root session's record, where there is one Novadeck reads. */
  readonly source: (terminalId: string) => Promise<ReceiptSource | undefined>
  /** The session the terminal is bound to now, by its `ReceiptSource.key`; null for none. */
  readonly bound: (terminalId: string) => string | null
  /**
   * The agent showing its own prompt before its first session binds, as Codex and
   * Antigravity do until their first prompt's hook; undefined for none.
   */
  readonly shown: (terminalId: string) => AgentName | undefined
  /**
   * Where in the root's record the runner joins interruptions of its own to the items
   * `agents.transcript` serves (Antigravity's, whose record holds none), so a settled
   * prompt's `item` is the index the chat has it at.
   */
  readonly interruptions: (terminalId: string) => readonly { readonly offset: number }[]
  /** The root agent's turns, as its activity tells them. */
  readonly turns: (terminalId: string) => Turns
  /** What the agent's input box holds on its screen now; undefined where none is read. */
  readonly box: (terminalId: string) => Promise<string | undefined>
  /** Tells the terminal's `agents.detail` readers its receipts changed. */
  readonly changed: (terminalId: string) => void
}

export type ReceiptsOptions = {
  readonly now?: () => number
  /** How long an idle agent has to show a prompt in its record (`missingAt`), in milliseconds. */
  readonly slackMs: number
  /** How often the record is read for what it gained, in milliseconds. */
  readonly pollMs?: number
  /**
   * How long the record is still followed once no prompt there may settle, so the next
   * prompt reads on from where it was rather than from the start, in milliseconds.
   */
  readonly keepMs?: number
}

type State = PromptReceipt["state"]

/** A prompt being followed. */
type Entry = {
  readonly ref: string
  readonly text: string
  readonly lines: readonly string[]
  /** How long the record was as the prompt was given: a line ending past it is new to it. */
  readonly bytes: number
  /**
   * When it was given, for one given before its session bound, whose record is unknown
   * then: an item recorded since that second is new to it (harnesses record whole seconds
   * at the coarsest). Null for one given in a bound session.
   */
  readonly since: number | null
  /**
   * How many items the record had then, once read that far: after the record is rewritten,
   * an item at or past it is new to it.
   */
  items: number | undefined
  /** When its Enter was pressed; null while it is still being typed. */
  sentAt: number | null
  state: State
  /** The index of the item that settled it. */
  item: number | null
  /** Its box is being read before it is called missing. */
  checking: boolean
}

/** What is read of a terminal's record, while any prompt there waits on it. */
type Reader = {
  readonly controller: AbortController
  /** Items read since the start of the record, the next one's index. */
  index: number
  /** Where the lines read so far end. */
  position: number
  /** When it was last read to its end; null before. */
  readAt: number | null
  /** Whether the record was rewritten since it was opened. */
  rewritten: boolean
}

type Track = {
  /**
   * The bound session's record; undefined while the agent shows its prompt before its first
   * session binds, which the first prompt's hook binds (`attach`).
   */
  source: ReceiptSource | undefined
  /** The agent the prompts went to. */
  readonly agent: AgentName
  readonly entries: Entry[]
  /** Its record being looked up, as its session just bound. */
  attaching: Promise<void> | undefined
  reader: Reader | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  /** Stops following the record, once it has been `keepMs` with nothing to settle. */
  rest: ReturnType<typeof setTimeout> | undefined
}

/** A ref for a prompt whose client gave none: as `agentRef` takes them. */
export const freshRef = (): string => randomBytes(12).toString("base64url")

/** The second a time falls in, as a coarse record would write it. */
const second = (at: number): number => Math.floor(at / 1000) * 1000

/** The prompt is settled by the record's item at `item`, or withdrawn by a Stop. */
const done = (entry: Entry, state: "settled" | "withdrawn", item?: number): void => {
  entry.state = state
  entry.item = item ?? null
}

/** Whether a prompt still waits on the record, or may be settled by a late one. */
const open = (state: State): boolean =>
  state === "pending" || state === "unrecorded" || state === "in-box"

/**
 * Follows each prompt given through `agents.prompt` until its agent's own record has it,
 * for the chat to show it until then and to say when it never came (see docs/backend-api.md,
 * "Prompt receipts"). The record is read with the harness's own decoder, the chat's, so a
 * prompt a decoder drops is missing here as it is in the chat: that is what it tells. A
 * prompt counts as missing once its agent's turns went by without it (`missingAt`); the
 * agent's box is read first, and one whose words are back in it is `in-box`, not missing.
 * One record per terminal is read, from its start, while any of its prompts may still settle.
 */
export class Receipts {
  private readonly tracks = new Map<string, Track>()
  private readonly now: () => number
  private readonly slackMs: number
  private readonly pollMs: number | undefined
  private readonly keepMs: number

  constructor(
    private readonly host: ReceiptsHost,
    options: ReceiptsOptions,
  ) {
    this.now = options.now ?? Date.now
    this.slackMs = options.slackMs
    this.pollMs = options.pollMs
    this.keepMs = options.keepMs ?? 60_000
  }

  /**
   * Holds `ref` for a prompt about to be given, before anything waits: a ref the terminal's
   * receipts hold already is a CONFLICT, writing nothing.
   */
  claim(terminalId: string, ref: string): void {
    if (this.tracks.get(terminalId)?.entries.some((entry) => entry.ref === ref))
      throw new DomainError("CONFLICT", "A prompt with that ref was given already.")
  }

  /**
   * A prompt is being given: followed from now, under `ref`, if the record can tell
   * (`tracked`). The ref is `claim`ed first; one a second prompt took meanwhile isn't followed.
   */
  async expect(
    terminalId: string,
    text: string,
    ref: string = freshRef(),
  ): Promise<{ readonly ref: string; readonly tracked: boolean }> {
    this.claim(terminalId, ref)
    const givenAt = this.now()
    const unbound = this.host.bound(terminalId) === null
    // Prompts given before the session bound are read in its record first, so this one's
    // track is theirs.
    const waiting = this.tracks.get(terminalId)
    if (!unbound && waiting && !waiting.source)
      await this.attach(terminalId, waiting, this.host.bound(terminalId)!)
    const shown = unbound ? this.host.shown(terminalId) : undefined
    const source = unbound ? undefined : await this.host.source(terminalId).catch(() => undefined)
    const agent = source?.agent ?? shown
    // A shell command isn't followed: Codex records one only once it ran, however long that
    // takes, with no turn to tell it runs; Antigravity keeps no record of one.
    const shell = shellCommand(text) !== undefined
    const lines = promptLines(text)
    if (!agent || shell || lines.length === 0) return { ref, tracked: false }
    if (source && this.host.bound(terminalId) !== source.key) return { ref, tracked: false }
    if (!source && this.host.bound(terminalId) !== null) return { ref, tracked: false }
    const bytes = source
      ? await stat(source.path).then(
          ({ size }) => size,
          () => 0,
        )
      : 0
    const track = this.trackOf(terminalId, source, agent)
    // Raced by a second prompt with the same ref while the record was looked at.
    if (track.entries.some((entry) => entry.ref === ref)) return { ref, tracked: false }
    const entry: Entry = {
      ref,
      text,
      lines,
      bytes,
      since: source ? null : givenAt,
      items: bytes === 0 ? 0 : undefined,
      sentAt: null,
      state: "pending",
      item: null,
      checking: false,
    }
    this.room(track)
    track.entries.push(entry)
    if (track.source) this.read(terminalId, track)
    return { ref, tracked: true }
  }

  /** The prompt's Enter was pressed: it is pending, as its receipt shows. */
  sent(terminalId: string, ref: string): void {
    const entry = this.entry(terminalId, ref)
    if (!entry) return
    entry.sentAt = this.now()
    this.host.changed(terminalId)
    this.check(terminalId)
  }

  /** The prompt wasn't given: no receipt follows it. */
  failed(terminalId: string, ref: string): void {
    const track = this.tracks.get(terminalId)
    const at = track?.entries.findIndex((entry) => entry.ref === ref) ?? -1
    if (!track || at < 0) return
    const [entry] = track.entries.splice(at, 1)
    if (entry?.sentAt !== null) this.host.changed(terminalId)
    this.idle(terminalId, track)
  }

  /**
   * A Stop handed back words queued behind the turn: the prompts still waiting whose words
   * they hold are withdrawn, as they are the person's draft again.
   */
  withdraw(terminalId: string, returned: string): void {
    const track = this.tracks.get(terminalId)
    if (!track) return
    let changed = false
    for (const entry of track.entries)
      if (entry.state === "pending" && inBox(returned, entry.lines)) {
        done(entry, "withdrawn")
        changed = true
      }
    if (changed) this.host.changed(terminalId)
    this.idle(terminalId, track)
  }

  /**
   * The terminal's agent changed what it does, or bound another session: a turn's end may
   * make a prompt missing, and a new session starts the receipts over.
   */
  changed(terminalId: string): void {
    const track = this.tracks.get(terminalId)
    if (!track) return
    const bound = this.host.bound(terminalId)
    if (!track.source && bound !== null) return void this.attach(terminalId, track, bound)
    if ((track.source?.key ?? null) !== bound) {
      this.forget(terminalId)
      this.host.changed(terminalId)
      return
    }
    this.check(terminalId)
  }

  /** The receipts of the terminal's prompts given in its bound session, oldest first. */
  view(terminalId: string): PromptReceipt[] {
    const track = this.tracks.get(terminalId)
    // Those given before the session bound show on while its record is looked up.
    if (!track || (track.source && this.host.bound(terminalId) !== track.source.key)) return []
    return track.entries
      .filter((entry): entry is Entry & { sentAt: number } => entry.sentAt !== null)
      .map(({ ref, text, sentAt, state, item }) => ({
        ref,
        text: state === "settled" || state === "withdrawn" ? null : text,
        sentAt,
        state,
        item,
      }))
  }

  /** Stops following the terminal's prompts, as it exits or goes, or its session changed. */
  forget(terminalId: string): void {
    const track = this.tracks.get(terminalId)
    if (!track) return
    this.tracks.delete(terminalId)
    track.reader?.controller.abort()
    clearTimeout(track.timer)
    clearTimeout(track.rest)
  }

  /** Stops following every terminal's, as the runner shuts down. */
  close(): void {
    for (const terminalId of this.tracks.keys()) this.forget(terminalId)
  }

  private entry(terminalId: string, ref: string): Entry | undefined {
    return this.tracks.get(terminalId)?.entries.find((entry) => entry.ref === ref)
  }

  private trackOf(terminalId: string, source: ReceiptSource | undefined, agent: AgentName): Track {
    const known = this.tracks.get(terminalId)
    const same = known?.source
      ? known.source.key === source?.key && known.source.path === source.path
      : known !== undefined && source === undefined && known.agent === agent
    if (known && same) return known
    if (known) this.forget(terminalId)
    const track: Track = {
      source,
      agent,
      entries: [],
      attaching: undefined,
      reader: undefined,
      timer: undefined,
      rest: undefined,
    }
    this.tracks.set(terminalId, track)
    return track
  }

  /**
   * The session the prompts given before it went to bound: its record is read for them, an
   * item recorded since each was given new to it. Another agent's session starts them over.
   */
  private attach(terminalId: string, track: Track, key: string): Promise<void> {
    track.attaching ??= this.attached(terminalId, track, key).then(
      (again) => {
        track.attaching = undefined
        // The session changed while its record was looked up: the new one's is looked up.
        if (again) this.changed(terminalId)
      },
      () => void (track.attaching = undefined),
    )
    return track.attaching
  }

  /** Reads the record of the session bound under `key`; true where another bound meanwhile. */
  private async attached(terminalId: string, track: Track, key: string): Promise<boolean> {
    const source = await this.host.source(terminalId).catch(() => undefined)
    if (this.tracks.get(terminalId) !== track || track.source) return false
    // Looked again once the record is known, or once the session that bound meanwhile is.
    if (!source || source.key !== key || this.host.bound(terminalId) !== key)
      return this.host.bound(terminalId) !== key
    if (source.agent !== track.agent) {
      this.forget(terminalId)
      this.host.changed(terminalId)
      return false
    }
    track.source = source
    this.host.changed(terminalId)
    this.read(terminalId, track)
    this.check(terminalId)
    return false
  }

  /** Room for one more receipt: the oldest settled or withdrawn goes first, else the oldest. */
  private room(track: Track): void {
    while (track.entries.length >= agentLimits.prompts) {
      const closed = track.entries.findIndex((entry) => !open(entry.state))
      track.entries.splice(closed < 0 ? 0 : closed, 1)
    }
  }

  /** Reads the record while a prompt may settle, from its start, so items are counted. */
  private read(terminalId: string, track: Track): void {
    const { source } = track
    clearTimeout(track.rest)
    track.rest = undefined
    if (track.reader || !source) return
    const reader: Reader = {
      controller: new AbortController(),
      index: 0,
      position: 0,
      readAt: null,
      rewritten: false,
    }
    track.reader = reader
    const { items } = source
    // An item is new to a prompt once its line ends past where the record ended as it was
    // given, or, once the record was rewritten, from the item it had then; for one given
    // before its session bound, once it was recorded in the second it was given or later.
    const fresh = (entry: Entry, end: number, index: number, at: number | null) => {
      if (entry.since !== null) return at !== null && at >= second(entry.since)
      return reader.rewritten
        ? entry.items !== undefined && index >= entry.items
        : end > entry.bytes
    }
    void followLines(
      source.path,
      reader.controller.signal,
      (line, end) => {
        // The interruptions `agents.transcript` joins before this line's items.
        const joined = this.host
          .interruptions(terminalId)
          .filter(({ offset }) => offset <= reader.position).length
        const start = reader.index
        for (const entry of track.entries)
          if (entry.items === undefined && end > entry.bytes) entry.items = start
        let changed = false
        for (const item of items(line)) {
          const index = reader.index
          reader.index += 1
          if (item.role !== "user" || item.kind !== "text" || item.interrupted) continue
          const waiting = track.entries.filter(
            (entry) => open(entry.state) && fresh(entry, end, index, item.at),
          )
          if (waiting.length === 0) continue
          for (const ref of settledBy(waiting, item.text)) {
            const entry = track.entries.find((each) => each.ref === ref)!
            done(entry, "settled", index + joined)
            changed ||= entry.sentAt !== null
          }
        }
        reader.position = end
        if (changed) this.host.changed(terminalId)
      },
      {
        fromStart: true,
        ...(this.pollMs !== undefined && { intervalMs: this.pollMs }),
        onIdle: () => {
          for (const entry of track.entries)
            if (entry.items === undefined && reader.position >= entry.bytes)
              entry.items = reader.index
          reader.readAt = this.now()
          this.check(terminalId)
          this.idle(terminalId, track)
        },
        onReset: () => {
          reader.index = 0
          reader.position = 0
          reader.rewritten = true
        },
      },
    )
  }

  /**
   * Stops reading the record once no prompt there has settled for `keepMs`: the next one
   * within it reads on from where the record was read to, not from its start, which in a
   * long session's record takes a second or more.
   */
  private idle(terminalId: string, track: Track): void {
    if (track.entries.some((entry) => open(entry.state)) || track.rest) return
    clearTimeout(track.timer)
    track.timer = undefined
    track.rest = setTimeout(() => {
      track.rest = undefined
      if (track.entries.some((entry) => open(entry.state))) return
      track.reader?.controller.abort()
      track.reader = undefined
      if (track.entries.length === 0 && this.tracks.get(terminalId) === track)
        this.tracks.delete(terminalId)
    }, this.keepMs)
    track.rest.unref?.()
  }

  /** Calls each pending prompt missing whose deadline passed, and looks again at the next. */
  private check(terminalId: string): void {
    const track = this.tracks.get(terminalId)
    if (!track) return
    clearTimeout(track.timer)
    track.timer = undefined
    const turns = this.host.turns(terminalId)
    const now = this.now()
    // Before its session binds there is no record to read: the first prompt's hook binds it,
    // given twice the slack, as a harness's first hook may come late on a cold start, or the
    // prompt never started a turn.
    const readAt = track.source ? (track.reader?.readAt ?? null) : now
    const slackMs = track.source ? this.slackMs : 2 * this.slackMs
    let next = Number.POSITIVE_INFINITY
    for (const entry of track.entries) {
      if (entry.state !== "pending" || entry.sentAt === null || entry.checking) continue
      const due = missingAt(entry.sentAt, turns, readAt, now, slackMs)
      if (due === true) void this.missing(terminalId, track, entry)
      else if (due !== null) next = Math.min(next, due)
    }
    // Past the deadline, the next read to its end decides; before it, a timer.
    if (Number.isFinite(next))
      track.timer = setTimeout(() => this.check(terminalId), Math.max(0, next - now))
  }

  /** The prompt's turns went by without it: back in the box, or missing from the record. */
  private async missing(terminalId: string, track: Track, entry: Entry): Promise<void> {
    entry.checking = true
    const box = await this.host.box(terminalId).catch(() => undefined)
    entry.checking = false
    if (this.tracks.get(terminalId) !== track || entry.state !== "pending") return
    if (box !== undefined && inBox(box, entry.lines)) entry.state = "in-box"
    else {
      entry.state = "unrecorded"
      // Once per prompt whose record was read, with no content: what it tells is that a
      // decoder may have drifted. One whose session never bound tells no such thing.
      if (track.source)
        log.warn(
          "chat.unrecorded",
          "A prompt given through the chat isn't in its agent's record.",
          {
            data: { agent: track.agent, version: track.source?.version ?? null },
          },
        )
    }
    this.host.changed(terminalId)
  }
}
