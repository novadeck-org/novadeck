import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe as context, describe, expect, it } from "vitest"

import { isLibrary, stage } from "./stage.ts"

const folders: string[] = []
const folder = (): string => {
  const path = mkdtempSync(join(tmpdir(), "ggml-build-"))
  folders.push(path)
  return path
}

afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

const write = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

describe("what the engine stages beside its server", () => {
  it("takes Linux shared objects, versioned ones included", () => {
    expect(isLibrary("libggml.so", "linux")).toBe(true)
    expect(isLibrary("libggml-base.so.0.9.4", "linux")).toBe(true)
    expect(isLibrary("libggml.a", "linux")).toBe(false)
  })

  it("takes dylibs on macOS and DLLs on Windows", () => {
    expect(isLibrary("libggml.dylib", "darwin")).toBe(true)
    expect(isLibrary("libggml.so", "darwin")).toBe(false)
    expect(isLibrary("ggml-vulkan.dll", "win32")).toBe(true)
    expect(isLibrary("ggml-vulkan.lib", "win32")).toBe(false)
  })
})

context.skipIf(process.platform === "win32")("staging a build", () => {
  // A build tree as CMake leaves it: the server, libraries under their own folders with a
  // soname link, and CMake's own files.
  const tree = (): string => {
    const build = folder()
    write(join(build, "bin", "whisper-server"), "server")
    write(join(build, "src", "libwhisper.so.1"), "whisper")
    symlinkSync("libwhisper.so.1", join(build, "src", "libwhisper.so"))
    write(join(build, "ggml", "src", "libggml-cpu-haswell.so"), "haswell")
    write(join(build, "ggml", "src", "libggml.a"), "archive")
    write(join(build, "CMakeFiles", "3.28", "CompilerIdC", "libprobe.so"), "probe")
    return build
  }

  it("gathers the server and its libraries flat, links as links, and none of CMake's files", async () => {
    const staging = join(folder(), "staging")
    await stage(tree(), staging, "whisper-server", "linux")
    expect(readdirSync(staging).toSorted()).toEqual([
      "libggml-cpu-haswell.so",
      "libwhisper.so",
      "libwhisper.so.1",
      "whisper-server",
    ])
    expect(readlinkSync(join(staging, "libwhisper.so"))).toBe("libwhisper.so.1")
    expect(readFileSync(join(staging, "whisper-server"), "utf8")).toBe("server")
  })

  it("takes one copy of a file the build wrote twice", async () => {
    const build = tree()
    write(join(build, "bin", "libwhisper.so.1"), "whisper")
    const staging = join(folder(), "staging")
    await stage(build, staging, "whisper-server", "linux")
    expect(readFileSync(join(staging, "libwhisper.so.1"), "utf8")).toBe("whisper")
  })

  it("stops the build when two different files share a name", async () => {
    const build = tree()
    write(join(build, "stale", "libggml-cpu-haswell.so"), "an earlier configuration's")
    await expect(
      stage(build, join(folder(), "staging"), "whisper-server", "linux"),
    ).rejects.toThrow(/The build produced two different libggml-cpu-haswell.so/)
  })

  it("stops the build when there is no server", async () => {
    await expect(stage(tree(), join(folder(), "staging"), "llama-server", "linux")).rejects.toThrow(
      "The build produced no llama-server.",
    )
  })
})
