import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { HistoryDot, historyDotMs, HistoryDropNotice, recentDropMs } from "./HistoryDot"

const unmounts: (() => void)[] = []
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount())
  vi.useRealTimers()
})

const mount = (element: React.ReactElement) => {
  const view = render(element)
  unmounts.push(view.unmount)
  return view
}

describe("History's dot", () => {
  it("stays away for the landings before it mounted", () => {
    const { container } = mount(createElement(HistoryDot, { drops: 3 }))
    expect(container.querySelector(".history-dot")).toBeNull()
  })

  it("shows with its ring for a landing, and leaves once its flare has played", () => {
    vi.useFakeTimers()
    const { container, rerender } = mount(createElement(HistoryDot, { drops: 0 }))
    const dot = () => container.querySelector(".history-dot")
    rerender(createElement(HistoryDot, { drops: 1 }))
    expect(dot()).not.toBeNull()
    expect(dot()?.querySelector(".bell-dot-ring")).not.toBeNull()
    act(() => vi.advanceTimersByTime(historyDotMs - 1))
    expect(dot()).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(dot()).toBeNull()
  })

  it("flares afresh for a landing while one plays", () => {
    vi.useFakeTimers()
    const { container, rerender } = mount(createElement(HistoryDot, { drops: 0 }))
    const dot = () => container.querySelector(".history-dot")
    rerender(createElement(HistoryDot, { drops: 1 }))
    const first = dot()
    act(() => vi.advanceTimersByTime(historyDotMs - 100))
    rerender(createElement(HistoryDot, { drops: 2 }))
    expect(dot()).not.toBe(first)
    act(() => vi.advanceTimersByTime(historyDotMs - 1))
    expect(dot()).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(dot()).toBeNull()
  })
})

describe("History's live region", () => {
  it("says where a closed terminal went, for a while", () => {
    vi.useFakeTimers()
    const { container, rerender } = mount(
      createElement(HistoryDropNotice, { drops: 0, last: undefined }),
    )
    const said = () => container.querySelector('[role="status"]')?.textContent
    expect(said()).toBe("")
    rerender(createElement(HistoryDropNotice, { drops: 1, last: "Tests" }))
    expect(said()).toBe("Tests closed. It’s in History.")
    act(() => vi.advanceTimersByTime(recentDropMs))
    expect(said()).toBe("")
  })
})
