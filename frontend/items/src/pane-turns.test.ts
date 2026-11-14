import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import {
  createPaneTurns,
  heldAttribute,
  PaneTurnsContext,
  usePaneTurn,
  type Pace,
  type PaneTurn,
  type PaneTurns,
} from "./pane-turns"
import { context, describe, expect, it } from "./test"

// A pace whose turns come when the test steps, one at a time.
const stepped = () => {
  const queue: (() => void)[] = []
  const pace: Pace = (next) => {
    queue.push(next)
    return () => {
      const at = queue.indexOf(next)
      if (at >= 0) queue.splice(at, 1)
    }
  }
  return {
    pace,
    step: () => act(() => queue.shift()?.()),
    pending: () => queue.length,
  }
}

afterEach(() => document.documentElement.removeAttribute(heldAttribute))

describe("pane turns", () => {
  it("gives one turn a frame, in the order they were asked", () => {
    const { pace, step } = stepped()
    const turns = createPaneTurns(pace)
    const granted: string[] = []
    for (const name of ["a", "b", "c"]) turns.want(false, () => granted.push(name))
    expect(granted).toEqual([])
    step()
    expect(granted).toEqual(["a"])
    step()
    step()
    expect(granted).toEqual(["a", "b", "c"])
  })

  it("gives the selected terminal's pane its turn ahead of the others", () => {
    const { pace, step } = stepped()
    const turns = createPaneTurns(pace)
    const granted: string[] = []
    turns.want(false, () => granted.push("other"))
    turns.want(true, () => granted.push("selected"))
    step()
    expect(granted).toEqual(["selected"])
  })

  it("never gives a cancelled turn, and stops waiting for frames once none is asked", () => {
    const { pace, step, pending } = stepped()
    const turns = createPaneTurns(pace)
    const granted: string[] = []
    const cancel = turns.want(false, () => granted.push("gone"))
    turns.want(false, () => granted.push("kept"))
    cancel()
    step()
    expect(granted).toEqual(["kept"])
    expect(pending()).toBe(0)
    turns.want(false, () => granted.push("alone"))()
    expect(pending()).toBe(0)
  })

  it("holds every turn while the debug panel holds them", () => {
    const { pace, step } = stepped()
    const turns = createPaneTurns(pace)
    const granted: string[] = []
    document.documentElement.setAttribute(heldAttribute, "")
    turns.want(false, () => granted.push("a"))
    step()
    step()
    expect(granted).toEqual([])
    document.documentElement.removeAttribute(heldAttribute)
    step()
    expect(granted).toEqual(["a"])
  })
})

describe("a pane's turn", () => {
  // A pane that writes its turn out, in sight or not, under `turns` when given.
  const pane = (turns?: PaneTurns, first = false) => {
    let seen: PaneTurn | undefined
    const Probe = (): null => {
      seen = usePaneTurn(first)
      return null
    }
    const tree = (shown: boolean) => {
      const inner = createElement(Shown, { value: shown }, createElement(Probe))
      return turns ? createElement(PaneTurnsContext, { value: turns }, inner) : inner
    }
    return { tree, turn: () => seen }
  }

  context("outside the workspace", () => {
    it("is built and laid out at once", () => {
      const { tree, turn } = pane()
      render(tree(true))
      expect(turn()).toEqual({ built: true, ready: true })
    })
  })

  context("in the workspace", () => {
    it("waits for its turn before it's built", () => {
      const { pace, step } = stepped()
      const { tree, turn } = pane(createPaneTurns(pace))
      render(tree(true))
      expect(turn()).toEqual({ built: false, ready: false })
      step()
      expect(turn()).toEqual({ built: true, ready: true })
    })

    it("asks no turn while it's out of sight", () => {
      const { pace, pending } = stepped()
      const { tree, turn } = pane(createPaneTurns(pace))
      render(tree(false))
      expect(pending()).toBe(0)
      expect(turn()).toEqual({ built: false, ready: false })
    })

    it("keeps what it built out of sight, and is laid out again in a new turn", () => {
      const { pace, step, pending } = stepped()
      const { tree, turn } = pane(createPaneTurns(pace))
      const rendered = render(tree(true))
      step()
      rendered.rerender(tree(false))
      expect(turn()).toEqual({ built: true, ready: false })
      expect(pending()).toBe(0)
      rendered.rerender(tree(true))
      expect(turn()).toEqual({ built: true, ready: false })
      step()
      expect(turn()).toEqual({ built: true, ready: true })
    })

    it("lets go of its turn when it goes before the turn comes", () => {
      const { pace, pending } = stepped()
      const { tree } = pane(createPaneTurns(pace))
      const rendered = render(tree(true))
      expect(pending()).toBe(1)
      rendered.unmount()
      expect(pending()).toBe(0)
    })
  })
})
