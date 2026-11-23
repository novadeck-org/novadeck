import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { permitsOf, takeBackCall } from "./permits"

describe("the shipping gate's standing permits", () => {
  it("reads none from a detail a runner from before them sent", () => {
    expect(permitsOf({ permits: undefined } as never)).toEqual([])
  })

  describe("the runner's call to take one back", () => {
    const takeBack = vi.fn<() => Promise<{ ended: boolean }>>(async () => ({ ended: true }))

    it("is there only where the runner has the procedure", async () => {
      const has = { supports: (path: string) => path === "agents.takeBack", agents: { takeBack } }
      const lacks = { supports: () => false, agents: { takeBack } }

      await takeBackCall(has)?.("t", "p1")
      expect(takeBack).toHaveBeenCalledWith("t", "p1")
      expect(takeBackCall(lacks)).toBeUndefined()
    })

    it("is none for a client that can't say what the runner has, or lists no such call", () => {
      expect(takeBackCall({ agents: { takeBack } })).toBeUndefined()
      expect(takeBackCall({ supports: () => true, agents: {} })).toBeUndefined()
    })
  })
})
