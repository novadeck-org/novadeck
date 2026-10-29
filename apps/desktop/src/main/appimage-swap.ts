import { chmodSync, copyFileSync, renameSync, rmSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"

import { fileIdentity } from "./update-state.js"

/** The parts of the file system a swap uses, so a test can fail a step. */
export type SwapFiles = {
  rename(from: string, to: string): void
  copy(from: string, to: string): void
  chmod(path: string, mode: number): void
  remove(path: string): void
  identity(path: string): string
}

const files: SwapFiles = {
  rename: renameSync,
  copy: copyFileSync,
  chmod: chmodSync,
  remove: (path) => rmSync(path, { force: true }),
  identity: (path) => fileIdentity(statSync(path)),
}

/**
 * Puts the downloaded AppImage `update` in place of the running one, `target` (`$APPIMAGE`),
 * and returns how the file at `target` then looks (`fileIdentity`). A single rename over
 * `target`, so there is never a moment with no file there, which electron-updater's own
 * install leaves (it deletes the file and then moves the new one in, and a launch in
 * between finds nothing). The running app is not disturbed: its mount holds the old file
 * through its inode, which the rename only unlinks. When the download sits on another file
 * system, so a rename cannot cross to it, the update is first copied beside `target` under
 * a name of its own and that is renamed over it; the download is removed afterwards, as
 * electron-updater's move would have. The file keeps `target`'s name whatever the
 * download's is: no release file carries a version in its name.
 *
 * It throws when `target` is not an absolute path or any step fails; `target` is then
 * whole, the old file or the new one. Once the file is in place nothing fails it: should
 * its identity not be read, that is returned as undefined, which only costs the safety net.
 */
export const swapAppImage = (
  update: string,
  target: string,
  fs: SwapFiles = files,
): string | undefined => {
  if (!isAbsolute(target) || target.includes("\0"))
    throw new Error(`APPIMAGE is not a valid absolute path: "${target}"`)
  try {
    fs.rename(update, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    const beside = join(dirname(target), `.${basename(target)}.${process.pid}.new`)
    try {
      fs.copy(update, beside)
      fs.chmod(beside, 0o755)
      fs.rename(beside, target)
    } catch (failure) {
      try {
        fs.remove(beside)
      } catch {
        // the copy is a stray file at worst
      }
      throw failure
    }
    try {
      fs.remove(update)
    } catch {
      // electron-updater clears its download folder with the next download
    }
  }
  try {
    return fs.identity(target)
  } catch {
    return undefined
  }
}
