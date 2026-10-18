import type { Backend } from "#core/port"
import type { PortableInstall, PortableState } from "#core/portable"
import type { UpdateOffer } from "#core/update"

import { portableScenarios } from "./scenarios"
import type { DemoActionGroup } from "./types"
import type { DemoLaunch } from "./with-debug"

// A portable copy as the demo plays one: the release waiting, if any, and how installing
// from it goes: what it ends as, which comes after `installAfterMs` (at once when absent),
// or never, so Installing stays for as long as anyone wants to look at it.
export type DemoPortable = {
  readonly ends:
    | Exclude<PortableInstall, { phase: "idle" | "downloading" | "installing" }>
    | "never"
  readonly installAfterMs?: number
  // Whether the install reports a download climbing and then the install, as Windows does.
  readonly progress?: boolean
  // How the install stands when the run opens; idle when absent. Installed is a window
  // opened again after this run installed the app.
  readonly opens?: PortableInstall
  readonly offer?: UpdateOffer
  // How long the host takes to say it is a portable copy; at once when absent.
  readonly answerAfterMs?: number
}

// The version of the portable copy the demo plays.
export const portableVersion = "0.0.70"

// The run the demo plays: new at each load of the page, so a reload is a new launch.
export const portableRun = crypto.randomUUID()

// When each step of an install comes: after its wait, unless a spec steps it (`schedule`).
export type PortableSchedule = (apply: () => void, next: PortableInstall, ms: number) => void

// The browser's stand-in for the desktop host's portable copy: it says it is one and owns
// the install as the host does, holding where it stands and pushing the whole state at each
// step: a download and then the install where `progress` is set, then how it `ends`. Asking
// while it is under way, or once installed or found newer, changes nothing; after a failure
// it starts over.
export const createDemoPortable = (
  {
    ends,
    installAfterMs = 0,
    progress = false,
    opens = { phase: "idle" },
    answerAfterMs = 0,
  }: DemoPortable,
  {
    schedule = (apply, _next, ms) => void setTimeout(apply, ms),
  }: { readonly schedule?: PortableSchedule } = {},
): { readonly portable: NonNullable<Backend["portable"]> } => {
  let install: PortableInstall = opens
  const state = (): PortableState => ({
    portable: true,
    version: portableVersion,
    run: portableRun,
    install,
  })
  const watchers = new Set<(state: PortableState) => void>()
  const step = (next: PortableInstall): void => {
    install = next
    watchers.forEach((listener) => listener(state()))
  }
  const later = (next: PortableInstall, ms: number): void => schedule(() => step(next), next, ms)
  return {
    portable: {
      onState: (listener) => {
        watchers.add(listener)
        return () => void watchers.delete(listener)
      },
      state: () =>
        answerAfterMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve(state()), answerAfterMs))
          : Promise.resolve(state()),
      install: () => {
        if (install.phase !== "idle" && install.phase !== "failed") return
        // Installing at once, as the host answers the click before anything else.
        step({ phase: "installing" })
        if (progress) {
          // A download in five steps over the first two thirds of the wait, then the install.
          for (let at = 0; at <= 5; at += 1)
            later({ phase: "downloading", percent: at * 20 }, (installAfterMs * 2 * at) / 15)
          later({ phase: "installing" }, (installAfterMs * 2) / 3)
        }
        if (ends !== "never") later(ends, installAfterMs)
      },
    },
  }
}

// Each press is another release.
let patch = 79

// The panel's group for portable copies. Each action boots the demo again as one (or as
// an installed copy), with the host's answer to an install armed.
export const portableGroup = (launch: DemoLaunch): DemoActionGroup => ({
  section: "App",
  title: "Portable",
  actions: Object.values(portableScenarios).map(({ label, hint, setup }) => ({
    label,
    hint,
    reboots: true,
    run: () => launch.setPortable(setup(`0.0.${(patch += 1)}`)),
  })),
})
