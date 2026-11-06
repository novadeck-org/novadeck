// Each terminal's live slice, for those who read it (`agents.slice`): the rows of its screen
// that stand for something of its harness's own at its input. The screen is looked at only
// while someone reads, so a terminal nobody watches costs nothing; the screen at rest is kept
// meanwhile, which is what tells where a thing drawn over it starts. Rows go to the readers
// and nowhere else: nothing here logs them, keeps them past the next look, or traces them.
import { readScreen, styledRows, type Screen } from "@novadeck/emulator/headless"
import { readSlice, type Resting, type SliceProfile } from "@novadeck/harness-core/slices"
import {
  liveSlice,
  type AgentName,
  type LiveSlice,
  type RequestDialog,
  type SliceChange,
} from "@novadeck/protocol"
import type { BoxProfile } from "@novadeck/tui-input/box"
import { Latest } from "@novadeck/wire/server"

import { harnesses } from "../harnesses/registry.js"
import type { Record } from "./record.js"

/** What a look at a terminal takes; undefined with no agent bound there. */
export type Slicing = {
  readonly box: BoxProfile
  readonly profile: SliceProfile
  /** Whether a request waits on the person, whose dialog is the chat's to show. */
  readonly waiting: boolean
  /** Whether that dialog is one no adapter read. */
  readonly unread: boolean
  /** Reads the screen once what was drawn before is on it; undefined once it is gone. */
  readonly read: <T>(read: (screen: Screen) => T) => Promise<T | undefined>
}

/**
 * What a look at the record's screen takes, with its dialogs as the tracker reads them, and
 * the agent whose prompt shows there before a session binds: Antigravity and Codex bind only
 * at a first prompt, and their menus come before it.
 */
export const slicingOf = (
  record: Record | undefined,
  dialogs: ReadonlyMap<string, RequestDialog>,
  shown: AgentName | undefined,
): Slicing | undefined => {
  const agent = record?.bound?.binding.agent ?? shown
  if (!record || !agent) return undefined
  const { box, slice } = harnesses[agent]
  const child = record.terminal.pty
  return {
    box,
    profile: slice,
    waiting: (record.bound?.activity.pending.length ?? 0) > 0,
    unread: [...dialogs.values()].some((dialog) => dialog.type === "raw"),
    read: async (read) => {
      const taken = await record.terminal.readScreen(read)
      return record.terminal.pty === child ? taken : undefined
    },
  }
}

export type SlicesOptions = {
  readonly now?: () => number
  /** The least time between two looks at one terminal's screen, in milliseconds. */
  readonly throttleMs?: number
  /**
   * How long the box must stay gone before a view shows, in milliseconds: a redraw between
   * two frames shows no box either.
   */
  readonly viewStillMs?: number
}

type State = {
  readonly readers: Set<Latest<SliceChange>>
  rest: Resting | undefined
  /** What the readers have, to tell a change by. */
  shown: string
  timer: ReturnType<typeof setTimeout> | undefined
  lastLook: number
  looking: boolean
  /** A change came during a look: another follows it. */
  again: boolean
  /** Since when a view has shown, not yet told. */
  viewSince: number | undefined
  /** Looks again once that view has stayed long enough; other looks go on meanwhile. */
  still: ReturnType<typeof setTimeout> | undefined
}

const none = JSON.stringify({ slice: null })

/** What the screen shows of the harness's own, and whether the screen is at rest. */
const take = (
  screen: Screen,
  rest: Resting | undefined,
  slicing: Slicing,
): { readonly slice: LiveSlice | null; readonly resting: Resting | undefined } => {
  const text = readScreen(screen)
  const { box, profile, waiting, unread } = slicing
  const { bounds, resting } = readSlice({ screen: text, rest, box, profile, waiting, unread })
  const at = resting ? { rows: text.rows } : undefined
  if (!bounds) return { slice: null, resting: at }
  const { reason, first, last } = bounds
  const { row, column } = text.cursor
  const parsed = liveSlice.safeParse({
    reason,
    columns: text.columns,
    rows: styledRows(screen, first, last),
    cursor: row >= first && row <= last ? { row: row - first, column } : null,
    secret: profile.secret(text.rows.slice(first, last + 1)),
  })
  // Past the limits it is no slice: rows cut short would be the wrong rows.
  return { slice: parsed.success ? parsed.data : null, resting: at }
}

export class Slices {
  private readonly states = new Map<string, State>()
  private readonly now: () => number
  private readonly throttleMs: number
  private readonly viewStillMs: number

  constructor(
    private readonly slicing: (terminalId: string) => Slicing | undefined,
    options: SlicesOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.throttleMs = options.throttleMs ?? 50
    this.viewStillMs = options.viewStillMs ?? 120
  }

  /** The terminal's slice, then another on each change, until it is finished or `signal` aborts. */
  async *watch(terminalId: string, signal: AbortSignal | undefined): AsyncGenerator<SliceChange> {
    const reader = new Latest<SliceChange>()
    const state = this.states.get(terminalId) ?? this.fresh(terminalId)
    state.readers.add(reader)
    reader.push(JSON.parse(state.shown) as SliceChange)
    this.changed(terminalId)
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Snapshots are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      state.readers.delete(reader)
      if (state.readers.size === 0 && this.states.get(terminalId) === state) {
        this.stop(state)
        this.states.delete(terminalId)
      }
    }
  }

  /** The screen or the terminal's requests changed: read again, if anyone reads. */
  changed(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    if (state.looking) {
      state.again = true
      return
    }
    if (!state.timer) this.later(terminalId, state, state.lastLook + this.throttleMs - this.now())
  }

  /** Ends the terminal's readers, as it is closed. */
  end(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    this.stop(state)
    this.states.delete(terminalId)
    for (const reader of state.readers) reader.finish()
  }

  /** Ends every reader, as the runner shuts down. */
  finish(): void {
    for (const terminalId of this.states.keys()) this.end(terminalId)
  }

  private fresh(terminalId: string): State {
    const state: State = {
      readers: new Set(),
      rest: undefined,
      shown: none,
      timer: undefined,
      lastLook: Number.NEGATIVE_INFINITY,
      looking: false,
      again: false,
      viewSince: undefined,
      still: undefined,
    }
    this.states.set(terminalId, state)
    return state
  }

  private stop(state: State): void {
    clearTimeout(state.timer)
    clearTimeout(state.still)
  }

  private later(terminalId: string, state: State, ms: number): void {
    clearTimeout(state.timer)
    state.timer = setTimeout(
      () => {
        state.timer = undefined
        void this.look(terminalId, state)
      },
      Math.max(0, ms),
    )
  }

  private tell(state: State, slice: LiveSlice | null): void {
    const change = { slice }
    const shown = JSON.stringify(change)
    if (shown === state.shown) return
    state.shown = shown
    for (const reader of state.readers) reader.push(change)
  }

  private async look(terminalId: string, state: State): Promise<void> {
    const slicing = this.slicing(terminalId)
    if (!slicing) {
      // Nothing of a harness's own is at an input no agent draws, and its rest is another's.
      state.rest = undefined
      state.viewSince = undefined
      this.tell(state, null)
      return
    }
    state.looking = true
    state.lastLook = this.now()
    const taken = await slicing
      .read((screen) => take(screen, state.rest, slicing))
      .catch(() => undefined)
    state.looking = false
    if (this.states.get(terminalId) !== state) return
    if (taken) {
      if (taken.resting) state.rest = taken.resting
      this.settle(terminalId, state, taken.slice)
    }
    if (state.again) {
      state.again = false
      this.changed(terminalId)
    }
  }

  /** Tells what the look found: a view only once it has stayed, as a redraw has no box. */
  private settle(terminalId: string, state: State, slice: LiveSlice | null): void {
    const told = (JSON.parse(state.shown) as SliceChange).slice
    if (slice?.reason !== "view" || told?.reason === "view") {
      state.viewSince = undefined
      this.tell(state, slice)
      return
    }
    state.viewSince ??= this.now()
    const left = state.viewSince + this.viewStillMs - this.now()
    if (left > 0) {
      state.still ??= setTimeout(() => {
        state.still = undefined
        this.changed(terminalId)
      }, left)
      return
    }
    state.viewSince = undefined
    this.tell(state, slice)
  }
}
