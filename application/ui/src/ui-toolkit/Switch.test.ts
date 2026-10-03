import { act, createElement } from "react"

import { describe, expect, it } from "../test"
import { render } from "../test/render"
import { Switch } from "./Switch"

describe("a switch with a change on its way", () => {
  it("takes no clicks, keeps focus, and says it's busy", () => {
    const changes: boolean[] = []
    const props = {
      checked: false,
      onChange: (next: boolean) => changes.push(next),
      labelledBy: "x",
    }
    const view = render(createElement(Switch, { ...props, pending: true }))
    const button = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!
    button.focus()
    act(() => button.click())
    expect(changes).toEqual([])
    expect(button.getAttribute("aria-disabled")).toBe("true")
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(document.activeElement).toBe(button)
    view.rerender(createElement(Switch, props))
    act(() => button.click())
    expect(changes).toEqual([true])
    expect(button.hasAttribute("aria-disabled")).toBe(false)
    view.unmount()
  })
})

describe("a switch", () => {
  it("says whether it is on in data-state as well as aria-checked", () => {
    const props = { checked: false, onChange: () => {}, labelledBy: "x" }
    const view = render(createElement(Switch, props))
    const button = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(button.dataset.state).toBe("unchecked")
    view.rerender(createElement(Switch, { ...props, checked: true }))
    expect(button.dataset.state).toBe("checked")
    expect(button.getAttribute("aria-checked")).toBe("true")
    view.unmount()
  })
})
