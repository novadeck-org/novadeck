import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { UpdateChannel, UpdateOffer } from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import {
  allowUpdatesChannel,
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
  checkHeaders,
  checkIntervalMs,
  developerIdSigned,
  feedUrl,
  firstCheckMs,
  githubConfirmMs,
  retryCheckMs,
  installOnlyOnOrderlyQuit,
  portableOf,
  quitWithoutInstalling,
  registerUpdateIpc,
  switchCheckMs,
  trackOffer,
  updatePlan,
  type CheckFacts,
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
  windowsInstalled: true,
  bundleSwap: undefined,
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
        allow: false,
      })
    })

    it("only tells of updates when the folder of an installed AppImage cannot be written to", () => {
      expect(updatePlan(build({ ...appImage, appImageWritable: false }))).toEqual({
        kind: "appimage",
        mode: "tell",
        allow: false,
      })
    })

    it("only tells of updates when the AppImage is portable, even in a folder it can write to", () => {
      expect(updatePlan(build({ ...appImage, appImageInstalled: false }))).toEqual({
        kind: "appimage",
        mode: "tell",
        allow: false,
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
        allow: false,
      })
    })

    it("only tells for a copy the installer did not make, and never installs", () => {
      const zip = build({ platform: "win32", windowsInstalled: false })
      expect(updatePlan(zip)).toEqual({ kind: "nsis", mode: "tell", allow: false })
      expect(updatePlan({ ...zip, signed: true })?.mode).toBe("tell")
    })

    it("is not portable when the installer made the copy, and still installs", () => {
      expect(updatePlan(build({ platform: "win32", windowsInstalled: true }))).toEqual({
        kind: "nsis",
        mode: "install",
        allow: false,
      })
    })

    it("does not look for updates from a ZIP copy that looks for none", () => {
      const zip = { platform: "win32", windowsInstalled: false } as const
      expect(updatePlan(build({ ...zip, version: "0.0.0" }))).toBeUndefined()
      expect(updatePlan(build({ ...zip, env: { NOVADECK_UPDATES: "off" } }))).toBeUndefined()
      expect(updatePlan(build({ ...zip, packaged: false }))).toBeUndefined()
    })
  })

  context("on macOS", () => {
    const installed = { platform: "darwin", inApplications: true } as const

    it("installs when the app is Developer ID signed and its bundle can be replaced", () => {
      for (const bundleSwap of ["whole", "contents"] as const)
        expect(updatePlan(build({ ...installed, signed: true, bundleSwap }))).toEqual({
          kind: "mac",
          mode: "install",
          allow: false,
        })
    })

    it("only tells when its bundle can't be written, which an administrator may allow", () => {
      expect(updatePlan(build({ ...installed, signed: true }))).toEqual({
        kind: "mac",
        mode: "tell",
        allow: true,
      })
    })

    it("only tells of updates when it is not signed, writable or not", () => {
      for (const bundleSwap of ["whole", undefined] as const)
        expect(updatePlan(build({ ...installed, bundleSwap }))).toEqual({
          kind: "mac",
          mode: "tell",
          allow: false,
        })
    })

    it("only tells, signed or not, when it runs outside Applications, and is portable", () => {
      for (const signed of [true, false])
        expect(
          updatePlan(
            build({ platform: "darwin", signed, inApplications: false, bundleSwap: "whole" }),
          ),
        ).toEqual({
          kind: "mac",
          mode: "tell",
          allow: false,
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

  context("on Windows", () => {
    it("is a packaged copy the installer did not make", () => {
      expect(portableOf(build({ platform: "win32", windowsInstalled: false }))).toBe(true)
      expect(portableOf(build({ platform: "win32", windowsInstalled: true }))).toBe(false)
    })

    it("is not a build that looks for no updates", () => {
      const zip = { platform: "win32", windowsInstalled: false } as const
      expect(portableOf(build({ ...zip, version: "0.0.0" }))).toBe(false)
      expect(portableOf(build({ ...zip, env: { NOVADECK_UPDATES: "off" } }))).toBe(false)
      expect(portableOf(build({ ...zip, packaged: false }))).toBe(false)
    })
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
    offers.offer({ kind: "ready", version: "1.2.3" })
    const offer = { kind: "ready", version: "1.2.3" }
    expect(first.sent).toEqual([[updateOfferChannel, offer]])
    expect(second.sent).toEqual([[updateOfferChannel, offer]])
    expect(offers.current()).toEqual(offer)
  })

  it("tells a page that asks later, and nothing before there is an offer", () => {
    const late = page()
    const offers = trackOffer<ReturnType<typeof page>>(() => [])
    offers.request(late)
    expect(late.sent).toEqual([])
    offers.offer({ kind: "available", version: "1.2.3" })
    offers.request(late)
    expect(late.sent).toEqual([[updateOfferChannel, { kind: "available", version: "1.2.3" }]])
  })

  it("tells pages of a newer version, but not again of the one they know", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer({ kind: "available", version: "1.2.3" })
    offers.offer({ kind: "available", version: "1.2.3" })
    offers.offer({ kind: "available", version: "1.3.0" })
    expect(open.sent.map(([, offer]) => (offer as { version: string }).version)).toEqual([
      "1.2.3",
      "1.3.0",
    ])
  })

  it("tells pages each percent a download reaches once, and carries it only for a download", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer({ kind: "downloading", version: "1.2.3", percent: 0 })
    offers.offer({ kind: "downloading", version: "1.2.3", percent: 0 })
    offers.offer({ kind: "downloading", version: "1.2.3", percent: 7 })
    offers.offer({ kind: "downloading", version: "1.2.3", percent: 7 })
    offers.offer({ kind: "ready", version: "1.2.3", percent: 100 } as UpdateOffer)
    expect(open.sent.map(([, offer]) => offer)).toEqual([
      { kind: "downloading", version: "1.2.3", percent: 0 },
      { kind: "downloading", version: "1.2.3", percent: 7 },
      { kind: "ready", version: "1.2.3" },
    ])
  })

  it("tells pages when the release is no longer one an administrator can allow, and back", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer({ kind: "available", version: "1.2.3", allow: true })
    offers.offer({ kind: "available", version: "1.2.3" })
    offers.offer({ kind: "available", version: "1.2.3" })
    offers.offer({ kind: "available", version: "1.2.3", allow: true })
    expect(open.sent.map(([, offer]) => offer)).toEqual([
      { kind: "available", version: "1.2.3", allow: true },
      { kind: "available", version: "1.2.3" },
      { kind: "available", version: "1.2.3", allow: true },
    ])
  })

  it("tells pages when a ready update could not be installed after all", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer({ kind: "ready", version: "1.2.3" })
    offers.offer({ kind: "available", version: "1.2.3" })
    expect(offers.current()?.kind).toBe("available")
    expect(open.sent).toHaveLength(2)
  })

  it("remembers and tells nothing that is not a version", () => {
    const open = page()
    const offers = trackOffer(() => [open])
    offers.offer({ kind: "ready", version: "latest; rm -rf" })
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
      openPage: () => void calls.push("open page"),
      allow: () => void calls.push("allow"),
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

  it("opens the release page when asked", () => {
    const { send, calls } = registered(true)
    send(openUpdatePageChannel)
    expect(calls).toEqual(["open page"])
  })

  it("lets the copy install updates itself when asked", () => {
    const { send, calls } = registered(true)
    send(allowUpdatesChannel)
    expect(calls).toEqual(["allow"])
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
    send(openUpdatePageChannel)
    send(allowUpdatesChannel)
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
  install(): boolean {
    this.installed += 1
    return true
  }
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false
  requestHeaders: Record<string, string> | null = null
  logger: Updater["logger"] = null
  checks = 0
  failing = false
  feed: Parameters<Updater["setFeedURL"]>[0] | undefined
  /** The feed and headers each check was made with. */
  seen: { feed: Parameters<Updater["setFeedURL"]>[0] | undefined; headers: unknown }[] = []
  /** Whether a check on this feed fails, as when the network or the website is down. */
  failFeed: (feed: Parameters<Updater["setFeedURL"]>[0] | undefined) => boolean = () => false
  /** Whether a check that finds no release says so, as electron-updater's does. */
  upToDate = false
  /** The release each feed says is newest; none says there is nothing new. */
  newest: (feed: Parameters<Updater["setFeedURL"]>[0] | undefined) => string | undefined = () =>
    undefined
  setFeedURL(feed: Parameters<Updater["setFeedURL"]>[0]): void {
    this.feed = feed
  }
  checkForUpdates(): Promise<unknown> {
    this.checks += 1
    this.seen.push({ feed: this.feed, headers: this.requestHeaders && { ...this.requestHeaders } })
    if (this.newest(this.feed) !== undefined)
      this.emit("update-available", { version: this.newest(this.feed) })
    else if (this.upToDate && !this.failFeed(this.feed)) this.emit("update-not-available")
    if (this.failFeed(this.feed)) {
      const error = new Error("unreachable")
      this.emit("error", error)
      return Promise.reject(error)
    }
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
      prepare?: (update: { readonly version: string; readonly file: string }) => Promise<void>
      rejected?: (error: unknown) => boolean
      failedVersion?: string
      allow?: boolean
      feed?: Parameters<typeof checkForUpdates>[1]["feed"]
    } = {},
  ) => {
    const updater = new FakeUpdater()
    const offered: [string, string, number?][] = []
    const failed: string[] = []
    const started: string[] = []
    const logged: string[] = []
    const allowed: boolean[] = []
    const checks = checkForUpdates(updater as unknown as Updater, {
      mode: options.mode ?? "install",
      channel: options.channel ?? "stable",
      failedVersion: options.failedVersion,
      allow: options.allow,
      feed: options.feed,
      prepare: options.prepare,
      rejected: options.rejected,
      offer: (offer) => {
        if (offer.kind === "available") allowed.push(offer.allow === true)
        offered.push(
          offer.kind === "downloading"
            ? [offer.kind, offer.version, offer.percent]
            : [offer.kind, offer.version],
        )
      },
      installStarted: (version) => void started.push(version),
      installFailed: (version) => void failed.push(version),
      log: (message) => void logged.push(message),
    })
    return { updater, offered, failed, started, logged, allowed, ...checks }
  }

  // A macOS `prepare` the test settles, which hears each download it is given.
  const preparing = () => {
    const given: { version: string; file: string; settle: ReturnType<typeof deferred<void>> }[] = []
    return {
      given,
      prepare: (update: { readonly version: string; readonly file: string }) => {
        const settle = deferred<void>()
        given.push({ ...update, settle })
        return settle.promise
      },
    }
  }

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
    it("offers the update as ready once downloaded", () => {
      const { updater, offered } = checking()
      const info = { version: "1.2.3" }
      updater.emit("update-available", info)
      updater.emit("download-progress", { percent: 0 })
      expect(offered).toEqual([["downloading", "1.2.3", 0]])
      updater.emit("update-downloaded", info)
      expect(offered).toEqual([
        ["downloading", "1.2.3", 0],
        ["ready", "1.2.3"],
      ])
    })

    it("offers a download already on disk from an earlier launch as ready, without progress", () => {
      const { updater, offered } = checking()
      updater.emit("update-available", { version: "1.2.3" })
      expect(offered).toEqual([])
      updater.emit("update-downloaded", { version: "1.2.3" })
      expect(offered).toEqual([["ready", "1.2.3"]])
    })

    context("on macOS, where the host puts the update in place itself", () => {
      const downloaded = { version: "1.2.3", downloadedFile: "/cache/update.zip" }

      it("hands no download to Squirrel.Mac, which installs only while this is on", () => {
        expect(checking({ prepare: preparing().prepare }).updater.autoInstallOnAppQuit).toBe(false)
      })

      it("offers the update as ready only once prepared, downloading until then", async () => {
        const { given, prepare } = preparing()
        const { updater, offered } = checking({ prepare })
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("download-progress", { percent: 99.6 })
        updater.emit("update-downloaded", downloaded)
        expect(given.map(({ version, file }) => [version, file])).toEqual([
          ["1.2.3", "/cache/update.zip"],
        ])
        expect(offered).toEqual([["downloading", "1.2.3", 99]])
        given[0]?.settle.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(offered.at(-1)).toEqual(["ready", "1.2.3"])
      })

      it("counts a download it could not prepare as a failed install, told of from then on", async () => {
        const { given, prepare } = preparing()
        const { updater, offered, failed, logged } = checking({ prepare })
        updater.emit("update-downloaded", downloaded)
        given[0]?.settle.reject(new Error("Not signed by the same team."))
        await vi.advanceTimersByTimeAsync(0)
        expect(failed).toEqual(["1.2.3"])
        expect(offered).toEqual([["available", "1.2.3"]])
        expect(logged).toEqual(["Preparing the update failed."])
      })

      it("does not download a release it rejected again in the same run", async () => {
        const { given, prepare } = preparing()
        const { updater } = checking({ prepare })
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("update-downloaded", downloaded)
        given[0]?.settle.reject(new Error("Not signed by the same team."))
        await vi.advanceTimersByTimeAsync(0)
        updater.emit("update-available", { version: "1.2.3" })
        expect(updater.downloads).toHaveLength(1)
      })

      it("tries a download it could not prepare for another reason again, marking nothing", async () => {
        const { given, prepare } = preparing()
        const { updater, offered, failed } = checking({ prepare, rejected: () => false })
        await vi.advanceTimersByTimeAsync(firstCheckMs)
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("update-downloaded", downloaded)
        given[0]?.settle.reject(new Error("No space left on the disk."))
        await vi.advanceTimersByTimeAsync(0)
        expect(failed).toEqual([])
        expect(offered.at(-1)).toEqual(["retrying", "1.2.3"])
        await vi.advanceTimersByTimeAsync(retryCheckMs)
        expect(updater.checks).toBe(2)
        updater.emit("update-available", { version: "1.2.3" })
        expect(updater.downloads).toHaveLength(2)
        // Failing again, it is told of, for the person to fetch.
        updater.emit("update-downloaded", downloaded)
        given[1]?.settle.reject(new Error("No space left on the disk."))
        await vi.advanceTimersByTimeAsync(0)
        expect(offered.at(-1)).toEqual(["available", "1.2.3"])
        expect(failed).toEqual([])
      })

      it("fails to prepare a download that names no file", async () => {
        const { prepare } = preparing()
        const { updater, failed } = checking({ prepare })
        updater.emit("update-downloaded", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(0)
        expect(failed).toEqual(["1.2.3"])
      })

      it("does not download the release it is preparing again", () => {
        const { prepare } = preparing()
        const { updater } = checking({ prepare })
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("update-downloaded", downloaded)
        updater.emit("update-available", { version: "1.2.3" })
        expect(updater.downloads).toHaveLength(1)
      })

      it("lets a download go that a newer one replaced while it was prepared", async () => {
        const { given, prepare } = preparing()
        const { updater, offered } = checking({ prepare })
        updater.emit("update-downloaded", downloaded)
        updater.emit("update-downloaded", { version: "1.3.0", downloadedFile: "/cache/update.zip" })
        given[0]?.settle.resolve()
        given[1]?.settle.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([["ready", "1.3.0"]])
      })

      it("keeps checking once an update is ready, so a newer release replaces it", async () => {
        const { given, prepare } = preparing()
        const { updater } = checking({ prepare })
        await vi.advanceTimersByTimeAsync(firstCheckMs)
        updater.emit("update-downloaded", downloaded)
        given[0]?.settle.resolve()
        await vi.advanceTimersByTimeAsync(checkIntervalMs)
        expect(updater.checks).toBe(2)
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(1)
      })
    })

    context("while it downloads", () => {
      it("offers each whole percent of progress once, as it changes", () => {
        const { updater, offered } = checking()
        updater.emit("update-available", { version: "1.2.3" })
        for (const percent of [0.4, 0.9, 1, 1.5, 1.99, 2, 57.3, 100])
          updater.emit("download-progress", { percent })
        expect(offered.map(([, , percent]) => percent)).toEqual([0, 1, 2, 57, 100])
        expect(offered.every(([kind]) => kind === "downloading")).toBe(true)
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
          ["downloading", "1.2.3", 10],
          ["ready", "1.2.3"],
        ])
      })

      it("offers it as retrying when the first download fails partway, which the error event logs", async () => {
        const { updater, offered, failed, logged } = checking()
        const download = deferred<unknown>()
        updater.downloadResult = () => download.promise
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("download-progress", { percent: 30 })
        updater.emit("error", new Error("download failed"))
        download.reject(new Error("download failed"))
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([
          ["downloading", "1.2.3", 30],
          ["retrying", "1.2.3"],
        ])
        expect(logged).toEqual(["The update check failed."])
        expect(failed).toEqual([])
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

      it("offers it as available once the early retry fails too, and as downloading again when one gets going", async () => {
        const { updater, offered } = checking()
        updater.downloadResult = () => Promise.reject(new Error("download failed"))
        updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(retryCheckMs)
        expect(offered).toEqual([])
        updater.emit("update-available", { version: "1.2.3" })
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([["available", "1.2.3"]])
        updater.downloadResult = () => new Promise(() => {})
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("download-progress", { percent: 5 })
        expect(offered.at(-1)).toEqual(["downloading", "1.2.3", 5])
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
        const { updater, offered } = checking()
        const download = deferred<unknown>()
        updater.downloadResult = () => download.promise
        updater.emit("update-available", { version: "1.2.3" })
        updater.emit("update-downloaded", { version: "1.2.3" })
        download.reject(new Error("the blockmap could not be copied"))
        await vi.advanceTimersByTimeAsync(0)
        expect(offered.at(-1)).toEqual(["ready", "1.2.3"])
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
        expect(offered).toEqual([["ready", "1.2.3"]])
        updater.emit("download-progress", { percent: 0 })
        updater.emit("download-progress", { percent: 40.2 })
        updater.emit("update-downloaded", { version: "1.3.0" })
        download.resolve(undefined)
        await vi.advanceTimersByTimeAsync(0)
        expect(offered).toEqual([
          ["ready", "1.2.3"],
          ["downloading", "1.3.0", 0],
          ["downloading", "1.3.0", 40],
          ["ready", "1.3.0"],
        ])
      })

      it("still installs the waiting one on quit until it is in", () => {
        const { updater } = waiting()
        expect(updater.autoInstallOnAppQuit).toBe(true)
      })

      it("leaves a release found meanwhile to a later check", () => {
        const { updater } = waiting()
        updater.emit("update-available", { version: "1.4.0" })
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(1)
      })

      it("offers it as retrying when its download fails, and downloads it at a later check", async () => {
        const { updater, offered, failed, logged, download } = waiting()
        // electron-updater reports the failure through the error event before it rejects.
        updater.emit("error", new Error("download failed"))
        download.reject(new Error("download failed"))
        await vi.advanceTimersByTimeAsync(0)
        // The ready update is likely gone, so the page hears even without any progress.
        expect(offered).toEqual([
          ["ready", "1.2.3"],
          ["retrying", "1.3.0"],
        ])
        expect(logged).toEqual(["The update check failed."])
        expect(failed).toEqual([])
        updater.downloadResult = undefined
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(2)
        updater.emit("update-downloaded", { version: "1.3.0" })
        expect(offered.at(-1)).toEqual(["ready", "1.3.0"])
      })
    })

    it("downloads nothing once stopped", () => {
      const { updater, stop } = checking()
      stop()
      updater.emit("update-available", { version: "1.2.3" })
      expect(updater.downloads).toHaveLength(0)
    })

    context("after an install failed on a version", () => {
      it("only tells of that version, without downloading it again", () => {
        const { updater, offered } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-available", {
          version: "1.2.3",
        })
        expect(updater.downloads).toHaveLength(0)
        expect(offered).toEqual([["available", "1.2.3"]])
      })

      it("installs a newer release as usual", () => {
        const { updater, offered } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-available", { version: "1.3.0" })
        expect(updater.downloads).toHaveLength(1)
        updater.emit("update-downloaded", { version: "1.3.0" })
        expect(offered.at(-1)).toEqual(["ready", "1.3.0"])
        expect(updater.autoInstallOnAppQuit).toBe(true)
      })

      it("does not let a late check replace a ready update with the failed one", () => {
        const { updater, offered } = checking({ failedVersion: "1.2.3" })
        updater.emit("update-downloaded", { version: "1.3.0" })
        updater.emit("update-available", { version: "1.2.3" })
        expect(offered).toEqual([["ready", "1.3.0"]])
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
      })
      updater.install()
      updater.emit("error", new Error("the installer failed"))
      expect(failed).toEqual(["1.2.3"])
      expect(updater.autoInstallOnAppQuit).toBe(false)
      expect(offered).toEqual([
        ["ready", "1.2.3"],
        ["available", "1.2.3"],
      ])
      expect(logged).toEqual(["Installing the update failed."])
    })

    it("does not count an error from a check or channel switch that fails after the download", () => {
      const { updater, failed, offered, logged } = checking()
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.emit("error", new Error("offline"))
      expect(failed).toEqual([])
      expect(updater.autoInstallOnAppQuit).toBe(true)
      expect(offered).toEqual([["ready", "1.2.3"]])
      expect(logged).toEqual(["The update check failed."])
    })

    it("tells of the version an install on quitting begins to put in place", () => {
      const { updater, started } = checking()
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.install()
      expect(started).toEqual(["1.2.3"])
      expect(updater.installed).toBe(1)
    })

    it("counts a failed install once, though more errors follow", () => {
      const { updater, failed, logged } = checking()
      updater.emit("update-downloaded", { version: "1.2.3" })
      updater.install()
      updater.emit("error", new Error("could not install"))
      updater.emit("error", new Error("could not install"))
      expect(failed).toEqual(["1.2.3"])
      expect(logged).toEqual(["Installing the update failed."])
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
  })

  context("in tell mode", () => {
    it("offers each release newer than the build as available, ", () => {
      const { updater, offered } = checking({ mode: "tell" })
      updater.emit("update-available", {
        version: "1.2.3",
      })
      updater.emit("update-available", {
        version: "1.3.0",
      })
      expect(offered).toEqual([
        ["available", "1.2.3"],
        ["available", "1.3.0"],
      ])
    })

    it("says an administrator can let the copy install updates itself, where one can", () => {
      const allowing = checking({ mode: "tell", allow: true })
      allowing.updater.emit("update-available", { version: "1.2.3" })
      const plain = checking({ mode: "tell" })
      plain.updater.emit("update-available", { version: "1.2.3" })
      expect([allowing.allowed, plain.allowed]).toEqual([[true], [false]])
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
      const checks = checking()
      checks.stop()
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

  it("still installs on closing the last window or restarting into an installed copy", () => {
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

const facts: CheckFacts = {
  version: "1.4.0",
  build: "installed",
}
const repository = { owner: "novadeck-org", repo: "novadeck" }
const github = { provider: "github", ...repository }
// How a check through novadeck.dev is set up: no multipart ranges, as the website sends the
// files on to GitHub, which does not serve them.
const generic = (url: string) => ({ provider: "generic", url, useMultipleRangeRequest: false })

describe("the update feed", () => {
  it("is the channel's address on novadeck.dev, or on the site NOVADECK_UPDATE_URL names", () => {
    expect(feedUrl("stable")).toBe("https://novadeck.dev/update/stable/")
    expect(feedUrl("early")).toBe("https://novadeck.dev/update/early/")
    expect(feedUrl("early", "http://127.0.0.1:8787/ignored")).toBe(
      "http://127.0.0.1:8787/update/early/",
    )
    expect(feedUrl("stable", "file:///tmp/updates")).toBe("https://novadeck.dev/update/stable/")
    expect(feedUrl("stable", "https://localhost:8787")).toBe(
      "https://localhost:8787/update/stable/",
    )
    expect(feedUrl("stable", "https://example.test")).toBe("https://novadeck.dev/update/stable/")
    expect(feedUrl("stable", "http://localhost:8787")).toBe("http://localhost:8787/update/stable/")
    expect(feedUrl("stable", "http://[::1]:8787")).toBe("http://[::1]:8787/update/stable/")
    expect(feedUrl("stable", "http://example.test")).toBe("https://novadeck.dev/update/stable/")
    expect(feedUrl("stable", "not an address")).toBe("https://novadeck.dev/update/stable/")
  })

  it("says why the check runs and what copy makes it, and nothing else", () => {
    expect(checkHeaders("launch", facts)).toEqual({
      "x-novadeck-check": "launch",
      "x-novadeck-version": "1.4.0",
      "x-novadeck-build": "installed",
      "x-user-staging-id": "0",
    })
  })

  it("leaves out a version that is not plain text", () => {
    expect(checkHeaders("retry", { ...facts, version: "1.4.0\ny" })).toEqual({
      "x-novadeck-check": "retry",
      "x-novadeck-build": "installed",
      "x-user-staging-id": "0",
    })
  })

  // The library's own per-copy ID is replaced only because its headers go over the ones it
  // makes for a check; the real library is asked, so an update to it that changes this
  // fails here rather than sending the ID to novadeck.dev again.
  it("replaces the update library's per-copy ID, as the library merges a check's headers", () => {
    const require = createRequire(import.meta.url)
    const out = dirname(require.resolve("electron-updater"))
    const { AppUpdater } = require(join(out, "AppUpdater.js")) as {
      AppUpdater: {
        prototype: {
          computeFinalHeaders(this: unknown, headers: Record<string, string>): unknown
          getUpdateInfoAndProvider(): unknown
        }
      }
    }
    const merged = AppUpdater.prototype.computeFinalHeaders.call(
      { requestHeaders: checkHeaders("launch", facts) },
      { "x-user-staging-id": "6c1f5e1e-1111-4222-8333-944455556666" },
    )

    expect(merged).toEqual(checkHeaders("launch", facts))
    // The check's own headers, which the library makes here: the ID, under this name.
    expect(String(AppUpdater.prototype.getUpdateInfoAndProvider)).toMatch(
      /computeFinalHeaders\(\{\s*"x-user-staging-id": stagingUserId\s*\}\)/,
    )
  })
})

describe("checking through novadeck.dev", () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  const checking = (
    options: { channel?: UpdateChannel; mode?: UpdateMode; build?: CheckFacts["build"] } = {},
  ) => {
    const updater = new FakeUpdater()
    const logged: string[] = []
    const checks = checkForUpdates(updater as unknown as Updater, {
      mode: options.mode ?? "install",
      channel: options.channel ?? "stable",
      feed: { repository, facts: { ...facts, build: options.build ?? "installed" } },
      offer: () => {},
      installFailed: () => {},
      log: (message) => void logged.push(message),
    })
    return { updater, logged, ...checks }
  }

  it("checks the channel's address, saying it is the launch's check", async () => {
    const { updater } = checking({ channel: "early" })
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.seen).toEqual([
      {
        feed: generic("https://novadeck.dev/update/early/"),
        headers: expect.objectContaining({ "x-novadeck-check": "launch" }),
      },
    ])
  })

  it("names the trigger of each check: launch, schedule and channel switch", async () => {
    const { updater, setChannel } = checking()
    const reasons = (): (string | undefined)[] =>
      updater.seen.map(
        ({ headers }) => (headers as Record<string, string> | null)?.["x-novadeck-check"],
      )
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    await vi.advanceTimersByTimeAsync(checkIntervalMs)
    setChannel("early")
    await vi.advanceTimersByTimeAsync(switchCheckMs)
    updater.downloadResult = () => Promise.reject(new Error("disk full"))
    updater.emit("update-available", { version: "1.5.0" })
    await vi.advanceTimersByTimeAsync(retryCheckMs)
    // The retry is for a download from novadeck.dev, so it goes to GitHub, without headers.
    expect(reasons()).toEqual(["launch", "interval", "switch", undefined])
  })

  it("follows a channel switch with the new channel's address", async () => {
    const { updater, setChannel } = checking()
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    setChannel("early")
    await vi.advanceTimersByTimeAsync(switchCheckMs)
    setChannel("stable")
    await vi.advanceTimersByTimeAsync(switchCheckMs)
    expect(updater.seen.map(({ feed }) => feed)).toEqual([
      generic("https://novadeck.dev/update/stable/"),
      generic("https://novadeck.dev/update/early/"),
      generic("https://novadeck.dev/update/stable/"),
    ])
  })

  it("checks a portable copy the same way, saying it is portable", async () => {
    const { updater } = checking({ mode: "tell", build: "portable" })
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.seen).toHaveLength(1)
    expect(updater.seen[0]?.headers).toEqual(
      expect.objectContaining({ "x-novadeck-build": "portable" }),
    )
  })

  it("replaces electron-updater's per-install staging id with a constant", async () => {
    const { updater } = checking()
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(Object.keys(updater.seen[0]?.headers as object).toSorted()).toEqual([
      "x-novadeck-build",
      "x-novadeck-check",
      "x-novadeck-version",
      "x-user-staging-id",
    ])
    expect(updater.seen[0]?.headers).toEqual(expect.objectContaining({ "x-user-staging-id": "0" }))
  })

  it("starts no GitHub check when the schedule ended during the novadeck.dev one", async () => {
    const { updater, stop, logged } = checking()
    updater.failFeed = (feed) => feed?.provider === "generic"
    updater.checkForUpdates = () => {
      updater.checks += 1
      stop()
      updater.emit("error", new Error("unreachable"))
      return Promise.reject(new Error("unreachable"))
    }
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.checks).toBe(1)
    expect(logged).not.toContain("The update check through novadeck.dev failed; trying GitHub.")
  })

  it("logs the error of a download under way, not taking it for the check's", async () => {
    const { updater, logged } = checking()
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    updater.downloadResult = () => new Promise(() => {})
    updater.emit("update-available", { version: "1.5.0" })
    let finish: () => void = () => {}
    updater.checkForUpdates = () => new Promise<void>((resolve) => (finish = resolve))
    await vi.advanceTimersByTimeAsync(checkIntervalMs)
    updater.emit("error", new Error("the download broke"))
    expect(logged).toEqual(["The update check failed."])
    finish()
  })

  it("confirms a check that finds nothing against GitHub once a day, without the headers", async () => {
    const { updater } = checking()
    updater.upToDate = true
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.seen.map(({ feed }) => feed)).toEqual([
      generic("https://novadeck.dev/update/stable/"),
      github,
    ])
    expect(updater.seen[1]?.headers).toBeNull()
    // Within the day the website's word stands.
    await vi.advanceTimersByTimeAsync(githubConfirmMs - firstCheckMs - checkIntervalMs)
    expect(updater.seen.every(({ feed }, at) => at < 2 || feed !== github)).toBe(true)
    const before = updater.seen.length
    await vi.advanceTimersByTimeAsync(checkIntervalMs * 2)
    const feeds = updater.seen.slice(before).map(({ feed }) => feed)
    expect(feeds).toContainEqual(github)
    // Each GitHub check is followed by novadeck.dev for the next scheduled one.
    expect(feeds[0]).toEqual(generic("https://novadeck.dev/update/stable/"))
  })

  it("takes an update that only GitHub knows of like any GitHub-found one", async () => {
    const { updater } = checking()
    updater.upToDate = true
    updater.newest = (feed) => (feed?.provider === "github" ? "1.5.0" : undefined)
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.downloads).toHaveLength(1)
  })

  it("makes no confirmation once the schedule has ended", async () => {
    const { updater, stop } = checking()
    updater.checkForUpdates = () => {
      updater.checks += 1
      updater.seen.push({ feed: updater.feed, headers: null })
      stop()
      updater.emit("update-not-available")
      return Promise.resolve()
    }
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.checks).toBe(1)
  })

  it("logs a failed novadeck.dev check once, as it falls back", async () => {
    const { updater, logged } = checking()
    updater.failFeed = (feed) => feed?.provider === "generic"
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(logged).toEqual(["The update check through novadeck.dev failed; trying GitHub."])
  })

  it("makes the same check against GitHub at once when novadeck.dev fails, then returns", async () => {
    const { updater, logged } = checking({ channel: "early" })
    updater.failFeed = (feed) => feed?.provider === "generic"
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.seen.map(({ feed }) => feed)).toEqual([
      generic("https://novadeck.dev/update/early/"),
      github,
    ])
    expect(updater.seen[1]?.headers).toBeNull()
    expect(updater.allowPrerelease).toBe(true)
    expect(logged).toContain("The update check through novadeck.dev failed; trying GitHub.")
    updater.failFeed = () => false
    await vi.advanceTimersByTimeAsync(checkIntervalMs)
    expect(updater.seen.map(({ feed }) => feed).slice(2)).toEqual([
      generic("https://novadeck.dev/update/early/"),
    ])
  })

  it("keeps no headers on the updater once a check is done", async () => {
    const { updater } = checking()
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(updater.requestHeaders).toBeNull()
  })

  it("sends a download's headers to no one", async () => {
    const { updater } = checking()
    let headers: unknown = "unset"
    updater.downloadResult = () => {
      headers = updater.requestHeaders
      return Promise.resolve()
    }
    updater.checkForUpdates = () => {
      updater.emit("update-available", { version: "1.5.0" })
      return Promise.resolve()
    }
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    expect(headers).toBeNull()
  })

  it("retries a download that failed from novadeck.dev against GitHub, then returns", async () => {
    const { updater } = checking()
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    updater.downloadResult = () => Promise.reject(new Error("redirect broke"))
    updater.emit("update-available", { version: "1.5.0" })
    await vi.advanceTimersByTimeAsync(retryCheckMs)
    expect(updater.seen.map(({ feed }) => feed)).toEqual([
      generic("https://novadeck.dev/update/stable/"),
      github,
    ])
    await vi.advanceTimersByTimeAsync(checkIntervalMs)
    expect(updater.seen[2]?.feed).toEqual(generic("https://novadeck.dev/update/stable/"))
  })

  it("retries a download that failed from GitHub against novadeck.dev as before", async () => {
    const { updater } = checking()
    updater.failFeed = (feed) => feed?.provider === "generic"
    await vi.advanceTimersByTimeAsync(firstCheckMs)
    updater.failFeed = () => false
    updater.downloadResult = () => Promise.reject(new Error("offline"))
    updater.emit("update-available", { version: "1.5.0" })
    await vi.advanceTimersByTimeAsync(retryCheckMs)
    expect(updater.seen.at(-1)?.feed).toEqual(generic("https://novadeck.dev/update/stable/"))
    expect(updater.seen.at(-1)?.headers).toEqual(
      expect.objectContaining({ "x-novadeck-check": "retry" }),
    )
  })

  it("makes only one check at a time", async () => {
    const { updater } = checking()
    let finish: () => void = () => {}
    updater.checkForUpdates = () => {
      updater.checks += 1
      return new Promise<void>((resolve) => (finish = resolve))
    }
    await vi.advanceTimersByTimeAsync(firstCheckMs + checkIntervalMs)
    expect(updater.checks).toBe(1)
    finish()
  })
})
