// The Electron fuses the packaged app ships with (see `electronFuses` in electron-builder.yml),
// read back from the binary, and a copy of that binary with the three that keep the Node
// entry points shut flipped open, which is what launching the app under Playwright and running
// the app's code as Node, both of which the smoke test and the bench do, need.
import { execFileSync } from "node:child_process"
import { copyFileSync, rmSync } from "node:fs"
import { basename, dirname, extname, join } from "node:path"

import fuses from "@electron/fuses"

const { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } = fuses

// The package declares its FuseState enum but does not export it at run time.
const FuseState = { DISABLE: 48, ENABLE: 49 }

/** What a shipped binary must read back: the fuse, its name, and its state. */
export const shipped = [
  [FuseV1Options.RunAsNode, "RunAsNode", FuseState.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, "NODE_OPTIONS", FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, "the inspect arguments", FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, "asar integrity", FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, "only-load-from-asar", FuseState.ENABLE],
]

/** The ways `executable`'s fuses differ from what ships, as sentences; none when they match. */
export const fuseProblems = async (executable) => {
  const wire = await getCurrentFuseWire(executable)
  return shipped.flatMap(([fuse, name, wanted]) =>
    wire[fuse] === wanted
      ? []
      : [`${name} is ${wire[fuse] === FuseState.ENABLE ? "on" : "off"} in ${executable}`],
  )
}

/**
 * A copy of `executable` beside it, byte for byte but for RunAsNode, NODE_OPTIONS and the
 * inspect arguments turned on, so it finds the same resources and runs the same code. On macOS
 * the copy is signed ad hoc again, as a changed binary no longer matches its signature.
 */
export const openedCopy = async (executable) => {
  const extension = extname(executable)
  const copy = join(dirname(executable), `${basename(executable, extension)}-open${extension}`)
  copyFileSync(executable, copy)
  const remove = () => rmSync(copy, { force: true })
  try {
    await flipFuses(copy, {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: process.platform === "darwin",
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
      [FuseV1Options.EnableNodeCliInspectArguments]: true,
    })
    if (process.platform === "darwin")
      execFileSync("codesign", ["--force", "--sign", "-", copy], { stdio: "ignore" })
  } catch (error) {
    remove()
    throw error
  }
  return { executable: copy, remove }
}
