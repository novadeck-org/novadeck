import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { engineArchive, folder } from "../testing/engines.js"
import {
  engineFolder,
  engineInterface,
  enginesIn,
  olderEngine,
  programFile,
  unpack,
} from "./unpack.js"

// Not whisper's: nothing here is specific to one engine.
const program = programFile("llama-server")

describe("unpacking the engine", () => {
  it("puts the archive's files in a folder named by its checksum, and removes older engines", async ({
    resources,
  }) => {
    const manifest = join(
      await engineArchive(resources, program, { extras: { "check.wav": "clip" } }),
    )
    const archive = join(manifest, "..", "engine.tar.gz")
    const directory = await folder(resources)
    const older = join(enginesIn(directory), "0123456789ab")
    await mkdir(older, { recursive: true })

    const target = await unpack(archive, directory, "f".repeat(64), 2, program)

    expect(target).toBe(engineFolder(directory, "f".repeat(64)))
    expect((await readdir(target)).toSorted()).toEqual([
      ".interface",
      "LICENSE",
      "check.wav",
      program,
    ])
    expect(await readdir(enginesIn(directory))).toEqual(["ffffffffffff"])
  })

  it("marks the folder with the interface it was unpacked for", async ({ resources }) => {
    const archive = join(
      await engineArchive(resources, program, { extras: { "check.wav": "clip" } }),
      "..",
      "engine.tar.gz",
    )
    const directory = await folder(resources)
    const bare = join(directory, "bare")
    await mkdir(bare)
    const torn = join(directory, "torn")
    await mkdir(torn)
    await writeFile(join(torn, ".interface"), "two")
    const unreadable = join(directory, "unreadable")
    await mkdir(join(unreadable, ".interface"), { recursive: true })

    const target = await unpack(archive, directory, "c".repeat(64), 3, program)

    await expect(engineInterface(target)).resolves.toBe(3)
    await expect(engineInterface(bare)).resolves.toBe(0)
    await expect(engineInterface(torn)).resolves.toBe(0)
    await expect(engineInterface(unreadable)).resolves.toBe(0)
  })

  it("fails in words for a file that is not an archive, leaving no folder behind", async ({
    resources,
  }) => {
    const directory = await folder(resources)
    const archive = join(directory, "engine.tar.gz")
    await writeFile(archive, "not an archive")

    await expect(unpack(archive, directory, "a".repeat(64), 1, program)).rejects.toThrow(
      "Could not unpack the engine",
    )

    expect(await readdir(enginesIn(directory))).toEqual([])
  })
})

describe("an older engine", () => {
  it("is the first unpacked one that has the program and a marker for the wanted interface", async ({
    resources,
  }) => {
    const directory = await folder(resources)
    const root = enginesIn(directory)
    const make = async (name: string, files: Record<string, string>) => {
      await mkdir(join(root, name), { recursive: true })
      await Promise.all(
        Object.entries(files).map(([file, text]) => writeFile(join(root, name, file), text)),
      )
    }
    await make("0000", { [program]: "" })
    await make("0001", { [program]: "", ".interface": "1\n" })
    await make("1111", { [program]: "", ".interface": "2\n" })
    await make("2222", { ".interface": "2\n" })
    await make(".unpacking-x", { [program]: "", ".interface": "2\n" })

    await expect(olderEngine(directory, program, 2)).resolves.toBe(join(root, "1111"))
    await expect(olderEngine(directory, program, 1)).resolves.toBe(join(root, "0001"))
    await expect(olderEngine(directory, program, 3)).resolves.toBeUndefined()
    await expect(olderEngine(join(directory, "none"), program, 1)).resolves.toBeUndefined()
  })
})
