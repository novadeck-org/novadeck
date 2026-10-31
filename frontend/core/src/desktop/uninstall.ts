// What uninstalling this copy of the desktop app would do, and how it went. The core
// can't import the protocol's wire contracts, so this mirrors its `UninstallPlan` and
// `UninstallResult`, which frontend/runner-adapter/src/desktop/app.test.ts checks it fits.
//
// `unavailable`: nothing from here (a portable copy, a development run). `manual`: another
// tool installed it, so the person runs `command` in a terminal. `ready`: the app can
// remove itself; `dataFolders` are the paths of the person's projects and sessions, and
// `handoff` says who removes the app: `app` itself, or the platform's `uninstaller`.
export type UninstallPlan =
  | { readonly kind: "unavailable" }
  | { readonly kind: "manual"; readonly command: string }
  | {
      readonly kind: "ready"
      readonly dataFolders: readonly string[]
      readonly handoff: "app" | "uninstaller"
    }

// A plan the page offers: one that does something.
export type OfferedUninstall = Exclude<UninstallPlan, { readonly kind: "unavailable" }>

// `uninstalling`: the platform's uninstaller was started and the app is quitting for it.
// `removed`: the files are gone; `leftover` is a command for the person to run. `failed`:
// it stopped for the short `reason`, and what it had not reached is intact.
export type UninstallResult =
  | { readonly kind: "uninstalling" }
  | { readonly kind: "removed"; readonly leftover?: string }
  | { readonly kind: "failed"; readonly reason: string }

// The longest reason, command or folder path the page shows.
export const maxUninstallText = 300

// The longest data folder path the page takes: what the desktop app's preload takes.
export const maxUninstallPath = 1000

// The longest failure reason the page takes: what the desktop app's preload takes, so the advice
// the desktop app ends a reason with is never cut.
export const maxUninstallReason = 300
