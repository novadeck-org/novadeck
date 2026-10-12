import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { closeSync, openSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { InstallResult } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { afterEach, beforeEach, vi } from "vitest"

import { installAppChannel, openInstalledChannel, portableChannel } from "../bridge.js"
import { context, describe, expect, it } from "../test"
import type { InstalledCopy, InstallOutcome } from "./install-linux"
import {
  closeDescriptors,
  installedEnvironment,
  leaveForNewerInstalled,
  portableInstaller,
  registerPortableIpc,
  startAppImage,
  type NewerInstalledCheck,
  type PortableHost,
} from "./portable"

// A host that records what it was asked, in order.
const hosting = (overrides: Partial<PortableHost> = {}) => {
  const calls: string[] = []
  const host: PortableHost = {
    portable: true,
    version: "1.0.0",
    source: "/dl/novadeck.AppImage",
    find: async () => [],
    install: async (source, target): Promise<InstallOutcome> => {
      calls.push(`install ${source}${target ? ` over ${target}` : ""}`)
      return { kind: "installed", image: "/i/novadeck.AppImage" }
    },
    shutdown: async () => void calls.push("shutdown"),
    start: async (image) => {
      calls.push(`start ${image}`)
      return true
    },
    alert: async (image) => void calls.push(`alert ${image}`),
    stopping: () => false,
    fallbackMs: 10_000,
    quit: () => void calls.push("quit"),
    log: () => {},
    ...overrides,
  }
  return { host, calls }
}

// Lets the shutdown and relaunch that follow an answer run.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const copy = (version: string | undefined, unchecked = false): InstalledCopy => ({
  image: "/n/novadeck.AppImage",
  version,
  unchecked,
})

describe("what a portable copy reports", () => {
  it("is portable, with this build's version", () => {
    expect(portableInstaller(hosting().host).state()).toEqual({
      portable: true,
      version: "1.0.0",
    })
  })

  it("is not portable for an installed copy", () => {
    expect(portableInstaller(hosting({ portable: false }).host).state()).toEqual({
      portable: false,
    })
  })
})

describe("installing from a portable copy", () => {
  it("installs this very file, shuts down, then starts the installed copy", async () => {
    const { host, calls } = hosting()
    const result = await portableInstaller(host).install()
    expect(result).toEqual({ kind: "installing" })
    await settle()
    expect(calls).toEqual([
      "install /dl/novadeck.AppImage",
      "shutdown",
      "start /i/novadeck.AppImage",
    ])
  })

  it("replaces an installed copy that is the same or older", async () => {
    const runs = ["1.0.0", "0.9.0", undefined].map(async (version) => {
      const { host, calls } = hosting({ find: async () => [copy(version)] })
      return { result: await portableInstaller(host).install(), calls }
    })
    for (const { result, calls } of await Promise.all(runs)) {
      expect(result).toEqual({ kind: "installing" })
      expect(calls[0]).toBe("install /dl/novadeck.AppImage over /n/novadeck.AppImage")
    }
  })

  it("replaces the installer's copy before Homebrew's, and makes no second copy", async () => {
    const both = [
      { image: "/c/novadeck.AppImage", version: "1.0.0", unchecked: false },
      { image: "/b/novadeck.AppImage", version: "0.9.0", unchecked: false },
    ]
    const { host, calls } = hosting({ find: async () => both })
    await portableInstaller(host).install()
    await settle()
    expect(calls).toEqual([
      "install /dl/novadeck.AppImage over /c/novadeck.AppImage",
      "shutdown",
      "start /i/novadeck.AppImage",
    ])
    const brew = hosting({ find: async () => both.slice(1) })
    await portableInstaller(brew.host).install()
    expect(brew.calls[0]).toBe("install /dl/novadeck.AppImage over /b/novadeck.AppImage")
  })

  it("leaves a newer installed copy alone and says which version it is", async () => {
    const { host, calls } = hosting({ find: async () => [copy("1.1.0")] })
    expect(await portableInstaller(host).install()).toEqual({
      kind: "newer",
      version: "1.1.0",
    })
    await settle()
    expect(calls).toEqual([])
  })

  it("fails with the reason, and keeps running", async () => {
    const { host, calls } = hosting({
      install: async () => ({
        kind: "failed",
        reason: "There is no space left on the disk.",
      }),
    })
    expect(await portableInstaller(host).install()).toEqual({
      kind: "failed",
      reason: "There is no space left on the disk.",
    })
    await settle()
    expect(calls).toEqual([])
  })

  it("fails, and logs, when installing throws", async () => {
    const logged: string[] = []
    const { host } = hosting({
      install: () => Promise.reject(new Error("boom")),
      log: (message) => void logged.push(message),
    })
    expect(await portableInstaller(host).install()).toEqual({
      kind: "failed",
      reason: "Something went wrong.",
    })
    expect(logged).toEqual(["Installing failed."])
  })

  it("installs nothing from a copy that is not portable", async () => {
    const { host, calls } = hosting({ portable: false })
    expect((await portableInstaller(host).install()).kind).toBe("failed")
    expect(calls).toEqual([])
  })

  it("does nothing more for a second request, whether under way or after leaving", async () => {
    const { host, calls } = hosting()
    const installer = portableInstaller(host)
    const [first, second] = await Promise.all([installer.install(), installer.install()])
    expect([first, second]).toEqual([{ kind: "installing" }, { kind: "installing" }])
    expect(await installer.install()).toEqual({ kind: "installing" })
    await settle()
    expect(calls.filter((call) => call.startsWith("install"))).toHaveLength(1)
    expect(calls.filter((call) => call === "shutdown")).toHaveLength(1)
  })

  context("when the installed copy will not start", () => {
    it("tells the person where it is, then quits, as the shells are gone", async () => {
      const { host, calls } = hosting({ start: async () => false })
      await portableInstaller(host).install()
      await settle()
      expect(calls).toEqual([
        "install /dl/novadeck.AppImage",
        "shutdown",
        "alert /i/novadeck.AppImage",
        "quit",
      ])
    })

    it("quits even when the person cannot be told", async () => {
      const { host, calls } = hosting({
        start: async () => false,
        alert: () => Promise.reject(new Error("no display")),
      })
      await portableInstaller(host).install()
      await settle()
      expect(calls.at(-1)).toBe("quit")
    })
  })

  context("when the installed copy started but this one is somehow still running", () => {
    it("quits after the fallback time, and not before", async () => {
      vi.useFakeTimers()
      try {
        const { host, calls } = hosting({ fallbackMs: 5_000 })
        await portableInstaller(host).install()
        await vi.advanceTimersByTimeAsync(4_999)
        expect(calls).not.toContain("quit")
        await vi.advanceTimersByTimeAsync(1)
        expect(calls.at(-1)).toBe("quit")
      } finally {
        vi.useRealTimers()
      }
    })
  })

  context("when the installed copy could not be looked at", () => {
    it("is left as it is, whether or not it would be newer", async () => {
      const logs: unknown[][] = []
      const { host, calls } = hosting({
        find: async () => [copy(undefined, true)],
        log: (...entry) => void logs.push(entry),
      })
      const result = await portableInstaller(host).install()
      expect(result).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining("install.sh"),
      })
      await settle()
      expect(calls).toEqual([])
      expect(logs).toEqual([["The installed copy could not be checked.", "/n/novadeck.AppImage"]])
    })
  })

  context("when the installed copy runs but names no version", () => {
    it("is replaced", async () => {
      const { host, calls } = hosting({ find: async () => [copy(undefined, false)] })
      expect(await portableInstaller(host).install()).toEqual({ kind: "installing" })
      expect(calls[0]).toBe("install /dl/novadeck.AppImage over /n/novadeck.AppImage")
    })
  })

  context("when the person quit while the copy was made", () => {
    it("does not start the installed copy, and says so", async () => {
      let quitting = false
      const { host, calls } = hosting({
        install: async () => {
          quitting = true
          return { kind: "installed", image: "/i/novadeck.AppImage" }
        },
        stopping: () => quitting,
      })
      expect(await portableInstaller(host).install()).toEqual({
        kind: "failed",
        reason: "Novadeck is quitting.",
      })
      await settle()
      expect(calls).toEqual([])
    })
  })

  context("when the app is already quitting", () => {
    it("installs nothing", async () => {
      const { host, calls } = hosting({ stopping: () => true })
      expect(await portableInstaller(host).install()).toEqual({
        kind: "failed",
        reason: "Novadeck is quitting.",
      })
      await settle()
      expect(calls).toEqual([])
    })

    it("installs nothing when the quit began while the installed copies were looked at", async () => {
      let quitting = false
      const { host, calls } = hosting({
        find: async () => {
          quitting = true
          return []
        },
        stopping: () => quitting,
      })
      expect(await portableInstaller(host).install()).toMatchObject({ kind: "failed" })
      expect(calls).toEqual([])
    })
  })

  context("when shutting down fails", () => {
    it("still starts the installed copy", async () => {
      const { host, calls } = hosting({
        shutdown: () => Promise.reject(new Error("runner gone")),
      })
      await portableInstaller(host).install()
      await settle()
      expect(calls).toEqual(["install /dl/novadeck.AppImage", "start /i/novadeck.AppImage"])
    })
  })
})

describe("opening the installed copy found newer", () => {
  it("shuts down and starts it", async () => {
    const { host, calls } = hosting({ find: async () => [copy("1.1.0")] })
    const installer = portableInstaller(host)
    await installer.install()
    installer.openInstalled()
    await settle()
    expect(calls).toEqual(["shutdown", "start /n/novadeck.AppImage"])
  })

  it("does nothing while the app is already quitting, so a shutdown is not run twice", async () => {
    let quitting = false
    const { host, calls } = hosting({
      find: async () => [copy("1.1.0")],
      stopping: () => quitting,
    })
    const installer = portableInstaller(host)
    await installer.install()
    quitting = true
    installer.openInstalled()
    await settle()
    expect(calls).toEqual([])
  })

  it("does nothing before one was found", async () => {
    const { host, calls } = hosting()
    portableInstaller(host).openInstalled()
    await settle()
    expect(calls).toEqual([])
  })
})

describe("a launch of a portable copy", () => {
  const checking = (overrides: Partial<NewerInstalledCheck> = {}) => {
    const calls: string[] = []
    const check: NewerInstalledCheck = {
      portable: true,
      version: "1.0.0",
      find: async () => [copy("1.1.0")],
      ask: async (version) => {
        calls.push(`ask ${version}`)
        return true
      },
      start: async (image) => {
        calls.push(`start ${image}`)
        return true
      },
      alert: async (image) => void calls.push(`alert ${image}`),
      quit: () => void calls.push("quit"),
      log: () => {},
      ...overrides,
    }
    return { check, calls }
  }

  it("offers to open a newer installed copy, and starts it when asked", async () => {
    const { check, calls } = checking()
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["ask 1.1.0", "start /n/novadeck.AppImage"])
  })

  it("quits when the person chooses to", async () => {
    const { check, calls } = checking({ ask: async () => false })
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["quit"])
  })

  it("tells the person and quits when the installed copy will not start", async () => {
    const { check, calls } = checking({ start: async () => false })
    expect(await leaveForNewerInstalled(check)).toBe(true)
    expect(calls).toEqual(["ask 1.1.0", "alert /n/novadeck.AppImage", "quit"])
  })

  it("goes on when no installed copy is newer, or when the copy is not portable", async () => {
    const runs = [
      { find: async () => [copy("1.0.0"), copy(undefined)] },
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

  it("goes on, and logs, when the installed copies cannot be looked at", async () => {
    const logged: string[] = []
    const { check } = checking({
      find: () => Promise.reject(new Error("denied")),
      log: (message) => void logged.push(message),
    })
    expect(await leaveForNewerInstalled(check)).toBe(false)
    expect(logged).toHaveLength(1)
  })
})

describe("answering the app's pages", () => {
  type Handler = (event: unknown) => unknown
  const registered = (known: boolean) => {
    const handlers = new Map<string, Handler>()
    const { host, calls } = hosting()
    const installer = portableInstaller(host)
    registerPortableIpc(
      {
        handle: (channel, listener) => void handlers.set(channel, listener as Handler),
        on: (channel, listener) => void handlers.set(channel, listener as Handler),
      },
      { window: () => (known ? "window" : undefined), installer },
    )
    const ask = (channel: string): unknown =>
      handlers.get(channel)!({} as IpcMainEvent & IpcMainInvokeEvent)
    return { ask, calls }
  }

  it("tells the app's own page whether the copy is portable, and installs for it", async () => {
    const { ask, calls } = registered(true)
    expect(await ask(portableChannel)).toEqual({
      portable: true,
      version: "1.0.0",
    })
    expect(await (ask(installAppChannel) as Promise<InstallResult>)).toEqual({
      kind: "installing",
    })
    expect(calls[0]).toBe("install /dl/novadeck.AppImage")
  })

  it("tells any other sender the copy is not portable, and refuses it", async () => {
    const { ask, calls } = registered(false)
    expect(await ask(portableChannel)).toEqual({ portable: false })
    expect(await ask(installAppChannel)).toMatchObject({ kind: "failed" })
    ask(openInstalledChannel)
    await settle()
    expect(calls).toEqual([])
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
  overrides: { runnable?: (path: string) => boolean; throws?: boolean } = {},
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

  it("does not exit when the child fails to start", async () => {
    const { start, calls } = starting((child) => child.emit("error", new Error("EACCES")))
    expect(await start).toBe(false)
    expect(calls).not.toContain("exit")
    expect(calls).toContain("log The installed copy did not start.")
  })

  it("does not exit when spawning throws", async () => {
    const { start, calls } = starting(() => {}, { throws: true })
    expect(await start).toBe(false)
    expect(calls).not.toContain("exit")
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
