import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Catalog } from "../voice/catalog.js"
import { engineProgram } from "../voice/engine.js"
import { engineArchive as archive, fakeLaunchOf, folder, sha256 } from "./engines.js"
import type { Resources } from "./resources.js"

export { folder, sha256 }

/** Runs the fake engine, whatever the engine's program is called. */
export const fakeLaunch = fakeLaunchOf("fake-engine.mjs")

/** A voice engine archive, with the test clip the check transcribes; see `engineArchive` in engines. */
export const engineArchive = (
  resources: Resources,
  release = "1",
  fields: Record<string, unknown> = {},
): Promise<string> =>
  archive(resources, engineProgram, {
    release,
    fields,
    extras: { "check.wav": Buffer.alloc(3200) },
  })

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
