import { createHash } from "node:crypto"

import type { ScreenText } from "@novadeck/emulator/headless"
import type {
  DialogAdapter,
  DialogRead,
  AnswerableDialog,
  RequestFacts,
  ScreenRequest,
} from "@novadeck/harness-core/dialogs"
import {
  dialogTextLimits,
  maxRawDialogText,
  requestDialog,
  type AgentName,
  type RequestDialog,
} from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { cut } from "../text.js"
import { DialogDiagnostics, type RawWhy, type Subject } from "./dialog-diagnostics.js"
import { DialogSaves } from "./dialog-saves.js"
import type { SeenTerminals } from "./seen.js"

const log = logs.for("dialogs")

/** A request waiting on the person, as the tracker looks for its dialog. */
export type Waiting = {
  readonly ref: string
  readonly facts: RequestFacts
  /** The actor asking: null for the root agent, else a subagent's id. */
  readonly actor: string | null
  readonly subject: string | null
  /** Whether only the screen told it (`DialogAdapter.screenRequest`). */
  readonly screen: boolean
  /** When its hook started, in epoch milliseconds. */
  readonly askedAt: number
}

/** What the tracker asks of the terminal manager, by terminal. */
export type DialogsHost = {
  /**
   * The agent bound there and the requests it has waiting; undefined with none bound or
   * once the terminal is gone.
   */
  readonly pending: (terminalId: string) =>
    | {
        readonly agent: AgentName
        /** The harness's version, where the runner knows it. */
        readonly version?: string | null
        readonly requests: readonly Waiting[]
      }
    | undefined
  /** How the agent's TUI answers dialogs; undefined where it has no way to. */
  readonly adapter: (agent: AgentName) => DialogAdapter | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** The terminal's agent waits on a request only the screen tells. */
  readonly ask: (terminalId: string, request: ScreenRequest) => void
  /** The request only the screen told no longer waits: its screen is gone. */
  readonly clear: (terminalId: string, ref: string) => void
  /** Some request's dialog changed. */
  readonly changed: (terminalId: string) => void
  /** Whether other work holds the terminal's input box (a prompt, a message, an answer). */
  readonly busy: (terminalId: string) => boolean
  /**
   * Presses keys in the terminal's agent as the person's, through the bookkeeping their own
   * keys get; false once the terminal is gone.
   */
  readonly press: (terminalId: string, data: string) => boolean
}

export type DialogsOptions = {
  readonly now?: () => number
  /** The least time between two looks at one terminal's screen, in milliseconds. */
  readonly throttleMs?: number
  /** How long a screen must be still before a request only the screen told is let go, in milliseconds. */
  readonly settleMs?: number
  /**
   * How long a screen must be still, and a request pending, before it is shown raw for
   * want of a dialog the adapter reads, in milliseconds. A harness may run its hooks (ours
   * included) before it draws a dialog, its screen showing only "Working" meanwhile: a
   * dialog not yet drawn is no dialog that can't be read.
   */
  readonly rawStillMs?: number
  readonly rawAgeMs?: number
  /**
   * How long a screen may go without reading a dialog before it is shown raw whether or not
   * it is still, in milliseconds: a dialog may tick (Claude Code counts down to blocking the
   * request in one), and a screen that never rests must not leave the person with no prompt
   * to read.
   */
  readonly rawLatestMs?: number
  /** Where a person's "Save for debugging" puts a raw dialog; see `DialogSaves`. */
  readonly saves?: string
  /**
   * Which terminals a client has in sight. A dialog held out of view is scrolled into view
   * (`DialogAdapter.reveal`) only for a terminal none has; without it, every terminal is unseen.
   */
  readonly seen?: SeenTerminals
  /**
   * How long a terminal must have gone unseen before a held dialog is scrolled into view, in
   * milliseconds, from the runner's start, from the last time a client had it in sight, and
   * from a connection's release: a window that reloads or reconnects reports what it looks
   * at only after a moment.
   */
  readonly graceMs?: number
}

/**
 * The dialog as the protocol shows it: with its `id`, a fingerprint of the read, detail
 * included. An answer names it, and is refused where the screen no longer reads the same.
 */
export const identified = (
  dialog: AnswerableDialog,
  held = false,
): Exclude<RequestDialog, { type: "raw" }> | undefined => {
  const shown = clamped(dialog)
  if (!shown) return undefined
  // The same dialog held out of view is another read, answered after it is brought into view.
  const id = createHash("sha256")
    .update(JSON.stringify(held ? [shown, "held"] : shown))
    .digest("hex")
    .slice(0, 16)
  const identity = { ...shown, id }
  // Whatever an adapter read, only what the protocol takes is shown.
  const parsed = requestDialog.safeParse(identity)
  return parsed.success && parsed.data.type !== "raw" ? parsed.data : undefined
}

/** A read's dialog as the protocol shows it, its fingerprint telling whether it is held out of view. */
export const identifiedRead = (
  read: DialogRead,
): Exclude<RequestDialog, { type: "raw" }> | undefined =>
  identified(read.dialog, read.reveal !== undefined)

// What the protocol allows of each string an adapter reads for display, by field name.
const displayLimits: { readonly [key: string]: number } = dialogTextLimits

/** A read's value with its display strings, found by their field's name, cut to their limits. */
const clamp = (value: unknown, key?: string): unknown => {
  if (typeof value === "string") {
    const limit = key === undefined ? undefined : displayLimits[key]
    return limit === undefined ? value : cut(value, limit)
  }
  if (Array.isArray(value))
    // A form field's choices are display strings of their own.
    return value.map((each) => clamp(each, key === "choices" ? "label" : undefined))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([name, each]) => [name, clamp(each, name)]),
    )
  return value
}

/**
 * The dialog with its display strings cut to the protocol's limits (a long question or
 * description, a form field's choices), but for a `detail`, which the person approves from and
 * which reads as nothing when past its limit; ids and structure are never cut, so a dialog whose ids or counts exceed the limits fails the protocol's own
 * check, and reads as nothing.
 */
const clamped = (dialog: AnswerableDialog): AnswerableDialog | undefined => {
  // Novadeck never cuts what the person approves from: a detail past its limit reads as nothing.
  if (dialog.type === "choices" && (dialog.detail?.length ?? 0) > dialogTextLimits.detail)
    return undefined
  return clamp(dialog) as AnswerableDialog
}

/**
 * Whether two requests ask the very same of the very same agent: actor, kind, tool, input
 * and directory alike. Calls of one agent that are identical fold into one request, so
 * twins are in practice requests of different agents.
 */
export const twin = (
  a: { readonly facts: RequestFacts; readonly actor: string | null },
  b: { readonly facts: RequestFacts; readonly actor: string | null },
): boolean =>
  a.actor === b.actor &&
  JSON.stringify([a.facts.kind, a.facts.tool, a.facts.input, a.facts.cwd]) ===
    JSON.stringify([b.facts.kind, b.facts.tool, b.facts.input, b.facts.cwd])

/**
 * The screen's text around a dialog no adapter recognised, the same for every harness: the
 * screen's rows without their trailing blanks, taken from the bottom up while they fit in
 * what the protocol carries of it (`maxRawDialogText`; a row is never cut), a run of blank
 * rows shortened to one, and none leading. Where a dialog shows it, it is at the bottom;
 * whatever above it belongs to the transcript goes with it only as far as the space allows.
 */
export const rawText = (rows: readonly string[]): string => {
  const lines = rows.map((row) => row.trimEnd())
  while (lines.length > 0 && lines.at(-1) === "") lines.pop()
  const kept: string[] = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (line === "" && kept[0] === "") continue
    // Characters are what the protocol counts; a row too long on its own is cut.
    if (size + line.length + 1 > maxRawDialogText) {
      if (kept.length === 0) kept.unshift(line.slice(0, maxRawDialogText))
      break
    }
    kept.unshift(line)
    size += line.length + 1
  }
  while (kept[0] === "") kept.shift()
  return kept.join("\n")
}

type Entry = {
  readonly dialog: RequestDialog | null
  /** When its raw text was taken from the screen. */
  readonly taken?: number
  /** Why it is raw for good: nothing is pressed for the request again, nor its dialog read. */
  readonly locked?: "unrecognized" | "failed"
  /** Answered: its last dialog stays as it was. */
  readonly done?: true
}

type State = {
  readonly entries: Map<string, Entry>
  /** The screen's text as last seen, since when, and its rows. */
  text: string
  since: number
  rows: readonly string[]
  columns: number
  /** What each request's dialog said as last announced. */
  announced: Map<string, string>
  timer: NodeJS.Timeout | undefined
  lastLook: number
  looking: boolean
  again: boolean
  /** Answers under way, whose screens go through states no look should judge. */
  answering: number
  /** Whether its adapter threw reading it yet, logged only the first time while it waits. */
  failed: boolean
  /** Since when a request waits and none reads; undefined where one does, or none waits. */
  unread: number | undefined
  /** The screen that keys were last pressed on to bring a held dialog into view, until it ends. */
  revealed: string | undefined
}

/**
 * Tells each request's dialog in `agents.detail` (see docs/backend-api.md): for each
 * request waiting, the dialog its harness's adapter reads from the terminal's screen;
 * `raw` with the screen's text once the screen is still and no request's dialog reads
 * (or the harness has no adapter); null until then. It also raises the requests only the
 * screen tells, as Codex's plan prompt, and lets them go once their screen is. Looks
 * again as the screen or the requests change, throttled, and announces only real
 * changes. It presses only what an adapter's `reveal` says, to bring a dialog held out of
 * view into view on a terminal no client has in sight. Knows nothing of how any harness draws
 * its screen.
 */
/**
 * What `read` gives, or undefined where it throws: logged once while the terminal waits, as
 * an adapter that throws on a screen throws again on each redraw of it. Only the error's
 * class is logged, as an adapter's message may quote the screen's rows.
 */
const attempt = <T>(state: State, read: () => T): T | undefined => {
  try {
    return read()
  } catch (error) {
    if (!state.failed)
      log.error("dialogs.read-failed", "Novadeck could not read an agent's dialog", {
        data: { error: error instanceof Error ? error.name : typeof error },
      })
    state.failed = true
    return undefined
  }
}

export class Dialogs {
  private readonly states = new Map<string, State>()
  private readonly now: () => number
  private readonly throttleMs: number
  private readonly settleMs: number
  private readonly rawStillMs: number
  private readonly rawAgeMs: number
  private readonly rawLatestMs: number
  private readonly diagnostics: DialogDiagnostics
  private readonly saves: DialogSaves
  private readonly seen: SeenTerminals | undefined
  private readonly graceMs: number

  constructor(
    private readonly host: DialogsHost,
    options: DialogsOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.diagnostics = new DialogDiagnostics(log, this.now)
    this.saves = new DialogSaves(options.saves)
    this.throttleMs = options.throttleMs ?? 100
    this.settleMs = options.settleMs ?? 500
    this.rawStillMs = options.rawStillMs ?? 1_500
    this.rawAgeMs = options.rawAgeMs ?? 2_000
    this.rawLatestMs = options.rawLatestMs ?? 6_000
    this.seen = options.seen
    this.graceMs = options.graceMs ?? 5_000
    // A terminal turning seen ends its held dialog's spell; turning unseen is a look at it.
    this.seen?.subscribe((terminalId, seen) => {
      const state = this.states.get(terminalId)
      if (!state) return
      if (seen) state.revealed = undefined
      else this.changed(terminalId)
    })
  }

  /** The terminal's screen or requests changed: its dialogs are looked at again soon. */
  changed(terminalId: string): void {
    const info = this.host.pending(terminalId)
    const adapter = info && this.host.adapter(info.agent)
    if (!info || (info.requests.length === 0 && !adapter?.screenRequest)) {
      this.forget(terminalId)
      return
    }
    const state = this.state(terminalId)
    if (state.timer) return
    this.later(terminalId, state, state.lastLook + this.throttleMs - this.now())
  }

  /** The dialog of each request of the terminal that has one, by its ref. */
  view(terminalId: string): ReadonlyMap<string, RequestDialog> {
    const view = new Map<string, RequestDialog>()
    for (const [ref, { dialog }] of this.states.get(terminalId)?.entries ?? [])
      if (dialog) view.set(ref, dialog)
    return view
  }

  /** The refs of the terminal's requests answered through `agents.answer` and waiting still. */
  answered(terminalId: string): ReadonlySet<string> {
    const refs = new Set<string>()
    for (const [ref, entry] of this.states.get(terminalId)?.entries ?? [])
      if (entry.done) refs.add(ref)
    return refs
  }

  /** The request's dialog as it shows now, null when none does. */
  shown(terminalId: string, ref: string): RequestDialog | null {
    return this.states.get(terminalId)?.entries.get(ref)?.dialog ?? null
  }

  /** Whether nothing may be pressed for the request: locked raw or answered. */
  closed(terminalId: string, ref: string): boolean {
    const entry = this.states.get(terminalId)?.entries.get(ref)
    return entry !== undefined && (entry.locked !== undefined || entry.done === true)
  }

  /**
   * The request's dialog turns raw for good, with the screen's text as given or last
   * seen: its dialog was not what it should be, or keys pressed there did not take.
   */
  lock(
    terminalId: string,
    ref: string,
    reason: "unrecognized" | "failed",
    rows?: readonly string[],
    why?: string,
  ): void {
    const state = this.state(terminalId)
    const subject = this.subject(terminalId, state, ref, rows)
    if (subject) {
      this.diagnostics.unread(subject, reason)
      if (why !== undefined) this.diagnostics.answerFailed(subject, reason === "failed", why)
    }
    const text = rawText(rows ?? state.rows)
    state.entries.set(ref, {
      dialog: { type: "raw", text, reason },
      locked: reason,
    })
    this.announce(terminalId, state)
  }

  /**
   * Writes a raw request's dialog, with the screen as it is, for the person to attach to a bug
   * report (see `agents.saveDialog`); resolves with the file's path.
   */
  async save(terminalId: string, ref: string): Promise<string> {
    const state = this.states.get(terminalId)
    const dialog = this.shown(terminalId, ref)
    const info = this.host.pending(terminalId)
    const request = info?.requests.find((each) => each.ref === ref)
    if (!state || !info || !request) throw new DomainError("NOT_FOUND")
    if (dialog?.type !== "raw")
      throw new DomainError("CONFLICT", "Only a dialog Novadeck can't read is saved.")
    const screen = await this.host.screen(terminalId)
    if (!screen) throw new DomainError("CONFLICT", "The terminal went away.")
    const subject = {
      ...this.subject(terminalId, state, ref, screen.rows)!,
      columns: screen.columns,
    }
    return this.saves.save({
      harness: info.agent,
      version: info.version ?? null,
      reason: dialog.reason,
      refusals: this.diagnostics.refusals(subject),
      request: request.facts,
      rows: screen.rows,
      columns: screen.columns,
    })
  }

  /** The request was answered: its dialog stays as it was, and is looked at no more. */
  done(terminalId: string, ref: string): void {
    const state = this.state(terminalId)
    state.entries.set(ref, { dialog: state.entries.get(ref)?.dialog ?? null, done: true })
    this.host.changed(terminalId)
  }

  /** An answer goes on in the terminal: its screens are not looked at until it ends. */
  begin(terminalId: string): void {
    this.state(terminalId).answering += 1
  }

  end(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    state.answering = Math.max(0, state.answering - 1)
    if (state.answering === 0) this.changed(terminalId)
  }

  /** Forgets a terminal that stopped running, or has no request to look for. */
  forget(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state || state.answering > 0) return
    clearTimeout(state.timer)
    this.states.delete(terminalId)
    this.diagnostics.prune(terminalId)
  }

  /** What the log is told of a request, with the screen it was looked for on. */
  private subject(
    terminalId: string,
    state: State,
    ref: string,
    rows: readonly string[] = state.rows,
  ): Subject | undefined {
    const info = this.host.pending(terminalId)
    const request = info?.requests.find((each) => each.ref === ref)
    if (!info || !request) return undefined
    return {
      terminalId,
      agent: info.agent,
      version: info.version ?? null,
      ref,
      facts: request.facts,
      askedAt: request.askedAt,
      adapter: this.host.adapter(info.agent),
      rows,
      columns: state.columns,
    }
  }

  /** Tells the log of a request whose dialog turned raw, once for the request. */
  private unread(terminalId: string, state: State, ref: string, why: RawWhy): void {
    const subject = this.subject(terminalId, state, ref)
    if (subject) this.diagnostics.unread(subject, why)
  }

  private state(terminalId: string): State {
    let state = this.states.get(terminalId)
    if (!state) {
      state = {
        entries: new Map(),
        text: "",
        since: this.now(),
        rows: [],
        columns: 80,
        announced: new Map(),
        timer: undefined,
        lastLook: 0,
        looking: false,
        again: false,
        answering: 0,
        failed: false,
        unread: undefined,
        revealed: undefined,
      }
      this.states.set(terminalId, state)
    }
    return state
  }

  private later(terminalId: string, state: State, delay: number): void {
    clearTimeout(state.timer)
    state.timer = setTimeout(
      () => {
        state.timer = undefined
        void this.look(terminalId, state).catch((error: unknown) =>
          log.error("dialogs.read-failed", "Novadeck could not read an agent's dialog", {
            err: error,
          }),
        )
      },
      Math.max(0, delay),
    )
    state.timer.unref()
  }

  private async look(terminalId: string, state: State): Promise<void> {
    if (this.states.get(terminalId) !== state) return
    if (state.looking) {
      state.again = true
      return
    }
    state.looking = true
    try {
      state.lastLook = this.now()
      await this.read(terminalId, state)
    } finally {
      state.looking = false
      if (state.again) {
        state.again = false
        if (this.states.get(terminalId) === state && !state.timer)
          this.later(terminalId, state, state.lastLook + this.throttleMs - this.now())
      }
    }
  }

  private async read(terminalId: string, state: State): Promise<void> {
    const before = this.host.pending(terminalId)
    if (!before) return this.forget(terminalId)
    const found = this.host.adapter(before.agent)
    // An adapter that throws on a screen reads no dialog there, so its request's dialog
    // turns raw as one it doesn't recognise, the screen's text in the chat, rather than
    // waiting there quietly while the error goes only to the log. One that throws telling
    // a request from the screen tells nothing either way: what it raised stays.
    const adapter = found && {
      read: (rows: readonly string[], facts: Waiting["facts"]) =>
        attempt(state, () => found.read(rows, facts)),
      ...(found.screenRequest && {
        screenRequest: (rows: readonly string[]) =>
          attempt(state, () => ({ seen: found.screenRequest!(rows) })),
      }),
    }
    const screen = await this.host.screen(terminalId)
    if (!screen || this.states.get(terminalId) !== state) return
    const { rows } = screen
    const now = this.now()
    const text = rows.join("\n")
    if (text !== state.text) {
      state.text = text
      state.since = now
    }
    state.rows = rows
    state.columns = screen.columns
    if (state.answering > 0) return
    const settled = now - state.since >= this.settleMs
    let waiting = false
    let wake = 0
    // A request only the screen tells comes with its screen, and goes once the screen is
    // still without it, never on a redraw in between.
    const fromScreen = adapter?.screenRequest?.(rows)
    if (fromScreen) {
      const { seen } = fromScreen
      const held = before.requests.find(({ screen: told }) => told)
      const same =
        seen !== undefined &&
        held !== undefined &&
        held.facts.kind === seen.kind &&
        held.facts.tool === seen.tool &&
        held.subject === seen.subject
      if (seen && !same) {
        if (held) this.host.clear(terminalId, held.ref)
        this.host.ask(terminalId, seen)
      } else if (!seen && held) {
        // Hidden is not gone: a view of the harness's own may hold it out of sight (Codex's
        // `/diff` pager), and closing that view shows it again, the same request. It keeps
        // its ref while the adapter says one holds a dialog out of view (`reveal`).
        // Looked at again as the screen changes, as that view closes.
        const hidden =
          found?.reveal !== undefined && attempt(state, () => found.reveal!(rows)) !== undefined
        if (!hidden && settled) this.host.clear(terminalId, held.ref)
        else if (!hidden) waiting = true
      }
    }
    const requests = this.host.pending(terminalId)?.requests ?? []
    const live = new Set(requests.map(({ ref }) => ref))
    for (const ref of state.entries.keys()) if (!live.has(ref)) state.entries.delete(ref)
    this.diagnostics.prune(terminalId, live)
    const reads: { request: Waiting; read: DialogRead }[] = []
    const unread: Waiting[] = []
    for (const request of requests) {
      const entry = state.entries.get(request.ref)
      if (entry?.locked || entry?.done) continue
      const read: DialogRead | undefined = adapter?.read(rows, request.facts)
      // A read from the facts alone names no dialog on screen: it counts for the only request.
      // Requests answered already are gone from the screen, as the answer driver counts them.
      const sole =
        read?.reveal === undefined ||
        requests.every(({ ref }) => ref === request.ref || state.entries.get(ref)?.done === true)
      if (read && sole && identifiedRead(read)) reads.push({ request, read })
      else unread.push(request)
    }
    // A request whose dialog is raw for good still shows on screen as the dialog it was: it
    // keeps another's from being answerable. (An answered one's is gone, or the next's.)
    const ghosts: { request: Waiting; read: DialogRead }[] = []
    for (const request of requests) {
      if (state.entries.get(request.ref)?.locked && !state.entries.get(request.ref)?.done) {
        const read = adapter?.read(rows, request.facts)
        // One held out of view is not on screen to be mistaken for.
        if (read && read.reveal === undefined && identified(read.dialog))
          ghosts.push({ request, read })
      }
    }
    const recognised = reads.length > 0
    state.unread = recognised || unread.length === 0 ? undefined : (state.unread ?? now)
    // Twins read the same dialog, which is either's to answer; any other pair can't be told
    // apart on one screen, so neither is answerable. Dialogs answered as prompts never
    // clash with each other, each prompt naming its own, but do with one answered by keys.
    const everyone = [...reads, ...ghosts]
    const keyed = everyone.filter(({ read }) => !read.prompt)
    const alike = keyed.every(
      ({ request, read }) =>
        twin(request, keyed[0]!.request) &&
        identifiedRead(read)?.id === identifiedRead(keyed[0]!.read)?.id,
    )
    for (const { request, read } of reads) {
      const clear = read.prompt ? keyed.length === 0 : alike
      state.entries.set(request.ref, {
        dialog: clear
          ? identifiedRead(read)!
          : { type: "raw", text: rawText(rows), reason: "unrecognized" },
      })
      if (!clear) this.unread(terminalId, state, request.ref, "clash")
      else if (before)
        this.diagnostics.readLate({
          terminalId,
          agent: before.agent,
          version: before.version ?? null,
          ref: request.ref,
          facts: request.facts,
          askedAt: request.askedAt,
        })
    }
    for (const request of unread) {
      const entry = state.entries.get(request.ref)
      // Another request's dialog is the one on screen: this one's is not (yet).
      if (recognised) {
        if (entry?.dialog) state.entries.set(request.ref, { dialog: null })
        continue
      }
      // Not before the screen has been still, and the request pending, for a while; nor
      // later than a screen that keeps moving allows.
      const still = state.since + this.rawStillMs
      const ready = Math.min(
        Math.max(still, request.askedAt + this.rawAgeMs),
        Math.max(state.unread ?? now, request.askedAt) + this.rawLatestMs,
      )
      if (now < ready) {
        wake = Math.max(wake, ready)
        continue
      }
      // Raw already, it follows a moving screen only now and then, never each of its frames.
      const stale = (entry?.taken ?? 0) + this.rawLatestMs
      if (entry?.dialog?.type === "raw" && now < Math.min(still, stale)) {
        wake = Math.max(wake, Math.min(still, stale))
        continue
      }
      state.entries.set(request.ref, {
        dialog: {
          type: "raw",
          text: rawText(rows),
          reason: adapter ? "unrecognized" : "unsupported",
        },
        taken: now,
      })
      this.unread(terminalId, state, request.ref, adapter ? "unrecognized" : "unsupported")
    }
    this.announce(terminalId, state)
    if (unread.length === 0 || recognised) state.revealed = undefined
    else {
      const after = this.reveal(terminalId, state, found, unread[0]!)
      if (after > 0) wake = Math.max(wake, this.now() + after - 10)
    }
    if (waiting) wake = Math.max(wake, state.since + this.settleMs)
    if (wake > 0) this.later(terminalId, state, wake - this.now() + 10)
  }

  /**
   * Brings a dialog its harness holds out of view into view, for a terminal nobody has in
   * sight, once for each screen it is held on: the keys of the adapter's `reveal`, which
   * answer nothing, pressed as the person's would be once the screen is still, no other work
   * holds the terminal's input, and the terminal has been unseen for the grace period (a
   * window that reloads or reconnects says what it looks at only a moment later). Gives how
   * long to wait before looking again, in milliseconds; 0 for no need to.
   */
  private reveal(
    terminalId: string,
    state: State,
    adapter: DialogAdapter | undefined,
    request: Waiting,
  ): number {
    const keys = adapter?.reveal ? attempt(state, () => adapter.reveal!(state.rows)) : undefined
    if (keys === undefined) {
      // No longer held out of view: the next spell may press again.
      state.revealed = undefined
      return 0
    }
    if (this.seen?.has(terminalId) || state.revealed === state.text) return 0
    const still = this.settleMs - (this.now() - state.since)
    if (still > 0) return still
    const unseen = this.seen ? this.graceMs - this.seen.unseenFor(terminalId) : 0
    if (unseen > 0) return unseen
    // A prompt, message or answer under way holds the input box: looked at again soon.
    if (this.host.busy(terminalId)) return 250
    state.revealed = state.text
    if (!this.host.press(terminalId, keys)) return 0
    const subject = this.subject(terminalId, state, request.ref)
    if (subject) this.diagnostics.revealed(subject)
    return 0
  }

  /** Tells the manager when any request's dialog differs from what it last told. */
  private announce(terminalId: string, state: State): void {
    const next = new Map<string, string>()
    for (const [ref, { dialog }] of state.entries) if (dialog) next.set(ref, JSON.stringify(dialog))
    const same =
      next.size === state.announced.size &&
      [...next].every(([ref, json]) => state.announced.get(ref) === json)
    if (same) return
    state.announced = next
    this.host.changed(terminalId)
  }
}
