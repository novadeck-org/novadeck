// What a launch does about the other copies of the app before it starts anything: a portable
// copy gives way to a newer one, and the copy that stays is recorded for later launches to
// hand over to. The rules live in ./handoff.ts and ./redirect.ts; this hands them the system.
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

import { app, dialog } from "electron"

import { realpathOrUndefined, type MachineCopies } from "../install/copies.js"
import { currentOrNewerCopy } from "../install/linux.js"
import { bundleOf } from "../install/mac.js"
import { leaveForNewerPortable, portableRecordName, recordPortableCopy } from "./handoff.js"
import { leaveForNewerInstalled, redirectMarker } from "./redirect.js"

// The notes a portable launch leaves in the data folder, as files.
const markerFiles = {
  modified: (file: string) => statSync(file).mtimeMs,
  write: (file: string) => writeFileSync(file, ""),
  remove: (file: string) => rmSync(file, { force: true }),
}

// How long the note of a redirect, or of a handoff, holds.
const redirectWindowMs = 30_000

// What the system runs to start this copy, which a portable copy records for the older ones
// to hand their launches to: the AppImage file, the Windows executable, the macOS bundle.
const ownCopy = (): string =>
  process.platform === "darwin"
    ? bundleOf(app.getPath("exe"))
    : process.platform === "win32"
      ? process.execPath
      : (process.env.APPIMAGE ?? "")

// A path as it compares: resolved, and on Windows without regard to case.
const comparable = (path: string): string => {
  const resolved = realpathOrUndefined(path) ?? path
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

// Whether a macOS app runs translocated: from a random read-only copy the system makes of
// an app that was downloaded and opened in place. That path is gone with the run, so it is
// no place to hand a later launch to.
const translocated = (path: string): boolean => path.includes("/AppTranslocation/")

// Tells the person that the newer portable copy at `path` would not start, which leaves the
// app with nothing to do but quit.
const alertPortableNotStarted = async (path: string): Promise<void> => {
  await dialog.showMessageBox({
    type: "error",
    message: "A newer Novadeck did not start.",
    detail: `This copy is older than the one you last used, which may have upgraded your workspace, so it was not opened. Open the newer copy yourself. It is at ${path}.`,
  })
}

/** What a launch's look at the other copies is handed of the running app. */
export type PortableLaunchHost = {
  readonly copies: MachineCopies
  /** Ends this process, its log closed first. */
  readonly exitApp: (code: number) => void
  readonly log: (message: string, error: unknown) => void
}

/** A launch's look at the other copies of the app; see `leaveForNewer`. */
export const portableLaunch = ({ copies, exitApp, log }: PortableLaunchHost) => {
  // The note a portable launch leaves when it redirects to the installed copy.
  const redirect = redirectMarker(
    join(app.getPath("userData"), "redirected-at"),
    redirectWindowMs,
    markerFiles,
    Date.now,
    log,
  )
  // The same for a launch handed to a newer portable copy, which clears it as it starts.
  const handoff = redirectMarker(
    join(app.getPath("userData"), "handed-off-at"),
    redirectWindowMs,
    markerFiles,
    Date.now,
    log,
  )

  // The record of the newest portable copy, and what is asked of the machine to use it.
  const portableRecordFile = join(app.getPath("userData"), portableRecordName)
  const portableRecord = {
    read: (): string | undefined => {
      try {
        return readFileSync(portableRecordFile, "utf8")
      } catch {
        return undefined
      }
    },
    // Written whole beside the file and renamed over it, so a reader never sees half of it.
    write: (text: string): void => {
      const staged = `${portableRecordFile}.${process.pid}.tmp`
      mkdirSync(dirname(portableRecordFile), { recursive: true })
      try {
        writeFileSync(staged, text)
        renameSync(staged, portableRecordFile)
      } catch (error) {
        rmSync(staged, { force: true })
        throw error
      }
    },
    isSelf: (path: string): boolean => comparable(path) === comparable(ownCopy()),
    // Whether a copy is there to start and whole: an AppImage that is a file with the
    // executable bit; the Windows executable with its `resources` folder; the macOS bundle
    // with its property list and the executable.
    usable: (path: string): boolean => {
      try {
        if (process.platform === "darwin")
          return (
            existsSync(join(path, "Contents", "Info.plist")) &&
            existsSync(join(path, "Contents", "MacOS", basename(app.getPath("exe"))))
          )
        if (process.platform === "win32")
          return statSync(path).isFile() && existsSync(join(dirname(path), "resources"))
        accessSync(path, constants.X_OK)
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
    log,
  }

  return {
    /**
     * Whether this launch gave way to a newer copy, which it then started in its place or
     * quit for. A portable copy gives way to the newest copy there is: an installed copy of
     * the same version or a newer one, or the newest portable copy that ran in this data
     * folder if it is newer than the installed one; either may have upgraded the data this
     * copy cannot open. Nothing has started yet, so there is nothing to shut down. The
     * portable record is looked at first only to pick the newer of the two; on a tie the
     * installed copy wins. A launch that stays is recorded for later ones to hand over to.
     */
    leaveForNewer: async (portable: boolean): Promise<boolean> => {
      // An installed copy that starts answers a redirect: a later portable launch redirects again.
      if (!portable) redirect.clear()
      // An install interrupted on macOS may have left the only installed copy renamed aside,
      // and a half-made one; tidy before looking for installed copies.
      if (portable && process.platform === "darwin") await copies.recoverBundles()
      // Looked for once, by whichever check asks first.
      let found: ReturnType<MachineCopies["installedCopies"]> | undefined
      const foundCopies = () => (found ??= copies.installedCopies())
      if (
        await leaveForNewerPortable({
          portable,
          version: app.getVersion(),
          ...portableRecord,
          installedVersion: async () =>
            currentOrNewerCopy(await foundCopies(), app.getVersion())?.version,
          start: copies.startInstalledCopy,
          alert: alertPortableNotStarted,
          recentHandoff: handoff.recent,
          markHandoff: handoff.mark,
          quit: () => exitApp(0),
        })
      )
        return true
      if (
        await leaveForNewerInstalled({
          portable,
          version: app.getVersion(),
          find: foundCopies,
          start: copies.startInstalledCopy,
          alert: copies.alertNotStarted,
          recentRedirect: redirect.recent,
          markRedirect: redirect.mark,
          quit: () => exitApp(0),
          log,
        })
      )
        return true
      // This launch stays, so the copy it was handed over to, if it was one, has answered; and
      // this copy is the one to hand a later launch to, unless a newer one is there. A
      // translocated macOS copy has no lasting path to record.
      handoff.clear()
      if (portable && ownCopy() !== "" && !translocated(ownCopy()))
        recordPortableCopy(portableRecord, { path: ownCopy(), version: app.getVersion() })
      return false
    },
  }
}
