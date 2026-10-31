// What decides how this build updates, read from the running app and the machine once.
import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"

import { app } from "electron"

import { appImageWritable, realpathOrUndefined } from "../install/copies.js"
import { isInstalledImage } from "../install/location.js"
import { bundleOf } from "../install/mac.js"
import { macSwapMode } from "./mac.js"
import { developerIdSigned, type UpdateBuild } from "./updater.js"

/** What decides how this build updates, but for the signature. */
export type UnsignedBuild = Omit<UpdateBuild, "signed">

// Whether the signature matters to this launch: a packaged macOS build that looks for
// updates. Others never ask, and codesign takes a moment.
const checksSignature = (): boolean =>
  process.platform === "darwin" &&
  app.isPackaged &&
  app.getVersion() !== "0.0.0" &&
  process.env.NOVADECK_UPDATES !== "off"

/**
 * What decides how this build updates, each part read once and kept. `windowsInstalled`
 * tells whether the Windows installer made this copy.
 */
export const buildFacts = (windowsInstalled: () => Promise<boolean>) => {
  // Whether `codesign` finds a Developer ID signature on the running macOS app bundle; run
  // once, as the update plan asks.
  let signature: Promise<boolean> | undefined
  const bundleSigned = (): Promise<boolean> =>
    (signature ??= new Promise((resolve) => {
      execFile(
        "codesign",
        ["--display", "--verbose=2", bundleOf(app.getPath("exe"))],
        { timeout: 10_000 },
        // codesign reports on stderr, and exits non-zero for an unsigned bundle.
        (_error, stdout, stderr) => resolve(developerIdSigned(`${stdout}\n${stderr}`)),
      )
    }))

  // What decides how this build updates, but for the signature, which takes a moment to ask
  // and which a launch need not wait for to tell whether it is portable.
  let unsigned: Promise<UnsignedBuild> | undefined
  const unsignedBuild = (): Promise<UnsignedBuild> =>
    (unsigned ??= (async () => {
      const appDir = process.env.APPDIR
      const linux = process.platform === "linux"
      const appImage = process.env.APPIMAGE
      return {
        packaged: app.isPackaged,
        version: app.getVersion(),
        platform: process.platform,
        execPath: process.execPath,
        // The AppImage mounts under TMPDIR, which may reach it through a symlink; the
        // executable's path is the real one.
        env: { ...process.env, APPDIR: appDir && (await realpath(appDir).catch(() => appDir)) },
        inApplications: process.platform === "darwin" && app.isInApplicationsFolder(),
        bundleSwap:
          process.platform === "darwin" && app.isInApplicationsFolder()
            ? await macSwapMode(bundleOf(app.getPath("exe")))
            : undefined,
        appImageWritable: linux && (await appImageWritable()),
        windowsInstalled: process.platform === "win32" && (await windowsInstalled()),
        appImageInstalled:
          linux &&
          appImage !== undefined &&
          isInstalledImage(appImage, {
            env: process.env,
            home: homedir(),
            realpath: realpathOrUndefined,
          }),
      }
    })())

  // What decides how this build updates, read once.
  let signed: Promise<UpdateBuild> | undefined
  const updateBuild = (): Promise<UpdateBuild> =>
    (signed ??= (async () => {
      const rest = await unsignedBuild()
      // Asked only where it matters: codesign takes a moment, and a portable copy only
      // tells of updates whether it is signed or not.
      return { ...rest, signed: checksSignature() && rest.inApplications && (await bundleSigned()) }
    })())

  return {
    unsignedBuild,
    updateBuild,

    /** Forgets what was read, as letting this copy install updates changes it. */
    forget: (): void => {
      unsigned = undefined
      signed = undefined
    },
  }
}

/** What decides how this build updates; see `buildFacts`. */
export type BuildFacts = ReturnType<typeof buildFacts>
