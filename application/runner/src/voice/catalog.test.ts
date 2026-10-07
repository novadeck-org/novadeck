import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { engineArchive, folder } from "../testing/voice.js"
import { catalog, readManifest, recommend } from "./catalog.js"

describe("the voice catalog", () => {
  it("pins every download by commit and checksum", () => {
    for (const artifact of [...Object.values(catalog.models), catalog.vad]) {
      expect(artifact.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//)
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe("the engine manifest", () => {
  it("reads the file name, checksum and size of the archive", async ({ resources }) => {
    const path = await engineArchive(resources)

    await expect(readManifest(path)).resolves.toMatchObject({ file: "engine.tar.gz" })
  })

  it("takes the first interface for a manifest that names none", async ({ resources }) => {
    const path = await engineArchive(resources)
    const named = await engineArchive(resources, "2", { interface: 2 })

    await expect(readManifest(path)).resolves.toMatchObject({ interface: 1 })
    await expect(readManifest(named)).resolves.toMatchObject({ interface: 2 })
  })

  it("is nothing for an interface that is not a positive whole number", async ({ resources }) => {
    const zero = await engineArchive(resources, "1", { interface: 0 })
    const half = await engineArchive(resources, "2", { interface: 1.5 })

    await expect(readManifest(zero)).resolves.toBeUndefined()
    await expect(readManifest(half)).resolves.toBeUndefined()
  })

  it("is nothing where there is no manifest, or one that makes no sense", async ({ resources }) => {
    const directory = await folder(resources)
    const bad = join(directory, "bad.json")
    await writeFile(bad, JSON.stringify({ file: "../elsewhere", sha256: "0".repeat(64), size: 1 }))
    const torn = join(directory, "torn.json")
    await writeFile(torn, "{")

    await expect(readManifest(undefined)).resolves.toBeUndefined()
    await expect(readManifest(join(directory, "missing.json"))).resolves.toBeUndefined()
    await expect(readManifest(bad)).resolves.toBeUndefined()
    await expect(readManifest(torn)).resolves.toBeUndefined()
  })
})

describe("the recommended model", () => {
  it("is turbo for a GPU that does the test clip in four seconds", () => {
    expect(recommend({ gpu: true, milliseconds: 4000 })).toBe("turbo")
  })

  it("is small for a GPU that is slower than that", () => {
    expect(recommend({ gpu: true, milliseconds: 4001 })).toBe("small")
  })

  it("is small without a GPU, however quick", () => {
    expect(recommend({ gpu: false, milliseconds: 100 })).toBe("small")
  })
})
