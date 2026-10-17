import "./browser.css"
import { afterEach, describe as context, describe, expect, it } from "vitest"

import { mountBrowser, type BrowserOptions, type Load, type Place } from "./browser.js"

const hosts: HTMLElement[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove()
})

const hostIn = (): HTMLElement => {
  const host = document.createElement("div")
  host.style.cssText = "display: flex; flex-direction: column; height: 300px; width: 400px"
  document.body.append(host)
  hosts.push(host)
  return host
}

const pageOf = (host: HTMLElement): HTMLElement => host.querySelector("webview")!

// A <webview> as Electron makes it once attached: its methods work, here at a place.
const attach = (page: HTMLElement, at: Place, calls: string[] = []): void => {
  Object.assign(page, {
    getURL: () => at.url,
    canGoBack: () => at.back,
    canGoForward: () => at.forward,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
    reload: () => calls.push("reload"),
    setAudioMuted: (muted: boolean) => calls.push(`muted ${muted}`),
  })
}

const event = (type: string, fields: Record<string, unknown> = {}): Event =>
  Object.assign(new Event(type), fields)

const live = (host: HTMLElement, on: BrowserOptions["on"] = {}, url = "http://localhost:5173/") =>
  mountBrowser(host, {
    content: { url },
    label: url,
    live: true,
    partition: "pages",
    on,
  })

describe("the browser viewer", () => {
  context("with live pages", () => {
    it("makes its page with the pages' session and allowpopups, before it attaches", () => {
      const host = hostIn()
      live(host)
      const page = pageOf(host)
      expect(page.getAttribute("partition")).toBe("pages")
      // Electron reads it only as an attribute, as the view attaches.
      expect(page.getAttribute("allowpopups")).toBe("")
      expect(page.getAttribute("src")).toBe("http://localhost:5173/")
    })

    it("reports where the page goes, once it's attached", () => {
      const host = hostIn()
      const places: Place[] = []
      live(host, { navigate: (place) => places.push(place) })
      const page = pageOf(host)
      // Not attached yet: nothing to read.
      page.dispatchEvent(event("did-navigate"))
      expect(places).toEqual([])
      attach(page, { url: "http://localhost:5173/about", back: true, forward: false })
      page.dispatchEvent(event("did-navigate"))
      expect(places).toEqual([{ url: "http://localhost:5173/about", back: true, forward: false }])
    })

    it("reports its load as it starts, ends and fails, a replaced load not failing", () => {
      const host = hostIn()
      const loads: Load[] = []
      live(host, { load: (load) => loads.push(load) })
      const page = pageOf(host)
      attach(page, { url: "http://localhost:5173/", back: false, forward: false })
      expect(host.querySelector(".browser-viewer")!.getAttribute("data-load")).toBe("loading")
      page.dispatchEvent(event("did-stop-loading"))
      page.dispatchEvent(event("did-start-loading"))
      page.dispatchEvent(event("did-fail-load", { errorCode: -3, isMainFrame: true }))
      page.dispatchEvent(event("did-fail-load", { errorCode: -105, isMainFrame: false }))
      expect(loads).toEqual(["loading", "ready", "loading"])
      page.dispatchEvent(event("did-fail-load", { errorCode: -105, isMainFrame: true }))
      page.dispatchEvent(event("did-stop-loading"))
      expect(loads).toEqual(["loading", "ready", "loading", "failed"])
      expect(host.querySelector(".browser-viewer")!.getAttribute("data-load")).toBe("failed")
      page.dispatchEvent(event("did-start-loading"))
      page.dispatchEvent(event("render-process-gone"))
      expect(loads.at(-1)).toBe("failed")
    })

    it("goes back, forward and reloads when asked, and stays quiet when told", () => {
      const host = hostIn()
      const calls: string[] = []
      const viewer = live(host)
      // Before it's attached, asking does nothing, and muting waits for it.
      viewer.muted(true)
      viewer.back()
      attach(pageOf(host), { url: "http://localhost:5173/", back: true, forward: true }, calls)
      pageOf(host).dispatchEvent(event("dom-ready"))
      viewer.back()
      viewer.forward()
      viewer.reload()
      viewer.muted(false)
      expect(calls).toEqual(["muted true", "back", "forward", "reload", "muted false"])
    })

    it("tells the page's title", () => {
      const host = hostIn()
      const titles: string[] = []
      live(host, { title: (title) => titles.push(title) })
      pageOf(host).dispatchEvent(event("page-title-updated", { title: "Studio" }))
      expect(titles).toEqual(["Studio"])
    })

    it("opens where the person had taken the page, from its state", () => {
      const first = hostIn()
      const viewer = live(first)
      attach(pageOf(first), { url: "http://localhost:5173/work", back: true, forward: false })
      pageOf(first).dispatchEvent(event("did-navigate"))
      const state = viewer.state()
      viewer.destroy()
      expect(first.children).toHaveLength(0)

      const again = hostIn()
      mountBrowser(again, {
        content: { url: "http://localhost:5173/" },
        label: "page",
        saved: state,
        live: true,
        partition: "pages",
      })
      expect(pageOf(again).getAttribute("src")).toBe("http://localhost:5173/work")

      const other = hostIn()
      mountBrowser(other, {
        content: { url: "https://example.com/" },
        label: "page",
        saved: state,
        live: true,
        partition: "pages",
      })
      expect(pageOf(other).getAttribute("src")).toBe("https://example.com/")
    })

    it("goes to a new address it's given, and keeps it as where it is until it's there", () => {
      const host = hostIn()
      const places: Place[] = []
      const viewer = live(host, { navigate: (place) => places.push(place) })
      viewer.update({ url: "https://example.com/" })
      expect(pageOf(host).getAttribute("src")).toBe("https://example.com/")
      expect(places.at(-1)?.url).toBe("https://example.com/")
      const again = hostIn()
      mountBrowser(again, {
        content: { url: "https://example.com/" },
        label: "page",
        saved: viewer.state(),
        live: true,
        partition: "pages",
      })
      expect(pageOf(again).getAttribute("src")).toBe("https://example.com/")
    })

    it("goes to no address but an http(s) one once its page has attached", () => {
      const host = hostIn()
      const viewer = live(host)
      for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"])
        viewer.update({ url })
      expect(pageOf(host).getAttribute("src")).toBe("http://localhost:5173/")
    })

    it("says where it's going when it opens where the person had taken the page", () => {
      const first = hostIn()
      const viewer = live(first)
      attach(pageOf(first), { url: "http://localhost:5173/work", back: true, forward: false })
      pageOf(first).dispatchEvent(event("did-navigate"))
      const places: Place[] = []
      mountBrowser(hostIn(), {
        content: { url: "http://localhost:5173/" },
        label: "page",
        saved: viewer.state(),
        live: true,
        partition: "pages",
        on: { navigate: (place) => places.push(place) },
      })
      expect(places.map((place) => place.url)).toEqual(["http://localhost:5173/work"])
    })

    it("doesn't load its page again to restore where it already is", () => {
      const host = hostIn()
      const viewer = live(host)
      const page = pageOf(host)
      let set = 0
      const setAttribute = page.setAttribute.bind(page)
      page.setAttribute = (name: string, value: string) => {
        if (name === "src") set += 1
        setAttribute(name, value)
      }
      viewer.restore(viewer.state())
      expect(set).toBe(0)
    })
  })

  context("without live pages", () => {
    it("shows a snapshot of the page, ready, at its address", () => {
      const host = hostIn()
      const places: Place[] = []
      const loads: Load[] = []
      mountBrowser(host, {
        content: { url: "https://example.com/" },
        label: "page",
        live: false,
        snapshot: { src: "data:image/png;base64,", alt: "The page as shown" },
        partition: "pages",
        on: { navigate: (place) => places.push(place), load: (load) => loads.push(load) },
      })
      expect(host.querySelector("webview")).toBeNull()
      expect(host.querySelector(".browser-snapshot img")!.getAttribute("alt")).toBe(
        "The page as shown",
      )
      expect(places).toEqual([{ url: "https://example.com/", back: false, forward: false }])
      expect(loads).toEqual(["ready"])
    })

    it("shows nothing without a snapshot, for its host to say why", () => {
      const host = hostIn()
      mountBrowser(host, {
        content: { url: "https://example.com/" },
        label: "page",
        live: false,
        partition: "pages",
      })
      expect(host.querySelector(".browser-viewer")!.children).toHaveLength(0)
    })
  })
})
