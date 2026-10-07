import { createHash } from "node:crypto"

import { requestDialog, type AgentName, type RequestDialog } from "@novadeck/protocol"

import type {
  DialogAdapter,
  DialogRead,
  ReadDialog,
  RequestFacts,
  ScreenRequest,
} from "../harnesses/dialogs.js"
import type { ScreenText } from "./screen.js"

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
  readonly pending: (
    terminalId: string,
  ) => { readonly agent: AgentName; readonly requests: readonly Waiting[] } | undefined
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
}

/**
 * The dialog as the protocol shows it: with its `id`, a fingerprint of the read, detail
 * included. An answer names it, and is refused where the screen no longer reads the same.
 */
export const identified = (
  dialog: ReadDialog,
): Exclude<RequestDialog, { type: "raw" }> | undefined => {
  const shown = clamped(dialog)
  if (!shown) return undefined
  const id = createHash("sha256").update(JSON.stringify(shown)).digest("hex").slice(0, 16)
  const identity = { ...shown, id }
  // Whatever an adapter read, only what the protocol takes is shown.
  const parsed = requestDialog.safeParse(identity)
  return parsed.success && parsed.data.type !== "raw" ? parsed.data : undefined
}

// What the protocol allows of each string an adapter reads for display.
const displayLimits: { readonly [key: string]: number } = {
  detail: 4096,
  message: 2048,
  title: 1024,
  question: 2048,
  header: 256,
  label: 512,
  description: 2048,
}

/**
 * The dialog with its display strings cut to the protocol's limits (a long question or
 * description, a form field's choices), but for a `detail`, which the person approves from and
 * which reads as nothing when past its limit; ids and structure are never cut, so a dialog whose ids or counts exceed the limits fails the protocol's own
 * check, and reads as nothing.
 */
const clamped = (dialog: ReadDialog): ReadDialog | undefined => {
  // What the person approves from is never cut: a detail past its limit reads as nothing.
  if (dialog.type === "choices" && (dialog.detail?.length ?? 0) > displayLimits.detail!)
    return undefined
  const cut = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") {
      const limit = key === undefined ? undefined : displayLimits[key]
      return limit !== undefined && value.length > limit ? value.slice(0, limit) : value
    }
    if (Array.isArray(value))
      // A form field's choices are display strings of their own.
      return value.map((each) => cut(each, key === "choices" ? "label" : undefined))
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([name, each]) => [name, cut(each, name)]),
      )
    return value
  }
  return cut(dialog) as ReadDialog
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

/** What the protocol carries of a raw dialog's text. */
const rawBytes = 4096

/**
 * The screen's text around a dialog no adapter recognised, the same for every harness: the
 * screen's rows without their trailing blanks, taken from the bottom up while they fit
 * in 4 KiB (a row is never cut), a run of blank rows shortened to one, and none leading.
 * Where a dialog shows it, it is at the bottom; whatever above it belongs to the
 * transcript goes with it only as far as the space allows.
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
    if (size + line.length + 1 > rawBytes) {
      if (kept.length === 0) kept.unshift(line.slice(0, rawBytes))
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
  /** What each request's dialog said as last announced. */
  announced: Map<string, string>
  timer: NodeJS.Timeout | undefined
  lastLook: number
  looking: boolean
  again: boolean
  /** Answers under way, whose screens go through states no look should judge. */
  answering: number
}

/**
 * Tells each request's dialog in `agents.detail` (see docs/backend-api.md): for each
 * request waiting, the dialog its harness's adapter reads from the terminal's screen;
 * `raw` with the screen's text once the screen is still and no request's dialog reads
 * (or the harness has no adapter); null until then. It also raises the requests only the
 * screen tells, as Codex's plan prompt, and lets them go once their screen is. Looks
 * again as the screen or the requests change, throttled, and announces only real
 * changes. It presses nothing. Knows nothing of how any harness draws its screen.
 */
export class Dialogs {
  private readonly states = new Map<string, State>()
  private readonly now: () => number
  private readonly throttleMs: number
  private readonly settleMs: number
  private readonly rawStillMs: number
  private readonly rawAgeMs: number

  constructor(
    private readonly host: DialogsHost,
    options: DialogsOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.throttleMs = options.throttleMs ?? 100
    this.settleMs = options.settleMs ?? 500
    this.rawStillMs = options.rawStillMs ?? 1_500
    this.rawAgeMs = options.rawAgeMs ?? 2_000
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
  ): void {
    const state = this.state(terminalId)
    const text = rawText(rows ?? state.rows)
    state.entries.set(ref, {
      dialog: { type: "raw", text, reason },
      locked: reason,
    })
    this.announce(terminalId, state)
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
  }

  private state(terminalId: string): State {
    let state = this.states.get(terminalId)
    if (!state) {
      state = {
        entries: new Map(),
        text: "",
        since: this.now(),
        rows: [],
        announced: new Map(),
        timer: undefined,
        lastLook: 0,
        looking: false,
        again: false,
        answering: 0,
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
          console.error("Novadeck could not read an agent's dialog:", error),
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
    const adapter = this.host.adapter(before.agent)
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
    if (state.answering > 0) return
    const settled = now - state.since >= this.settleMs
    let waiting = false
    let wake = 0
    // A request only the screen tells comes with its screen, and goes once the screen is
    // still without it, never on a redraw in between.
    if (adapter?.screenRequest) {
      const seen = adapter.screenRequest(rows)
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
        if (settled) this.host.clear(terminalId, held.ref)
        else waiting = true
      }
    }
    const requests = this.host.pending(terminalId)?.requests ?? []
    const live = new Set(requests.map(({ ref }) => ref))
    for (const ref of state.entries.keys()) if (!live.has(ref)) state.entries.delete(ref)
    const reads: { request: Waiting; read: DialogRead }[] = []
    const unread: Waiting[] = []
    for (const request of requests) {
      const entry = state.entries.get(request.ref)
      if (entry?.locked || entry?.done) continue
      const read: DialogRead | undefined = adapter?.read(rows, request.facts)
      if (read && identified(read.dialog)) reads.push({ request, read })
      else unread.push(request)
    }
    // A request whose dialog is raw for good still shows on screen as the dialog it was: it
    // keeps another's from being answerable. (An answered one's is gone, or the next's.)
    const ghosts: { request: Waiting; read: DialogRead }[] = []
    for (const request of requests) {
      if (state.entries.get(request.ref)?.locked && !state.entries.get(request.ref)?.done) {
        const read = adapter?.read(rows, request.facts)
        if (read && identified(read.dialog)) ghosts.push({ request, read })
      }
    }
    const recognised = reads.length > 0
    // Twins read the same dialog, which is either's to answer; any other pair can't be told
    // apart on one screen, so neither is answerable.
    const everyone = [...reads, ...ghosts]
    const alike = everyone.every(
      ({ request, read }) =>
        twin(request, everyone[0]!.request) &&
        identified(read.dialog)?.id === identified(everyone[0]!.read.dialog)?.id,
    )
    for (const { request, read } of reads)
      state.entries.set(request.ref, {
        dialog: alike
          ? identified(read.dialog)!
          : { type: "raw", text: rawText(rows), reason: "unrecognized" },
      })
    for (const request of unread) {
      const entry = state.entries.get(request.ref)
      // Another request's dialog is the one on screen: this one's is not (yet).
      if (recognised) {
        if (entry?.dialog) state.entries.set(request.ref, { dialog: null })
        continue
      }
      // Not before the screen has been still, and the request pending, for a while.
      const ready = Math.max(state.since + this.rawStillMs, request.askedAt + this.rawAgeMs)
      if (now < ready) {
        wake = Math.max(wake, ready)
        continue
      }
      state.entries.set(request.ref, {
        dialog: {
          type: "raw",
          text: rawText(rows),
          reason: adapter ? "unrecognized" : "unsupported",
        },
      })
    }
    this.announce(terminalId, state)
    if (waiting) wake = Math.max(wake, state.since + this.settleMs)
    if (wake > 0) this.later(terminalId, state, wake - this.now() + 10)
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
