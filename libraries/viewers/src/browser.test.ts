import "./browser.css"
import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  desktopWidth,
  fadeMs,
  framingOf,
  freshenMs,
  keepMs,
  mountBrowser,
  phoneScreen,
  scrollWaitMs,
  uncoverMs,
  type BrowserContent,
  type BrowserOptions,
  type Load,
  type Place,
  type Trouble,
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

    it("keeps its ground under the page only until it paints, not through later loads", () => {
      const host = hostIn()
      host.style.setProperty("--browser-page-bg", "rgb(255, 255, 255)")
      live(host)
      const page = pageOf(host)
      attach(page, { url: "http://localhost:5173/", back: false, forward: false })
      const ground = (): string => getComputedStyle(page).backgroundColor
      page.dispatchEvent(event("did-start-loading"))
      expect(ground()).toBe("rgb(255, 255, 255)")
      // Painting its own, nothing is under it: a page drawn a device pixel short shows no
      // line, though what it waits on hasn't loaded.
      page.dispatchEvent(event("dom-ready"))
      expect(ground()).toBe("rgba(0, 0, 0, 0)")
      page.dispatchEvent(event("did-stop-loading"))
      // A later load keeps the last frame over it.
      page.dispatchEvent(event("did-start-loading"))
      expect(ground()).toBe("rgba(0, 0, 0, 0)")
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

  context("framing its page", () => {
    // The page's view as it lays out, and as it's drawn on screen.
    const boxes = (host: HTMLElement) => {
      const page = pageOf(host)
      const drawn = page.getBoundingClientRect()
      const viewer = host.querySelector(".browser-viewer")!.getBoundingClientRect()
      return {
        laid: [page.offsetWidth, page.offsetHeight],
        drawn: [drawn.left - viewer.left, drawn.top - viewer.top, drawn.width, drawn.height],
      }
    }

    it("lays out as a desktop's window, scaled down to fit a narrower viewer", () => {
      const host = hostIn()
      live(host)
      expect(host.querySelector(".browser-viewer")!.getAttribute("data-size")).toBe("desktop")
      expect(boxes(host)).toEqual({ laid: [desktopWidth, 960], drawn: [0, 0, 400, 300] })
    })

    it("fills a viewer as wide as a desktop's window, as it is", async () => {
      const host = hostIn()
      host.style.width = `${desktopWidth + 100}px`
      live(host)
      expect(boxes(host)).toEqual({
        laid: [desktopWidth + 100, 300],
        drawn: [0, 0, desktopWidth + 100, 300],
      })
      // Narrower, it's scaled down to fit again.
      host.style.width = "640px"
      await expect.poll(() => boxes(host).laid).toEqual([desktopWidth, 600])
      expect(boxes(host).drawn).toEqual([0, 0, 640, 300])
    })

    it("lays out as a phone's screen when told, back to a desktop's when told again", async () => {
      const host = hostIn()
      host.style.width = "300px"
      host.style.height = "600px"
      const viewer = mountBrowser(host, {
        content: { url: "http://localhost:5173/" },
        label: "page",
        live: true,
        partition: "pages",
        size: "phone",
      })
      expect(host.querySelector(".browser-viewer")!.getAttribute("data-size")).toBe("phone")
      // Scaled down to fit the viewer's width, and no taller than it.
      expect(boxes(host).laid).toEqual([phoneScreen.width, 780])
      expect(boxes(host).drawn).toEqual([0, 0, 300, 600])
      viewer.size("desktop")
      expect(boxes(host).laid).toEqual([desktopWidth, 2560])
      viewer.size("phone")
      host.style.width = "800px"
      host.style.height = "1000px"
      // Room for the whole screen: as big as a phone's, centred.
      await expect
        .poll(() => boxes(host).drawn)
        .toEqual([205, 78, phoneScreen.width, phoneScreen.height])
      expect(boxes(host).laid).toEqual([phoneScreen.width, phoneScreen.height])
    })

    it("frames nothing in a viewer with no room, as one kept out of sight", () => {
      expect(framingOf("desktop", 0, 300)).toBeUndefined()
      expect(framingOf("phone", 400, 0)).toBeUndefined()
    })
  })

  context("at rest", () => {
    const url = "http://localhost:5173/"
    const shot = "data:image/jpeg;base64,c2hvdA=="
    const later = "data:image/jpeg;base64,bGF0ZXI="
    // Its picture, and its page, while there is one.
    const pictureOf = (host: HTMLElement) => host.querySelector<HTMLElement>(".browser-picture")
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
    // A live page that rests as `pictures` come, each taking the next (none once they're
    // out), attached as each of its views is made, recording what is asked of it.
    const resting = ({
      pictures = [shot],
      content = { url },
      saved,
      awake,
    }: {
      pictures?: (string | undefined)[]
      content?: BrowserContent
      saved?: ViewerState
      awake?: boolean
    } = {}) => {
      const host = hostIn()
      // Clear of where the test's pointer rests, so it isn't under it.
      host.style.marginTop = "400px"
      const loads: Load[] = []
      const places: Place[] = []
      const calls: string[] = []
      const at = { url: content.url, back: true, forward: false }
      const taken: number[] = []
      const viewer = mountBrowser(host, {
        content,
        label: "page",
        live: true,
        partition: "pages",
        picture: async (id) => {
          taken.push(id)
          return pictures.shift()
        },
        on: { load: (load) => loads.push(load), navigate: (place) => places.push(place) },
        ...(saved && { saved }),
        ...(awake !== undefined && { awake }),
      })
      // Each view, attached as it's made, as Electron does it.
      const ready = () => {
        const page = pageOf(host)
        if (!page || "getWebContentsId" in page) return page
        attach(page, at, calls)
        Object.assign(page, {
          getWebContentsId: () => 7,
          reloadIgnoringCache: () => calls.push("reload fresh"),
          loadURL: (address: string) => {
            calls.push(`load ${address}`)
            return Promise.resolve()
          },
          executeJavaScript: (code: string) => {
            calls.push(`run ${code}`)
            return Promise.resolve(code === "[scrollX, scrollY]" ? [0, 640] : true)
          },
        })
        return page
      }
      ready()
      const fire = (type: string, fields?: Record<string, unknown>) =>
        ready()!.dispatchEvent(event(type, fields))
      return { host, viewer, at, calls, loads, places, taken, fire, ready }
    }

    it("takes a picture of the page and where it's scrolled, and shows it in its view's place", async () => {
      const { host, viewer, calls, places, taken, fire } = resting()
      fire("did-stop-loading")
      expect(viewer.pictured()).toBe(false)
      viewer.awake(false)
      await settled()
      expect(taken).toEqual([7])
      expect(calls).toContain("run [scrollX, scrollY]")
      expect(pageOf(host)).toBeNull()
      expect(pictureOf(host)!.querySelector("img")!.getAttribute("src")).toBe(shot)
      expect(pictureOf(host)!.querySelector("img")!.getAttribute("alt")).toBe("page")
      expect(viewer.pictured()).toBe(true)
      // Its history went with its view.
      expect(places.at(-1)).toEqual({ url, back: false, forward: false })
      expect(viewer.state()).toMatchObject({
        browser: { picture: { src: shot, at: url }, scrolled: [0, 640] },
      })
    })

    it("wakes under its picture, where it was scrolled, and lets the picture fade once there", async () => {
      vi.useFakeTimers()
      try {
        const { host, viewer, calls, loads, fire, ready } = resting()
        fire("did-stop-loading")
        viewer.awake(false)
        await vi.runAllTimersAsync()
        calls.splice(0)
        viewer.awake(true)
        expect(pageOf(host)!.getAttribute("src")).toBe(url)
        expect(loads.at(-1)).toBe("loading")
        ready()
        // Loading: the picture stays over it, on the page's ground.
        expect(pictureOf(host)).not.toBeNull()
        expect(getComputedStyle(pictureOf(host)!).backgroundColor).toBe("rgb(255, 255, 255)")
        fire("did-stop-loading")
        expect(calls.some((call) => call.includes("scrollTo(0, 640)"))).toBe(true)
        await vi.advanceTimersByTimeAsync(uncoverMs)
        expect(pictureOf(host)!.hasAttribute("data-fading")).toBe(true)
        // Fading off a page that has drawn, with no ground to show at its edge.
        expect(getComputedStyle(pictureOf(host)!).backgroundColor).toBe("rgba(0, 0, 0, 0)")
        await vi.advanceTimersByTimeAsync(fadeMs)
        expect(pictureOf(host)).toBeNull()
        // Woken, it's live again: back, forward and the rest work on it.
        viewer.back()
        expect(calls).toContain("back")
      } finally {
        vi.useRealTimers()
      }
    })

    it("stays live when it can't be pictured, until a later rest can", async () => {
      const { host, viewer, fire } = resting({ pictures: [undefined, shot] })
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      expect(pageOf(host)).not.toBeNull()
      expect(viewer.pictured()).toBe(false)
      viewer.awake(true)
      viewer.awake(false)
      await settled()
      expect(pageOf(host)).toBeNull()
      expect(viewer.pictured()).toBe(true)
    })

    it("rests once a load under way is done, unless a picture it has stands in", async () => {
      const { host, viewer, taken, fire, ready } = resting({ pictures: [shot, later] })
      // Its first load: nothing to stand in, so it rests once loaded.
      viewer.awake(false)
      await settled()
      expect(taken).toEqual([])
      expect(pageOf(host)).not.toBeNull()
      fire("did-stop-loading")
      await settled()
      expect(pageOf(host)).toBeNull()
      // Woken, then told to rest again mid-load: the picture it has stands in at once.
      viewer.awake(true)
      ready()
      viewer.awake(false)
      expect(pageOf(host)).toBeNull()
      expect(taken).toHaveLength(1)
      expect(pictureOf(host)!.querySelector("img")!.getAttribute("src")).toBe(shot)
    })

    it("doesn't rest as a picture taken while it's woken, or once a load began", async () => {
      // Each rest takes one: the two it drops, and the one it rests as.
      const { host, viewer, fire, ready } = resting({ pictures: [shot, later, later] })
      fire("did-stop-loading")
      viewer.awake(false)
      viewer.awake(true)
      await settled()
      expect(pageOf(host)).not.toBeNull()
      expect(viewer.pictured()).toBe(false)
      // A show's load begins while its picture is taken: it rests once that's done.
      viewer.awake(false)
      viewer.update({ url, shown: 1 })
      await settled()
      expect(pageOf(host)).not.toBeNull()
      ready()
      fire("did-stop-loading")
      await settled()
      expect(pageOf(host)).toBeNull()
      expect(pictureOf(host)!.querySelector("img")!.getAttribute("src")).toBe(later)
    })

    it("loads a show that came while it rested afresh once woken, then brings it into view", async () => {
      const { host, viewer, calls, places, fire, ready } = resting()
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      viewer.update({ url, shown: 1, scroll: "#plans" })
      // Not carried out yet: a viewer mounted for it before it wakes carries it out.
      expect(viewer.state()).toMatchObject({ browser: { shown: 0 } })
      expect(places.at(-1)?.url).toBe(url)
      calls.splice(0)
      viewer.awake(true)
      ready()
      fire("did-stop-loading")
      // Past the cache, as a show again is; then the element, not where it was scrolled.
      expect(calls).toEqual(["muted false", "reload fresh"])
      fire("did-stop-loading")
      expect(calls.filter((call) => call.startsWith("run "))).toHaveLength(1)
      expect(calls.at(-1)).toContain(JSON.stringify("#plans"))
      expect(viewer.state()).toMatchObject({ browser: { shown: 1 } })
      expect(pageOf(host)).not.toBeNull()
    })

    it("goes to a new address it's given while it rests once woken", async () => {
      const { host, viewer, fire } = resting()
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      viewer.update({ url: "https://example.com/" })
      viewer.awake(true)
      expect(pageOf(host)!.getAttribute("src")).toBe("https://example.com/")
    })

    it("reloads afresh once woken when asked to reload at rest", async () => {
      const { viewer, calls, fire, ready } = resting()
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      viewer.reload()
      calls.splice(0)
      viewer.awake(true)
      ready()
      fire("did-stop-loading")
      expect(calls).toContain("reload fresh")
    })

    it("starts at rest from its state, as its picture, and wakes where it was", async () => {
      const first = resting()
      first.at.url = `${url}work`
      first.fire("did-navigate")
      first.fire("did-stop-loading")
      first.viewer.awake(false)
      await settled()
      const saved = first.viewer.state()
      first.viewer.destroy()
      const again = resting({ saved, awake: false })
      expect(pageOf(again.host)).toBeNull()
      expect(again.loads).toEqual(["loading", "ready"])
      expect(again.places).toEqual([{ url: `${url}work`, back: false, forward: false }])
      expect(pictureOf(again.host)!.querySelector("img")!.getAttribute("src")).toBe(shot)
      again.viewer.awake(true)
      expect(pageOf(again.host)!.getAttribute("src")).toBe(`${url}work`)
      // Woken from the first, it's live under its picture until it's there.
      const awake = resting({ saved })
      expect(pageOf(awake.host)).not.toBeNull()
      expect(pictureOf(awake.host)).not.toBeNull()
    })

    it("rests out of sight only as a picture from since the person was at it, asking for none", async () => {
      const { host, viewer, taken, fire, ready } = resting({ pictures: [shot] })
      fire("did-stop-loading")
      host.style.display = "none"
      viewer.awake(false)
      await settled()
      expect(taken).toEqual([])
      expect(pageOf(host)).not.toBeNull()
      host.style.display = "flex"
      viewer.awake(false)
      await settled()
      viewer.awake(true)
      ready()
      // Mid-load out of sight, the person hasn't seen it live: its picture stands in.
      viewer.awake(false)
      expect(taken).toEqual([7])
      expect(pageOf(host)).toBeNull()
      expect(pictureOf(host)!.querySelector("img")!.getAttribute("src")).toBe(shot)
      // Woken and loaded, the person may change it: a picture from before stands in for
      // nothing, nor is it kept, until a new one is taken.
      host.style.display = "flex"
      viewer.awake(true)
      ready()
      fire("did-stop-loading")
      expect(viewer.pictured()).toBe(false)
      expect(viewer.state()).not.toHaveProperty("browser.picture")
      host.style.display = "none"
      viewer.awake(false)
      await settled()
      expect(pageOf(host)).not.toBeNull()
    })

    it("brings a show that came as it woke into view afresh, not where it was scrolled", async () => {
      const { viewer, calls, fire, ready } = resting()
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      viewer.awake(true)
      ready()
      // Its wake's load is under way: the show's goes once it's done, past the cache.
      viewer.update({ url, shown: 1, scroll: "#plans" })
      calls.splice(0)
      fire("did-stop-loading")
      expect(calls).toContain("reload fresh")
      fire("did-stop-loading")
      const runs = calls.filter((call) => call.startsWith("run "))
      expect(runs).toHaveLength(1)
      expect(runs[0]).toContain(JSON.stringify("#plans"))
    })

    it("brings a show's element into view on waking when it rested while waiting for it", async () => {
      const { viewer, calls, fire, ready } = resting({ content: { url, shown: 1, scroll: "#a" } })
      // The page draws the element late: its show waits.
      Object.assign(ready()!, {
        executeJavaScript: (code: string) => {
          calls.push(`run ${code}`)
          return code === "[scrollX, scrollY]" ? Promise.resolve([0, 0]) : new Promise(() => {})
        },
      })
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      expect(viewer.state()).toMatchObject({ browser: { shown: 0 } })
      viewer.awake(true)
      ready()
      calls.splice(0)
      fire("did-stop-loading")
      expect(calls.filter((call) => call.startsWith("run "))).toHaveLength(1)
      expect(calls.at(-1)).toContain(JSON.stringify("#a"))
    })

    it("is pictured a while after each load, so it rests out of sight as it is", async () => {
      vi.useFakeTimers()
      try {
        const { host, viewer, taken, fire } = resting({ pictures: [later] })
        fire("did-stop-loading")
        await vi.advanceTimersByTimeAsync(freshenMs)
        expect(taken).toEqual([7])
        host.style.display = "none"
        viewer.awake(false)
        await vi.advanceTimersByTimeAsync(0)
        expect(pageOf(host)).toBeNull()
        expect(pictureOf(host)!.querySelector("img")!.getAttribute("src")).toBe(later)
      } finally {
        vi.useRealTimers()
      }
    })

    it("is pictured again once an app moves within the page, and while awake", async () => {
      vi.useFakeTimers()
      try {
        const { host, viewer, at, taken, fire } = resting({ pictures: [shot, later, later] })
        fire("did-stop-loading")
        await vi.advanceTimersByTimeAsync(freshenMs)
        expect(taken).toHaveLength(1)
        // An app's route: the picture is of where it was, until it's pictured again.
        at.url = `${url}settings`
        fire("did-navigate-in-page", { isMainFrame: true })
        host.style.display = "none"
        viewer.awake(false)
        await vi.advanceTimersByTimeAsync(0)
        expect(pageOf(host)).not.toBeNull()
        host.style.display = "flex"
        viewer.awake(true)
        await vi.advanceTimersByTimeAsync(freshenMs)
        expect(taken).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(keepMs)
        expect(taken).toHaveLength(3)
        host.style.display = "none"
        viewer.awake(false)
        await vi.advanceTimersByTimeAsync(0)
        expect(pageOf(host)).toBeNull()
        expect(pictureOf(host)!.querySelector("img")!.getAttribute("src")).toBe(later)
      } finally {
        vi.useRealTimers()
      }
    })

    it("isn't pictured while it has focus, as the person uses it", async () => {
      vi.useFakeTimers()
      try {
        const { taken, fire, ready } = resting()
        const page = ready()!
        page.tabIndex = 0
        page.focus()
        fire("did-stop-loading")
        await vi.advanceTimersByTimeAsync(freshenMs + keepMs)
        expect(taken).toEqual([])
        page.blur()
        await vi.advanceTimersByTimeAsync(keepMs)
        expect(taken).toEqual([7])
      } finally {
        vi.useRealTimers()
      }
    })

    it("doesn't rest out of sight as a picture of another page", async () => {
      const { host, viewer, at, fire, ready } = resting()
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      viewer.awake(true)
      ready()
      at.url = "https://example.com/"
      fire("did-navigate")
      host.style.display = "none"
      viewer.awake(false)
      expect(pageOf(host)).not.toBeNull()
    })

    it("lets its picture go over a woken page that didn't load", async () => {
      vi.useFakeTimers()
      try {
        const { host, viewer, fire, ready } = resting()
        fire("did-stop-loading")
        viewer.awake(false)
        await vi.advanceTimersByTimeAsync(0)
        viewer.awake(true)
        ready()
        fire("did-fail-load", { errorCode: -105, isMainFrame: true })
        viewer.awake(false)
        fire("did-stop-loading")
        await vi.advanceTimersByTimeAsync(uncoverMs + fadeMs)
        expect(pictureOf(host)).toBeNull()
        expect(pageOf(host)).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("never covers itself with a picture of another page", async () => {
      const first = resting()
      first.fire("did-stop-loading")
      first.viewer.awake(false)
      await settled()
      const saved = first.viewer.state() as unknown as {
        browser: { picture: { src: string; at: string } }
      }
      first.viewer.destroy()
      const elsewhere = {
        browser: { ...saved.browser, at: `${url}other`, picture: saved.browser.picture },
      } as unknown as ViewerState
      for (const awake of [true, false]) {
        const again = resting({ saved: elsewhere, awake })
        expect(pageOf(again.host)!.getAttribute("src")).toBe(`${url}other`)
        expect(pictureOf(again.host)).toBeNull()
      }
    })

    it("opens live after being let go while the person was at it", async () => {
      const first = resting()
      first.fire("did-stop-loading")
      first.viewer.awake(false)
      await settled()
      first.viewer.awake(true)
      first.ready()
      first.fire("did-stop-loading")
      // At it, then let go, as a view switch does, before a new picture could be taken.
      first.host.querySelector(".browser-viewer")!.dispatchEvent(new PointerEvent("pointerenter"))
      const saved = first.viewer.state()
      first.viewer.destroy()
      const again = resting({ saved, awake: false })
      expect(pageOf(again.host)).not.toBeNull()
      expect(pictureOf(again.host)).toBeNull()
      expect(again.viewer.pictured()).toBe(false)
    })

    it("takes its picture down when it's shown at another address while it rests", async () => {
      const { host, viewer, fire } = resting()
      fire("did-stop-loading")
      viewer.awake(false)
      await settled()
      viewer.update({ url: "https://example.com/", shown: 1 })
      expect(pictureOf(host)).toBeNull()
    })

    it("rests all the same when the page doesn't say where it's scrolled", async () => {
      vi.useFakeTimers()
      try {
        const { host, viewer, fire, ready } = resting()
        Object.assign(ready()!, { executeJavaScript: () => new Promise(() => {}) })
        fire("did-stop-loading")
        viewer.awake(false)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(pageOf(host)).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it("goes only once its picture has decoded, and stays for a show that came meanwhile", async () => {
      let decoded!: () => void
      const decode = vi
        .spyOn(HTMLImageElement.prototype, "decode")
        .mockImplementation(() => new Promise<void>((resolve) => (decoded = resolve)))
      try {
        const { host, viewer, calls, loads, fire } = resting()
        fire("did-stop-loading")
        viewer.awake(false)
        await settled()
        // Its picture is up, not yet drawn: the view is still there.
        expect(pictureOf(host)).not.toBeNull()
        expect(pageOf(host)).not.toBeNull()
        viewer.update({ url, shown: 1 })
        expect(calls).toContain("reload fresh")
        decoded()
        await settled()
        // The show's load goes on, and it rests once that's done.
        expect(pageOf(host)).not.toBeNull()
        expect(loads.at(-1)).toBe("loading")
      } finally {
        decode.mockRestore()
      }
    })

    it("keeps the picture last asked for, whatever arrives late", async () => {
      vi.useFakeTimers()
      try {
        const answers: ((src: string) => void)[] = []
        const host = hostIn()
        host.style.marginTop = "400px"
        const viewer = mountBrowser(host, {
          content: { url },
          label: "page",
          live: true,
          partition: "pages",
          picture: () => new Promise((resolve) => answers.push(resolve)),
        })
        const page = pageOf(host)
        attach(page, { url, back: false, forward: false })
        Object.assign(page, {
          getWebContentsId: () => 7,
          executeJavaScript: () => Promise.resolve([0, 0]),
        })
        page.dispatchEvent(event("did-stop-loading"))
        await vi.advanceTimersByTimeAsync(freshenMs)
        await vi.advanceTimersByTimeAsync(keepMs)
        expect(answers).toHaveLength(2)
        answers[1]!(later)
        await vi.advanceTimersByTimeAsync(0)
        answers[0]!(shot)
        await vi.advanceTimersByTimeAsync(0)
        expect(viewer.state()).toMatchObject({ browser: { picture: { src: later } } })
      } finally {
        vi.useRealTimers()
      }
    })

    it("counts a minimized window as out of sight", async () => {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      try {
        const { host, viewer, taken, fire } = resting()
        fire("did-stop-loading")
        viewer.awake(false)
        await settled()
        expect(taken).toEqual([])
        expect(pageOf(host)).not.toBeNull()
      } finally {
        visibility.mockRestore()
      }
    })

    it("counts focus moving into the live page as the person at it", async () => {
      vi.useFakeTimers()
      try {
        const { viewer, fire, ready } = resting()
        const page = ready()!
        page.tabIndex = 0
        fire("did-stop-loading")
        // Pictured since, while the person was elsewhere.
        await vi.advanceTimersByTimeAsync(freshenMs)
        expect(viewer.pictured()).toBe(true)
        page.focus()
        expect(viewer.pictured()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("counts focus in the live page as the person at it, and hands the picture's focus on", async () => {
      vi.useFakeTimers()
      try {
        const { host, viewer, fire, ready } = resting()
        fire("did-stop-loading")
        viewer.awake(false)
        await vi.advanceTimersByTimeAsync(0)
        // Focused by keyboard at rest, it wakes, and focus goes on to the page.
        pictureOf(host)!.focus()
        viewer.awake(true)
        const page = ready()!
        page.tabIndex = 0
        fire("did-stop-loading")
        await vi.advanceTimersByTimeAsync(uncoverMs + fadeMs + 2_000)
        expect(document.activeElement).toBe(page)
        expect(viewer.pictured()).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it("stays live without a way to take a picture, or when it didn't load", async () => {
      const host = hostIn()
      const viewer = mountBrowser(host, {
        content: { url },
        label: "page",
        live: true,
        partition: "pages",
      })
      attach(pageOf(host), { url, back: false, forward: false })
      pageOf(host).dispatchEvent(event("did-stop-loading"))
      viewer.awake(false)
      await settled()
      expect(pageOf(host)).not.toBeNull()
      const failing = resting()
      failing.fire("did-fail-load", { errorCode: -105, isMainFrame: true })
      failing.fire("did-stop-loading")
      failing.viewer.awake(false)
      await settled()
      expect(failing.taken).toEqual([])
      expect(pageOf(failing.host)).not.toBeNull()
    })

    context("while the page has a sign-in window open", () => {
      // The desktop host's word, through the preload, of how many the view `contentsId` has.
      const signIns = (open: number, contentsId = 7, source: Window | null = window) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source,
            data: { type: "novadeck:page-sign-in", contentsId, open },
          }),
        )

      it("stays live, as its view going would close it, and rests once it closes", async () => {
        const { host, viewer, fire } = resting()
        fire("did-stop-loading")
        signIns(1)
        viewer.awake(false)
        await settled()
        expect(pageOf(host)).not.toBeNull()
        signIns(2)
        signIns(1)
        await settled()
        expect(pageOf(host)).not.toBeNull()
        signIns(0)
        await settled()
        expect(pageOf(host)).toBeNull()
        expect(pictureOf(host)).not.toBeNull()
      })

      it("stays live through a rest already under way", async () => {
        const { host, viewer, fire } = resting()
        fire("did-stop-loading")
        viewer.awake(false)
        signIns(1)
        await settled()
        expect(pageOf(host)).not.toBeNull()
      })

      it("heeds no word of another view, another window, or a malformed one", async () => {
        const { host, viewer, fire } = resting()
        fire("did-stop-loading")
        signIns(1, 8)
        signIns(1, 7, null)
        signIns(-1)
        viewer.awake(false)
        await settled()
        expect(pageOf(host)).toBeNull()
      })

      it("stops listening when the viewer goes", async () => {
        const { viewer, fire } = resting()
        fire("did-stop-loading")
        viewer.destroy()
        expect(() => signIns(0)).not.toThrow()
      })
    })
  })

  context("with troubles on the page", () => {
    const origin = "http://localhost:5173"
    const contentsId = 7

    const failLoad = (page: HTMLElement, validatedURL: string, errorCode = -102) =>
      page.dispatchEvent(
        event("did-fail-load", {
          errorCode,
          errorDescription: errorCode === -102 ? "ERR_CONNECTION_REFUSED" : "",
          isMainFrame: true,
          validatedURL,
        }),
      )

    // A live page at the shown address, what it reports, and the ways the page and the
    // app's preload tell of what went wrong.
    const troubled = (content: BrowserContent = { url: `${origin}/`, shown: 1 }) => {
      const host = hostIn()
      const troubles: Trouble[] = []
      const shows: number[] = []
      const viewer = mountBrowser(host, {
        content,
        label: "page",
        live: true,
        partition: "pages",
        on: {
          trouble: (trouble, shown) => {
            troubles.push(trouble)
            shows.push(shown)
          },
        },
      })
      const page = pageOf(host)
      attach(page, { url: content.url, back: false, forward: false })
      Object.assign(page, { getWebContentsId: () => contentsId })
      return {
        page,
        viewer,
        troubles,
        shows,
        goes: (url: string) => Object.assign(page, { getURL: () => url }),
        log: (fields: Record<string, unknown> = {}) =>
          page.dispatchEvent(
            event("console-message", {
              level: 3,
              message: "boom",
              line: 7,
              sourceId: `${origin}/app.js`,
              ...fields,
            }),
          ),
        // A request the preload tells of, by default a missing script.
        failed: (
          fields: Record<string, unknown> = {},
          source: MessageEventSource | null = window,
        ) =>
          window.dispatchEvent(
            new MessageEvent("message", {
              source,
              data: {
                type: "novadeck:page-request",
                contentsId,
                url: `${origin}/missing.js`,
                status: 404,
                what: "script",
                ...fields,
              },
            }),
          ),
      }
    }

    it("reports an error the page logged, with where it came from", () => {
      const { log, troubles } = troubled()
      log()
      expect(troubles).toEqual([
        { kind: "error", text: "boom", source: `${origin}/app.js`, line: 7 },
      ])
    })

    it("leaves out what isn't an error of the shown origin", () => {
      const { log, troubles } = troubled()
      log({ level: 2 })
      log({ level: 1 })
      log({ sourceId: "node:electron/js2c/sandbox_bundle" })
      log({ sourceId: "" })
      log({ sourceId: "https://ads.example.com/frame.js" })
      expect(troubles).toEqual([])
    })

    it("reports nothing from a page the person took elsewhere, until it is back", () => {
      const t = troubled()
      t.goes("https://example.com/")
      t.log({ sourceId: "https://example.com/app.js" })
      t.log()
      t.failed({ url: "https://example.com/x.js" })
      t.failed()
      expect(t.troubles).toEqual([])
      t.goes(`${origin}/deeper/page`)
      t.log()
      expect(t.troubles.map((each) => each.kind)).toEqual(["error"])
    })

    it("follows the address it is shown at", () => {
      const t = troubled()
      t.viewer.update({ url: "https://example.com/", shown: 1 })
      t.log()
      expect(t.troubles).toEqual([])
      t.goes("https://example.com/")
      t.log({ sourceId: "https://example.com/app.js" })
      expect(t.troubles).toHaveLength(1)
    })

    it("reports a load that failed outright, not an aborted one, a frame's or another site's", () => {
      const { page, troubles } = troubled()
      failLoad(page, `${origin}/`, -3)
      page.dispatchEvent(
        event("did-fail-load", { errorCode: -105, isMainFrame: false, validatedURL: `${origin}/` }),
      )
      failLoad(page, "https://example.com/")
      expect(troubles).toEqual([])
      failLoad(page, `${origin}/`)
      failLoad(page, `${origin}/`, -105)
      expect(troubles).toEqual([
        { kind: "load", text: "ERR_CONNECTION_REFUSED" },
        { kind: "load", text: "Error -105" },
      ])
    })

    context("with the requests the desktop tells of", () => {
      it("reports a request of the shown origin that failed", () => {
        const t = troubled()
        t.failed()
        t.failed({ url: `${origin}/api`, status: 0, what: "fetch" })
        expect(t.troubles).toEqual([
          { kind: "request", url: `${origin}/missing.js`, status: 404, what: "script" },
          { kind: "request", url: `${origin}/api`, status: 0, what: "fetch" },
        ])
      })

      it("leaves out another view's, another window's, another site's and malformed ones", () => {
        const t = troubled()
        t.failed({ contentsId: contentsId + 1 })
        t.failed({}, null)
        const frame = document.createElement("iframe")
        document.body.append(frame)
        t.failed({}, frame.contentWindow)
        frame.remove()
        t.failed({ url: "https://cdn.example.com/x.js" })
        t.failed({ url: "not an address" })
        t.failed({ status: "404" })
        t.failed({ status: 404.5 })
        t.failed({ type: "other" })
        expect(t.troubles).toEqual([])
      })

      it("holds a failure of the page itself until the page has committed", () => {
        const t = troubled()
        t.page.dispatchEvent(event("did-start-loading"))
        t.failed({ url: `${origin}/`, status: 404, what: "page" })
        expect(t.troubles).toEqual([])
        t.page.dispatchEvent(event("did-navigate"))
        expect(t.troubles).toEqual([
          { kind: "request", url: `${origin}/`, status: 404, what: "page" },
        ])
        // Once committed, a failure of the page is told at once.
        t.failed({ url: `${origin}/`, status: 500, what: "page" })
        expect(t.troubles).toHaveLength(2)
      })

      it("drops a held failure of a load that another replaced, or of a page left", () => {
        const t = troubled()
        t.page.dispatchEvent(event("did-start-loading"))
        t.failed({ url: `${origin}/`, status: 404, what: "page" })
        t.page.dispatchEvent(event("did-start-loading"))
        t.page.dispatchEvent(event("did-navigate"))
        expect(t.troubles).toEqual([])
        t.page.dispatchEvent(event("did-start-loading"))
        t.failed({ url: `${origin}/`, status: 404, what: "page" })
        t.goes("https://example.com/")
        t.page.dispatchEvent(event("did-navigate"))
        expect(t.troubles).toEqual([])
      })

      it("stops listening when the viewer goes", () => {
        const t = troubled()
        t.viewer.destroy()
        t.failed()
        expect(t.troubles).toEqual([])
      })
    })

    context("with a load that fails outright", () => {
      const reshown = (t: ReturnType<typeof troubled>) => {
        t.viewer.update({ url: `${origin}/`, shown: 2 })
        t.page.dispatchEvent(event("did-start-loading"))
      }

      it("is a new document, carrying the show being carried out", () => {
        const t = troubled()
        reshown(t)
        failLoad(t.page, `${origin}/`)
        expect(t.troubles).toEqual([{ kind: "load", text: "ERR_CONNECTION_REFUSED" }])
        expect(t.shows).toEqual([2])
      })

      it("is told even when the document before it was capped", () => {
        const t = troubled()
        for (let each = 0; each < 30; each += 1) t.log()
        expect(t.troubles).toHaveLength(20)
        reshown(t)
        failLoad(t.page, `${origin}/`)
        expect(t.troubles).toHaveLength(21)
        expect(t.shows.at(-1)).toBe(2)
      })

      it("takes the place of a failed request for the page that got no answer", () => {
        const t = troubled()
        reshown(t)
        t.failed({ url: `${origin}/`, status: 0, what: "page" })
        failLoad(t.page, `${origin}/`)
        expect(t.troubles).toEqual([{ kind: "load", text: "ERR_CONNECTION_REFUSED" }])
      })

      it("takes the place of that request when its word comes after the failed load", () => {
        const t = troubled()
        reshown(t)
        failLoad(t.page, `${origin}/`)
        t.failed({ url: `${origin}/`, status: 0, what: "page" })
        expect(t.troubles).toEqual([{ kind: "load", text: "ERR_CONNECTION_REFUSED" }])
        // The page's other requests still count, and the next load starts over.
        t.failed({ url: `${origin}/api`, status: 500, what: "fetch" })
        expect(t.troubles).toHaveLength(2)
        t.page.dispatchEvent(event("did-start-loading"))
        t.page.dispatchEvent(event("did-navigate"))
        t.failed({ url: `${origin}/`, status: 0, what: "page" })
        expect(t.troubles).toHaveLength(3)
      })

      it("tells a failed request for the page with the show of the load", () => {
        const t = troubled()
        reshown(t)
        t.failed({ url: `${origin}/`, status: 404, what: "page" })
        failLoad(t.page, `${origin}/`, -3)
        expect(t.troubles).toEqual([])
        failLoad(t.page, `${origin}/`)
        expect(t.troubles.map((each) => each.kind)).toEqual(["request", "load"])
        expect(t.shows).toEqual([2, 2])
      })
    })

    context("across shows and rests", () => {
      it("tells a load under way that a show took for its own with that show", () => {
        const t = troubled()
        t.page.dispatchEvent(event("did-start-loading"))
        t.page.dispatchEvent(event("did-navigate"))
        // Shown again before its first load is done: that load is the new show's.
        t.viewer.update({ url: `${origin}/`, shown: 2 })
        t.log()
        expect(t.shows).toEqual([2])
      })

      it("tells, after a rest, from the view its wake makes, with the show it wakes for", async () => {
        const host = hostIn()
        // Clear of where the test's pointer rests, so it isn't under it.
        host.style.marginTop = "400px"
        const shows: number[] = []
        const viewer = mountBrowser(host, {
          content: { url: `${origin}/`, shown: 1 },
          label: "page",
          live: true,
          partition: "pages",
          picture: async () => "data:image/jpeg;base64,c2hvdA==",
          on: { trouble: (_trouble, shown) => shows.push(shown) },
        })
        // Each view, attached as it's made, as Electron does it.
        const ready = (): HTMLElement => {
          const page = pageOf(host)
          attach(page, { url: `${origin}/`, back: false, forward: false })
          Object.assign(page, {
            getWebContentsId: () => contentsId,
            reloadIgnoringCache: () => undefined,
            loadURL: () => Promise.resolve(),
            executeJavaScript: (code: string) =>
              Promise.resolve(code === "[scrollX, scrollY]" ? [0, 0] : true),
          })
          return page
        }
        const first = ready()
        first.dispatchEvent(event("did-navigate"))
        first.dispatchEvent(event("did-stop-loading"))
        viewer.awake(false)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(host.querySelector("webview")).toBeNull()
        // The old view is gone: what is said of it now reaches nothing.
        first.dispatchEvent(
          event("console-message", {
            level: 3,
            message: "late",
            line: 1,
            sourceId: `${origin}/a.js`,
          }),
        )
        expect(shows).toEqual([])
        viewer.update({ url: `${origin}/`, shown: 2 })
        viewer.awake(true)
        const woken = ready()
        expect(woken).not.toBe(first)
        woken.dispatchEvent(event("did-start-loading"))
        woken.dispatchEvent(event("did-navigate"))
        woken.dispatchEvent(
          event("console-message", {
            level: 3,
            message: "boom",
            line: 1,
            sourceId: `${origin}/a.js`,
          }),
        )
        expect(shows).toEqual([2])
        viewer.destroy()
      })
    })

    context("with a cap on each document", () => {
      it("reports at most 20 troubles of any kind, and more for the next document", () => {
        const t = troubled()
        for (let each = 0; each < 50; each += 1) t.log({ message: `again ${each}` })
        t.failed()
        expect(t.troubles).toHaveLength(20)
        t.page.dispatchEvent(event("did-navigate"))
        t.log()
        expect(t.troubles).toHaveLength(21)
      })

      it("holds when the document's own failure is told and more is logged after it", () => {
        const t = troubled()
        t.page.dispatchEvent(event("did-start-loading"))
        t.page.dispatchEvent(event("did-navigate"))
        for (let each = 0; each < 20; each += 1) t.log()
        t.failed({ url: `${origin}/`, status: 404, what: "page" })
        t.page.dispatchEvent(event("did-stop-loading"))
        for (let each = 0; each < 30; each += 1) t.log()
        expect(t.troubles).toHaveLength(20)
      })

      it("counts a failure of the page from before it committed in its own document", () => {
        const t = troubled()
        for (let each = 0; each < 20; each += 1) t.log()
        t.page.dispatchEvent(event("did-start-loading"))
        t.failed({ url: `${origin}/`, status: 404, what: "page" })
        t.page.dispatchEvent(event("did-navigate"))
        expect(t.troubles).toHaveLength(21)
        expect(t.troubles.at(-1)).toMatchObject({ kind: "request", what: "page" })
      })
    })

    context("with the show the document carries", () => {
      it("tells the show of the document, not of one still loading", () => {
        const t = troubled({ url: `${origin}/`, shown: 1 })
        t.page.dispatchEvent(event("did-navigate"))
        t.page.dispatchEvent(event("did-stop-loading"))
        t.log()
        // Shown again once loaded: it loads again, and the old document logs till then.
        t.viewer.update({ url: `${origin}/`, shown: 2 })
        t.log()
        t.page.dispatchEvent(event("did-navigate"))
        t.log()
        expect(t.shows).toEqual([1, 1, 2])
      })
    })

    it("reports nothing from a snapshot", () => {
      const host = hostIn()
      const troubles: Trouble[] = []
      mountBrowser(host, {
        content: { url: "https://example.com/" },
        label: "page",
        live: false,
        partition: "pages",
        on: { trouble: (trouble) => troubles.push(trouble) },
      })
      expect(host.querySelector("webview")).toBeNull()
      expect(troubles).toEqual([])
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
