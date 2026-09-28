import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { render } from "../../test/render"
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

  it("opens the welcome dialog again", () => {
    const { backend } = runnerBackend(runner, listing, {
      debug: debug(),
      agents: [],
      onboarded: true,
    })
    const Panel = backend.DebugPanel!
    const app = render(
      createElement(Panel, {
        addTerminal: () => {
          throw new Error("Not used here.")
        },
        startFresh: () => {},
        selected: () => undefined,
      }),
    )
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "D", ctrlKey: true, shiftKey: true }),
      )
    })
    const button = [...app.container.querySelectorAll("button")].find((element) =>
      element.textContent?.startsWith("Welcome dialog"),
    )
    expect(backend.agents?.onboarding.getSnapshot()).toBe(false)
    act(() => button!.click())
    expect(backend.agents?.onboarding.getSnapshot()).toBe(true)
    app.unmount()
  })

  it("is there when the launch offers it", () => {
    expect(runnerBackend(runner, listing, { debug: debug() }).backend.DebugPanel).toBeTypeOf(
      "function",
    )
  })
})
