import { describe, expect, it } from "../test.js"
import {
  parseCpuTime,
  parseMeminfo,
  parseProcStat,
  parsePs,
  parseVmStat,
  readProcesses,
  treeCpu,
  type ProcessRow,
} from "./host-reading.js"

const row = (pid: number, parent: number, ms: number, name = "p"): ProcessRow => ({
  pid,
  parent,
  name,
  selfMs: ms,
  totalMs: ms,
})

describe("reading processor time", () => {
  it("reads a Linux process's own time and that of the children it waited for", () => {
    const stat = "4242 (my (odd) prog) S 100 4242 100 0 -1 0 0 0 0 0 150 50 30 20 20 0 1 0 999"
    expect(parseProcStat(stat)).toEqual({
      pid: 4242,
      parent: 100,
      name: "my (odd) prog",
      selfMs: 2000,
      totalMs: 2500,
    })
    expect(parseProcStat("garbled")).toBeUndefined()
  })

  it("reads ps' cumulative CPU times, with hours and days", () => {
    expect(parseCpuTime("0:01.50")).toBe(1500)
    expect(parseCpuTime("12:03:04.00")).toBe(((12 * 60 + 3) * 60 + 4) * 1000)
    expect(parseCpuTime("1-00:00:01")).toBe(86_401_000)
    expect(parseCpuTime("soon")).toBeUndefined()
  })

  it("reads macOS ps rows, naming a program by its file", () => {
    const rows = parsePs(
      [
        "    1     0   0:10.00 /sbin/launchd",
        "  500   400  12:00.25 /Applications/Some App/bin/cargo",
        "not a row",
      ].join("\n"),
    )
    expect(rows).toEqual([
      { pid: 1, parent: 0, name: "launchd", selfMs: 10_000, totalMs: 10_000 },
      { pid: 500, parent: 400, name: "cargo", selfMs: 720_250, totalMs: 720_250 },
    ])
  })

  it("adds up a terminal's shell and everything under it, and nothing beside it", () => {
    const rows = [row(10, 1, 100), row(11, 10, 200), row(12, 11, 300), row(20, 1, 9_000)]
    expect(treeCpu(rows, 10)).toEqual({
      ms: 600,
      programs: [
        { pid: 10, name: "p", ms: 100 },
        { pid: 11, name: "p", ms: 200 },
        { pid: 12, name: "p", ms: 300 },
      ],
    })
    expect(treeCpu(rows, 99)).toBeUndefined()
  })

  it("reads memory in use from Linux's and macOS's own words", () => {
    expect(parseMeminfo("MemTotal:  1000 kB\nMemFree: 10 kB\nMemAvailable:  250 kB\n")).toBe(75)
    expect(parseMeminfo("nothing")).toBeUndefined()
    const vm = [
      "Mach Virtual Memory Statistics: (page size of 4096 bytes)",
      "Pages free:                               100.",
      "Pages inactive:                           50.",
      "Pages speculative:                        25.",
      "Pages purgeable:                          25.",
    ].join("\n")
    expect(parseVmStat(vm, 4096 * 1000)).toBe(80)
  })

  it("reads a Windows terminal's tree from the relay's trees, only where they tell CPU time", async () => {
    const trees = {
      read: async (root: number | { pid: number }) =>
        root === 1
          ? [
              { pid: 1, startedAt: 1, name: "pwsh.exe", cpuMs: 100 },
              { pid: 2, startedAt: 2, name: "node.exe", parent: 1, cpuMs: 900 },
            ]
          : [{ pid: 3, startedAt: 3, name: "old.exe" }],
      end: async () => undefined,
    }
    const read = readProcesses("win32", () => trees)
    expect(
      await read(
        new Map([
          ["a", 1],
          ["b", 3],
        ]),
      ),
    ).toEqual(
      new Map([
        [
          "a",
          {
            ms: 1000,
            programs: [
              { pid: 1, name: "pwsh.exe", ms: 100 },
              { pid: 2, name: "node.exe", ms: 900 },
            ],
          },
        ],
      ]),
    )
  })
})
