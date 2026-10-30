/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { describe, expect, it } from "../../test"
import { prepareAppImage, type AppImageHost } from "./appimage"
import { portableAssets } from "./download"

const own = "https://x/download/v0.4.2/"
const latest = "https://x/latest/download/"
const offered = "https://x/download/v0.5.0/"
const sums = (hash: string) => `${hash}  ${portableAssets.linux}\n`

const hosting = (
  files: Record<string, string | undefined>,
  options: {
    downloads?: Partial<AppImageHost["downloads"]>
    got?: string
    fail?: boolean
    version?: string
  } = {},
) => {
  const calls: string[] = []
  const progress: number[] = []
  const host: AppImageHost = {
    downloads: { offered: undefined, latest, own, ...options.downloads },
    version: options.version ?? "0.4.2",
    text: async (url) => {
      calls.push(`text ${url}`)
      if (!(url in files)) throw new TypeError("fetch failed")
      return files[url]
    },
    download: async (url, file, _max, tell) => {
      calls.push(`download ${url} -> ${file}`)
      if (options.fail) throw new Error("The download answered 500.")
      tell(60)
      return options.got ?? "a".repeat(64)
    },
    remove: async (file) => void calls.push(`remove ${file}`),
    makeExecutable: async (file) => void calls.push(`chmod ${file}`),
    progress: (percent) => void progress.push(percent),
    log: () => {},
  }
  return { host, calls, progress }
}

const latestYml = (version: string) => `version: ${version}\n`
const good = "a".repeat(64)

describe("getting the release's AppImage for an install", () => {
  it("takes the version the update offer named, whatever the latest release is", async () => {
    const { host, calls, progress } = hosting(
      { [`${offered}SHA256SUMS`]: sums(good) },
      { downloads: { offered } },
    )
    expect(await prepareAppImage(host, "/t/app")).toEqual({ kind: "ready", file: "/t/app" })
    expect(calls).toEqual([
      `text ${offered}SHA256SUMS`,
      `download ${offered}${portableAssets.linux} -> /t/app`,
      "chmod /t/app",
    ])
    expect(progress).toEqual([60])
  })

  it("takes the latest release without an offer, when it is not older than this copy", async () => {
    const { host, calls } = hosting({
      [`${latest}latest-linux.yml`]: latestYml("0.5.0"),
      [`${latest}SHA256SUMS`]: sums(good),
    })
    expect(await prepareAppImage(host, "/t/app")).toEqual({ kind: "ready", file: "/t/app" })
    expect(calls[2]).toBe(`download ${latest}${portableAssets.linux} -> /t/app`)
  })

  it("takes this copy's own release when the latest is older, or there is no stable release", async () => {
    for (const yml of [latestYml("0.4.0"), undefined]) {
      const { host, calls } = hosting({
        [`${latest}latest-linux.yml`]: yml,
        [`${own}SHA256SUMS`]: sums(good),
      })
      expect(await prepareAppImage(host, "/t/app")).toEqual({ kind: "ready", file: "/t/app" })
      expect(calls.at(-2)).toBe(`download ${own}${portableAssets.linux} -> /t/app`)
    }
  })

  it("fails, without guessing another release, when the latest can't be fetched", async () => {
    const { host } = hosting({})
    expect(await prepareAppImage(host, "/t/app")).toEqual({
      kind: "failed",
      reason: "The latest release could not be fetched. Are you online?",
    })
  })

  it("fails for a copy that does not know where Novadeck is released", async () => {
    const { host } = hosting({}, { downloads: { latest: undefined, own: undefined } })
    expect(await prepareAppImage(host, "/t/app")).toMatchObject({ kind: "failed" })
  })

  it("fails when the release does not list the AppImage or has no checksums", async () => {
    const unlisted = hosting({ [`${offered}SHA256SUMS`]: "" }, { downloads: { offered } })
    expect(await prepareAppImage(unlisted.host, "/t/app")).toEqual({
      kind: "failed",
      reason: "The release does not list the AppImage.",
    })
    const none = hosting({ [`${offered}SHA256SUMS`]: undefined }, { downloads: { offered } })
    expect(await prepareAppImage(none.host, "/t/app")).toMatchObject({ kind: "failed" })
    expect(none.calls.some((call) => call.startsWith("download"))).toBe(false)
  })

  it("discards a file that does not match, rather than install it or this copy instead", async () => {
    const { host, calls } = hosting(
      { [`${offered}SHA256SUMS`]: sums(good) },
      { downloads: { offered }, got: "b".repeat(64) },
    )
    expect(await prepareAppImage(host, "/t/app")).toEqual({
      kind: "failed",
      reason: "The downloaded AppImage did not match the release, so it was discarded.",
    })
    expect(calls).toContain("remove /t/app")
    expect(calls).not.toContain("chmod /t/app")
  })

  it("fails, asking if the person is online, when the download does", async () => {
    const { host } = hosting(
      { [`${offered}SHA256SUMS`]: sums(good) },
      { downloads: { offered }, fail: true },
    )
    expect(await prepareAppImage(host, "/t/app")).toEqual({
      kind: "failed",
      reason: "The AppImage could not be downloaded. Are you online?",
    })
  })
})
