import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Catalog } from "../voice/catalog.js"
import { engineProgram, type Launch } from "../voice/engine.js"
import type { Resources } from "./resources.js"

/** Runs the fake engine, whatever the engine's program is called. */
export const fakeLaunch: Launch = (_program, args) => ({
  command: process.execPath,
  args: [join(dirname(fileURLToPath(import.meta.url)), "fake-engine.mjs"), ...args],
})

export const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex")

/** A folder that goes with the test. */
export const folder = async (resources: Resources): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "novadeck-voice-test-"))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * An engine archive and its manifest in a new folder, as the build leaves them: the
 * program, a test clip and a licence, packed flat. Returns the manifest's path, which
 * beside the archive is also its source. Another `release` is another engine, with another
 * checksum.
 */
export const engineArchive = async (resources: Resources, release = "1"): Promise<string> => {
  const directory = await folder(resources)
  const contents = join(directory, "contents")
  await mkdir(contents)
  await writeFile(join(contents, engineProgram), "not a program: tests run a fake")
  await writeFile(join(contents, "check.wav"), Buffer.alloc(3200))
  await writeFile(join(contents, "LICENSE"), `MIT ${release}`)
  const file = "engine.tar.gz"
  const packed = spawnSync("tar", ["-czf", join(directory, file), "-C", contents, "."])
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr.toString()}`)
  const archive = await readFile(join(directory, file))
  const manifest = join(directory, "engine.json")
  await writeFile(manifest, JSON.stringify({ file, sha256: sha256(archive), size: archive.length }))
  return manifest
}

/** Models as small files in a folder, which a download copies; each says how the fake behaves. */
export const modelCatalog = async (
  resources: Resources,
  behaviour: { turbo?: string; small?: string } = {},
): Promise<Catalog> => {
  const directory = await folder(resources)
  const make = async (name: string, content: string) => {
    const path = join(directory, name)
    await writeFile(path, content)
    return { url: path, sha256: sha256(content), size: Buffer.byteLength(content) }
  }
  return {
    models: {
      turbo: await make("ggml-turbo.bin", behaviour.turbo ?? "turbo gpu"),
      small: await make("ggml-small.bin", behaviour.small ?? "small"),
    },
    vad: await make("ggml-vad.bin", "vad"),
  }
}
