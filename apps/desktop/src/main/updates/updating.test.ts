import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { notQuitting } from "../quitting"

const electron = vi.hoisted(() => ({
  calls: [] as string[],
  quitting: undefined as { restart: boolean; reopenWanted: boolean; orderly: boolean } | undefined,
  seen: undefined as { restart: boolean; reopenWanted: boolean; orderly: boolean } | undefined,
  hooks: [] as (() => void)[],
}))

vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.0",
    getPath: () => "/opt/Novadeck.app/Contents/MacOS/Novadeck",
    quit: () => {
      electron.calls.push("quit")
      electron.seen = electron.quitting && { ...electron.quitting }
    },
    relaunch: () => void electron.calls.push("relaunch"),
    once: (_event: string, hook: () => void) => void electron.hooks.push(hook),
  },
}))

// The options the app hands the update schedule, which a test reads the install's answers from.
const schedule = vi.hoisted(() => ({
  options: undefined as { installReturned?: (ran: boolean) => void } | undefined,
}))

vi.mock("electron-updater", () => ({ default: { NsisUpdater: function NsisUpdater() {} } }))
vi.mock("../resources.js", () => ({ releaseRepository: async () => undefined }))
vi.mock("./updater", async (original) => ({
  ...(await original<typeof import("./updater")>()),
  checkForUpdates: (_updater: unknown, options: NonNullable<typeof schedule.options>) => {
    schedule.options = options
    return { stop: () => {}, setChannel: () => {}, installNow: () => false }
  },
}))

const { updating } = await import("./updating")

const realPlatform = process.platform
const realImage = process.env.APPIMAGE
const platformIs = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value: platform })
}

// A build the updater installs on, per system.
const installing = (platform: NodeJS.Platform) => ({
  platform,
  packaged: true,
  version: "1.0.0",
  execPath: platform === "linux" ? "/tmp/.mount_x/novadeck" : "/x/Novadeck",
  env:
    platform === "linux" ? { APPIMAGE: "/home/p/Novadeck.AppImage", APPDIR: "/tmp/.mount_x" } : {},
  appImageInstalled: true,
  appImageWritable: true,
  inApplications: true,
  windowsInstalled: true,
  signed: true,
  bundleSwap: "plain",
})

const made = (platform: NodeJS.Platform, offer: string | null = "ready") => {
  platformIs(platform)
  const quitting = notQuitting()
  electron.quitting = quitting
  const started: string[] = []
  const log = Object.assign(() => {}, {
    info: () => {},
    warn: (line: unknown) => void started.push(`warn ${String(line)}`),
    logger: {},
  })
  const run = updating({
    state: { read: () => ({}) } as never,
    log: log as never,
    offers: { current: () => (offer ? { kind: offer, version: "2.0.0" } : undefined) } as never,
    build: { updateBuild: async () => installing(platform) } as never,
    quitting,
    startBundle: async (bundle) => (started.push(`bundle ${bundle}`), true),
    startInstalledImage: async (image, after) => (started.push(`image ${image} ${after}`), true),
  })
  return { run, quitting, started }
}

beforeEach(() => {
  electron.calls.length = 0
  electron.hooks.length = 0
  electron.seen = undefined
  process.env.APPIMAGE = "/home/p/Novadeck.AppImage"
})
afterEach(() => {
  platformIs(realPlatform)
  if (realImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = realImage
})

describe("restarting into the waiting update", () => {
  it("marks the quit and then quits, for a ready update", async () => {
    const { run, quitting } = made("linux")
    await run.restart()
    expect(electron.calls).toEqual(["quit"])
    expect(electron.seen).toMatchObject({ restart: true, reopenWanted: true, orderly: true })
    expect(quitting.restart).toBe(true)
  })

  it.each(["available", "downloading", null])(
    "leaves the quit alone when the offer is %s",
    async (offer) => {
      const { run, quitting } = made("linux", offer)
      await run.restart()
      expect(quitting).toEqual(notQuitting())
      expect(electron.calls).toEqual([])
    },
  )

  it("watches Windows' own install, which opens the app itself when it starts", async () => {
    const { run } = made("win32")
    await run.restart()
    expect(electron.hooks).toHaveLength(1)
    expect(electron.calls).toEqual(["quit"])
    // No install began: the app opens itself, once electron-updater's own handler has run.
    electron.hooks[0]!()
    expect(electron.calls).toEqual(["quit", "relaunch"])
  })

  it("watches the install once on Windows, however often the person presses it", async () => {
    const { run } = made("win32")
    await run.restart()
    await run.restart()
    expect(electron.hooks).toHaveLength(1)
  })

  describe("on Windows, where the installer is electron-updater's", () => {
    const restarted = async (ran: boolean | undefined) => {
      const { run } = made("win32")
      await run.start()
      await run.restart()
      if (ran !== undefined) schedule.options?.installReturned?.(ran)
      electron.hooks[0]!()
      return electron.calls
    }

    it("opens no second copy beside an installer that started", async () => {
      expect(await restarted(true)).toEqual(["quit"])
    })

    it("opens the current version when the install call returned false", async () => {
      expect(await restarted(false)).toEqual(["quit", "relaunch"])
    })

    it("opens the current version when the install never ran", async () => {
      expect(await restarted(undefined)).toEqual(["quit", "relaunch"])
    })
  })

  it.each(["linux", "darwin"] as const)("does not watch the install on %s", async (platform) => {
    const { run } = made(platform)
    await run.restart()
    expect(electron.hooks).toEqual([])
  })

  it("opens nothing after a logout or shutdown during the restart", async () => {
    const { run, quitting } = made("win32")
    await run.restart()
    run.quitOnSessionEnd()
    expect(quitting.restart).toBe(false)
    expect(quitting.reopenWanted).toBe(false)
    electron.hooks[0]!()
    expect(electron.calls).not.toContain("relaunch")
  })

  it("keeps the app closed on Windows when the runner may still be there", async () => {
    const { run } = made("win32")
    await run.restart()
    run.keepUpdateOnQuit()
    electron.hooks[0]!()
    expect(electron.calls).not.toContain("relaunch")
  })
})

describe("opening the current version after a restart that put nothing in place", () => {
  it("starts the AppImage as it is on Linux", async () => {
    const { run, quitting, started } = made("linux")
    quitting.restart = true
    await run.openCurrentAfterQuit()
    expect(started.at(-1)).toBe(`image /home/p/Novadeck.AppImage ${process.pid}`)
  })

  it("starts the bundle on macOS, as macPlaced is false until an install succeeded", async () => {
    const { run, quitting, started } = made("darwin")
    quitting.restart = true
    await run.openCurrentAfterQuit()
    expect(started.at(-1)).toBe("bundle /opt/Novadeck.app")
  })

  it.each(["linux", "darwin"] as const)("opens nothing on a plain quit on %s", async (platform) => {
    const { run, started } = made(platform)
    await run.openCurrentAfterQuit()
    expect(started).toEqual([])
  })
})
