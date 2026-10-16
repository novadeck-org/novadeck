import type { InstallProgress, InstallResult, PortableState } from "../../../model/portable"
import type { UpdateOffer } from "../../../model/update"
import type { Backend } from "../../port"
import type { DemoActionGroup } from "./types"
import type { DemoLaunch } from "./with-debug"

// A portable copy as the demo plays one: the release waiting, if any, and how installing
// from it goes: the answer, which comes after `installAfterMs` (at once when absent), or
// none, so Installing stays for as long as anyone wants to look at it.
export type DemoPortable = {
  readonly install: InstallResult | "never"
  readonly installAfterMs?: number
  // Whether the install reports a download climbing and then the install, as Windows does.
  readonly progress?: boolean
  // Whether this run installed the app already, as a window opened again finds it.
  readonly installed?: boolean
  readonly offer?: UpdateOffer
  // How long the host takes to say it is a portable copy; at once when absent.
  readonly answerAfterMs?: number
}

// The version of the portable copy the demo plays.
export const portableVersion = "0.0.70"

// The run the demo plays: new at each load of the page, so a reload is a new launch.
export const portableRun = crypto.randomUUID()

// The browser's stand-in for the desktop host's portable copy: it says it is one, and
// every install ends as `install` says, after reporting a download and then the install
// where `progress` is set.
export const createDemoPortable = ({
  install,
  installAfterMs = 0,
  progress = false,
  installed = false,
  answerAfterMs = 0,
}: DemoPortable): { readonly portable: NonNullable<Backend["portable"]> } => {
  let state: Extract<PortableState, { portable: true }> = {
    portable: true,
    version: portableVersion,
    run: portableRun,
    installed,
  }
  const listeners = new Set<(progress: InstallProgress) => void>()
  const tell = (heard: InstallProgress): void => listeners.forEach((listener) => listener(heard))
  const watchers = new Set<(state: PortableState) => void>()
  return {
    portable: {
      // As the desktop host does, the state is pushed once an install ends as installed or newer.
      onState: (listener) => {
        watchers.add(listener)
        return () => void watchers.delete(listener)
      },
      onProgress: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      state: () =>
        answerAfterMs > 0
          ? new Promise((resolve) => setTimeout(() => resolve(state), answerAfterMs))
          : Promise.resolve(state),
      install: () => {
        if (progress) {
          // A download in five steps over the first two thirds of the wait, then the install.
          for (let step = 1; step <= 5; step += 1) {
            setTimeout(
              () => tell({ phase: "downloading", percent: step * 20 }),
              (installAfterMs * 2 * step) / 15,
            )
          }
          setTimeout(() => tell({ phase: "installing" }), (installAfterMs * 2) / 3)
        }
        if (install === "never") return new Promise<InstallResult>(() => {})
        return new Promise((resolve) =>
          setTimeout(() => {
            if (install.kind !== "failed") {
              state = { ...state, installed: true }
              watchers.forEach((listener) => listener(state))
            }
            resolve(install)
          }, installAfterMs),
        )
      },
    },
  }
}

// A release this copy is missing, as the host would tell of it.
export const releaseOffer = (version: string): UpdateOffer => ({
  kind: "available",
  version,
})

// How long the host takes to install, so Installing is there to look at.
const installTakes = 4000

// Each press is another release.
let patch = 79

// The panel's group for portable copies. Each action boots the demo again as one, with
// the host's answer to an install armed.
export const portableGroup = (launch: DemoLaunch): DemoActionGroup => {
  const boot = (portable: DemoPortable | undefined) => () => launch.setPortable(portable)
  const installed: DemoPortable = {
    install: { kind: "installed" },
    installAfterMs: installTakes,
    progress: true,
  }
  return {
    section: "App",
    title: "Portable",
    actions: [
      {
        label: "No release known",
        hint: "Card comes up once, then the Install Novadeck chip; Install takes 4 s",
        reboots: true,
        run: boot(installed),
      },
      {
        label: "Update available",
        hint: "Card for a new release, Update available chip; Install takes 4 s",
        reboots: true,
        run: () => launch.setPortable({ ...installed, offer: releaseOffer(`0.0.${(patch += 1)}`) }),
      },
      {
        label: "Install never finishes",
        hint: "Install holds the Installing card and chip",
        reboots: true,
        run: boot({ install: "never" }),
      },
      {
        label: "Newer install exists",
        hint: "Install answers that Novadeck 0.0.99 is already installed",
        reboots: true,
        run: boot({ install: { kind: "newer", version: "0.0.99" }, installAfterMs: installTakes }),
      },
      {
        label: "Install fails",
        hint: "Says why; Try again stays",
        reboots: true,
        run: boot({
          install: { kind: "failed", reason: "There is no space left on the disk." },
          installAfterMs: installTakes,
        }),
      },
      {
        label: "Already installed",
        hint: "A window opened again after installing: no card, chip reads Installed",
        reboots: true,
        run: boot({ install: { kind: "installed" }, installed: true }),
      },
      {
        label: "Slow host",
        hint: "Chip comes after 4 s",
        reboots: true,
        run: boot({ ...installed, answerAfterMs: 4000 }),
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
