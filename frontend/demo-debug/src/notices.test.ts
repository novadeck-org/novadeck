import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { createDemoNotices, noticeMs } from "./notices"
import { describe, expect, it } from "./test"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const mount = () => {
  const { notices, Notices } = createDemoNotices()
  const view = render(createElement(Notices))
  const shown = (): string[] =>
    [...view.container.querySelectorAll("button")].map((button) => button.textContent ?? "")
  return { notices, view, shown }
}

describe("demo notices", () => {
  it("shows a notice in a labelled region", () => {
    const { notices, view, shown } = mount()
    act(() => notices.show({ id: "01", title: "@moth is done", body: "All green." }))
    expect(shown()).toEqual(["@moth is doneAll green."])
    expect(view.container.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Notifications",
    )
    view.unmount()
  })

  it("replaces an older notice for the same id", () => {
    const { notices, view, shown } = mount()
    act(() => notices.show({ id: "01", title: "First", body: "a" }))
    act(() => notices.show({ id: "02", title: "Other", body: "b" }))
    act(() => notices.show({ id: "01", title: "Second", body: "c" }))
    expect(shown()).toEqual(["Secondc", "Otherb"])
    view.unmount()
  })

  it("dismisses itself after a while, counted from its latest show", () => {
    const { notices, view, shown } = mount()
    act(() => notices.show({ id: "01", title: "First", body: "a" }))
    act(() => vi.advanceTimersByTime(noticeMs - 1000))
    act(() => notices.show({ id: "01", title: "Second", body: "b" }))
    act(() => vi.advanceTimersByTime(noticeMs - 1000))
    expect(shown()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1000))
    expect(shown()).toEqual([])
    view.unmount()
  })

  it("tells the listeners the id of a clicked notice, and dismisses it", () => {
    const { notices, view, shown } = mount()
    const heard: string[] = []
    const stop = notices.onClick((id) => heard.push(id))
    act(() => notices.show({ id: "07", title: "Done", body: "b" }))
    act(() => view.container.querySelector("button")?.click())
    expect(heard).toEqual(["07"])
    expect(shown()).toEqual([])
    stop()
    act(() => notices.show({ id: "08", title: "Done", body: "b" }))
    act(() => view.container.querySelector("button")?.click())
    expect(heard).toEqual(["07"])
    view.unmount()
  })
})
