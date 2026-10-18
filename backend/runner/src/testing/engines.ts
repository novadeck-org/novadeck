import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Launch } from "../engines/server.js"
import type { Resources } from "./resources.js"

/** A launch that runs the fake engine script `script`, in this folder, whatever the engine's program is called. */
export const fakeLaunchOf =
  (script: string): Launch =>
  (_program, args) => ({
    command: process.execPath,
    args: [join(dirname(fileURLToPath(import.meta.url)), script), ...args],
  })

export const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex")

/** A folder that goes with the test. */
export const folder = async (resources: Resources): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "novadeck-engine-test-"))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * An engine archive and its manifest in a new folder, as the build leaves them: the
 * `program`, a licence and any `extras` (file name to contents), packed flat. Returns the
 * manifest's path, which beside the archive is also its source. Another `release` is
 * another engine, with another checksum. `fields` adds to the manifest, as the build's
 * `interface` does.
 */
export const engineArchive = async (
  resources: Resources,
  program: string,
  options: {
    release?: string
    fields?: Record<string, unknown>
    extras?: Record<string, string | Uint8Array>
  } = {},
): Promise<string> => {
  const directory = await folder(resources)
  const contents = join(directory, "contents")
  await mkdir(contents)
  await writeFile(join(contents, program), "not a program: tests run a fake")
  await writeFile(join(contents, "LICENSE"), `MIT ${options.release ?? "1"}`)
  await Promise.all(
    Object.entries(options.extras ?? {}).map(([name, data]) =>
      writeFile(join(contents, name), data),
    ),
  )
  const file = "engine.tar.gz"
  const packed = spawnSync("tar", ["-czf", join(directory, file), "-C", contents, "."])
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr.toString()}`)
  const archive = await readFile(join(directory, file))
  const manifest = join(directory, "engine.json")
  await writeFile(
    manifest,
    JSON.stringify({
      file,
      sha256: sha256(archive),
      size: archive.length,
      interface: 1,
      ...options.fields,
    }),
  )
  return manifest
}
