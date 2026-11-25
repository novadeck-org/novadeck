import type { Backend, BundledPiFetchState } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"

type BundledPi = NonNullable<Backend["bundledPi"]>

// The demo's Novadeck Agent (Preferences > Experimental): switched on, it plays a download of
// pi's size over a few seconds, then is ready; off, it says nothing and keeps its "copy", as the
// runner does. `show` puts it in any state, for the debug panel.
export type DemoBundledPi = BundledPi & {
  readonly show: (enabled: boolean, fetch: BundledPiFetchState) => void
}

// pi 1.6.0's Linux archive, as the runner's pin names it.
const size = 58_977_130
const steps = 20
const stepMs = 150

export const createDemoBundledPi = (): DemoBundledPi => {
  const enabled = createStore(false)
  const fetch = createStore<BundledPiFetchState>({ state: "off" })
  let ready = false
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const download = () => {
    stop()
    let step = 0
    fetch.update(() => ({ state: "downloading", received: 0, size }))
    timer = setInterval(() => {
      step += 1
      if (step < steps) {
        fetch.update(() => ({
          state: "downloading",
          received: Math.round((size * step) / steps),
          size,
        }))
        return
      }
      stop()
      ready = true
      fetch.update(() => ({ state: "ready" }))
    }, stepMs)
  }
  return {
    enabled,
    fetch,
    set: (on) => {
      enabled.update(() => on)
      if (!on) {
        stop()
        fetch.update(() => ({ state: "off" }))
      } else if (ready) fetch.update(() => ({ state: "ready" }))
      else if (fetch.getSnapshot().state !== "downloading") download()
    },
    show: (on, state) => {
      stop()
      ready = state.state === "ready"
      enabled.update(() => on)
      fetch.update(() => state)
    },
  }
}

export const isDemoBundledPi = (
  bundledPi: Backend["bundledPi"] | undefined,
): bundledPi is DemoBundledPi => bundledPi !== undefined && "show" in bundledPi
