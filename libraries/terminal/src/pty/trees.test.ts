import { describe, expect, it } from "vitest"

import { parseTrees, Trees, type RunRelay } from "./trees.js"

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
    expect([...parseTrees(output)]).toEqual([["10", [{ pid: 10, startedAt: 1 }]]])
  })
})
