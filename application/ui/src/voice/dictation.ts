import { createStore, type MutableStore, type Store } from "#core/store"
import type { TerminalKey } from "#core/types"
import {
  installFailure,
  maxClipSeconds,
  type Voice,
  type VoiceClip,
  type VoiceState,
} from "#core/voice"

import type { Capture, CaptureHandlers } from "./capture"
import type { Dictation } from "./dictation-control"
import {
  idle,
  minimumClipSeconds,
  stepDictation,
  type DictationEffect,
  type DictationEvent,
  type Dictating,
  type Readiness,
} from "./dictation-state"
import { voiceSampleRate } from "./resample"

const noticeMilliseconds = 4000

// Whether voice input is on and has the model it asks for.
export const voiceReady = (state: VoiceState): boolean =>
  state.enabled && state.installed.includes(state.model)

// Whether reaching for dictation offers to install voice input: it is wanted and not set up,
// and nothing installs. That includes an install the person cancelled or that failed, which
// left a model on disk that never passed its check: Turn on picks it up from there.
export const offered = (state: VoiceState): boolean =>
  state.available && state.wanted && !state.installing && !voiceReady(state)

// An engine update doesn't stop dictation: the runner keeps the engine it has until the
// new one is in, and says why should there be none to use.
const readiness = (state: VoiceState): Readiness =>
  voiceReady(state)
    ? { ready: true }
    : offered(state)
      ? { ready: false, offer: true }
      : // Only an install under way is left: where it is off or absent the shortcut and the mic are
        // not voice input's, and nothing else asks.
        { ready: false, hint: "Voice input is still installing." }

// Whether the shortcut and the microphone are the app's: voice input exists here and the
// person hasn't turned it off or said no thanks to it.
export const voiceClaimed = (state: VoiceState): boolean => state.available && state.wanted

// What dictation tells the person once a clip is over, or before one starts:
// - `done`: the words went in; `hint`: nothing went wrong, but nothing went in either;
//   `error`: something failed.
// - `target`: the terminal it is about, where there is one.
// - `setup`: voice input isn't ready, which Preferences → Addons sets up.
export type DictationNotice = {
  readonly text: string
  readonly tone: "done" | "hint" | "error"
  readonly target: TerminalKey | null
  readonly setup?: true
}

export type DictationView = {
  readonly phase: Dictating["kind"]
  // The terminal being dictated into, while there is a clip.
  readonly target: TerminalKey | null
  readonly mode: "hold" | "toggle" | null
  readonly startedAt: number
  // What the last clip came to, or why none started, which fades after a few seconds.
  readonly notice: DictationNotice | null
}

const quiet: DictationView = {
  phase: "idle",
  target: null,
  mode: null,
  startedAt: 0,
  notice: null,
}

export type DictationDeps = {
  readonly voice: Voice
  // Notes that voice input was offered, as the person reached for it before it is installed.
  readonly offered: () => void
  readonly typeInto: (key: TerminalKey, text: string) => boolean
  readonly startCapture: (handlers: CaptureHandlers) => Promise<Capture>
  readonly now: () => number
  readonly after: (milliseconds: number, run: () => void) => () => void
}

// What a clip's microphone has handed over. It stays open past the person's stop, while
// the microphone lets the last words in, which a bump of `generation` would cut.
type Recording = { open: boolean; appended: number }

// Voice input's setup, shown in the strip of the terminal the person reached from, or in the
// overlay where there is none on screen: the offer, the install, how it ended.
export type VoiceSetup = {
  readonly kind: "offer" | "installing" | "ready" | "failed"
  readonly target: TerminalKey | null
}

// How long an ignored offer waits, and how long its ready and failure notes stay.
export const offerMilliseconds = 15_000
export const readyMilliseconds = 6000
export const failureMilliseconds = 12_000

export type DictationController = {
  readonly dictation: Dictation
  // The backend voice's state, for the setup's progress and failure.
  readonly voice: Store<VoiceState>
  readonly setup: Store<VoiceSetup | null>
  readonly setupActions: {
    readonly turnOn: () => void
    // Off by choice: the mic goes and the shortcut is the terminal's again.
    readonly noThanks: () => void
    readonly cancel: () => void
    // Ignoring the offer: gone for now, offered again by the next press.
    readonly dismiss: () => void
  }
  // Starts following the backend voice, for the setup's story; returns what ends it.
  readonly start: () => () => void
  readonly view: Store<DictationView>
  // The microphone's loudness, apart from the view because it changes many times a second.
  readonly level: Store<number>
  // The terminals whose windows show dictation themselves, by `dictationKey`, each with how
  // many of its windows do: what concerns one of them shows there, and everything else in
  // the app-wide status line.
  readonly docks: MutableStore<ReadonlyMap<string, number>>
}

// A terminal's key among a controller's `docks`.
export const dictationKey = ({ projectId, workspaceSessionId, terminalId }: TerminalKey): string =>
  `${projectId}/${workspaceSessionId}/${terminalId}`

// How a count of words reads.
const wordCount = (text: string): string => {
  const count = text.split(/\s+/).filter(Boolean).length
  return `${count} ${count === 1 ? "word" : "words"}`
}

// Runs the state machine against the microphone and the backend's voice: starting a clip
// at once, so the engine warms up while the person speaks, streaming audio into it, and
// pasting what comes back into the terminal it began in.
export const createDictation = (deps: DictationDeps): DictationController => {
  const { voice, offered: noteOffered, typeInto, startCapture, now, after } = deps
  const view: MutableStore<DictationView> = createStore(quiet)
  const level: MutableStore<number> = createStore(0)
  const docks: MutableStore<ReadonlyMap<string, number>> = createStore<ReadonlyMap<string, number>>(
    new Map(),
  )
  let state: Dictating = idle
  let clip: VoiceClip | null = null
  let capture: Capture | null = null
  // Bumped for each clip, so a microphone that answers after its clip ended is let go.
  let generation = 0
  let recording: Recording | null = null
  // Lets go of a clip that is waiting for the microphone's last words, for a cancel.
  let abortDrain: (() => void) | null = null
  let cancelLimit: (() => void) | null = null
  let cancelNotice: (() => void) | null = null
  // Bumped for each transcription and again when one is dropped, so a transcript that
  // arrives for a clip the person cancelled is thrown away.
  let transcription = 0

  const notify = (
    text: string,
    tone: DictationNotice["tone"],
    target: TerminalKey | null,
    setup = false,
  ): void => {
    cancelNotice?.()
    view.update((current) => ({
      ...current,
      notice: { text, tone, target, ...(setup && { setup: true as const }) },
    }))
    cancelNotice = after(noticeMilliseconds, () => {
      cancelNotice = null
      view.update((current) => ({ ...current, notice: null }))
    })
  }
  const clearNotice = (): void => {
    cancelNotice?.()
    cancelNotice = null
  }
  const publish = (): void => {
    const phase = state
    view.update((current) => ({
      phase: phase.kind,
      target: phase.kind === "idle" ? null : phase.target,
      mode: phase.kind === "recording" ? phase.mode : null,
      startedAt: phase.kind === "recording" ? phase.startedAt : 0,
      // A new clip clears what the last one left.
      notice: phase.kind === "recording" ? null : current.notice,
    }))
    if (phase.kind !== "recording") level.update(() => 0)
  }
  const endClip = (): void => {
    generation++
    cancelLimit?.()
    cancelLimit = null
    capture?.stop()
    capture = null
    clip = null
    if (recording) recording.open = false
    recording = null
  }

  const start = (target: TerminalKey): void => {
    clearNotice()
    const id = ++generation
    const current = voice.record()
    clip = current
    const mine: Recording = { open: true, appended: 0 }
    recording = mine
    cancelLimit = after(maxClipSeconds * 1000, () => dispatch({ type: "limit" }))
    startCapture({
      onSamples: (samples) => {
        if (!mine.open) return
        mine.appended += samples.length
        current.append(samples)
      },
      onLevel: (next) => {
        if (mine.open && recording === mine) level.update(() => next)
      },
    }).then(
      (started) => {
        // The clip ended while the microphone was still asking: let it go at once.
        if (id !== generation) started.stop()
        else capture = started
      },
      (failure: unknown) => {
        const message =
          failure instanceof Error ? failure.message : "Couldn't start the microphone."
        // Said even when the clip ended first: a key let go while the system asked for the
        // microphone would otherwise fail without a word.
        if (id === generation) {
          current.discard()
          endClip()
          state = idle
          publish()
        }
        notify(message, "error", target)
      },
    )
  }

  const finish = (target: TerminalKey): void => {
    const current = clip
    const heardFrom = recording
    const microphone = capture
    cancelLimit?.()
    cancelLimit = null
    clip = null
    capture = null
    recording = null
    // A microphone still being asked for is let go when it answers.
    if (!microphone) generation++
    if (!current || !heardFrom) return dispatch({ type: "settled" })
    const mine = ++transcription
    // False once cancelled: the person has moved on, so neither text nor failure shows.
    const wanted = (): boolean => mine === transcription
    // The microphone keeps listening a moment so the last words are in the clip, which is
    // counted and sent only after.
    abortDrain = () => {
      microphone?.stop()
      heardFrom.open = false
      current.discard()
    }
    void (microphone?.drain() ?? Promise.resolve()).then(() => {
      if (!wanted()) return
      abortDrain = null
      heardFrom.open = false
      // A slip of the key, not speech.
      if (heardFrom.appended / voiceSampleRate < minimumClipSeconds) {
        current.discard()
        return dispatch({ type: "settled" })
      }
      transcribe(current, target, wanted)
    })
  }

  const transcribe = (current: VoiceClip, target: TerminalKey, wanted: () => boolean): void => {
    current
      // The runner hints the engine with the words of the terminal dictated into.
      .finish({ terminalId: target.terminalId })
      .then(({ text }) => {
        if (!wanted()) return
        const said = text.trim()
        if (!said) return notify("Didn't catch anything.", "hint", target)
        if (typeInto(target, said)) return notify(`Typed ${wordCount(said)}`, "done", target)
        // The terminal went while the engine worked, or isn't taking input now: out of sight,
        // or reconnecting. The words stay on the clipboard where that is allowed, and in the
        // message where it is not, so they aren't lost.
        const lost = "The terminal wasn't taking input when the text arrived"
        const clipboard = navigator.clipboard?.writeText(said)
        if (!clipboard) return notify(`${lost}: ${said}`, "error", target)
        clipboard.then(
          () => notify(`${lost}. The text is on your clipboard.`, "error", target),
          () => notify(`${lost}: ${said}`, "error", target),
        )
      })
      .catch((failure: unknown) => {
        if (wanted())
          notify(
            failure instanceof Error ? failure.message : "Couldn't transcribe that.",
            "error",
            target,
          )
      })
      .finally(() => {
        if (wanted()) dispatch({ type: "settled" })
      })
  }

  const run = (effect: DictationEffect): void => {
    switch (effect.kind) {
      case "start":
        return start(effect.target)
      case "stop":
        return finish(effect.target)
      case "discard":
        clip?.discard()
        return endClip()
      case "drop":
        transcription++
        abortDrain?.()
        abortDrain = null
        return
      case "offer":
        return showOffer(effect.target ?? null)
      case "hint":
        return notify(effect.text, "hint", effect.target ?? null, effect.setup)
    }
  }

  const dispatch = (event: DictationEvent): void => {
    const step = stepDictation(state, event)
    state = step.state
    publish()
    step.effects.forEach(run)
  }

  const setup: MutableStore<VoiceSetup | null> = createStore<VoiceSetup | null>(null)
  let cancelSetup: (() => void) | null = null
  // An install this setup followed was seen under way, so its end is told.
  let seen = false
  // Turn on was pressed and its install call has not come back.
  let awaiting = false
  const setSetup = (next: VoiceSetup | null): void => {
    const current = setup.getSnapshot()
    if (current?.kind === next?.kind && current?.target === next?.target) return
    cancelSetup?.()
    cancelSetup = null
    setup.update(() => next)
    const wait =
      next?.kind === "offer"
        ? offerMilliseconds
        : next?.kind === "ready"
          ? readyMilliseconds
          : next?.kind === "failed"
            ? failureMilliseconds
            : 0
    if (wait) cancelSetup = after(wait, () => setSetup(null))
  }
  const showOffer = (target: TerminalKey | null): void => {
    seen = false
    setSetup(null)
    setSetup({ kind: "offer", target })
    noteOffered()
  }
  // The strip's story follows the backend: progress while it installs, the ready note once
  // an install it saw is done, the failure, and nothing after a cancel or a no thanks.
  const sync = (): void => {
    const current = setup.getSnapshot()
    if (!current) return
    const backend = voice.state.getSnapshot()
    const isReady = voiceReady(backend)
    if (!backend.wanted) return setSetup(null)
    // Until the install call is through, a snapshot that shows no install is one from before
    // it, which says nothing of how it goes: it neither drops the strip nor shows an old failure.
    if (awaiting && !backend.installing && current.kind === "installing") return
    if (current.kind === "offer") {
      if (isReady) return setSetup(null)
      if (backend.installing) {
        seen = true
        setSetup({ kind: "installing", target: current.target })
      }
      return
    }
    if (current.kind === "ready") return
    if (backend.installing && !isReady) {
      seen = true
      return setSetup({ kind: "installing", target: current.target })
    }
    if (isReady) return seen ? setSetup({ kind: "ready", target: current.target }) : setSetup(null)
    if (installFailure(backend) !== null)
      return setSetup({ kind: "failed", target: current.target })
    // Under way once and gone with nothing to show: cancelled.
    if (seen && current.kind === "installing") setSetup(null)
  }
  const turnOn = (): void => {
    const current = setup.getSnapshot()
    seen = false
    setSetup({ kind: "installing", target: current?.target ?? null })
    awaiting = true
    const through = (): void => {
      awaiting = false
      sync()
    }
    void Promise.resolve(voice.install()).then(through, through)
    sync()
  }
  const setupActions = {
    turnOn,
    noThanks: (): void => {
      setSetup(null)
      voice.set({ enabled: false })
    },
    cancel: (): void => {
      setSetup(null)
      voice.cancel()
    },
    dismiss: (): void => {
      if (setup.getSnapshot()?.kind === "offer") setSetup(null)
    },
  }
  const offering = (): boolean => setup.getSnapshot()?.kind === "offer" && state.kind === "idle"
  // A clip starting leaves no room for the ready note or a failure, which would hide what
  // the first clip comes to.
  const clearTold = (): void => {
    const kind = setup.getSnapshot()?.kind
    if (kind === "ready" || kind === "failed") setSetup(null)
  }
  const ready = (): Readiness => readiness(voice.state.getSnapshot())
  return {
    voice: voice.state,
    setup,
    setupActions,
    start: () => {
      const unwatch = voice.state.subscribe(sync)
      return () => {
        unwatch()
        cancelSetup?.()
        cancelSetup = null
      }
    },
    view,
    level,
    docks,
    dictation: {
      recording: () => state.kind === "recording",
      active: () => state.kind !== "idle",
      claims: () => state.kind !== "idle" || voiceClaimed(voice.state.getSnapshot()),
      // Pressed again while its offer shows, the shortcut turns voice input on.
      press: (target, code) => {
        if (offering()) return turnOn()
        clearTold()
        dispatch({ type: "press", code, target, now: now(), readiness: ready() })
      },
      release: (code) => dispatch({ type: "release", code, now: now() }),
      blur: () => dispatch({ type: "blur" }),
      cancel: () => dispatch({ type: "cancel" }),
      // The mic, clicked while the offer shows, turns voice input on as the shortcut does.
      toggle: (target) => {
        // Only the mic of the terminal the offer is on means Turn on; another offers there.
        const offer = setup.getSnapshot()
        if (offering() && (!offer?.target || dictationKey(offer.target) === dictationKey(target)))
          return turnOn()
        clearTold()
        dispatch({ type: "toggle", target, now: now(), readiness: ready() })
      },
    },
  }
}
