import { workspaceFromSeed } from "@novadeck/core/seed"
import { workspaceReducer } from "@novadeck/core/state"
import type { TerminalStatus } from "@novadeck/core/types"
import { afterEach, vi } from "vitest"

import { plainDemo } from "./index"
import { demoSeed } from "./samples"
import {
  createDemoSource,
  endTurnIn,
  isDemoSource,
  nextFile,
  sourcePaths,
  sourceThird,
  storefrontSource,
  withSource,
  workingInSeed,
  writeTo,
  type SourceClock,
} from "./source"
import { context, describe, expect, it } from "./test"
import { demoTurns } from "./turns"
import { visitorSeed } from "./visitor/seed"

const now = 1_000_000

// A clock whose timers run when a test advances it, and whose rolls are fixed.
const manual = (roll = 0.5) => {
  let time = now
  let hidden = false
  const timers = new Map<number, { at: number; run: () => void }>()
  let next = 0
  const clock: SourceClock = {
    now: () => time,
    random: () => roll,
    after: (ms, run) => {
      const id = next++
      timers.set(id, { at: time + ms, run })
      return () => void timers.delete(id)
    },
    hidden: () => hidden,
  }
  const advance = (ms: number): void => {
    const until = time + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
      const first = due.toSorted((a, b) => a[1].at - b[1].at)[0]
      if (!first) break
      timers.delete(first[0])
      time = first[1].at
      first[1].run()
    }
    time = until
  }
  return {
    clock,
    advance,
    pending: () => timers.size,
    hide: (value: boolean) => void (hidden = value),
  }
}

const project = (source: ReturnType<typeof createDemoSource>) =>
  source.state.getSnapshot().projects.storefront!

describe("the storefront's source at boot", () => {
  it("has Moth's work behind it and Crow writing its test", () => {
    const { changes, writing } = storefrontSource(now)
    expect(changes["src/cart/useCart.ts"]).toEqual({
      kind: "modified",
      touched: { moth: now - 7 * 60_000 },
    })
    expect(changes["src/checkout/OrderSummary.tsx"]?.kind).toBe("added")
    expect(changes["src/checkout/LegacyCheckout.tsx"]?.kind).toBe("deleted")
    expect(Object.keys(changes[sourcePaths.checkout]!.touched)).toEqual(["moth", "crow"])
    expect(writing).toEqual({ crow: sourcePaths.checkoutTest })
  })

  it("has nobody writing where no agent works", () => {
    expect(storefrontSource(now, []).writing).toEqual({})
  })
})

describe("who works as the demo opens", () => {
  it("is nobody in the agents demo, where Moth waits on its plan and Codex on a permission", () => {
    const { seed, source } = plainDemo("agents")
    expect(workingInSeed(seed)).toEqual([])
    expect(isDemoSource(source) && source.state.getSnapshot().projects.storefront!.writing).toEqual(
      {},
    )
  })

  it("is Crow in the try demo, and Moth too while Claude Code still reads its plan", () => {
    expect(workingInSeed(visitorSeed(now, false))).toEqual(["crow"])
    expect(workingInSeed(visitorSeed(now, true))).toEqual(["moth", "crow"])
  })

  it("marks every variant as the demo, which shows the Source panel", () => {
    for (const variant of ["plain", "welcome", "agents", "messages", "inbox"] as const)
      expect(plainDemo(variant).demo).toBe(true)
  })

  it("has no Source in the demos whose storefront runs no agents", () => {
    expect(plainDemo("plain").source).toBeUndefined()
    expect(plainDemo("welcome").source).toBeUndefined()
    for (const variant of ["agents", "messages", "inbox"] as const)
      expect(isDemoSource(plainDemo(variant).source)).toBe(true)
  })
})

describe("a write to the project", () => {
  it("moves the agent's time on and makes the file the one it writes", () => {
    const after = writeTo(storefrontSource(now), "crow", sourcePaths.checkoutTest, now + 5)
    expect(after.changes[sourcePaths.checkoutTest]).toEqual({
      kind: "modified",
      touched: { crow: now + 5 },
    })
    expect(after.writing.crow).toBe(sourcePaths.checkoutTest)
  })

  it("keeps what other agents did to the file", () => {
    const after = writeTo(storefrontSource(now), sourceThird, sourcePaths.checkout, now + 5)
    expect(Object.keys(after.changes[sourcePaths.checkout]!.touched).toSorted()).toEqual([
      "crow",
      "moth",
      "owl",
    ])
  })

  it("adds a file the tree doesn't have", () => {
    const after = writeTo(storefrontSource(now), "crow", sourcePaths.payments, now)
    expect(after.changes[sourcePaths.payments]?.kind).toBe("added")
  })

  it("leaves the project it was given as it was", () => {
    const before = storefrontSource(now)
    writeTo(before, "crow", sourcePaths.payments, now)
    expect(before.changes[sourcePaths.payments]).toBeUndefined()
  })
})

describe("the end of a turn", () => {
  it("takes the agent's file away and keeps its changes", () => {
    const after = endTurnIn(storefrontSource(now), "crow")
    expect(after.writing).toEqual({})
    expect(after.changes[sourcePaths.checkoutTest]).toBeDefined()
  })
})

describe("the file an agent writes next", () => {
  const before = storefrontSource(now)

  it("is mostly the one it is on", () => {
    expect(nextFile(before, "crow", 0.9, 0)).toBe(sourcePaths.checkoutTest)
  })

  it("is sometimes another of its pool", () => {
    expect(nextFile(before, "crow", 0.2, 0)).toBe(sourcePaths.checkout)
  })

  it("is a new file the first time it rolls low, and not after", () => {
    const created = nextFile(before, "crow", 0.05, 0)
    expect(created).toBe("src/checkout/PaymentForm.tsx")
    const later = writeTo(before, "crow", created, now)
    expect(nextFile(later, "crow", 0.05, 0)).toBe(sourcePaths.payments)
  })

  it("is never a new file for an agent that creates none", () => {
    expect(nextFile(before, "moth", 0.05, 0)).toBe("src/cart/useCart.ts")
  })
})

describe("the demo source", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("is the demo's, which the debug panel writes to", () => {
    expect(isDemoSource(createDemoSource(now))).toBe(true)
    expect(isDemoSource({ state: createDemoSource(now).state })).toBe(false)
  })

  it("has the storefront and no other project", () => {
    expect(Object.keys(createDemoSource(now).state.getSnapshot().projects)).toEqual(["storefront"])
  })

  it("writes at the clock's time", () => {
    const { clock, advance } = manual()
    const source = createDemoSource(now, clock)
    advance(2000)
    source.write("crow", sourcePaths.payments)
    expect(project(source).changes[sourcePaths.payments]?.touched.crow).toBe(now + 2000)
  })

  context("running", () => {
    it("has Crow write every few seconds", () => {
      const { clock, advance } = manual()
      const source = createDemoSource(now, clock)
      const stop = source.start()
      advance(4999)
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      advance(1)
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(now + 5000)
      stop()
    })

    it("has Crow end its turn for a rest, then write again", () => {
      const { clock, advance } = manual()
      const source = createDemoSource(now, clock)
      const stop = source.start()
      // Six writes a turn at a roll of one half, 5 s apart.
      advance(5000 * 6)
      expect(project(source).writing.crow).toBeUndefined()
      advance(15_000 + 5000)
      expect(project(source).writing.crow).toBe(sourcePaths.checkoutTest)
      stop()
    })

    it("writes nothing while the page is hidden", () => {
      const { clock, advance, hide } = manual()
      const source = createDemoSource(now, clock)
      const stop = source.start()
      hide(true)
      advance(60_000)
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      stop()
    })

    it("stops with its stop", () => {
      const { clock, pending } = manual()
      const stop = createDemoSource(now, clock).start()
      stop()
      expect(pending()).toBe(0)
    })

    it("leaves Moth still while it waits", () => {
      const { clock, advance } = manual()
      const source = createDemoSource(now, clock)
      const stop = source.start(demoTurns())
      advance(120_000)
      expect(project(source).changes["src/cart/useCart.ts"]!.touched.moth).toBe(now - 7 * 60_000)
      expect(project(source).writing.moth).toBeUndefined()
      stop()
    })

    it("has Moth write while its turn works and stop when it ends", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      const key = {
        projectId: "storefront",
        workspaceSessionId: "initial",
        terminalId: "storefront-initial-01",
      }
      turns.work(key, undefined)
      advance(5000)
      expect(project(source).writing.moth).toBe("src/cart/CartSummary.tsx")
      turns.rest(key, undefined)
      expect(project(source).writing.moth).toBeUndefined()
      stop()
    })

    const crowKey = {
      projectId: "storefront",
      workspaceSessionId: "initial",
      terminalId: "storefront-initial-04",
    }
    const mothKey = { ...crowKey, terminalId: "storefront-initial-01" }

    it("leaves Crow still while its agent waits on the person, and has it write again after", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      turns.ask(crowKey, undefined, "permission", 1)
      expect(project(source).writing.crow).toBeUndefined()
      advance(60_000)
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      turns.work(crowKey, undefined)
      advance(5000)
      expect(project(source).writing.crow).toBe(sourcePaths.checkoutTest)
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(now + 65_000)
      stop()
    })

    it("has Crow write through no permission prompt that is open", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      advance(5000)
      turns.ask(crowKey, undefined, "question", 1)
      const touched = project(source).changes[sourcePaths.checkoutTest]!.touched.crow
      advance(60_000)
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(touched)
      stop()
    })

    it("does not start Moth writing on a request", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      turns.ask(mothKey, undefined, "permission", 1)
      advance(60_000)
      expect(project(source).writing.moth).toBeUndefined()
      expect(project(source).changes["src/cart/useCart.ts"]!.touched.moth).toBe(now - 7 * 60_000)
      stop()
    })

    it("has nothing write when the agent rests, and Crow's cursor go", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      turns.rest(crowKey, undefined)
      expect(project(source).writing.crow).toBeUndefined()
      advance(60_000)
      expect(project(source).writing.crow).toBeUndefined()
      stop()
    })

    it("leaves no cursor when it stops", () => {
      const { clock, advance } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      turns.work(mothKey, undefined)
      advance(5000)
      expect(Object.keys(project(source).writing).toSorted()).toEqual(["crow", "moth"])
      stop()
      expect(project(source).writing).toEqual({})
    })

    it("moves nothing where the visitor asked for less motion", () => {
      vi.stubGlobal("matchMedia", () => ({ matches: true }))
      const { clock, pending } = manual()
      const stop = createDemoSource(now, clock).start()
      expect(pending()).toBe(0)
      stop()
    })

    it("moves nothing on a page held still", () => {
      vi.stubGlobal("location", { search: "?still" })
      const { clock, pending } = manual()
      createDemoSource(now, clock).start()
      expect(pending()).toBe(0)
    })

    it("takes Crow's cursor away on a page held still once its agent waits on the person", () => {
      vi.stubGlobal("location", { search: "?still" })
      const { clock } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      source.start(turns)
      expect(project(source).writing.crow).toBe(sourcePaths.checkoutTest)
      turns.ask(crowKey, undefined, "permission", 1)
      expect(project(source).writing.crow).toBeUndefined()
    })

    it("has Crow write no more once its terminal closes, even when its agent works again", () => {
      const { clock, advance, pending } = manual()
      const turns = demoTurns()
      const source = createDemoSource(now, clock)
      const stop = source.start(turns)
      source.close(crowKey.terminalId)
      expect(project(source).writing.crow).toBeUndefined()
      expect(pending()).toBe(0)
      turns.work(crowKey, undefined)
      advance(60_000)
      expect(project(source).writing.crow).toBeUndefined()
      expect(project(source).changes[sourcePaths.checkoutTest]!.touched.crow).toBe(now - 20_000)
      stop()
    })
  })
})

describe("a backend with the demo's Source", () => {
  const target = { projectId: "storefront", workspaceSessionId: "initial" }
  const workspace = workspaceFromSeed(demoSeed(now), { view: "focus", windowedView: "grid", now })

  it("stops the agent of a terminal that closes", () => {
    const { clock, pending } = manual()
    const source = createDemoSource(now, clock)
    const stop = source.start()
    withSource(plainDemo("plain"), undefined, source).commit(workspace, [
      { type: "terminal/close", target, terminalId: "storefront-initial-04" },
    ])
    expect(project(source).writing.crow).toBeUndefined()
    expect(pending()).toBe(0)
    stop()
  })

  // The try demo's workspace, where Moth and Crow work and ask nothing.
  const working = workspaceFromSeed(visitorSeed(now, true), {
    view: "focus",
    windowedView: "grid",
    now,
  })
  const crowId = "storefront-initial-04"
  const started = () => {
    const { clock, advance } = manual()
    const turns = demoTurns()
    const source = createDemoSource(now, clock, ["moth", "crow"])
    const stop = source.start(turns)
    // Both have written by now.
    advance(5000)
    return { source, turns, advance, stop }
  }

  it("keeps the agents going when the storefront project is refused removal", () => {
    const { source, stop } = started()
    expect(Object.keys(project(source).writing).toSorted()).toEqual(["crow", "moth"])
    withSource(plainDemo("plain"), undefined, source).commit(working, [
      { type: "project/remove", projectId: "storefront", now },
    ])
    expect(Object.keys(project(source).writing).toSorted()).toEqual(["crow", "moth"])
    stop()
  })

  it("stops every agent when the storefront project is really gone", () => {
    const { source, turns, advance, stop } = started()
    const gone = {
      ...working,
      projects: working.projects.filter((each) => each.id !== "storefront"),
    }
    withSource(plainDemo("plain"), turns, source).commit(gone, [
      { type: "project/remove", projectId: "storefront", now },
    ])
    expect(project(source).writing).toEqual({})
    advance(60_000)
    expect(project(source).writing).toEqual({})
    stop()
  })

  // What the debug panel does to a terminal: it releases the agent and dispatches a status
  // itself, so the turns never report it.
  const dispatched = (status: TerminalStatus) => {
    const action = { type: "terminal/status" as const, target, terminalId: crowId, status }
    return { action, after: workspaceReducer(working, action) }
  }

  it("stops Crow writing once its terminal is at a prompt, however it got there", () => {
    const { source, turns, advance, stop } = started()
    expect(project(source).writing.crow).toBeDefined()
    turns.release({ ...target, terminalId: crowId })
    const { action, after } = dispatched({ state: "running" })
    withSource(plainDemo("plain"), turns, source).commit(after, [action])
    expect(project(source).writing.crow).toBeUndefined()
    advance(60_000)
    expect(project(source).writing.crow).toBeUndefined()
    expect(project(source).writing.moth).toBeDefined()
    stop()
  })

  it("stops Crow writing once its terminal failed, as in the crash loop", () => {
    const { source, advance, stop } = started()
    const { action, after } = dispatched({ state: "failed", message: "crashed" })
    withSource(plainDemo("plain"), undefined, source).commit(after, [action])
    expect(project(source).writing.crow).toBeUndefined()
    advance(60_000)
    expect(project(source).writing.crow).toBeUndefined()
    stop()
  })

  it("has Crow write again when its agent is reported working after that", () => {
    const { source, turns, advance, stop } = started()
    const { action, after } = dispatched({ state: "running" })
    withSource(plainDemo("plain"), turns, source).commit(after, [action])
    expect(project(source).writing.crow).toBeUndefined()
    turns.work({ ...target, terminalId: crowId }, undefined)
    advance(8000)
    expect(project(source).writing.crow).toBeDefined()
    stop()
  })
})
