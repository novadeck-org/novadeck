import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { closeSync, openSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PortableInstall, PortableState } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import { installAppChannel, portableChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import type { InstalledCopy } from "./install-linux"
import {
  closeDescriptors,
  installedEnvironment,
  leaveForNewerInstalled,
  portableInstaller,
  redirectMarker,
  registerPortableIpc,
  startAppImage,
  type InstalledCopyCheck,
  type PortableHost,
  type PlatformInstall,
} from "./portable"

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

describe("a launch of a portable copy", () => {
  const checking = (
    overrides: Partial<InstalledCopyCheck> = {},
    refuse = false,
    recent = false,
  ) => {
    const calls: string[] = []
    const check: InstalledCopyCheck = {
      portable: true,
      version: "1.0.0",
      find: async () => [copy("1.1.0")],
      start: async (image) => {
        calls.push(`start ${image}`)
        return !refuse
      },
      alert: async (image) => void calls.push(`alert ${image}`),
      recentRedirect: () => recent,
      markRedirect: () => void calls.push("mark"),
      quit: () => void calls.push("quit"),
      log: (message) => void calls.push(`log ${message}`),
      ...overrides,
    }
    return { check, calls }
  }

  it("starts a newer installed copy in place of the launch, without asking", async () => {
    const { check, calls } = checking()
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["start /n/novadeck.AppImage"])
  })

  it("starts an installed copy of the same version too", async () => {
    const { check, calls } = checking({ find: async () => [copy("1.0.0")] })
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["mark", "start /n/novadeck.AppImage"])
  })

  it("tells the person and quits when a newer installed copy will not start", async () => {
    const { check, calls } = checking({}, true)
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["start /n/novadeck.AppImage", "alert /n/novadeck.AppImage", "quit"])
  })

  it("carries on, with no alert, when a same-version copy will not start", async () => {
    const { check, calls } = checking({ find: async () => [copy("1.0.0")] }, true)
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(calls).toEqual([
      "mark",
      "start /n/novadeck.AppImage",
      "log The installed copy did not start; carrying on in this one.",
    ])
  })

  it("carries on, starting nothing, when it redirected to a same-version copy moments ago", async () => {
    const { check, calls } = checking({ find: async () => [copy("1.0.0")] }, false, true)
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(calls).toEqual([
      "log Redirected to the installed copy just now; carrying on in this one.",
    ])
  })

  it("still starts a newer copy soon after a redirect", async () => {
    const { check, calls } = checking({}, false, true)
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["start /n/novadeck.AppImage"])
  })

  it("carries on when the installed copy is older, unchecked or none, or this copy is not portable", async () => {
    const runs = [
      { find: async () => [copy("0.9.0"), copy(undefined)] },
      // One that could not be looked at: the runner's refusal of a newer workspace is the fallback.
      { find: async () => [copy(undefined, true)] },
      { find: async () => [] },
      { portable: false },
    ].map(async (overrides) => {
      const { check, calls } = checking(overrides)
      return { left: await leaveForNewerInstalled(check), calls }
    })
    for (const { left, calls } of await Promise.all(runs)) {
      expect(left).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it("carries on, and logs, when the installed copies cannot be looked at", async () => {
    const logged: string[] = []
    const { check } = checking({
      find: () => Promise.reject(new Error("denied")),
      log: (message) => void logged.push(message),
    })
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(logged).toHaveLength(1)
  })
})

describe("the note of a redirect", () => {
  const noting = () => {
    let at: number | undefined
    let clock = 1_000
    const marker = redirectMarker(
      "/data/redirected-at",
      30_000,
      {
        modified: () => {
          if (at === undefined) throw new Error("ENOENT")
          return at
        },
        write: () => void (at = clock),
        remove: () => void (at = undefined),
      },
      () => clock,
      () => {},
    )
    return { marker, tick: (ms: number) => void (clock += ms) }
  }

  it("is recent within the window after a redirect, and not before one", () => {
    const { marker, tick } = noting()
    expect(marker.recent()).toBe(false)
    marker.mark()
    tick(10_000)
    expect(marker.recent()).toBe(true)
    tick(25_000)
    expect(marker.recent()).toBe(false)
  })

  it("is cleared when the installed copy starts, so a relaunch of the portable redirects again", () => {
    const { marker } = noting()
    marker.mark()
    marker.clear()
    expect(marker.recent()).toBe(false)
  })

  it("does not fail when the files cannot be written or removed", () => {
    const marker = redirectMarker(
      "/x",
      30_000,
      {
        modified: () => 0,
        write: () => {
          throw new Error("EACCES")
        },
        remove: () => {
          throw new Error("EACCES")
        },
      },
      () => 1,
      () => {},
    )
    expect(() => (marker.mark(), marker.clear())).not.toThrow()
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

describe("the environment of the installed copy", () => {
  it("lacks the variables the AppImage runtime set for this copy, and keeps the rest", () => {
    expect(
      installedEnvironment(
        {
          APPIMAGE: "/dl/n.AppImage",
          APPDIR: "/tmp/.mount_n",
          OWD: "/home/me",
          ARGV0: "n.AppImage",
          HOME: "/home/me",
          XDG_DATA_HOME: "/data",
        },
        [],
      ),
    ).toEqual({ HOME: "/home/me", XDG_DATA_HOME: "/data" })
  })

  it("drops the entries of the path lists that lie in the mount, however it is named", () => {
    const mounts = ["/tmp/.mount_n", "/private/tmp/.mount_n/"]
    expect(
      installedEnvironment(
        {
          PATH: "/tmp/.mount_n/usr/bin:/tmp/.mount_n/:/usr/bin:/private/tmp/.mount_n/usr/sbin:/bin",
          LD_LIBRARY_PATH: "/tmp/.mount_n/usr/lib:/tmp/.mount_nx/lib",
          XDG_DATA_DIRS: "/tmp/.mount_n/usr/share/:/usr/share",
          GSETTINGS_SCHEMA_DIR: "/tmp/.mount_n/usr/share/glib-2.0/schemas",
          OTHER: "/tmp/.mount_n/usr/bin",
        },
        mounts,
      ),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      // A neighbour whose name only starts alike stays.
      LD_LIBRARY_PATH: "/tmp/.mount_nx/lib",
      XDG_DATA_DIRS: "/usr/share",
      // Other variables are not path lists AppRun extends.
      OTHER: "/tmp/.mount_n/usr/bin",
    })
  })

  it("never takes every entry for a mount of the root, or one that is empty", () => {
    expect(installedEnvironment({ PATH: "/usr/bin" }, ["/", ""])).toEqual({ PATH: "/usr/bin" })
  })
})

const starting = (
  behave: (child: EventEmitter & { unref: () => void }) => void,
  overrides: { runnable?: (path: string) => boolean; throws?: boolean; refused?: boolean } = {},
) => {
  const calls: string[] = []
  const spawned: { file: string; args: readonly string[]; options: unknown }[] = []
  const start = startAppImage({
    image: "/i/novadeck.AppImage",
    env: { APPIMAGE: "/dl/n.AppImage", HOME: "/home/me", PATH: "/tmp/.mount_n/usr/bin:/usr/bin" },
    mounts: ["/tmp/.mount_n"],
    spawn: (file, args, options) => {
      if (overrides.throws) throw new Error("EACCES")
      spawned.push({ file, args, options })
      const child = Object.assign(new EventEmitter(), { unref: () => void calls.push("unref") })
      queueMicrotask(() => behave(child))
      return child
    },
    runnable: overrides.runnable ?? (() => true),
    releaseLock: () => void calls.push("release"),
    reclaimLock: () => (calls.push("reclaim"), !overrides.refused),
    exit: () => void calls.push("exit"),
    log: (message) => void calls.push(`log ${message}`),
  })
  return { start, calls, spawned }
}

describe("starting the installed copy", () => {
  const env = { HOME: "/home/me", PATH: "/usr/bin" }

  it("releases the lock, spawns detached through bash with a clean environment, then exits", async () => {
    const { start, calls, spawned } = starting((child) => child.emit("spawn"))
    expect(await start).toBe(true)
    expect(calls).toEqual(["release", "unref", "exit"])
    expect(spawned).toEqual([
      {
        file: "/bin/bash",
        args: ["-c", closeDescriptors, "/i/novadeck.AppImage"],
        options: { detached: true, stdio: "ignore", env },
      },
    ])
  })

  it("finds bash in /usr/bin when /bin has none", async () => {
    const { start, spawned } = starting((child) => child.emit("spawn"), {
      runnable: (path) => path !== "/bin/bash",
    })
    expect(await start).toBe(true)
    expect(spawned).toMatchObject([
      { file: "/usr/bin/bash", args: ["-c", closeDescriptors, "/i/novadeck.AppImage"] },
    ])
  })

  it("starts the image directly, and says so, when there is no bash", async () => {
    const { start, calls, spawned } = starting((child) => child.emit("spawn"), {
      runnable: (path) => !path.endsWith("/bash"),
    })
    expect(await start).toBe(true)
    expect(spawned).toMatchObject([{ file: "/i/novadeck.AppImage", args: [] }])
    expect(calls).toContain(
      "log Starting the installed copy without bash, so this copy's mount stays while it runs.",
    )
  })

  it("does not exit, and holds the lock again, when the child fails to start", async () => {
    const { start, calls } = starting((child) => child.emit("error", new Error("EACCES")))
    expect(await start).toBe(false)
    expect(calls).toEqual(["release", "log The installed copy did not start.", "reclaim"])
  })

  it("holds the lock again when spawning throws", async () => {
    const { start, calls } = starting(() => {}, { throws: true })
    expect(await start).toBe(false)
    expect(calls).toEqual(["release", "log The installed copy did not start.", "reclaim"])
  })

  it("ends this process when the lock cannot be taken back, as another copy has it", async () => {
    const { start, calls } = starting(() => {}, { throws: true, refused: true })
    expect(await start).toBe(false)
    expect(calls).toContain("exit")
  })

  it("does not spawn a file that is missing or lacks the exec bit", async () => {
    const { start, calls, spawned } = starting(() => {}, { runnable: () => false })
    expect(await start).toBe(false)
    expect(spawned).toEqual([])
    expect(calls).not.toContain("release")
  })
})

// Linux only: it lists descriptors from /proc, as the closer does, and AppImages are Linux's.
describe.skipIf(process.platform !== "linux")("the descriptors of the installed copy", () => {
  let folder: string
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "novadeck-start-test-"))
  })
  afterEach(() => rm(folder, { recursive: true, force: true }))

  // A program that lists its own open descriptors into $OUT, as the installed app would see them.
  const program = async (): Promise<string> => {
    const file = join(folder, "program")
    await writeFile(
      file,
      '#!/bin/bash\nexec > "$OUT"\nfor f in /proc/$$/fd/*; do echo "${f##*/}"; done\n',
      { mode: 0o755 },
    )
    return file
  }

  // Starts the program as the host does, but with descriptors 3 to 12 handed to the child
  // as Chromium leaves them: Node marks its own close-on-exec, so spawn passes these on.
  const descriptorsOf = async (direct: boolean): Promise<string[]> => {
    const image = await program()
    const out = join(folder, direct ? "direct" : "closed")
    const held = Array.from({ length: 10 }, () => openSync(join(folder, "held"), "a"))
    try {
      const started = await startAppImage({
        image,
        env: { OUT: out },
        mounts: [],
        spawn: (file, args, options) =>
          spawn(file, [...args], { ...options, stdio: ["ignore", "ignore", "ignore", ...held] }),
        runnable: (path) => (direct ? !path.endsWith("/bash") : true),
        releaseLock: () => {},
        reclaimLock: () => true,
        exit: () => {},
        log: () => {},
      })
      expect(started).toBe(true)
      await vi.waitFor(async () => expect((await readFile(out, "utf8")).length).toBeGreaterThan(0))
      return (await readFile(out, "utf8")).trim().split("\n")
    } finally {
      for (const fd of held) closeSync(fd)
    }
  }

  // The program's own shell holds 255 for its script and one for the listing; the ten handed on are 4 to 12 (and 3).
  const handedOn = ["4", "5", "6", "7", "8", "9", "10", "11", "12"]

  it("holds none of the descriptors the parent passed on once started through the closer", async () => {
    const listed = await descriptorsOf(false)
    expect(listed.slice(0, 3)).toEqual(["0", "1", "2"])
    expect(listed.filter((fd) => handedOn.includes(fd))).toEqual([])
  })

  it("would hold them all without it", async () => {
    expect(await descriptorsOf(true)).toEqual(expect.arrayContaining(handedOn))
  })
})
