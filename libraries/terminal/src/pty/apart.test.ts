import { spawn } from "node:child_process"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import { endApart, listedApart, sameProcess, type ApartProcess } from "./apart.js"
import { processListing, type Listed } from "./descendants.js"
import type { Member } from "./trees.js"

const row = (pid: number, started: string, more: Partial<Listed> = {}): Listed => ({
  pid,
  parent: 1,
  group: pid,
  foreground: 0,
  started,
  zombie: false,
  ...more,
})

const born = { after: 0, before: Number.MAX_SAFE_INTEGER }

describe("a process its harness recorded", () => {
  it("is the listed one with the same clock ticks on Linux, and no other", () => {
    const apart = { pid: 42, start: "75822456", born }
    expect(sameProcess(row(42, "75822456"), apart, "linux")).toBe(true)
    expect(sameProcess(row(42, "75822457"), apart, "linux")).toBe(false)
    expect(sameProcess(row(43, "75822456"), apart, "linux")).toBe(false)
    expect(sameProcess(row(42, "75822456", { zombie: true }), apart, "linux")).toBe(false)
  })

  it("is never one by pid alone, with no start recorded", () => {
    expect(sameProcess(row(42, "75822456"), { pid: 42, born }, "linux")).toBe(false)
  })

  it("is the listed one started the same second on macOS, its start given in UTC", () => {
    // The listing gives the local time; Claude Code records `ps -o lstart` under TZ=UTC.
    const local = new Date(2026, 10, 6, 15, 20, 11)
    const utc = new Date(local.getTime())
    const pad = (n: number) => String(n).padStart(2, "0")
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]
    const recorded = `${days[utc.getUTCDay()]} ${months[utc.getUTCMonth()]} ${utc.getUTCDate()} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())} ${utc.getUTCFullYear()}`
    const listed = row(42, "Fri Nov  6 15:20:11 2026")
    expect(sameProcess(listed, { pid: 42, start: recorded, born }, "darwin")).toBe(true)
    expect(
      sameProcess(listed, { pid: 42, start: "Fri Nov  6 15:20:11 2026", born }, "darwin"),
    ).toBe(true)
    const later = new Date(local.getTime() + 1_000)
    const other = `${days[later.getUTCDay()]} ${months[later.getUTCMonth()]} ${later.getUTCDate()} ${pad(later.getUTCHours())}:${pad(later.getUTCMinutes())}:${pad(later.getUTCSeconds())} ${later.getUTCFullYear()}`
    expect(sameProcess(listed, { pid: 42, start: other, born }, "darwin")).toBe(false)
  })

  it("is listed as found, by pid and the listing's own start", () => {
    const rows = [row(42, "100"), row(43, "200"), row(44, "300")]
    const apart = [
      { pid: 42, start: "100", born },
      { pid: 44, start: "999", born },
    ]
    expect(listedApart(rows, apart, "linux")).toEqual([{ pid: 42, started: "100" }])
  })
})

describe("ending what a harness left apart", () => {
  const trees = (read: Record<number, readonly Member[]>) => ({
    read: vi.fn<(root: number) => Promise<readonly Member[] | undefined>>(
      async (root) => read[root],
    ),
    end: vi.fn<(members: readonly Member[]) => Promise<void>>(async () => {}),
  })

  it("ends on Windows each tree whose root started within its window, and no other", async () => {
    const service: Member = { pid: 7, startedAt: 1_000 }
    const session: Member = { pid: 8, startedAt: 1_500, parent: 7 }
    const recycled: Member = { pid: 9, startedAt: 9_000 }
    const relay = trees({ 7: [service, session], 9: [recycled] })
    const apart: ApartProcess[] = [
      { pid: 7, born: { after: 500, before: 1_200 } },
      { pid: 9, born: { after: 500, before: 2_000 } },
      { pid: 11, born: { after: 500, before: 2_000 } },
    ]
    await endApart(apart, { platform: "win32", listing: async () => undefined, trees: relay })
    expect(relay.end).toHaveBeenCalledTimes(1)
    expect(relay.end.mock.calls[0]![0]).toEqual([service, session])
  })

  it("ends nothing where the listing fails, and says so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    onTestFinished(() => error.mockRestore())
    const kill = vi.spyOn(process, "kill")
    onTestFinished(() => kill.mockRestore())
    await endApart([{ pid: 4242, start: "1", born }], {
      platform: "linux",
      listing: async () => undefined,
      trees: trees({}),
    })
    expect(kill).not.toHaveBeenCalled()
    expect(error.mock.calls.flat().join(" ")).toContain("were not ended")
  })

  it("signals nothing that isn't the process recorded", async () => {
    const kill = vi.spyOn(process, "kill")
    onTestFinished(() => kill.mockRestore())
    await endApart([{ pid: 4242, start: "1", born }], {
      platform: "linux",
      listing: async () => [row(4242, "2")],
      trees: trees({}),
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === "win32")(
    "ends the process recorded, by its start, with what it started",
    async () => {
      const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" })
      onTestFinished(() => {
        try {
          process.kill(-child.pid!, "SIGKILL")
        } catch {
          // Gone.
        }
      })
      const exited = new Promise((resolve) => child.once("exit", resolve))
      const listing = processListing(process.platform, 0, 2_000)
      let rows: readonly Listed[] | undefined
      // Until its sleep shows under it.
      for (let tries = 0; tries < 50; tries += 1) {
        // eslint-disable-next-line no-await-in-loop -- Waits for the child's own child.
        rows = await listing()
        if (rows?.some((one) => one.parent === child.pid)) break
        // eslint-disable-next-line no-await-in-loop -- As above.
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const own = rows!.find((one) => one.pid === child.pid)!
      const sleeper = rows!.find((one) => one.parent === child.pid)!
      await endApart([{ pid: own.pid, start: own.started, born }], {
        platform: process.platform,
        listing,
        trees: trees({}),
      })
      await exited
      const gone = () => {
        try {
          process.kill(sleeper.pid, 0)
          return false
        } catch {
          return true
        }
      }
      // Its reaper may take a moment.
      await vi.waitFor(() => expect(gone()).toBe(true), { timeout: 3_000 })
    },
  )
})
