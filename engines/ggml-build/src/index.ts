import { join } from "node:path"

import { archiveName, pack, publish, readStaging } from "./archive.ts"
import { compile } from "./cmake.ts"
import { commands, machine, windows } from "./machine.ts"
import { sign } from "./sign.ts"
import { download, prepare } from "./source.ts"
import type { EngineSpec } from "./spec.ts"
import { stage } from "./stage.ts"
import { requireTools } from "./toolchain.ts"

// The build the ggml engines share: whisper.cpp's `whisper-server` for voice input and
// llama.cpp's `llama-server` for murmur. Each engine's `scripts/build.ts` names what is its
// own (the pinned source, its CMake options and target, its patches, any extra files) and
// calls `buildEngine`; this package fetches the pinned source, patches it, builds it for this
// platform, signs it and packs the engine as `dist/<archive>` and `dist/engine.json`.
//
// Linux and Windows build Vulkan and the CPU variants as modules loaded at run time; macOS
// builds Metal into one universal binary, as the universal app needs.

export type { EngineSpec } from "./spec.ts"

/** Builds the engine for this platform into `<root>/dist`: the archive and its `engine.json`. */
export const buildEngine = async (spec: EngineSpec): Promise<void> => {
  const run = commands(spec.label, spec.root)
  const cache = join(spec.root, ".cache")
  const staging = join(cache, "staging")
  const executable = windows ? `${spec.executable}.exe` : spec.executable
  requireTools(spec.label)
  const { source, build } = await prepare(spec, cache, await download(spec, cache), run)
  compile(spec, cache, source, build, run)
  await stage(build, staging, executable)
  await spec.extras(source, staging)
  await sign(staging, executable, run)
  await publish(
    join(spec.root, "dist"),
    archiveName(spec.name, machine.platform, machine.arch),
    pack(await readStaging(staging)),
    spec.engineInterface,
  )
}
