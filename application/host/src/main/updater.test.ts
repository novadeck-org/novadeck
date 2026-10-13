import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { UpdateChannel } from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import {
  installUpdateChannel,
  openUpdatePageChannel,
  setUpdateChannelChannel,
  updateChannelChannel,
  updateOfferChannel,
  updateRequestChannel,
} from "../bridge.js"
import { context, describe, expect, it } from "../test"
import {
  bundleOf,
  checkForUpdates,
  checkIntervalMs,
  developerIdSigned,
  firstCheckMs,
  retryCheckMs,
  installFallbackMs,
  installOnlyOnOrderlyQuit,
  installUpdate,
  portableOf,
  quitWithoutInstalling,
  registerUpdateIpc,
  switchCheckMs,
  trackOffer,
  updatePlan,
  updateVersionOf,
  type Updater,
  type UpdateBuild,
  type UpdateMode,
} from "./updater"

const build = (overrides: Partial<UpdateBuild> = {}): UpdateBuild => ({
  packaged: true,
  version: "0.4.2",
  platform: "linux",
  execPath: "/opt/novadeck/novadeck",
  env: {},
  signed: false,
  inApplications: false,
  appImageWritable: true,
  appImageInstalled: true,
  ...overrides,
})

const appImage = {
  env: {
    APPIMAGE: "/home/me/novadeck.AppImage",
    APPDIR: "/tmp/.mount_novadeAbC",
  },
  execPath: "/tmp/.mount_novadeAbC/novadeck",
}

describe("how a build updates", () => {
  it("never looks in a development run or in a build that carries version 0.0.0", () => {
    expect(updatePlan(build({ packaged: false, platform: "win32" }))).toBeUndefined()
    for (const platform of ["linux", "win32", "darwin"] as const)
      expect(
        updatePlan(build({ version: "0.0.0", platform, signed: true, ...appImage })),
      ).toBeUndefined()
  })

  it("never looks when the launch turns updates off", () => {
    expect(
      updatePlan(build({ platform: "win32", env: { NOVADECK_UPDATES: "off" } })),
    ).toBeUndefined()
    expect(
      updatePlan(
        build({
          ...appImage,
          env: { ...appImage.env, NOVADECK_UPDATES: "off" },
        }),
      ),
    ).toBeUndefined()
  })

  it("never looks on a platform without an installer", () => {
    expect(updatePlan(build({ platform: "freebsd" }))).toBeUndefined()
  })

  context("on Linux", () => {
    it("installs an installed AppImage that can replace its own file", () => {
      expect(updatePlan(build(appImage))).toEqual({
        kind: "appimage",
        mode: "install",
        portable: false,
      })
    })

    it("only tells of updates when the folder of an installed AppImage cannot be written to", () => {
      expect(updatePlan(build({ ...appImage, appImageWritable: false }))).toEqual({
        kind: "appimage",
        mode: "tell",
        portable: false,
      })
    })

    it("only tells of updates when the AppImage is portable, even in a folder it can write to", () => {
      expect(updatePlan(build({ ...appImage, appImageInstalled: false }))).toEqual({
        kind: "appimage",
        mode: "tell",
        portable: true,
      })
    })

    it("does not look in a build that is not an AppImage, such as a distribution's package", () => {
      expect(updatePlan(build())).toBeUndefined()
      // A folder that merely shares the mount's name as a prefix is not inside it.
      for (const execPath of ["/tmp/.mount_novadeAbCd/novadeck", "/tmp/.mount_novadeAbC"])
        expect(updatePlan(build({ ...appImage, execPath }))).toBeUndefined()
      // A shell started inside an AppImage inherits its variables, but runs another build.
      expect(updatePlan(build({ ...appImage, execPath: "/opt/novadeck/novadeck" }))).toBeUndefined()
    })

    it("does not take a build for an AppImage without both variables", () => {
      expect(updatePlan(build({ ...appImage, env: { APPIMAGE: "/x.AppImage" } }))).toBeUndefined()
      expect(
        updatePlan(build({ ...appImage, env: { APPDIR: "/tmp/.mount_novadeAbC" } })),
      ).toBeUndefined()
    })
  })

  context("on Windows", () => {
    it("installs", () => {
      expect(updatePlan(build({ platform: "win32" }))).toEqual({
        kind: "nsis",
        mode: "install",
        portable: false,
      })
    })

    it("does not tell a portable copy from an installed one yet", () => {
      const env = { PORTABLE_EXECUTABLE_DIR: "C:\\Tools" }
      expect(updatePlan(build({ platform: "win32", env, appImageInstalled: false }))).toEqual({
        kind: "nsis",
        mode: "install",
        portable: false,
      })
    })
  })

  context("on macOS", () => {
    it("installs when the app is Developer ID signed", () => {
      expect(updatePlan(build({ platform: "darwin", signed: true, inApplications: true }))).toEqual(
        {
          kind: "mac",
          mode: "install",
          portable: false,
        },
      )
    })

    it("only tells of updates when it is not", () => {
      expect(updatePlan(build({ platform: "darwin", inApplications: true }))).toEqual({
        kind: "mac",
        mode: "tell",
        portable: false,
      })
    })

    it("only tells, signed or not, when it runs outside Applications, and is portable", () => {
      for (const signed of [true, false])
        expect(updatePlan(build({ platform: "darwin", signed, inApplications: false }))).toEqual({
          kind: "mac",
          mode: "tell",
          portable: true,
        })
    })
  })
})

describe("whether a build is portable", () => {
  it("is an AppImage anywhere but the places the installer puts it", () => {
    expect(portableOf(build({ ...appImage, appImageInstalled: false }))).toBe(true)
    expect(portableOf(build(appImage))).toBe(false)
  })

  it("is not a build that is no AppImage, or one that looks for no updates", () => {
    expect(portableOf(build({ appImageInstalled: false }))).toBe(false)
    expect(portableOf(build({ ...appImage, appImageInstalled: false, version: "0.0.0" }))).toBe(
      false,
    )
    const env = { ...appImage.env, NOVADECK_UPDATES: "off" }
    expect(portableOf(build({ ...appImage, env, appImageInstalled: false }))).toBe(false)
    expect(portableOf(build({ ...appImage, appImageInstalled: false, packaged: false }))).toBe(
      false,
    )
  })

  it("is not yet a Windows build", () => {
    expect(portableOf(build({ platform: "win32", appImageInstalled: false }))).toBe(false)
  })

  context("on macOS", () => {
    const outside = { platform: "darwin", inApplications: false } as const

    it("is a packaged app anywhere but an Applications folder, signed or not", () => {
      expect(portableOf(build(outside))).toBe(true)
      expect(portableOf(build({ ...outside, signed: true }))).toBe(true)
      expect(portableOf(build({ platform: "darwin", signed: true, inApplications: true }))).toBe(
        false,
      )
    })

    it("is not a build that looks for no updates", () => {
      expect(portableOf(build({ ...outside, version: "0.0.0" }))).toBe(false)
      expect(portableOf(build({ ...outside, env: { NOVADECK_UPDATES: "off" } }))).toBe(false)
      expect(portableOf(build({ ...outside, packaged: false }))).toBe(false)
    })
  })
})

describe("the macOS app bundle", () => {
  it("is the folder above Contents/MacOS", () => {
    expect(bundleOf("/Applications/novadeck.app/Contents/MacOS/novadeck")).toBe(
      "/Applications/novadeck.app",
    )
  })

  it("counts as signed when codesign names a Developer ID authority", () => {
    const signed =
      "Identifier=dev.mzpk.novadeck\nAuthority=Developer ID Application: Mateusz (ABC)\n"
    expect(developerIdSigned(signed)).toBe(true)
  })

  it("does not when it is unsigned, ad-hoc signed, or signed by another authority", () => {
    expect(developerIdSigned("novadeck.app: code object is not signed at all")).toBe(false)
    expect(developerIdSigned("Identifier=dev.mzpk.novadeck\nSignature=adhoc\n")).toBe(false)
    expect(developerIdSigned("Authority=Apple Development: Someone (XYZ)\n")).toBe(false)
  })
})

describe("an update's version", () => {
  it("is a release's semantic version", () => {
    expect(updateVersionOf("1.2.3")).toBe("1.2.3")
    expect(updateVersionOf("0.10.0-rc.1")).toBe("0.10.0-rc.1")
  })

  it("is nothing else", () => {
    for (const value of [undefined, 3, "1.2", "v1.2.3", "1.2.3 ", "1.2.3\n<b>", "../1.2.3", ""])
      expect(updateVersionOf(value)).toBeUndefined()
  })
})

const page = () => {
  const sent: [string, unknown][] = []
  return {
    sent,
    send: (channel: string, offer: unknown) => void sent.push([channel, offer]),
  }
}

describe("telling pages of an update", () => {
  it("tells every open page the offer", () => {
    const [first, second] = [page(), page()]
    const offers = trackOffer(() => [first, second])
    offers.offer("ready", "1.2.3", ["Faster."])
    const offer = { kind: "ready", version: "1.2.3", notes: ["Faster."] }
    expect(first.sent).toEqual([[updateOfferChannel, offer]])
    expect(second.sent).toEqual([[updateOfferChannel, offer]])
    expect(offers.current()).toEqual(offer)
  })

  it("carries when the copy fell behind, asking only for an offer that is new", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    const asked: string[] = []
    const since = (): string => {
      asked.push("asked")
      return "2026-10-01T09:30:00.000Z"
    }
    offers.offer("available", "1.2.3", [], { outdatedSince: since })
    offers.offer("available", "1.2.3", [], { outdatedSince: since })
    offers.offer("available", "1.2.4", [])
    expect(asked).toHaveLength(1)
    expect(open.sent.map(([, offer]) => offer)).toEqual([
      {
        kind: "available",
        version: "1.2.3",
        notes: [],
        outdatedSince: "2026-10-01T09:30:00.000Z",
      },
      { kind: "available", version: "1.2.4", notes: [] },
    ])
  })

  it("goes without the date when the copy cannot say", () => {
    const open = page()
    trackOffer(() => [open]).offer("available", "1.2.3", [], { outdatedSince: () => undefined })
    expect(open.sent).toEqual([
      [updateOfferChannel, { kind: "available", version: "1.2.3", notes: [] }],
    ])
  })

  it("tells a page that asks later, and nothing before there is an offer", () => {
    const late = page()
    const offers = trackOffer<ReturnType<typeof page>>(() => [])
    offers.request(late)
    expect(late.sent).toEqual([])
    offers.offer("available", "1.2.3", [])
    offers.request(late)
    expect(late.sent).toEqual([
      [updateOfferChannel, { kind: "available", version: "1.2.3", notes: [] }],
    ])
  })

  it("tells pages of a newer version, but not again of the one they know", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer("available", "1.2.3", [])
    offers.offer("available", "1.2.3", ["Changed notes."])
    offers.offer("available", "1.3.0", [])
    expect(open.sent.map(([, offer]) => (offer as { version: string }).version)).toEqual([
      "1.2.3",
      "1.3.0",
    ])
  })

  it("tells pages each percent a download reaches once, and carries it only for a download", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer("downloading", "1.2.3", [], { percent: 0 })
    offers.offer("downloading", "1.2.3", [], { percent: 0 })
    offers.offer("downloading", "1.2.3", [], { percent: 7 })
    offers.offer("downloading", "1.2.3", [], { percent: 7 })
    offers.offer("ready", "1.2.3", [], { percent: 100 })
    expect(open.sent.map(([, offer]) => offer)).toEqual([
      { kind: "downloading", version: "1.2.3", notes: [], percent: 0 },
      { kind: "downloading", version: "1.2.3", notes: [], percent: 7 },
      { kind: "ready", version: "1.2.3", notes: [] },
    ])
  })

  it("tells pages when a ready update could not be installed after all", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer("ready", "1.2.3", [])
    offers.offer("available", "1.2.3", [])
    expect(offers.current()?.kind).toBe("available")
    expect(open.sent).toHaveLength(2)
  })

  it("remembers and tells nothing that is not a version", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer("ready", "latest; rm -rf", [])
    expect(open.sent).toEqual([])
    expect(offers.current()).toBeUndefined()
  })
})

type Listener = (event: IpcMainEvent, ...values: unknown[]) => unknown

const registered = (own: boolean, channel: UpdateChannel = "stable") => {
  const listeners = new Map<string, Listener>()
  const calls: string[] = []
  registerUpdateIpc(
    {
      on: (name, listener) => void listeners.set(name, listener as Listener),
      handle: (name, listener) => void listeners.set(name, listener as Listener),
    },
    {
      window: () => (own ? "window" : undefined),
      request: (window) => void calls.push(`request ${window}`),
      install: () => void calls.push("install"),
      openPage: () => void calls.push("open page"),
      channel: () => channel,
      setChannel: (next) => void calls.push(`channel ${next}`),
    },
  )
  const send = (name: string, ...values: unknown[]): unknown =>
    listeners.get(name)?.({} as IpcMainEvent, ...values)
  return { send, calls }
}

describe("taking the page's requests about updates", () => {
  it("answers a request for the last offer for the window it came from", () => {
    const { send, calls } = registered(true)
    send(updateRequestChannel)
    expect(calls).toEqual(["request window"])
  })

  it("installs and opens the release page when asked", () => {
    const { send, calls } = registered(true)
    send(installUpdateChannel)
    send(openUpdatePageChannel)
    expect(calls).toEqual(["install", "open page"])
  })

  it("answers the channel the build follows", () => {
    expect(registered(true, "early").send(updateChannelChannel)).toBe("early")
  })

  it("follows a channel the page names, when it is a known one", () => {
    const { send, calls } = registered(true)
    send(setUpdateChannelChannel, "early")
    send(setUpdateChannelChannel, "nightly")
    send(setUpdateChannelChannel, { channel: "early" })
    send(setUpdateChannelChannel)
    expect(calls).toEqual(["channel early"])
  })

  it("ignores any other sender, and tells it only the default channel", () => {
    const { send, calls } = registered(false, "early")
    send(updateRequestChannel)
    send(installUpdateChannel)
    send(openUpdatePageChannel)
    send(setUpdateChannelChannel, "early")
    expect(send(updateChannelChannel)).toBe("stable")
    expect(calls).toEqual([])
  })
})

// A promise and what settles it, as the host's lib has no Promise.withResolvers.
const deferred = <T>() => {
  const settle: { resolve?: (value: T) => void; reject?: (error: unknown) => void } = {}
  const promise = new Promise<T>((resolve, reject) => Object.assign(settle, { resolve, reject }))
  return {
    promise,
    resolve: (value: T) => settle.resolve?.(value),
    reject: (error: unknown) => settle.reject?.(error),
  }
}

// An updater whose quitAndInstall behaves as electron-updater's does when installing
// fails: it logs and returns, without quitting or throwing. `ends` is how it behaves
// when installing works: the app quits (as BaseUpdater does after a setImmediate).
const installing = ({
  downloaded = true,
  settled = () => Promise.resolve(true),
  ends = true,
  throws = false,
  shutdownMs = 0,
  fallbackMs = 10_000,
} = {}) => {
  const steps: string[] = []
  let stopping = false
  const quitAndInstall = (): void => {
    steps.push("install")
    if (throws) throw new Error("no updater")
    if (ends) steps.push("quit by updater")
  }
  const run = (): void =>
    installUpdate({
      downloaded: () => downloaded,
      settled,
      stopping: () => stopping,
      stop: () => {
        stopping = true
        steps.push("stop")
      },
      shutdown: async () => {
        steps.push("shutdown")
        await new Promise((resolve) => setTimeout(resolve, shutdownMs))
        steps.push("shut down")
      },
      install: quitAndInstall,
      quit: () => void steps.push("quit"),
      fallbackMs,
    })
  return { run, steps }
}

describe("restarting into the update", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it("saves and shuts down the way quitting does, then installs", async () => {
    const { run, steps } = installing()
    run()
    await vi.advanceTimersByTimeAsync(0)
    expect(steps).toEqual(["stop", "shutdown", "shut down", "install", "quit by updater"])
  })

  it("ignores a second request while the first is still shutting down", async () => {
    const { run, steps } = installing({ shutdownMs: 20 })
    run()
    run()
    await vi.advanceTimersByTimeAsync(20)
    expect(steps.filter((step) => step === "shutdown")).toHaveLength(1)
    expect(steps).toContain("install")
  })

  it("does nothing while no update is downloaded", async () => {
    const { run, steps } = installing({ downloaded: false })
    run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(steps).toEqual([])
  })

  it("waits for a newer release downloading in place of the update, then restarts into it", async () => {
    const { promise, resolve } = deferred<boolean>()
    const { run, steps } = installing({ settled: () => promise })
    run()
    run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(steps).toEqual([])
    resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(steps).toEqual(["stop", "shutdown", "shut down", "install", "quit by updater"])
  })

  it("does not restart when that download fails, as nothing is left to install", async () => {
    const { run, steps } = installing({ settled: () => Promise.resolve(false) })
    run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(steps).toEqual([])
  })

  it("quits at once when installing throws", async () => {
    const { run, steps } = installing({ throws: true })
    run()
    await vi.advanceTimersByTimeAsync(0)
    expect(steps).toEqual(["stop", "shutdown", "shut down", "install", "quit"])
  })

  it("quits after the wait when the updater returns without ending the app", async () => {
    const { run, steps } = installing({ ends: false, fallbackMs: 10_000 })
    run()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(steps).toEqual(["stop", "shutdown", "shut down", "install"])
    await vi.advanceTimersByTimeAsync(1)
    expect(steps).toEqual(["stop", "shutdown", "shut down", "install", "quit"])
  })

  it("waits longer on macOS, where Squirrel stages the update first", () => {
    expect(installFallbackMs("darwin")).toBeGreaterThan(installFallbackMs("linux"))
    expect(installFallbackMs("win32")).toBe(installFallbackMs("linux"))
  })
})

describe("quitting as the system ends the session", () => {
  it("leaves an update uninstalled, then quits", () => {
    const steps: string[] = []
    const updater = {
      get autoInstallOnAppQuit() {
        return true
      },
      set autoInstallOnAppQuit(value: boolean) {
        steps.push(`install on quit ${value}`)
      },
    }
    quitWithoutInstalling(
      () => updater,
      () => void steps.push("quit"),
    )()
    expect(steps).toEqual(["install on quit false", "quit"])
  })

  it("quits all the same in a build that does not update", () => {
    const steps: string[] = []
    quitWithoutInstalling(
      () => undefined,
      () => void steps.push("quit"),
    )()
    expect(steps).toEqual(["quit"])
  })
})

class FakeUpdater extends EventEmitter implements Pick<Updater, "checkForUpdates"> {
  downloads: (() => Promise<unknown>)[] = []
  downloadResult: (() => Promise<unknown>) | undefined
  downloadUpdate(): Promise<unknown> {
    this.downloads.push(() => Promise.resolve())
    return this.downloadResult?.() ?? Promise.resolve()
  }
  installed = 0
  restarted = 0
  install(): boolean {
    this.installed += 1
    return true
  }
  quitAndInstall(): void {
    this.restarted += 1
  }
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  logger: Updater["logger"] = null
  checks = 0
  failing = false
  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    if (!this.failing) return Promise.resolve()
    const error = new Error("offline")
    this.emit("error", error)
    return Promise.reject(error)
  }
}

describe("checking for updates", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const checking = (
    options: {
      mode?: UpdateMode
      channel?: UpdateChannel
      native?: EventEmitter
      upToDate?: () => void
      failedVersion?: string
    } = {},
  ) => {
    const updater = new FakeUpdater()
    const offered: [string, string, readonly string[], number?][] = []
    const failed: string[] = []
    const logged: string[] = []
    const checks = checkForUpdates(updater as unknown as Updater, {
      mode: options.mode ?? "install",
      channel: options.channel ?? "stable",
      failedVersion: options.failedVersion,
      native: options.native,
      upToDate: options.upToDate,
      offer: (kind, version, notes, percent) =>
        void offered.push(
          percent === undefined ? [kind, version, notes] : [kind, version, notes, percent],
        ),
      installFailed: (version) => void failed.push(version),
      log: (message) => void logged.push(message),
    })
    return { updater, offered, failed, logged, ...checks }
  }

  it("tells when a check finds no newer release", () => {
    let told = 0
    const { updater } = checking({ mode: "tell", upToDate: () => void (told += 1) })
    updater.emit("update-not-available", { version: "1.0.0" })
    expect(told).toBe(1)
    // Not every build asks.
    expect(() => checking().updater.emit("update-not-available", {})).not.toThrow()
  })

  it("installs on quitting in install mode, and asks for each download itself", () => {
    const { updater } = checking()
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: true,
    })
  })

  it("downloads and installs nothing in tell mode", () => {
    const { updater } = checking({ mode: "tell" })
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
    })
  })

  it("follows only releases that are not prereleases on the stable channel, and every release on early", () => {
    expect(checking({ channel: "stable" }).updater.allowPrerelease).toBe(false)
    expect(checking({ channel: "early" }).updater.allowPrerelease).toBe(true)
  })

  it("checks once shortly after launch, then every few hours", async () => {
    const { updater } = checking()
    await vi.advanceTimersByTimeAsync(firstCheckMs - 1)
    expect(updater.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(checkIntervalMs)
    expect(updater.checks).toBe(2)
  })

  it("logs a failed check, as when stable has no release yet, and tries again at the next one", async () => {
    const { updater, logged, offered } = checking()
    updater.failing = true
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(logged).toEqual(["The update check failed."])
    expect(offered).toEqual([])
    updater.failing = false
    await vi.advanceTimersByTimeAsync(checkIntervalMs)
    expect(updater.checks).toBe(2)
  })

  context("in install mode", () => {
    it("offers the update as ready once downloaded, with its notes as lines", () => {
      const { updater, offered } = checking()
      const info = {
        version: "1.2.3",
        releaseName: "Novadeck v1.2.3",
        releaseNotes: "<ul><li>Faster &amp; smaller.</li><li>Fixes.</li></ul>",
      }
      updater.emit("update-available", info)
      const notes = ["Faster & smaller.", "Fixes."]
      updater.emit("download-progress", { percent: 0 })
      expect(offered).toEqual([["downloading", "1.2.3", notes, 0]])
      updater.emit("update-downloaded", info)
      expect(offered).toEqual([
        ["downloading", "1.2.3", notes, 0],
        ["ready", "1.2.3", notes],
      ])
    })

    it("offers a download already on disk from an earlier launch as ready, without progress", () => {
      const { updater, offered } = checking()
      updater.emit("update-available", { version: "1.2.3" })
      expect(offered).toEqual([])
      updater.emit("update-downloaded", { version: "1.2.3" })
      expect(offered).toEqual([["ready", "1.2.3", []]])
    })

    it("on macOS offers the update as ready only once Squirrel has staged it, downloading until then", () => {
      const native = new EventEmitter()
      const { updater, offered } = checking({ native })
      updater.emit("update-available", { version: "1.2.3" })
      updater.emit("download-progress", { percent: 0 })
      updater.emit("download-progress", { percent: 99.6 })
      updater.emit("update-downloaded", { version: "1.2.3" })
      expect(offered).toEqual([
        ["downloading", "1.2.3", [], 0],
        ["downloading", "1.2.3", [], 99],
      ])
      updater.emit("download-progress", { percent: 100 })
      expect(offered).toHaveLength(2)
      native.emit("update-downloaded")
      expect(offered.at(-1)).toEqual(["ready", "1.2.3", []])
      native.emit("update-downloaded")
      expect(offered).toHaveLength(3)
    })

    context("while it downloads", () => {
      it("offers each whole percent of progress once, as it changes", () => {
        const { updater, offered } = checking()
        updater.emit("update-available", {
          version: "1.2.3",
          releaseName: "Novadeck v1.2.3",
          releaseNotes: "<p>Faster.</p>",
        })
        for (const percent of [0.4, 0.9, 1, 1.5, 1.99, 2, 57.3, 100])
          updater.emit("download-progress", { percent })
        expect(offered.map(([, , , percent]) => percent)).toEqual([0, 1, 2, 57, 100])
        expect(
          offered.every(([kind, , notes]) => kind === "downloading" && notes.length === 1),
        ).toBe(true)
      })

      it("ignores progress when no download of ours is under way", async () => {
        const { updater, offered } = checking()
        updater.emit("download-progress", { percent: 30 })
        expect(offered).toEqual([])
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("download-progress", { percent: 10 })
        updater.emit("update-downloaded", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(0)
        updater.emit("download-progress", { percent: 50 })
        expect(offered).toEqual([
          ["downloading", "1.2.3", [], 10],
          ["ready", "1.2.3", []],
        ])
      })

      it("offers it as available when the first download fails partway, which the error event logs", async () => {
        const { updater, offered, failed, logged, settled } = checking()
        const download = deferred<unknown>()
        updater.downloadResult = () => download.promise
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("download-progress", { percent: 30 })
        updater.emit("error", new Error("download failed"))
        download.reject(new Error("download failed"))
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([
          ["downloading", "1.2.3", [], 30],
          ["available", "1.2.3", []],
        ])
        expect(logged).toEqual(["The update check failed."])
        expect(failed).toEqual([])
        await expect(settled()).resolves.toBe(false)
        updater.emit("download-progress", { percent: 80 })
        expect(offered).toHaveLength(2)
      })

      it("tells nothing of a download that fails before any progress, as of a failed check", async () => {
        const { updater, offered } = checking()
        updater.downloadResult = () => Promise.reject(new Error("download failed"))
        updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([])
      })

      it("tries a failed download again a few minutes later, and then as usual", async () => {
        const { updater } = checking()
        await vi.advanceTimersByTimeAsync(firstCheckMs)
        updater.downloadResult = () => Promise.reject(new Error("download failed"))
        updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(retryCheckMs - 1)
        expect(updater.checks).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(updater.checks).toBe(2)
        await vi.advanceTimersByTimeAsync(checkIntervalMs - retryCheckMs - firstCheckMs)
        expect(updater.checks).toBe(3)
      })

      it("tries a release again early only once in a run", async () => {
        const { updater } = checking()
        updater.downloadResult = () => Promise.reject(new Error("download failed"))
        updater.emit("update-available", { version: "1.2.3" })
        // The first check after launch, then the retry.
        await vi.advanceTimersByTimeAsync(retryCheckMs)
        expect(updater.checks).toBe(2)
        updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(retryCheckMs * 3)
        expect(updater.checks).toBe(2)
        expect(updater.downloads).toHaveLength(2)
      })

      it("keeps a channel switch's check soon while a retry waits", async () => {
        const checks = checking()
        checks.updater.downloadResult = () => Promise.reject(new Error("download failed"))
        checks.setChannel("early")
        checks.updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(switchCheckMs)
        expect(checks.updater.checks).toBe(1)
      })

      it("does not try again once stopped", async () => {
        const { updater, stop } = checking()
        updater.downloadResult = () => Promise.reject(new Error("download failed"))
        updater.emit("update-available", { version: "1.2.3" })
        stop()
        await vi.advanceTimersByTimeAsync(retryCheckMs * 2)
        expect(updater.checks).toBe(0)
      })

      it("keeps a download ready that fails only after it was reported in", async () => {
        const { updater, offered, settled } = checking()
        const download = deferred<unknown>()
        updater.downloadResult = () => download.promise
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("update-downloaded", { version: "1.2.3" })
        download.reject(new Error("the blockmap could not be copied"))
        await vi.advanceTimersByTimeAsync(0)
        expect(offered.at(-1)).toEqual(["ready", "1.2.3", []])
        await expect(settled()).resolves.toBe(true)
      })

      it("leaves a release found meanwhile to a later check", () => {
        const { updater } = checking()
        updater.downloadResult = () => new Promise(() => {})
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(1)
      })
    })

    it("keeps checking once an update has downloaded, so a newer release is found", async () => {
      const { updater } = checking()
      await vi.advanceTimersByTimeAsync(firstCheckMs)
      updater.emit("update-downloaded", { version: "1.2.3" })
      await vi.advanceTimersByTimeAsync(checkIntervalMs * 3)
      expect(updater.checks).toBe(4)
    })

    it("on macOS stops checking once an update has downloaded, as Squirrel keeps the one it staged", async () => {
      const native = new EventEmitter()
      const { updater } = checking({ native })
      await vi.advanceTimersByTimeAsync(firstCheckMs)
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("update-available", { version: "1.3.0" })
      await vi.advanceTimersByTimeAsync(checkIntervalMs * 3)
      expect(updater.checks).toBe(1)
      expect(updater.downloads).toHaveLength(0)
    })

    it("does not download the update it has again", () => {
      const { updater } = checking()
      updater.emit("update-available", { version: "1.2.3" })
      expect(updater.downloads).toHaveLength(1)
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("update-available", { version: "1.2.3" })
      expect(updater.downloads).toHaveLength(1)
    })

    context("when a newer release comes out while an update waits", () => {
      const waiting = () => {
        const checks = checking()
        checks.updater.emit("update-downloaded", { version: "1.2.3" })
        const download = deferred<unknown>()
        checks.updater.downloadResult = () => download.promise
        checks.updater.emit("update-available", { version: "1.3.0" })
        return { ...checks, download }
      }

      it("downloads it in place of the waiting one, showing its progress until it is in, and offers it as ready", async () => {
        const { updater, offered, download } = waiting()
        expect(updater.downloads).toHaveLength(1)
        expect(offered).toEqual([["ready", "1.2.3", []]])
        updater.emit("download-progress", { percent: 0 })
        updater.emit("download-progress", { percent: 40.2 })
        updater.emit("update-downloaded", { version: "1.3.0" })
        download.resolve(undefined)
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([
          ["ready", "1.2.3", []],
          ["downloading", "1.3.0", [], 0],
          ["downloading", "1.3.0", [], 40],
          ["ready", "1.3.0", []],
        ])
      })

      it("still installs the waiting one on quit until it is in", () => {
        const { updater } = waiting()
        expect(updater.autoInstallOnAppQuit).toBe(true)
      })

      it("shows it in place of a restart asked for before its progress came in", async () => {
        const { updater, offered, settled } = waiting()
        await expect(settled()).resolves.toBe(false)
        expect(offered.at(-1)).toEqual(["downloading", "1.3.0", [], 0])
        updater.emit("download-progress", { percent: 0.5 })
        expect(offered).toHaveLength(2)
        updater.emit("download-progress", { percent: 30 })
        await expect(settled()).resolves.toBe(false)
        expect(offered.at(-1)).toEqual(["downloading", "1.3.0", [], 30])
      })

      it("lets a restart wait for it once it was reported in, and tells whether it came through", async () => {
        const { updater, settled, download } = waiting()
        updater.emit("update-downloaded", { version: "1.3.0" })
        let ready: boolean | undefined
        void settled().then((value) => void (ready = value))
        await vi.advanceTimersByTimeAsync(0)
        expect(ready).toBeUndefined()
        download.resolve(undefined)
        await vi.advanceTimersByTimeAsync(0)
        expect(ready).toBe(true)
        await expect(settled()).resolves.toBe(true)
      })

      it("leaves a release found meanwhile to a later check", () => {
        const { updater } = waiting()
        updater.emit("update-available", { version: "1.4.0" })
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(1)
      })

      it("offers it as available when its download fails, and downloads it at a later check", async () => {
        const { updater, offered, failed, logged, settled, download } = waiting()
        // electron-updater reports the failure through the error event before it rejects.
        updater.emit("error", new Error("download failed"))
        download.reject(new Error("download failed"))
        await vi.advanceTimersByTimeAsync(0)
        await expect(settled()).resolves.toBe(false)
        // The ready update is likely gone, so the page hears even without any progress.
        expect(offered).toEqual([
          ["ready", "1.2.3", []],
          ["available", "1.3.0", []],
        ])
        expect(logged).toEqual(["The update check failed."])
        expect(failed).toEqual([])
        updater.downloadResult = undefined
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(2)
        updater.emit("update-downloaded", { version: "1.3.0" })
        expect(offered.at(-1)).toEqual(["ready", "1.3.0", []])
      })
    })

    it("downloads nothing once stopped", () => {
      const { updater, stop } = checking()
      stop()
      updater.emit("update-available", { version: "1.2.3" })
      expect(updater.downloads).toHaveLength(0)
    })

    it("has no update to install before one has downloaded", async () => {
      const { updater, settled } = checking()
      await expect(settled()).resolves.toBe(false)
      updater.emit("update-downloaded", { version: "1.2.3" })
      await expect(settled()).resolves.toBe(true)
    })

    context("after an install failed on a version", () => {
      it("only tells of that version, without downloading it again", () => {
        const { updater, offered } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-available", {
          version: "1.2.3",
          releaseName: "Novadeck v1.2.3",
          releaseNotes: "<p>Faster.</p>",
        })
        expect(updater.downloads).toHaveLength(0)
        expect(offered).toEqual([["available", "1.2.3", ["Faster."]]])
      })

      it("installs a newer release as usual", () => {
        const { updater, offered } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(1)
        updater.emit("update-downloaded", { version: "1.3.0" })
        expect(offered.at(-1)).toEqual(["ready", "1.3.0", []])
        expect(updater.autoInstallOnAppQuit).toBe(true)
      })

      it("does not let a late check replace a ready update with the failed one", () => {
        const { updater, offered } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-downloaded", { version: "1.3.0" })
        updater.emit("update-available", { version: "1.2.3" })
        expect(offered).toEqual([["ready", "1.3.0", []]])
      })

      it("keeps checking, so a newer release is found", async () => {
        const { updater } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(firstCheckMs + checkIntervalMs)
        expect(updater.checks).toBe(2)
      })
    })

    it("marks an error raised while quitting installs as a failed install, stops installing on quit, and offers the update as available", () => {
      const { updater, offered, failed, logged } = checking()
      updater.emit("update-downloaded", {
        version: "1.2.3",
        releaseName: "Novadeck v1.2.3",
        releaseNotes: "<p>Faster.</p>",
      })
      updater.install()
      updater.emit("error", new Error("the installer failed"))
      expect(failed).toEqual(["1.2.3"])
      expect(updater.autoInstallOnAppQuit).toBe(false)
      expect(offered).toEqual([
        ["ready", "1.2.3", ["Faster."]],
        ["available", "1.2.3", ["Faster."]],
      ])
      expect(logged).toEqual(["Installing the update failed."])
    })

    it("does the same for an error raised while restarting", () => {
      const { updater, failed } = checking()
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.quitAndInstall()
      updater.emit("error", new Error("the file could not be replaced"))
      expect(failed).toEqual(["1.2.3"])
    })

    it("does not count an error from a check or channel switch that fails after the download", () => {
      const { updater, failed, offered, logged } = checking()
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("error", new Error("offline"))
      expect(failed).toEqual([])
      expect(updater.autoInstallOnAppQuit).toBe(true)
      expect(offered).toEqual([["ready", "1.2.3", []]])
      expect(logged).toEqual(["The update check failed."])
    })

    it("on macOS counts an error while Squirrel stages the download, and none once it has", () => {
      const native = new EventEmitter()
      const { updater, failed } = checking({ native })
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("error", new Error("Squirrel could not stage"))
      expect(failed).toEqual(["1.2.3"])
      native.emit("update-downloaded")
      updater.emit("error", new Error("offline"))
      expect(failed).toEqual(["1.2.3"])
    })

    it("on macOS counts a failed staging once, although the updater reports the error twice", () => {
      const native = new EventEmitter()
      const { updater, failed, offered, logged } = checking({ native })
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("error", new Error("Squirrel could not stage"))
      updater.emit("error", new Error("Squirrel could not stage"))
      expect(failed).toEqual(["1.2.3"])
      expect(logged).toEqual(["Installing the update failed."])
      expect(offered).toEqual([["available", "1.2.3", []]])
    })

    it("does not mark a failed check as a failed install", () => {
      const { updater, failed } = checking()
      updater.emit("error", new Error("offline"))
      expect(failed).toEqual([])
      expect(updater.autoInstallOnAppQuit).toBe(true)
    })

    it("catches a download that fails, which the error event has logged", async () => {
      const { updater } = checking()
      updater.downloadResult = () => Promise.reject(new Error("download failed"))
      updater.emit("update-available", { version: "1.2.3" })
      await vi.advanceTimersByTimeAsync(0)
      expect(updater.downloads).toHaveLength(1)
    })

    it("gives no notes that belong to another release", () => {
      const { updater, offered } = checking()
      updater.emit("update-downloaded", {
        version: "1.2.3",
        releaseName: "Novadeck v1.2.4",
        releaseNotes: "<p>Another version's.</p>",
      })
      expect(offered).toEqual([["ready", "1.2.3", []]])
    })
  })

  context("in tell mode", () => {
    it("offers each release newer than the build as available, with its notes", () => {
      const { updater, offered } = checking({ mode: "tell" })
      updater.emit("update-available", {
        version: "1.2.3",
        releaseName: "Novadeck v1.2.3",
        releaseNotes: "<p>Faster.</p>",
      })
      updater.emit("update-available", {
        version: "1.3.0",
        releaseNotes: null,
      })
      expect(offered).toEqual([
        ["available", "1.2.3", ["Faster."]],
        ["available", "1.3.0", []],
      ])
    })

    it("keeps checking, so a newer release replaces the offer", async () => {
      const { updater } = checking({ mode: "tell" })
      await vi.advanceTimersByTimeAsync(firstCheckMs)
      updater.emit("update-available", { version: "1.2.3" })
      await vi.advanceTimersByTimeAsync(checkIntervalMs * 2)
      expect(updater.checks).toBe(3)
    })
  })

  context("when the channel is switched", () => {
    it("follows the new channel and checks soon, in place of the first check", async () => {
      const checks = checking()
      checks.setChannel("early")
      expect(checks.updater.allowPrerelease).toBe(true)
      await vi.advanceTimersByTimeAsync(switchCheckMs - 1)
      expect(checks.updater.checks).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(checks.updater.checks).toBe(1)
      checks.setChannel("stable")
      expect(checks.updater.allowPrerelease).toBe(false)
      await vi.advanceTimersByTimeAsync(switchCheckMs)
      expect(checks.updater.checks).toBe(2)
    })

    it("makes one check for a few switches in a row", async () => {
      const checks = checking()
      checks.setChannel("early")
      await vi.advanceTimersByTimeAsync(switchCheckMs - 1)
      checks.setChannel("stable")
      checks.setChannel("early")
      await vi.advanceTimersByTimeAsync(switchCheckMs * 2)
      expect(checks.updater.checks).toBe(1)
    })

    it("checks soon after an update has downloaded too, as a newer release replaces it", async () => {
      const checks = checking()
      checks.updater.emit("update-downloaded", { version: "1.2.3" })
      checks.setChannel("early")
      await vi.advanceTimersByTimeAsync(switchCheckMs)
      expect(checks.updater.checks).toBe(1)
    })

    it("applies from the next launch once the schedule has ended", async () => {
      const checks = checking({ native: new EventEmitter() })
      checks.updater.emit("update-downloaded", { version: "1.2.3" })
      checks.setChannel("early")
      expect(checks.updater.allowPrerelease).toBe(true)
      await vi.advanceTimersByTimeAsync(checkIntervalMs)
      expect(checks.updater.checks).toBe(0)
    })
  })

  it("stops checking once stopped", async () => {
    const { updater, stop } = checking()
    stop()
    await vi.advanceTimersByTimeAsync(checkIntervalMs * 2)
    expect(updater.checks).toBe(0)
  })
})

const quitting = (orderly: boolean) => {
  const updater = { autoInstallOnAppQuit: true }
  installOnlyOnOrderlyQuit(
    () => updater,
    () => orderly,
  )()
  return updater
}

describe("quitting by a signal", () => {
  it("installs nothing, as a logout or kill delivers SIGTERM and Electron quits normally", () => {
    expect(quitting(false).autoInstallOnAppQuit).toBe(false)
  })

  it("still installs on closing the last window or restarting into the update", () => {
    expect(quitting(true).autoInstallOnAppQuit).toBe(true)
  })

  it("does nothing in a build that does not update", () => {
    expect(() =>
      installOnlyOnOrderlyQuit(
        () => undefined,
        () => false,
      )(),
    ).not.toThrow()
  })
})

// What the download folder test uses of electron-updater's internals.
type DownloadHelper = { readonly file: string | null; clear(): Promise<void> }
type Download = {
  readonly fileInfo: { readonly url: URL; readonly info: { url: string; sha512: string } }
  readonly fileExtension: string
  readonly downloadUpdateOptions: unknown
  readonly task: (temp: string) => Promise<void>
  readonly done: () => Promise<void>
}

describe("electron-updater's download folder", () => {
  // checkForUpdates leaves installing on quit on while a newer release replaces the waiting
  // update. That holds while electron-updater keeps the waiting file, and goes on naming
  // it, until the newer one is renamed over it, which it does when both have one name, as
  // no release file carries a version (electron-builder.yml); and while a failed download
  // stops naming the file before it deletes it. Otherwise quitting would delete the running
  // AppImage and install nothing.
  const downloading = async (fails: boolean) => {
    const require = createRequire(import.meta.url)
    const out = dirname(require.resolve("electron-updater"))
    const { AppUpdater } = require(join(out, "AppUpdater.js")) as {
      AppUpdater: {
        prototype: { executeDownload(this: unknown, download: Download): Promise<unknown> }
      }
    }
    const { DownloadedUpdateHelper } = require(join(out, "DownloadedUpdateHelper.js")) as {
      DownloadedUpdateHelper: new (folder: string) => DownloadHelper
    }
    const folder = await mkdtemp(join(tmpdir(), "novadeck-updater-"))
    const helper = new DownloadedUpdateHelper(folder)
    // What clearing finds as it begins: whether the file is still named, and still there.
    const clearing: { file: string | null; there: boolean }[] = []
    let waiting: string | null = null
    const clear = helper.clear.bind(helper)
    helper.clear = () => {
      const cleared = clear()
      clearing.push({ file: helper.file, there: waiting !== null && existsSync(waiting) })
      return cleared
    }
    const updater = {
      listenerCount: () => 0,
      emit: () => false,
      _logger: { info: () => {}, warn: () => {}, error: () => {} },
      getOrCreateDownloadHelper: () => Promise.resolve(helper),
    }
    const name = "novadeck-linux-x86_64.AppImage"
    const download = (version: string, task: (temp: string) => Promise<void>): Download => ({
      fileInfo: {
        url: new URL(
          `https://github.com/novadeck-org/novadeck/releases/download/v${version}/${name}`,
        ),
        info: { url: name, sha512: version },
      },
      fileExtension: "AppImage",
      downloadUpdateOptions: {
        requestHeaders: {},
        updateInfoAndProvider: { info: { version, files: [] } },
      },
      task,
      done: () => Promise.resolve(),
    })
    const run = (version: string, task: (temp: string) => Promise<void>) =>
      AppUpdater.prototype.executeDownload.call(updater, download(version, task))
    try {
      await run("1.2.3", (temp) => writeFile(temp, "1.2.3"))
      waiting = helper.file
      const during: { file: string | null; content: string }[] = []
      const newer = run("1.3.0", async (temp) => {
        during.push({ file: helper.file, content: await readFile(waiting!, "utf8") })
        await writeFile(temp, "1.3.0")
        if (fails) throw new Error("download failed")
      })
      const failure = await newer.then(
        () => undefined,
        (error: unknown) => error,
      )
      return {
        waiting,
        during,
        clearing,
        failure,
        after: helper.file,
        content: await readFile(waiting!, "utf8").catch(() => undefined),
      }
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }

  it("keeps naming the waiting file, unchanged, while a newer release downloads in its place; re-check replacing in checkForUpdates if this fails", async () => {
    const { waiting, during, failure, after, content } = await downloading(false)
    expect(waiting).toMatch(/novadeck-linux-x86_64\.AppImage$/u)
    expect(during).toEqual([{ file: waiting, content: "1.2.3" }])
    expect(failure).toBeUndefined()
    expect(after).toBe(waiting)
    expect(content).toBe("1.3.0")
  })

  it("stops naming the waiting file before deleting it when that download fails; re-check replacing in checkForUpdates if this fails", async () => {
    const { failure, clearing, after, content } = await downloading(true)
    expect(failure).toBeInstanceOf(Error)
    expect(clearing).toEqual([{ file: null, there: true }])
    expect(after).toBeNull()
    expect(content).toBeUndefined()
  })

  it("is fed release files that carry no version in their names", async () => {
    const config = await readFile(join(import.meta.dirname, "../../electron-builder.yml"), "utf8")
    // Without a name of its own a build takes electron-builder's default, which has one.
    expect(config).toMatch(/^artifactName: \S/mu)
    const names = [...config.matchAll(/artifactName:(.*)$/gmu)].map(([, name]) => name!.trim())
    for (const name of names) {
      expect(name, "a name on one line").toMatch(/^[^>|]/u)
      expect(name).not.toMatch(/version/iu)
    }
  })
})

describe("electron-updater's restart", () => {
  it("emits before-quit-for-update on Electron's autoUpdater only after a successful install; re-check the Linux lock release in index.ts if this fails", async () => {
    // The host lets go of the single-instance lock on that event, so that the new AppImage,
    // which electron-updater starts first, can take it (see installUpdate's callback in
    // index.ts). If electron-updater changes when it emits, "Restart now" may end the app
    // without the new version starting, or a failed install may leave the lock released.
    const require = createRequire(import.meta.url)
    const file = join(dirname(require.resolve("electron-updater")), "BaseUpdater.js")
    const source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n")
    const start = source.search(/quitAndInstall\(isSilent = false, isForceRunAfter = false\)\s*\{/u)
    expect(start, "BaseUpdater.quitAndInstall").toBeGreaterThanOrEqual(0)
    const end = source.indexOf("\n    }\n", start)
    expect(end, "the end of BaseUpdater.quitAndInstall").toBeGreaterThan(start)
    const body = source.slice(start, end)
    const steps = [
      /const isInstalled = this\.install\(/u,
      /if \(isInstalled\)\s*\{/u,
      /setImmediate\(\(\) => \{/u,
      /require\("electron"\)\.autoUpdater\.emit\("before-quit-for-update"\)/u,
      /this\.app\.quit\(\)/u,
    ].map((step) => body.search(step))
    expect(steps.every((at) => at >= 0)).toBe(true)
    expect(steps).toEqual(steps.toSorted((a, b) => a - b))
  })
})
