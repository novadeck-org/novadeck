import { spawn } from "node:child_process"

import { describe, expect, it, onTestFinished } from "vitest"

import type { Listed } from "./descendants.js"
import { parseLstart, processesUnder, startResolutionMs } from "./spawned.js"

const row = (pid: number, parent: number, more: Partial<Listed> = {}): Listed => ({
  pid,
  parent,
  group: pid,
  foreground: 0,
  started: "Fri Nov  6 15:20:11 2026",
  zombie: false,
  ...more,
})

describe("startResolutionMs", () => {
  it("is each OS's grain", () => {
    expect(startResolutionMs("linux")).toBe(10)
    expect(startResolutionMs("darwin")).toBe(1000)
    expect(startResolutionMs("win32")).toBe(16)
  })
})

describe("parseLstart", () => {
  it("reads macOS's local time to the second", () => {
    expect(parseLstart("Fri Nov  6 15:20:11 2026")).toBe(
      new Date(2026, 10, 6, 15, 20, 11).getTime(),
    )
    expect(parseLstart("Sat Dec 12 00:00:00 2026")).toBe(new Date(2026, 11, 12).getTime())
    expect(parseLstart("garbage")).toBeUndefined()
  })
})

describe("processesUnder", () => {
  it("lists macOS's descendants but not the root, zombies or strangers", async () => {
    const rows = [
      row(10, 1),
      row(20, 10, { command: "/usr/bin/sleep" }),
      row(21, 20, { command: "/bin/sh", started: "Fri Nov  6 15:20:12 2026" }),
      row(22, 10, { zombie: true }),
      row(30, 1),
    ]
    const found = await processesUnder(10, { platform: "darwin", listing: async () => rows })
    const at = new Date(2026, 10, 6, 15, 20, 11).getTime()
    expect(found).toEqual([
      { key: `20:${at}`, pid: 20, parent: 10, name: "sleep", startedMs: at },
      { key: `21:${at + 1000}`, pid: 21, parent: 20, name: "sh", startedMs: at + 1000 },
    ])
  })

  it("is undefined with no listing or a root that is gone", async () => {
    expect(await processesUnder(10, { platform: "darwin", listing: async () => undefined })).toBe(
      undefined,
    )
    expect(
      await processesUnder(10, { platform: "darwin", listing: async () => [row(30, 1)] }),
    ).toBe(undefined)
    expect(await processesUnder(10, { platform: "win32" })).toBe(undefined)
  })

  it("takes Windows's from the relay's tree, root left out", async () => {
    const trees = {
      read: async () => [
        { pid: 10, startedAt: 1000, name: "cmd.exe" },
        { pid: 20, startedAt: 2500, name: "timeout.exe", parent: 10 },
        { pid: 21, startedAt: 2600 },
      ],
    }
    expect(await processesUnder(10, { platform: "win32", trees })).toEqual([
      { key: "20:2500", pid: 20, parent: 10, name: "timeout.exe", startedMs: 2500 },
      { key: "21:2600", pid: 21, parent: null, name: null, startedMs: 2600 },
    ])
    expect(
      await processesUnder(10, { platform: "win32", trees: { read: async () => undefined } }),
    ).toBe(undefined)
    expect(await processesUnder(10, { platform: "win32", trees: { read: async () => [] } })).toBe(
      undefined,
    )
  })

  it.skipIf(process.platform !== "linux")(
    "sees a real child of this process, started within a tick of now",
    async () => {
      const before = Date.now()
      const child = spawn("sleep", ["30"], { stdio: "ignore" })
      onTestFinished(() => void child.kill())
      await new Promise((resolve) => child.once("spawn", resolve))
      const found = await processesUnder(process.pid)
      const one = found?.find((each) => each.pid === child.pid)
      expect(one).toMatchObject({ parent: process.pid, name: "sleep" })
      expect(one!.startedMs).toBeGreaterThanOrEqual(before - startResolutionMs("linux"))
      expect(one!.startedMs).toBeLessThanOrEqual(Date.now() + startResolutionMs("linux"))
      expect(one!.key).toBe(`${child.pid}:${one!.startedMs}`)
      const again = await processesUnder(process.pid)
      expect(again?.find((each) => each.pid === child.pid)?.key).toBe(one!.key)
    },
  )
})
