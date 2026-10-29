import { EventEmitter } from "node:events"

import type { SelectWebauthnAccountDetails, Session, WebContents, WebPreferences } from "electron"
import { describe, expect, it, vi } from "vitest"

import {
  attachPage,
  gestureMs,
  guardPage,
  lockPagesSession,
  maxForwardedRequests,
  pagesSession,
  countSignIns,
  holdPhoneLoads,
  passkeyLabels,
  pickPasskeys,
  phonePage,
  phoneWaitMs,
  pictureQuality,
  picturePage,
  pictureWaitMs,
  signInTitle,
  signInWindow,
  watchPageRequests,
  webAddress,
} from "./browser-host.js"
import { chromeMajorOf, phoneUserAgent } from "./browser-phone.js"

const pagesPartition = "persist:pages"
const context = describe

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
      transparent: false,
      partition: pagesPartition,
    })
  })

  it("paints its own ground, as a browser does, whatever it asked", () => {
    const preferences: WebPreferences = { transparent: true }
    attachPage(preferences, { src: "https://example.com" }, pagesPartition)
    expect(preferences.transparent).toBe(false)
  })

  it("may be a phone's, named by the phone's user agent, and be told nothing else it runs on", () => {
    const phone = phoneUserAgent(chromeMajorOf(`Chrome/${process.versions.chrome ?? "0"}`))
    expect(attachPage({}, { src: "https://example.com", useragent: phone }, pagesPartition)).toBe(
      true,
    )
    expect(
      attachPage({}, { src: "https://example.com", useragent: "Googlebot/2.1" }, pagesPartition),
    ).toBe(false)
  })

  it("is refused for anything but an http(s) address", () => {
    expect(attachPage({}, { src: "file:///etc/passwd" }, pagesPartition)).toBe(false)
    expect(attachPage({}, {}, pagesPartition)).toBe(false)
  })

  it("is refused for a session that isn't kept on disk and apart from the app's", () => {
    for (const partition of ["", "persist:", "pages"]) {
      const preferences: WebPreferences = { nodeIntegration: true }
      expect(attachPage(preferences, { src: "https://example.com" }, partition)).toBe(false)
      // Locked down all the same, whatever the host makes of the refusal.
      expect(preferences.nodeIntegration).toBe(false)
    }
  })
})

// What a page asks for as it opens a window: a link to a new tab names no features.
type Opening = { url: string; features?: string; disposition?: string }

// A page view's WebContents as the guard sees it.
class FakeContents extends EventEmitter {
  opener?: (details: Required<Opening>) => { action: string }
  setWindowOpenHandler(handler: (details: Required<Opening>) => { action: string }): void {
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
      pagesPartition,
      () => time,
    )
    return {
      contents,
      opened,
      open: (url: string, how: Omit<Opening, "url"> = {}) =>
        contents.opener?.({ url, features: "", disposition: "foreground-tab", ...how }),
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
    guardPage(contents as unknown as WebContents, () => {}, pagesPartition)
    expect(navigates(contents, "will-navigate", "http://localhost:5173/next")).toBe(true)
    expect(navigates(contents, "will-navigate", "file:///etc/passwd")).toBe(false)
    expect(navigates(contents, "will-redirect", "https://example.com/")).toBe(true)
    expect(navigates(contents, "will-redirect", "javascript:alert(1)")).toBe(false)
  })

  context("when it opens a sized popup, as a sign-in does", () => {
    const popup = { features: "width=500,height=600", disposition: "new-window" }

    it("opens it in a window of the app on the pages' session, right after a click", () => {
      const page = guarded()
      page.input("mouseUp")
      expect(page.open("https://accounts.example.com/sign-in", popup)).toEqual({
        action: "allow",
        overrideBrowserWindowOptions: signInWindow(pagesPartition),
      })
      expect(signInWindow(pagesPartition).webPreferences).toEqual({
        partition: pagesPartition,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      })
      // Nothing the page named can hide it, cover others or pass it off as the app's.
      expect(signInWindow(pagesPartition)).toMatchObject({
        x: undefined,
        y: undefined,
        show: true,
        frame: true,
        transparent: false,
        opacity: 1,
        focusable: true,
        alwaysOnTop: false,
        skipTaskbar: false,
        fullscreen: false,
        simpleFullscreen: false,
        enableLargerThanScreen: false,
        hiddenInMissionControl: false,
        type: undefined,
        vibrancy: undefined,
        backgroundMaterial: undefined,
        kiosk: false,
        closable: true,
        title: "",
        minWidth: 360,
        minHeight: 300,
        maxWidth: undefined,
        maxHeight: undefined,
        useContentSize: false,
      })
      // One window for the click, wherever it opened.
      expect(page.open("https://accounts.example.com/again", popup)).toEqual({ action: "deny" })
      expect(page.opened).toEqual([])
    })

    it("opens nothing on its own", () => {
      const page = guarded()
      expect(page.open("https://accounts.example.com/sign-in", popup)).toEqual({ action: "deny" })
    })

    it("sends a link to a new tab, or one opened with Shift, to the browser", () => {
      const page = guarded()
      page.input("mouseUp")
      page.open("https://example.com/tab")
      page.input("mouseUp")
      page.open("https://example.com/shift", { disposition: "new-window" })
      expect(page.opened).toEqual(["https://example.com/tab", "https://example.com/shift"])
    })

    // A sign-in window, as Electron makes it, at `url` with the page's own title.
    const signInAt = (url: string, title: string) => {
      const webContents = Object.assign(new FakeContents(), {
        getURL: () => url,
        getTitle: () => title,
      })
      const titles: string[] = []
      const window = Object.assign(new EventEmitter(), {
        webContents,
        isDestroyed: () => false,
        setTitle: (next: string) => titles.push(next),
      })
      return { window, webContents, titles }
    }

    it("names the window it opened by its site, then the page's title", () => {
      const page = guarded()
      const { window, webContents, titles } = signInAt("https://accounts.example.com/o", "Sign in")
      page.contents.emit("did-create-window", window)
      let prevented = false
      window.emit("page-title-updated", { preventDefault: () => (prevented = true) }, "Novadeck")
      webContents.emit("did-navigate")
      expect(prevented).toBe(true)
      expect(titles).toEqual(["accounts.example.com — Sign in", "accounts.example.com — Sign in"])
      expect(signInTitle("https://github.com/login", " ")).toBe("github.com")
      expect(signInTitle("about:blank", "Novadeck")).toBe("Novadeck")
    })

    it("guards the window it opened as it guards the page", () => {
      const page = guarded()
      const { window, webContents } = signInAt("https://accounts.example.com/", "")
      page.contents.emit("did-create-window", window)
      expect(navigates(webContents, "will-navigate", "file:///etc/passwd")).toBe(false)
      expect(
        webContents.opener?.({
          url: "https://example.com/",
          features: "",
          disposition: "foreground-tab",
        }),
      ).toEqual({ action: "deny" })
    })
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
  it("is refused when it would be the app's session, or forget sign-ins at a restart", () => {
    expect(pagesSession(pagesPartition)).toBe(pagesPartition)
    for (const partition of ["", "persist:", "pages"])
      expect(() => pagesSession(partition)).toThrow("must be kept on disk")
    expect(() => lockPagesSession(() => ({}) as Session, "")).toThrow("must be kept on disk")
    expect(() => signInWindow("pages")).toThrow("must be kept on disk")
  })
})

describe("a page signing in with a passkey it doesn't name", () => {
  // The pages' session, and what each request was answered with.
  const picking = (
    pick: (details: SelectWebauthnAccountDetails) => Promise<string | undefined>,
  ) => {
    const pages = new EventEmitter()
    pickPasskeys(pages as unknown as Session, pick)
    return async (credentialIds: readonly string[]): Promise<string | undefined> => {
      const accounts = credentialIds.map((credentialId) => ({ credentialId, userHandle: "" }))
      const answer = new Promise<string | undefined>((resolve) =>
        pages.emit(
          "select-webauthn-account",
          {},
          { relyingPartyId: "github.com", accounts },
          resolve,
        ),
      )
      return answer
    }
  }

  it("signs in with the only passkey that fits, without asking", async () => {
    const pick = vi.fn<() => Promise<string | undefined>>(async () => undefined)
    await expect(picking(pick)(["a"])).resolves.toBe("a")
    expect(pick).not.toHaveBeenCalled()
  })

  it("asks the person which, when more than one fits", async () => {
    await expect(
      picking(async ({ accounts }) => accounts[1]?.credentialId)(["a", "b"]),
    ).resolves.toBe("b")
  })

  it("cancels when the person cancels, names another passkey, or the question fails", async () => {
    await expect(picking(async () => undefined)(["a", "b"])).resolves.toBeUndefined()
    await expect(picking(async () => "c")(["a", "b"])).resolves.toBeUndefined()
    await expect(
      picking(() => Promise.reject(new Error("gone")))(["a", "b"]),
    ).resolves.toBeUndefined()
  })

  it("cancels when the question throws before it starts", async () => {
    await expect(
      picking(() => {
        throw new Error("no window")
      })(["a", "b"]),
    ).resolves.toBeUndefined()
  })

  it("names each passkey by its name, else its display name, telling alike ones apart", () => {
    expect(
      passkeyLabels([
        { credentialId: "a", name: "moth@example.com", displayName: "Moth" },
        { credentialId: "b", displayName: "Moth" },
        { credentialId: "c" },
        { credentialId: "dddddddd-1", name: "work" },
        { credentialId: "eeeeeeee-2", name: "work" },
      ]),
    ).toEqual(["moth@example.com", "Moth", "Passkey", "work (dddddddd)", "work (eeeeeeee)"])
  })
})

describe("a page view's sign-in windows", () => {
  it("are counted as each opens and closes", () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false })
    const counts: number[] = []
    countSignIns(contents as unknown as WebContents, (open) => counts.push(open))
    const first = new EventEmitter()
    const second = new EventEmitter()
    contents.emit("did-create-window", first)
    contents.emit("did-create-window", second)
    first.emit("closed")
    second.emit("closed")
    expect(counts).toEqual([1, 2, 1, 0])
  })

  it("tell nothing as they close after their view went", () => {
    let gone = false
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => gone })
    const counts: number[] = []
    countSignIns(contents as unknown as WebContents, (open) => counts.push(open))
    const window = new EventEmitter()
    contents.emit("did-create-window", window)
    gone = true
    expect(() => window.emit("closed")).not.toThrow()
    expect(counts).toEqual([1])
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
    const resized: number[] = []
    const image = (width: number, jpeg: string) => ({
      isEmpty: () => drawn === "",
      getSize: () => ({ width, height: width * 2 }),
      resize: (options: { width: number }) => {
        resized.push(options.width)
        return image(options.width, `${jpeg} at ${options.width}`)
      },
      toJPEG: (quality: number) => {
        qualities.push(quality)
        return Buffer.from(jpeg)
      },
    })
    const contents = {
      hostWebContents: owner,
      getType: () => type,
      isDestroyed: () => destroyed,
      capturePage: async () => image(2560, drawn),
    } as unknown as WebContents
    return { contents, qualities, resized }
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

  it("is scaled down to the width it's drawn at, where it's wider, as a page fit to its viewer", async () => {
    const { contents, resized } = view()
    expect(await picturePage(host, 7, byId(contents), 800)).toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg at 800").toString("base64")}`,
    )
    // As wide or wider, or no width a picture can be: as it is.
    const widths = [2560, 4000, 0, -5, 1.5, "800", undefined]
    expect(
      await Promise.all(widths.map((width) => picturePage(host, 7, byId(contents), width))),
    ).toEqual(widths.map(() => `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`))
    expect(resized).toEqual([800])
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

describe("a page view as a phone's", () => {
  const phone = phoneUserAgent(chromeMajorOf(`Chrome/${process.versions.chrome ?? "0"}`))
  const host = {} as WebContents
  // A page view of `owner`, its DevTools protocol recording what it's sent.
  const view = ({
    owner = host,
    agent = "Desktop/1",
    answers = true as boolean | "rejects",
  } = {}) => {
    const sent: string[] = []
    let attachedNow = false
    let userAgent = agent
    const contents = {
      hostWebContents: owner,
      getType: () => "webview",
      isDestroyed: () => false,
      session: { getUserAgent: () => "Desktop/1" },
      getUserAgent: () => userAgent,
      setUserAgent: (next: string) => {
        sent.push(`agent ${next === phone ? "phone" : next}`)
        userAgent = next
      },
      debugger: {
        isAttached: () => attachedNow,
        attach: () => {
          sent.push("attach")
          attachedNow = true
        },
        detach: () => {
          sent.push("detach")
          attachedNow = false
        },
        sendCommand: (method: string) => {
          sent.push(method)
          if (answers === "rejects") return Promise.reject(new Error("No target"))
          return answers ? Promise.resolve({}) : new Promise(() => {})
        },
      },
    } as unknown as WebContents
    return { contents, sent }
  }
  const byId =
    (contents: WebContents) =>
    (id: number): WebContents | undefined =>
      id === 7 ? contents : undefined

  it("acts as one, touched, with a phone's screen and browser, and as itself again", async () => {
    const { contents, sent } = view()
    expect(await phonePage(host, 7, true, byId(contents))).toBe(true)
    expect(sent).toEqual([
      "attach",
      "agent phone",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setEmitTouchEventsForMouse",
      "Emulation.setUserAgentOverride",
    ])
    sent.splice(0)
    // Letting the protocol go undoes all it set.
    expect(await phonePage(host, 7, false, byId(contents))).toBe(true)
    expect(sent).toEqual(["detach", "agent Desktop/1"])
  })

  it("is left as itself, not half a phone, where it can't be made one", async () => {
    const { contents, sent } = view({ answers: "rejects" })
    expect(await phonePage(host, 7, true, byId(contents))).toBe(false)
    expect(sent.slice(-2)).toEqual(["detach", "agent Desktop/1"])
    expect(contents.getUserAgent()).toBe("Desktop/1")
  })

  it("is nothing for another window's page, the app's own, or an id that's no view's", async () => {
    const other = view({ owner: {} as WebContents })
    expect(await phonePage(host, 7, true, byId(other.contents))).toBe(false)
    const ids = [8, "7", 7.5]
    expect(
      await Promise.all(ids.map((id) => phonePage(host, id, true, byId(view().contents)))),
    ).toEqual(ids.map(() => false))
    expect(other.sent).toEqual([])
  })

  context("loading", () => {
    type Details = { resourceType: string; webContentsId?: number }
    const held = (contents: WebContents) => {
      let before: ((details: Details, callback: (response: object) => void) => void) | undefined
      let filter: unknown
      holdPhoneLoads(
        {
          webRequest: {
            onBeforeRequest: (only: unknown, listener: typeof before) => {
              filter = only
              before = listener
            },
          },
        } as unknown as Session,
        byId(contents),
      )
      const load = (details: Details): Promise<void> =>
        new Promise((resolve) => before?.(details, () => resolve()))
      return Object.assign(load, { filter: () => filter })
    }

    it("holds a phone's first page load until it acts as one, and nothing else", async () => {
      const { contents, sent } = view({ agent: phone })
      const load = held(contents)
      // Only page loads come to it, not what they load.
      expect(load.filter()).toEqual({ urls: ["<all_urls>"], types: ["mainFrame"] })
      await load({ resourceType: "mainFrame", webContentsId: 7 })
      expect(sent).toContain("Emulation.setTouchEmulationEnabled")
      sent.splice(0)
      // Already one, its next loads go at once; as do another's, and what isn't a page.
      await load({ resourceType: "mainFrame", webContentsId: 7 })
      await load({ resourceType: "script", webContentsId: 7 })
      await load({ resourceType: "mainFrame", webContentsId: 9 })
      expect(sent).toEqual([])
      const desktop = view()
      await held(desktop.contents)({ resourceType: "mainFrame", webContentsId: 7 })
      expect(desktop.sent).toEqual([])
    })

    it("loads it as it is once it has waited a while for a protocol that doesn't answer", async () => {
      vi.useFakeTimers()
      try {
        const { contents } = view({ agent: phone, answers: false })
        let loaded = false
        void held(contents)({ resourceType: "mainFrame", webContentsId: 7 }).then(
          () => (loaded = true),
        )
        await vi.advanceTimersByTimeAsync(phoneWaitMs - 1)
        expect(loaded).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(loaded).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
