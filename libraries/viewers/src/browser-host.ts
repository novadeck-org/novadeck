import type {
  BrowserWindowConstructorOptions,
  HandlerDetails,
  SelectWebauthnAccountDetails,
  Session,
  WebContents,
  WebPreferences,
  WindowOpenHandlerResponse,
} from "electron"

import { webAddress } from "./address.js"
import { chromeMajorOf, phoneEmulation, phoneUserAgent } from "./browser-phone.js"
import { originOf, type PageRequestFailure } from "./browser-trouble.js"

export { webAddress } from "./address.js"

// The browser viewer's lockdown, in Electron's main process. Live pages load in a
// <webview>: a browser view apart from the app's own page. Whatever the element asks for,
// each gets no preload, no Node, a sandbox, and the pages' session, kept on disk so a
// person signed in to a site stays signed in, in every page view and after a restart,
// and where every permission and download is refused and no file loads. It goes only to
// http(s) addresses by its own links and redirects. A window it opens right after the
// person clicked or typed in it opens in their own browser, one per click or key, or,
// when the page sized it as a popup, as a sign-in does, in a window of the app on the
// pages' session, so the sign-in lands there; any other opens nowhere. Nothing here can
// loosen that: the options only name the session.

/**
 * The pages' session's name, checked: one that names a session of its own, kept on disk,
 * apart from the app's. An empty name is the app's own session, and one without
 * `persist:` forgets every sign-in at a restart, so either is refused.
 */
export const pagesSession = (partition: string): string => {
  if (!kept(partition))
    throw new Error(`The pages' session must be kept on disk and named: "${partition}" isn't.`)
  return partition
}

const kept = (partition: string): boolean => /^persist:./.test(partition)

/**
 * Settles a page view's settings as it attaches, from `will-attach-webview`; false when
 * it must not attach, as for anything but an http(s) address. Only `preferences` take
 * effect here: Electron has read the element's attributes into them already, and
 * ignores changes to `params`. So `allowpopups`, which lets a page's new windows reach
 * `guardPage`'s handler, is the element's to set.
 */
export const attachPage = (
  preferences: WebPreferences,
  params: { readonly src?: string; readonly useragent?: string },
  // The pages' session, named as the viewer's `partition` names it (see `pagesSession`).
  partition: string,
): boolean => {
  delete preferences.preload
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.nodeIntegrationInWorker = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webSecurity = true
  preferences.allowRunningInsecureContent = false
  preferences.webviewTag = false
  // A page with no background of its own gets the ground a browser gives it, white or its
  // scheme's dark, not whatever the viewer draws behind it.
  preferences.transparent = false
  // A session that isn't the pages' own refuses the view, never throws past the host's
  // handler, which would let the view attach as it asked.
  if (!kept(partition)) return false
  preferences.partition = partition
  // A view may name itself a phone's, by the user agent its viewer gives one, and be told
  // nothing else it runs on.
  if (params.useragent && params.useragent !== phoneAgent()) return false
  return webAddress(params.src ?? "")
}

// The Chromium the app runs, which a phone's page view is told it runs too; none outside
// Electron, as in a test.
const chromeVersion = (): string => process.versions.chrome ?? "0"
const phoneAgent = (): string => phoneUserAgent(chromeMajorOf(`Chrome/${chromeVersion()}`))

/** How long a phone's page view's first load waits for it to act as a phone's, at most. */
export const phoneWaitMs = 2_000

// The page views acting as a phone's.
const phones = new WeakSet<WebContents>()

// A page view as itself: the protocol let go, which undoes all it set, and the session's
// user agent back.
const unemulate = (page: WebContents): void => {
  phones.delete(page)
  if (page.debugger.isAttached()) page.debugger.detach()
  page.setUserAgent(page.session.getUserAgent())
}

// Makes a page view act as a phone's, through the DevTools protocol, or as itself again;
// false when it can't. One it can't make a phone's is left as itself, not half a phone,
// so nothing takes it for one.
const emulate = async (page: WebContents, phone: boolean): Promise<boolean> => {
  try {
    if (!phone) {
      unemulate(page)
      return true
    }
    phones.add(page)
    if (!page.debugger.isAttached()) page.debugger.attach("1.3")
    page.setUserAgent(phoneAgent())
    await Promise.all(
      phoneEmulation(chromeVersion()).map(([method, params]) =>
        page.debugger.sendCommand(method, params),
      ),
    )
    return true
  } catch {
    try {
      if (!page.isDestroyed()) unemulate(page)
    } catch {
      // Gone as it was undone: nothing left of it.
    }
    return false
  }
}

// The page view `id`, as `host` asks for it: one of its own, and only a page view.
const pageViewOf = (
  host: WebContents,
  id: unknown,
  fromId: (id: number) => WebContents | undefined,
): WebContents | undefined => {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return undefined
  const page = fromId(id)
  return page &&
    !page.isDestroyed() &&
    page.getType() === "webview" &&
    page.hostWebContents === host
    ? page
    : undefined
}

/**
 * Makes the page view `id` act as a phone's, as its viewer shows it at a phone's size, or
 * as itself again: a phone's screen and layout, a pointer that touches, and a phone's
 * browser in its user agent and client hints. What it loads from then on is a phone's; a
 * document already loaded is told of its new screen and pointer, but not what it runs on,
 * so its viewer loads it again. False unless `id` is a page view of `host`, as for
 * `picturePage`, and when it can't.
 */
export const phonePage = async (
  host: WebContents,
  id: unknown,
  phone: unknown,
  fromId: (id: number) => WebContents | undefined,
): Promise<boolean> => {
  const page = pageViewOf(host, id, fromId)
  return page ? emulate(page, phone === true) : false
}

/**
 * Holds the first load of a page view its viewer named a phone's, by its user agent (see
 * `attachPage`), until it acts as one, so its first document is a phone's too; at most
 * `phoneWaitMs`, after which it loads as it is. Only page loads are held up, nothing they
 * load. Electron keeps one listener per request event for a session, so nothing else may
 * use `onBeforeRequest` on the pages' session.
 */
export const holdPhoneLoads = (
  pages: Session,
  fromId: (id: number) => WebContents | undefined,
): void => {
  pages.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"], types: ["mainFrame"] },
    (details, callback) => {
      const page =
        details.resourceType === "mainFrame" && details.webContentsId !== undefined
          ? fromId(details.webContentsId)
          : undefined
      if (
        !page ||
        page.isDestroyed() ||
        page.getType() !== "webview" ||
        phones.has(page) ||
        page.getUserAgent() !== phoneAgent()
      )
        return callback({})
      void within(emulate(page, true), phoneWaitMs).finally(() => callback({}))
    },
  )
}

type Opener = (url: string) => unknown

/**
 * The window a page's sign-in popup opens in: the app's, on the pages' session, with the
 * page view's lockdown and the size the page asked for. Electron gives it the opener, so
 * the sign-in can hand its answer back to the page that asked. Electron takes the rest of
 * a window's options from the features the page named too, so each that could hide the
 * window, cover others or pass it off as the app's is set here: shown, framed, opaque,
 * focusable, in the taskbar and not on top, where the system puts a new window, no smaller
 * than `signInMinimum` and free to resize, and named by its site (see `signInTitle`).
 */
export const signInWindow = (partition: string): BrowserWindowConstructorOptions => ({
  ...unplaced,
  // Never too small to see or use, nor held at a size the person can't change.
  minWidth: signInMinimum.width,
  minHeight: signInMinimum.height,
  useContentSize: false,
  show: true,
  frame: true,
  transparent: false,
  opacity: 1,
  focusable: true,
  alwaysOnTop: false,
  skipTaskbar: false,
  fullscreen: false,
  // macOS's own full screen, larger-than-screen windows and hiding from Mission Control.
  simpleFullscreen: false,
  enableLargerThanScreen: false,
  hiddenInMissionControl: false,
  hasShadow: true,
  thickFrame: true,
  kiosk: false,
  closable: true,
  movable: true,
  resizable: true,
  minimizable: true,
  maximizable: true,
  titleBarStyle: "default",
  title: "",
  autoHideMenuBar: true,
  webPreferences: {
    partition: pagesSession(partition),
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  },
})

/** The smallest a sign-in window gets, whatever size the page asks for. */
export const signInMinimum = { width: 360, height: 300 } as const

// No place and no largest size, rather than the page's, as off screen or 1×1: Electron's
// options can't say so in their type, which has no room for one set to nothing.
const unplaced = {
  x: undefined,
  y: undefined,
  maxWidth: undefined,
  maxHeight: undefined,
  // A plain window, not a panel, toolbar or desktop one, with nothing see-through behind it.
  type: undefined,
  vibrancy: undefined,
  backgroundMaterial: undefined,
} as unknown as BrowserWindowConstructorOptions

/**
 * A sign-in window's title: the site it is at, then the page's own title, so the person
 * sees where they sign in, as a browser's address bar would show them.
 */
export const signInTitle = (url: string, title: string): string => {
  const site = originOf(url) === null ? "" : new URL(url).host
  return [site, title.trim()].filter(Boolean).join(" — ")
}

// A popup the page asked for by its size or as a popup, as a sign-in opens; a link to a new
// tab, or one opened with Shift, names no features.
const sized = (details: Pick<HandlerDetails, "features" | "disposition">): boolean =>
  details.disposition === "new-window" && details.features !== ""

// How soon after the person's click or key a page's new window still counts as theirs.
// `allowpopups` lifts Chromium's own need for one, and the handler has no gesture flag.
export const gestureMs = 1_000
// A press or its release: a link opening a window follows the release, however long
// the press. A key held down counts once, not for each repeat.
const gestures = new Set([
  "mouseDown",
  "mouseUp",
  "keyDown",
  "rawKeyDown",
  "touchStart",
  "touchEnd",
])

/**
 * Keeps a page view to http(s) addresses by its own links and redirects, and lets a
 * window it opens through only right after the person's click or key, one each, so a page
 * can't open tabs on its own: a sized popup, as a sign-in's, in a window of the app on the
 * pages' session (see `signInWindow`), guarded the same way; anything else in the browser.
 * The handler isn't told which frame opened the window, so a frame from another site in
 * the page can take the click's one window.
 */
export const guardPage = (
  contents: WebContents,
  openExternal: Opener,
  partition: string,
  now: () => number = Date.now,
): void => {
  let gesture: number | undefined
  contents.on("input-event", (_event, input) => {
    // A key event marks a held key's repeats; others don't carry the flag.
    const repeat = "isAutoRepeat" in input && input.isAutoRepeat === true
    if (gestures.has(input.type) && !repeat) gesture = now()
  })
  contents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const theirs = gesture !== undefined && now() - gesture <= gestureMs
    if (!theirs || !webAddress(details.url)) return { action: "deny" }
    gesture = undefined
    if (sized(details))
      return { action: "allow", overrideBrowserWindowOptions: signInWindow(partition) }
    void openExternal(details.url)
    return { action: "deny" }
  })
  contents.on("did-create-window", (window) => {
    const titled = (): void => {
      if (!window.isDestroyed())
        window.setTitle(signInTitle(window.webContents.getURL(), window.webContents.getTitle()))
    }
    // The page names its window only after where it is.
    window.on("page-title-updated", (event) => {
      event.preventDefault()
      titled()
    })
    window.webContents.on("did-navigate", titled)
    window.webContents.on("did-navigate-in-page", titled)
    guardPage(window.webContents, openExternal, partition, now)
  })
  contents.on("will-navigate", (event, url) => {
    if (!webAddress(url)) event.preventDefault()
  })
  contents.on("will-redirect", (event, url) => {
    if (!webAddress(url)) event.preventDefault()
  })
}

// How a picture of a page is encoded: JPEG, which a page's text survives at this quality.
export const pictureQuality = 85
// How long a picture may take: one of a view out of sight never comes, as Chromium draws it
// no frame, and fails only half a minute later.
export const pictureWaitMs = 2_000

// What `promise` comes to within `ms`, else undefined, as when it fails.
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    const done = (value: T | undefined): void => {
      clearTimeout(timer)
      resolve(value)
    }
    promise.then(done, () => done(undefined))
  })

/**
 * A picture of what the page view `id` shows now, as a JPEG `data:` address, for the
 * viewer to show in its place while the page rests, scaled down to `width` pixels where
 * it's wider, as a page laid out wider than it's drawn is. Undefined unless `id` is a page
 * view of `host`, the app's page that asks, so a page can't be asked for another window's,
 * and when the page draws nothing yet. `fromId` is Electron's `webContents.fromId`.
 */
export const picturePage = async (
  host: WebContents,
  id: unknown,
  fromId: (id: number) => WebContents | undefined,
  width?: unknown,
): Promise<string | undefined> => {
  const page = pageViewOf(host, id, fromId)
  if (!page) return undefined
  const image = await within(page.capturePage(), pictureWaitMs)
  if (!image || image.isEmpty()) return undefined
  const narrower =
    typeof width === "number" && Number.isSafeInteger(width) && width > 0
      ? width < image.getSize().width
      : false
  const drawn = narrower ? image.resize({ width: width as number, quality: "good" }) : image
  return `data:image/jpeg;base64,${drawn.toJPEG(pictureQuality).toString("base64")}`
}

/**
 * Tells how many sign-in windows a page view has open as each opens or closes. Electron
 * closes them when the view goes, so its host keeps the view live while any is open. A
 * view gone first, its windows closing after it, has no one left to tell.
 */
export const countSignIns = (contents: WebContents, tell: (open: number) => void): void => {
  let open = 0
  contents.on("did-create-window", (window) => {
    tell(++open)
    window.once("closed", () => {
      open -= 1
      if (!contents.isDestroyed()) tell(open)
    })
  })
}

/**
 * What each passkey is called when the person picks one: its name, else its display name,
 * and where two would read alike, the start of its id too.
 */
export const passkeyLabels = (
  accounts: readonly { credentialId: string; name?: string; displayName?: string }[],
): string[] => {
  const labels = accounts.map((account) => account.name || account.displayName || "Passkey")
  return labels.map((label, index) =>
    labels.indexOf(label) === labels.lastIndexOf(label)
      ? label
      : `${label} (${accounts[index]!.credentialId.slice(0, 8)})`,
  )
}

/**
 * Has the person pick the passkey a page signs in with, when the page names none and more
 * than one fits; with one, it is that one. Electron cancels the sign-in unless someone
 * answers, so it answers each request once, cancelling when `pick` gives no account of
 * the request's or fails.
 */
export const pickPasskeys = (
  pages: Session,
  pick: (details: SelectWebauthnAccountDetails) => Promise<string | undefined>,
): void => {
  pages.on("select-webauthn-account", (_event, details, choose) => {
    const ids = details.accounts.map((account) => account.credentialId)
    void Promise.resolve()
      .then(() => (ids.length === 1 ? ids[0] : pick(details)))
      .then(
        (id) => choose(id !== undefined && ids.includes(id) ? id : undefined),
        () => choose(),
      )
      // Answered already, or the request is gone: nothing left to do.
      .catch(() => {})
  })
}

/**
 * Refuses the pages' session every permission, every download, and every file, which
 * the app's own page could otherwise point a view at. By its name, the one `attachPage`
 * gives pages, so the session locked is the one they load in; `fromPartition` is
 * Electron's `session.fromPartition`.
 */
export const lockPagesSession = (
  fromPartition: (partition: string) => Session,
  partition: string,
): void => {
  const pages = fromPartition(pagesSession(partition))
  pages.protocol.handle("file", () => new Response("", { status: 403 }))
  pages.setPermissionCheckHandler(() => false)
  pages.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  pages.setDevicePermissionHandler(() => false)
  pages.on("will-download", (event) => event.preventDefault())
}

// What the pages' session calls each kind of request, as a viewer names it: Electron
// reports fetch and XHR alike as `xhr`.
const requestKinds: Readonly<Record<string, string>> = {
  mainFrame: "page",
  subFrame: "frame",
  xhr: "fetch",
}

/** How many failures of one page view, from one origin, are told per navigation of its main frame. */
export const maxForwardedRequests = 100

/**
 * Tells of each request of the pages' session that fails, with the page view it is for: an
 * HTTP error answer (4xx, 5xx), or none at all (status 0), but not one cancelled, as by a
 * page that aborts its own fetch or goes elsewhere (`net::ERR_ABORTED`). The page's own
 * performance entries can't say as much: their buffer fills, and an abort reads as no
 * answer. Electron keeps one listener per request event for a session, so nothing else
 * may use these two on it. A page view that fails requests without end, as one polling a
 * server that errors, has `maxForwardedRequests` told for each origin and navigation of its
 * main frame and no more, so another site's beacon failing in a loop can't use up what the
 * page's own origin has: far over what a viewer reports for a document, which it decides.
 */
export const watchPageRequests = (
  pages: Session,
  report: (contentsId: number, failure: PageRequestFailure) => void,
): { readonly forget: (contentsId: number) => void } => {
  // By page view, then origin.
  const told = new Map<number, Map<string, number>>()
  const tell = (
    details: { url: string; resourceType: string; webContentsId?: number },
    status: number,
  ): void => {
    if (details.webContentsId === undefined) return
    const view = told.get(details.webContentsId) ?? new Map<string, number>()
    // An address that is no web page's, as ws: or blob:, shares one count, whatever it is.
    const origin = originOf(details.url) ?? "other"
    const count = view.get(origin) ?? 0
    if (count >= maxForwardedRequests) return
    told.set(details.webContentsId, view.set(origin, count + 1))
    report(details.webContentsId, {
      url: details.url,
      status,
      what: requestKinds[details.resourceType] ?? details.resourceType,
    })
  }
  // A new main-frame request is a new document, however it ends.
  const navigating = (details: { resourceType: string; webContentsId?: number }): void => {
    if (details.resourceType === "mainFrame" && details.webContentsId !== undefined)
      told.delete(details.webContentsId)
  }
  pages.webRequest.onCompleted((details) => {
    navigating(details)
    if (details.statusCode >= 400) tell(details, details.statusCode)
  })
  pages.webRequest.onErrorOccurred((details) => {
    navigating(details)
    if (details.error !== "net::ERR_ABORTED") tell(details, 0)
  })
  // A page view gone, as each rest of a page drops one: its counts go with it.
  return { forget: (contentsId) => void told.delete(contentsId) }
}
