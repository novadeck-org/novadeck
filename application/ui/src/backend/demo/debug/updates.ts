import type { UpdateChannel, UpdateOffer } from "../../../model/update"
import { updateScenarios } from "../scenarios"
import type { DemoActionGroup, DemoStates } from "./types"
import type { DemoLaunch } from "./with-debug"

// The browser's stand-in for the desktop app's self-updates: `offer` has an update, which
// listeners hear at once if they come later and again for each newer one. `finish` stands
// for the app coming back on the new version, a reload that forgets the offer, while one
// waits. `download` offers a version as downloading, its percent climbing until it is
// offered ready; any later offer, or a failed download, calls a running one off.
// `openPage` does nothing, since a browser has no release page to open.
// The channel is remembered until the page reloads.
export const createDemoUpdates = (
  restart: () => void = () => window.location.reload(),
): {
  readonly updates: DemoStates["updates"]
  readonly offer: (offer: UpdateOffer) => void
  readonly download: (version: string) => void
  readonly finish: () => void
  // A download fails, which the app retries by itself: the one running, or, with none, one
  // started and held at 40% that fails shortly after, so the bar and its drop both show.
  readonly failDownload: (version: string) => void
  readonly channel: () => UpdateChannel
} => {
  let waiting: UpdateOffer | undefined
  let channel: UpdateChannel = "stable"
  const listeners = new Set<(offer: UpdateOffer) => void>()
  let downloading: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    clearInterval(downloading)
    downloading = undefined
  }
  const tell = (offer: UpdateOffer): void => {
    waiting = offer
    listeners.forEach((listener) => listener(offer))
  }
  return {
    updates: {
      onOffer: (listener) => {
        listeners.add(listener)
        if (waiting !== undefined) listener(waiting)
        return () => void listeners.delete(listener)
      },
      openPage: () => {},
      channel: {
        get: () => Promise.resolve(channel),
        set: (next) => void (channel = next),
      },
    },
    offer: (offer) => {
      stop()
      tell(offer)
    },
    download: (version) => {
      stop()
      let percent = 0
      tell({ kind: "downloading", version, percent })
      downloading = setInterval(() => {
        percent = Math.min(percent + downloadStep, 100)
        if (percent < 100) return tell({ kind: "downloading", version, percent })
        stop()
        tell({ kind: "ready", version })
      }, downloadMs)
    },
    finish: () => {
      if (waiting !== undefined) restart()
    },
    failDownload: (version) => {
      const fail = (): void => {
        if (waiting?.kind !== "downloading") return
        stop()
        tell({ kind: "retrying", version: waiting.version })
      }
      if (waiting?.kind === "downloading") return fail()
      stop()
      tell({ kind: "downloading", version, percent: 40 })
      setTimeout(fail, failAfterMs)
    },
    channel: () => channel,
  }
}

// How often a demo download advances, and by how many percent.
export const downloadMs = 300
export const downloadStep = 10
// How long a download held for failing stays at 40% first.
export const failAfterMs = 1500

// What the Updates group plays an installed copy's updates with.
export type DemoUpdates = ReturnType<typeof createDemoUpdates>

// Each press offers a newer version than the last, across boots too.
let patch = 79
const nextVersion = (): string => `0.0.${(patch += 1)}`

// The panel's group for an installed copy's updates. On a portable copy, whose install
// entry would stand in for them, each one boots the demo again as an installed copy and
// plays there.
export const updatesGroup = (launch: DemoLaunch, controls: DemoUpdates): DemoActionGroup => {
  const installed = (play: (updates: DemoUpdates) => void) =>
    launch.portable
      ? { reboots: true as const, run: () => launch.bootInstalled(play) }
      : { run: () => play(controls) }
  const scenarios = Object.values(updateScenarios).map(({ label, hint, play }) => ({
    label,
    hint,
    ...installed((updates) => play(updates, nextVersion())),
  }))
  return {
    section: "App",
    title: "Updates",
    actions: [
      ...scenarios,
      {
        label: "Early builds on",
        hint: "Shows in Preferences once reopened",
        run: () => controls.updates.channel?.set("early"),
      },
      {
        label: "Early builds off",
        hint: "Shows in Preferences once reopened",
        run: () => controls.updates.channel?.set("stable"),
      },
      {
        label: "Finish restart",
        reboots: true,
        hint: "Reloads on the new version; update gone",
        run: controls.finish,
      },
    ],
  }
}
