/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import {
  checksumOf,
  downloadChecked,
  hashFile,
  listedChecksum,
  portableAssets,
  streamToFile,
  type Fetched,
} from "./release-download"

const sha = (text: string): string => createHash("sha256").update(text).digest("hex")

const sums = [
  `${sha("appimage")}  ${portableAssets.linux}`,
  `${sha("zip")} *${portableAssets.win32}`,
  `${sha("mac")}  ${portableAssets.darwin}`,
  `${sha("shell")}  install.sh`,
  "",
].join("\n")

describe("the checksums a release lists", () => {
  it("names the SHA-256 of a file in sha256sum's text and binary forms", () => {
    expect(checksumOf(sums, portableAssets.linux)).toBe(sha("appimage"))
    expect(checksumOf(sums, portableAssets.win32)).toBe(sha("zip"))
    expect(checksumOf(sums.replaceAll("\n", "\r\n"), portableAssets.darwin)).toBe(sha("mac"))
  })

  it("lowercases a hash written in capitals", () => {
    expect(checksumOf(`${sha("a").toUpperCase()}  one.zip`, "one.zip")).toBe(sha("a"))
  })

  it("names nothing for a file that is not listed, or a line that is not a checksum", () => {
    expect(checksumOf(sums, "other.zip")).toBeUndefined()
    expect(checksumOf(`${sha("a").slice(1)}  one.zip`, "one.zip")).toBeUndefined()
    expect(checksumOf(`${sha("a")} one.zip`, "one.zip")).toBeUndefined()
    // A name that merely ends in the file's is another file.
    expect(checksumOf(`${sha("a")}  x-one.zip`, "one.zip")).toBeUndefined()
  })
})

describe("looking a file up in the release's checksums", () => {
  const host = (text: () => Promise<string | undefined>) => {
    const urls: string[] = []
    const logged: string[] = []
    return {
      urls,
      logged,
      host: {
        text: (url: string) => {
          urls.push(url)
          return text()
        },
        log: (message: string) => void logged.push(message),
      },
    }
  }

  it("reads SHA256SUMS beside the file and answers the hash it lists", async () => {
    const { host: found, urls } = host(async () => sums)
    expect(
      await listedChecksum(found, "https://x/r/", portableAssets.linux, "the AppImage"),
    ).toEqual({
      kind: "listed",
      sha256: sha("appimage"),
    })
    expect(urls).toEqual(["https://x/r/SHA256SUMS"])
  })

  it("fails, saying so, when the release has no checksums or does not list the file", async () => {
    const none = host(async () => undefined)
    expect(await listedChecksum(none.host, "https://x/r/", "a", "the AppImage")).toEqual({
      kind: "failed",
      reason: "The release has no checksums to check the AppImage against.",
    })
    const unlisted = host(async () => sums)
    expect(await listedChecksum(unlisted.host, "https://x/r/", "a", "the AppImage")).toEqual({
      kind: "failed",
      reason: "The release does not list the AppImage.",
    })
  })

  it("fails, logging why, when the network does", async () => {
    const down = host(async () => {
      throw new TypeError("fetch failed")
    })
    expect(await listedChecksum(down.host, "https://x/r/", "a", "the AppImage")).toEqual({
      kind: "failed",
      reason: "The release could not be fetched. Are you online?",
    })
    expect(down.logged).toEqual(["The release's checksums could not be fetched."])
  })
})

describe("downloading a file the release vouches for", () => {
  const hosting = (got: () => Promise<string>) => {
    const removed: string[] = []
    const progress: number[] = []
    return {
      removed,
      progress,
      host: {
        download: async (
          _url: string,
          _file: string,
          _max: number,
          tell: (percent: number) => void,
        ) => {
          tell(50)
          return got()
        },
        remove: async (file: string) => void removed.push(file),
        log: () => {},
      },
    }
  }
  const asked = (progress: number[]) => ({
    url: "https://x/r/a.zip",
    file: "/t/a.zip",
    sha256: sha("zip"),
    what: "the portable copy",
    progress: (percent: number) => void progress.push(percent),
  })

  it("keeps a file that matches", async () => {
    const { host, removed, progress } = hosting(async () => sha("zip"))
    expect(await downloadChecked(host, asked(progress))).toEqual({ kind: "ready" })
    expect(removed).toEqual([])
    expect(progress).toEqual([50])
  })

  it("discards a file that does not match, and says so", async () => {
    const { host, removed, progress } = hosting(async () => sha("other"))
    expect(await downloadChecked(host, asked(progress))).toEqual({
      kind: "failed",
      reason: "The downloaded portable copy did not match the release, so it was discarded.",
    })
    expect(removed).toEqual(["/t/a.zip"])
  })

  it("fails when the download does, leaving no file", async () => {
    const { host, removed, progress } = hosting(async () => {
      throw new Error("The download answered 500.")
    })
    expect(await downloadChecked(host, asked(progress))).toEqual({
      kind: "failed",
      reason: "The portable copy could not be downloaded. Are you online?",
    })
    expect(removed).toEqual(["/t/a.zip"])
  })
})

describe("streaming a download into a file", () => {
  const body = (...chunks: string[]): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield new TextEncoder().encode(chunk)
    },
  })
  const response = (
    chunks: AsyncIterable<Uint8Array> | null,
    length?: number,
    status = 200,
  ): Fetched => ({
    ok: status === 200,
    status,
    body: chunks,
    headers: { get: (name) => (name === "content-length" && length ? String(length) : null) },
  })
  const run = (
    answer: () => Promise<Fetched>,
    options: { maxBytes?: number; size?: number; stallMs?: number } = {},
  ) => {
    const written: string[] = []
    const events: string[] = []
    const percents: number[] = []
    const result = streamToFile({
      url: "https://x/a",
      file: "/t/a",
      maxBytes: options.maxBytes ?? 100,
      ...(options.stallMs ? { stallMs: options.stallMs } : {}),
      size: options.size,
      digest: { algorithm: "sha256", encoding: "hex" },
      progress: (percent) => void percents.push(percent),
      fetch: async () => answer(),
      open: async () => ({
        write: async (chunk) => void written.push(new TextDecoder().decode(chunk)),
        close: async () => void events.push("closed"),
      }),
      remove: async () => void events.push("removed"),
    })
    return { result, written, events, percents }
  }

  it("writes what arrives, answers its digest and tells the whole percent along", async () => {
    const { result, written, events, percents } = run(async () => response(body("ab", "cd"), 4))
    expect(await result).toBe(sha("abcd"))
    expect(written).toEqual(["ab", "cd"])
    expect(events).toEqual(["closed"])
    expect(percents).toEqual([50, 100])
  })

  it("measures against the release's size before the response's", async () => {
    const { result, percents } = run(async () => response(body("ab", "cd"), 400), { size: 4 })
    await result
    expect(percents).toEqual([50, 100])
  })

  it("tells no percent without a total", async () => {
    const { result, percents } = run(async () => response(body("ab")))
    await result
    expect(percents).toEqual([])
  })

  it("removes the file when the answer is not a success, the body too long, or the fetch fails", async () => {
    for (const answer of [
      async () => response(null, undefined, 404),
      async () => response(body("x".repeat(101))),
      async () => {
        throw new TypeError("fetch failed")
      },
    ]) {
      const { result, events } = run(answer)
      await expect(result).rejects.toThrow()
      expect(events).toEqual(["closed", "removed"])
    }
  })

  describe("when no data comes", () => {
    beforeEach(() => void vi.useFakeTimers())
    afterEach(() => void vi.useRealTimers())

    it("gives up after the stall time, and not before", async () => {
      let signal: AbortSignal | undefined
      const events: string[] = []
      const result = streamToFile({
        url: "https://x/a",
        file: "/t/a",
        maxBytes: 100,
        stallMs: 1_000,
        digest: { algorithm: "sha256", encoding: "hex" },
        progress: () => {},
        fetch: (_url, init) => {
          signal = init.signal
          return new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          )
        },
        open: async () => ({
          write: async () => {},
          close: async () => void events.push("closed"),
        }),
        remove: async () => void events.push("removed"),
      })
      const failed = expect(result).rejects.toThrow("aborted")
      await vi.advanceTimersByTimeAsync(999)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      await failed
      expect(events).toEqual(["closed", "removed"])
    })
  })
})

describe("the SHA-256 of a file", () => {
  let folder: string
  beforeEach(async () => void (folder = await mkdtemp(join(tmpdir(), "novadeck-test-"))))
  afterEach(() => rm(folder, { recursive: true, force: true }))

  it("is what sha256sum would list", async () => {
    await writeFile(join(folder, "a"), "appimage")
    expect(await hashFile(join(folder, "a"))).toBe(sha("appimage"))
  })
})
