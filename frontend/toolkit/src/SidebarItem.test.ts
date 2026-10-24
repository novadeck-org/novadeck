import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import { SidebarItem } from "./SidebarItem"
import { describe, expect, it } from "./test"

const item = (peek: string | null | undefined) =>
  createElement(SidebarItem, {
    name: "Build",
    icon: null,
    detail: "claude",
    selected: false,
    selectLabel: "Select Build",
    onSelect: () => {},
    ...(peek === undefined ? {} : { peek }),
  })

describe("a sidebar item whose card comes and goes", () => {
  it("keeps the same row, and keyboard focus on it", () => {
    const view = render(item(null))
    const row = view.container.querySelector<HTMLButtonElement>(".sidebar-item-select")!
    row.focus()
    view.rerender(item("Waiting · 4m"))
    expect(view.container.querySelector(".sidebar-item-select")).toBe(row)
    expect(document.activeElement).toBe(row)
    view.rerender(item(null))
    expect(view.container.querySelector(".sidebar-item-select")).toBe(row)
    expect(document.activeElement).toBe(row)
    view.unmount()
  })
})
