import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeAll, describe as context, describe, expect, it } from "vitest"

import type { Slice } from "./cmake.ts"
import { commands, output } from "./machine.ts"
import { archsProblem, merge, mergePlan } from "./universal.ts"

const folders: string[] = []
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

const staged = [
  { name: "whisper-server" },
  { name: "libwhisper.1.dylib" },
  { name: "libwhisper.dylib", link: "libwhisper.1.dylib" },
]

describe("the universal engine", () => {
  it("merges each binary from every slice and keeps each link once", () => {
    expect(mergePlan([staged, staged.toReversed()])).toEqual([
      { name: "libwhisper.1.dylib" },
      { name: "libwhisper.dylib", link: "libwhisper.1.dylib" },
      { name: "whisper-server" },
    ])
  })

  it("stops the build when one slice staged a file the other lacks", () => {
    expect(() => mergePlan([staged, staged.slice(0, 2)])).toThrow(
      /The slices staged different files/,
    )
  })

  it("stops the build when the slices' links point apart", () => {
    const other = [...staged.slice(0, 2), { name: "libwhisper.dylib", link: "libwhisper.2.dylib" }]
    expect(() => mergePlan([staged, other])).toThrow(/The slices staged different files/)
  })

  it("holds both architectures in every binary", () => {
    expect(archsProblem("x86_64 arm64\n", ["arm64", "x86_64"])).toBeUndefined()
    expect(archsProblem("arm64\n", ["arm64", "x86_64"])).toBe("holds arm64, not arm64 x86_64")
    expect(archsProblem("", ["arm64", "x86_64"])).toBe("holds no slice, not arm64 x86_64")
  })
})

// Needs Xcode's command line tools, as the macOS build does.
context.skipIf(process.platform !== "darwin")("merging the slices with lipo", () => {
  const slices: Slice[] = ["arm64", "x86_64"]
  let root = ""
  // The slices are built before the test, on a budget of their own: a fresh runner's first call
  // into Xcode's tools (cc, then lipo) warms them up, which took 10 s on CI's and, on a loaded
  // one, over a minute. Each step's time is told, so a slow one says which it was.
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ggml-build-"))
    folders.push(root)
    writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n")
    const timed = <T>(step: string, run: () => T): T => {
      const started = performance.now()
      try {
        return run()
      } finally {
        console.log(`${step}: ${Math.round(performance.now() - started)} ms`)
      }
    }
    for (const slice of slices) {
      const folder = join(root, slice)
      mkdirSync(folder)
      const made = timed(`cc -arch ${slice}`, () =>
        spawnSync("cc", [
          "-arch",
          slice,
          "-o",
          join(folder, "whisper-server"),
          join(root, "main.c"),
        ]),
      )
      if (made.status !== 0) throw new Error(`cc -arch ${slice} failed: ${made.stderr}`)
      symlinkSync("whisper-server", join(folder, "server"))
    }
    timed("lipo -archs", () => output("lipo", ["-archs", join(root, slices[0]!, "whisper-server")]))
  }, 180_000)

  it("makes each binary universal, keeps its mode, and keeps each link a link", async () => {
    const staging = join(root, "staging")
    await merge(
      slices.map((slice) => ({ slice, folder: join(root, slice) })),
      staging,
      commands("voice engine", root),
    )
    expect(
      output("lipo", ["-archs", join(staging, "whisper-server")])
        .trim()
        .split(" ")
        .toSorted(),
    ).toEqual(slices)
    expect(statSync(join(staging, "whisper-server")).mode & 0o111).not.toBe(0)
    expect(readlinkSync(join(staging, "server"))).toBe("whisper-server")
  })
})
