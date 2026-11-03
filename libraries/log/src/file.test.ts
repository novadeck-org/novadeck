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

import { afterEach, describe, expect, it } from "vitest"

import { logPath, openLogFile } from "./file.js"

const folders: string[] = []
const folder = (): string => {
  const made = mkdtempSync(join(tmpdir(), "novadeck-log-"))
  folders.push(made)
  return made
}

afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

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
        for (let index = 2; index < 8; index += 1) file.write(line(index))
      } finally {
        chmodSync(logs, 0o755)
      }
      file.close()
      const written = readFileSync(logPath(logs, "host"), "utf8").trim().split("\n")
      expect(written).toEqual(Array.from({ length: 8 }, (_, index) => line(index)))
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
