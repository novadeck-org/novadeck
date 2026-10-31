import type { Murmur, MurmurState } from "@novadeck/core/addons/murmur"
import { createStore, type MutableStore } from "@novadeck/core/store"

import { addressParams } from "../address"

// A pretend murmur addon for the browser demo and the specs. It starts installed and on,
// as the try demo shows it and never offers it; started uninstalled, nothing is installed
// until the person installs it, and the install walks through downloading the engine, then
// the model, then a check, ending with murmur on. `device: null` is a computer that can't
// run it: the check ends in Not available, with the downloads removed.

const megabyte = 1024 * 1024

const downloadSizes = { engine: 34 * megabyte, model: 1222 * megabyte }

// Murmur not on the computer, wanted until the person says otherwise.
const demoMurmurState: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: downloadSizes,
  installing: null,
  check: null,
  kept: false,
  unsupported: null,
  offers: 0,
  refused: null,
  failure: null,
  stopped: null,
}

const sampleCheck = { device: "Intel Arc Graphics", integrated: true, milliseconds: 5200 }

const installedState: MurmurState = {
  ...demoMurmurState,
  installed: true,
  enabled: true,
  check: sampleCheck,
}

const softwareSample = {
  reason: "This computer reports only software rendering; no graphics hardware answered.",
  source: "app",
} as const

const unsupportedSample = {
  reason: "No graphics device answered. On Linux, check that a Vulkan driver is installed.",
  source: "check",
} as const

// Where the demo starts: installed (the try demo's), not installed (the offer and the
// Addons card's Install), on a computer known not to run it, or not installed on a
// computer whose check will end in Not available.
export type DemoMurmurStart =
  | "installed"
  | "uninstalled"
  | "unsupported"
  | "no-device"
  | "offered-out"
  | "network-down"

// What a spec asks for in its address's hash: `&murmur=uninstalled`, `unsupported`,
// `no-device`, `network-down` (the first install fails on the network, the second works) or
// `offered-out` (not installed, the offer already shown in three sessions).
export const requestedMurmur = (): DemoMurmurStart => {
  const asked = typeof window === "undefined" ? null : addressParams().get("murmur")
  return asked === "uninstalled" ||
    asked === "unsupported" ||
    asked === "no-device" ||
    asked === "offered-out" ||
    asked === "network-down"
    ? asked
    : "installed"
}

// What the debug panel puts murmur in.
export type DemoMurmurScenario =
  | DemoMurmurStart
  | "installing"
  | "network-failure"
  | "unsupported-after-install"
  | "unsupported-app"
  | "unsupported-with-files"
  | "checking"
  | "done"
  | "unavailable-after-check"
  | "offer"

export type DemoMurmur = Murmur & {
  readonly show: (scenario: DemoMurmurScenario) => void
  // Each bump asks the app to offer Murmur now, on the selected terminal (see `Murmur.offer`).
  readonly offer: MutableStore<number>
}

export const isDemoMurmur = (murmur: Murmur | undefined): murmur is DemoMurmur =>
  murmur !== undefined && "show" in murmur

export type DemoMurmurTiming = {
  // How long each of an install's steps takes, in milliseconds.
  readonly step: number
  // The GPU the check passes on; null for a computer with none that works.
  readonly device: string | null
}

// Each step long enough to see.
const defaultTiming: DemoMurmurTiming = {
  step: 1200,
  device: "Intel Arc Graphics",
}

// An install that holds at its first step, for a spec that stops one: its Cancel then never
// races the demo's clock to the install's end, however slow the machine. Four days a step, so
// the last timer of the longest install (the voice fallback's, five steps on) still fits
// setTimeout, which fires at once past 2^31 ms.
export const heldMurmurTiming: DemoMurmurTiming = { ...defaultTiming, step: 400_000_000 }

// How many times a download reports progress.
const ticks = 8

const steps = ["engine", "model", "check"] as const

// Murmur not on the computer, at a step of its install.
const installingAt = (step: "engine" | "model" | "check", received: number): MurmurState => ({
  ...demoMurmurState,
  installing: {
    step,
    received,
    origin: "person",
    total: step === "model" ? downloadSizes.model : step === "engine" ? downloadSizes.engine : 0,
  },
})

// Puts `next` on show, keeping the count of sessions the offer was shown in, which is the
// runner's whatever is on show.
const keepOffers = (state: MutableStore<MurmurState>, next: MurmurState): void =>
  void state.update((current) => ({ ...next, offers: current.offers }))

export const createDemoMurmur = (
  initial: DemoMurmurTiming = defaultTiming,
  start: DemoMurmurStart = "installed",
): DemoMurmur => {
  // The first install of a computer whose network is down fails at its end, with a failure to try again.
  let networkDown = start === "network-down"
  let timing = start === "no-device" ? { ...initial, device: null } : initial
  const state = createStore<MurmurState>(
    start === "installed"
      ? installedState
      : start === "unsupported"
        ? { ...demoMurmurState, unsupported: unsupportedSample }
        : start === "offered-out"
          ? { ...demoMurmurState, offers: 3 }
          : demoMurmurState,
  )
  const offer = createStore(0)
  let timers: ReturnType<typeof setTimeout>[] = []
  // As the runner, the person's choice, undefined until they make one: an install turns
  // murmur on unless they turned it off.
  let choice: boolean | undefined
  const stop = (): void => {
    timers.forEach(clearTimeout)
    timers = []
  }
  const later = (run: () => void, wait: number): void => {
    timers.push(setTimeout(run, wait))
  }

  const progress = (step: (typeof steps)[number], part: number): void => {
    const { sizes } = state.getSnapshot()
    const total = step === "engine" ? sizes.engine : step === "model" ? sizes.model : 1
    state.update((current) => ({
      ...current,
      installing: { step, received: Math.round((total * part) / ticks), total, origin: "person" },
    }))
  }
  // With no device that works the check ends in Not available, as the runner's: the
  // downloads are removed and the verdict stays.
  const finish = (): void => {
    const { device } = timing
    if (device === null) {
      state.update((current) => ({
        ...demoMurmurState,
        wanted: choice !== false,
        unsupported: unsupportedSample,
        offers: current.offers,
      }))
      return
    }
    if (networkDown) {
      networkDown = false
      state.update((current) => ({
        ...current,
        installing: null,
        failure: "The download stopped: the connection dropped.",
      }))
      return
    }
    state.update((current) => ({
      ...current,
      installing: null,
      installed: true,
      enabled: choice !== false,
      wanted: choice !== false,
      check: { device, integrated: true, milliseconds: 5200 },
      // A check that passes ends the verdict an earlier one gave.
      unsupported: null,
      failure: null,
    }))
  }

  const install = (): Promise<void> => {
    const refuse = (message: string): Promise<void> => {
      state.update((current) => ({ ...current, refused: { call: "install", message } }))
      return Promise.resolve()
    }
    if (state.getSnapshot().installing) return refuse("An install is already running.")
    // As the runner: the app's word is final, a check's verdict stands until a check passes.
    if (state.getSnapshot().unsupported?.source === "app")
      return refuse("Murmur can't run on this computer.")
    // As the runner: a first install says murmur is wanted, whatever was chosen before.
    if (!state.getSnapshot().installed) choice = undefined
    state.update((current) => ({
      ...current,
      refused: null,
      failure: null,
      check: null,
      wanted: choice !== false,
    }))
    // The files stay once downloaded, so another try only runs the check.
    const todo = state.getSnapshot().installed ? steps.slice(2) : steps
    todo.forEach((step, index) => {
      for (let part = 0; part <= ticks; part += 1)
        later(() => progress(step, part), (index + part / ticks) * timing.step)
    })
    later(finish, todo.length * timing.step)
    return Promise.resolve()
  }

  const show = (scenario: DemoMurmurScenario): void => {
    stop()
    choice = undefined
    if (scenario === "installed") keepOffers(state, installedState)
    else if (scenario === "unsupported")
      keepOffers(state, { ...demoMurmurState, unsupported: unsupportedSample })
    else if (scenario === "unsupported-app")
      // The app saw only software rendering: no Check again.
      keepOffers(state, { ...demoMurmurState, unsupported: softwareSample })
    else if (scenario === "unsupported-with-files")
      // Removing the files for a verdict failed: they stay, unchecked, beside it.
      keepOffers(state, {
        ...installedState,
        enabled: false,
        check: null,
        unsupported: unsupportedSample,
      })
    else if (scenario === "installing")
      // Held at the model, half there, until cancelled.
      keepOffers(state, installingAt("model", downloadSizes.model / 2))
    else if (scenario === "checking") keepOffers(state, installingAt("check", 0))
    else if (scenario === "done") {
      keepOffers(state, installingAt("check", 0))
      later(() => keepOffers(state, installedState), 1800)
    } else if (scenario === "unavailable-after-check") {
      keepOffers(state, installingAt("check", 0))
      later(() => keepOffers(state, { ...demoMurmurState, unsupported: unsupportedSample }), 1800)
    } else if (scenario === "network-failure") {
      // An install that fails on the network, as the footer's item sees it: running, then not.
      keepOffers(state, installingAt("model", downloadSizes.model / 2))
      later(
        () =>
          keepOffers(state, {
            ...demoMurmurState,
            failure: "The download stopped: the connection dropped.",
          }),
        1500,
      )
    } else if (scenario === "offer") {
      // Not installed, and the app asked to offer it on the selected terminal.
      keepOffers(state, demoMurmurState)
      offer.update((count) => count + 1)
    } else {
      // The next install ends where the computer can't run it.
      keepOffers(state, demoMurmurState)
      timing = scenario === "unsupported-after-install" ? { ...initial, device: null } : initial
    }
  }

  return {
    state,
    show,
    offer,
    install,
    cancel: () => {
      stop()
      // As the runner's: once the model is down, a cancel in the check leaves the files with the
      // check owed, no failure.
      state.update((current) =>
        current.installing?.step === "check"
          ? { ...current, installing: null, installed: true }
          : { ...current, installing: null },
      )
    },
    uninstall: () => {
      stop()
      // Removing it says the person doesn't want it.
      choice = false
      state.update((current) => ({ ...demoMurmurState, wanted: false, offers: current.offers }))
      return Promise.resolve()
    },
    // The one-time offer was shown in a session: counted, and nothing else changes.
    noteOffered: () => void state.update((current) => ({ ...current, offers: current.offers + 1 })),
    set: (settings) =>
      state.update((current) => {
        // Turned on before an install, it is wanted, and the install will turn it on.
        if (settings.enabled === true && !current.installed) {
          choice = undefined
          return { ...current, enabled: false, wanted: true, failure: null }
        }
        if (settings.enabled !== undefined) choice = settings.enabled
        return {
          ...current,
          ...settings,
          wanted: choice !== false,
          failure: null,
        }
      }),
  }
}
