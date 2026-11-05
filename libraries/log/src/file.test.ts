import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import { logPath, openLogFile } from "./file.js"

// Faults the file system can be made to have, as another program holding a file open on
// Windows, or a disk that fills.
const faults = vi.hoisted(() => ({
  /** Files that can't be renamed, as when another program holds them open. */
  held: new Set<string>(),
  /** Bytes the disk takes before it is full; undefined for no limit. */
  room: undefined as number | undefined,
}))

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  const busy = (): Error => Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })
  return {
    ...fs,
    renameSync: (from: string, to: string): void => {
      if (faults.held.has(from)) throw busy()
      fs.renameSync(from, to)
    },
    writeSync: (handle: number, buffer: Buffer, offset = 0): number => {
      const room = faults.room
      if (room === undefined) return fs.writeSync(handle, buffer, offset)
      if (room === 0) throw Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" })
      const length = Math.min(room, buffer.length - offset)
      faults.room = room - length
      return fs.writeSync(handle, buffer, offset, length)
    },
  }
})

const folders: string[] = []
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), "novadeck-log-"))
  folders.push(made)
  return made
}

afterEach(() => {
  faults.held.clear()
  faults.room = undefined
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const lines = (path: string): string[] => readFileSync(path, "utf8").trim().split("\n")

const line = (index: number): string => `line ${String(index).padStart(4, "0")} ${"x".repeat(80)}`

describe("openLogFile", () => {
  it.skipIf(process.platform === "win32")(
    "keeps the folder and files to their owner, those from before too",
    () => {
      const logs = join(folder(), "logs")
      mkdirSync(logs, { mode: 0o755 })
      writeFileSync(join(logs, "host.log"), "old\n", { mode: 0o644 })
      writeFileSync(join(logs, "host.1.log"), "older\n", { mode: 0o644 })
      const file = openLogFile({ folder: logs, name: "host" })
      file.write("one")
      file.close()
      expect(statSync(logs).mode & 0o777).toBe(0o700)
      expect(statSync(join(logs, "host.log")).mode & 0o777).toBe(0o600)
      expect(statSync(join(logs, "host.1.log")).mode & 0o777).toBe(0o600)
    },
  )

  it("appends lines to name.log, making the folder", () => {
    const logs = join(folder(), "logs")
    const file = openLogFile({ folder: logs, name: "host" })
    file.write("one")
    file.write("two")
    file.close()
    expect(readFileSync(join(logs, "host.log"), "utf8")).toBe("one\ntwo\n")
  })

  it("appends to what an earlier run wrote", () => {
    const logs = folder()
    writeFileSync(join(logs, "host.log"), "before\n")
    const file = openLogFile({ folder: logs, name: "host" })
    file.write("after")
    file.close()
    expect(readFileSync(join(logs, "host.log"), "utf8")).toBe("before\nafter\n")
  })

  it("rotates past the size, keeps as many files as it's told, and stays within its budget", () => {
    const logs = folder()
    const maxBytes = 1_000
    const file = openLogFile({ folder: logs, name: "runner", maxBytes, keep: 3 })
    for (let index = 0; index < 200; index += 1) file.write(line(index))
    file.close()
    expect(readdirSync(logs).toSorted()).toEqual(["runner.1.log", "runner.2.log", "runner.log"])
    for (const name of readdirSync(logs))
      expect(statSync(join(logs, name)).size).toBeLessThanOrEqual(maxBytes)
    // The newest line is in runner.log, the ones before it in the older files, in order.
    const newest = readFileSync(logPath(logs, "runner"), "utf8").trim().split("\n")
    expect(newest.at(-1)).toBe(line(199))
    const older = readFileSync(logPath(logs, "runner", 1), "utf8")
      .trim()
      .split("\n")
    expect(older.at(-1)).toBe(line(199 - newest.length))
  })

  it("starts each rotated-in file with its header", () => {
    const logs = folder()
    const file = openLogFile({ folder: logs, name: "host", maxBytes: 300, header: () => "HEADER" })
    for (let index = 0; index < 10; index += 1) file.write(line(index))
    file.close()
    expect(readFileSync(logPath(logs, "host"), "utf8").split("\n")[0]).toBe("HEADER")
    expect(readFileSync(logPath(logs, "host", 1), "utf8").split("\n")[0]).toBe("HEADER")
  })

  // As on Windows, where a program holding the file open keeps it from being renamed. A
  // read-only folder stands in for that on Linux and macOS; Windows doesn't enforce one, and
  // root ignores it.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "writes on where it can't rotate, without a header before each line, and keeps every line",
    () => {
      const logs = folder()
      let now = 0
      const file = openLogFile({
        folder: logs,
        name: "host",
        maxBytes: 300,
        header: () => "HEADER",
        retryMs: 1_000,
        now: () => now,
      })
      file.write(line(0))
      file.write(line(1))
      chmodSync(logs, 0o555)
      try {
        for (let index = 2; index < 6; index += 1) file.write(line(index))
      } finally {
        chmodSync(logs, 0o755)
      }
      file.close()
      const written = readFileSync(logPath(logs, "host"), "utf8").trim().split("\n")
      expect(written).toEqual(Array.from({ length: 6 }, (_, index) => line(index)))
    },
  )

  context("where the file written can't be moved, as another program holds it", () => {
    const rotated = () => {
      const logs = folder()
      let now = 0
      const file = openLogFile({
        folder: logs,
        name: "host",
        maxBytes: 300,
        retryMs: 1_000,
        now: () => now,
        dropped: (count) => `DROPPED ${count}`,
      })
      // Three lines a file: host.2.log, host.1.log and host.log all written.
      for (let index = 0; index < 9; index += 1) file.write(line(index))
      return { logs, file, later: (ms: number) => (now += ms) }
    }

    it("keeps every older file as it was, however often it tries", () => {
      const { logs, file, later } = rotated()
      const before = [1, 2].map((index) => readFileSync(logPath(logs, "host", index), "utf8"))
      faults.held.add(logPath(logs, "host"))
      file.write(line(9))
      later(1_000)
      file.write(line(10))
      later(1_000)
      file.write(line(11))
      file.close()
      expect([1, 2].map((index) => readFileSync(logPath(logs, "host", index), "utf8"))).toEqual(
        before,
      )
      expect(lines(logPath(logs, "host"))).toEqual([6, 7, 8, 9, 10, 11].map(line))
      expect(readdirSync(logs).toSorted()).toEqual(["host.1.log", "host.2.log", "host.log"])
    })

    it("stops at twice its size, and says how many lines it dropped once it rotates", () => {
      const { logs, file, later } = rotated()
      faults.held.add(logPath(logs, "host"))
      for (let index = 9; index < 14; index += 1) file.write(line(index))
      expect(statSync(logPath(logs, "host")).size).toBeLessThanOrEqual(600)
      faults.held.clear()
      later(1_000)
      file.write(line(14))
      file.close()
      expect(lines(logPath(logs, "host"))).toEqual(["DROPPED 2", line(14)])
      expect(lines(logPath(logs, "host", 1))).toEqual([6, 7, 8, 9, 10, 11].map(line))
      expect(lines(logPath(logs, "host", 2))).toEqual([3, 4, 5].map(line))
    })
  })

  context("when the disk fills", () => {
    it("says how many lines it dropped, and starts the next on a line of its own", () => {
      const logs = folder()
      let now = 0
      const file = openLogFile({
        folder: logs,
        name: "host",
        retryMs: 1_000,
        now: () => now,
        dropped: (count) => `DROPPED ${count}`,
      })
      file.write("one")
      faults.room = 3
      file.write("two cut short")
      file.write("lost")
      faults.room = undefined
      now = 1_000
      file.write("three")
      file.close()
      expect(readFileSync(logPath(logs, "host"), "utf8")).toBe("one\ntwo\nDROPPED 2\nthree\n")
    })
  })

  it("starts a new file where the one it moved aside can't be put back", () => {
    const logs = folder()
    const file = openLogFile({ folder: logs, name: "host", maxBytes: 300 })
    for (let index = 0; index < 3; index += 1) file.write(line(index))
    faults.held.add(join(logs, "host.rotating.log"))
    file.write(line(3))
    file.close()
    expect(lines(logPath(logs, "host"))).toEqual([line(3)])
  })

  it("rotates past what a rotation a crash cut short left behind", () => {
    const logs = folder()
    writeFileSync(join(logs, "host.rotating.log"), "left\n")
    const file = openLogFile({ folder: logs, name: "host", maxBytes: 300 })
    for (let index = 0; index < 4; index += 1) file.write(line(index))
    file.close()
    expect(readdirSync(logs).toSorted()).toEqual(["host.1.log", "host.log"])
    expect(lines(logPath(logs, "host", 1))).toEqual([0, 1, 2].map(line))
  })

  // Root reads any file, and Windows has no such modes.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "appends to a file it may write but not read",
    () => {
      const logs = folder()
      writeFileSync(join(logs, "host.log"), "old\n", { mode: 0o200 })
      chmodSync(join(logs, "host.log"), 0o200)
      const file = openLogFile({ folder: logs, name: "host" })
      file.write("new")
      file.close()
      expect(readFileSync(join(logs, "host.log"), "utf8")).toBe("old\nnew\n")
    },
  )

  it("starts on a line of its own after one an earlier run cut short", () => {
    const logs = folder()
    writeFileSync(join(logs, "host.log"), "cut sh")
    const file = openLogFile({ folder: logs, name: "host" })
    file.write("next")
    file.close()
    expect(readFileSync(join(logs, "host.log"), "utf8")).toBe("cut sh\nnext\n")
  })

  it("starts the file again with keep 1, and stays within its size", () => {
    const logs = folder()
    const file = openLogFile({ folder: logs, name: "host", maxBytes: 300, keep: 1 })
    for (let index = 0; index < 20; index += 1) file.write(line(index))
    file.close()
    expect(readdirSync(logs)).toEqual(["host.log"])
    expect(statSync(logPath(logs, "host")).size).toBeLessThanOrEqual(300)
    expect(lines(logPath(logs, "host")).at(-1)).toBe(line(19))
  })

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps 3 files when told to keep %s",
    (keep) => {
      const logs = folder()
      const file = openLogFile({ folder: logs, name: "host", maxBytes: 300, keep })
      for (let index = 0; index < 20; index += 1) file.write(line(index))
      file.close()
      expect(readdirSync(logs).toSorted()).toEqual(["host.1.log", "host.2.log", "host.log"])
    },
  )

  it("drops lines it can't write, without throwing", () => {
    const blocked = join(folder(), "file")
    writeFileSync(blocked, "")
    // A file where the folder should be: nothing can be made under it.
    const file = openLogFile({ folder: join(blocked, "logs"), name: "host" })
    expect(() => file.write("lost")).not.toThrow()
    file.close()
  })

  it("tries again once the folder can be written", () => {
    const base = folder()
    const blocked = join(base, "logs")
    writeFileSync(blocked, "")
    let now = 0
    const file = openLogFile({ folder: blocked, name: "host", retryMs: 1_000, now: () => now })
    file.write("lost")
    rmSync(blocked)
    now = 500
    file.write("still lost")
    now = 1_500
    file.write("kept")
    file.close()
    expect(readFileSync(join(blocked, "host.log"), "utf8")).toBe("kept\n")
  })
})
