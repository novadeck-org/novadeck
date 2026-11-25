import { spawnSync } from "node:child_process"
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll } from "vitest"

import { describe, expect, it } from "../test.js"
import { folder, sha256 } from "../testing/engines.js"
import type { Resources } from "../testing/resources.js"
import {
  buildFolder,
  buildFor,
  bundledPiFolder,
  bundledPiHome,
  bundledPiProgram,
  fetchBundledPi,
  pinnedPi,
  progressLine,
  type PinnedPi,
} from "./pi.js"

const licenceText = "MIT License\n\nCopyright (c) pi's authors\n"

/**
 * A release of a fake pi in a new folder, as pi publishes one for Linux: `pi-linux-x64.tar.gz`,
 * holding `pi/pi` and an asset beside it, with the pin naming it and the licence beside it.
 * `contents` says what the program file holds, so two releases differ.
 */
const fakeRelease = async (
  resources: Resources,
  contents = "#!/bin/sh\necho pi\n",
  version = "1.6.0",
): Promise<{ source: string; pinned: PinnedPi; licence: string }> => {
  const directory = await folder(resources)
  const tree = join(directory, "tree")
  await mkdir(join(tree, "pi"), { recursive: true })
  await writeFile(join(tree, "pi", "pi"), contents)
  await writeFile(join(tree, "pi", "photon_rs_bg.wasm"), "wasm")
  const file = "pi-linux-x64.tar.gz"
  const packed = spawnSync("tar", ["-czf", join(directory, file), "-C", tree, "pi"])
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr.toString()}`)
  const archive = await readFile(join(directory, file))
  const licence = join(directory, "LICENSE")
  await writeFile(licence, licenceText)
  return {
    source: directory,
    licence,
    pinned: {
      version,
      source: "https://release.test/",
      builds: {
        "linux-x64": { file, sha256: sha256(archive), size: archive.length, program: "pi/pi" },
      },
      licence: {
        url: "https://release.test/LICENSE",
        sha256: sha256(licenceText),
        size: licenceText.length,
      },
    },
  }
}

const linux = { platform: "linux", arch: "x64" } as const

describe("the pinned pi", () => {
  it("names a build, with its checksum, for every system Novadeck ships for", () => {
    for (const system of ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
      const [platform = "", arch = ""] = system.split("-")
      const build = buildFor(platform as NodeJS.Platform, arch)
      expect(build?.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(build?.file).toMatch(/^pi-(linux|darwin|windows)-(x64|arm64)\.(tar\.gz|zip)$/)
    }
    expect(buildFor("win32", "x64")?.program).toBe("pi.exe")
    expect(buildFor("darwin", "arm64")?.program).toBe("pi/pi")
    expect(buildFor("freebsd", "x64")).toBeUndefined()
    expect(pinnedPi.source).toContain(`/v${pinnedPi.version}/`)
  })

  it("lives in Novadeck's data folder, its agent folder apart from its builds", () => {
    const build = buildFor("linux", "x64")
    if (!build) throw new Error("no Linux build")
    expect(bundledPiFolder("/data")).toBe(join("/data", "bundled", "pi"))
    expect(bundledPiHome("/data")).toBe(join("/data", "bundled", "pi", "agent"))
    expect(bundledPiProgram("/data", build)).toBe(
      join("/data", "bundled", "pi", `1.6.0-${build.sha256.slice(0, 12)}`, "pi", "pi"),
    )
  })

  it("says a download's progress in megabytes and whole percent", () => {
    expect(progressLine("1.6.0", 12_345_678, 58_977_130)).toBe(
      "Downloading pi 1.6.0: 12.3 of 59.0 MB (20%)",
    )
  })
})

describe("fetching Novadeck's pi", () => {
  it("downloads, checks and unpacks the build for this system, with pi's licence beside it", async ({
    resources,
  }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const lines: string[] = []

    const program = await fetchBundledPi({
      data,
      ...linux,
      ...release,
      progress: (line) => lines.push(line),
    })

    const build = release.pinned.builds["linux-x64"]
    if (!build) throw new Error("no build")
    expect(program).toBe(bundledPiProgram(data, build, "1.6.0"))
    await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    expect((await stat(program)).mode & 0o111).not.toBe(0)
    const target = buildFolder(data, build, "1.6.0")
    await expect(readFile(join(target, "LICENSE"), "utf8")).resolves.toBe(licenceText)
    await expect(readFile(join(target, "pi", "photon_rs_bg.wasm"), "utf8")).resolves.toBe("wasm")
    // Nothing is left of the download or the unpacking.
    expect(await readdir(bundledPiFolder(data))).toEqual([target.split(/[\\/]/).at(-1)])
    expect(lines.at(0)).toMatch(/^Downloading pi 1\.6\.0: /)
    expect(lines.at(-2)).toMatch(/\(100%\)$/)
    expect(lines.at(-1)).toBe("Unpacking pi 1.6.0")
  })

  it("starts the copy in place without downloading", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const first = await fetchBundledPi({ data, ...linux, ...release })
    const lines: string[] = []

    // A source that holds nothing: a download would fail.
    const again = await fetchBundledPi({
      data,
      ...linux,
      ...release,
      source: await folder(resources),
      progress: (line) => lines.push(line),
    })

    expect(again).toBe(first)
    expect(lines).toEqual([])
  })

  it("shares one fetch between launches waiting at once", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const second: string[] = []

    const [a, b] = await Promise.all([
      fetchBundledPi({ data, ...linux, ...release }),
      fetchBundledPi({ data, ...linux, ...release, progress: (line) => second.push(line) }),
    ])

    expect(a).toBe(b)
    // It hears the shared fetch's progress from then on.
    expect(second.at(0)).toBe("Waiting for pi 1.6.0, which is downloading")
    expect(second.at(-1)).toBe("Unpacking pi 1.6.0")
  })

  it("refuses an archive whose checksum isn't the pinned one, and leaves nothing", async ({
    resources,
  }) => {
    const release = await fakeRelease(resources)
    const tampered = await fakeRelease(resources, "#!/bin/sh\necho not pi\n")
    const data = await folder(resources)

    await expect(
      fetchBundledPi({ data, ...linux, ...release, source: tampered.source }),
    ).rejects.toThrow(/damaged|larger than expected/)

    expect(await readdir(bundledPiFolder(data))).toEqual([])
  })

  it("refuses a licence whose checksum isn't the pinned one", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const other = join(await folder(resources), "LICENSE")
    await writeFile(other, "Some other licence")

    await expect(fetchBundledPi({ data, ...linux, ...release, licence: other })).rejects.toThrow(
      "damaged",
    )
    expect(await readdir(bundledPiFolder(data))).toEqual([])
  })

  it("fetches again over what a broken download or unpacking left", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const build = release.pinned.builds["linux-x64"]
    if (!build) throw new Error("no build")
    const pi = bundledPiFolder(data)
    // A download cut short, and an unpacking that never finished.
    await mkdir(join(pi, "downloads"), { recursive: true })
    await writeFile(join(pi, "downloads", `${build.file}.part`), "half")
    await mkdir(join(pi, ".unpacking-0000"), { recursive: true })

    const program = await fetchBundledPi({ data, ...linux, ...release })

    await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    expect(await readdir(pi)).toEqual([buildFolder(data, build, "1.6.0").split(/[\\/]/).at(-1)])
  })

  it("replaces an earlier pinned version, keeping the agent folder", async ({ resources }) => {
    const older = await fakeRelease(resources, "#!/bin/sh\necho old\n", "1.5.0")
    const newer = await fakeRelease(resources)
    const data = await folder(resources)
    await fetchBundledPi({ data, ...linux, ...older })
    await mkdir(bundledPiHome(data), { recursive: true })
    await writeFile(join(bundledPiHome(data), "settings.json"), "{}")

    const program = await fetchBundledPi({ data, ...linux, ...newer })

    await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    const build = newer.pinned.builds["linux-x64"]
    if (!build) throw new Error("no build")
    expect((await readdir(bundledPiFolder(data))).toSorted()).toEqual(
      ["agent", buildFolder(data, build, "1.6.0").split(/[\\/]/).at(-1)].toSorted(),
    )
    await expect(readFile(join(bundledPiHome(data), "settings.json"), "utf8")).resolves.toBe("{}")
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the new build where an earlier one can't be removed yet",
    async ({ resources }) => {
      const older = await fakeRelease(resources, "#!/bin/sh\necho old\n", "1.5.0")
      const newer = await fakeRelease(resources)
      const data = await folder(resources)
      const old = await fetchBundledPi({ data, ...linux, ...older })
      // As a pi still running from it holds its folder on Windows: here, a folder in it that
      // can't be emptied.
      const locked = join(old, "..", "locked")
      await mkdir(join(locked, "inside"), { recursive: true })
      await chmod(locked, 0o500)
      resources.defer(() => chmod(locked, 0o700))

      const program = await fetchBundledPi({ data, ...linux, ...newer })

      await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    },
  )

  it("refuses a system pi has no build for", async ({ resources }) => {
    await expect(
      fetchBundledPi({ data: await folder(resources), platform: "freebsd", arch: "x64" }),
    ).rejects.toThrow("pi has no build for this system (freebsd-x64).")
  })
})

describe("fetching Novadeck's pi over the network", () => {
  const server = setupServer(
    http.get("https://release.test/stall/pi-linux-x64.tar.gz", () => {
      // Headers, then nothing.
      const body = new ReadableStream({ start: () => {} })
      return new HttpResponse(body)
    }),
    http.get("https://release.test/down/pi-linux-x64.tar.gz", () => HttpResponse.error()),
    http.get("https://release.test/counted/pi-linux-x64.tar.gz", () => {
      archives += 1
      return HttpResponse.error()
    }),
    http.get("https://licence.test/LICENSE", () => HttpResponse.error()),
  )
  let archives = 0
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it("says the connection is down when the release can't be reached", async ({ resources }) => {
    const release = await fakeRelease(resources)

    await expect(
      fetchBundledPi({
        data: await folder(resources),
        ...linux,
        ...release,
        source: "https://release.test/down/",
      }),
    ).rejects.toThrow("Could not reach release.test. Check the connection.")
  })

  it("fetches the licence first, and no archive where it can't be had", async ({ resources }) => {
    const release = await fakeRelease(resources)

    await expect(
      fetchBundledPi({
        data: await folder(resources),
        ...linux,
        ...release,
        source: "https://release.test/counted/",
        licence: "https://licence.test/LICENSE",
      }),
    ).rejects.toThrow("Could not reach licence.test.")
    expect(archives).toBe(0)
  })

  it("gives up on a download that stalls", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)

    await expect(
      fetchBundledPi({
        data,
        ...linux,
        ...release,
        source: "https://release.test/stall/",
        stallMs: 200,
      }),
    ).rejects.toThrow("The download stalled")
    expect(await readdir(bundledPiFolder(data))).toEqual([])
  })
})
