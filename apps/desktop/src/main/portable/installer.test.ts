import type { PortableInstall, PortableState } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { vi } from "vitest"

import { installAppChannel, portableChannel } from "../../bridge.js"
import { context, describe, expect, it } from "../../test"
import type { InstalledCopy } from "../install/linux"
import {
  portableInstaller,
  registerPortableIpc,
  type PortableHost,
  type PlatformInstall,
} from "./installer"

// A host that records what it was asked, in order.
const hosting = (overrides: Partial<PortableHost> = {}) => {
  const calls: string[] = []
  const states: PortableState[] = []
  const host: PortableHost = {
    portable: true,
    version: "1.0.0",
    run: "run-1",
    uncheckedAdvice: "Try again, or reinstall Novadeck with install.sh.",
    find: async () => [],
    install: async (target, progress): Promise<PlatformInstall> => {
      calls.push(`install${target ? ` over ${target}` : ""}`)
      progress({ phase: "installing" })
      return { kind: "installed", image: "/i/novadeck.AppImage" }
    },
    changed: (state) => void states.push(state),
    stopping: () => false,
    log: () => {},
    ...overrides,
  }
  return { host, calls, states }
}

// The install phases the pages were told of, in order.
const phases = (states: readonly PortableState[]): PortableInstall[] =>
  states.flatMap((state) => (state.portable ? [state.install] : []))

const copy = (version: string | undefined, unchecked = false): InstalledCopy => ({
  image: "/n/novadeck.AppImage",
  version,
  unchecked,
})

describe("what a portable copy reports", () => {
  it("is portable, with this build's version, and has not installed yet", () => {
    expect(portableInstaller(hosting().host).state()).toEqual({
      portable: true,
      version: "1.0.0",
      run: "run-1",
      install: { phase: "idle" },
    })
  })

  it("holds where the workspace is", () => {
    const { host } = hosting({ dataFolder: "~/.config/novadeck" })
    expect(portableInstaller(host).state()).toMatchObject({ dataFolder: "~/.config/novadeck" })
  })

  it("is not portable for an installed copy", () => {
    expect(portableInstaller(hosting({ portable: false }).host).state()).toEqual({
      portable: false,
    })
  })
})

describe("installing from a portable copy", () => {
  it("installs this very file, ends installed and tells the pages each step, quitting nothing", async () => {
    const { host, calls, states } = hosting()
    const installer = portableInstaller(host)
    await installer.install()
    expect(calls).toEqual(["install"])
    expect(phases(states)).toEqual([{ phase: "installing" }, { phase: "installed" }])
    expect(installer.state()).toEqual({
      portable: true,
      version: "1.0.0",
      run: "run-1",
      install: { phase: "installed" },
    })
  })

  it("tells the pages each new percent of the platform's download once", async () => {
    const { host, states } = hosting({
      install: async (_target, progress) => {
        progress({ phase: "downloading", percent: 0 })
        progress({ phase: "downloading", percent: 50 })
        progress({ phase: "downloading", percent: 50 })
        progress({ phase: "installing" })
        return { kind: "installed", image: "/i/novadeck.AppImage" }
      },
    })
    await portableInstaller(host).install()
    expect(phases(states)).toEqual([
      { phase: "installing" },
      { phase: "downloading", percent: 0 },
      { phase: "downloading", percent: 50 },
      { phase: "installing" },
      { phase: "installed" },
    ])
  })

  it("replaces an installed copy that is the same or older", async () => {
    const runs = ["1.0.0", "0.9.0", undefined].map(async (version) => {
      const { host, calls, states } = hosting({ find: async () => [copy(version)] })
      await portableInstaller(host).install()
      return { calls, states }
    })
    for (const { calls, states } of await Promise.all(runs)) {
      expect(phases(states).at(-1)).toEqual({ phase: "installed" })
      expect(calls[0]).toBe("install over /n/novadeck.AppImage")
    }
  })

  it("replaces the installer's copy before Homebrew's, and makes no second copy", async () => {
    const both = [
      { image: "/c/novadeck.AppImage", version: "1.0.0", unchecked: false },
      { image: "/b/novadeck.AppImage", version: "0.9.0", unchecked: false },
    ]
    const { host, calls } = hosting({ find: async () => both })
    await portableInstaller(host).install()
    expect(calls).toEqual(["install over /c/novadeck.AppImage"])
    const brew = hosting({ find: async () => both.slice(1) })
    await portableInstaller(brew.host).install()
    expect(brew.calls[0]).toBe("install over /b/novadeck.AppImage")
  })

  it("does nothing while an install is under way, or after it ended installed", async () => {
    const { host, calls, states } = hosting()
    const installer = portableInstaller(host)
    await Promise.all([installer.install(), installer.install()])
    await installer.install()
    expect(calls).toEqual(["install"])
    expect(phases(states)).toEqual([{ phase: "installing" }, { phase: "installed" }])
  })

  it("does nothing while it downloads or installs", async () => {
    let finish: () => void = () => {}
    const { host, calls } = hosting({
      install: (_target, progress) => {
        progress({ phase: "downloading", percent: 10 })
        return new Promise((resolve) => {
          finish = () => resolve({ kind: "installed", image: "/i/novadeck.AppImage" })
        })
      },
    })
    const installer = portableInstaller(host)
    const first = installer.install()
    await vi.waitFor(() =>
      expect(installer.state()).toMatchObject({ install: { phase: "downloading" } }),
    )
    await installer.install()
    expect(calls).toEqual([])
    finish()
    await first
    expect(installer.state()).toMatchObject({ install: { phase: "installed" } })
  })

  it("starts over after a failure", async () => {
    let attempts = 0
    const { host, states } = hosting({
      install: async () => {
        attempts += 1
        return attempts === 1
          ? { kind: "failed", reason: "No." }
          : { kind: "installed", image: "/i/novadeck.AppImage" }
      },
    })
    const installer = portableInstaller(host)
    await installer.install()
    expect(installer.state()).toMatchObject({ install: { phase: "failed", reason: "No." } })
    await installer.install()
    expect(installer.state()).toMatchObject({ install: { phase: "installed" } })
    expect(phases(states)).toEqual([
      { phase: "installing" },
      { phase: "failed", reason: "No." },
      { phase: "installing" },
      { phase: "installed" },
    ])
  })

  it("tells the pages again when a retry fails for the same reason", async () => {
    const { host, states } = hosting({
      install: async () => ({ kind: "failed", reason: "No." }),
    })
    const installer = portableInstaller(host)
    await installer.install()
    await installer.install()
    expect(phases(states)).toEqual([
      { phase: "installing" },
      { phase: "failed", reason: "No." },
      { phase: "installing" },
      { phase: "failed", reason: "No." },
    ])
  })

  it("goes on installing when telling a page throws", async () => {
    const logged: string[] = []
    const { host, calls } = hosting({
      changed: () => {
        throw new Error("gone")
      },
      log: (message) => void logged.push(message),
    })
    const installer = portableInstaller(host)
    await installer.install()
    expect(calls).toEqual(["install"])
    expect(installer.state()).toMatchObject({ install: { phase: "installed" } })
    expect(logged.length).toBeGreaterThan(0)
  })

  it("tells the pages it is installing at once, before the platform reports a step", async () => {
    let release: () => void = () => {}
    const { host, states } = hosting({
      find: () => new Promise((resolve) => (release = () => resolve([]))),
    })
    const done = portableInstaller(host).install()
    expect(phases(states)).toEqual([{ phase: "installing" }])
    release()
    await done
  })

  it("leaves a newer installed copy alone and says which version it is, then does nothing more", async () => {
    const { host, calls, states } = hosting({ find: async () => [copy("1.1.0")] })
    const installer = portableInstaller(host)
    await installer.install()
    await installer.install()
    expect(phases(states)).toEqual([{ phase: "installing" }, { phase: "newer", version: "1.1.0" }])
    expect(calls).toEqual([])
  })

  it("passes on a newer copy the platform found while installing, writing nothing here", async () => {
    const { host, states } = hosting({ install: async () => ({ kind: "newer", version: "1.2.0" }) })
    await portableInstaller(host).install()
    expect(phases(states)).toEqual([{ phase: "installing" }, { phase: "newer", version: "1.2.0" }])
  })

  it("passes a failure's reason through, and keeps running", async () => {
    const { host, states } = hosting({
      install: async () => ({ kind: "failed", reason: "There is no space left on the disk." }),
    })
    await portableInstaller(host).install()
    expect(phases(states)).toEqual([
      { phase: "installing" },
      { phase: "failed", reason: "There is no space left on the disk." },
    ])
  })

  it("fails, and logs, when installing throws", async () => {
    const logged: string[] = []
    const { host, states } = hosting({
      install: () => Promise.reject(new Error("boom")),
      log: (message) => void logged.push(message),
    })
    await portableInstaller(host).install()
    expect(phases(states)).toEqual([
      { phase: "installing" },
      { phase: "failed", reason: "Something went wrong." },
    ])
    expect(logged).toEqual(["Installing failed."])
  })

  it("installs nothing from a copy that is not portable", async () => {
    const { host, calls, states } = hosting({ portable: false })
    await portableInstaller(host).install()
    expect(calls).toEqual([])
    expect(states).toEqual([])
  })

  it("does not replace an installed copy that could not be looked at", async () => {
    const logged: string[] = []
    const { host, calls, states } = hosting({
      find: async () => [copy(undefined, true)],
      log: (message) => void logged.push(message),
    })
    await portableInstaller(host).install()
    const end = phases(states).at(-1)
    expect(end).toMatchObject({ phase: "failed" })
    expect(end?.phase === "failed" && end.reason).toContain("could not be checked")
    expect(end?.phase === "failed" && end.reason).toContain("install.sh")
    expect(calls).toEqual([])
    expect(logged).toHaveLength(1)
  })

  it("replaces an installed copy that names no version", async () => {
    const { host, calls, states } = hosting({ find: async () => [copy(undefined)] })
    await portableInstaller(host).install()
    expect(phases(states).at(-1)).toEqual({ phase: "installed" })
    expect(calls[0]).toBe("install over /n/novadeck.AppImage")
  })

  context("when the app is already quitting", () => {
    it("installs nothing and says so", async () => {
      const { host, calls, states } = hosting({ stopping: () => true })
      await portableInstaller(host).install()
      expect(phases(states)).toEqual([
        { phase: "installing" },
        { phase: "failed", reason: "Novadeck is quitting." },
      ])
      expect(calls).toEqual([])
    })
  })

  context("when the app starts quitting while the installed copy is looked for", () => {
    it("installs nothing", async () => {
      let quitting = false
      const { host, calls, states } = hosting({
        find: async () => {
          quitting = true
          return []
        },
        stopping: () => quitting,
      })
      await portableInstaller(host).install()
      expect(phases(states)).toEqual([
        { phase: "installing" },
        { phase: "failed", reason: "Novadeck is quitting." },
      ])
      expect(calls).toEqual([])
    })
  })
})

describe("answering the app's pages", () => {
  type Handler = (event: unknown) => unknown
  const registered = (known: boolean, overrides: Partial<PortableHost> = {}) => {
    const handlers = new Map<string, Handler>()
    const logged: string[] = []
    const { host, calls, states } = hosting(overrides)
    const installer = portableInstaller(host)
    registerPortableIpc(
      {
        handle: (channel, listener) => void handlers.set(channel, listener as Handler),
        on: (channel, listener) => void handlers.set(channel, listener as Handler),
      },
      {
        window: () => (known ? "window" : undefined),
        installer,
        log: (message) => void logged.push(message),
      },
    )
    const ask = (channel: string): unknown =>
      handlers.get(channel)!({} as IpcMainEvent & IpcMainInvokeEvent)
    return { ask, calls, states, handlers, installer, logged }
  }

  it("tells the app's own page whether the copy is portable and how the install stands, and installs for it", async () => {
    const { ask, calls, states } = registered(true)
    expect(await ask(portableChannel)).toEqual({
      portable: true,
      version: "1.0.0",
      run: "run-1",
      install: { phase: "idle" },
    })
    expect(ask(installAppChannel)).toBeUndefined()
    await vi.waitFor(() => expect(phases(states).at(-1)).toEqual({ phase: "installed" }))
    expect(calls[0]).toBe("install")
    expect(await ask(portableChannel)).toMatchObject({ install: { phase: "installed" } })
  })

  it("logs, and does not throw, when the installer throws", async () => {
    const logged: string[] = []
    const handlers = new Map<string, Handler>()
    registerPortableIpc(
      {
        handle: () => {},
        on: (channel, listener) => void handlers.set(channel, listener as Handler),
      },
      {
        window: () => "window",
        installer: {
          state: () => ({ portable: false }),
          install: () => {
            throw new Error("gone")
          },
        },
        log: (message) => void logged.push(message),
      },
    )
    expect(() => handlers.get(installAppChannel)!({})).not.toThrow()
    expect(logged).toEqual(["Installing failed."])
  })

  it("has no channel to open an installed copy", () => {
    expect(registered(true).handlers.size).toBe(2)
  })

  it("tells any other sender the copy is not portable, and installs nothing for it", async () => {
    const { ask, calls, states } = registered(false)
    expect(await ask(portableChannel)).toEqual({ portable: false })
    expect(ask(installAppChannel)).toBeUndefined()
    await Promise.resolve()
    expect(calls).toEqual([])
    expect(states).toEqual([])
  })
})
