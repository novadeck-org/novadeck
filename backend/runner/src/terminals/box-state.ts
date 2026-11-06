import type { ScreenText } from "@novadeck/emulator/headless"
import type { AgentBox } from "@novadeck/protocol"
import { leftoverOf, type BoxProfile } from "@novadeck/tui-input/box"

/** The most of a box's text `agents.detail` carries, in UTF-16 code units. */
const textMax = 16_384

/** What a client is shown of a box's text. */
export const boxWords = (text: string): string => text.trim().slice(0, textMax)

/**
 * What an agent's input box holds as a client should show it, so nothing goes along with a
 * prompt unseen: its text, whether it may be only the end of it, and whether all of it is words
 * Novadeck typed. Null for an empty box, one that isn't there, a shell mode with nothing in it,
 * and a line a ring left, which is the doorbell's to finish.
 */
export const boxView = (
  profile: BoxProfile,
  screen: ScreenText,
  known: (text: string) => boolean,
  ringLine: (text: string) => boolean,
): AgentBox | null => {
  const state = leftoverOf(profile, screen)
  if (state.kind === "none" || state.kind === "empty") return null
  const { box, tail } = state
  const text = box.text.trim()
  if (text === "" || ringLine(text)) return null
  return { text: boxWords(text), mode: box.mode, tail, known: known(text) }
}

const same = (a: AgentBox | null, b: AgentBox | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.text === b.text &&
    a.mode === b.mode &&
    a.tail === b.tail &&
    a.known === b.known)

export type BoxStatesHost = {
  /** Whether a client reads the terminal's `agents.detail`: none, and no screen is read. */
  readonly watched: (terminalId: string) => boolean
  /** Whether something is typing there now, whose keys the box shows on their way through. */
  readonly typing: (terminalId: string) => boolean
  /** The box a client should see of the terminal's screen now; undefined for none to read. */
  readonly read: (terminalId: string) => Promise<AgentBox | null | undefined>
  /** Tells the terminal's `agents.detail` readers it changed. */
  readonly changed: (terminalId: string) => void
}

type State = {
  view: AgentBox | null
  timer: ReturnType<typeof setTimeout> | undefined
  lastLook: number
  looking: boolean
  /** It changed during a look: another follows. */
  again: boolean
}

/**
 * Follows the input box of each terminal a client reads, for `agents.detail`: a look at its
 * screen as it changes, throttled, announcing only real changes. It presses nothing, and reads
 * no screen no one watches.
 */
export class BoxStates {
  private readonly states = new Map<string, State>()
  private readonly now: () => number
  private readonly throttleMs: number

  constructor(
    private readonly host: BoxStatesHost,
    options: { readonly now?: () => number; readonly throttleMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now
    this.throttleMs = options.throttleMs ?? 250
  }

  /** The terminal's screen, or what is known of its box's words, changed: a look comes soon. */
  changed(terminalId: string): void {
    if (!this.host.watched(terminalId)) {
      this.forget(terminalId)
      return
    }
    let state = this.states.get(terminalId)
    if (!state) {
      state = { view: null, timer: undefined, lastLook: 0, looking: false, again: false }
      this.states.set(terminalId, state)
    }
    if (state.looking) state.again = true
    else this.later(terminalId, state, state.lastLook + this.throttleMs - this.now())
  }

  /** What the terminal's box holds, as last read; null while nothing is known. */
  view(terminalId: string): AgentBox | null {
    return this.states.get(terminalId)?.view ?? null
  }

  /** Forgets a terminal that stopped running, or that no client reads. */
  forget(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    clearTimeout(state.timer)
    this.states.delete(terminalId)
  }

  /** Stops every look, as the runner shuts down. */
  close(): void {
    for (const terminalId of this.states.keys()) this.forget(terminalId)
  }

  private later(terminalId: string, state: State, ms: number): void {
    if (state.timer) return
    state.timer = setTimeout(
      () => {
        state.timer = undefined
        void this.look(terminalId, state)
      },
      Math.max(0, ms),
    )
    state.timer.unref?.()
  }

  private async look(terminalId: string, state: State): Promise<void> {
    if (this.states.get(terminalId) !== state) return
    // What is being typed shows in the box on its way to the agent: it is no leftover. The
    // screen changes again as it goes.
    if (this.host.typing(terminalId)) {
      this.later(terminalId, state, this.throttleMs)
      return
    }
    state.looking = true
    state.lastLook = this.now()
    const read = await this.host.read(terminalId).catch(() => undefined)
    state.looking = false
    if (this.states.get(terminalId) !== state) return
    const view = read ?? null
    if (!same(view, state.view)) {
      state.view = view
      this.host.changed(terminalId)
    }
    if (state.again) {
      state.again = false
      this.later(terminalId, state, this.throttleMs)
    }
  }
}
