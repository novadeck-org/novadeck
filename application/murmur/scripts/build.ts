import { cp } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildEngine } from "../../ggml-build/index.ts"

// The llama.cpp engine murmur downloads, built for this platform:
//
//   node scripts/build.ts     builds dist/novadeck-murmur-<platform>-<arch>.tar.gz and
//                             dist/engine.json, which names it with its SHA-256 and size
//                             and the interface it speaks
//
// The archive holds `llama-server`, the libraries and backend modules it loads and
// llama.cpp's licence, all flat. It does not hold the model: the runner downloads that
// apart. The build itself, shared with the voice engine, is application/ggml-build.

const root = fileURLToPath(new URL("..", import.meta.url))

// Release b11541, the build murmur's model was tested on.
const version = "b11541"
const commit = "f2918cabbffe8abf8e2a90c1c089085fa116c2cf"

export const main = (): Promise<void> =>
  buildEngine({
    root,
    name: "murmur",
    label: "murmur engine",
    project: "llama.cpp",
    version,
    commit,
    sourceUrl: `https://github.com/ggml-org/llama.cpp/archive/${commit}.tar.gz`,
    sourceSha256: "8958c760e0772e8305c24d2ce7df740811ce61b3371b43875c0a031781e2e0a1",
    // The interface the runner launches the server through: the flags it passes (see
    // application/runner/src/murmur/service.ts), the HTTP surface it requests, the patches'
    // flags and the output of `--list-devices`. Bump it with any change to them, so an app
    // that is still fetching this engine does not run an older one that would not understand
    // the runner (see olderEngine in application/runner/src/engines/unpack.ts).
    engineInterface: 1,
    target: "llama-server",
    executable: "llama-server",
    options: [
      "-DLLAMA_BUILD_TESTS=OFF",
      "-DLLAMA_BUILD_EXAMPLES=OFF",
      "-DLLAMA_BUILD_TOOLS=ON",
      "-DLLAMA_BUILD_SERVER=ON",
      // The server serves its API to the runner on loopback: no HTTPS, and no web page,
      // which the build would download from Hugging Face.
      "-DLLAMA_OPENSSL=OFF",
      "-DLLAMA_BUILD_UI=OFF",
      "-DLLAMA_USE_PREBUILT_UI=OFF",
      "-DLLAMA_TOOLS_INSTALL=OFF",
    ],
    windowsBuild: { env: "NOVADECK_MURMUR_BUILD", folder: "nvmu" },
    extras: async (source, staging) => {
      await cp(join(source, "LICENSE"), join(staging, "LICENSE"))
    },
  })

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
