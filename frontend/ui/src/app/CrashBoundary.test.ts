import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { CrashBoundary } from "./CrashBoundary"

let rendered: Rendered | undefined
// What reached the page's error event, as the desktop app's log hears of it.
let reported: unknown[] = []
const report = (event: ErrorEvent): void => void reported.push(event.error)
beforeEach(() => {
  reported = []
  window.addEventListener("error", report)
})
afterEach(() => {
  window.removeEventListener("error", report)
  rendered?.unmount()
  rendered = undefined
})

const Broken = (): never => {
  throw new Error("A view that can't draw")
}

describe("CrashBoundary", () => {
  context("while the app draws", () => {
    it("shows the app", () => {
      rendered = render(createElement(CrashBoundary, null, createElement("main", null, "Deck")))
      expect(rendered.container.textContent).toBe("Deck")
      expect(rendered.container.querySelector("[role=alert]")).toBeNull()
    })
  })

  context("once a render throws", () => {
    it("says so in place of a blank window, and reloads on a press", () => {
      // React reports what a boundary catches; the test needn't print it.
      vi.spyOn(console, "error").mockImplementation(() => {})
      const reload = vi.fn<() => void>()
      rendered = render(createElement(CrashBoundary, { reload }, createElement(Broken)))
      const alert = rendered.container.querySelector("[role=alert]")
      expect(alert?.textContent).toContain("Novadeck ran into an error")
      expect(rendered.container.querySelector(".boot-splash")?.getAttribute("data-state")).toBe(
        "failed",
      )
      const button = Array.from(alert!.querySelectorAll("button")).find(
        (each) => each.textContent === "Reload",
      )!
      act(() => button.click())
      expect(reload).toHaveBeenCalledOnce()
    })

    it("passes the error on to the page's error event, where the desktop app logs it", () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      rendered = render(createElement(CrashBoundary, null, createElement(Broken)))
      expect(reported).toEqual([expect.objectContaining({ message: "A view that can't draw" })])
    })
  })
})
