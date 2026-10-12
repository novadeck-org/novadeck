import { cp } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildEngine } from "../../ggml-build/index.ts"

// The whisper.cpp engine voice input downloads, built for this platform:
//
//   node scripts/build.ts     builds dist/novadeck-whisper-<platform>-<arch>.tar.gz and
//                             dist/engine.json, which names it with its SHA-256 and size
//                             and the interface it speaks
//
// The archive holds `whisper-server`, the libraries and backend modules it loads, a
// sample of speech for the post-install check and whisper.cpp's licence, all flat. The
// build itself, shared with the murmur engine, is application/ggml-build.

const root = fileURLToPath(new URL("..", import.meta.url))

const version = "v1.9.4"
const commit = "927cfce34f31707e17f2bff35c349632fb9e2c3a"

export const main = (): Promise<void> =>
  buildEngine({
    root,
    name: "whisper",
    label: "voice engine",
    project: "whisper.cpp",
    version,
    commit,
    sourceUrl: `https://github.com/ggml-org/whisper.cpp/archive/${commit}.tar.gz`,
    sourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
    // The interface the runner launches the server through: the flags it passes and the
    // HTTP surface the patches give it. Bump it with any change to either, so an app that
    // is still fetching this engine does not dictate with an older one that would not
    // understand the runner (see olderEngine in application/runner/src/engines/unpack.ts).
    engineInterface: 1,
    target: "whisper-server",
    executable: "whisper-server",
    options: [
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DWHISPER_BUILD_EXAMPLES=ON",
      "-DWHISPER_BUILD_SERVER=ON",
      "-DWHISPER_CURL=OFF",
      "-DWHISPER_SDL2=OFF",
    ],
    windowsBuild: { env: "NOVADECK_WHISPER_BUILD", folder: "nvw" },
    extras: async (source, staging) => {
      await cp(join(source, "samples", "jfk.wav"), join(staging, "check.wav"))
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
