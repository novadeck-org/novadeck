import type { UpdateChannel, UpdateOffer, WhatsNew } from "@novadeck/core/desktop/update"

import type { DemoLaunch } from "../debug-demo"
import type { DemoActionGroup, DemoStates } from "../types"
import { releaseVersions, updateScenarios } from "./scenarios"

// The browser's stand-in for the desktop app's self-updates: `offer` has an update, which
// listeners hear at once if they come later and again for each newer one. `finish` stands
// for the app coming back on the new version, a reload that forgets the offer, while one
// waits. `download` offers a version as downloading, its percent climbing until it is
// offered ready; any later offer, or a failed download, calls a running one off.
// `openPage` does nothing, since a browser has no release page to open. `allow`, on an
// offer that has it, stands for the administrator's step succeeding: the update downloads.
// The channel is kept in `memory`: the page's (`pageUpdateChannel`) lasts across the demo's
// boots until the page reloads. `showWhatsNew` has the app answer, when
// asked, that the app updated to `version`, from `from` when given, whose release names the
// highlights below, and its `headsUp` when given, until they are dismissed (the heads-up alone
// can be, as "Got it" does); `whatsNewCalls` counts what the page asked of the app since.
export const createDemoUpdates = (
  restart: () => void = () => window.location.reload(),
  memory: { channel: UpdateChannel } = { channel: "stable" },
): {
  readonly updates: DemoStates["updates"]
  readonly offer: (offer: UpdateOffer) => void
  readonly download: (version: string) => void
  readonly finish: () => void
  // A download fails, which the app retries by itself: the one running, or, with none, one
  // started and held at 40% that fails shortly after, so the bar and its drop both show.
  readonly failDownload: (version: string) => void
  readonly channel: () => UpdateChannel
  readonly whatsNew: DemoStates["whatsNew"]
  readonly showWhatsNew: (
    version: string,
    notes?: {
      readonly highlights?: WhatsNew["highlights"]
      readonly headsUp?: WhatsNew["highlights"]
      readonly from?: string
    },
  ) => void
  readonly whatsNewCalls: { dismissed: number; headsUpDismissed: number; asked: number }
  // Has the app take this long to answer what is new.
  readonly delayWhatsNew: (ms: number) => void
} => {
  let notes: WhatsNew | undefined
  const whatsNewCalls = { dismissed: 0, headsUpDismissed: 0, asked: 0 }
  let answerAfterMs = 0
  let waiting: UpdateOffer | undefined
  const listeners = new Set<(offer: UpdateOffer) => void>()
  let downloading: ReturnType<typeof setInterval> | undefined
  // The failure still to come of a download held for failing.
  let failing: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    clearInterval(downloading)
    downloading = undefined
    clearTimeout(failing)
    failing = undefined
  }
  const tell = (offer: UpdateOffer): void => {
    waiting = offer
    listeners.forEach((listener) => listener(offer))
  }
  const download = (version: string): void => {
    stop()
    let percent = 0
    tell({ kind: "downloading", version, percent })
    downloading = setInterval(() => {
      percent = Math.min(percent + downloadStep, 100)
      if (percent < 100) return tell({ kind: "downloading", version, percent })
      stop()
      tell({ kind: "ready", version })
    }, downloadMs)
  }
  return {
    updates: {
      onOffer: (listener) => {
        listeners.add(listener)
        if (waiting !== undefined) listener(waiting)
        return () => void listeners.delete(listener)
      },
      openPage: () => {},
      allow: () => {
        if (waiting?.kind === "available" && waiting.allow === true) download(waiting.version)
      },
      channel: {
        get: () => Promise.resolve(memory.channel),
        set: (next) => void (memory.channel = next),
      },
    },
    offer: (offer) => {
      stop()
      tell(offer)
    },
    download,
    finish: () => {
      if (waiting !== undefined) restart()
    },
    failDownload: (version) => {
      const fail = (): void => {
        if (waiting?.kind !== "downloading") return
        stop()
        tell({ kind: "retrying", version: waiting.version })
      }
      if (downloading !== undefined) return fail()
      stop()
      tell({ kind: "downloading", version, percent: 40 })
      failing = setTimeout(fail, failAfterMs)
    },
    channel: () => memory.channel,
    whatsNew: {
      get: () => {
        whatsNewCalls.asked += 1
        const answer = notes
        return answerAfterMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve(answer), answerAfterMs))
          : Promise.resolve(answer)
      },
      dismiss: () => {
        whatsNewCalls.dismissed += 1
        notes = undefined
      },
      dismissHeadsUp: () => {
        whatsNewCalls.headsUpDismissed += 1
        // As the app answers once they are got: the highlights alone, or nothing left.
        if (!notes) return
        const { version, from, highlights } = notes
        notes =
          highlights.length > 0
            ? { version, ...(from === undefined ? {} : { from }), highlights }
            : undefined
      },
    },
    showWhatsNew: (version, { highlights = sampleHighlights, headsUp, from } = {}) =>
      void (notes = {
        version,
        ...(from === undefined ? {} : { from }),
        highlights,
        ...(headsUp ? { headsUp } : {}),
      }),
    whatsNewCalls,
    delayWhatsNew: (ms) => void (answerAfterMs = ms),
  }
}

// Highlights as a release's notes name them: a short title, one plain line and an icon.
const sampleHighlights: WhatsNew["highlights"] = [
  {
    title: "Word handles for terminals",
    line: 'Talk to @moth instead of "terminal 3".',
    icon: "users",
  },
  {
    title: "Plans open beside the terminal",
    line: "Edit an agent's plan while it works.",
    icon: "panel-right",
  },
  {
    title: "Answer agents from the Inbox",
    line: "Reply to an agent without opening its terminal.",
    icon: "inbox",
  },
]

// How often a demo download advances, and by how many percent.
export const downloadMs = 300
export const downloadStep = 10
// How long a download held for failing stays at 40% first.
export const failAfterMs = 1500

// The page's update channel, which every boot's updates share until it reloads.
export const pageUpdateChannel: { channel: UpdateChannel } = { channel: "stable" }

// What the Updates group plays an installed copy's updates with.
export type DemoUpdates = ReturnType<typeof createDemoUpdates>

// Each press offers a newer version than the last, across boots too.
const nextVersion = releaseVersions()

// The panel's group for an installed copy's updates. On a portable copy, whose install
// entry would stand in for them, each one boots the demo again as an installed copy and
// plays there.
export const updatesGroup = (launch: DemoLaunch, controls: DemoUpdates): DemoActionGroup => {
  const installed = (play: (updates: DemoUpdates) => void) =>
    launch.portable
      ? { reboots: true as const, run: () => launch.bootInstalled(play) }
      : { run: () => play(controls) }
  const scenarios = Object.values(updateScenarios).map((scenario) => {
    const { label, hint, play } = scenario
    return {
      label,
      hint,
      ...("reboots" in scenario
        ? {
            reboots: true as const,
            run: () => {
              const version = nextVersion()
              launch.bootInstalled((updates) => play(updates, version))
            },
          }
        : installed((updates) => play(updates, nextVersion()))),
    }
  })
  return {
    section: "App",
    title: "Updates",
    actions: [
      ...scenarios,
      {
        label: "Experimental on",
        hint: "Takes effect once Preferences is reopened",
        run: () => controls.updates.channel?.set("experimental"),
      },
      {
        label: "Experimental off",
        hint: "Takes effect once Preferences is reopened",
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
