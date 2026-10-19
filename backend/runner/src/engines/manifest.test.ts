import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { engineArchive, folder } from "../testing/engines.js"
import { readManifest } from "./manifest.js"

const program = "llama-server"

describe("the engine manifest", () => {
  it("reads the file name, checksum and size of the archive", async ({ resources }) => {
    const path = await engineArchive(resources, program)

    await expect(readManifest(path)).resolves.toMatchObject({ file: "engine.tar.gz" })
  })

  it("reads the interface, which a manifest must name", async ({ resources }) => {
    const named = await engineArchive(resources, program, {
      release: "2",
      fields: { interface: 2 },
    })
    const directory = await folder(resources)
    const none = join(directory, "none.json")
    await writeFile(
      none,
      JSON.stringify({ file: "engine.tar.gz", sha256: "0".repeat(64), size: 1 }),
    )

    await expect(readManifest(named)).resolves.toMatchObject({ interface: 2 })
    await expect(readManifest(none)).resolves.toBeUndefined()
  })

  it("is nothing for an interface that is not a positive whole number", async ({ resources }) => {
    const zero = await engineArchive(resources, program, { fields: { interface: 0 } })
    const half = await engineArchive(resources, program, {
      release: "2",
      fields: { interface: 1.5 },
    })

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
