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
