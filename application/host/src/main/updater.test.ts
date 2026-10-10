import { EventEmitter } from "node:events"

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
  installFallbackMs,
  installOnlyOnOrderlyQuit,
  installUpdate,
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
  packageType: undefined,
  signed: false,
  appImageWritable: true,
  ...overrides,
})

const appImage = {
  env: { APPIMAGE: "/home/me/novadeck.AppImage", APPDIR: "/tmp/.mount_novadeAbC" },
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
      updatePlan(build({ ...appImage, env: { ...appImage.env, NOVADECK_UPDATES: "off" } })),
    ).toBeUndefined()
  })

  it("never looks on a platform without an installer", () => {
    expect(updatePlan(build({ platform: "freebsd" }))).toBeUndefined()
  })

  context("on Linux", () => {
    it("installs an AppImage that can replace its own file", () => {
      expect(updatePlan(build(appImage))).toEqual({ kind: "appimage", mode: "install" })
    })

    it("only tells of updates when the folder of the AppImage cannot be written to", () => {
      expect(updatePlan(build({ ...appImage, appImageWritable: false }))).toEqual({
        kind: "appimage",
        mode: "tell",
      })
    })

    it("installs a deb or an rpm through the package manager", () => {
      expect(updatePlan(build({ packageType: "deb" }))).toEqual({ kind: "deb", mode: "install" })
      expect(updatePlan(build({ packageType: "rpm" }))).toEqual({ kind: "rpm", mode: "install" })
    })

    it("does not need a writable folder for a package", () => {
      expect(updatePlan(build({ packageType: "deb", appImageWritable: false }))?.mode).toBe(
        "install",
      )
    })

    it("takes a deb launched from a shell inside an AppImage, which inherits its variables, for a deb", () => {
      expect(
        updatePlan(build({ ...appImage, execPath: "/opt/novadeck/novadeck", packageType: "deb" })),
      ).toEqual({ kind: "deb", mode: "install" })
    })

    it("takes an AppImage for one although a package type leaked into it", () => {
      expect(updatePlan(build({ ...appImage, packageType: "deb" }))?.kind).toBe("appimage")
    })

    it("does not look in a build that is neither, such as a package of another manager", () => {
      expect(updatePlan(build())).toBeUndefined()
      expect(updatePlan(build({ packageType: "pacman" }))).toBeUndefined()
      // A folder that merely shares the mount's name as a prefix is not inside it.
      for (const execPath of ["/tmp/.mount_novadeAbCd/novadeck", "/tmp/.mount_novadeAbC"])
        expect(updatePlan(build({ ...appImage, execPath }))).toBeUndefined()
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
      expect(updatePlan(build({ platform: "win32" }))).toEqual({ kind: "nsis", mode: "install" })
    })

    it("has no portable build to treat differently", () => {
      const env = { PORTABLE_EXECUTABLE_DIR: "C:\\Tools" }
      expect(updatePlan(build({ platform: "win32", env }))?.mode).toBe("install")
    })
  })

  context("on macOS", () => {
    it("installs when the app is Developer ID signed", () => {
      expect(updatePlan(build({ platform: "darwin", signed: true }))).toEqual({
        kind: "mac",
        mode: "install",
      })
    })

    it("only tells of updates when it is not", () => {
      expect(updatePlan(build({ platform: "darwin" }))).toEqual({ kind: "mac", mode: "tell" })
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
  return { sent, send: (channel: string, offer: unknown) => void sent.push([channel, offer]) }
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

// An updater whose quitAndInstall behaves as electron-updater's does when installing
// fails: it logs and returns, without quitting or throwing. `ends` is how it behaves
// when installing works: the app quits (as BaseUpdater does after a setImmediate).
const installing = ({
  downloaded = true,
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
      failedVersion?: string
    } = {},
  ) => {
    const updater = new FakeUpdater()
    const offered: [string, string, readonly string[]][] = []
    const failed: string[] = []
    const logged: string[] = []
    const checks = checkForUpdates(updater as unknown as Updater, {
      mode: options.mode ?? "install",
      channel: options.channel ?? "stable",
      failedVersion: options.failedVersion,
      native: options.native,
      offer: (kind, version, notes) => void offered.push([kind, version, notes]),
      installFailed: (version) => void failed.push(version),
      log: (message) => void logged.push(message),
    })
    return { updater, offered, failed, logged, ...checks }
  }

  it("installs on quitting in install mode, and asks for each download itself", () => {
    const { updater } = checking()
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: true })
  })

  it("downloads and installs nothing in tell mode", () => {
    const { updater } = checking({ mode: "tell" })
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false })
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
      updater.emit("update-available", { version: "1.2.3" })
      expect(offered).toEqual([])
      updater.emit("update-downloaded", {
        version: "1.2.3",
        releaseName: "Novadeck v1.2.3",
        releaseNotes: "<ul><li>Faster &amp; smaller.</li><li>Fixes.</li></ul>",
      })
      expect(offered).toEqual([["ready", "1.2.3", ["Faster & smaller.", "Fixes."]]])
    })

    it("on macOS offers the update only once Squirrel has staged it", () => {
      const native = new EventEmitter()
      const { updater, offered } = checking({ native })
      updater.emit("update-downloaded", { version: "1.2.3" })
      expect(offered).toEqual([])
      native.emit("update-downloaded")
      expect(offered).toEqual([["ready", "1.2.3", []]])
      native.emit("update-downloaded")
      expect(offered).toHaveLength(1)
    })

    it("stops checking once an update has downloaded, so a newer one cannot replace it", async () => {
      const { updater } = checking()
      await vi.advanceTimersByTimeAsync(firstCheckMs)
      updater.emit("update-downloaded", { version: "1.2.3" })
      await vi.advanceTimersByTimeAsync(checkIntervalMs * 3)
      expect(updater.checks).toBe(1)
    })

    it("downloads an update it finds, and nothing more once one has downloaded", () => {
      const { updater } = checking()
      updater.emit("update-available", { version: "1.2.3" })
      expect(updater.downloads).toHaveLength(1)
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("update-available", { version: "1.3.0" })
      expect(updater.downloads).toHaveLength(1)
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
        expect(offered).toEqual([["ready", "1.3.0", []]])
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
      updater.emit("error", new Error("pkexec was dismissed"))
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
      updater.emit("error", new Error("no polkit agent"))
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
      updater.emit("update-available", { version: "1.3.0", releaseNotes: null })
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

    it("applies from the next launch once an update has downloaded, which ended the schedule", async () => {
      const checks = checking()
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
