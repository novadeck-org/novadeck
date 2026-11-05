import { describe, expect, it, onTestFinished, vi } from "vitest"

import { named } from "./rounds.js"
import { asProcess, endProcess, endTree, type Row } from "./windows.js"

// A pid no process has, so a tree of it reads as ended at once: above Linux's pid_max, and a
// multiple of 4, as Windows reads a pid without its two low bits.
const gone = 2 ** 22 + 8

describe("a Windows process as the lister wrote it", () => {
  const row: Row = {
    pid: 7056,
    comm: "cmd.exe",
    start: 100,
    parent: "#668 gone",
    stopped: false,
    path: "C:\\Windows\\System32\\cmd.exe",
    line: '"C:\\Windows\\System32\\cmd.exe" /d /c echo hi',
  }

  it("is named with its parent, then its program's path and its command line", () => {
    expect(named(asProcess(row))).toBe(
      'cmd.exe (7056, parent #668 gone) at C:\\Windows\\System32\\cmd.exe as "C:\\Windows\\System32\\cmd.exe" /d /c echo hi',
    )
  })

  // As a program started suspended and never resumed is: it can never exit by itself.
  it("is named stopped where every thread of it is suspended", () => {
    expect(named(asProcess({ ...row, stopped: true }))).toMatch(
      /^cmd\.exe \(7056, stopped, parent #668 gone\) at /,
    )
  })

  it("is named without what the lister couldn't read, and with a long command line cut", () => {
    expect(named(asProcess({ ...row, path: "", line: "" }))).toBe(
      "cmd.exe (7056, parent #668 gone)",
    )
    const long = named(asProcess({ ...row, path: "", line: "x".repeat(500) }))
    expect(long).toBe(`cmd.exe (7056, parent #668 gone) as ${"x".repeat(400)}…`)
  })
})

describe("ending a Windows process's tree", () => {
  const reader = (tree: readonly { pid: number; startedAt: number }[] | undefined) => {
    const calls = { read: [] as number[], end: [] as unknown[] }
    return {
      calls,
      trees: {
        read: async (pid: number) => {
          calls.read.push(pid)
          return tree
        },
        end: async (members: readonly unknown[]) => {
          calls.end.push(members)
        },
      },
    }
  }

  it("ends the tree its reader reads, rooted at the process found", async () => {
    const tree = [
      { pid: gone, startedAt: 100 },
      { pid: gone + 1, startedAt: 101 },
    ]
    const { calls, trees } = reader(tree)
    const killed: number[] = []

    await endTree({ pid: gone, start: 100 }, trees, async (pid) => {
      killed.push(pid)
    })

    expect(calls.read).toEqual([gone])
    expect(calls.end).toEqual([tree])
    expect(killed).toEqual([])
  })

  it("ends nothing where the root is a later process given the same pid", async () => {
    const { calls, trees } = reader([{ pid: gone, startedAt: 200 }])
    const killed: number[] = []

    await endTree({ pid: gone, start: 100 }, trees, async (pid) => {
      killed.push(pid)
    })

    expect(calls.end).toEqual([])
    expect(killed).toEqual([])
  })

  it("ends the process alone when asked, or forcibly with no reader to read its tree", async () => {
    const { calls, trees } = reader([{ pid: gone, startedAt: 100 }])
    const terminated: number[] = []
    const terminate = (pid: number) => {
      terminated.push(pid)
    }

    await endProcess({ pid: gone, start: 100 }, false, trees, terminate)
    await endProcess({ pid: gone, start: 100 }, true, undefined, terminate)
    await endProcess({ pid: gone, start: 100 }, true, trees, terminate)

    // Only the forcible end with a reader went to the tree.
    expect(terminated).toEqual([gone, gone])
    expect(calls.read).toEqual([gone])
  })

  // A wait that stalled would take its 30 s, past this test's time.
  it(
    "stops waiting for a member whose pid another user's process has since",
    { timeout: 2_000 },
    async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
      })
      onTestFinished(() => kill.mockRestore())
      const tree = [{ pid: gone, startedAt: 100 }]
      const { calls, trees } = reader(tree)

      await endTree({ pid: gone, start: 100 }, trees)

      expect(calls.end).toEqual([tree])
    },
  )

  // Waiting its 30 s would take it past this test's time.
  it("waits for a tree that won't end no later than it is told", { timeout: 2_000 }, async () => {
    // This worker, which runs throughout.
    const tree = [{ pid: process.pid, startedAt: 100 }]
    const { calls, trees } = reader(tree)

    await endTree({ pid: process.pid, start: 100 }, trees, async () => {}, Date.now() + 200)

    expect(calls.end).toEqual([tree])
  })

  it("ends it by recorded parents where its reader can't read the tree", async () => {
    const { trees } = reader(undefined)
    const killed: number[] = []

    await endTree({ pid: gone, start: 100 }, trees, async (pid) => {
      killed.push(pid)
    })

    expect(killed).toEqual([gone])
  })
})
