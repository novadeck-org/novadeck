import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"

import { describe, expect, it } from "./test"
import { createToasts, ToastRegion } from "./Toast"

const mount = () => {
  const toasts = createToasts<string>()
  const selected: string[] = []
  const props = {
    toasts,
    label: "Things",
    onSelect: (data: string) => void selected.push(data),
    onMore: () => {},
    children: (data: string) => createElement("span", { className: "body" }, data),
  }
  const view = render(createElement(ToastRegion<string>, props))
  const standing = (): string[] =>
    [...view.container.ownerDocument.querySelectorAll(".toast:not([data-state=closed]) .body")].map(
      (each) => each.textContent ?? "",
    )
  return { toasts, selected, view, standing }
}

describe("a toast stack", () => {
  it("shows the newest first, and a key's newer toast replaces its older", async () => {
    const { toasts, standing, view } = mount()
    await act(async () => {
      toasts.show("a", "first")
      toasts.show("b", "second")
    })
    expect(standing()).toEqual(["second", "first"])
    await act(async () => toasts.show("a", "first again"))
    expect(standing()).toEqual(["first again", "second"])
    view.unmount()
  })

  it("ignores a click as a toast lands, and answers one after", async () => {
    const { toasts, selected, standing, view } = mount()
    await act(async () => toasts.show("a", "ring"))
    const body = view.container.ownerDocument.querySelector<HTMLElement>(".body")!
    await act(async () => body.click())
    expect(selected).toEqual([])
    expect(standing()).toEqual(["ring"])
    view.unmount()
  })
})
