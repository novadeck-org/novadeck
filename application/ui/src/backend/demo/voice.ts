import { createStore } from "#core/store"
import type { Voice, VoiceModel, VoiceState } from "#core/voice"

// A pretend voice input addon for the browser demo and the specs. It starts installed and
// on, as the try demo shows it and never offers it; started uninstalled, nothing is
// installed until the person installs it, and the install walks through downloading the
// engine, then the model, then a check, ending with voice input on. As the runner's on a
// computer with a GPU, it installs turbo and nothing more. Dictating answers a canned
// transcript a moment after the clip ends.

const megabyte = 1024 * 1024

// Voice input not on the computer, wanted until the person says otherwise.
export const demoVoiceState: VoiceState = {
  available: true,
  installed: [],
  enabled: false,
  wanted: true,
  model: "turbo",
  aim: "turbo",
  engineInstalled: false,
  language: "auto",
  sizes: { engine: 28 * megabyte, turbo: 574 * megabyte, small: 190 * megabyte },
  installing: null,
  check: null,
  failure: null,
  refused: null,
}

const installedState: VoiceState = {
  ...demoVoiceState,
  installed: ["turbo"],
  engineInstalled: true,
  enabled: true,
  check: { model: "turbo", milliseconds: 2300 },
}

// Where the demo starts: installed (the try demo's), or not (the offer, and the Addons
// card's Install), or not, and its first install fails.
export type DemoVoiceStart = "installed" | "uninstalled" | "failing"

// What a spec asks for in its address's hash: `&voice=uninstalled`, or `&voice=failing`, not
// installed with an install that fails.
export const requestedVoice = (): DemoVoiceStart => {
  const asked =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("voice")
  return asked === "uninstalled" || asked === "failing" ? asked : "installed"
}

// What the debug panel puts voice input in.
export type DemoVoiceScenario =
  | DemoVoiceStart
  | "declined"
  | "installing"
  | "install-and-finish"
  | "install-fallback"
  | "cancelled-at-check"
  | "software-graphics"
  | "network-failure"

export type DemoVoice = Voice & { readonly show: (scenario: DemoVoiceScenario) => void }

export const isDemoVoice = (voice: Voice | undefined): voice is DemoVoice =>
  voice !== undefined && "show" in voice

export const demoTranscript = "Add a retry to the checkout request and run the tests."

export type DemoVoiceTiming = {
  // How long each of an install's steps takes, in milliseconds.
  readonly step: number
  // How long a transcription takes, in milliseconds.
  readonly transcribe: number
}

// Each step long enough to see, and for a check that runs on a busy machine to catch.
const defaultTiming: DemoVoiceTiming = { step: 1200, transcribe: 600 }

// An install that holds at its first step, for a spec that stops one: its Cancel then never
// races the demo's clock to the install's end, however slow the machine. Four days a step, so
// the last timer of the longest install (the voice fallback's, five steps on) still fits
// setTimeout, which fires at once past 2^31 ms.
export const heldVoiceTiming: DemoVoiceTiming = { ...defaultTiming, step: 400_000_000 }

// How many times a download reports progress.
const ticks = 8

// What an install that stops where it is has put on disk: the engine once its step is past,
// and the model once its step is.
const keepWhatCame = (current: VoiceState): VoiceState => {
  const { installing } = current
  if (!installing || installing.step === "engine") return { ...current, installing: null }
  return {
    ...current,
    installing: null,
    engineInstalled: true,
    installed:
      installing.step === "check" && !current.installed.includes(installing.model)
        ? [...current.installed, installing.model]
        : current.installed,
  }
}

export const createDemoVoice = (
  timing: DemoVoiceTiming = defaultTiming,
  start: DemoVoiceStart = "installed",
): DemoVoice => {
  const state = createStore<VoiceState>(start === "installed" ? installedState : demoVoiceState)
  let timers: ReturnType<typeof setTimeout>[] = []
  // As the runner, the person's choice, undefined until they make one: a first install
  // turns voice input on, another unless they turned it off.
  let choice: boolean | undefined
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
      installing: {
        origin: "person",
        model,
        step,
        received: Math.round((total * part) / ticks),
        total,
      },
    }))
  }
  const finish = (model: VoiceModel): void => {
    const gpu = model === "turbo"
    state.update((current) => ({
      ...current,
      installing: null,
      installed: [model],
      engineInstalled: true,
      aim: model,
      enabled: choice !== false,
      wanted: choice !== false,
      model,
      check: { model, milliseconds: gpu ? 2300 : 3800 },
    }))
  }

  // Whether the next install finds turbo too slow, as the runner's does on a computer
  // without a GPU: it goes on to small, and turbo goes.
  let slowTurbo = false
  // Whether the host saw only software rendering, which keeps the aim at small, as the runner's.
  let software = false
  // How the next install ends instead of finishing: held at the model, half there, until
  // cancelled, or failing as a connection that drops.
  let endsIn: "hold" | "failure" | undefined = start === "failing" ? "failure" : undefined

  const begin = (): void => {
    if (state.getSnapshot().installing) {
      state.update((current) => ({
        ...current,
        refused: { call: "install", message: "Voice input is already installing." },
      }))
      return
    }
    const { installed, aim } = state.getSnapshot()
    // The engine stays once downloaded, so another install skips it.
    const steps: { model: VoiceModel; step: "engine" | "model" | "check" }[] = [
      ...(state.getSnapshot().engineInstalled ? [] : [{ model: aim, step: "engine" as const }]),
      ...(installed.includes(aim) ? [] : [{ model: aim, step: "model" as const }]),
      { model: aim, step: "check" },
      ...(aim === "turbo" && slowTurbo
        ? [
            { model: "small" as const, step: "model" as const },
            { model: "small" as const, step: "check" as const },
          ]
        : []),
    ]
    // As the runner: the last check stays until a new one passes, and a first install says
    // voice input is wanted, whatever was chosen before.
    if (installed.length === 0) choice = undefined
    state.update((current) => ({
      ...current,
      failure: null,
      wanted: choice !== false,
      // At once, as the first step of the install is begun by the call itself.
      installing: {
        origin: "person",
        model: aim,
        step: steps[0]!.step,
        received: 0,
        total: sizeOf(aim, steps[0]!.step),
      },
    }))
    const held = endsIn === "hold" ? steps.findIndex(({ step }) => step === "model") : -1
    const failing = endsIn === "failure" ? steps.findIndex(({ step }) => step === "model") : -1
    steps.forEach(({ model, step }, index) => {
      // Held: the model's download stops half way, and nothing follows.
      const last = index === held || index === failing ? ticks / 2 : ticks
      if ((held >= 0 && index > held) || (failing >= 0 && index > failing)) return
      for (let part = 0; part <= last; part += 1)
        later(() => progress(model, step, part), (index + part / ticks) * timing.step)
    })
    if (held >= 0) return
    if (failing >= 0) {
      endsIn = undefined
      later(
        () =>
          state.update((current) => ({
            ...keepWhatCame(current),
            failure: "The download stopped: the connection dropped.",
          })),
        (failing + 0.5) * timing.step,
      )
      return
    }
    later(() => finish(aim === "turbo" && slowTurbo ? "small" : aim), steps.length * timing.step)
  }
  // The call comes back at once, as the runner's does once the install has started.
  const install = (): Promise<void> => {
    begin()
    return Promise.resolve()
  }

  const show = (scenario: DemoVoiceScenario): void => {
    stop()
    choice = undefined
    slowTurbo = false
    software = false
    endsIn = undefined
    if (scenario === "installed") state.update(() => installedState)
    else if (scenario === "uninstalled") state.update(() => demoVoiceState)
    else if (scenario === "declined") {
      // As the runner after No thanks: off by choice, nothing installed.
      choice = false
      state.update(() => ({ ...demoVoiceState, wanted: false }))
    } else if (scenario === "installing") {
      // The next install is held at the model, half there, until cancelled.
      state.update(() => demoVoiceState)
      endsIn = "hold"
    } else if (scenario === "install-and-finish") state.update(() => demoVoiceState)
    else if (scenario === "install-fallback") {
      // Turbo downloads and checks, and is too slow here: small follows, and turbo goes.
      state.update(() => demoVoiceState)
      slowTurbo = true
    } else if (scenario === "cancelled-at-check")
      // A cancel at the check left the engine and the model on disk, never checked.
      state.update(() => ({
        ...demoVoiceState,
        engineInstalled: true,
        installed: ["turbo"],
      }))
    else if (scenario === "software-graphics") {
      // As the runner where the host saw only software rendering: small is what installs,
      // and what the offer quotes.
      software = true
      state.update(() => ({ ...demoVoiceState, aim: "small" }))
    } else {
      // The next install fails as a connection that drops.
      state.update(() => demoVoiceState)
      endsIn = "failure"
    }
  }

  return {
    state,
    show,
    install,
    cancel: () => {
      stop()
      state.update(keepWhatCame)
    },
    uninstall: () => {
      stop()
      // Removing it says the person doesn't want it.
      choice = false
      state.update(() => ({ ...demoVoiceState, aim: software ? "small" : "turbo", wanted: false }))
    },
    set: (settings) =>
      state.update((current) => {
        const next = { ...current, ...settings }
        // Turned on before an install, or with a model that never passed its check, it is only
        // wanted, as the runner has it, and the install that follows turns it on.
        if (
          settings.enabled === true &&
          (!next.installed.includes(next.model) || next.check?.model !== next.model)
        ) {
          choice = undefined
          return { ...next, enabled: false, wanted: true, failure: null, refused: null }
        }
        if (settings.enabled !== undefined) choice = settings.enabled
        return { ...next, wanted: choice !== false, failure: null, refused: null }
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
