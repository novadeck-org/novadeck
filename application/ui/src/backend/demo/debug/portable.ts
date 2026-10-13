import type { InstallResult, PortableState } from "../../../model/portable"
import type { UpdateOffer } from "../../../model/update"
import type { Backend } from "../../port"
import type { DemoActionGroup } from "./types"
import { sampleNotes } from "./updates"
import type { DemoLaunch } from "./with-debug"

// A portable copy as the demo plays one: the release waiting, if any, and how installing
// from it goes.
export type DemoPortable = {
  readonly install: InstallResult
  readonly offer?: UpdateOffer
  // How long the host takes to say it is a portable copy; at once when absent.
  readonly answerAfterMs?: number
}

// The version of the portable copy the demo plays.
export const portableVersion = "0.0.70"

// The browser's stand-in for the desktop host's portable copy: it says it is one, and
// every install ends as `install` says, so Installing… stays for as long as anyone wants
// to look at it. `opened` counts the presses of Open Novadeck, since a browser has no
// installed copy to start.
export const createDemoPortable = ({
  install,
  answerAfterMs = 0,
}: DemoPortable): {
  readonly portable: NonNullable<Backend["portable"]>
  readonly opened: () => number
} => {
  const state: PortableState = { portable: true, version: portableVersion }
  let opens = 0
  return {
    portable: {
      state: () =>
        answerAfterMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve(state), answerAfterMs))
          : Promise.resolve(state),
      install: () => Promise.resolve(install),
      openInstalled: () => void (opens += 1),
    },
    opened: () => opens,
  }
}

const dayMs = 24 * 60 * 60 * 1000

// A release this copy has known of for `days`, as the host would tell of it.
export const releaseOffer = (version: string, days: number): UpdateOffer => ({
  kind: "available",
  version,
  notes: sampleNotes,
  outdatedSince: new Date(Date.now() - days * dayMs).toISOString(),
})

const installing: InstallResult = { kind: "installing" }

// Each press is another release, so the notice that comes once per version comes again.
let patch = 79

const release = (days: number): UpdateOffer => releaseOffer(`0.0.${(patch += 1)}`, days)

// The panel's group for portable copies. Each action boots the demo again as one, with
// the host's answer to an install armed.
export const portableGroup = (launch: DemoLaunch): DemoActionGroup => {
  const boot = (portable: DemoPortable | undefined) => () => launch.setPortable(portable)
  return {
    section: "App",
    title: "Portable",
    actions: [
      {
        label: "No release known",
        hint: "Install chip; installing never ends",
        reboots: true,
        run: boot({ install: installing }),
      },
      {
        label: "Update available",
        hint: "2-day-old release: chip, notice once per version",
        reboots: true,
        run: () => launch.setPortable({ install: installing, offer: release(2) }),
      },
      {
        label: "Stale update",
        hint: "20 days behind: notice at every boot",
        reboots: true,
        run: () => launch.setPortable({ install: installing, offer: release(20) }),
      },
      {
        label: "Newer install exists",
        hint: "Install offers Open Novadeck (0.0.99)",
        reboots: true,
        run: boot({ install: { kind: "newer", version: "0.0.99" } }),
      },
      {
        label: "Install fails",
        hint: "Says why; Install stays to retry",
        reboots: true,
        run: boot({
          install: {
            kind: "failed",
            reason: "There is no space left on the disk.",
          },
        }),
      },
      {
        label: "Slow host",
        hint: "Chip comes after 4 s",
        reboots: true,
        run: boot({ install: installing, answerAfterMs: 4000 }),
      },
      {
        label: "Installed copy",
        hint: "No install chip",
        reboots: true,
        run: boot(undefined),
      },
    ],
  }
}
