import type { Workspace } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { followTerminal, settleMs, standingOf } from "./files-terminals"

type Shown = { readonly state: string; readonly busy?: boolean; readonly exitCode?: number }

// A workspace with one terminal, `t1`, as `shown` says (none where undefined).
const world = (shown: Shown | undefined) => {
  let current = shown
  const listeners = new Set<() => void>()
  return {
    store: {
      getSnapshot: () =>
        ({
          projects: [
            {
              history: [
                { state: { roster: { terminals: current ? [{ id: "t1", ...current }] : [] } } },
              ],
            },
          ],
        }) as unknown as Workspace,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    },
    set: (next: Shown | undefined) => {
      current = next
      listeners.forEach((listener) => listener())
    },
  }
}

describe("following the terminal a Files card's command runs in", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("reads how a terminal stands", () => {
    expect(standingOf(world({ state: "idle", busy: true }).store.getSnapshot(), "t1")).toBe("busy")
    expect(standingOf(world({ state: "idle" }).store.getSnapshot(), "t1")).toBe("quiet")
    expect(standingOf(world({ state: "starting" }).store.getSnapshot(), "t1")).toBe("starting")
    expect(standingOf(world({ state: "exited", exitCode: 1 }).store.getSnapshot(), "t1")).toBe(
      "failed",
    )
    expect(standingOf(world(undefined).store.getSnapshot(), "t1")).toBe("gone")
  })

  it("runs until its program has run and left the shell, then is finished, with how long it ran", () => {
    const { store, set } = world({ state: "starting" })
    const follower = followTerminal(store, "t1", Date.now())
    const told = vi.fn<() => void>()
    follower.subscribe(told)
    expect(follower.get().phase).toBe("running")
    set({ state: "idle", busy: true })
    vi.advanceTimersByTime(12_000)
    expect(follower.get().phase).toBe("running")
    set({ state: "idle", busy: false })
    expect(follower.get()).toEqual({ phase: "finished", ms: 12_000 })
    expect(told).toHaveBeenCalled()
  })

  it("is not taken as over while a program runs, though its shell sat at the prompt before it", () => {
    const { store, set } = world({ state: "idle" })
    const follower = followTerminal(store, "t1", Date.now())
    vi.advanceTimersByTime(1000)
    set({ state: "idle", busy: true })
    vi.advanceTimersByTime(settleMs + 1000)
    expect(follower.get().phase).toBe("running")
    set({ state: "idle", busy: false })
    expect(follower.get()).toEqual({ phase: "finished", ms: 1000 + settleMs + 1000 })
  })

  it("takes a command never seen running as finished, with no time, once its shell has settled", () => {
    const { store } = world({ state: "idle" })
    const follower = followTerminal(store, "t1", Date.now())
    vi.advanceTimersByTime(settleMs - 1)
    expect(follower.get().phase).toBe("running")
    vi.advanceTimersByTime(2)
    expect(follower.get()).toEqual({ phase: "finished" })
  })

  it("fails where the terminal exits with a status or goes", () => {
    const exited = world({ state: "idle", busy: true })
    const one = followTerminal(exited.store, "t1", Date.now())
    one.subscribe(() => {})
    exited.set({ state: "exited", exitCode: 2 })
    expect(one.get().phase).toBe("failed")
    const gone = world({ state: "idle", busy: true })
    const two = followTerminal(gone.store, "t1", Date.now())
    two.subscribe(() => {})
    gone.set(undefined)
    expect(two.get().phase).toBe("failed")
  })

  it("keeps the time it ended at, whoever reads it later", () => {
    const { store, set } = world({ state: "idle", busy: true })
    const follower = followTerminal(store, "t1", Date.now())
    vi.advanceTimersByTime(3000)
    set({ state: "idle", busy: false })
    vi.advanceTimersByTime(60_000)
    const stop = follower.subscribe(() => {})
    expect(follower.get()).toEqual({ phase: "finished", ms: 3000 })
    stop()
  })
})
