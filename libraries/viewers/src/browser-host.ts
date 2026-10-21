import type { Session, WebContents, WebPreferences } from "electron"

import { webAddress } from "./address.js"
import { originOf, type PageRequestFailure } from "./browser-trouble.js"

export { webAddress } from "./address.js"

// The browser viewer's lockdown, in Electron's main process. Live pages load in a
// <webview>: a browser view apart from the app's own page. Whatever the element asks for,
// each gets no preload, no Node, a sandbox, and the pages' session, in memory, where
// every permission and download is refused and no file loads. It goes only to http(s)
// addresses by its own links and redirects. A window it opens right after the person
// clicked or typed in it opens in their own browser, one per click or key; any other
// opens nowhere. Nothing here can loosen that: the options only name the session.

/**
 * The pages' session's name, checked: one that names a session in memory and apart from
 * the app's. An empty name is the app's own session, and `persist:` keeps what pages store
 * on disk, so either is refused rather than loosening the lockdown.
 */
export const pagesSession = (partition: string): string => {
  if (!inMemory(partition))
    throw new Error(`The pages' session must be in memory and named: "${partition}" isn't.`)
  return partition
}

const inMemory = (partition: string): boolean =>
  partition !== "" && !partition.startsWith("persist:")

/**
 * Settles a page view's settings as it attaches, from `will-attach-webview`; false when
 * it must not attach, as for anything but an http(s) address. Only `preferences` take
 * effect here: Electron has read the element's attributes into them already, and
 * ignores changes to `params`. So `allowpopups`, which lets a page's new windows reach
 * `guardPage`'s handler, is the element's to set.
 */
export const attachPage = (
  preferences: WebPreferences,
  params: { readonly src?: string },
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
  // A session that isn't the pages' own refuses the view, never throws past the host's
  // handler, which would let the view attach as it asked.
  if (!inMemory(partition)) return false
  preferences.partition = partition
  return webAddress(params.src ?? "")
}

type Opener = (url: string) => unknown

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
 * Keeps a page view to http(s) addresses by its own links and redirects, and sends a
 * window it opens to the browser only right after the person's click or key, one each,
 * so a page can't open tabs on its own. The handler isn't told which frame opened the
 * window, so a frame from another site in the page can take the click's one window.
 */
export const guardPage = (
  contents: WebContents,
  openExternal: Opener,
  now: () => number = Date.now,
): void => {
  let gesture: number | undefined
  contents.on("input-event", (_event, input) => {
    // A key event marks a held key's repeats; others don't carry the flag.
    const repeat = "isAutoRepeat" in input && input.isAutoRepeat === true
    if (gestures.has(input.type) && !repeat) gesture = now()
  })
  contents.setWindowOpenHandler(({ url }) => {
    const theirs = gesture !== undefined && now() - gesture <= gestureMs
    if (theirs && webAddress(url)) {
      gesture = undefined
      void openExternal(url)
    }
    return { action: "deny" }
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
 * viewer to show in its place while the page rests. Undefined unless `id` is a page view
 * of `host`, the app's page that asks, so a page can't be asked for another window's, and
 * when the page draws nothing yet. `fromId` is Electron's `webContents.fromId`.
 */
export const picturePage = async (
  host: WebContents,
  id: unknown,
  fromId: (id: number) => WebContents | undefined,
): Promise<string | undefined> => {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return undefined
  const page = fromId(id)
  if (!page || page.isDestroyed() || page.getType() !== "webview" || page.hostWebContents !== host)
    return undefined
  const image = await within(page.capturePage(), pictureWaitMs)
  if (!image || image.isEmpty()) return undefined
  return `data:image/jpeg;base64,${image.toJPEG(pictureQuality).toString("base64")}`
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
