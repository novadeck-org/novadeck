import type { Companions, ItemContent, PageContent } from "@novadeck/core/companion"
import { pagesPartition } from "@novadeck/core/pages"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"
import { afterEach } from "vitest"

import { createPanes } from "../../state"
import { context, describe, expect, it } from "../../test"
import { page as registration } from "./index"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const url = "http://localhost:5173/"
const target = { projectId: "project", workspaceSessionId: "initial" }
const item = itemFixture("preview", "01", { kind: "page", name: "localhost:5173", path: null, url })

// The page's body in the pane, as the page registration draws it, loading what `content`
// holds; `show` reports new content for the same item, as the backend does.
const show = (content: PageContent, shown = true) => {
  let stamp = 0
  const ready = (next: PageContent): ItemContent => ({
    state: "ready",
    stamp: String(++stamp),
    content: next,
  })
  let emit: (content: ItemContent) => void = () => {}
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      emit = on
      on(ready(content))
      return () => {}
    },
    save: () => new Promise(() => {}),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const panes = createPanes({ companions, workspace })
  unmounts.push(panes.connect())
  const rendered = render(
    createElement(
      Shown.Provider,
      { value: shown },
      createElement(registration.View, {
        member: { kind: "item", key: item.id, item, placed: false, fresh: false },
        panes,
        target,
        actions: undefined,
      }),
    ),
  )
  unmounts.push(rendered.unmount)
  return { ...rendered, show: (next: PageContent) => act(() => emit(ready(next))) }
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
      const { container } = show({ kind: "page", url, shown: 1, live: true })
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
      const { container } = show({ kind: "page", url, shown: 1, live: true })
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
      const { container } = show({ kind: "page", url, shown: 1, live: true }, false)
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
      const rendered = show({ kind: "page", url, shown: 1, live: true })
      Object.assign(pageOf(rendered.container), {
        getURL: () => `${url}work`,
        canGoBack: () => true,
        canGoForward: () => false,
        setAudioMuted: () => undefined,
      })
      fire(pageOf(rendered.container), "did-navigate")
      rendered.show({ kind: "page", url: "https://example.com/", shown: 1, live: true })
      expect(rendered.container.querySelector(".artifact-url")?.textContent).toBe(
        "https://example.com/",
      )
      expect((button(rendered.container, "Back") as HTMLButtonElement).disabled).toBe(true)
    })
    it("loads afresh when shown again, then brings that show's element into view", () => {
      // An address of its own, where no earlier viewer of this item was kept.
      const at = "http://localhost:4321/"
      const rendered = show({ kind: "page", url: at, shown: 1, live: true })
      const page = pageOf(rendered.container)
      const calls: string[] = []
      Object.assign(page, {
        getURL: () => at,
        canGoBack: () => false,
        canGoForward: () => false,
        setAudioMuted: () => undefined,
        reloadIgnoringCache: () => calls.push("reload"),
        executeJavaScript: (code: string) => {
          calls.push(code.includes(JSON.stringify("#faq")) ? "scroll #faq" : "scroll")
          return Promise.resolve(true)
        },
      })
      fire(page, "did-stop-loading")
      rendered.show({ kind: "page", url: at, shown: 2, scroll: "#faq", live: true })
      expect(calls).toEqual(["reload"])
      const frame = rendered.container.querySelector(".artifact-browser")!
      expect(frame.getAttribute("aria-busy")).toBe("true")
      fire(page, "did-stop-loading")
      expect(calls).toEqual(["reload", "scroll #faq"])
      // The same show read again, as after a reconnect, gives the viewer nothing new.
      rendered.show({ kind: "page", url: at, shown: 2, scroll: "#faq", live: true })
      fire(page, "did-stop-loading")
      expect(calls).toEqual(["reload", "scroll #faq"])
    })
  })

  context("where pages can't load live", () => {
    it("shows its snapshot under its address, with nothing to go back or forward to", () => {
      const { container } = show({
        kind: "page",
        url,
        shown: 1,
        live: false,
        snapshot: "data:image/png;base64,",
      })
      expect(container.querySelector("webview")).toBeNull()
      expect(container.querySelector("img")?.getAttribute("alt")).toBe(`${url} as shown`)
      expect(button(container, "Back")).toBeUndefined()
      expect(container.querySelector(".artifact-browser")?.getAttribute("aria-busy")).toBe("false")
    })

    it("says it opens in the browser, without a snapshot", () => {
      const { container } = show({ kind: "page", url, shown: 1, live: false })
      expect(container.textContent).toContain("This page opens in your browser.")
      expect(container.querySelector(".artifact-url")?.textContent).toBe(url)
    })
  })
})
