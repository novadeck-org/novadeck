import type { UninstallPlan, UninstallResult } from "@novadeck/core/desktop/uninstall"
import type { Backend } from "@novadeck/core/port"

import type { DemoLaunch } from "../debug-demo"
import type { DemoActionGroup } from "../types"

// An uninstall as the demo plays one: what the desktop app says it would do, and how running it
// ends.
export type DemoUninstall = {
  readonly plan: UninstallPlan
  readonly result: UninstallResult
  // How every run after the first ends, where it ends otherwise than the first did.
  readonly retried?: UninstallResult
}

// Long enough to see Removing….
export const uninstallMs = 1500

// The command a Homebrew copy is removed with, and the one the app leaves for the person.
const sampleBrewCommand = "brew uninstall --cask novadeck"
export const sampleLeftover = "sudo rm /etc/apparmor.d/novadeck"

// The reason the app gives once it has stopped the terminals: ending in its advice, and
// the same on every retry.
export const stoppedReason =
  "Novadeck couldn't remove its files: permission denied. Novadeck has stopped your terminals; quit it and open it again."

// What macOS says when it won't let the app move itself to the Trash.
export const trashReason =
  "macOS didn't let Novadeck move itself to the Trash. Allow it under System Settings > Privacy & Security > App Management, then try again."

const dataFolders = ["/home/mzpk/.config/novadeck", "/home/mzpk/Novadeck"] as const

// The browser's stand-in for the desktop app's uninstall: it says what it would do, and
// every run ends as armed after a moment. `runs` records the `keepData` of each run and
// `quits` counts the presses of Quit, since a browser has no app to remove or quit.
export const createDemoUninstall = ({
  plan,
  result,
  retried,
}: DemoUninstall): {
  readonly uninstall: NonNullable<Backend["uninstall"]>
  readonly runs: () => readonly boolean[]
  readonly quits: () => number
} => {
  const runs: boolean[] = []
  let quits = 0
  return {
    uninstall: {
      plan: () => Promise.resolve(plan),
      run: ({ keepData }) => {
        runs.push(keepData)
        const ends = runs.length > 1 && retried ? retried : result
        return new Promise((resolve) => setTimeout(() => resolve(ends), uninstallMs))
      },
      quit: () => void (quits += 1),
    },
    runs: () => runs,
    quits: () => quits,
  }
}

const ready = (
  handoff: "app" | "uninstaller",
  folders: readonly string[] = dataFolders,
): UninstallPlan => ({
  kind: "ready",
  dataFolders: folders,
  handoff,
})

// The uninstalls the demo plays, by the name a spec asks for in the address (`?uninstall=`).
export const uninstallScenarios = {
  unavailable: { plan: { kind: "unavailable" }, result: { kind: "removed" } },
  manual: { plan: { kind: "manual", command: sampleBrewCommand }, result: { kind: "removed" } },
  removed: { plan: ready("app"), result: { kind: "removed" } },
  "no-data": { plan: ready("app", []), result: { kind: "removed" } },
  leftover: { plan: ready("app"), result: { kind: "removed", leftover: sampleLeftover } },
  failed: {
    plan: ready("app"),
    result: { kind: "failed", reason: "Novadeck is in a folder you can't change." },
  },
  stopped: {
    plan: ready("app"),
    result: { kind: "failed", reason: stoppedReason },
    retried: { kind: "failed", reason: stoppedReason },
  },
  trash: {
    plan: ready("app"),
    result: { kind: "failed", reason: trashReason },
    retried: { kind: "removed" },
  },
  windows: { plan: ready("uninstaller"), result: { kind: "uninstalling" } },
  "windows-failed": {
    plan: ready("uninstaller"),
    result: { kind: "failed", reason: "Windows couldn't start the uninstaller." },
  },
} as const satisfies Record<string, DemoUninstall>

// The panel's group for uninstalling the app. Each action boots the demo again as an app
// that offers it, with the end of a run armed. The dialog names the agents connected in
// Preferences, and Agent connections › Connect fails makes a disconnect fail before the run.
export const uninstallGroup = (launch: DemoLaunch): DemoActionGroup => {
  const boot = (name: keyof typeof uninstallScenarios | undefined) => () =>
    launch.setUninstall(name && uninstallScenarios[name])
  return {
    section: "App",
    title: "Uninstall",
    actions: [
      {
        label: "Not offered",
        hint: "Preferences > About has no Uninstall row (portable copy, development)",
        reboots: true,
        run: boot(undefined),
      },
      {
        label: "Homebrew copy",
        hint: "About shows the brew command with Copy, no button",
        reboots: true,
        run: boot("manual"),
      },
      {
        label: "Removed",
        hint: "Uninstall… dialog, Removing…, then Novadeck is uninstalled and Quit",
        reboots: true,
        run: boot("removed"),
      },
      {
        label: "Ready, no data folder",
        hint: "Dialog has no Keep my projects checkbox (custom user-data dir)",
        reboots: true,
        run: boot("no-data"),
      },
      {
        label: "Removed, leftover",
        hint: "Ends on uninstalled, with a command to copy",
        reboots: true,
        run: boot("leftover"),
      },
      {
        label: "Removal fails",
        hint: "Dialog stays open with the reason; Uninstall retries",
        reboots: true,
        run: boot("failed"),
      },
      {
        label: "Fails after terminals ended",
        hint: "Reason ends in quit it and open it again; every retry fails the same",
        reboots: true,
        run: boot("stopped"),
      },
      {
        label: "Trash refused",
        hint: "macOS App Management reason; Uninstall again then succeeds",
        reboots: true,
        run: boot("trash"),
      },
      {
        label: "Windows uninstaller",
        hint: "Dialog button reads Continue; ends on closing for its uninstaller",
        reboots: true,
        run: boot("windows"),
      },
      {
        label: "Windows uninstaller fails",
        hint: "Continue ends in the reason, dialog stays open",
        reboots: true,
        run: boot("windows-failed"),
      },
    ],
  }
}
