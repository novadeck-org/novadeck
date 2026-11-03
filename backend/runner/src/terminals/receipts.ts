import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"

import { followLines } from "@novadeck/harness-core/follow"
import type { Harness } from "@novadeck/harness-core/harness"
import { agentLimits, shellCommand, type AgentName, type PromptReceipt } from "@novadeck/protocol"
import { harnesses as table } from "@novadeck/protocol/harnesses"

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
  readonly source: ReceiptSource
  readonly entries: Entry[]
  reader: Reader | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

/** A ref for a prompt whose client gave none: as `agentRef` takes them. */
export const freshRef = (): string => randomBytes(12).toString("base64url")

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

  constructor(
    private readonly host: ReceiptsHost,
    options: ReceiptsOptions,
  ) {
    this.now = options.now ?? Date.now
    this.slackMs = options.slackMs
    this.pollMs = options.pollMs
  }

  /**
   * A prompt is about to be given: followed from now, under `ref`, if the record can tell
   * (`tracked`). A ref the terminal's receipts hold already is a CONFLICT.
   */
  async expect(
    terminalId: string,
    text: string,
    ref: string = freshRef(),
  ): Promise<{ readonly ref: string; readonly tracked: boolean }> {
    if (this.tracks.get(terminalId)?.entries.some((entry) => entry.ref === ref))
      throw new DomainError("CONFLICT", "A prompt with that ref was given already.")
    const source = await this.host.source(terminalId).catch(() => undefined)
    const shell = shellCommand(text) !== undefined
    const records = table.find(({ id }) => id === source?.agent)?.recordsShell ?? true
    if (!source || (shell && !records) || this.host.bound(terminalId) !== source.key)
      return { ref, tracked: false }
    const bytes = await stat(source.path).then(
      ({ size }) => size,
      () => 0,
    )
    const track = this.trackOf(terminalId, source)
    // Raced by a second prompt with the same ref while the record was looked at.
    if (track.entries.some((entry) => entry.ref === ref))
      throw new DomainError("CONFLICT", "A prompt with that ref was given already.")
    const lines = promptLines(text)
    if (lines.length === 0) return { ref, tracked: false }
    const entry: Entry = {
      ref,
      text,
      lines,
      bytes,
      items: bytes === 0 ? 0 : undefined,
      sentAt: null,
      state: "pending",
      item: null,
      checking: false,
    }
    this.room(track)
    track.entries.push(entry)
    this.read(terminalId, track)
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
    if (this.host.bound(terminalId) !== track.source.key) {
      this.forget(terminalId)
      this.host.changed(terminalId)
      return
    }
    this.check(terminalId)
  }

  /** The receipts of the terminal's prompts given in its bound session, oldest first. */
  view(terminalId: string): PromptReceipt[] {
    const track = this.tracks.get(terminalId)
    if (!track || this.host.bound(terminalId) !== track.source.key) return []
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
  }

  /** Stops following every terminal's, as the runner shuts down. */
  close(): void {
    for (const terminalId of this.tracks.keys()) this.forget(terminalId)
  }

  private entry(terminalId: string, ref: string): Entry | undefined {
    return this.tracks.get(terminalId)?.entries.find((entry) => entry.ref === ref)
  }

  private trackOf(terminalId: string, source: ReceiptSource): Track {
    const known = this.tracks.get(terminalId)
    if (known?.source.key === source.key && known.source.path === source.path) return known
    if (known) this.forget(terminalId)
    const track: Track = { source, entries: [], reader: undefined, timer: undefined }
    this.tracks.set(terminalId, track)
    return track
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
    if (track.reader) return
    const reader: Reader = {
      controller: new AbortController(),
      index: 0,
      position: 0,
      readAt: null,
      rewritten: false,
    }
    track.reader = reader
    const { items } = track.source
    // An item is new to a prompt once its line ends past where the record ended as it was
    // given, or, once the record was rewritten, from the item it had then.
    const fresh = (entry: Entry, end: number, index: number) =>
      reader.rewritten ? entry.items !== undefined && index >= entry.items : end > entry.bytes
    void followLines(
      track.source.path,
      reader.controller.signal,
      (line, end) => {
        const start = reader.index
        for (const entry of track.entries)
          if (entry.items === undefined && end > entry.bytes) entry.items = start
        let changed = false
        for (const item of items(line)) {
          const index = reader.index
          reader.index += 1
          if (item.role !== "user" || item.kind !== "text" || item.interrupted) continue
          const waiting = track.entries.filter(
            (entry) => open(entry.state) && fresh(entry, end, index),
          )
          if (waiting.length === 0) continue
          for (const ref of settledBy(waiting, item.text)) {
            const entry = track.entries.find((each) => each.ref === ref)!
            done(entry, "settled", index)
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

  /** Stops reading the record once no prompt there may settle. */
  private idle(terminalId: string, track: Track): void {
    if (track.entries.some((entry) => open(entry.state))) return
    track.reader?.controller.abort()
    track.reader = undefined
    clearTimeout(track.timer)
    track.timer = undefined
    if (track.entries.length === 0) this.tracks.delete(terminalId)
  }

  /** Calls each pending prompt missing whose deadline passed, and looks again at the next. */
  private check(terminalId: string): void {
    const track = this.tracks.get(terminalId)
    if (!track) return
    clearTimeout(track.timer)
    track.timer = undefined
    const turns = this.host.turns(terminalId)
    const now = this.now()
    let next = Number.POSITIVE_INFINITY
    for (const entry of track.entries) {
      if (entry.state !== "pending" || entry.sentAt === null || entry.checking) continue
      const due = missingAt(entry.sentAt, turns, track.reader?.readAt ?? null, now, this.slackMs)
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
      // Once per prompt, with no content: what it tells is that a decoder may have drifted.
      log.warn("chat.unrecorded", "A prompt given through the chat isn't in its agent's record.", {
        data: { agent: track.source.agent, version: track.source.version },
      })
    }
    this.host.changed(terminalId)
  }
}
