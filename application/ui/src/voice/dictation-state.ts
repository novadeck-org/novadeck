import type { TerminalKey } from "../model/types"

// Dictation as a state machine, apart from the microphone and the backend: what a key
// press, a release, a click or a timer does to a recording, and what the controller must
// then do. Holding the shortcut records until release; a quick tap instead leaves a
// hands-free recording that the next press stops.

// A press shorter than this is a tap, and anything shorter in audio is a slip: the
// recording is dropped without a word.
export const tapMilliseconds = 300
export const minimumClipSeconds = 0.3

export type Dictating =
  | { readonly kind: "idle" }
  | {
      readonly kind: "recording"
      readonly target: TerminalKey
      // `hold` ends when the key does; `toggle` waits for the next press or click.
      readonly mode: "hold" | "toggle"
      // The key being held, by `code`, since modifiers may be let go first.
      readonly code: string | null
      readonly startedAt: number
    }
  | { readonly kind: "transcribing"; readonly target: TerminalKey }

export const idle: Dictating = { kind: "idle" }

// Whether dictation can start now; if not, what to tell the person.
export type Readiness = { readonly ready: true } | { readonly ready: false; readonly hint: string }

export type DictationEvent =
  | {
      readonly type: "press"
      readonly code: string
      readonly target: TerminalKey | undefined
      readonly now: number
      readonly readiness: Readiness
    }
  | { readonly type: "release"; readonly code: string; readonly now: number }
  // The mic button.
  | {
      readonly type: "toggle"
      readonly target: TerminalKey
      readonly now: number
      readonly readiness: Readiness
    }
  | { readonly type: "blur" }
  | { readonly type: "cancel" }
  // The recording ran as long as the backend takes.
  | { readonly type: "limit" }
  // A transcription or a failed start is over.
  | { readonly type: "settled" }

export type DictationEffect =
  | { readonly kind: "start"; readonly target: TerminalKey }
  // Ends the recording and transcribes it.
  | { readonly kind: "stop"; readonly target: TerminalKey }
  | { readonly kind: "discard" }
  // Forgets a transcription under way: whatever it returns is thrown away.
  | { readonly kind: "drop" }
  // Something to tell the person, about the terminal they meant to dictate into where there
  // is one; `setup` where voice input isn't ready, which Preferences → Addons sets up.
  | {
      readonly kind: "hint"
      readonly text: string
      readonly target?: TerminalKey
      readonly setup?: true
    }

export type Step = { readonly state: Dictating; readonly effects: readonly DictationEffect[] }

const stay = (state: Dictating): Step => ({ state, effects: [] })

const begin = (
  mode: "hold" | "toggle",
  target: TerminalKey | undefined,
  code: string | null,
  now: number,
  readiness: Readiness,
): Step => {
  if (!readiness.ready)
    return {
      state: idle,
      effects: [{ kind: "hint", text: readiness.hint, ...(target && { target }), setup: true }],
    }
  if (!target)
    return {
      state: idle,
      effects: [{ kind: "hint", text: "Select a terminal to dictate into." }],
    }
  return {
    state: { kind: "recording", target, mode, code, startedAt: now },
    effects: [{ kind: "start", target }],
  }
}

const stop = (state: Extract<Dictating, { kind: "recording" }>): Step => ({
  state: { kind: "transcribing", target: state.target },
  effects: [{ kind: "stop", target: state.target }],
})

export const stepDictation = (state: Dictating, event: DictationEvent): Step => {
  switch (event.type) {
    case "press":
      if (state.kind === "idle")
        return begin("hold", event.target, event.code, event.now, event.readiness)
      // The tap that began a hands-free recording ends it; a second key pressed during a
      // hold is nobody's business.
      return state.kind === "recording" && state.mode === "toggle" ? stop(state) : stay(state)
    case "release":
      if (state.kind !== "recording" || state.mode !== "hold" || state.code !== event.code)
        return stay(state)
      return event.now - state.startedAt < tapMilliseconds
        ? stay({ ...state, mode: "toggle", code: null })
        : stop(state)
    case "toggle":
      if (state.kind === "idle")
        return begin("toggle", event.target, null, event.now, event.readiness)
      return state.kind === "recording" ? stop(state) : stay(state)
    // Losing focus ends a hold, which would never see its key come up; a hands-free
    // recording carries on.
    case "blur":
      return state.kind === "recording" && state.mode === "hold" ? stop(state) : stay(state)
    case "limit":
      return state.kind === "recording" ? stop(state) : stay(state)
    case "cancel":
      if (state.kind === "recording") return { state: idle, effects: [{ kind: "discard" }] }
      return state.kind === "transcribing"
        ? { state: idle, effects: [{ kind: "drop" }] }
        : stay(state)
    case "settled":
      return state.kind === "transcribing" || state.kind === "recording" ? stay(idle) : stay(state)
  }
}
