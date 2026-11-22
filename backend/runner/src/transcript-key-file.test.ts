import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Log } from "@novadeck/log"

import { describe, expect, it } from "./test.js"
import { loadTranscriptKeyFile } from "./transcript-key-file.js"

/** A log that keeps each line's event, as `level event`. */
const recording = () => {
  const lines: string[] = []
  const log = new Proxy({} as Log, {
    get:
      (_, level: string) =>
      (event: string): void => {
        lines.push(`${level} ${event}`)
      },
  })
  return { lines, log }
}

const folder = async (resources: { defer(release: () => Promise<void>): void }) => {
  const directory = await mkdtemp(join(tmpdir(), "novadeck-key-"))
  resources.defer(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const posix = process.platform !== "win32"

describe("a standalone runner's transcript key file", () => {
  it("is made where missing, readable only by its owner, and the same key next time", async ({
    resources,
  }) => {
    const path = join(await folder(resources), "data", "transcript.key")
    const { lines, log } = recording()

    const made = await loadTranscriptKeyFile({ path, platform: process.platform, log })
    expect(made).toHaveLength(32)
    expect((await readFile(path, "utf8")).trim()).toBe(Buffer.from(made ?? []).toString("base64"))
    if (posix) expect((await stat(path)).mode & 0o777).toBe(0o600)
    // Linked into place whole: no temporary file is left beside it.
    expect(await readdir(join(path, ".."))).toEqual(["transcript.key"])

    const again = await loadTranscriptKeyFile({ path, platform: process.platform, log })
    expect(Buffer.from(again ?? []).equals(Buffer.from(made ?? []))).toBe(true)
    expect(lines).toEqual([
      "info transcript-key.created",
      "info transcript-key.loaded",
      "info transcript-key.loaded",
    ])
  })

  it("reads a key the person made, as `openssl rand -base64 32` prints it", async ({
    resources,
  }) => {
    const path = join(await folder(resources), "transcript.key")
    const key = Buffer.alloc(32, 7)
    await writeFile(path, `${key.toString("base64")}\n`, { mode: 0o600 })
    const loaded = await loadTranscriptKeyFile({
      path,
      platform: process.platform,
      log: recording().log,
    })
    expect(Buffer.from(loaded ?? []).equals(key)).toBe(true)
  })

  it("leaves a file holding no key as it is, and keeps no transcripts", async ({ resources }) => {
    const path = join(await folder(resources), "transcript.key")
    await writeFile(path, "not a key\n", { mode: 0o600 })
    const { lines, log } = recording()

    expect(await loadTranscriptKeyFile({ path, platform: process.platform, log })).toBeNull()
    expect(await readFile(path, "utf8")).toBe("not a key\n")
    expect(lines).toEqual(["warn transcript-key.invalid"])
  })

  it.runIf(posix)(
    "uses a key other users can read, as a Docker secret, and warns",
    async ({ resources }) => {
      const path = join(await folder(resources), "transcript.key")
      await writeFile(path, Buffer.alloc(32, 1).toString("base64"))
      await chmod(path, 0o444)
      const { lines, log } = recording()

      expect(await loadTranscriptKeyFile({ path, platform: process.platform, log })).toHaveLength(
        32,
      )
      expect(lines).toEqual(["warn transcript-key.shared", "info transcript-key.loaded"])
    },
  )

  it("takes the key another runner made meanwhile", async () => {
    const key = Buffer.alloc(32, 9).toString("base64")
    let made = false
    const loaded = await loadTranscriptKeyFile(
      { path: "/data/transcript.key", platform: "linux", log: recording().log },
      {
        readFile: async () => {
          if (!made) throw Object.assign(new Error("missing"), { code: "ENOENT" })
          return Buffer.from(key)
        },
        create: async () => {
          made = true
          throw Object.assign(new Error("exists"), { code: "EEXIST" })
        },
        mode: async () => 0o100600,
      },
    )
    expect(Buffer.from(loaded ?? []).toString("base64")).toBe(key)
  })

  it("keeps no transcripts where the file can't be read or made, and says why", async () => {
    const { lines, log } = recording()
    const denied = () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
    expect(
      await loadTranscriptKeyFile(
        { path: "/data/transcript.key", platform: "linux", log },
        { readFile: denied, create: denied, mode: denied },
      ),
    ).toBeNull()
    expect(lines).toEqual(["warn transcript-key.unavailable"])
  })
})
