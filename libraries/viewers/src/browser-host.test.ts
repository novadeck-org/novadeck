import { EventEmitter } from "node:events"

import type { Session, WebContents, WebPreferences } from "electron"
import { describe, expect, it, vi } from "vitest"

import {
  attachPage,
  gestureMs,
  guardPage,
  lockPagesSession,
  maxForwardedRequests,
  pagesSession,
  pictureQuality,
  picturePage,
  pictureWaitMs,
  watchPageRequests,
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

describe("the requests of a page view that fail", () => {
  type Details = { url: string; resourceType: string; webContentsId?: number | undefined }
  const watched = () => {
    let completed: ((details: Details & { statusCode: number }) => void) | undefined
    let errored: ((details: Details & { error: string }) => void) | undefined
    const told: [number, unknown][] = []
    const watching = watchPageRequests(
      {
        webRequest: {
          onCompleted: (listener: typeof completed) => (completed = listener),
          onErrorOccurred: (listener: typeof errored) => (errored = listener),
        },
      } as unknown as Session,
      (contentsId, failure) => told.push([contentsId, failure]),
    )
    return {
      told,
      forget: watching.forget,
      completed: (statusCode: number, rest: Partial<Details> = {}) =>
        completed?.({
          url: "http://localhost/a",
          resourceType: "script",
          webContentsId: 3,
          statusCode,
          ...rest,
        }),
      errored: (error: string, rest: Partial<Details> = {}) =>
        errored?.({
          url: "http://localhost/a",
          resourceType: "script",
          webContentsId: 3,
          error,
          ...rest,
        }),
    }
  }

  it("are those answered with an HTTP error, and only those", () => {
    const { told, completed } = watched()
    for (const status of [200, 204, 301, 304, 399]) completed(status)
    expect(told).toEqual([])
    completed(400)
    completed(404)
    completed(503)
    expect(told.map(([, failure]) => (failure as { status: number }).status)).toEqual([
      400, 404, 503,
    ])
    expect(told[0]).toEqual([3, { url: "http://localhost/a", status: 400, what: "script" }])
  })

  it("include those that got no answer, but not those cancelled", () => {
    const { told, errored } = watched()
    errored("net::ERR_ABORTED")
    expect(told).toEqual([])
    errored("net::ERR_CONNECTION_REFUSED")
    expect(told).toEqual([[3, { url: "http://localhost/a", status: 0, what: "script" }]])
  })

  it("are named as a viewer names them", () => {
    const { told, completed } = watched()
    const kinds = ["mainFrame", "subFrame", "xhr", "script", "image", "stylesheet", "font", "media"]
    for (const resourceType of kinds) completed(404, { resourceType })
    expect(told.map(([, failure]) => (failure as { what: string }).what)).toEqual([
      "page",
      "frame",
      "fetch",
      "script",
      "image",
      "stylesheet",
      "font",
      "media",
    ])
  })

  it("are told up to a bound for each navigation of a page view, and each view has its own", () => {
    const { told, completed, errored } = watched()
    for (let each = 0; each < maxForwardedRequests + 10; each += 1) completed(500)
    expect(told).toHaveLength(maxForwardedRequests)
    completed(500, { webContentsId: 4 })
    expect(told).toHaveLength(maxForwardedRequests + 1)
    // The page view goes to a document, which ends well or not.
    completed(200, { resourceType: "mainFrame" })
    completed(500)
    expect(told).toHaveLength(maxForwardedRequests + 2)
    errored("net::ERR_CONNECTION_REFUSED", { resourceType: "mainFrame" })
    completed(500)
    expect(told).toHaveLength(maxForwardedRequests + 4)
  })

  it("are bound for each origin, so another site's failures leave the page's own their room", () => {
    const { told, completed, errored } = watched()
    for (let each = 0; each < maxForwardedRequests + 10; each += 1)
      completed(500, { url: "https://beacon.example/hit" })
    expect(told).toHaveLength(maxForwardedRequests)
    completed(404)
    expect(told).toHaveLength(maxForwardedRequests + 1)
    // What isn't a web page's address shares one bound, however many such addresses fail.
    for (let each = 0; each < maxForwardedRequests + 10; each += 1)
      errored("net::ERR_FAILED", { url: `ws://localhost/socket-${each}` })
    expect(told).toHaveLength(2 * maxForwardedRequests + 1)
  })

  it("forget a page view once it's gone, as a rest of its page drops it", () => {
    const { told, completed, forget } = watched()
    for (let each = 0; each < maxForwardedRequests; each += 1) completed(500)
    completed(500)
    expect(told).toHaveLength(maxForwardedRequests)
    forget(3)
    completed(500)
    expect(told).toHaveLength(maxForwardedRequests + 1)
  })

  it("are left out when no page view made them", () => {
    const { told, completed, errored } = watched()
    completed(404, { webContentsId: undefined })
    errored("net::ERR_FAILED", { webContentsId: undefined })
    expect(told).toEqual([])
  })
})
