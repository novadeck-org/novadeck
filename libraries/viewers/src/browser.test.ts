import "./browser.css"
import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  mountBrowser,
  scrollWaitMs,
  type BrowserContent,
  type BrowserOptions,
  type Load,
  type Place,
} from "./browser.js"
import type { ViewerState } from "./index.js"

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

    context("shown again", () => {
      const url = "http://localhost:5173/"
      // A page shown at `url`, attached where `at` says, recording what is asked of it.
      const shownAt = (content: BrowserContent, saved?: ViewerState) => {
        const host = hostIn()
        const loads: Load[] = []
        const viewer = mountBrowser(host, {
          content,
          label: "page",
          live: true,
          partition: "pages",
          on: { load: (load) => loads.push(load) },
          ...(saved && { saved }),
        })
        const page = pageOf(host)
        const at = { url, back: false, forward: false }
        const calls: string[] = []
        attach(page, at, calls)
        Object.assign(page, {
          setAudioMuted: () => undefined,
          reloadIgnoringCache: () => calls.push("reload fresh"),
          loadURL: (address: string) => {
            calls.push(`load ${address}`)
            return Promise.resolve()
          },
          executeJavaScript: (code: string) => {
            calls.push(`run ${code}`)
            return Promise.resolve(true)
          },
        })
        const fire = (type: string, fields?: Record<string, unknown>) =>
          page.dispatchEvent(event(type, fields))
        return { viewer, page, at, calls, loads, fire }
      }
      const scrolled = (calls: readonly string[]) =>
        calls.filter((call) => call.startsWith("run ")).map((call) => call.slice(4))

      it("reloads, or goes back where it was shown if the person went elsewhere", () => {
        const { viewer, at, calls, loads, fire } = shownAt({ url, shown: 1 })
        at.url = `${url}work`
        fire("did-stop-loading")
        viewer.update({ url, shown: 2 })
        expect(calls).toEqual([`load ${url}`])
        expect(loads).toEqual(["loading", "ready", "loading"])
        at.url = url
        fire("did-stop-loading")
        viewer.update({ url, shown: 3 })
        expect(calls).toEqual([`load ${url}`, "reload fresh"])
        // The same show, or an older one, loads nothing.
        fire("did-stop-loading")
        viewer.update({ url, shown: 3 })
        viewer.update({ url, shown: 2 })
        expect(calls).toEqual([`load ${url}`, "reload fresh"])
        // An older show arriving late takes nothing back: the latest, read again, is done.
        viewer.update({ url, shown: 3 })
        expect(calls).toEqual([`load ${url}`, "reload fresh"])
      })

      it("reloads the document the person moved within, then goes to the shown fragment", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, loads, fire } = shownAt({ url: at, shown: 1 })
        where.url = `${url}#faq`
        fire("did-stop-loading")
        // Its first load is done, its fragment brought into view.
        calls.splice(0)
        viewer.update({ url: at, shown: 2, scroll: "#plans" })
        // Loading another fragment would only move within what the page held before.
        expect(calls).toEqual(["reload fresh"])
        expect(loads.at(-1)).toBe("loading")
        // Not carried out until it's at the fragment and scrolled.
        expect(viewer.state()).toMatchObject({ browser: { shown: 1 } })
        fire("did-stop-loading")
        expect(calls).toEqual(["reload fresh", `load ${at}`])
        expect(scrolled(calls)).toEqual([])
        where.url = at
        fire("did-navigate-in-page")
        expect(scrolled(calls)).toHaveLength(1)
        expect(viewer.state()).toMatchObject({ browser: { shown: 2 } })
      })

      it("reloads at the fragment it was shown at, going nowhere after", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, fire } = shownAt({ url: at, shown: 1 })
        where.url = at
        fire("did-stop-loading")
        // Its first load is done, its fragment brought into view.
        calls.splice(0)
        viewer.update({ url: at, shown: 2, scroll: "#plans" })
        fire("did-stop-loading")
        expect(calls.filter((call) => !call.startsWith("run "))).toEqual(["reload fresh"])
        expect(scrolled(calls)).toHaveLength(1)
      })

      it("brings the fragment it was shown at into view as it reloads, given no scroll", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, fire } = shownAt({ url: at, shown: 1 })
        where.url = at
        fire("did-stop-loading")
        expect(scrolled(calls)).toHaveLength(1)
        viewer.update({ url: at, shown: 2 })
        fire("did-stop-loading")
        // A reload keeps where the person had scrolled; the show is at its fragment.
        expect(scrolled(calls)).toHaveLength(2)
        expect(scrolled(calls)[1]).toContain(JSON.stringify(`[id=${JSON.stringify("pricing")}]`))
        // An address without one scrolls nowhere, nor does a route or a text directive.
        for (const [shown, address] of [
          [3, url],
          [4, `${url}#/settings`],
          [5, `${url}#!/settings`],
          [6, `${url}#:~:text=Pricing`],
        ] as const) {
          viewer.update({ url: address, shown })
          where.url = address
          fire("did-stop-loading")
        }
        expect(scrolled(calls)).toHaveLength(2)
        // A text directive after an id, or a % that encodes nothing, leaves the id.
        for (const [shown, address, id] of [
          [7, `${url}#plans:~:text=Pro`, "plans"],
          [8, `${url}#100%`, "100%"],
          [9, `${url}#caf%C3%A9`, "café"],
        ] as const) {
          viewer.update({ url: address, shown })
          where.url = address
          fire("did-stop-loading")
          expect(scrolled(calls).at(-1)).toContain(JSON.stringify(`[id=${JSON.stringify(id)}]`))
        }
      })

      it("starts a show over when another comes while its fragment is on the way", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, fire } = shownAt({ url: at, shown: 1 })
        where.url = `${url}#faq`
        fire("did-stop-loading")
        calls.splice(0)
        viewer.update({ url: at, shown: 2, scroll: "#plans" })
        fire("did-stop-loading")
        expect(calls).toEqual(["reload fresh", `load ${at}`])
        // Before the page reached it, a later show: the move waits for nothing now.
        viewer.update({ url: at, shown: 3, scroll: "#team" })
        fire("did-navigate-in-page")
        expect(scrolled(calls)).toEqual([])
        // The later show reloads and goes to its fragment, then scrolls there.
        fire("did-stop-loading")
        expect(calls).toEqual(["reload fresh", `load ${at}`, "reload fresh", `load ${at}`])
        expect(scrolled(calls)).toEqual([])
        where.url = at
        fire("did-navigate-in-page")
        expect(scrolled(calls)).toHaveLength(1)
        expect(scrolled(calls)[0]).toContain(JSON.stringify("#team"))
      })

      it("loads a fragment shown in another document afresh, and scrolls once it has loaded", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, loads, fire } = shownAt({ url: at, shown: 1 })
        where.url = `${url}other`
        fire("did-stop-loading")
        // Its first load is done, its fragment brought into view.
        calls.splice(0)
        viewer.update({ url: at, shown: 2, scroll: "#plans" })
        expect(calls).toEqual([`load ${at}`])
        expect(loads.at(-1)).toBe("loading")
        where.url = at
        fire("did-stop-loading")
        expect(scrolled(calls)).toHaveLength(1)
      })

      it("loads the page again for an address without the fragment the person went to", () => {
        const { viewer, at: where, calls, loads, fire } = shownAt({ url, shown: 1 })
        where.url = `${url}#install`
        fire("did-stop-loading")
        viewer.update({ url, shown: 2, scroll: "#pricing" })
        expect(calls).toEqual([`load ${url}`])
        expect(loads.at(-1)).toBe("loading")
        // Not on the page being replaced: on the one that loads.
        expect(scrolled(calls)).toEqual([])
        where.url = url
        fire("did-stop-loading")
        expect(scrolled(calls)).toHaveLength(1)
      })

      it("loads the shown address again when shown before its last show's load got there", () => {
        const { viewer, at: where, calls, fire } = shownAt({ url, shown: 1 })
        where.url = `${url}other`
        fire("did-stop-loading")
        viewer.update({ url, shown: 2 })
        fire("did-start-loading")
        // Still where the person went: a reload would go back there.
        viewer.update({ url, shown: 3, scroll: "#a" })
        expect(calls).toEqual([`load ${url}`, `load ${url}`])
      })

      it("lets a fragment go when the person leaves its document while it reloads", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, fire } = shownAt({ url: at, shown: 1 })
        where.url = `${url}#faq`
        fire("did-stop-loading")
        // Its first load is done, its fragment brought into view.
        calls.splice(0)
        viewer.update({ url: at, shown: 2, scroll: "#plans" })
        where.url = `${url}docs`
        fire("did-stop-loading")
        expect(calls).toEqual(["reload fresh"])
        expect(viewer.state()).toMatchObject({ browser: { shown: 2 } })
      })

      it("scrolls once the page itself, not a frame in it, reaches the shown fragment", () => {
        const at = `${url}#pricing`
        const { viewer, at: where, calls, fire } = shownAt({ url: at, shown: 1 })
        where.url = `${url}#faq`
        fire("did-stop-loading")
        // Its first load is done, its fragment brought into view.
        calls.splice(0)
        viewer.update({ url: at, shown: 2, scroll: "#plans" })
        fire("did-stop-loading")
        fire("did-navigate-in-page", { isMainFrame: false })
        expect(scrolled(calls)).toEqual([])
        where.url = at
        fire("did-navigate-in-page", { isMainFrame: true })
        expect(scrolled(calls)).toHaveLength(1)
      })

      it("reloads when shown during a later load, as the person's click", () => {
        const { viewer, calls, fire } = shownAt({ url, shown: 1 })
        fire("did-stop-loading")
        fire("did-start-loading")
        viewer.update({ url, shown: 2 })
        expect(calls).toEqual(["reload fresh"])
      })

      it("leaves a load of its address under way be, as its first", () => {
        const { viewer, calls, fire } = shownAt({ url, shown: 1 })
        viewer.update({ url, shown: 2 })
        expect(calls).toEqual([])
        // A first load that ended in a crash, with no stop, is reloaded.
        fire("render-process-gone")
        viewer.update({ url, shown: 3 })
        expect(calls).toEqual(["reload fresh"])
      })

      it("brings the show's element into view once the page has loaded", async () => {
        const { viewer, calls, fire } = shownAt({ url, shown: 1, scroll: "#pricing" })
        expect(scrolled(calls)).toEqual([])
        fire("did-stop-loading")
        expect(scrolled(calls)).toHaveLength(1)
        // It runs in the page, here this one, the selector given as a string, never as code.
        const section = document.createElement("section")
        section.id = "pricing"
        let revealed = 0
        section.scrollIntoView = () => void (revealed += 1)
        document.body.append(section)
        try {
          await expect(new Function(`return ${scrolled(calls)[0]!}`)()).resolves.toBe(true)
        } finally {
          section.remove()
        }
        expect(revealed).toBe(1)
        // A failed load drops it; a later show scrolls again.
        viewer.update({ url, shown: 2, scroll: '"]; alert(1); ["' })
        fire("did-fail-load", { errorCode: -105, isMainFrame: true })
        fire("did-stop-loading")
        expect(scrolled(calls)).toHaveLength(1)
        viewer.update({ url, shown: 3, scroll: '"]; alert(1); ["' })
        fire("did-stop-loading")
        expect(scrolled(calls)[1]).toContain(JSON.stringify('"]; alert(1); ["'))
      })

      it("waits a while for the element of a page that draws itself, and gives up", async () => {
        vi.useFakeTimers()
        try {
          const { calls, fire } = shownAt({ url, shown: 1, scroll: "#late" })
          fire("did-stop-loading")
          const run = (): Promise<unknown> => new Function(`return ${scrolled(calls)[0]!}`)()
          let revealed = 0
          const late = run()
          const element = document.createElement("div")
          element.id = "late"
          element.scrollIntoView = () => void (revealed += 1)
          document.body.append(element)
          await vi.advanceTimersByTimeAsync(0)
          await expect(late).resolves.toBe(true)
          expect(revealed).toBe(1)
          element.remove()
          const never = run()
          await vi.advanceTimersByTimeAsync(scrollWaitMs)
          await expect(never).resolves.toBe(false)
        } finally {
          vi.useRealTimers()
        }
      })

      it("carries out each show once, however often a viewer mounts for it", () => {
        const first = shownAt({ url, shown: 2, scroll: "#a" })
        first.at.url = `${url}work`
        first.fire("did-stop-loading")
        expect(scrolled(first.calls)).toHaveLength(1)
        const state = first.viewer.state()
        first.viewer.destroy()

        // The same show: where the person had taken it, and no scroll.
        const again = shownAt({ url, shown: 2, scroll: "#a" }, state)
        expect(again.page.getAttribute("src")).toBe(`${url}work`)
        again.fire("did-stop-loading")
        expect(scrolled(again.calls)).toEqual([])

        // A later show, made while no viewer was there: at its address, scrolled.
        const later = shownAt({ url, shown: 3, scroll: "#b" }, state)
        expect(later.page.getAttribute("src")).toBe(url)
        later.fire("did-stop-loading")
        expect(scrolled(later.calls)).toHaveLength(1)

        // A show let go before its scroll: the next viewer still scrolls for it.
        later.viewer.update({ url, shown: 4, scroll: "#c" })
        const early = later.viewer.state()
        later.viewer.destroy()
        const next = shownAt({ url, shown: 4, scroll: "#c" }, early)
        next.fire("did-stop-loading")
        expect(scrolled(next.calls)).toHaveLength(1)
      })
    })

    it("keeps a snapshot at the latest show, whatever arrives late", () => {
      const host = hostIn()
      const viewer = mountBrowser(host, {
        content: { url: "http://localhost:5173/new", shown: 2 },
        label: "page",
        live: false,
        partition: "pages",
      })
      viewer.update({ url: "http://localhost:5173/old", shown: 1 })
      expect(viewer.state()).toMatchObject({
        browser: { url: "http://localhost:5173/new", shown: 2 },
      })
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
