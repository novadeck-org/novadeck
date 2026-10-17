import type { Session, WebContents, WebPreferences } from "electron"

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

/** Whether `url` is an http(s) address, the only kind a page view loads. */
export const webAddress = (url: string): boolean => {
  try {
    const { protocol } = new URL(url)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

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
