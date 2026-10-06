import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll } from "vitest"

import { describe, expect, it } from "../test.js"
import { folder, sha256 } from "../testing/voice.js"
import { download, DownloadError, locate } from "./download.js"

const data = Buffer.from("a model, more or less".repeat(1000))
const server = setupServer(
  http.get("https://models.test/model.bin", () => new HttpResponse(data)),
  http.get("https://models.test/missing.bin", () => new HttpResponse(null, { status: 404 })),
  http.get("https://models.test/down.bin", () => HttpResponse.error()),
)
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const fetchTo = async (
  from: string,
  to: string,
  expected: string,
  signal = new AbortController().signal,
) => {
  const progress: number[] = []
  await download({ from, to, sha256: expected, signal, progress: (n) => progress.push(n) })
  return progress
}

describe("downloading a file", () => {
  it("saves what arrives once its checksum matches, reporting the bytes so far", async ({
    resources,
  }) => {
    const to = join(await folder(resources), "models", "model.bin")

    const progress = await fetchTo("https://models.test/model.bin", to, sha256(data))

    await expect(readFile(to)).resolves.toEqual(data)
    expect(progress.at(-1)).toBe(data.length)
    expect(await readdir(join(to, ".."))).toEqual(["model.bin"])
  })

  it("leaves nothing when the checksum is not the one expected", async ({ resources }) => {
    const to = join(await folder(resources), "model.bin")

    await expect(fetchTo("https://models.test/model.bin", to, sha256("other"))).rejects.toThrow(
      "damaged",
    )

    expect(await readdir(join(to, ".."))).toEqual([])
  })

  it("explains a server that refuses", async ({ resources }) => {
    const to = join(await folder(resources), "model.bin")

    await expect(fetchTo("https://models.test/missing.bin", to, sha256(data))).rejects.toThrow(
      "models.test answered 404",
    )
  })

  it("explains a server that cannot be reached", async ({ resources }) => {
    const to = join(await folder(resources), "model.bin")

    await expect(fetchTo("https://models.test/down.bin", to, sha256(data))).rejects.toThrow(
      DownloadError,
    )
  })

  it("stops when aborted, leaving no part", async ({ resources }) => {
    const directory = await folder(resources)
    const controller = new AbortController()
    controller.abort()

    await expect(
      fetchTo(
        "https://models.test/model.bin",
        join(directory, "model.bin"),
        sha256(data),
        controller.signal,
      ),
    ).rejects.toThrow()

    expect(await readdir(directory)).toEqual([])
  })

  it("copies a local file the same way, checking it too", async ({ resources }) => {
    const directory = await folder(resources)
    await mkdir(join(directory, "from"))
    const from = join(directory, "from", "engine.bin")
    await writeFile(from, data)

    await fetchTo(from, join(directory, "to", "engine.bin"), sha256(data))
    await expect(fetchTo(from, join(directory, "to", "bad.bin"), sha256("other"))).rejects.toThrow(
      "damaged",
    )

    await expect(readFile(join(directory, "to", "engine.bin"))).resolves.toEqual(data)
    expect(await readdir(join(directory, "to"))).toEqual(["engine.bin"])
  })
})

describe("where a file is found", () => {
  it("is under a URL ending in a slash, or in a folder", () => {
    expect(locate("https://downloads.test/voice/", "engine 1.tar.gz")).toBe(
      "https://downloads.test/voice/engine%201.tar.gz",
    )
    expect(locate(join("data", "voice"), "engine.tar.gz")).toBe(
      join("data", "voice", "engine.tar.gz"),
    )
  })
})
