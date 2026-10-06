import { createStore } from "../../model/store"
import type { Voice, VoiceModel, VoiceState } from "../../model/voice"

// A pretend voice input addon for the browser demo and the specs: nothing is installed
// until the person installs it, and the install walks through downloading the engine, then
// the model, then a check, ending with voice input on. Dictating answers a canned
// transcript a moment after the clip ends.

const megabyte = 1024 * 1024

export const demoVoiceState: VoiceState = {
  available: true,
  installed: [],
  enabled: false,
  model: "turbo",
  language: "auto",
  sizes: { engine: 28 * megabyte, turbo: 574 * megabyte, small: 190 * megabyte },
  installing: null,
  check: null,
  failure: null,
}

export const demoTranscript = "Add a retry to the checkout request and run the tests."

export type DemoVoiceTiming = {
  // How long each of an install's steps takes, in milliseconds.
  readonly step: number
  // How long a transcription takes, in milliseconds.
  readonly transcribe: number
}

// Each step long enough to see, and for a check that runs on a busy machine to catch.
const defaultTiming: DemoVoiceTiming = { step: 1200, transcribe: 600 }

// How many times a download reports progress.
const ticks = 8

export const createDemoVoice = (timing: DemoVoiceTiming = defaultTiming): Voice => {
  const state = createStore<VoiceState>(demoVoiceState)
  let timers: ReturnType<typeof setTimeout>[] = []
  // As the runner: an install turns voice input on unless the person turned it off.
  let turnedOff = false
  const stop = (): void => {
    timers.forEach(clearTimeout)
    timers = []
  }
  const later = (run: () => void, wait: number): void => {
    timers.push(setTimeout(run, wait))
  }

  const sizeOf = (model: VoiceModel, step: "engine" | "model" | "check"): number => {
    const { sizes } = state.getSnapshot()
    if (step === "engine") return sizes.engine
    return step === "model" ? sizes[model] : 1
  }
  const progress = (model: VoiceModel, step: "engine" | "model" | "check", part: number): void => {
    const total = sizeOf(model, step)
    state.update((current) => ({
      ...current,
      installing: { model, step, received: Math.round((total * part) / ticks), total },
    }))
  }
  const finish = (model: VoiceModel): void => {
    const gpu = model === "turbo"
    state.update((current) => ({
      ...current,
      installing: null,
      installed: current.installed.includes(model)
        ? current.installed
        : [...current.installed, model],
      enabled: !turnedOff,
      model,
      check: { model, milliseconds: gpu ? 2300 : 3800, gpu, recommended: model },
    }))
  }

  const install = (model: VoiceModel): void => {
    if (state.getSnapshot().installing) {
      state.update((current) => ({ ...current, failure: "An install is already running." }))
      return
    }
    // The engine stays once downloaded, so a second model skips it.
    const steps: ("engine" | "model" | "check")[] = state.getSnapshot().installed.length
      ? ["model", "check"]
      : ["engine", "model", "check"]
    state.update((current) => ({ ...current, failure: null }))
    steps.forEach((step, index) => {
      for (let part = 0; part <= ticks; part += 1)
        later(() => progress(model, step, part), (index + part / ticks) * timing.step)
    })
    later(() => finish(model), steps.length * timing.step)
  }

  return {
    state,
    install,
    cancel: () => {
      stop()
      state.update((current) => ({ ...current, installing: null }))
    },
    uninstall: () => {
      stop()
      turnedOff = false
      state.update(() => demoVoiceState)
    },
    set: (settings) =>
      state.update((current) => {
        const next = { ...current, ...settings }
        if ((next.enabled || settings.model) && !next.installed.includes(next.model))
          return { ...current, failure: "That model isn't installed." }
        if (settings.enabled !== undefined) turnedOff = !settings.enabled
        return { ...next, failure: null }
      }),
    record: () => ({
      append: () => {},
      finish: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ text: demoTranscript, language: "en" }), timing.transcribe),
        ),
      discard: () => {},
    }),
  }
}
