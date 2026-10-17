import { act, createElement } from "react"
import { afterEach } from "vitest"

import type { ItemContent, PageContent } from "../../model/companion"
import { pagesPartition } from "../../model/pages"
import { context, describe, expect, it } from "../../test"
import { itemFixture } from "../../test/fixtures"
import { render } from "../../test/render"
import { Shown } from "../../ui-toolkit/shown"
import { ArtifactViewer } from "./ArtifactViewer"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const url = "http://localhost:5173/"
const item = itemFixture("preview", "01", { kind: "page", name: "localhost:5173", path: null, url })

const show = (content: PageContent, shown = true) => {
  const element = (next: PageContent) =>
    createElement(
      Shown.Provider,
      { value: shown },
      createElement(ArtifactViewer, {
        artifact: item,
        load: { state: "ready", stamp: "1", content: next } satisfies ItemContent,
      }),
    )
  const rendered = render(element(content))
  unmounts.push(rendered.unmount)
  return { ...rendered, show: (next: PageContent) => rendered.rerender(element(next)) }
}

const pageOf = (container: HTMLElement): HTMLElement => container.querySelector("webview")!
const fire = (page: HTMLElement, type: string, fields: Record<string, unknown> = {}): void =>
  act(() => {
    page.dispatchEvent(Object.assign(new Event(type), fields))
  })
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.textContent === name,
  )

describe("a page beside a terminal", () => {
  context("where pages load live", () => {
    it("loads in the pages' session, busy until it has loaded", () => {
      const { container } = show({ kind: "page", url, live: true })
      expect(pageOf(container).getAttribute("partition")).toBe(pagesPartition)
      expect(pageOf(container).hasAttribute("allowpopups")).toBe(true)
      const frame = container.querySelector(".artifact-browser")!
      expect(frame.getAttribute("aria-busy")).toBe("true")
      fire(pageOf(container), "did-stop-loading")
      expect(frame.getAttribute("aria-busy")).toBe("false")
      expect(button(container, "Back")).toBeDefined()
      expect(button(container, "Reload")).toBeDefined()
    })

    it("says when it didn't load, and loads it again when asked", () => {
      const { container } = show({ kind: "page", url, live: true })
      const page = pageOf(container)
      let reloads = 0
      Object.assign(page, { reload: () => (reloads += 1) })
      fire(page, "did-fail-load", { errorCode: -105, isMainFrame: true })
      expect(container.querySelector("[role=alert]")?.textContent).toContain(
        "This page didn't load.",
      )
      act(() => button(container, "Try again")!.click())
      expect(reloads).toBe(1)
    })

    it("goes quiet while it's kept out of sight", () => {
      const { container } = show({ kind: "page", url, live: true }, false)
      const page = pageOf(container)
      const muted: boolean[] = []
      Object.assign(page, {
        setAudioMuted: (each: boolean) => muted.push(each),
        getURL: () => url,
        canGoBack: () => false,
        canGoForward: () => false,
      })
      fire(page, "dom-ready")
      expect(muted).toEqual([true])
    })

    it("shows a new page at its own address, not the last one's", () => {
      const rendered = show({ kind: "page", url, live: true })
      Object.assign(pageOf(rendered.container), {
        getURL: () => `${url}work`,
        canGoBack: () => true,
        canGoForward: () => false,
        setAudioMuted: () => undefined,
      })
      fire(pageOf(rendered.container), "did-navigate")
      rendered.show({ kind: "page", url: "https://example.com/", live: true })
      expect(rendered.container.querySelector(".artifact-url")?.textContent).toBe(
        "https://example.com/",
      )
      expect((button(rendered.container, "Back") as HTMLButtonElement).disabled).toBe(true)
    })
  })

  context("where pages can't load live", () => {
    it("shows its snapshot under its address, with nothing to go back or forward to", () => {
      const { container } = show({
        kind: "page",
        url,
        live: false,
        snapshot: "data:image/png;base64,",
      })
      expect(container.querySelector("webview")).toBeNull()
      expect(container.querySelector("img")?.getAttribute("alt")).toBe(`${url} as shown`)
      expect(button(container, "Back")).toBeUndefined()
      expect(container.querySelector(".artifact-browser")?.getAttribute("aria-busy")).toBe("false")
    })

    it("says it opens in the browser, without a snapshot", () => {
      const { container } = show({ kind: "page", url, live: false })
      expect(container.textContent).toContain("This page opens in your browser.")
      expect(container.querySelector(".artifact-url")?.textContent).toBe(url)
    })
  })
})
