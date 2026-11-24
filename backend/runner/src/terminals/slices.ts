// Each terminal's live slice, for those who read it (`agents.slice`): the rows of its screen
// that stand for something of its harness's own at its input. The screen is looked at only
// while someone reads, so a terminal nobody watches costs nothing; the screen at rest is kept
// meanwhile, which is what tells where a thing drawn over it starts. Rows go to the readers
// and nowhere else: nothing here logs them or traces them, and what it holds meanwhile (the
// screen at rest, what the readers have) goes with the last reader.
import { readScreen, styledRows, type Screen } from "@novadeck/emulator/headless"
import { readSlice, type Resting, type SliceProfile } from "@novadeck/harness-core/slices"
import {
  isAgentName,
  liveSlice,
  sliceLimits,
  type AgentName,
  type LiveSlice,
  type RequestDialog,
  type SliceChange,
} from "@novadeck/protocol"
import type { BoxProfile } from "@novadeck/tui-input/box"
import { Latest } from "@novadeck/wire/server"

import { blocking } from "../harnesses/activity.js"
import { requestRef } from "../harnesses/detail.js"
import { harnesses } from "../harnesses/registry.js"
import type { Record } from "./record.js"

/** What a look at a terminal takes; undefined with no agent bound there. */
export type Slicing = {
  readonly box: BoxProfile
  readonly profile: SliceProfile
  /** Whether a request holds the agent, whose dialog is the chat's to show. */
  readonly waiting: boolean
  /** Whether that dialog is one no adapter read. */
  readonly unread: boolean
  /** Reads the screen once what was drawn before is on it; undefined once it is gone. */
  readonly read: <T>(read: (screen: Screen) => T) => Promise<T | undefined>
}

/**
 * What a look at the record's screen takes, with its dialogs as the tracker reads them, and
 * the agent whose prompt shows there before a session binds: Antigravity and Codex bind only
 * at a first prompt, and their menus come before it. Before that, the agent starting there
 * (`expecting`), whose screen the chat shows as it starts, and whose own screens, as a
 * folder-trust one, take the keys the person passes them.
 */
export const slicingOf = (
  record: Record | undefined,
  dialogs: ReadonlyMap<string, RequestDialog>,
  shown: AgentName | undefined,
): Slicing | undefined => {
  const bound = record?.bound
  const starting = record?.summary.expecting
  const agent = bound?.binding.agent ?? shown ?? (isAgentName(starting) ? starting : undefined)
  if (!record || !agent) return undefined
  const { box, slice } = harnesses[agent]
  const child = record.terminal.pty
  // A detached request leaves its prompt free, and its menus go on showing.
  const held = bound ? blocking(bound.activity.pending) : []
  return {
    box,
    profile: slice,
    waiting: held.length > 0,
    unread: held.some(
      (request) => dialogs.get(requestRef(bound!.binding, request))?.type === "raw",
    ),
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
  /** The readers that asked for the whole screen too. */
  readonly screens: Set<Latest<SliceChange>>
  rest: Resting | undefined
  /** What the readers have, to tell a change by: the slice and whether the harness idles. */
  shown: string
  /** The whole screen the readers that asked for it have, as JSON. */
  whole: string
  /** Whether a look has been told yet: until it has, a reader waits for its first. */
  looked: boolean
  /** Whether the last look took the whole screen, as readers of it wait for one that did. */
  wholeTaken: boolean
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

/** What a look found: the slice, whether the harness idles, the screen at rest, the whole screen. */
type Taken = {
  readonly slice: LiveSlice | null
  readonly resting: Resting | undefined
  readonly idle: boolean
  readonly whole: LiveSlice | null
}

/** The rows `first` to `last` of the screen as a slice of `reason`; null past its limits. */
const rowsOf = (
  screen: Screen,
  text: ReturnType<typeof readScreen>,
  profile: SliceProfile,
  reason: LiveSlice["reason"],
  first: number,
  last: number,
): LiveSlice | null => {
  const { row, column } = text.cursor
  const parsed = liveSlice.safeParse({
    reason,
    columns: text.columns,
    rows: styledRows(screen, first, last),
    cursor: row >= first && row <= last ? { row: row - first, column } : null,
    secret: profile.secret(text.rows.slice(first, last + 1)),
  })
  // Past the limits it is no slice: rows cut short would be the wrong rows.
  return parsed.success ? parsed.data : null
}

const drawn = (row: string): boolean => row.trim() !== ""

/**
 * Everything drawn, from the first row that shows anything to the last (the last rows where
 * it is taller than a slice goes), for a reader that asked for the screen; null for a blank one.
 */
const wholeScreen = (
  screen: Screen,
  text: ReturnType<typeof readScreen>,
  profile: SliceProfile,
): LiveSlice | null => {
  const last = text.rows.findLastIndex(drawn)
  if (last < 0) return null
  const first = Math.max(text.rows.findIndex(drawn), last - sliceLimits.rows + 1)
  return rowsOf(screen, text, profile, "view", first, last)
}

/** What the screen shows of the harness's own, whether the screen is at rest, and idles. */
const take = (
  screen: Screen,
  rest: Resting | undefined,
  slicing: Slicing,
  whole: boolean,
): Taken => {
  const text = readScreen(screen)
  const { box, profile, waiting, unread } = slicing
  const { bounds, resting, idle } = readSlice({ screen: text, rest, box, profile, waiting, unread })
  const all = whole ? wholeScreen(screen, text, profile) : null
  if (!bounds) return { slice: null, resting, idle, whole: all }
  const { reason, first, last } = bounds
  return { slice: rowsOf(screen, text, profile, reason, first, last), resting, idle, whole: all }
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

  /**
   * The terminal's slice, then another on each change, until it is finished or `signal` aborts.
   * The first comes with the first look at the screen, so what it says of the harness idling is
   * said and not guessed; `screen` asks for the whole screen with each.
   */
  async *watch(
    terminalId: string,
    signal: AbortSignal | undefined,
    screen = false,
  ): AsyncGenerator<SliceChange> {
    const reader = new Latest<SliceChange>()
    const state = this.states.get(terminalId) ?? this.fresh(terminalId)
    state.readers.add(reader)
    if (screen) state.screens.add(reader)
    // What a look already told is what it has, unless it took no screen and this reader wants one.
    if (state.looked && (!screen || state.wholeTaken)) reader.push(this.change(state, reader))
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
      state.screens.delete(reader)
      if (state.screens.size === 0) state.wholeTaken = false
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
      screens: new Set(),
      rest: undefined,
      shown: none,
      whole: "null",
      looked: false,
      wholeTaken: false,
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

  /** What a reader has of the state: the screen only if it asked. */
  private change(state: State, reader: Latest<SliceChange>): SliceChange {
    const change = JSON.parse(state.shown) as SliceChange
    return state.screens.has(reader)
      ? { ...change, screen: JSON.parse(state.whole) as LiveSlice | null }
      : change
  }

  /** Tells the readers what a look found, if it is the first or differs from what they have. */
  private tell(
    state: State,
    slice: LiveSlice | null,
    rest: boolean,
    whole: LiveSlice | null = null,
  ): void {
    const wants = state.screens.size > 0
    const shown = JSON.stringify({ slice, rest })
    const all = wants ? JSON.stringify(whole) : "null"
    // A reader's first look, whatever it found, and the first to take the screen for one that asked.
    const first = !state.looked || (wants && !state.wholeTaken)
    state.looked = true
    state.wholeTaken = wants
    if (!first && shown === state.shown && all === state.whole) return
    state.shown = shown
    state.whole = all
    for (const reader of state.readers) reader.push(this.change(state, reader))
  }

  private async look(terminalId: string, state: State): Promise<void> {
    state.looking = true
    state.lastLook = this.now()
    // What can't be read shows nothing: a look that throws leaves no stale rows up.
    const taken = await (async () => {
      const slicing = this.slicing(terminalId)
      const whole = state.screens.size > 0
      return slicing && slicing.read((screen) => take(screen, state.rest, slicing, whole))
    })().catch(() => undefined)
    state.looking = false
    if (this.states.get(terminalId) !== state) return
    if (taken) {
      state.rest = taken.resting ?? state.rest
      this.settle(terminalId, state, taken)
    } else {
      // Nothing of a harness's own is at an input no agent draws, and its rest is another's.
      state.rest = undefined
      state.viewSince = undefined
      this.tell(state, null, false)
    }
    if (state.again) {
      state.again = false
      this.changed(terminalId)
    }
  }

  /**
   * Tells what the look found: a view only once it has stayed, as a redraw has no box, and so
   * the harness leaving its idle for a screen with no box and nothing new drawn.
   */
  private settle(terminalId: string, state: State, taken: Taken): void {
    const { slice, idle, whole, resting } = taken
    const told = JSON.parse(state.shown) as SliceChange
    const holds =
      slice?.reason === "view"
        ? told.slice?.reason !== "view"
        : slice === null && resting === undefined && told.rest === true
    if (!holds) {
      state.viewSince = undefined
      this.tell(state, slice, idle, whole)
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
    this.tell(state, slice, idle, whole)
  }
}
