import {
  unknownInstallReason,
  type PortableInstall,
  type PortableState,
} from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import { installAppChannel, portableChannel } from "../../bridge.js"
import { newerCopy, type InstalledCopy, type InstallOutcome } from "../install/linux.js"

/**
 * How an install went, as the platform reports it: the copy now installed, a newer
 * installed copy found and left alone (`version`), or why nothing was installed.
 */
export type PlatformInstall = InstallOutcome | { readonly kind: "newer"; readonly version: string }

/** A step an install reports on the way: the installer downloading, or being put in place. */
export type InstallStep = Extract<PortableInstall, { phase: "downloading" | "installing" }>

/** What installing from a portable copy asks of the app. */
export type PortableHost = {
  /** Whether this copy is portable; see `portableOf`. */
  readonly portable: boolean
  /** This build's version. */
  readonly version: string
  /** Names this run of the app, which a page that opens again within it can tell. */
  readonly run: string
  /** Where the workspace is kept, as the person finds it; undefined when it can't be said. */
  readonly dataFolder?: string | undefined
  /** What to do about an installed copy that could not be checked, as a sentence. */
  readonly uncheckedAdvice: string
  /** The copies of the app already installed, with their versions. */
  readonly find: () => Promise<readonly InstalledCopy[]>
  /**
   * Installs this copy over `target`, an installed copy, or where the platform installs
   * when `target` is undefined, telling `progress` how it goes. Starts nothing: this copy
   * keeps running.
   */
  readonly install: (
    target: string | undefined,
    progress: (step: InstallStep) => void,
  ) => Promise<PlatformInstall>
  /** Tells every window the portable state, each time it changes. */
  readonly changed: (state: PortableState) => void
  /** Whether the app is already on its way out, as a quit is. */
  readonly stopping: () => boolean
  readonly log: (message: string, error: unknown) => void
}

/** The page's view of a portable copy: what it is and how installing from it stands. */
export type PortableInstaller = {
  /** The portable state now, with the install's phase as this run holds it. */
  readonly state: () => PortableState
  /**
   * Starts installing, unless the copy is not portable, an install is under way, or one
   * ended `installed` or `newer`; a `failed` one starts over. Resolves when this attempt
   * has ended (at once when it did nothing); every step went through `changed` by then.
   */
  readonly install: () => Promise<void>
}

const quitting = "Novadeck is quitting."

const failure = (reason: string): PortableInstall => ({ phase: "failed", reason })

/**
 * Installs the app from a portable copy while it keeps running; nothing is restarted,
 * quit or started. The installer holds the run's `PortableInstall`, starting `idle`, and
 * tells `changed` the whole `PortableState` at each change: `installing` as soon as a
 * request is taken, `downloading` with each new whole percent (Windows only, then
 * `installing` again once the setup runs), then how it ended. `install` first looks at
 * the installed copies: one newer than this copy is left alone, since this copy would
 * replace it with an older app that could not open the data the newer one may have
 * upgraded, and the end is `newer`. An installed copy that could not be looked at is not
 * replaced either; that ends `failed`, as does an install while the app is quitting.
 * Otherwise the app is installed from this very copy, over the installed copy there is,
 * else where the platform installs, and the end is `installed`; the installed copy takes
 * effect when the person next opens Novadeck. A failed install says why and changes
 * nothing. A request while one is under way, or after `installed` or `newer`, does
 * nothing, and a copy that is not portable installs nothing.
 */
export const portableInstaller = (host: PortableHost): PortableInstaller => {
  let install: PortableInstall = { phase: "idle" }
  let under: Promise<void> | undefined

  const state = (): PortableState =>
    host.portable
      ? {
          portable: true,
          version: host.version,
          run: host.run,
          install,
          ...(host.dataFolder === undefined ? {} : { dataFolder: host.dataFolder }),
        }
      : { portable: false }

  const set = (next: PortableInstall): void => {
    if (JSON.stringify(next) === JSON.stringify(install)) return
    install = next
    // A page that cannot be told must not stop the install.
    try {
      host.changed(state())
    } catch (error) {
      host.log("The portable state was not sent.", error)
    }
  }

  const run = async (): Promise<PortableInstall> => {
    const copies = await host.find()
    const copy = newerCopy(copies, host.version)
    if (copy) return { phase: "newer", version: copy.version }
    // On Linux an installed copy is replaced where it is, the installer's own before
    // Homebrew's, so no second copy appears; `find` lists them in that order. One that
    // could not be looked at may be a newer app, so it is left as it is.
    const [replaced] = copies
    if (replaced?.unchecked) {
      host.log("The installed copy could not be checked.", replaced.image)
      return failure(
        "The installed copy could not be checked, so it was left as it is. " + host.uncheckedAdvice,
      )
    }
    if (host.stopping()) return failure(quitting)
    const outcome = await host.install(replaced?.image, set)
    if (outcome.kind === "failed") return failure(outcome.reason)
    if (outcome.kind === "newer") return { phase: "newer", version: outcome.version }
    return { phase: "installed" }
  }

  return {
    state,
    install: () => {
      if (!host.portable || under !== undefined) return Promise.resolve()
      if (install.phase === "installed" || install.phase === "newer") return Promise.resolve()
      // The page hears at once that its request was taken, whatever the platform does
      // first, and a failure after a retry is then a change that always reaches it.
      set({ phase: "installing" })
      if (host.stopping()) {
        set(failure(quitting))
        return Promise.resolve()
      }
      under = run()
        .catch((error: unknown): PortableInstall => {
          host.log("Installing failed.", error)
          return failure(unknownInstallReason)
        })
        .then(set)
        .finally(() => {
          under = undefined
        })
      return under
    },
  }
}

type PortableIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): unknown
}

/**
 * Answers the app's own pages whether this is a portable copy, and starts the install
 * they ask for; how it goes reaches every page through the installer's `changed`. `window`
 * names the window of a request from the main frame of the app's own page, or undefined
 * for any other sender, which is told this is not a portable copy and may not install.
 * The requests carry no value.
 */
export const registerPortableIpc = <Window>(
  ipc: PortableIpc,
  {
    window,
    installer,
    log,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly installer: PortableInstaller
    readonly log: (message: string, error: unknown) => void
  },
): void => {
  ipc.handle(portableChannel, (event): PortableState =>
    window(event) === undefined ? { portable: false } : installer.state(),
  )
  ipc.on(installAppChannel, (event) => {
    if (window(event) === undefined) return
    // Telling a page can throw; nothing waits on the request, so it is logged here.
    try {
      installer.install().catch((error: unknown) => log("Installing failed.", error))
    } catch (error) {
      log("Installing failed.", error)
    }
  })
}
