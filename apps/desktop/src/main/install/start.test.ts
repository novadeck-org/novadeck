import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { closeSync, openSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { closeDescriptors, installedEnvironment, startAppImage } from "./start"

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
  overrides: {
    runnable?: (path: string) => boolean
    throws?: boolean
    refused?: boolean
    after?: number
  } = {},
) => {
  const calls: string[] = []
  const spawned: { file: string; args: readonly string[]; options: unknown }[] = []
  const start = startAppImage({
    image: "/i/novadeck.AppImage",
    after: overrides.after,
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

  it("waits for the process to be gone first when asked, handing bash its id", async () => {
    const { start, spawned } = starting((child) => child.emit("spawn"), { after: 4242 })
    expect(await start).toBe(true)
    const [call] = spawned
    expect(call?.file).toBe("/bin/bash")
    expect(call?.args.slice(2)).toEqual(["/i/novadeck.AppImage", "4242"])
    expect(call?.args[1]).toContain('kill -0 "$1"')
    expect(call?.args[1]).toContain(closeDescriptors)
  })

  it("starts nothing, and takes the lock back, when it must wait and there is no bash", async () => {
    const { start, calls, spawned } = starting(() => {}, {
      after: 4242,
      runnable: (path) => !path.endsWith("bash"),
    })
    expect(await start).toBe(false)
    expect(spawned).toEqual([])
    expect(calls).toContain("reclaim")
  })

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
