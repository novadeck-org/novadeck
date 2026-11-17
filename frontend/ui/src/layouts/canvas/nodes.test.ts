import { describe, expect, it } from "vitest"

import { keepUnchanged } from "./nodes"
import type { TerminalNode } from "./types"

const node = (id: string, change: Partial<TerminalNode> = {}): TerminalNode => ({
  id,
  type: "terminal",
  position: { x: 0, y: 0 },
  selected: false,
  data: { hiding: false, preview: false, team: undefined, focusRequest: null },
  ...change,
})

describe("placing Canvas's nodes again", () => {
  it("keeps the very nodes when none changed", () => {
    const previous = [node("a"), node("b")]
    expect(keepUnchanged(previous, [node("a"), node("b")])).toBe(previous)
  })

  it("keeps the nodes XYFlow measured, whose size the canvas never sets", () => {
    const measured = { ...node("a"), measured: { width: 550, height: 400 } }
    expect(keepUnchanged([measured], [node("a")])[0]).toBe(measured)
  })

  it("hands over only the node that changed", () => {
    const previous = [node("a"), node("b")]
    const moved = node("b", { position: { x: 24, y: 0 } })
    const next = keepUnchanged(previous, [node("a"), moved])
    expect(next[0]).toBe(previous[0])
    expect(next[1]).toBe(moved)
  })

  it("hands over a node whose data changed", () => {
    const previous = [node("a")]
    const lead = node("a", { data: { ...node("a").data, team: "lead" } })
    expect(keepUnchanged(previous, [lead])[0]).toBe(lead)
  })

  it("hands over a node that no longer has a field the canvas set before", () => {
    const styled = node("a", { style: { opacity: 0.5 } })
    const plain = node("a")
    expect(keepUnchanged([styled], [plain])[0]).toBe(plain)
  })

  it("keeps a node whose class was cleared, which is no class", () => {
    const cleared = node("a", { className: "" })
    expect(keepUnchanged([cleared], [node("a")])[0]).toBe(cleared)
  })

  it("follows the new order, and drops what is gone", () => {
    const previous = [node("a"), node("b"), node("c")]
    const next = keepUnchanged(previous, [node("c"), node("a")])
    expect(next).toEqual([previous[2], previous[0]])
    expect(next[0]).toBe(previous[2])
  })
})
