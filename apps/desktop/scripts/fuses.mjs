// The Electron fuses the packaged app ships with (see `electronFuses` in electron-builder.yml),
// read back from the binary, and a copy of the app with the three that keep the Node entry
// points shut turned on, which is what launching the app under Playwright and running its
// code as Node, both of which the smoke test and the bench do, need.
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"

import fuses from "@electron/fuses"

const { FuseV1Options, FuseVersion, flipFuses } = fuses

// The package declares its FuseState enum but does not export it at run time.
const FuseState = { DISABLE: 48, ENABLE: 49 }
// Where the fuse wire starts in the binary: this marker, then the wire's version and length.
const sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"

/** What a shipped binary must read back: the fuse, its name, and its state. */
export const shipped = [
  [FuseV1Options.RunAsNode, "RunAsNode", FuseState.DISABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, "NODE_OPTIONS", FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, "the inspect arguments", FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, "asar integrity", FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, "only-load-from-asar", FuseState.ENABLE],
]

// The file the fuses live in: the executable, or on macOS the framework beside it.
const fuseFile = (executable) =>
  executable.includes(".app")
    ? resolve(
        executable,
        "..",
        "..",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      )
    : executable

/**
 * The ways `executable`'s fuses differ from what ships, as sentences; none when they match.
 * A universal macOS binary holds the wire twice, one per architecture, and both are checked.
 */
export const fuseProblems = async (executable) => {
  const file = fuseFile(executable)
  const binary = readFileSync(file)
  const wires = []
  for (let at = binary.indexOf(sentinel); at !== -1; at = binary.indexOf(sentinel, at + 1))
    wires.push(at + sentinel.length)
  if (wires.length === 0) return [`${file} has no fuse wire`]
  return wires.flatMap((wire, index) =>
    shipped.flatMap(([fuse, name, wanted]) => {
      const state = binary[wire + 2 + fuse]
      return state === wanted
        ? []
        : [
            `${name} is ${state === FuseState.ENABLE ? "on" : "off"} in ${file}${wires.length > 1 ? ` (slice ${index + 1})` : ""}`,
          ]
    }),
  )
}

const open = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true,
  [FuseV1Options.EnableNodeCliInspectArguments]: true,
}

// Removing a copy must not hide the result of the run it served: on Windows the crashpad
// handler can outlive the app and hold its executable.
const removing = (path) => () => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {}
}

/**
 * A copy of the app that differs from `executable`'s only in RunAsNode, NODE_OPTIONS and the
 * inspect arguments being on, so it finds the same app.asar and runs the same code; `remove`
 * deletes it. On Linux and Windows it is the executable beside the original. On macOS the fuses
 * live in the bundle's framework, so the whole `.app` is copied to a folder of its own and
 * signed there ad hoc, without the hardened runtime that would refuse the changed framework;
 * the bundle that ships is left as it is.
 */
export const openedCopy = async (executable) => {
  if (process.platform === "darwin") {
    const bundle = executable.slice(0, executable.indexOf(".app") + ".app".length)
    const folder = mkdtempSync(join(tmpdir(), "novadeck-open-"))
    const remove = removing(folder)
    try {
      const copy = join(folder, basename(bundle))
      execFileSync("ditto", [bundle, copy])
      const opened = join(copy, executable.slice(bundle.length + 1))
      await flipFuses(opened, open)
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", copy], { stdio: "ignore" })
      return { executable: opened, remove }
    } catch (error) {
      remove()
      throw error
    }
  }
  const extension = extname(executable)
  const copy = join(dirname(executable), `${basename(executable, extension)}-open${extension}`)
  const remove = removing(copy)
  try {
    copyFileSync(executable, copy)
    await flipFuses(copy, open)
  } catch (error) {
    remove()
    throw error
  }
  return { executable: copy, remove }
}
