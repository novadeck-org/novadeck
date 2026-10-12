import { spawn } from "node:child_process"

import { relayPath } from "@novadeck/relay"

import { describe, expect, it } from "../test.js"
import { anyRunning, trees, Trees, type RunRelay } from "./trees.js"

// A relay that answers from a table of trees and records how it was run.
const fake = (known: Record<string, { pid: number; startedAt: number }[]>) => {
  const runs: string[][] = []
  const run: RunRelay = async (_relay, args) => {
    runs.push([...args])
    if (args[0] !== "tree") return ""
    return args
      .slice(1)
      .map((root) => JSON.stringify({ root, processes: known[root] ?? [] }))
      .join("\n")
  }
  return { runs, run }
}

describe("Windows process trees", () => {
  it("are read for every terminal asking in the same tick in one run of the relay", async () => {
    const { runs, run } = fake({
      10: [
        { pid: 10, startedAt: 1 },
        { pid: 11, startedAt: 2 },
      ],
      20: [{ pid: 20, startedAt: 3 }],
    })
    const read = new Trees(async () => "relay.exe", run)
    const [first, second] = await Promise.all([read.read(10), read.read(20)])
    expect(first).toEqual([
      { pid: 10, startedAt: 1 },
      { pid: 11, startedAt: 2 },
    ])
    expect(second).toEqual([{ pid: 20, startedAt: 3 }])
    expect(runs).toEqual([["tree", "10", "20"]])
    // A later tick runs it again.
    await read.read(10)
    expect(runs).toHaveLength(2)
  })

  it("are ended together, each by its pid and start", async () => {
    const { runs, run } = fake({})
    const read = new Trees(async () => "relay.exe", run)
    await Promise.all([
      read.end([{ pid: 10, startedAt: 1 }]),
      read.end([
        { pid: 11, startedAt: 2 },
        { pid: 10, startedAt: 1 },
      ]),
      read.end([]),
    ])
    expect(runs).toEqual([["end", "10:1", "11:2"]])
  })

  it("are unknown where there is no relay, or it fails", async () => {
    expect(await new Trees(async () => undefined, fake({}).run).read(10)).toBeUndefined()
    const failing = new Trees(
      async () => "relay.exe",
      () => Promise.reject(new Error("gone")),
    )
    expect(await failing.read(10)).toBeUndefined()
    await failing.end([{ pid: 10, startedAt: 1 }])
  })

  it("are read again from a member by its start, once it may have ended", async () => {
    const { runs, run } = fake({ "11:200": [{ pid: 14, startedAt: 400 }] })
    const read = new Trees(async () => "relay.exe", run)
    expect(await read.read({ pid: 11, startedAt: 200 })).toEqual([{ pid: 14, startedAt: 400 }])
    expect(runs).toEqual([["tree", "11:200"]])
  })

  it("leave out what isn't a line of the relay's", () => {
    const output = [
      '{"root":"10","processes":[{"pid":10,"startedAt":1},{"pid":"x","startedAt":2}]}',
      "garbled",
      '{"root":20,"processes":[]}',
      "",
    ].join("\r\n")
    expect([...trees(output)]).toEqual([["10", [{ pid: 10, startedAt: 1 }]]])
  })

  it.runIf(process.platform === "win32")(
    "find what an ended process left running, read again from it by its start",
    async () => {
      // cmd starts a ping, then is ended alone, as a shell is: the ping runs on, orphaned.
      const shell = spawn("cmd.exe", ["/d", "/c", "ping -n 60 127.0.0.1 >nul"], {
        stdio: "ignore",
        windowsHide: true,
      })
      const read = new Trees(async () => relayPath)
      await expect
        .poll(async () => (await read.read(shell.pid!))?.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(3)
      const root = (await read.read(shell.pid!))![0]!
      process.kill(shell.pid!)
      await expect.poll(() => anyRunning([root]), { timeout: 10_000 }).toBe(false)
      const left = (await read.read(root)) ?? []
      expect(left.length).toBeGreaterThan(0)
      expect(left.every(({ pid }) => pid !== root.pid)).toBe(true)
      await read.end(left)
      await expect.poll(() => anyRunning(left), { timeout: 10_000 }).toBe(false)
    },
  )

  it.runIf(process.platform === "win32")(
    "end a tree the relay read, programs it started included",
    async () => {
      // cmd, which starts a ping of its own, as a shell starts an agent.
      const shell = spawn("cmd.exe", ["/d", "/c", "ping -n 60 127.0.0.1 >nul"], {
        stdio: "ignore",
        windowsHide: true,
      })
      const read = new Trees(async () => relayPath)
      // Its ping, and the console host Windows starts for a hidden console.
      await expect
        .poll(async () => (await read.read(shell.pid!))?.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(3)
      const tree = (await read.read(shell.pid!))!
      expect(tree[0]?.pid).toBe(shell.pid)
      await read.end(tree)
      await expect.poll(() => anyRunning(tree), { timeout: 10_000 }).toBe(false)
    },
  )
})
