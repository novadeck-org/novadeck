import { render } from "@novadeck/test-kit/render"
import { act, Component, createElement, type ComponentType, type ReactNode } from "react"
import { afterEach, beforeEach } from "vitest"

import { failViewLoads, lazyView } from "./lazy-view"
import { context, describe, expect, it } from "./test"

// What reached the page's `error` event, kept from jsdom's console.
let reported: unknown[] = []
const keep = (event: ErrorEvent): void => {
  event.preventDefault()
  reported.push(event.error)
}
beforeEach(() => {
  reported = []
  window.addEventListener("error", keep)
})
afterEach(() => window.removeEventListener("error", keep))

// Lets a load settle and React show what it gave.
const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

const Shown = ({ text }: { readonly text: string }): ReactNode =>
  createElement("p", { className: "shown" }, text)

// A load that fails the first `failures` times, as a chunk that couldn't be fetched, then
// gives `view`; it counts its calls.
const flaky = <P extends object>(view: ComponentType<P>, failures: number) => {
  let calls = 0
  const load = (): Promise<ComponentType<P>> => {
    calls++
    return calls <= failures
      ? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
      : Promise.resolve(view)
  }
  return { load, calls: () => calls }
}

// Stands in for the app's crash screen, to see what reaches it.
class Crash extends Component<{ readonly children: ReactNode }, { readonly crashed: boolean }> {
  override state = { crashed: false }
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true }
  }
  override render(): ReactNode {
    return this.state.crashed ? createElement("p", { className: "crashed" }) : this.props.children
  }
}

const inApp = (...views: ReactNode[]): ReturnType<typeof render> =>
  render(
    createElement(Crash, null, createElement("nav", { className: "rest" }, "Sidebar"), ...views),
  )

const retryButton = (root: ParentNode): HTMLButtonElement =>
  [...root.querySelectorAll("button")].find((button) => button.textContent === "Retry")!

describe("a lazy view", () => {
  context("whose code loads", () => {
    it("renders as it would plainly lazy, with nothing said and nothing reported", async () => {
      const View = lazyView(flaky(Shown, 0).load, createElement("div", { className: "wait" }))
      const { container } = inApp(createElement(View, { text: "tree" }))
      await settle()
      expect(container.querySelector(".shown")?.textContent).toBe("tree")
      expect(container.querySelector("[role=alert]")).toBeNull()
      expect(reported).toEqual([])
    })

    it("shows its fallback till it's in", () => {
      const View = lazyView(
        () => new Promise<ComponentType<object>>(() => {}),
        createElement("div", { className: "wait" }),
      )
      const { container } = inApp(createElement(View))
      expect(container.querySelector(".wait")).not.toBeNull()
    })

    it("leaves what it throws once loaded to the app's crash screen, as before", async () => {
      const Broken = (): ReactNode => {
        throw new Error("a bug in the view")
      }
      const View = lazyView(flaky(Broken, 0).load, null)
      const { container } = inApp(createElement(View))
      await settle()
      expect(container.querySelector(".crashed")).not.toBeNull()
      expect(container.querySelector("[role=alert]")).toBeNull()
    })
  })

  context("whose code fails to load", () => {
    it("says so in its own place, with a Retry, and the app stays up", async () => {
      const View = lazyView(flaky(Shown, 1).load, null)
      const { container } = inApp(
        createElement("section", { className: "pane" }, createElement(View, { text: "tree" })),
      )
      await settle()
      const pane = container.querySelector(".pane")!
      expect(pane.querySelector("[role=alert] p")?.textContent).toBe("Couldn't load this view.")
      expect(retryButton(pane)).toBeDefined()
      expect(container.querySelector(".crashed")).toBeNull()
      expect(container.querySelector(".rest")?.textContent).toBe("Sidebar")
    })

    it("reports the failure to the page, where the desktop app logs it", async () => {
      const View = lazyView(flaky(Shown, 1).load, null)
      inApp(createElement(View, { text: "tree" }))
      await settle()
      expect(reported).toEqual([new TypeError("Failed to fetch dynamically imported module")])
    })

    it("loads it again on Retry, and shows it once it's in", async () => {
      const source = flaky(Shown, 1)
      const View = lazyView(source.load, null)
      const { container } = inApp(createElement(View, { text: "tree" }))
      await settle()
      act(() => retryButton(container).click())
      await settle()
      expect(source.calls()).toBe(2)
      expect(container.querySelector(".shown")?.textContent).toBe("tree")
      expect(container.querySelector("[role=alert]")).toBeNull()
    })

    it("says so again when Retry fails too", async () => {
      const source = flaky(Shown, 2)
      const View = lazyView(source.load, null)
      const { container } = inApp(createElement(View, { text: "tree" }))
      await settle()
      act(() => retryButton(container).click())
      await settle()
      expect(source.calls()).toBe(2)
      expect(retryButton(container)).toBeDefined()
    })

    it("loads it once for every pane that shows it, from either one's Retry", async () => {
      const source = flaky(Shown, 1)
      const View = lazyView(source.load, null)
      const { container } = inApp(
        createElement(View, { key: "a", text: "one" }),
        createElement(View, { key: "b", text: "two" }),
      )
      await settle()
      expect(container.querySelectorAll("[role=alert]")).toHaveLength(2)
      const [first, second] = [...container.querySelectorAll("button")]
      act(() => {
        first!.click()
        second!.click()
      })
      await settle()
      expect(source.calls()).toBe(2)
      expect([...container.querySelectorAll(".shown")].map((p) => p.textContent)).toEqual([
        "one",
        "two",
      ])
    })

    it("keeps its fallback where it's quiet, as a peek's still", async () => {
      const View = lazyView(
        flaky(Shown, 1).load,
        createElement("span", { className: "badge" }),
        "quiet",
      )
      const { container } = inApp(createElement(View, { text: "tree" }))
      await settle()
      expect(container.querySelector(".badge")).not.toBeNull()
      expect(container.querySelector("[role=alert]")).toBeNull()
      expect(container.querySelector(".crashed")).toBeNull()
    })
  })

  context("that the demo fails", () => {
    it("says it couldn't load, even once loaded, and Retry brings it back", async () => {
      const source = flaky(Shown, 0)
      const View = lazyView(source.load, null)
      const { container } = inApp(createElement(View, { text: "tree" }))
      await settle()
      act(failViewLoads)
      await settle()
      expect(container.querySelector("[role=alert] p")?.textContent).toBe(
        "Couldn't load this view.",
      )
      act(() => retryButton(container).click())
      await settle()
      expect(container.querySelector(".shown")?.textContent).toBe("tree")
    })
  })
})
