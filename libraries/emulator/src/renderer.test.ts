// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"

import { contextCap, createRenderers, probeWebgl, type Drawing } from "./renderer.js"

const setup = ({ cap = 2, supported = true, failing = false } = {}) => {
  const state = { ligatures: false, failing, loads: 0 }
  // Work the pool leaves until the moment is over, run when the test says it is.
  const deferred: (() => void)[] = []
  const log: string[] = []
  let changed = (): void => {}
  const drawings = new Map<string, FakeDrawing>()
  class FakeDrawing implements Drawing {
    disposed = false
    cleared = 0
    lose = (): void => {}
    onContextLoss = (listener: () => void) => {
      this.lose = listener
      return { dispose: () => {} }
    }
    clearTextureAtlas = () => void (this.cleared += 1)
    constructor(readonly name: string) {}
    dispose = () => {
      this.disposed = true
      log.push(`drop ${this.name}`)
    }
  }
  const pool = createRenderers<string>({
    load: (name) => {
      state.loads += 1
      log.push(`load ${name}`)
      if (state.failing) throw new Error("no context")
      const drawing = new FakeDrawing(name)
      drawings.set(name, drawing)
      return drawing
    },
    supported: () => supported,
    cap,
    ligatures: () => state.ligatures,
    watchLigatures: (listener) => {
      changed = listener
      return () => {}
    },
    defer: (work) => void deferred.push(work),
  })
  const live = (name: string): boolean => {
    const drawing = drawings.get(name)
    return Boolean(drawing && !drawing.disposed)
  }
  return {
    pool,
    state,
    live,
    log,
    // The moment is over: what the pool left for then runs.
    settle: () => deferred.splice(0).forEach((work) => work()),
    drawing: (name: string) => drawings.get(name)!,
    ligatures: (on: boolean) => {
      state.ligatures = on
      changed()
    },
  }
}

describe("the renderer budget", () => {
  it("fits a page of 13 terminals, two contexts short of Chromium's 16", () => {
    expect(contextCap).toBeGreaterThanOrEqual(13)
    expect(contextCap).toBeLessThanOrEqual(16 - 2)
  })

  it("gives shown screens a context up to the cap and leaves the rest on the DOM", () => {
    const { pool, live } = setup()
    for (const name of ["a", "b", "c"]) pool.screen(name).take()
    expect([live("a"), live("b"), live("c")]).toEqual([true, true, false])
  })

  it("gives a freed slot to the longest waiting shown screen", () => {
    const { pool, live } = setup()
    const a = pool.screen("a")
    const [b, c, d] = ["b", "c", "d"].map((name) => pool.screen(name))
    a.take()
    b!.take()
    c!.take()
    d!.take()
    a.release()
    expect([live("a"), live("b"), live("c"), live("d")]).toEqual([false, true, true, false])
    b!.dispose()
    expect(live("d")).toBe(true)
  })

  it("keeps a screen shown where WebGL isn't wanted on the DOM, its slot to a waiter", () => {
    const { pool, live } = setup()
    const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
    a!.take()
    b!.take()
    c!.take()
    a!.take(false)
    expect([live("a"), live("b"), live("c")]).toEqual([false, true, true])
    b!.release()
    a!.take(true)
    expect([live("a"), live("c")]).toEqual([true, true])
  })

  it("tells a screen each time it changes renderer, but not as it closes", () => {
    const { pool } = setup()
    const told: string[] = []
    const a = pool.screen("a", () => told.push("a"))
    a.take()
    a.release()
    a.take()
    a.dispose()
    expect(told).toEqual(["a", "a", "a"])
  })

  it("takes nothing for a parked screen", () => {
    const { pool, live } = setup()
    const a = pool.screen("a")
    a.take()
    a.release()
    expect(live("a")).toBe(false)
    a.take()
    expect(live("a")).toBe(true)
  })

  it("never loads where WebGL is unsupported", () => {
    const { pool, state } = setup({ supported: false })
    pool.screen("a").take()
    expect(state.loads).toBe(0)
  })

  it("retries once where loading throws, on the next take, then stays on the DOM", () => {
    const { pool, state } = setup({ failing: true })
    const a = pool.screen("a")
    a.take()
    a.take()
    expect(state.loads).toBe(1)
    a.release()
    a.take()
    expect(state.loads).toBe(2)
    a.release()
    a.take()
    expect(state.loads).toBe(2)
  })

  it("retries once after a lost context, on the next take, then stays on the DOM", () => {
    const { pool, live, drawing, state } = setup()
    const a = pool.screen("a")
    a.take()
    drawing("a").lose()
    expect(live("a")).toBe(false)
    expect(drawing("a").disposed).toBe(true)
    expect(state.loads).toBe(1)
    a.release()
    a.take()
    expect(live("a")).toBe(true)
    drawing("a").lose()
    a.release()
    a.take()
    expect(live("a")).toBe(false)
    expect(state.loads).toBe(2)
  })

  it("hands a lost context's slot to a waiter", () => {
    const { pool, live, drawing } = setup({ cap: 1 })
    pool.screen("a").take()
    pool.screen("b").take()
    drawing("a").lose()
    expect(live("b")).toBe(true)
  })

  it("keeps every screen on the DOM renderer while ligatures are on", () => {
    const { pool, live, ligatures } = setup()
    pool.screen("a").take()
    ligatures(true)
    expect(live("a")).toBe(false)
    pool.screen("b").take()
    expect(live("b")).toBe(false)
    ligatures(false)
    expect([live("a"), live("b")]).toEqual([true, true])
  })

  it("clears the texture atlas of a screen that has one", () => {
    const { pool, drawing } = setup()
    const a = pool.screen("a")
    a.refresh()
    a.take()
    a.refresh()
    expect(drawing("a").cleared).toBe(1)
  })

  describe("with screens nobody shows for the moment", () => {
    it("keeps their contexts while no shown screen waits", () => {
      const { pool, live } = setup()
      const [a, b] = ["a", "b"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      a!.idle()
      b!.idle()
      expect([live("a"), live("b")]).toEqual([true, true])
      pool.screen("c").take(false)
      expect([live("a"), live("b")]).toEqual([true, true])
    })

    it("gives a waiting screen the context of the one idle longest, once the moment is over", () => {
      const { pool, live, settle } = setup()
      const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      b!.idle()
      a!.idle()
      c!.take()
      expect(live("c")).toBe(false)
      settle()
      expect([live("a"), live("b"), live("c")]).toEqual([true, false, true])
    })

    it("never takes the context of a shown screen for a waiter", () => {
      const { pool, live } = setup()
      const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      c!.take()
      expect([live("a"), live("b"), live("c")]).toEqual([true, true, false])
    })

    it("lets a screen whose context went to a waiter draw again when it is shown", () => {
      const { pool, live, settle } = setup()
      const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      a!.idle()
      c!.take()
      settle()
      expect(live("a")).toBe(false)
      c!.release()
      a!.take()
      expect(live("a")).toBe(true)
    })

    it("does not give a context to an idle screen that has none", () => {
      const { pool, live } = setup()
      const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      c!.take()
      c!.idle()
      a!.release()
      expect(live("c")).toBe(false)
    })

    it("gives an idle screen's context to a screen already waiting", () => {
      const { pool, live, settle } = setup()
      const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      c!.take()
      a!.idle()
      settle()
      expect([live("a"), live("c")]).toEqual([false, true])
    })

    it("takes nothing from screens shown again in the same moment, waiter or not", () => {
      const { pool, live, log, settle } = setup({ cap: 3 })
      const [t1, t2, t3, t4] = ["t1", "t2", "t3", "t4"].map((name) => pool.screen(name))
      for (const screen of [t1, t2, t3, t4]) screen!.take()
      log.length = 0
      // A view switch: every surface goes, and all come back, the waiter first.
      for (const screen of [t1, t2, t3, t4]) screen!.idle()
      for (const screen of [t4, t1, t2, t3]) screen!.take()
      settle()
      expect(log).toEqual([])
      expect([live("t1"), live("t2"), live("t3"), live("t4")]).toEqual([true, true, true, false])
    })

    it("does not churn when screens are released and taken again in one go", () => {
      const { pool, live, state } = setup()
      const told: string[] = []
      const [a, b] = ["a", "b"].map((name) => pool.screen(name, () => told.push(name)))
      a!.take()
      b!.take()
      told.length = 0
      a!.idle()
      b!.idle()
      a!.take()
      b!.take()
      expect([live("a"), live("b")]).toEqual([true, true])
      expect(state.loads).toBe(2)
      expect(told).toEqual([])
    })

    it("tells the screen that loses its context", () => {
      const { pool, settle } = setup({ cap: 1 })
      const told: string[] = []
      const a = pool.screen("a", () => told.push("a"))
      a.take()
      a.idle()
      pool.screen("b").take()
      settle()
      expect(told).toEqual(["a", "a"])
    })
  })
})

describe("probing for WebGL", () => {
  it("frees the probe's context even when asking it throws", () => {
    const lose = vi.fn<() => void>()
    vi.stubGlobal("WebGL2RenderingContext", Object)
    const context = {
      RENDERER: 0,
      getExtension: (name: string) =>
        name === "WEBGL_lose_context" ? { loseContext: lose } : null,
      getParameter: () => {
        throw new Error("context lost")
      },
    }
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as never)
    try {
      expect(probeWebgl()).toBe(false)
      expect(lose).toHaveBeenCalledTimes(1)
    } finally {
      getContext.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
