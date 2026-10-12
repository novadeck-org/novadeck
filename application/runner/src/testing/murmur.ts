import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Artifact } from "../engines/manifest.js"
import type { Launch } from "../engines/server.js"
import { programFile } from "../engines/unpack.js"
import { engineArchive, fakeLaunchOf, folder, sha256 } from "./engines.js"
import type { Resources } from "./resources.js"

/** A device the fake llama-server lists, as `--list-devices` of the engine we build prints it. */
export type FakeDevice = {
  id: string
  name: string
  kind: "cpu" | "gpu" | "igpu" | "accel"
  /** MiB. */
  total?: number
  free?: number
}

export const arc: FakeDevice = { id: "Vulkan0", name: "Intel Arc Graphics", kind: "igpu" }
export const nvidia: FakeDevice = { id: "Vulkan1", name: "NVIDIA RTX 2000", kind: "gpu" }
export const processor: FakeDevice = { id: "CPU", name: "Some Processor", kind: "cpu" }

/** Runs the fake llama-server on `devices`, whatever the engine's program is called. */
export const fakeLaunch = (devices: readonly FakeDevice[]): Launch => {
  const run = fakeLaunchOf("fake-llama.mjs")
  return (program, args) => {
    const launched = run(program, args)
    return {
      ...launched,
      args: [
        launched.args[0] ?? "",
        "--fake-devices",
        JSON.stringify(devices),
        ...launched.args.slice(1),
      ],
    }
  }
}

/** An engine archive and its manifest, holding the program murmur launches. */
export const llamaArchive = (resources: Resources, release = "1"): Promise<string> =>
  engineArchive(resources, programFile("llama-server"), { release })

/**
 * A model as a small file, which a download copies; what it says is how the fake behaves
 * (see fake-llama.mjs).
 */
export const modelFile = async (resources: Resources, behaviour = "plain"): Promise<Artifact> => {
  const path = join(await folder(resources), "model.gguf")
  await writeFile(path, behaviour)
  return { url: path, sha256: sha256(behaviour), size: Buffer.byteLength(behaviour) }
}

export { folder, sha256 }
