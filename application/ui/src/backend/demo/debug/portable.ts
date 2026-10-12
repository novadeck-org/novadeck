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

// The panel's group for portable copies. Each action boots the demo again as one, with
// the host's answer to an install armed.
export const portableGroup = (launch: DemoLaunch): DemoActionGroup => {
  const boot = (portable: DemoPortable | undefined) => () => launch.setPortable(portable)
  const release = (days: number): UpdateOffer => releaseOffer(`0.0.${(patch += 1)}`, days)
  return {
    title: "Portable",
    actions: [
      {
        label: "Portable",
        hint: "Boots again as a portable copy with no release known: an Install Novadeck chip (Install when narrow) that never opens by itself; its panel says this copy can't update itself, with Later and Install Novadeck. Pressing Install Novadeck turns the chip to Installing…, which never ends",
        run: boot({ install: installing }),
      },
      {
        label: "Portable, update available",
        hint: "Boots again as a portable copy with a release from two days ago: an Update available chip and a notice, raised once per version, with Install Novadeck and Release notes, no Download; the next boot shows only the chip",
        run: () => launch.setPortable({ install: installing, offer: release(2) }),
      },
      {
        label: "Portable, stale update",
        hint: "Boots again as a portable copy 20 days behind a release: the same notice, raised at every boot, not only the first",
        run: () => launch.setPortable({ install: installing, offer: release(20) }),
      },
      {
        label: "Portable, newer installed",
        hint: "Boots again as a portable copy that finds a newer install: press Install Novadeck and the panel says Novadeck 0.0.99 is already installed, with Later and Open Novadeck",
        run: boot({ install: { kind: "newer", version: "0.0.99" } }),
      },
      {
        label: "Portable, install fails",
        hint: "Boots again as a portable copy whose install fails: press Install Novadeck and the panel says why it could not, keeping Install Novadeck to try again",
        run: boot({
          install: {
            kind: "failed",
            reason: "There is no space left on the disk.",
          },
        }),
      },
      {
        label: "Portable, slow answer",
        hint: "Boots again as a portable copy whose host takes four seconds to say so: the Install Novadeck chip comes late, and with No sandbox set under Startup, that chip stays away meanwhile instead of flashing",
        run: boot({ install: installing, answerAfterMs: 4000 }),
      },
      {
        label: "Not portable",
        hint: "Boots again as an installed copy: no install chip",
        run: boot(undefined),
      },
    ],
  }
}
