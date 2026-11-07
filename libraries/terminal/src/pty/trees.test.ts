import { afterEach, describe, expect, it, vi } from "vitest"

import { anyRunning, chainTo, parseConsole, parseTrees, Trees, type RunRelay } from "./trees.js"

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

describe("whether a tree's members still run", () => {
  afterEach(() => vi.restoreAllMocks())

  const killFails = (code: string) =>
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code })
    })

  it("is true while a member's pid can be signalled", () => {
    vi.spyOn(process, "kill").mockReturnValue(true)
    expect(anyRunning([{ pid: 10, startedAt: 1 }])).toBe(true)
  })

  it("is false once every member's pid is gone", () => {
    killFails("ESRCH")
    expect(anyRunning([{ pid: 10, startedAt: 1 }])).toBe(false)
  })

  it("is true where a member's pid may not be signalled, as an elevated process's", () => {
    killFails("EPERM")
    expect(anyRunning([{ pid: 10, startedAt: 1 }])).toBe(true)
  })
})

describe("the chain from a shell to its agent", () => {
  const at = (pid: number, parent?: number) => ({
    pid,
    startedAt: 1,
    ...(parent !== undefined && { parent }),
  })

  it("names a wrapper between them, as codex.cmd is, by the parents told", () => {
    const tree = [at(10, 1), at(11, 10), at(12, 11), at(13, 12), at(20, 10)]
    expect(chainTo(tree, 10, 13)).toEqual([11, 12, 13])
    expect(chainTo(tree, 10, 20)).toEqual([20])
  })

  it("tells nothing where a link has no parent, the agent is not under the shell, or it loops", () => {
    expect(chainTo([at(10, 1), at(11), at(12, 11)], 10, 12)).toBeUndefined()
    expect(chainTo([at(10, 1), at(20, 1)], 10, 20)).toBeUndefined()
    expect(chainTo([at(10, 1)], 10, 99)).toBeUndefined()
    expect(chainTo([at(10, 1), at(11, 12), at(12, 11)], 10, 11)).toBeUndefined()
  })

  it("reads the parent the relay tells, leaving it out when it is not an integer", () => {
    const output =
      '{"root":"10","processes":[{"pid":10,"startedAt":1},{"pid":11,"startedAt":2,"parent":10},{"pid":12,"startedAt":3,"parent":"x"}]}'
    expect(parseTrees(output).get("10")).toEqual([
      { pid: 10, startedAt: 1 },
      { pid: 11, startedAt: 2, parent: 10 },
      { pid: 12, startedAt: 3 },
    ])
  })
})

describe("the processes attached to a terminal's console", () => {
  it("reads the relay's line, and nothing else", () => {
    expect(parseConsole('noise\r\n{"pids":[10,11]}\r\n')).toEqual([10, 11])
    expect(parseConsole('{"pids":[]}')).toEqual([])
    expect(parseConsole('{"pids":["x"]}')).toBeUndefined()
    expect(parseConsole("")).toBeUndefined()
  })

  it("asks the relay by the shell's pid, and tells nothing where it can't answer", async () => {
    const runs: string[][] = []
    const answering: RunRelay = async (_relay, args) => {
      runs.push([...args])
      return '{"pids":[10,12]}\n'
    }
    const trees = new Trees(async () => "relay", answering)
    await expect(trees.console(10)).resolves.toEqual([10, 12])
    expect(runs).toEqual([["console", "10"]])
    const old = new Trees(
      async () => "relay",
      () => Promise.reject(new Error("unknown command")),
    )
    await expect(old.console(10)).resolves.toBeUndefined()
    const none = new Trees(async () => undefined, answering)
    await expect(none.console(10)).resolves.toBeUndefined()
  })
})
