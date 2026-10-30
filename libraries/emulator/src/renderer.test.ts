// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"

import {
  browserContexts,
  createRendererPool,
  probeWebgl,
  rendererPoolCap,
  type Drawing,
} from "./renderer.js"

const setup = ({ cap = 2, supported = true, failing = false } = {}) => {
  const state = { failing, loads: 0 }
  // Work the pool leaves until the moment is over, run when the test says it is.
  const deferred: (() => void)[] = []
  const log: string[] = []
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
    // Alone on its atlas, unless a test sets it to another drawing's.
    atlasId: unknown = this
    atlas = () => this.atlasId
    constructor(readonly name: string) {}
    dispose = () => {
      this.disposed = true
      log.push(`drop ${this.name}`)
    }
  }
  const pool = createRendererPool<string>({
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
  }
}

describe("the WebGL pool", () => {
  it("fits a page of 13 terminals, two contexts short of Chromium's 16", () => {
    expect(browserContexts).toBe(16)
    expect(rendererPoolCap(browserContexts)).toBeGreaterThanOrEqual(13)
    expect(rendererPoolCap(browserContexts)).toBeLessThanOrEqual(16 - 2)
  })

  it("takes all but two of a limit an app raised", () => {
    expect(rendererPoolCap(64)).toBe(62)
  })

  it.each([0, 2, -1, 1.5, Number.NaN])("refuses a limit of %s", (contexts) => {
    expect(() => rendererPoolCap(contexts)).toThrow(RangeError)
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

  it("tells whether WebGL draws a screen", () => {
    const { pool } = setup({ cap: 1 })
    const [a, b] = ["a", "b"].map((name) => pool.screen(name))
    expect([a!.drawn(), b!.drawn()]).toEqual([false, false])
    a!.take()
    b!.take()
    expect([a!.drawn(), b!.drawn()]).toEqual([true, false])
    a!.release()
    expect([a!.drawn(), b!.drawn()]).toEqual([false, true])
  })

  it("clears the glyph atlas of a screen that has one", () => {
    const { pool, drawing, settle } = setup()
    const a = pool.screen("a")
    a.refresh()
    a.take()
    a.refresh()
    settle()
    expect(drawing("a").cleared).toBe(1)
  })

  describe("when a screen clears its glyph atlas", () => {
    const shared = () => {
      const kit = setup({ cap: 4 })
      const screens = Object.fromEntries(
        ["a", "b", "c", "d"].map((name) => [name, kit.pool.screen(name)]),
      )
      for (const screen of Object.values(screens)) screen.take()
      // a and b draw from one atlas, c from another, d is on the DOM renderer.
      kit.drawing("b").atlasId = kit.drawing("a").atlasId
      screens.d!.release()
      return { ...kit, screens }
    }

    it("clears it for every screen drawing from the same atlas, and no other", () => {
      const { screens, drawing, settle } = shared()
      screens.a!.refresh()
      settle()
      expect(["a", "b", "c"].map((name) => drawing(name).cleared)).toEqual([1, 1, 0])
    })

    it("clears once however many of them ask in the same moment", () => {
      const { screens, drawing, settle } = shared()
      screens.a!.refresh()
      screens.b!.refresh()
      screens.a!.refresh()
      settle()
      expect(["a", "b", "c"].map((name) => drawing(name).cleared)).toEqual([1, 1, 0])
    })

    it("reads the atlases together, after the moment, not as each asks", () => {
      const { screens, drawing, settle } = shared()
      screens.c!.refresh()
      // c's atlas is shared with b by the time the moment is over.
      drawing("b").atlasId = drawing("c").atlasId
      settle()
      expect(["a", "b", "c"].map((name) => drawing(name).cleared)).toEqual([0, 1, 1])
    })

    it("leaves a screen that gave its context back, or closed, alone", () => {
      const { screens, drawing, settle } = shared()
      screens.a!.refresh()
      screens.b!.release()
      settle()
      expect(drawing("a").cleared).toBe(1)
      expect(drawing("b").cleared).toBe(0)
    })

    it("still clears its neighbours when the asking screen is let go in the same moment", () => {
      const { screens, drawing, settle } = shared()
      screens.a!.refresh()
      screens.a!.release()
      settle()
      expect(["b", "c"].map((name) => drawing(name).cleared)).toEqual([1, 0])
    })

    it("clears for a screen that asks while the clearing runs", () => {
      const { screens, drawing, settle } = shared()
      const clear = drawing("b").clearTextureAtlas
      drawing("b").clearTextureAtlas = () => {
        clear()
        screens.c!.refresh()
      }
      screens.a!.refresh()
      settle()
      settle()
      expect(drawing("c").cleared).toBe(1)
    })

    it("does nothing for a screen on the DOM renderer", () => {
      const { screens, drawing, settle } = shared()
      screens.d!.refresh()
      settle()
      expect(["a", "b", "c"].map((name) => drawing(name).cleared)).toEqual([0, 0, 0])
    })

    it("treats an atlas that is not there yet as no one else's", () => {
      const { screens, drawing, settle } = shared()
      for (const name of ["a", "b", "c"]) drawing(name).atlasId = undefined
      screens.a!.refresh()
      settle()
      expect(["a", "b", "c"].map((name) => drawing(name).cleared)).toEqual([1, 0, 0])
    })
  })

  describe("the counts", () => {
    it("start at nothing", () => {
      const { pool } = setup()
      expect(pool.stats()).toEqual({
        waits: 0,
        steals: 0,
        swaps: 0,
        lost: 0,
        failed: 0,
        resizes: 0,
        onDom: 0,
      })
    })

    it("count a screen that finds the pool full once, however often it is looked at", () => {
      const { pool } = setup()
      const [a, b, c] = ["a", "b", "c"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      c!.take()
      c!.take()
      b!.take()
      expect(pool.stats()).toMatchObject({ waits: 1, swaps: 2, onDom: 1 })
    })

    it("count every shown screen that finds the pool full, once each", () => {
      const { pool } = setup({ cap: 1 })
      for (const name of ["a", "b", "c", "d"]) pool.screen(name).take()
      expect(pool.stats()).toMatchObject({ waits: 3, onDom: 3 })
    })

    it("leave out of onDom a screen that ran out of tries after losses", () => {
      const { pool, drawing, state } = setup({ cap: 2 })
      const a = pool.screen("a")
      a.take()
      drawing("a").lose()
      a.release()
      a.take()
      drawing("a").lose()
      expect(pool.stats()).toMatchObject({ lost: 2, onDom: 0 })
      state.failing = false
    })

    it("leave idle screens out of onDom, whether they lost the context or never had it", () => {
      const first = setup({ cap: 1 })
      const [a, b] = ["a", "b"].map((name) => first.pool.screen(name))
      a!.take()
      a!.idle()
      b!.take()
      first.settle()
      expect(first.pool.stats().onDom).toBe(0)
      const second = setup({ cap: 1 })
      const [c, d] = ["c", "d"].map((name) => second.pool.screen(name))
      c!.take()
      d!.take()
      d!.idle()
      expect(second.pool.stats().onDom).toBe(0)
    })

    it("tell a watcher when the screens on the DOM change in number", () => {
      const { pool } = setup({ cap: 1 })
      const heard = vi.fn<() => void>()
      pool.watch(heard)
      const [a, b] = ["a", "b"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      heard.mockClear()
      a!.release()
      expect(pool.stats().onDom).toBe(0)
      expect(heard).toHaveBeenCalled()
    })

    it("go on when a watcher throws", () => {
      const { pool, live } = setup()
      pool.watch(() => {
        throw new Error("watcher")
      })
      pool.screen("a").take()
      expect(live("a")).toBe(true)
    })

    it("count a wait again after the screen was parked and shown afresh", () => {
      const { pool } = setup({ cap: 1 })
      const [a, b] = ["a", "b"].map((name) => pool.screen(name))
      a!.take()
      b!.take()
      b!.release()
      b!.take()
      expect(pool.stats().waits).toBe(2)
    })

    it("count contexts taken from idle screens, and the swaps both ways", () => {
      const { pool, settle, live } = setup({ cap: 1 })
      const [a, b] = ["a", "b"].map((name) => pool.screen(name))
      a!.take()
      a!.idle()
      b!.take()
      settle()
      expect(live("b")).toBe(true)
      expect(pool.stats()).toMatchObject({ waits: 1, steals: 1, swaps: 3, onDom: 0 })
    })

    it("count contexts lost and loads that failed", () => {
      const { pool, drawing, state } = setup({ cap: 2 })
      pool.screen("a").take()
      drawing("a").lose()
      state.failing = true
      pool.screen("b").take()
      expect(pool.stats()).toMatchObject({ lost: 1, failed: 1 })
    })

    it("count the resizes the views report", () => {
      const { pool } = setup()
      const a = pool.screen("a")
      a.resized()
      a.resized()
      expect(pool.stats().resizes).toBe(2)
    })

    it("don't count a screen closing as a swap", () => {
      const { pool } = setup()
      const a = pool.screen("a")
      a.take()
      a.dispose()
      expect(pool.stats().swaps).toBe(1)
    })

    it("tell a watcher each time one changes, until it stops", () => {
      const { pool } = setup()
      const heard = vi.fn<() => void>()
      const stop = pool.watch(heard)
      const a = pool.screen("a")
      a.take()
      expect(heard).toHaveBeenCalledTimes(1)
      stop()
      a.release()
      expect(heard).toHaveBeenCalledTimes(1)
    })
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
