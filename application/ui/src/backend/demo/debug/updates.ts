import type { UpdateChannel, UpdateOffer } from "../../../model/update"
import type { DemoStates } from "./types"

// The browser's stand-in for the desktop app's self-updates: `offer` has an update, which
// listeners hear at once if they come later and again for each newer one. `install` does
// nothing more, so the footer's Restarting… stays for as long as anyone wants to look at
// it; `finish` ends the restart as the app comes back, a reload that forgets the offer,
// while one waits. `openPage` only counts, since a browser has no release page to open.
// The channel is remembered until the page reloads.
export const createDemoUpdates = (
  restart: () => void = () => window.location.reload(),
): {
  readonly updates: DemoStates["updates"]
  readonly offer: (offer: UpdateOffer) => void
  readonly finish: () => void
  // The install failed: the update waiting is offered again, to fetch by hand.
  readonly failInstall: () => void
  readonly channel: () => UpdateChannel
  readonly pagesOpened: () => number
} => {
  let waiting: UpdateOffer | undefined
  let channel: UpdateChannel = "stable"
  let pages = 0
  const listeners = new Set<(offer: UpdateOffer) => void>()
  return {
    updates: {
      onOffer: (listener) => {
        listeners.add(listener)
        if (waiting !== undefined) listener(waiting)
        return () => void listeners.delete(listener)
      },
      install: () => {},
      openPage: () => void (pages += 1),
      channel: {
        get: () => Promise.resolve(channel),
        set: (next) => void (channel = next),
      },
    },
    offer: (offer) => {
      waiting = offer
      listeners.forEach((listener) => listener(offer))
    },
    finish: () => {
      if (waiting !== undefined) restart()
    },
    failInstall: () => {
      if (waiting === undefined) return
      waiting = { ...waiting, kind: "available" }
      listeners.forEach((listener) => listener(waiting!))
    },
    channel: () => channel,
    pagesOpened: () => pages,
  }
}

// Release notes as a release's might read: a handful of lines.
export const sampleNotes: readonly string[] = [
  "Terminals keep their place when you switch projects.",
  "Grid view remembers the tiles you resized.",
  "Fixed a crash when an agent finished while the window was minimized.",
  "Faster startup on large workspaces.",
]

// The most an offer carries, as the desktop host caps it: 12 notes of 200 characters.
export const longestNotes: readonly string[] = Array.from({ length: 12 }, (_, index) =>
  `${index + 1}. ${"A long release note that runs on and on. ".repeat(6)}`.slice(0, 200),
)
