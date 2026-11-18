import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { calmMs, hostPollMs, strainMs, type HostReading, type TerminalCpu } from "./host-load.js"
import { HostWatch, type WatchedRecord } from "./host-watch.js"

const cores = 4

const terminal = (id: string, session: string, agent: boolean, pending = false): WatchedRecord =>
  ({
    summary: { id, handle: id, sessionId: session },
    terminal: { exit: null, exiting: false, pty: { pid: id.charCodeAt(0) } },
    bound: agent
      ? {
          activity: {
            pending: pending
              ? [{ kind: "question", toolName: "Ask", subject: null, askedAt: 0 }]
              : [],
          },
        }
      : null,
  }) as unknown as WatchedRecord

/** A watch over `records`, read against a host `busy` percent busy and each terminal's use. */
const rig = (records: WatchedRecord[]) => {
  const notices: [string, string][] = []
  let at = 0
  let busyMs = 0
  let totalMs = 0
  const used = new Map<string, number>()
  let now = { busy: 0, use: {} as Record<string, number> }
  const watch = new HostWatch(
    {
      stopping: () => false,
      records: () => records,
      trees: () => ({ read: async () => undefined }),
      messaging: () => ({
        notice: (id: string, text: string) => {
          notices.push([id, text])
          return true
        },
      }),
    },
    {
      host: async (): Promise<HostReading> => {
        at += hostPollMs
        totalMs += hostPollMs * cores
        busyMs += (hostPollMs * cores * now.busy) / 100
        vi.setSystemTime(at)
        return { at: Date.now(), busyMs, totalMs }
      },
      processes: async (shells) => {
        const read = new Map<string, TerminalCpu>()
        for (const id of shells.keys()) {
          used.set(id, (used.get(id) ?? 0) + (hostPollMs * cores * (now.use[id] ?? 0)) / 100)
          read.set(id, { ms: used.get(id)!, programs: [] })
        }
        return read
      },
    },
  )
  return {
    watch,
    notices,
    tick: async (busy: number, use: Record<string, number>) => {
      now = { busy, use }
      return watch.tick()
    },
    /** `times` readings in a row, one after the other. */
    repeat: async (times: number, busy: number, use: Record<string, number>) => {
      now = { busy, use }
      for (let index = 0; index < times; index += 1)
        // eslint-disable-next-line no-await-in-loop -- Each reading is read against the last.
        await watch.tick()
    },
  }
}

describe("watching the host", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: 0 }))
  afterEach(() => vi.useRealTimers())

  it("reads nothing while no terminal runs an agent", async () => {
    const { watch, tick } = rig([terminal("a", "s", false)])
    expect(await tick(99, { a: 90 })).toBeUndefined()
    expect(watch.listing("a", [terminal("a", "s", false)])).toBeUndefined()
  })

  it("lists who uses the CPU once it is high, and nothing when it is quiet", async () => {
    const records = [terminal("a", "s", true), terminal("b", "s", true)]
    const { watch, tick } = rig(records)
    await tick(10, {})
    await tick(30, { a: 10 })
    expect(watch.listing("a", records)).toBeUndefined()
    await tick(95, { a: 50, b: 30 })
    expect(watch.listing("a", records)).toBe(
      [
        "Host load now: CPU 95%.",
        "Most CPU, of the machine's: you 50%, @b 30%, everything else (other projects, other programs) 15%.",
      ].join("\n"),
    )
  })

  it("tells the agents using the CPU once, when it stayed high, not one waiting on the person", async () => {
    const records = [
      terminal("a", "s", true),
      terminal("b", "s", true),
      terminal("c", "s", true, true),
      terminal("d", "s", false),
    ]
    const { notices, tick, repeat } = rig(records)
    await tick(95, {})
    const ticks = Math.ceil(strainMs / hostPollMs) + 2
    await repeat(ticks, 96, { a: 40, b: 30, c: 15, d: 5 })
    expect(notices.map(([id]) => id)).toEqual(["a", "b"])
    expect(notices[0]![1]).toMatch(
      /^Novadeck: automatic notice, not from the user: Host CPU has been at 90% or more for \d+ min; heaviest here: you 40%, @b 30%, @c 15%\.$/,
    )
    await repeat(10, 96, { a: 40, b: 30, c: 15 })
    expect(notices).toHaveLength(2)
    expect(calmMs).toBeGreaterThan(hostPollMs)
  })
})
