import { spawnSync } from "node:child_process"
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

import { turnOnLine } from "@novadeck/harness-nova/launcher"
import {
  buildFolder,
  novaFolder,
  novaHome,
  novaBinary,
  novaSession,
  type PinnedPi,
} from "@novadeck/harness-nova/pin"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll } from "vitest"

import { describe, expect, it } from "../test.js"
import { folder, sha256 } from "../testing/engines.js"
import type { Resources } from "../testing/resources.js"
import { Nova, fetchNova, progressLine } from "./nova.js"

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

const linux = { platform: "linux", arch: "x64", enabled: true } as const

describe("the pinned pi's download", () => {
  it("says a download's progress in megabytes and whole percent", () => {
    expect(progressLine("1.6.0", 12_345_678, 58_977_130)).toBe(
      "Downloading Pi 1.6.0: 12.3 of 59.0 MB (20%)",
    )
  })
})

describe("fetching Nova", () => {
  it("downloads, checks and unpacks the build for this system, with pi's licence beside it", async ({
    resources,
  }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const lines: string[] = []

    const program = await fetchNova({
      data,
      ...linux,
      ...release,
      progress: (line) => lines.push(line),
    })

    const build = release.pinned.builds["linux-x64"]
    if (!build) throw new Error("no build")
    expect(program).toBe(novaBinary(data, build, "1.6.0"))
    await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    // Executable, where the file system keeps the bits.
    if (process.platform !== "win32") expect((await stat(program)).mode & 0o111).not.toBe(0)
    const target = buildFolder(data, build, "1.6.0")
    await expect(readFile(join(target, "LICENSE"), "utf8")).resolves.toBe(licenceText)
    await expect(readFile(join(target, "pi", "photon_rs_bg.wasm"), "utf8")).resolves.toBe("wasm")
    // Nothing is left of the download or the unpacking.
    expect(await readdir(novaFolder(data))).toEqual([target.split(/[\\/]/).at(-1)])
    expect(lines.at(0)).toMatch(/^Downloading Pi 1\.6\.0: /)
    expect(lines.at(-2)).toMatch(/\(100%\)$/)
    expect(lines.at(-1)).toBe("Unpacking Pi 1.6.0")
  })

  it("starts the copy in place without downloading", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const first = await fetchNova({ data, ...linux, ...release })
    const lines: string[] = []

    // A source that holds nothing: a download would fail.
    const again = await fetchNova({
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
      fetchNova({ data, ...linux, ...release }),
      fetchNova({ data, ...linux, ...release, progress: (line) => second.push(line) }),
    ])

    expect(a).toBe(b)
    // It hears the shared fetch's progress from then on.
    expect(second.at(0)).toBe("Waiting for Pi 1.6.0, which is downloading")
    expect(second.at(-1)).toBe("Unpacking Pi 1.6.0")
  })

  it("refuses an archive whose checksum isn't the pinned one, and leaves nothing", async ({
    resources,
  }) => {
    const release = await fakeRelease(resources)
    const tampered = await fakeRelease(resources, "#!/bin/sh\necho not pi\n")
    const data = await folder(resources)

    await expect(
      fetchNova({ data, ...linux, ...release, source: tampered.source }),
    ).rejects.toThrow(/damaged|larger than expected/)

    expect(await readdir(novaFolder(data))).toEqual([])
  })

  it("refuses a licence whose checksum isn't the pinned one", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const other = join(await folder(resources), "LICENSE")
    await writeFile(other, "Some other licence")

    await expect(fetchNova({ data, ...linux, ...release, licence: other })).rejects.toThrow(
      "damaged",
    )
    expect(await readdir(novaFolder(data))).toEqual([])
  })

  it("fetches again over what a broken download or unpacking left", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const build = release.pinned.builds["linux-x64"]
    if (!build) throw new Error("no build")
    const pi = novaFolder(data)
    // A download cut short, and an unpacking that never finished.
    await mkdir(join(pi, "downloads"), { recursive: true })
    await writeFile(join(pi, "downloads", `${build.file}.part`), "half")
    await mkdir(join(pi, ".unpacking-0000"), { recursive: true })

    const program = await fetchNova({ data, ...linux, ...release })

    await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    expect(await readdir(pi)).toEqual([buildFolder(data, build, "1.6.0").split(/[\\/]/).at(-1)])
  })

  it("replaces an earlier pinned version, keeping the agent folder", async ({ resources }) => {
    const older = await fakeRelease(resources, "#!/bin/sh\necho old\n", "1.5.0")
    const newer = await fakeRelease(resources)
    const data = await folder(resources)
    await fetchNova({ data, ...linux, ...older })
    await mkdir(novaHome(data), { recursive: true })
    await writeFile(join(novaHome(data), "settings.json"), "{}")

    const program = await fetchNova({ data, ...linux, ...newer })

    await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    const build = newer.pinned.builds["linux-x64"]
    if (!build) throw new Error("no build")
    expect((await readdir(novaFolder(data))).toSorted()).toEqual(
      ["agent", buildFolder(data, build, "1.6.0").split(/[\\/]/).at(-1)].toSorted(),
    )
    await expect(readFile(join(novaHome(data), "settings.json"), "utf8")).resolves.toBe("{}")
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the new build where an earlier one can't be removed yet",
    async ({ resources }) => {
      const older = await fakeRelease(resources, "#!/bin/sh\necho old\n", "1.5.0")
      const newer = await fakeRelease(resources)
      const data = await folder(resources)
      const old = await fetchNova({ data, ...linux, ...older })
      // As a pi still running from it holds its folder on Windows: here, a folder in it that
      // can't be emptied.
      const locked = join(old, "..", "locked")
      await mkdir(join(locked, "inside"), { recursive: true })
      await chmod(locked, 0o500)
      resources.defer(() => chmod(locked, 0o700))

      const program = await fetchNova({ data, ...linux, ...newer })

      await expect(readFile(program, "utf8")).resolves.toContain("echo pi")
    },
  )

  it("refuses a system pi has no build for", async ({ resources }) => {
    await expect(
      fetchNova({
        data: await folder(resources),
        platform: "freebsd",
        arch: "x64",
        enabled: true,
      }),
    ).rejects.toThrow("Pi has no build for this system (freebsd-x64).")
  })
})

describe("Nova behind its Experimental switch", () => {
  // The service over a fake release, with the switch as `on` says.
  const service = async (resources: Resources, on: { value: boolean }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const states: string[] = []
    const pi = new Nova({
      data,
      enabled: () => on.value,
      env: {
        NOVADECK_NOVA_SOURCE: release.source,
        NOVADECK_NOVA_LICENCE: release.licence,
      },
      platform: "linux",
      arch: "x64",
      pinned: release.pinned,
    })
    pi.follow(() => states.push(pi.state().state))
    return { pi, data, release, states }
  }

  it("fetches nothing while off, and says how to turn it on", async ({ resources }) => {
    const { pi, data, release } = await service(resources, { value: false })

    pi.switched()
    await expect(pi.fetch("nova", () => {})).rejects.toThrow(turnOnLine)
    await expect(fetchNova({ data, ...linux, ...release, enabled: false })).rejects.toThrow(
      "Turn on Nova in Preferences > Experimental.",
    )

    expect(pi.state()).toEqual({ state: "off" })
    expect(await readdir(data)).toEqual([])
  })

  it("starts its fetch as it is switched on, telling where it stands", async ({ resources }) => {
    const on = { value: true }
    const { pi, states } = await service(resources, on)

    pi.switched()
    await expect.poll(() => pi.state().state).toBe("ready")

    expect(states.at(0)).toBe("downloading")
    expect(states.at(-1)).toBe("ready")
    // A launch then starts the copy in place at once.
    await pi.fetch("nova", () => {})
    expect(pi.state()).toEqual({ state: "ready" })
    // Switched off, it stops launches, and keeps the copy.
    on.value = false
    pi.switched()
    expect(pi.state()).toEqual({ state: "off" })
    await expect(pi.fetch("nova", () => {})).rejects.toThrow(turnOnLine)
  })

  it("says why a fetch failed, and tries again as it is switched on again", async ({
    resources,
  }) => {
    const on = { value: true }
    const { pi, release } = await service(resources, on)
    const licence = release.licence
    await writeFile(licence, "Another licence")

    pi.switched()
    await expect.poll(() => pi.state().state).toBe("failed")
    expect(pi.state().error).toContain("damaged")

    await writeFile(licence, licenceText)
    pi.switched()
    await expect.poll(() => pi.state().state).toBe("ready")
  })

  it("tells nothing new for a launch of the copy in place", async ({ resources }) => {
    const { pi, states } = await service(resources, { value: true })
    await pi.fetch("nova", () => {})
    const told = states.length

    await pi.fetch("nova", () => {})
    await pi.fetch("nova", () => {})

    expect(states.length).toBe(told)
    expect(pi.state()).toEqual({ state: "ready" })
  })

  it("gives a launcher's Nova the variables of its host's service, saying why there are none", async ({
    resources,
  }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)
    const env = { NOVADECK_NOVA_BASE_URL: "https://novadeck.dev/nova/v1", NOVADECK_NOVA_KEY: "T1" }
    let refuse = false
    const pi = new Nova({
      data,
      enabled: () => true,
      service: (progress) => {
        if (!refuse) return Promise.resolve(env)
        progress("No ticket today.")
        return Promise.resolve(undefined)
      },
      env: {
        NOVADECK_NOVA_SOURCE: release.source,
        NOVADECK_NOVA_LICENCE: release.licence,
      },
      platform: "linux",
      arch: "x64",
      pinned: release.pinned,
    })
    const said: string[] = []

    await expect(pi.fetch("nova", () => {})).resolves.toEqual(env)
    refuse = true
    await expect(pi.fetch("nova", (line) => said.push(line))).resolves.toBeUndefined()
    expect(said).toContain("No ticket today.")
  })

  it("tells each setting of its switch, which the state doesn't always say", async ({
    resources,
  }) => {
    const lever = { value: true }
    const { pi, states } = await service(resources, lever)
    await pi.ready()
    expect(pi.state().state).toBe("ready")
    const switches: boolean[] = []
    pi.followSwitch(() => switches.push(lever.value))
    const told = states.length
    pi.switched()
    // The state stands ready, so only the switch's own listeners hear of it.
    await expect.poll(() => switches).toEqual([true])
    expect(states.length).toBe(told)
  })

  it("says whether a launcher may start it: while its switch is on", async ({ resources }) => {
    const data = await folder(resources)
    const lever = { value: false }
    const pi = new Nova({ data, enabled: () => lever.value, platform: "freebsd" })

    expect(pi.starts()).toBe(false)
    lever.value = true
    expect(pi.starts()).toBe(true)
  })

  it("fetches Nova alone", async ({ resources }) => {
    const { pi } = await service(resources, { value: true })
    await expect(pi.fetch("claude", () => {})).rejects.toThrow("Novadeck has no claude of its own.")
  })

  it("refuses the tour's ask too while switched off, and gives its program once on", async ({
    resources,
  }) => {
    const lever = { value: false }
    const { pi, data } = await service(resources, lever)
    await expect(pi.ready()).rejects.toThrow(turnOnLine)
    lever.value = true
    await expect(pi.ready()).resolves.toContain(novaFolder(data))
  })

  // POSIX paths: Windows' own are its `join`'s.
  it.skipIf(process.platform === "win32")(
    "tells its own sessions apart from the person's pi's, by their transcript",
    () => {
      const data = "/home/a/.config/novadeck"
      const pi = new Nova({ data, enabled: () => false, platform: "linux" })
      const own = `${novaHome(data)}/sessions/--tour--/2026_s1.jsonl`
      expect(pi.owns("pi", own)).toBe(true)
      expect(pi.owns("pi", "/home/a/.pi/agent/sessions/--tour--/2026_s1.jsonl")).toBe(false)
      expect(pi.owns("pi", `${novaHome(data)}-other/s.jsonl`)).toBe(false)
      expect(pi.owns("pi", undefined)).toBe(false)
      // Another agent's session is never its.
      expect(pi.owns("opencode", own)).toBe(false)
      expect(novaSession(own, data, "linux")).toBe(true)
    },
  )
})

describe("fetching Nova over the network", () => {
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
  let slow = new Uint8Array()
  // A real server on this machine sending the release's archive a tenth at a time, each request
  // on its own connection, as the release's is.
  const slowServer = createServer((request, response) => {
    const step = Math.ceil(slow.length / 10)
    let at = 0
    const send = (): void => {
      if (response.destroyed) return
      if (at >= slow.length) return void response.end()
      response.write(slow.slice(at, at + step))
      at += step
      setTimeout(send, 40)
    }
    response.writeHead(200, { "content-type": "application/octet-stream" })
    send()
  })
  let slowSource = ""
  beforeAll(async () => {
    await new Promise<void>((settle) => slowServer.listen(0, "127.0.0.1", settle))
    slowSource = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise<void>((settle) => slowServer.close(() => settle())))

  // The service over a release sent slowly, with the switch as `on` says.
  const slowService = async (resources: Resources, on: { value: boolean }) => {
    const release = await fakeRelease(resources)
    slow = await readFile(join(release.source, "pi-linux-x64.tar.gz"))
    const data = await folder(resources)
    const states: string[] = []
    const pi = new Nova({
      data,
      enabled: () => on.value,
      env: {
        NOVADECK_NOVA_SOURCE: slowSource,
        NOVADECK_NOVA_LICENCE: release.licence,
      },
      platform: "linux",
      arch: "x64",
      pinned: release.pinned,
    })
    pi.follow(() => states.push(pi.state().state))
    return { pi, data, states }
  }

  it("keeps telling a download switched on twice, to its end", async ({ resources }) => {
    const on = { value: true }
    const { pi, states } = await slowService(resources, on)

    pi.switched()
    await expect.poll(() => pi.state().state).toBe("downloading")
    pi.switched()
    await expect.poll(() => pi.state().state, { timeout: 5_000 }).toBe("ready")

    expect(states.filter((state) => state === "downloading").length).toBeGreaterThan(2)
  })

  it("stops a download switched off, leaves nothing, and refuses the launch waiting on it", async ({
    resources,
  }) => {
    const on = { value: true }
    const { pi, data, states } = await slowService(resources, on)
    const launch = pi.fetch("nova", () => {})
    await expect.poll(() => pi.state().state).toBe("downloading")

    on.value = false
    pi.switched()

    await expect(launch).rejects.toThrow(turnOnLine)
    expect(pi.state()).toEqual({ state: "off" })
    // What the stopped run said after the switch doesn't stand over it.
    await new Promise((settle) => setTimeout(settle, 200))
    expect(states.at(-1)).toBe("off")
    expect((await readdir(novaFolder(data))).filter((entry) => entry !== "agent")).toEqual([])
  })

  it("ends ready, telling the progress, when switched on, off and on again", async ({
    resources,
  }) => {
    const on = { value: true }
    const { pi } = await slowService(resources, on)
    const seen: string[] = []
    pi.follow(() => {
      const state = pi.state()
      if (state.state === "downloading") seen.push(String(state.received))
    })

    pi.switched()
    await expect.poll(() => pi.state().state).toBe("downloading")
    on.value = false
    pi.switched()
    on.value = true
    pi.switched()
    await expect.poll(() => pi.state().state, { timeout: 5_000 }).toMatch(/ready|failed/)
    expect(pi.state()).toEqual({ state: "ready" })

    // The second run's own bytes, past its start.
    expect(seen.filter((received) => received !== "0").length).toBeGreaterThan(0)
  })

  beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it("says the connection is down when the release can't be reached", async ({ resources }) => {
    const release = await fakeRelease(resources)

    await expect(
      fetchNova({
        data: await folder(resources),
        ...linux,
        ...release,
        source: "https://release.test/down/",
      }),
    ).rejects.toThrow("Couldn't reach release.test. Check your connection.")
  })

  it("fetches the licence first, and no archive where it can't be had", async ({ resources }) => {
    const release = await fakeRelease(resources)

    await expect(
      fetchNova({
        data: await folder(resources),
        ...linux,
        ...release,
        source: "https://release.test/counted/",
        licence: "https://licence.test/LICENSE",
      }),
    ).rejects.toThrow("Couldn't reach licence.test.")
    expect(archives).toBe(0)
  })

  it("gives up on a download that stalls", async ({ resources }) => {
    const release = await fakeRelease(resources)
    const data = await folder(resources)

    await expect(
      fetchNova({
        data,
        ...linux,
        ...release,
        source: "https://release.test/stall/",
        stallMs: 200,
      }),
    ).rejects.toThrow("The download stalled")
    expect(await readdir(novaFolder(data))).toEqual([])
  })
})
