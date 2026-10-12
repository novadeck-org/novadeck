import { MURMUR_NAME, type Murmur, type MurmurState } from "../../model/murmur"
import { createStore } from "../../model/store"

// A pretend murmur addon for the browser demo and the specs: nothing is installed until
// the person installs it, and the install walks through downloading the engine, then the
// model, then a check, ending with murmur on.

const megabyte = 1024 * 1024

export const demoMurmurState: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: { engine: 34 * megabyte, model: 1222 * megabyte },
  installing: null,
  check: null,
  failure: null,
}

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

// How many times a download reports progress.
const ticks = 8

const steps = ["engine", "model", "check"] as const

export const createDemoMurmur = (timing: DemoMurmurTiming = defaultTiming): Murmur => {
  const state = createStore<MurmurState>(demoMurmurState)
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
      installing: { step, received: Math.round((total * part) / ticks), total },
    }))
  }
  // The files are on disk either way; with no GPU the check fails and murmur can't run.
  const finish = (): void => {
    const { device } = timing
    state.update((current) => ({
      ...current,
      installing: null,
      installed: true,
      enabled: device !== null && choice !== false,
      wanted: choice !== false,
      check: device === null ? null : { device, integrated: true, milliseconds: 5200 },
      failure: device === null ? `${MURMUR_NAME} needs a GPU on this computer.` : null,
    }))
  }

  const install = (): void => {
    if (state.getSnapshot().installing) {
      state.update((current) => ({
        ...current,
        failure: "An install is already running.",
      }))
      return
    }
    // As the runner: a first install says murmur is wanted, whatever was chosen before.
    if (!state.getSnapshot().installed) choice = undefined
    state.update((current) => ({
      ...current,
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
      // Removing it says the person doesn't want it.
      choice = false
      state.update(() => ({ ...demoMurmurState, wanted: false }))
      return Promise.resolve()
    },
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
