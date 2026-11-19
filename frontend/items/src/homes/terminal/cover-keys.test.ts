import { describe, expect, it } from "vitest"

import { coverKey } from "./cover-keys"

// A pane over its terminal, with `inner` drawn in it, and what its keys did.
const pane = (inner: string) => {
  document.body.innerHTML = `<div id="terminal"></div><div id="pane">${inner}</div>`
  const calls = { uncovered: 0, typed: [] as string[] }
  const context = {
    covering: () => true,
    terminal: document.getElementById("terminal")!,
    pane: document.getElementById("pane")!,
    uncover: () => void (calls.uncovered += 1),
    type: (event: KeyboardEvent) => void calls.typed.push(event.key),
  }
  const press = (selector: string, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    document.querySelector(selector)!.dispatchEvent(event)
    coverKey(event, context)
    return event
  }
  return { calls, press }
}

describe("the keys of a pane over its terminal", () => {
  it("takes a letter typed on its surface as a reply: it uncovers and types", () => {
    const { calls, press } = pane('<table><tr id="row" tabindex="0"><td>a</td></tr></table>')
    expect(press("#row", "a").defaultPrevented).toBe(true)
    expect(calls).toEqual({ uncovered: 1, typed: ["a"] })
  })

  it("leaves every key to a region that marks itself `data-pane-keys`", () => {
    const { calls, press } = pane('<div data-pane-keys="" tabindex="-1" id="own">x</div>')
    for (const key of ["a", " ", "Escape", "j"]) press("#own", key)
    expect(calls).toEqual({ uncovered: 0, typed: [] })
  })

  it('leaves only Space to a region marked `data-pane-keys="space"`', () => {
    const { calls, press } = pane(
      '<div data-pane-keys="space"><div id="row" tabindex="0"></div></div>',
    )
    expect(press("#row", " ").defaultPrevented).toBe(false)
    expect(calls).toEqual({ uncovered: 0, typed: [] })
    press("#row", "a")
    expect(calls).toEqual({ uncovered: 1, typed: ["a"] })
    press("#row", "Escape")
    expect(calls.uncovered).toBe(2)
  })

  it("still takes Space typed on a surface that has no such region", () => {
    const { calls, press } = pane('<div id="plain" tabindex="-1"></div>')
    press("#plain", " ")
    expect(calls).toEqual({ uncovered: 1, typed: [" "] })
  })
})
