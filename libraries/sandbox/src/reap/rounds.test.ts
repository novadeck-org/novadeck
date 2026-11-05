import { describe, expect, it } from "vitest"

import type { Process, Table } from "./process.js"
import { reapTable } from "./rounds.js"

const sandbox = { root: "/sandbox", home: "/sandbox/home", started: 0 }

// A table whose `list` gives a new process each time, as a supervisor that restarts its
// worker whenever it is ended does, every one still running as long as `alive` says.
const respawning = (alive: boolean) => {
  let next = 100
  const ended: [number, boolean][] = []
  const table: Table = {
    list: async () => {
      next += 1
      return [{ pid: next, comm: "worker", start: next, stopped: false }]
    },
    alive: () => alive,
    current: async (_sandbox, found) => found,
    end: async (one: Process, forcibly) => {
      ended.push([one.pid, forcibly])
    },
  }
  return { table, ended }
}

describe("reaping round by round", () => {
  it("names, and ends, one still running unseen after its last round", async () => {
    const { table, ended } = respawning(false)

    const leftovers = await reapTable(table, sandbox, 15_000)

    expect(leftovers).toEqual([
      "worker (101)",
      "worker (102)",
      "worker (103)",
      "worker (104)",
      "worker (105)",
      "worker (106) ended unwaited as reaping ran out",
    ])
    expect(ended.filter(([pid]) => pid === 106)).toEqual([[106, true]])
  })

  it("ends within its time, however long what it ends takes", async () => {
    const { table } = respawning(true)
    const began = Date.now()

    const leftovers = await reapTable(table, sandbox, 300)

    expect(Date.now() - began).toBeLessThan(1500)
    expect(leftovers).toEqual(["worker (101)", "worker (102) ended unwaited as reaping ran out"])
  })

  it("names nothing when nothing runs", async () => {
    const table: Table = {
      list: async () => [],
      alive: () => false,
      current: async () => [],
      end: async () => {},
    }

    expect(await reapTable(table, sandbox, 15_000)).toEqual([])
  })
})
