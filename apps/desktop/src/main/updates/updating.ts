// The app's updates over one run: checking on a schedule, the install as the app quits, and
// what the last quit's install came to. The rules live beside it, in ./updater.ts, ./mac.ts,
// ./state.ts and ./quit-install.ts; this is where they meet electron-updater and the app.
import { existsSync, statSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { UpdateChannel } from "@novadeck/protocol/bridge"
import { app, type WebContents } from "electron"

import { bundleOf, bundleVersionOf } from "../install/mac.js"
import type { updateLogOn } from "../logs.js"
import type { Quitting } from "../quitting.js"
import { releasePageUrl } from "../releases/repository.js"
import { isNewerVersion } from "../releases/versions.js"
import { releaseRepository } from "../resources.js"
import { swapAppImage } from "./appimage-swap.js"
import type { BuildFacts } from "./build.js"
import {
  allowMacUpdates,
  InstallPostponed,
  installMacUpdate,
  macSwapMode,
  prepareMacUpdate,
  recheckMacUpdate,
  removeMacUpdates,
  UpdateRejected,
} from "./mac.js"
import { opensAfterQuit, swapsAtQuitStart } from "./quit-install.js"
import {
  failureOutdated,
  fileIdentity,
  installedBeforeLaunch,
  installOutcome,
  type keepUpdateState,
} from "./state.js"
import {
  checkForUpdates,
  installOnlyOnOrderlyQuit,
  portableOf,
  quitWithoutInstalling,
  updatePlan,
  type trackOffer,
  type Updater,
  type UpdaterKind,
} from "./updater.js"

// How long what an update left must sit unchanged before it is removed, as another copy
// on its own data folder may be installing from it.
const preparedForMs = 10 * 60 * 1000

/** What updating is handed of the running app. */
export type UpdatingHost = {
  readonly state: ReturnType<typeof keepUpdateState>
  /** The log of updating; see `updateLogOn`. */
  readonly log: ReturnType<typeof updateLogOn>
  /** The last update offer, told to the app's pages; see `trackOffer`. */
  readonly offers: ReturnType<typeof trackOffer<WebContents>>
  readonly build: BuildFacts
  readonly quitting: Quitting
  /** Starts the macOS app bundle at the path in this one's place, as the process ends. */
  readonly startBundle: (bundle: string) => Promise<boolean>
  /** Starts the AppImage at the path once the process `after` names has gone. */
  readonly startAppImage: (image: string, after?: number) => Promise<boolean>
}

/** The app's updates over one run; see ./updater.ts. */
export const updating = ({
  state,
  log,
  offers,
  build,
  quitting,
  startBundle,
  startAppImage,
}: UpdatingHost) => {
  // The macOS update made ready to put in place on quitting, and whether quitting puts it
  // there: a quit as the session ends, or the uninstall, switches that off. See ./mac.ts.
  let macUpdate: { readonly version: string; readonly prepared: string } | undefined
  const macQuitInstall = { autoInstallOnAppQuit: true }
  // The auto-updater of a build that looks for updates, once it has loaded, and what keeps
  // its schedule.
  let updater: Updater | undefined
  let updates: ReturnType<typeof checkForUpdates> | undefined
  // The releases this build follows; read from the data folder at launch.
  let channel: UpdateChannel = "stable"
  // The version the quit's install is putting in place, for the lines that tell of it.
  let installingVersion: string | undefined
  // Whether the AppImage was swapped for the update at the start of this quit (Linux).
  let appImageSwapped = false
  // The macOS download being made ready, so one finished after a newer one began is let go.
  let preparing = 0
  // Whether the person turned down letting this copy install updates, which then offers the
  // release page for the rest of the run; see `allow`.
  let allowDeclined = false
  // Whether the macOS update is going into place, which a second quit, as a logout's, waits
  // for: the app it ends would be left between the old bundle and the new.
  let macInstalling = false
  // Whether letting this copy install updates is under way, so one request runs at a time.
  let allowing = false

  // A failure of updating, kept in the log, which a development run also shows on the console.
  const warn = (message: string, error: unknown): void => log.warn(message, error)

  // electron-updater is CommonJS, so ESM takes its exports from the default. Each kind of
  // build has its own updater; the one for the build is chosen here, from what was decided
  // in ./updater.ts, rather than left to electron-updater to guess from the environment.
  const loadUpdater = async (kind: UpdaterKind): Promise<Updater> => {
    const { default: electronUpdater } = await import("electron-updater")
    switch (kind) {
      case "nsis":
        return new electronUpdater.NsisUpdater()
      case "mac":
        return new electronUpdater.MacUpdater()
      case "appimage": {
        const appImage = new electronUpdater.AppImageUpdater()
        // electron-updater's own install deletes the AppImage and then moves the new one in,
        // so for a moment nothing is there for a launch to find, and then runs the new file
        // once for a desktop integration this build's AppRun skips. This one renames the
        // update over the file in a single step; see `swapAppImage`. It is called as the quit
        // begins.
        Object.assign(appImage, {
          doInstall(this: {
            readonly installerPath: string | null
            dispatchError(error: Error): void
          }): boolean {
            const target = process.env.APPIMAGE
            if (!target || this.installerPath == null) {
              this.dispatchError(new Error("No update file or AppImage path, can't install"))
              return false
            }
            const identity = swapAppImage(this.installerPath, target)
            appImageSwapped = true
            log.info(`Put ${installingVersion ?? "the update"} in place as the app quits.`)
            try {
              if (identity !== undefined) state.recordInstalledImage(identity)
            } catch (error) {
              warn("The installed file was not kept.", error)
            }
            return true
          },
        })
        return appImage
      }
    }
  }

  // Marks a failed install, so its release is told of rather than installed again.
  // Synchronous: a failed install on quit is reported as the app exits.
  const installFailed = (version: string): void => {
    try {
      state.recordInstallFailure(version)
    } catch (error) {
      warn("The failed install was not kept.", error)
    }
  }

  // Marks the version an install on quitting begins to put in place, for the next launch
  // to check; see `settleLastInstall`. Synchronous, as the app is exiting.
  const recordInstalling = (version: string): void => {
    installingVersion = version
    log.info(`Installing ${version} on quitting.`)
    try {
      state.recordInstalling(version)
    } catch (error) {
      warn("The install begun was not kept.", error)
    }
  }

  // What the install the last quit began came to: one that left this launch older than the
  // version it put in place failed, as when the Windows installer failed after the app
  // exited, so it is marked like any failed install and told of rather than tried again
  // at every launch. See `installOutcome`.
  const settleLastInstall = (): void => {
    const kept = state.read()
    // A release marked failed that this launch runs, or is past, did install: a copy reopened
    // while the installer ran may have marked it before the installer closed that copy.
    if (
      kept.installFailedOn !== undefined &&
      failureOutdated(kept, app.getVersion(), isNewerVersion)
    )
      try {
        log.info(`Installed ${app.getVersion()}; the failure marked on it is cleared.`)
        state.clearInstallFailure()
      } catch (error) {
        warn("The failed install was not cleared.", error)
      }
    const { installing } = state.read()
    const outcome = installOutcome({ installing }, app.getVersion(), isNewerVersion)
    if (outcome === undefined || installing === undefined) return
    try {
      if (outcome === "failed") {
        log.warn(`Installing ${installing} did not take: this is still ${app.getVersion()}.`)
        state.recordInstallFailure(installing)
      } else {
        log.info(`Installed ${app.getVersion()}.`)
        state.clearInstalling()
      }
    } catch (error) {
      warn("The last install was not settled.", error)
    }
  }

  // Starts checking for updates in a build that looks for them; see ./updater.ts.
  const start = async (): Promise<void> => {
    const plan = updatePlan(await build.updateBuild())
    if (!plan) return
    // A copy that only tells, such as a portable one sharing this data folder, leaves the
    // installed copy's install for it to settle.
    if (plan.mode === "install") settleLastInstall()
    const kept = state.read()
    log.info(
      `Novadeck ${app.getVersion()} ${plan.mode === "install" ? "installs" : "tells of"} updates on the ${channel} channel.`,
    )
    // What earlier launches prepared, and the app an install replaced, go before anything
    // new is prepared.
    if (plan.kind === "mac")
      await removeMacUpdates({ bundle: bundleOf(app.getPath("exe")), olderThanMs: preparedForMs })
    const current = await loadUpdater(plan.kind)
    const repository = await releaseRepository()
    updater = current
    updates = checkForUpdates(current, {
      mode: plan.mode,
      channel,
      failedVersion: kept.installFailedOn,
      allow: plan.allow,
      // Checks go through novadeck.dev, which counts active copies, and fall back to GitHub.
      // Without a repository to fall back to they stay on the updater's own configuration.
      feed: repository && {
        repository,
        site: process.env.NOVADECK_UPDATE_URL,
        facts: {
          version: app.getVersion(),
          build: portableOf({ ...(await build.unsignedBuild()), signed: false })
            ? "portable"
            : "installed",
        },
      },
      // macOS updates are put in place by the app as it quits; the others install from
      // electron-updater's file.
      prepare:
        plan.kind === "mac"
          ? async ({ version, file }) => {
              // Once quitting, the update being put in place is left alone.
              if (quitting.stopping) return
              const turn = (preparing += 1)
              const prepared = await prepareMacUpdate({
                zip: file,
                version,
                bundle: bundleOf(app.getPath("exe")),
              })
              if (turn !== preparing || quitting.stopping) {
                await rm(dirname(prepared), { recursive: true, force: true }).catch(() => {})
                return
              }
              macUpdate = { version, prepared }
              log.info(`${version} is ready to install on quitting.`)
              await removeMacUpdates({ keep: prepared, olderThanMs: preparedForMs })
            }
          : undefined,
      rejected: (error) => error instanceof UpdateRejected,
      // An updater replaced, as by allowing updates, says nothing more.
      offer: (offer) => {
        if (updater !== current) return
        offers.offer(
          allowDeclined && offer.kind === "available"
            ? { kind: offer.kind, version: offer.version }
            : offer,
        )
      },
      installStarted: recordInstalling,
      // Windows runs the installer after the app has gone: asked to start the app again when
      // the person opened it meanwhile.
      runAfterInstall:
        plan.kind === "nsis"
          ? () => {
              if (!quitting.reopenWanted) return false
              log.info(
                `Opening ${installingVersion ?? "the update"}, which is put in place as the app quits.`,
              )
              return true
            }
          : undefined,
      installFailed,
      log: warn,
      logger: log.logger,
    })
  }

  // Ctrl+Q and the menu's Quit install a waiting update on Linux; a signal's quit does not.
  const declineUnorderlyInstall = installOnlyOnOrderlyQuit(
    () => updater,
    () => quitting.orderly,
  )

  return {
    start,

    /**
     * Whether this launch gave way to the newer AppImage the last quit put in place, which it
     * started instead. That launch began from the old file: it came before the swap, or the
     * launcher had resolved the file already. Nothing has started yet, so the newer one
     * starts in its place instead of the install being called a failure.
     */
    openSwappedAppImage: async (portable: boolean): Promise<boolean> => {
      const file = process.env.APPIMAGE
      if (process.platform !== "linux" || portable || !file) return false
      const kept = state.read()
      let image: string | undefined
      try {
        image = fileIdentity(statSync(file))
      } catch {
        image = undefined
      }
      if (
        kept.installing === undefined ||
        !installedBeforeLaunch(kept, app.getVersion(), image, isNewerVersion)
      )
        return false
      log.info(
        `Opening ${kept.installing}, which was put in place as the app quit: this is still ${app.getVersion()}.`,
      )
      try {
        state.recordReopened(kept.installing)
        if (await startAppImage(file)) return true
      } catch (error) {
        warn("The newer AppImage was not started.", error)
      }
      return false
    },

    /** Reads the channel the build follows from the data folder, as a launch begins. */
    readChannel: (): void => {
      channel = state.read().channel
    },

    channel: (): UpdateChannel => channel,

    /**
     * Switches the releases the build follows, then keeps the choice, throwing when it
     * could not be kept.
     */
    setChannel: (next: UpdateChannel): void => {
      if (next === channel) return
      channel = next
      updates?.setChannel(next)
      state.setChannel(next)
    },

    /**
     * Lets this macOS copy install updates itself once an administrator hands its bundle to
     * the person (see `allowMacUpdates`), then checks for updates afresh as a copy that
     * installs. Only the copy whose offer says so asks, and one request at a time.
     */
    allow: async (): Promise<void> => {
      const offer = offers.current()
      if (process.platform !== "darwin" || allowing || offer?.kind !== "available" || !offer.allow)
        return
      allowing = true
      try {
        const allowed = await allowMacUpdates({
          bundle: bundleOf(app.getPath("exe")),
          uid: process.getuid?.() ?? -1,
          gid: process.getgid?.() ?? -1,
        })
        if (!allowed) {
          // Turned down, as by a person who has no administrator to ask: the chip leads to
          // the release page instead, for the rest of this run.
          allowDeclined = true
          offers.offer({ kind: "available", version: offer.version })
          return
        }
        log.info("An administrator let this copy install updates.")
        // The chip goes, as there is nothing left to press, until the download shows.
        offers.offer({ kind: "retrying", version: offer.version })
        updates?.stop()
        build.forget()
        await start()
      } catch (error) {
        warn("Letting this copy install updates failed.", error)
        offers.offer({ kind: "available", version: offer.version })
      } finally {
        allowing = false
      }
    },

    /** The page of the last offer's release, from the repository the build updates from. */
    page: async (): Promise<string | undefined> => {
      const offer = offers.current()
      if (!offer) return undefined
      const repository = await releaseRepository()
      return repository && releasePageUrl(repository, offer.version)
    },

    /**
     * The quit of the system ending the session: no update installs on the way out, as the
     * system may kill the installer halfway.
     */
    quitOnSessionEnd: quitWithoutInstalling(
      () => (process.platform === "darwin" ? macQuitInstall : updater),
      () => app.quit(),
    ),

    /** No update installs as the app quits, as the uninstall's quit must not put it back. */
    installNothing: (): void => {
      updates?.stop()
      if (updater) updater.autoInstallOnAppQuit = false
      macQuitInstall.autoInstallOnAppQuit = false
    },

    /**
     * Whether the macOS update is going into place, which holds a second quit, as a
     * logout's, back: the app it ends would be left between the old bundle and the new.
     */
    holdsQuit: (): boolean => macInstalling,

    /**
     * As a quit begins: no new download starts on the way out, and on Linux the update is
     * swapped in now, by the person's quit alone.
     */
    quitBegins: (): void => {
      updates?.stop()
      if (process.platform !== "linux") return
      if (
        swapsAtQuitStart({
          platform: process.platform,
          orderly: quitting.orderly,
          stopping: quitting.stopping,
        })
      )
        updates?.installNow()
      else declineUnorderlyInstall()
    },

    /**
     * On macOS, puts the update made ready in place as the app quits, once every page has
     * saved and the shells have ended, so the next launch, however soon, is the new version.
     * Should it fail, the old app is left whole and the release is told of from then on.
     */
    installMacUpdateOnQuit: async (): Promise<void> => {
      const update = macUpdate
      if (process.platform !== "darwin" || !update || !macQuitInstall.autoInstallOnAppQuit) return
      if (!existsSync(update.prepared))
        return log.warn(`${update.version} was no longer ready to install; it downloads again.`)
      const bundle = bundleOf(app.getPath("exe"))
      // A bundle replaced while the app ran, as by install.sh, is not this build to replace.
      const plist = await readFile(join(bundle, "Contents", "Info.plist"), "utf8").catch(() => "")
      if (bundleVersionOf(plist) !== app.getVersion())
        return log.warn(`${update.version} was not installed: the app changed while it ran.`)
      const mode = await macSwapMode(bundle)
      if (mode === undefined)
        return log.warn(`${update.version} was not installed: the app can't be written.`)
      macInstalling = true
      try {
        try {
          await recheckMacUpdate({ prepared: update.prepared, bundle })
        } catch (error) {
          // Nothing was touched: one that could not be checked waits for a later session,
          // which prepares it again; one that no longer passes failed.
          if (error instanceof InstallPostponed) return log.warn(error.message)
          warn("Installing the update failed.", error)
          return installFailed(update.version)
        }
        recordInstalling(update.version)
        try {
          await installMacUpdate({ prepared: update.prepared, bundle, mode })
          log.info(`Installed ${update.version}; it starts at the next launch.`)
        } catch (error) {
          warn("Installing the update failed.", error)
          return installFailed(update.version)
        }
        // The person opened Novadeck while it was quitting: open the new version now it is
        // there.
        if (quitting.reopenWanted) {
          log.info(`Opening ${update.version}, which was put in place as the app quit.`)
          await startBundle(bundle)
        }
      } finally {
        macInstalling = false
      }
    },

    /**
     * On Linux, opens the AppImage the quit swapped in when the person opened Novadeck while
     * it was quitting: that launch found the data folder held and went away.
     */
    openAppImageAfterQuit: async (): Promise<void> => {
      const image = process.env.APPIMAGE
      if (!image || !opensAfterQuit({ placed: appImageSwapped, wanted: quitting.reopenWanted }))
        return
      log.info(
        `Opening ${installingVersion ?? "the update"}, which was put in place as the app quit.`,
      )
      // Started only once this process has gone: its windows and their storage are still
      // open while it shuts down, and the data folder's lock is released with it.
      await startAppImage(image, process.pid)
    },
  }
}

/** The app's updates over one run; see `updating`. */
export type Updating = ReturnType<typeof updating>
