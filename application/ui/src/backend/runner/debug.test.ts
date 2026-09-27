import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { createBootRehearsals } from "../boot-rehearsal"
import { runnerBackend, type RunnerApi } from "./backend"
import { createRunnerDebug } from "./debug"
import type { RunnerListing } from "./seed"

afterEach(() => void vi.useRealTimers())

const debug = () => createRunnerDebug({ rehearsals: createBootRehearsals() })

describe("runner debug hooks", () => {
  context("arming the next create", () => {
    it("hands the override to one create, then none", () => {
      const hooks = debug()
      hooks.armCreate({ fail: "TERMINAL_LIMIT" })
      expect(hooks.takeCreate()).toEqual({ fail: "TERMINAL_LIMIT" })
      expect(hooks.takeCreate()).toEqual({})
    })
  })

  context("forcing a reconnection", () => {
    it("shows an outage for the given time, then clears it", () => {
      vi.useFakeTimers()
      const hooks = debug()
      hooks.forceReconnecting(5_000)
      expect(hooks.outage.getSnapshot()).toBe(true)
      vi.advanceTimersByTime(5_000)
      expect(hooks.outage.getSnapshot()).toBe(false)
    })
  })

  it("rehearses boots through the app's rehearsals", () => {
    const rehearsals = createBootRehearsals()
    createRunnerDebug({ rehearsals }).rehearse({ fail: "UNAUTHORIZED" })
    expect(rehearsals.reboots.getSnapshot()).toBe(1)
  })
})

describe("the debug panel", () => {
  const listing: RunnerListing = [
    {
      project: { id: "p", name: "P", cwd: "/tmp" },
      sessions: [{ session: { id: "s", projectId: "p", name: "S", state: null }, terminals: [] }],
    },
  ]
  // Creating a backend reaches nothing, so no runner is needed.
  const runner = {} as RunnerApi

  it("is absent when the launch does not offer it", () => {
    expect(runnerBackend(runner, listing).backend.DebugPanel).toBeUndefined()
  })

  it("is there when the launch offers it", () => {
    expect(runnerBackend(runner, listing, { debug: debug() }).backend.DebugPanel).toBeTypeOf(
      "function",
    )
  })
})
