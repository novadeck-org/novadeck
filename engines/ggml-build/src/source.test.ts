import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe as context, describe, expect, it } from "vitest"

import { type Configuration, configurations } from "./cmake.ts"
import { commands, type Run, sha256 } from "./machine.ts"
import { buildKeys, notPinned, patchFiles, patchTargets, prepare, windowsBuild } from "./source.ts"
import type { EngineSpec } from "./spec.ts"

const commit = "927cfce34f31707e17f2bff35c349632fb9e2c3a"
const patch = new TextEncoder().encode("--- a/server.cpp\n+++ b/server.cpp\n")
const linux = configurations([], { platform: "linux", arch: "x64", vulkanSdk: undefined })

const folders: string[] = []
const folder = (): string => {
  const path = mkdtempSync(join(tmpdir(), "ggml-build-"))
  folders.push(path)
  return path
}

afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

const engine = (root: string, patches: readonly string[]): EngineSpec => ({
  root,
  name: "whisper",
  label: "voice engine",
  project: "whisper.cpp",
  version: "v1",
  commit,
  sourceUrl: `https://example.com/${commit}.tar.gz`,
  sourceSha256: sha256(new TextEncoder().encode("source")),
  engineInterface: 1,
  patches,
  target: "whisper-server",
  executable: "whisper-server",
  options: [],
  windowsBuild: { env: "NOVADECK_WHISPER_BUILD", folder: "nvw" },
  extras: async () => {},
})

describe("the build's folders", () => {
  // Pinned: a change here moves every cached build and Windows build folder.
  it("are named by the commit, the patches' digest and the configurations, shorter for Windows", () => {
    expect(buildKeys(commit, [patch], linux)).toEqual({
      key: "927cfce34f31-3f050eae639b",
      short: "927cfce3-3f050e",
    })
  })

  it("change with a patch, so a changed patch builds afresh", () => {
    const changed = new TextEncoder().encode("--- a/server.cpp\n+++ b/server.cpp\n+\n")
    expect(buildKeys(commit, [changed], linux).key).not.toBe(buildKeys(commit, [patch], linux).key)
    expect(buildKeys(commit, [changed], linux).short).not.toBe(
      buildKeys(commit, [patch], linux).short,
    )
  })

  it("change with an option, so one taken away does not keep its value in CMake's cache", () => {
    const fewer: Configuration[] = [{ slice: undefined, options: linux[0]!.options.slice(1) }]
    expect(buildKeys(commit, [patch], fewer).key).not.toBe(buildKeys(commit, [patch], linux).key)
  })

  it("stay the same for the same commit, patches and configurations", () => {
    expect(buildKeys(commit, [patch], linux)).toEqual(buildKeys(commit, [patch], linux))
  })

  context("on Windows", () => {
    const spec = engine("C:\\Novadeck\\engines\\whisper", [])

    it("go where the engine's variable says", () => {
      expect(windowsBuild(spec, "927cfce3-c2d0d5", { NOVADECK_WHISPER_BUILD: "D:\\w" })).toBe(
        "D:\\w",
      )
    })

    it("go to a short folder at the drive's root when the variable is unset or empty", () => {
      expect(windowsBuild(spec, "927cfce3-c2d0d5", {})).toMatch(/nvw[/\\]927cfce3-c2d0d5$/)
      expect(windowsBuild(spec, "927cfce3-c2d0d5", { NOVADECK_WHISPER_BUILD: "" })).toBe(
        windowsBuild(spec, "927cfce3-c2d0d5", {}),
      )
    })
  })
})

describe("the source tarball", () => {
  const spec = engine("/engine", [])

  it("is the pinned one when its digest is", () => {
    expect(notPinned(spec, new TextEncoder().encode("source"))).toBeUndefined()
  })

  it("names the digest and size it got when it is not", () => {
    const got = new TextEncoder().encode("<html>")
    expect(notPinned(spec, got)).toBe(
      `whisper.cpp's source tarball is not the one pinned (${spec.sourceUrl}): ` +
        `got 6 bytes with sha256 ${sha256(got)}, not ${spec.sourceSha256}.`,
    )
  })
})

describe("the engine's patches", () => {
  it("are the ones its spec lists, in the spec's order", () => {
    const root = folder()
    mkdirSync(join(root, "patches"))
    for (const name of ["a.patch", "b.patch", "notes.md"])
      writeFileSync(join(root, "patches", name), "")
    expect(patchFiles(engine(root, ["b.patch", "a.patch"]))).toEqual([
      join(root, "patches", "b.patch"),
      join(root, "patches", "a.patch"),
    ])
  })

  it("stop the build when the folder holds one the spec leaves out, or lacks one it lists", () => {
    const root = folder()
    mkdirSync(join(root, "patches"))
    writeFileSync(join(root, "patches", "a.patch"), "")
    writeFileSync(join(root, "patches", "b.patch"), "")
    expect(() => patchFiles(engine(root, ["a.patch", "c.patch"]))).toThrow(
      "The voice engine's patch list and its patches folder differ: " +
        "b.patch is not listed, c.patch is not in the folder.",
    )
  })

  it("name the files they change, new, changed or deleted", () => {
    const diff = [
      "diff --git a/examples/server/server.cpp b/examples/server/server.cpp",
      "index d9b8cae..b7b4249 100644",
      "--- a/examples/server/server.cpp",
      "+++ b/examples/server/server.cpp",
      "@@ -1,3 +1,3 @@",
      // A removed line that reads like a header, with no new name after it.
      "--- a/removed.txt",
      " context",
      "+++ b/added.txt",
      "--- /dev/null",
      "+++ b/new.txt\t2026-11-05",
      "--- a/old.txt",
      "+++ /dev/null",
      "--- a/examples/server/server.cpp",
      "+++ b/examples/server/server.cpp",
    ].join("\n")
    expect(patchTargets(diff)).toEqual(["examples/server/server.cpp", "new.txt", "old.txt"])
  })
})

// A tarball of one file, as GitHub makes them: under a folder named for the commit.
const tarball = (into: string, text: string): string => {
  const project = join(into, "project")
  const server = join(project, `whisper.cpp-${commit}`, "examples", "server")
  mkdirSync(server, { recursive: true })
  writeFileSync(join(server, "server.cpp"), text)
  const file = join(into, "source.tar.gz")
  const made = spawnSync("tar", ["-czf", file, "-C", project, `whisper.cpp-${commit}`])
  expect(made.status).toBe(0)
  return file
}

const serverPatch = [
  "diff --git a/examples/server/server.cpp b/examples/server/server.cpp",
  "--- a/examples/server/server.cpp",
  "+++ b/examples/server/server.cpp",
  "@@ -1 +1 @@",
  "-listen anywhere",
  "+listen on loopback",
  "",
].join("\n")

context.skipIf(process.platform === "win32")("preparing the source", () => {
  const setUp = () => {
    const root = folder()
    mkdirSync(join(root, "patches"))
    writeFileSync(join(root, "patches", "loopback-only.patch"), serverPatch)
    const spec = engine(root, ["loopback-only.patch"])
    return { root, spec, cache: join(root, ".cache"), file: tarball(folder(), "listen anywhere\n") }
  }

  it("extracts the tarball and applies the patches", async () => {
    const { root, spec, cache, file } = setUp()
    const { source } = await prepare(spec, cache, file, commands("voice engine", root))
    expect(readFileSync(join(source, "examples", "server", "server.cpp"), "utf8")).toBe(
      "listen on loopback\n",
    )
  })

  it("stops the build when git skips a patch and still succeeds", async () => {
    const { root, spec, cache, file } = setUp()
    const real = commands("voice engine", root)
    // git ignores a patch's files that it reads as outside the folder, as when it finds a
    // repository around the cache, and exits 0; a reverse check run the same way does too.
    const skipping: Run = (command, args, options) => {
      if (command !== "git") real(command, args, options)
    }
    await expect(prepare(spec, cache, file, skipping)).rejects.toThrow(
      `${join(root, "patches", "loopback-only.patch")} did not change examples/server/server.cpp.`,
    )
  })

  it("stops the build when git finds a repository around the cache after all", async () => {
    const { root, spec, cache, file } = setUp()
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0)
    writeFileSync(join(root, ".gitignore"), ".cache/\n")
    const real = commands("voice engine", root)
    // As when git does not match the ceiling against its folder, as a Windows spelling may not.
    const unbounded: Run = (command, args, options) => {
      const { GIT_CEILING_DIRECTORIES: _, ...env } = options?.env ?? process.env
      real(command, args, command === "git" ? { ...options, env } : options)
    }
    await expect(prepare(spec, cache, file, unbounded)).rejects.toThrow(/did not change/)
  })

  it("stops the build when a patch does not apply", async () => {
    const { root, spec, cache } = setUp()
    const file = tarball(folder(), "listen somewhere else\n")
    await expect(prepare(spec, cache, file, commands("voice engine", root))).rejects.toThrow(
      /^git apply .* failed$/,
    )
  })
})
