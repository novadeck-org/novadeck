import { describe, expect, it, vi } from "vitest"

import { boosting, type BoostParts } from "./boost.js"
import type { Listed } from "./descendants.js"
import { activeCpuWeight, terminalCpuWeight } from "./scopes.js"

const row = (pid: number, parent: number, extra: Partial<Listed> = {}): Listed => ({
  pid,
  parent,
  group: pid,
  foreground: 0,
  started: "1",
  zombie: false,
  ...extra,
})

const parts = (extra: Partial<BoostParts> = {}) => {
  const weights: number[] = []
  const raised: number[] = []
  const lowered: number[] = []
  const all: BoostParts = {
    scope: { weigh: (weight) => void weights.push(weight) as never },
    priority: { raise: (pid) => void raised.push(pid), lower: (pid) => void lowered.push(pid) },
    platform: "linux",
    shell: () => 10,
    running: () => true,
    ...extra,
  }
  return { all, weights, raised, lowered }
}

describe("a terminal in use", () => {
  it("weighs its scope at the app's weight, and back at the terminal weight", () => {
    const { all, weights } = parts({ priority: undefined })
    const boost = boosting(all)
    boost.set(true)
    boost.set(true)
    boost.set(false)
    expect(weights).toEqual([activeCpuWeight, terminalCpuWeight])
    expect(boost.active).toBe(false)
  })

  it("raises the shell and what runs under it, and lowers them again, on macOS", async () => {
    const rows = [row(10, 1), row(11, 10), row(12, 11), row(13, 12, { zombie: true }), row(20, 1)]
    const { all, raised, lowered } = parts({
      scope: undefined,
      platform: "darwin",
      listing: () => Promise.resolve(rows),
    })
    const boost = boosting(all)
    boost.set(true)
    await vi.waitFor(() => expect(raised).toEqual([10, 11, 12]))
    boost.set(false)
    await vi.waitFor(() => expect(lowered).toEqual([10, 11, 12]))
  })

  it("raises a Windows shell with what the relay reads of its tree", async () => {
    const { all, raised } = parts({
      scope: undefined,
      platform: "win32",
      trees: { read: () => Promise.resolve([10, 5, 6].map((pid) => ({ pid, startedAt: 1 }))) },
    })
    boosting(all).set(true)
    await vi.waitFor(() => expect(raised).toEqual([10, 5, 6]))
  })

  it("still raises the shell where the process list fails or doesn't hold it", async () => {
    const failing = parts({
      scope: undefined,
      platform: "darwin",
      listing: () => Promise.reject(new Error("slow")),
    })
    boosting(failing.all).set(true)
    await vi.waitFor(() => expect(failing.raised).toEqual([10]))
    const gone = parts({
      scope: undefined,
      platform: "darwin",
      listing: () => Promise.resolve([row(99, 1)]),
    })
    boosting(gone.all).set(true)
    await vi.waitFor(() => expect(gone.raised).toEqual([10]))
  })

  it("changes nothing before the shell's pid is known, or once the program has ended", async () => {
    const early = parts({ shell: () => undefined })
    boosting(early.all).set(true)
    const ended = parts({ running: () => false })
    boosting(ended.all).set(true)
    await Promise.resolve()
    expect([early.raised, ended.raised, ended.weights]).toEqual([[], [], []])
  })

  it("raises a terminal in use since before its shell's pid was known once it is", async () => {
    let shell: number | undefined
    const { all, raised } = parts({ scope: undefined, platform: "darwin", shell: () => shell })
    const boost = boosting(all)
    boost.known()
    boost.set(true)
    await Promise.resolve()
    expect(raised).toEqual([])
    shell = 10
    boost.known()
    await vi.waitFor(() => expect(raised).toEqual([10]))
  })

  it("does nothing where there is no scope and no priority", () => {
    const { all } = parts({ scope: undefined, priority: undefined })
    expect(() => boosting(all).set(true)).not.toThrow()
  })
})
