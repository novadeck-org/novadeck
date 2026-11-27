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

  it("runs until its program has run and left the shell, then is done, with how long it took", () => {
    const { store, set } = world({ state: "starting" })
    const follower = followTerminal(store, "t1", Date.now())
    const told = vi.fn<() => void>()
    follower.subscribe(told)
    expect(follower.get().phase).toBe("running")
    set({ state: "idle", busy: true })
    vi.advanceTimersByTime(12_000)
    expect(follower.get().phase).toBe("running")
    set({ state: "idle", busy: false })
    expect(follower.get()).toEqual({ phase: "done", ms: 12_000 })
    expect(told).toHaveBeenCalled()
  })

  it("takes a command that never showed a program as done once it has settled at the prompt", () => {
    const { store } = world({ state: "idle" })
    const follower = followTerminal(store, "t1", Date.now())
    follower.subscribe(() => {})
    vi.advanceTimersByTime(settleMs - 1)
    expect(follower.get().phase).toBe("running")
    vi.advanceTimersByTime(2)
    expect(follower.get().phase).toBe("done")
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

  it("keeps where it got to while nothing listens, and listens to nothing then", () => {
    const { store, set } = world({ state: "idle", busy: true })
    const follower = followTerminal(store, "t1", Date.now())
    const stop = follower.subscribe(() => {})
    set({ state: "idle", busy: false })
    stop()
    expect(follower.get().phase).toBe("done")
    follower.subscribe(() => {})
    expect(follower.get().phase).toBe("done")
  })
})
