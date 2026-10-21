import { EventEmitter } from "node:events"

import type { Session, WebContents, WebPreferences } from "electron"
import { describe, expect, it, vi } from "vitest"

import {
  attachPage,
  gestureMs,
  guardPage,
  lockPagesSession,
  pagesSession,
  pictureQuality,
  picturePage,
  pictureWaitMs,
  webAddress,
} from "./browser-host.js"

const pagesPartition = "pages"

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
    expect(attachPage(preferences, params, pagesPartition)).toBe(true)
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
    expect(attachPage({}, { src: "file:///etc/passwd" }, pagesPartition)).toBe(false)
    expect(attachPage({}, {}, pagesPartition)).toBe(false)
  })

  it("is refused for a session that isn't in memory and apart from the app's", () => {
    for (const partition of ["", "persist:", `persist:${pagesPartition}`]) {
      const preferences: WebPreferences = { nodeIntegration: true }
      expect(attachPage(preferences, { src: "https://example.com" }, partition)).toBe(false)
      // Locked down all the same, whatever the host makes of the refusal.
      expect(preferences.nodeIntegration).toBe(false)
    }
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
    const asked: string[] = []
    lockPagesSession((partition) => {
      asked.push(partition)
      return session as unknown as Session
    }, pagesPartition)
    expect(asked).toEqual([pagesPartition])
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

describe("the pages' session's name", () => {
  it("is refused when it would be the app's session, or kept on disk", () => {
    expect(pagesSession(pagesPartition)).toBe(pagesPartition)
    for (const partition of ["", "persist:", `persist:${pagesPartition}`])
      expect(() => pagesSession(partition)).toThrow("must be in memory")
    expect(() => lockPagesSession(() => ({}) as Session, "")).toThrow("must be in memory")
  })
})

describe("a picture of a page", () => {
  const host = {} as WebContents
  // A page view of `owner`, which draws `drawn` (nothing when empty).
  const view = ({
    owner = host,
    type = "webview",
    drawn = "jpeg",
    destroyed = false,
  }: {
    owner?: WebContents
    type?: string
    drawn?: string
    destroyed?: boolean
  } = {}) => {
    const qualities: number[] = []
    const contents = {
      hostWebContents: owner,
      getType: () => type,
      isDestroyed: () => destroyed,
      capturePage: async () => ({
        isEmpty: () => drawn === "",
        toJPEG: (quality: number) => {
          qualities.push(quality)
          return Buffer.from(drawn)
        },
      }),
    } as unknown as WebContents
    return { contents, qualities }
  }
  const byId =
    (contents: WebContents) =>
    (id: number): WebContents | undefined =>
      id === 7 ? contents : undefined

  it("is the JPEG of what a page view of the asking page shows", async () => {
    const { contents, qualities } = view()
    expect(await picturePage(host, 7, byId(contents))).toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
    )
    expect(qualities).toEqual([pictureQuality])
  })

  it("is nothing for another window's page, the app's own, or one gone", async () => {
    const others = [
      view({ owner: {} as WebContents }).contents,
      view({ type: "window" }).contents,
      view({ destroyed: true }).contents,
    ].map((contents) => picturePage(host, 7, byId(contents)))
    const ids = [8, "7", 7.5, undefined].map((id) => picturePage(host, id, byId(view().contents)))
    expect(await Promise.all([...others, ...ids])).toEqual(Array(7).fill(undefined))
  })

  it("is nothing once it has waited a while for a page out of sight", async () => {
    vi.useFakeTimers()
    try {
      const never = {
        ...view().contents,
        hostWebContents: host,
        getType: () => "webview",
        isDestroyed: () => false,
        capturePage: () => new Promise(() => {}),
      } as unknown as WebContents
      const picture = picturePage(host, 7, byId(never))
      await vi.advanceTimersByTimeAsync(pictureWaitMs)
      expect(await picture).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("is nothing while the page draws nothing, or can't be taken", async () => {
    expect(await picturePage(host, 7, byId(view({ drawn: "" }).contents))).toBeUndefined()
    const failing = {
      ...view().contents,
      hostWebContents: host,
      getType: () => "webview",
      isDestroyed: () => false,
      capturePage: () => Promise.reject(new Error("gone")),
    } as unknown as WebContents
    expect(await picturePage(host, 7, byId(failing))).toBeUndefined()
  })
})
