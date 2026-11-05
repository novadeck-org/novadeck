import { lstatSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { macos, type Run, windows } from "./machine.ts"
import { signWindowsFiles, windowsSigning } from "./signtool.ts"
import { isLibrary } from "./stage.ts"

/** Signs the staged server and its libraries as the app is signed on this platform. */
export const sign = async (staging: string, executable: string, run: Run): Promise<void> => {
  if (macos) await signMac(staging, executable, run)
  if (windows) await signWindows(staging)
}

// Apple silicon runs only signed code, so on macOS every Mach-O is signed: with the
// Developer ID that NOVADECK_MAC_IDENTITY names, under the hardened runtime as the app is,
// or else ad hoc.
const signMac = async (staging: string, executable: string, run: Run): Promise<void> => {
  const identity = process.env.NOVADECK_MAC_IDENTITY
  const how = identity
    ? ["--options", "runtime", "--timestamp", "--sign", identity]
    : ["--sign", "-"]
  for (const name of await readdir(staging)) {
    const path = join(staging, name)
    // A link points at a file signed under its own name.
    if (lstatSync(path).isFile() && (name === executable || isLibrary(name, "darwin"))) {
      run("codesign", ["--force", ...how, path])
    }
  }
}

/** Whether Windows signs the staged file: the server and its modules, not the files beside them. */
export const signedOnWindows = (name: string): boolean => /\.(exe|dll)$/i.test(name)

// On Windows the server and its modules are signed through Azure Artifact Signing, as the
// app is and with the same pinned tools (see signtool.ts), when the release names the account.
const signWindows = async (staging: string): Promise<void> => {
  const signing = windowsSigning(process.env)
  if (!signing) return
  const files = (await readdir(staging, { withFileTypes: true }))
    .filter((file) => file.isFile() && signedOnWindows(file.name))
    .map((file) => join(staging, file.name))
  await signWindowsFiles(files, signing)
}
