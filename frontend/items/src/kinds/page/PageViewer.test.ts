import type { Items, ItemContent, PageContent, PageTrouble } from "@novadeck/core/items"
import { pagesPartition } from "@novadeck/core/pages"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { AwakeContext, type Awake } from "../../awake"
import { createItemStore } from "../../state"
import { context, describe, expect, it } from "../../test"
import { page as registration } from "./index"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const url = "http://localhost:5173/"
const target = { projectId: "project", workspaceSessionId: "initial" }
const item = itemFixture("preview", "01", { kind: "page", name: "localhost:5173", path: null, url })

// The page's body in the pane, as the page registration draws it, loading what `content`
// holds; `show` reports new content for the same item, as the backend does. With `awake`,
// the pane says whether it's awake, and `pictures` are what its host takes of the page.
const show = (
  content: PageContent,
  shown = true,
  { awake, pictures }: { awake?: Awake; pictures?: string[] } = {},
) => {
  let stamp = 0
  const told: { shown: number; troubles: readonly PageTrouble[] }[] = []
  const ready = (next: PageContent): ItemContent => ({
    state: "ready",
    stamp: String(++stamp),
    content: next,
  })
  let emit: (content: ItemContent) => void = () => {}
  const companions: Items = {
    follow: (_target, _id, _options, on) => {
      emit = on
      on(ready(content))
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: (_target, _id, version, troubles) => told.push({ shown: version, troubles }),
    ...(pictures && { picture: async () => pictures.shift() }),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const view = createElement(registration.View, {
    member: { kind: "item", key: item.id, item, placed: false, fresh: false },
    itemStore,
    target,
    actions: undefined,
  })
  let pane = awake
  let visible = shown
  const tree = () =>
    createElement(
      Shown.Provider,
      { value: visible },
      pane ? createElement(AwakeContext, { value: pane }, view) : view,
    )
  const rendered = render(tree())
  unmounts.push(rendered.unmount)
  return {
    ...rendered,
    told,
    show: (next: PageContent) => act(() => emit(ready(next))),
    awake: (next: Awake) => {
      pane = next
      rendered.rerender(tree())
    },
    visible: (next: boolean) => {
      visible = next
      rendered.rerender(tree())
    },
  }
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

  context("while the pane sleeps", () => {
    const shot = "data:image/jpeg;base64,c2hvdA=="
    // A view attached as Electron attaches it, at `at`, recording what's asked of it.
    const attached = (page: HTMLElement, at: string, calls: string[] = []) => {
      Object.assign(page, {
        getURL: () => at,
        canGoBack: () => false,
        canGoForward: () => false,
        setAudioMuted: () => undefined,
        getWebContentsId: () => 7,
        reloadIgnoringCache: () => calls.push("reload"),
        executeJavaScript: () => Promise.resolve([0, 0]),
      })
      return calls
    }
    const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

    it("wakes a page with no picture for a while, then rests as its picture", async () => {
      const at = "http://localhost:4400/"
      const wakes: string[] = []
      const asleep: Awake = { awake: false, sleeps: true, wake: () => wakes.push("wake") }
      const rendered = show({ kind: "page", url: at, shown: 1, live: true }, true, {
        awake: asleep,
        pictures: [shot],
      })
      // No picture to rest as: the pane is asked to wake it.
      expect(wakes).toEqual(["wake"])
      rendered.awake({ awake: true, sleeps: true, wake: () => wakes.push("wake") })
      attached(pageOf(rendered.container), at)
      fire(pageOf(rendered.container), "did-stop-loading")
      rendered.awake(asleep)
      await settled()
      expect(rendered.container.querySelector("webview")).toBeNull()
      expect(rendered.container.querySelector(".browser-picture img")?.getAttribute("src")).toBe(
        shot,
      )
      // Woken again by the pane, it's live under its picture.
      rendered.awake({ awake: true, sleeps: true, wake: () => {} })
      expect(pageOf(rendered.container).getAttribute("src")).toBe(at)
      expect(rendered.container.querySelector(".browser-picture")).not.toBeNull()
    })

    it("wakes to show what changed when its agent shows it again", async () => {
      const at = "http://localhost:4401/"
      const wakes: string[] = []
      const awake: Awake = { awake: true, sleeps: true, wake: () => wakes.push("wake") }
      const rendered = show({ kind: "page", url: at, shown: 1, live: true }, true, {
        awake,
        pictures: [shot],
      })
      attached(pageOf(rendered.container), at)
      fire(pageOf(rendered.container), "did-stop-loading")
      const asleep: Awake = { awake: false, sleeps: true, wake: () => wakes.push("wake") }
      rendered.awake(asleep)
      await settled()
      wakes.splice(0)
      rendered.show({ kind: "page", url: at, shown: 2, live: true })
      expect(wakes).toEqual(["wake"])
      // The same show read again wakes nothing.
      rendered.show({ kind: "page", url: at, shown: 2, live: true })
      expect(wakes).toEqual(["wake"])
    })

    it("stays its picture when its terminal shows again, waking only for the person", async () => {
      const at = "http://localhost:4403/"
      const wakes: string[] = []
      const rendered = show({ kind: "page", url: at, shown: 1, live: true }, true, {
        awake: { awake: true, sleeps: true, wake: () => wakes.push("wake") },
        pictures: [shot],
      })
      attached(pageOf(rendered.container), at)
      fire(pageOf(rendered.container), "did-stop-loading")
      rendered.awake({ awake: false, sleeps: true, wake: () => wakes.push("wake") })
      await settled()
      wakes.splice(0)
      rendered.visible(false)
      rendered.visible(true)
      expect(wakes).toEqual([])
      expect(rendered.container.querySelector("webview")).toBeNull()
    })

    it("isn't pictured outside a pane, where it never rests", async () => {
      const at = "http://localhost:4404/"
      const asked: string[] = []
      const rendered = show({ kind: "page", url: at, shown: 1, live: true }, true, {
        pictures: new Proxy([shot], {
          get: (list, key, receiver) => {
            if (key === "shift") asked.push("picture")
            return Reflect.get(list, key, receiver) as unknown
          },
        }),
      })
      attached(pageOf(rendered.container), at)
      fire(pageOf(rendered.container), "did-stop-loading")
      await act(() => new Promise((resolve) => setTimeout(resolve, 1_200)))
      expect(asked).toEqual([])
    })

    it("stays live where its host takes no pictures", async () => {
      const at = "http://localhost:4402/"
      const rendered = show({ kind: "page", url: at, shown: 1, live: true }, true, {
        awake: { awake: false, sleeps: true, wake: () => {} },
      })
      attached(pageOf(rendered.container), at)
      fire(pageOf(rendered.container), "did-stop-loading")
      await settled()
      expect(pageOf(rendered.container)).not.toBeNull()
    })
  })

  context("when a live page has troubles", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const logs = (page: HTMLElement, message: string): void =>
      fire(page, "console-message", { level: 3, message, line: 3, sourceId: `${url}app.js` })
    const attached = (page: HTMLElement): void => {
      Object.assign(page, {
        getURL: () => url,
        canGoBack: () => false,
        canGoForward: () => false,
        setAudioMuted: () => undefined,
      })
    }

    it("tells them together a moment later, with the show that loaded the page", () => {
      const { container, told } = show({ kind: "page", url, shown: 1, live: true })
      const page = pageOf(container)
      attached(page)
      logs(page, "one")
      logs(page, "two")
      expect(told).toEqual([])
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(told).toEqual([
        {
          shown: 1,
          troubles: [
            { kind: "error", text: "one", source: `${url}app.js`, line: 3 },
            { kind: "error", text: "two", source: `${url}app.js`, line: 3 },
          ],
        },
      ])
    })

    it("tells no more than a call takes", () => {
      const { container, told } = show({ kind: "page", url, shown: 1, live: true })
      attached(pageOf(container))
      // A viewer reports 20 for a document; a batch may hold some of the next's.
      for (let each = 0; each < 20; each += 1) logs(pageOf(container), `a${each}`)
      fire(pageOf(container), "did-navigate")
      for (let each = 0; each < 5; each += 1) logs(pageOf(container), `b${each}`)
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(told.map((each) => each.troubles.length)).toEqual([20, 5])
    })

    it("keeps each trouble with the show of the document it came from", () => {
      const rendered = show({ kind: "page", url, shown: 1, live: true })
      const page = pageOf(rendered.container)
      attached(page)
      fire(page, "did-navigate")
      fire(page, "did-stop-loading")
      logs(page, "a")
      // Shown again once loaded: the old document logs until the new one loads.
      rendered.show({ kind: "page", url, shown: 2, live: true })
      logs(page, "old")
      fire(page, "did-navigate")
      logs(page, "b")
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(rendered.told.map((each) => [each.shown, each.troubles.length])).toEqual([
        [1, 2],
        [2, 1],
      ])
    })

    it("tells what is waiting when the page goes", () => {
      const { container, told, unmount } = show({ kind: "page", url, shown: 1, live: true })
      attached(pageOf(container))
      logs(pageOf(container), "last")
      unmount()
      expect(told).toHaveLength(1)
    })
  })

  context("where pages can't load live", () => {
    it("tells nothing", () => {
      const { container, told } = show({
        kind: "page",
        url,
        shown: 1,
        live: false,
        snapshot: "data:,",
      })
      expect(container.querySelector("webview")).toBeNull()
      expect(told).toEqual([])
    })

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
