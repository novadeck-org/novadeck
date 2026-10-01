import { EventEmitter } from "node:events"

import type { Session, WebContents, WebPreferences } from "electron"

import { describe, expect, it } from "../test"
import {
  attachPage,
  gestureMs,
  guardPage,
  lockPagesSession,
  pagesPartition,
  webAddress,
} from "./pages"

describe("a live page's address", () => {
  it("is http or https only", () => {
    expect(webAddress("http://localhost:5173/")).toBe(true)
    expect(webAddress("https://example.com")).toBe(true)
    for (const other of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "chrome://gpu",
      "not an address",
      "",
    ])
      expect(webAddress(other)).toBe(false)
  })
})

describe("a page view as it attaches", () => {
  it("gets no preload or Node, a sandbox and the pages' own session, whatever it asked", () => {
    const preferences: WebPreferences = {
      preload: "/evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
    }
    const params = { src: "http://localhost:5173/" }
    expect(attachPage(preferences, params)).toBe(true)
    expect(preferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      partition: pagesPartition,
    })
  })

  it("is refused for anything but an http(s) address", () => {
    expect(attachPage({}, { src: "file:///etc/passwd" })).toBe(false)
    expect(attachPage({}, {})).toBe(false)
  })
})

// A page view's WebContents as the guard sees it.
class FakeContents extends EventEmitter {
  opener?: (details: { url: string }) => { action: string }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.opener = handler
  }
}

// Whether a navigation of the page view to `url` goes ahead.
const navigates = (contents: FakeContents, event: string, url: string): boolean => {
  let prevented = false
  contents.emit(event, { preventDefault: () => (prevented = true) }, url)
  return !prevented
}

describe("a page view", () => {
  // A guarded page view, on a clock the test sets.
  const guarded = () => {
    const contents = new FakeContents()
    const opened: string[] = []
    let time = 10_000
    guardPage(
      contents as unknown as WebContents,
      (url) => opened.push(url),
      () => time,
    )
    return {
      opened,
      open: (url: string) => contents.opener?.({ url }),
      input: (type: string, isAutoRepeat = false) =>
        contents.emit("input-event", {}, { type, isAutoRepeat }),
      wait: (ms: number) => (time += ms),
    }
  }

  it("opens no window by itself, not even in the person's browser", () => {
    const page = guarded()
    for (let i = 0; i < 5; i++)
      expect(page.open("https://example.com/")).toEqual({ action: "deny" })
    page.input("mouseMove")
    page.open("https://example.com/")
    expect(page.opened).toEqual([])
  })

  it("opens one http(s) window in the browser for each click or key, right after it", () => {
    const page = guarded()
    page.input("mouseDown")
    expect(page.open("https://example.com/one")).toEqual({ action: "deny" })
    page.open("https://example.com/again")
    page.input("keyDown")
    page.open("file:///etc/passwd")
    // A refused address doesn't use up the key.
    page.open("https://example.com/two")
    page.input("mouseDown")
    page.wait(gestureMs + 1)
    page.open("https://example.com/late")
    expect(page.opened).toEqual(["https://example.com/one", "https://example.com/two"])
  })

  it("counts a click's release, as a link opens then, but not a held key's repeats", () => {
    const page = guarded()
    page.input("mouseDown")
    page.wait(gestureMs + 300)
    page.input("mouseUp")
    page.open("https://example.com/long-press")
    page.input("rawKeyDown")
    page.open("https://example.com/key")
    page.input("rawKeyDown", true)
    page.open("https://example.com/repeat")
    expect(page.opened).toEqual(["https://example.com/long-press", "https://example.com/key"])
  })

  it("goes only to http(s) addresses, by a link or a redirect", () => {
    const contents = new FakeContents()
    guardPage(contents as unknown as WebContents, () => {})
    expect(navigates(contents, "will-navigate", "http://localhost:5173/next")).toBe(true)
    expect(navigates(contents, "will-navigate", "file:///etc/passwd")).toBe(false)
    expect(navigates(contents, "will-redirect", "https://example.com/")).toBe(true)
    expect(navigates(contents, "will-redirect", "javascript:alert(1)")).toBe(false)
  })
})

describe("the pages' session", () => {
  it("refuses every permission, every download and every file", async () => {
    const session = Object.assign(new EventEmitter(), {
      schemes: new Map<string, () => Response>(),
      protocol: {
        handle: (scheme: string, handler: () => Response) => session.schemes.set(scheme, handler),
      },
      check: undefined as undefined | (() => boolean),
      request: undefined as undefined | ((c: unknown, p: string, r: (ok: boolean) => void) => void),
      device: undefined as undefined | (() => boolean),
      setPermissionCheckHandler(handler: () => boolean) {
        this.check = handler
      },
      setPermissionRequestHandler(
        handler: (c: unknown, p: string, r: (ok: boolean) => void) => void,
      ) {
        this.request = handler
      },
      setDevicePermissionHandler(handler: () => boolean) {
        this.device = handler
      },
    })
    lockPagesSession(session as unknown as Session)
    expect(session.check?.()).toBe(false)
    expect(session.device?.()).toBe(false)
    let granted: boolean | undefined
    session.request?.(undefined, "media", (ok) => (granted = ok))
    expect(granted).toBe(false)
    let prevented = false
    session.emit("will-download", { preventDefault: () => (prevented = true) })
    expect(prevented).toBe(true)
    const file = session.schemes.get("file")?.()
    expect(file?.status).toBe(403)
    await expect(file?.text()).resolves.toBe("")
  })
})
