import { webAddress } from "./browser/address.js"
import { framingOf, onPhone, type Framing, type PageSize } from "./browser/framing.js"
import {
  isScrolled,
  restoreWaitMs,
  revealing,
  scrolling,
  scrollRead,
  scrollReadMs,
  type Scrolled,
} from "./browser/in-page.js"
import { chromeMajorOf, phoneStyle, phoneUserAgent } from "./browser/phone.js"
import { pageSignInMessage, parsePageSignIn } from "./browser/sign-in.js"
import { createTilt } from "./browser/tilt.js"
import {
  abortedLoad,
  maxTroubles,
  originOf,
  pageRequestMessage,
  parsePageRequest,
  type Trouble,
} from "./browser/trouble.js"
import { wait } from "./browser/wait.js"
import type { Mount, Viewer, ViewerState } from "./index.js"

// A web page. Live, it loads in Electron's <webview>, which the desktop app's lockdown
// (./browser/host.ts) keeps to http(s), on the pages' session that keeps sign-ins, with no
// Node and no permissions; the viewer reports where it is and how its load went, and goes
// back, forward or reloads when asked. Shown again, it loads afresh and brings the element
// the show names into view. A live page can rest, as its app says while the person isn't
// at it: it shows a picture of itself in its place, and its view goes, so drawing it costs
// nothing; woken, it loads again under the picture, where the person had scrolled, and the
// picture fades once it's there. While the page has a sign-in window open, which closes
// with its view, it stays live instead, and rests once the last one closes. A live page lays
// out as a desktop's window or a phone's screen, scaled down to fit where the viewer is
// narrower (see `framingOf`). Where live pages aren't available (a plain browser, a demo),
// it shows a snapshot of the page, or nothing, for the app to say why. Its looks are
// browser.css's.

export type { PageSize, Trouble }

/**
 * A page by its address, as its app shows it. `shown` counts the app's shows of it: a
 * higher one is the page shown again, which loads afresh, back at its address if the
 * person went elsewhere, and brings `scroll`, a CSS selector, into view once it has
 * loaded. Each show scrolls once, however often a viewer mounts for it.
 */
export type BrowserContent = {
  readonly url: string
  readonly shown?: number
  readonly scroll?: string
}

/** Where the page is, and where it can go. */
export type Place = { readonly url: string; readonly back: boolean; readonly forward: boolean }

/** How the page's latest load went. */
export type Load = "loading" | "ready" | "failed"

export type BrowserOptions = {
  /** Whether pages load live here, as in the desktop app. */
  readonly live: boolean
  /** A picture of the page, shown where it can't load live. */
  readonly snapshot?: { readonly src: string; readonly alt: string }
  /** The pages' session, the one the desktop app's lockdown names. */
  readonly partition: string
  /**
   * Takes a picture of what the live page shows now, by its view's web contents id, for
   * the viewer to show while the page rests, no wider than `width` device pixels, as wide
   * as it's drawn, where it's drawn any width; undefined when it can't. Without it, a live
   * page never rests.
   */
  readonly picture?: (page: number, width?: number) => Promise<string | undefined>
  /**
   * Makes the live page's view act as a phone's, by its web contents id, or as itself
   * again: touched, with a phone's screen and browser; false when it can't. With it, a
   * page at a phone's size is a phone's, not just as narrow as one, and each view made for
   * one is named a phone's, for the app to make it one before it loads.
   */
  readonly phone?: (page: number, phone: boolean) => Promise<boolean>
  /** Whether a live page starts awake, as it does unless told; it rests only as a picture. */
  readonly awake?: boolean
  /** What a live page lays out as, a desktop's window unless told. */
  readonly size?: PageSize
  readonly on?: {
    readonly navigate?: (place: Place) => void
    readonly load?: (load: Load) => void
    readonly title?: (title: string) => void
    /**
     * What goes wrong on the page while it is at the address it was shown at, or anywhere
     * else on that origin: its errors, requests that failed (as the desktop app tells
     * them) and a load that failed outright, with `shown`, the show its document carries.
     * A document reports at most `maxTroubles`. Live pages only.
     */
    readonly trouble?: (trouble: Trouble, shown: number) => void
  }
}

export type BrowserViewer = Viewer<BrowserContent> & {
  readonly back: () => void
  readonly forward: () => void
  readonly reload: () => void
  /** Quiet while kept out of sight: it stops drawing on its own, but not playing. */
  readonly muted: (muted: boolean) => void
  /**
   * Live, or resting as a picture of itself, its view gone: a page with no picture yet
   * stays live until a rest can take one, and one loading rests once it's done, unless an
   * older picture can stand in for it.
   */
  readonly awake: (awake: boolean) => void
  /** Whether it has a picture to rest as. */
  readonly pictured: () => boolean
  /** Lays the live page out as `size`: its picture, of the other, stands in for nothing. */
  readonly size: (size: PageSize) => void
  /**
   * The live page as the person sees it now, for a picture of it to be taken: its view's web
   * contents id, where it is, its title, and the size it lays out at in CSS pixels. Undefined
   * unless the page is live, loaded and drawn on screen: not resting as its picture, not
   * loading or failed, not kept out of sight.
   */
  readonly seen: () => PageSeen | undefined
}

export type PageSeen = {
  readonly page: number
  readonly url: string
  readonly title: string
  readonly width: number
  readonly height: number
}

// Electron's <webview>: its methods work once it's attached, and throw until then.
type Webview = HTMLElement & {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  getURL(): string
  getWebContentsId(): number
  setAudioMuted(muted: boolean): void
  insertCSS(css: string): Promise<string>
  removeInsertedCSS(key: string): Promise<void>
}

// A picture of the page, and the address it shows.
type Picture = { readonly src: string; readonly at: string }

// Where the person had taken the page, from the address it was shown at, and the show
// it had carried out; and its picture, with where it was scrolled as it was taken, to
// rest as.
type BrowserState = {
  readonly browser: {
    readonly url: string
    readonly at: string
    readonly shown: number
    readonly picture?: Picture
    readonly scrolled?: Scrolled
  }
}

const isPicture = (value: unknown): value is Picture =>
  typeof (value as Partial<Picture> | null)?.src === "string" &&
  typeof (value as Partial<Picture>).at === "string"

const isBrowserState = (state: unknown): state is BrowserState => {
  const browser = (state as Partial<BrowserState> | null)?.browser
  return (
    typeof browser?.url === "string" &&
    typeof browser.at === "string" &&
    typeof browser.shown === "number" &&
    (browser.picture === undefined || isPicture(browser.picture)) &&
    (browser.scrolled === undefined || isScrolled(browser.scrolled))
  )
}

const showOf = (content: BrowserContent): number => content.shown ?? 0

// An address without its #fragment: two that differ only there are one document.
const documentOf = (url: string): string => url.split("#")[0]!

// The element whose id an address's #fragment is, as a selector: what a show at it brings
// into view when it names none of its own, as a reload keeps where the person had
// scrolled. A text fragment's directive is no id, nor a hash router's route.
const fragmentOf = (url: string): string | undefined => {
  const at = url.indexOf("#")
  if (at === -1) return undefined
  const fragment = url.slice(at + 1).split(":~:")[0]!
  if (fragment === "" || fragment.startsWith("/") || fragment.startsWith("!")) return undefined
  let id = fragment
  try {
    id = decodeURIComponent(fragment)
  } catch {
    // Not percent-encoding after all, as #100%: the id is as written.
  }
  return `[id=${JSON.stringify(id)}]`
}

// The element a show brings into view: its own, else its fragment's.
const scrollOf = (content: BrowserContent): string | undefined =>
  content.scroll ?? fragmentOf(content.url)

// A kept state of `content`'s page that no later show has passed: where to pick up.
const keptOf = (state: unknown, content: BrowserContent): BrowserState["browser"] | undefined =>
  isBrowserState(state) &&
  state.browser.url === content.url &&
  state.browser.shown >= showOf(content)
    ? state.browser
    : undefined

const nothing = (): void => undefined

// Each call into a page, once it's attached; until then dom-ready catches up.
const attached = <T>(call: () => T): T | undefined => {
  try {
    return call()
  } catch {
    return undefined
  }
}

// Its first document ready, a view paints its own ground, and keeps its last frame
// through later loads: the viewer's goes (see browser.css).
const painting = (event: Event): void => {
  ;(event.currentTarget as HTMLElement).dataset.painting = ""
}

/** How long a show's scroll waits for its element to appear once the page has loaded. */
export const scrollWaitMs = 5_000

/**
 * A live page keeps a picture of itself ready, so it can rest at once, even where it can't
 * be pictured as it goes, as when its app hides it in the same moment: `freshenMs` after
 * a load or a move within it, `leftMs` after the pointer leaves it, and every `keepMs`
 * while it's awake, though never while the pointer is on it or it has focus, so taking one
 * never comes in the way of the person using it.
 */
export const freshenMs = 1_000
const leftMs = 300
export const keepMs = 5_000

/**
 * How long a woken page's picture stays over it once it has loaded, for it to draw, and
 * then fades for; browser.css's fade matches.
 */
export const uncoverMs = 120
export const fadeMs = 150

export const mountBrowser: Mount<BrowserContent, BrowserOptions, BrowserViewer> = (
  element,
  {
    content,
    label,
    saved,
    live,
    snapshot,
    partition,
    picture: take,
    phone: becomePhone,
    awake: startAwake,
    size: startSize,
    on,
  },
) => {
  const document = element.ownerDocument
  // The window it's drawn in: its resizes, its frames, and the desktop app's word.
  const win = document.defaultView
  const root = document.createElement("div")
  root.className = "browser-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  element.append(root)

  let shown = content
  const kept = keptOf(saved, content)
  const resumed = kept?.at ?? content.url
  let place: Place = { url: resumed, back: false, forward: false }
  let load: Load = "loading"
  let muted = false
  // The latest show, which an older one arriving late never takes back.
  let showing = showOf(content)
  // The element a show brings into view once the load under way is done; one a viewer of
  // the same show carried out already is done.
  let scrollTo = live && !kept ? scrollOf(content) : undefined
  // The shown fragment a reload of the document goes to once it has loaded.
  let then: string | undefined
  // The picture it rests as, and where the page was scrolled as it was taken.
  let picture = kept?.picture
  let scrolled = kept?.scrolled
  // A show came while it rested, or a reload was asked for: its next load goes afresh.
  let stale = false
  // The person has been at the live page since its picture was taken, so the picture may
  // not be how they left it: it stands in for nothing, and isn't kept, until a new one.
  let used = false
  // The element a show is bringing into view, the page waiting for it to appear.
  let bringing: string | undefined
  // Kept with the show it carried out: one whose move or scroll is still to come isn't yet,
  // so a viewer mounted for it before then still carries it out.
  const state = (at: string): ViewerState =>
    ({
      browser: {
        url: shown.url,
        at,
        shown: scrollTo === undefined && then === undefined && !stale ? showing : showing - 1,
        ...(picture !== undefined && !used && { picture }),
        ...(picture !== undefined && !used && scrolled !== undefined && { scrolled }),
      },
    }) satisfies BrowserState as unknown as ViewerState

  const report = (next: Load): void => {
    if (next === load) return
    load = next
    root.dataset.load = load
    on?.load?.(load)
  }

  if (!live) {
    if (snapshot) {
      const scroll = document.createElement("div")
      scroll.className = "browser-snapshot"
      // Focusable, so a tall snapshot can be scrolled by keyboard.
      scroll.tabIndex = 0
      const image = document.createElement("img")
      image.src = snapshot.src
      image.alt = snapshot.alt
      scroll.append(image)
      root.append(scroll)
    }
    report("ready")
    on?.navigate?.(place)
    return {
      update: (next) => {
        // An older show arriving late changes nothing.
        if (showOf(next) < showing) return
        shown = next
        showing = showOf(next)
        place = { url: next.url, back: false, forward: false }
        on?.navigate?.(place)
      },
      state: () => state(shown.url),
      restore: nothing,
      jumpTo: nothing,
      focus: () =>
        root.querySelector<HTMLElement>(".browser-snapshot")?.focus({ preventScroll: true }),
      back: nothing,
      forward: nothing,
      reload: nothing,
      muted: nothing,
      // A snapshot is its picture already.
      awake: nothing,
      pictured: () => true,
      size: nothing,
      seen: () => undefined,
      destroy: () => root.remove(),
    }
  }

  // The picture, over where the page is, or in its place while it rests. Focusable, so
  // the person can reach it by keyboard, which wakes it where its app listens.
  const still = document.createElement("div")
  still.className = "browser-picture"
  still.tabIndex = 0
  const image = document.createElement("img")
  image.alt = label
  still.append(image)
  // Its fade, under way.
  let fading: ReturnType<typeof setTimeout> | undefined
  // Only a picture taken where it is, and since the person was last at it: one of anywhere
  // else would show the wrong page, and an older one a page they've since changed.
  const cover = (): boolean => {
    if (picture === undefined || picture.at !== place.url || used) return false
    clearTimeout(fading)
    fading = undefined
    image.src = picture.src
    delete still.dataset.fading
    if (!still.isConnected) root.prepend(still)
    return true
  }
  // Once the woken page has drawn, the picture fades, and goes.
  const uncover = (): void => {
    if (!still.isConnected || fading !== undefined) return
    fading = setTimeout(() => {
      still.dataset.fading = ""
      fading = setTimeout(() => {
        fading = undefined
        // Focus the person gave the picture goes on to the page.
        const focused = still.contains(document.activeElement)
        still.remove()
        delete still.dataset.fading
        if (focused) page?.focus({ preventScroll: true })
      }, fadeMs)
    }, uncoverMs)
  }

  // What the page lays out as, and where its view and picture go for that in the viewer,
  // which browser.css reads; framed again as the viewer resizes. By its layout box, which a
  // zoomed canvas around it doesn't change.
  let size = startSize ?? "desktop"
  // The viewer's size as its resizes report it, to the fraction of a pixel, so a scaled
  // page reaches its edges; its whole pixels where none has reported it yet, or the last
  // report is behind it, as just after it shows again.
  let measured: { readonly width: number; readonly height: number } | undefined
  const sizeNow = (): { readonly width: number; readonly height: number } => {
    const { clientWidth: width, clientHeight: height } = root
    return measured &&
      Math.abs(measured.width - width) < 1 &&
      Math.abs(measured.height - height) < 1
      ? measured
      : { width, height }
  }
  // How wide the page is drawn now, in CSS pixels, as its picture is.
  const drawnWidth = (): number => {
    const { width, height } = sizeNow()
    const framing = framingOf(size, width, height)
    return framing ? framing.width * framing.scale : width
  }
  // Where its phone is, for a press on the stage around it, not on it.
  let framed: Framing | undefined
  const frame = (): void => {
    root.dataset.size = size
    const { width, height } = sizeNow()
    const framing = framingOf(size, width, height)
    framed = framing
    const values: Record<string, string | undefined> = {
      "--browser-width": framing && `${framing.width}px`,
      "--browser-height": framing && `${framing.height}px`,
      "--browser-scale": framing && `${framing.scale}`,
      "--browser-left": framing && `${framing.left}px`,
      "--browser-top": framing && `${framing.top}px`,
    }
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) root.style.removeProperty(name)
      else root.style.setProperty(name, value)
    }
  }
  // Where there's nothing to report a resize, as outside a browser, it's framed as it mounts.
  const resizing = win?.ResizeObserver
    ? new win.ResizeObserver((entries) => {
        const box = entries.at(-1)?.contentRect
        if (box) measured = { width: box.width, height: box.height }
        frame()
      })
    : undefined
  resizing?.observe(root)
  frame()

  // A phone tilts as the person drags across the stage around it, not on the phone itself,
  // its frame or a screen the pointer reaches through to, as in a Grid tile not yet picked.
  const tilt = createTilt(
    root,
    (press) => size === "phone" && !(framed && onPhone(framed, press.offsetX, press.offsetY)),
  )

  // Whether it's drawn: not inside an element kept out of sight, as with display: none.
  const shownNow = (): boolean =>
    document.visibilityState !== "hidden" && root.checkVisibility?.() !== false
  // The live page while there is one: none while it rests; and whether a wake opened it.
  let page: Webview | undefined
  let woken = false
  // A picture of the live page under way, after its load, to rest as.
  let freshening: ReturnType<typeof setTimeout> | undefined
  // Whether its app wants it live.
  let wanted = startAwake ?? true
  // A rest under way, waiting for its picture: a wake or a later rest drops it.
  let resting: object | undefined
  // The sign-in windows the live page has open, as the desktop app tells: it stays live
  // while there are any, as its view going would close them.
  let signingIn = 0
  // Until its first load is done.
  let first = true
  // Moving to the shown fragment, whose scroll waits for the move.
  let moving = false

  // What goes wrong, for the app to tell on, while the page is at the origin it was shown
  // at: its errors, a load that failed outright, and the requests the desktop app sees
  // fail. Where the page committed is its own address, else where it is going. One count
  // per document, which the main frame's `did-navigate` starts anew, as does a load of it
  // that fails outright, which commits nothing.
  const reportTrouble = on?.trouble
  let reported = 0
  // The show the document carries: the latest one when it committed.
  let carried = showing
  // A failed request for the page itself, which can come before the document commits and
  // so before the count starts anew: told once it has.
  let held: Trouble | undefined
  const shownOrigin = (): string | null => originOf(shown.url)
  const atShown = (): boolean => {
    const origin = shownOrigin()
    return origin !== null && originOf(attached(() => page?.getURL()) ?? place.url) === origin
  }
  const tell = (trouble: Trouble): void => {
    if (reported >= maxTroubles) return
    reported += 1
    reportTrouble?.(trouble, carried)
  }
  const tellHeld = (): void => {
    const trouble = held
    held = undefined
    if (trouble && atShown()) tell(trouble)
  }
  const logged = (event: Event): void => {
    const { level, message, line, sourceId } = event as Event & {
      level?: number
      message?: unknown
      line?: unknown
      sourceId?: unknown
    }
    // Errors only, from the shown origin: not Electron's own, nor a third party's frame.
    if (level !== 3 || typeof message !== "string" || typeof sourceId !== "string") return
    if (originOf(sourceId) !== shownOrigin() || !atShown()) return
    tell({
      kind: "error",
      text: message,
      source: sourceId,
      line: typeof line === "number" && line >= 0 ? line : 0,
    })
  }
  // The desktop app's word of a request this page's session saw fail, through the app's
  // preload: from the app's own page, naming this view.
  let committed = false
  // The document is a load that failed outright, which its own told: a later word of the page
  // getting no answer, which can come after it, is the same failure.
  let failedLoad = false
  const requested = (event: MessageEvent): void => {
    const { data } = event
    if (event.source !== win || data?.type !== pageRequestMessage) return
    const failure = parsePageRequest(data)
    if (!failure || failure.contentsId !== attached(() => page?.getWebContentsId())) return
    if (originOf(failure.url) !== shownOrigin()) return
    if (failedLoad && failure.what === "page" && failure.status === 0) return
    const trouble: Trouble = {
      kind: "request",
      url: failure.url,
      status: failure.status,
      what: failure.what,
    }
    if (failure.what === "page" && !committed) held = trouble
    else if (atShown()) tell(trouble)
  }
  // A new document for these purposes: its count, and the show it carries.
  const documented = (): void => {
    reported = 0
    carried = showing
    committed = true
    failedLoad = false
    tellHeld()
  }
  if (reportTrouble) win?.addEventListener("message", requested)
  // The desktop app's word of how many sign-in windows this page has open, through the
  // app's preload: from the app's own page, naming this view.
  const signIns = (event: MessageEvent): void => {
    const { data } = event
    if (event.source !== win || data?.type !== pageSignInMessage) return
    const notice = parsePageSignIn(data)
    if (!notice || notice.contentsId !== attached(() => page?.getWebContentsId())) return
    signingIn = notice.open
    // The last one closed while its app wanted it at rest: it rests now.
    if (signingIn === 0 && !wanted) rest()
  }
  win?.addEventListener("message", signIns)

  // A phone's page has no scrollbar taking room, as a phone's floats over it: put in each
  // document its view loads while it's a phone's, and taken out of it when it no longer is.
  // Every look put in a view is kept until taken out: dom-ready can come for a document
  // already given one, as when the switch came while it loaded, and taking out a look a
  // later document never had does nothing.
  let dressed: { readonly view: Webview; readonly keys: Promise<string | undefined>[] } | undefined
  const dress = (): void => {
    const view = page
    if (!view || size !== "phone") return
    const key = attached(() => view.insertCSS(phoneStyle))
    if (!key) return
    if (dressed?.view !== view) dressed = { view, keys: [] }
    dressed.keys.push(key.catch(() => undefined))
  }
  const undress = (): void => {
    const was = dressed
    dressed = undefined
    for (const each of was?.keys ?? [])
      void each.then((key) => {
        if (key !== undefined) void attached(() => was!.view.removeInsertedCSS(key))?.catch(nothing)
      })
  }
  // Where the app can make a view a phone's, or itself again, the live view is as its size
  // says, and the page loads again once it changes, for it to know what it now runs on. A
  // view not attached yet catches up as its document is ready.
  let phoneView: Webview | undefined
  const navigatorAgent = (): string => win?.navigator.userAgent ?? ""
  const becomeSize = (): void => {
    const view = page
    if (!becomePhone || !view) return
    const asPhone = size === "phone"
    if ((phoneView === view) === asPhone) return
    const id = attached(() => view.getWebContentsId())
    if (id === undefined) return
    phoneView = asPhone ? view : undefined
    // Not a phone's any more: loaded again from its address, as by a restore, it isn't one.
    if (!asPhone) view.removeAttribute("useragent")
    void becomePhone(id, asPhone)
      .catch(() => false)
      .then((done) => {
        if (!done) {
          if (asPhone && phoneView === view) phoneView = undefined
          return
        }
        if (page === view) attached(() => view.reload())
      })
  }
  const moved = (): void => {
    attached(() => {
      page!.setAudioMuted(muted)
      place = { url: page!.getURL(), back: page!.canGoBack(), forward: page!.canGoForward() }
      on?.navigate?.(place)
    })
  }
  // A new load, as the person or a redirect took it on: a show's element waited for in the
  // last one isn't any more.
  const started = (): void => {
    bringing = undefined
    held = undefined
    committed = false
    failedLoad = false
    report("loading")
  }
  const reveal = (): void => {
    const selector = scrollTo
    scrollTo = undefined
    if (selector === undefined) return
    const run = attached(() => page!.executeJavaScript(revealing(selector, scrollWaitMs)))
    if (!run) return
    bringing = selector
    void run.catch(nothing).finally(() => {
      if (bringing === selector) bringing = undefined
    })
  }
  // Its scroll goes once the page, not a frame in it, has moved to the shown fragment.
  const movedInPage = (event: Event): void => {
    moved()
    if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return
    // Moved within the page, as an app's route: its picture is of where it was.
    freshen(freshenMs)
    if (!moving) return
    moving = false
    reveal()
  }
  // Loads an address, once attached, even where its attribute already names it; another
  // fragment of the document it's on only moves within it, as a link to it would.
  const go = (to: string): boolean =>
    attached(() => {
      void page!.loadURL(to).catch(nothing)
      return true
    }) === true
  // Woken, back where the person had scrolled, unless a show brings something into view;
  // then the picture goes.
  const settle = (shows: boolean): void => {
    const at = scrolled
    scrolled = undefined
    if (at === undefined || shows) return uncover()
    const run = attached(() => page!.executeJavaScript(scrolling(at)))
    if (!run) return uncover()
    // However the page answers, or if it never does, the picture goes.
    void Promise.race([run, wait(restoreWaitMs + scrollReadMs)])
      .catch(nothing)
      .finally(uncover)
  }
  const stopped = (): void => {
    first = false
    moving = false
    if (load === "loading") report("ready")
    moved()
    // A reload that committed no new document tells what it held.
    tellHeld()
    // A show came while it rested: loaded again, past the cache, as a show again is.
    if (stale) {
      stale = false
      refresh()
      return
    }
    const to = then
    then = undefined
    // A show bringing an element into view, or moving to its fragment, scrolls in place of
    // where the person had scrolled.
    const shows = scrollTo !== undefined || to !== undefined
    // The person, or a redirect, took it to another document while it reloaded: theirs.
    const left = to !== undefined && documentOf(place.url) !== documentOf(to)
    if (load !== "ready" || left) scrollTo = undefined
    else if (to !== undefined && to !== place.url && go(to)) moving = true
    else reveal()
    if (!wanted && load === "ready") rest()
    else {
      // Live and awake, the person may be at it: what it shows from here is theirs.
      if (wanted) used = true
      settle(shows)
      freshen(freshenMs)
    }
  }
  // Shown again, or at another address: let be while its first load of that address is
  // under way, as that load is this show's. In the document it's on, at the shown
  // fragment or another, it reloads, then moves to the shown one: loading another fragment
  // of a document only moves within it, which would show what it held before. Anywhere
  // else, as a redirect took it or the person went, it loads the shown address afresh.
  const refresh = (): void => {
    moving = false
    then = undefined
    if (first && load === "loading" && place.url === shown.url) {
      // A wake's load isn't the show's: it goes again, afresh, once done. Else this load
      // is the show's, and what goes wrong in it is told with it.
      if (woken) stale = true
      else carried = showing
      return
    }
    // Where it is, as the page has it: an address it's on its way to isn't reloaded, as a
    // reload goes to the last one it reached.
    const at = attached(() => page!.getURL()) || place.url
    const there = at === shown.url
    // Without a fragment, the shown address is a document of its own to load.
    if ((there || shown.url.includes("#")) && documentOf(at) === documentOf(shown.url)) {
      // Past the cache, so what the agent changed shows, its styles and scripts too.
      const reloading = attached(() => {
        page!.reloadIgnoringCache()
        return true
      })
      if (reloading) {
        if (!there) then = shown.url
        report("loading")
        return
      }
    }
    if (!go(shown.url)) page!.setAttribute("src", shown.url)
    place = { url: shown.url, back: place.back, forward: place.forward }
    on?.navigate?.(place)
    report("loading")
  }
  const failed = (event: Event): void => {
    const { errorCode, isMainFrame } = event as Event & {
      errorCode?: number
      isMainFrame?: boolean
    }
    if (errorCode !== abortedLoad && isMainFrame !== false) report("failed")
  }
  const failedTo = (event: Event): void => {
    failed(event)
    const { errorCode, errorDescription, isMainFrame, validatedURL } = event as Event & {
      errorCode?: number
      errorDescription?: unknown
      isMainFrame?: boolean
      validatedURL?: unknown
    }
    if (!reportTrouble || errorCode === abortedLoad || isMainFrame === false) return
    // The server that gave no answer for the page itself is this failure, told once.
    if (held?.kind === "request" && held.what === "page" && held.status === 0) held = undefined
    documented()
    failedLoad = true
    // The address that failed: nothing was committed to say where the page was.
    const origin = shownOrigin()
    if (
      origin === null ||
      originOf(typeof validatedURL === "string" ? validatedURL : "") !== origin
    )
      return
    tell({
      kind: "load",
      text:
        typeof errorDescription === "string" && errorDescription
          ? errorDescription
          : `Error ${errorCode ?? "unknown"}`,
    })
  }
  const gone = (): void => {
    report("failed")
    uncover()
  }
  // The page's title as it last named itself.
  let titleNow = ""
  const titled = (event: Event): void => {
    const { title } = event as Event & { title?: string }
    if (typeof title === "string") {
      titleNow = title
      on?.title?.(title)
    }
  }
  const listeners: readonly (readonly [string, (event: Event) => void])[] = [
    ["dom-ready", moved],
    ["dom-ready", painting],
    ["dom-ready", dress],
    ["dom-ready", becomeSize],
    ["did-navigate", moved],
    ["did-navigate-in-page", movedInPage],
    ["did-start-loading", started],
    ["did-stop-loading", stopped],
    ["did-fail-load", failedTo],
    ["did-navigate", documented],
    ["console-message", logged],
    ["render-process-gone", gone],
    ["page-title-updated", titled],
  ]

  // Made here, not by a framework that may leave `allowpopups` off: Electron reads the
  // attributes once, as the view attaches. With it, a page's new windows reach the desktop app's
  // lockdown, which opens one in the browser right after the person's click or key. The
  // lockdown gives it the pages' session whatever it asks; it's named to match.
  const open = (at: string, byWake: boolean): void => {
    woken = byWake
    const made = document.createElement("webview") as Webview
    made.setAttribute("partition", partition)
    made.setAttribute("allowpopups", "")
    // A phone's, named by its browser's user agent, which the desktop app's lockdown knows and
    // makes it one by before it loads.
    if (becomePhone && size === "phone") {
      made.setAttribute("useragent", phoneUserAgent(chromeMajorOf(navigatorAgent())))
      phoneView = made
    }
    made.setAttribute("src", at)
    page = made
    first = true
    moving = false
    // A new view has none open: an earlier view's went with it.
    signingIn = 0
    for (const [type, listener] of listeners) made.addEventListener(type, listener)
    root.append(made)
    report("loading")
  }
  const close = (): void => {
    if (!page) return
    clearTimeout(freshening)
    // A show's element the page was waiting for is brought into view on waking instead.
    if (bringing !== undefined) {
      scrollTo = bringing
      bringing = undefined
      scrolled = undefined
    }
    for (const [type, listener] of listeners) page.removeEventListener(type, listener)
    page.remove()
    page = undefined
    // Its history went with its view.
    place = { url: place.url, back: false, forward: false }
    on?.navigate?.(place)
  }
  // In its picture's place: a fresh one where it can take one, else the one it has. One
  // that didn't load stays, to say so.
  const rest = (): void => {
    const view = page
    if (!view || !take || load === "failed" || signingIn > 0) return
    // Mid-load, it's pictured once loaded, unless a picture it has stands in meanwhile; a
    // load after its first, as a show's, then goes again, afresh, on waking. Out of sight, as
    // where its app keeps it hidden, it draws nothing to picture: the one it has stands in.
    const hidden = !shownNow()
    if (load === "loading" || hidden) {
      const standIn = (): void => {
        if (signingIn > 0 || !cover()) return
        if (load === "loading" && !first) stale = true
        then = undefined
        close()
        report("ready")
      }
      if (picture === undefined || load === "loading") return standIn()
      // Out of sight, where it's scrolled can still be read, for it to wake there, unless the
      // page doesn't answer.
      const reading = attached(() =>
        Promise.race([view.executeJavaScript(scrollRead), wait(scrollReadMs)]),
      )
      if (!reading) return standIn()
      const asked = {}
      resting = asked
      void reading
        .catch(() => undefined)
        .then((at) => {
          if (resting !== asked || wanted || page !== view) return
          resting = undefined
          if (isScrolled(at)) scrolled = at
          standIn()
        })
      return
    }
    const asked = {}
    resting = asked
    void snap(view).then((taken) => {
      if (resting !== asked || wanted || page !== view) return
      resting = undefined
      // A load began meanwhile, as a show's: it rests once that's done.
      if (load !== "ready") return
      if (taken) {
        picture = taken.picture
        scrolled = taken.scrolled
        used = false
      }
      // Nothing to rest as: live, until a later rest can take one.
      swap(view)
    })
  }
  // The latest picture asked for: an earlier one arriving after it is of before.
  let snapping = 0
  // A picture of the live page as it is now, and where it's scrolled; none where it can't,
  // or where a later one was asked for meanwhile.
  const snap = async (
    view: Webview,
  ): Promise<{ picture: Picture; scrolled: Scrolled | undefined } | undefined> => {
    const id = attached(() => view.getWebContentsId())
    if (id === undefined || !take) return undefined
    const at = place.url
    const asked = ++snapping
    const reading = attached(() =>
      Promise.race([view.executeJavaScript(scrollRead), wait(scrollReadMs)]),
    )?.catch(() => undefined)
    // As wide as it's drawn: a page scaled down to fit lays out, and is pictured, wider.
    // Drawn no width at all, it's pictured as it is.
    const drawn = Math.round(drawnWidth() * (win?.devicePixelRatio ?? 1))
    const width = drawn >= 1 ? drawn : undefined
    const [src, where] = await Promise.all([take(id, width).catch(() => undefined), reading])
    if (src === undefined || asked !== snapping) return undefined
    return { picture: { src, at }, scrolled: isScrolled(where) ? where : undefined }
  }
  // Pictured a while after each load, so a rest that can't picture it, as out of sight,
  // rests as it is, not as it was.
  const freshen = (after: number): void => {
    clearTimeout(freshening)
    const view = page
    if (!view || !take) return
    freshening = setTimeout(() => {
      if (page !== view) return
      // Again in a while, for as long as it's live.
      freshen(keepMs)
      const using = root.matches(":hover") || root.contains(document.activeElement)
      // A rest taking its own picture has the newer one coming: this one would only replace it.
      if (load !== "ready" || !shownNow() || using || resting !== undefined) return
      void snap(view).then((taken) => {
        if (!taken || page !== view || load !== "ready") return
        picture = taken.picture
        scrolled = taken.scrolled
        // At it again as it was taken: it may be out of date already.
        used = root.matches(":hover") || root.contains(document.activeElement)
        // Its app had it rest, but it had no picture to rest as until now.
        if (!wanted) swap(view)
      })
    }, after)
  }
  // In its picture's place, once the picture can draw, so no frame shows neither.
  const swap = (view: Webview): void => {
    if (!cover()) return
    // Where images can't say they've decoded, as outside a browser, at once.
    void (image.decode?.() ?? Promise.resolve()).catch(nothing).then(() => {
      // Woken meanwhile, or a load began, as a show's: it stays, and rests once it's done.
      if (page === view && !wanted && load === "ready" && signingIn === 0) close()
    })
  }
  // The person at the live page: its picture is of before. Gone from it: a picture of it as
  // they left it.
  const engaged = (): void => {
    if (page) used = true
  }
  root.addEventListener("pointerenter", engaged)
  root.addEventListener("focusin", engaged)
  root.addEventListener("pointerleave", () => freshen(leftMs))
  const wake = (): void => {
    resting = undefined
    if (page) {
      // Live already, as when a rest gave way: once it's there, its picture goes.
      if (load !== "loading") uncover()
      return
    }
    open(place.url, true)
  }

  root.dataset.load = load
  on?.load?.(load)
  if (!wanted && cover()) {
    // At rest from the first: its picture until it's woken.
    report("ready")
  } else {
    open(resumed, false)
    // Its picture until it's there.
    cover()
  }
  // Where it's going, as it may not be where its app showed it, until the page says.
  if (resumed !== content.url || !page) on?.navigate?.(place)

  return {
    update: (next) => {
      // An older show arriving late changes nothing.
      if (showOf(next) < showing) return
      const previous = shown
      const again = showOf(next) > showing
      shown = next
      showing = showOf(next)
      // Loaded after it attached, past the lockdown's check of its first address.
      if (!webAddress(next.url)) return
      if (!again && previous.url === next.url) return
      scrollTo = again ? scrollOf(next) : undefined
      if (page) return refresh()
      // At rest: it goes there, afresh, once woken, its picture of where it was gone.
      stale = true
      then = undefined
      scrolled = undefined
      place = { url: next.url, back: false, forward: false }
      if (!cover()) still.remove()
      on?.navigate?.(place)
    },
    state: () => state(place.url),
    restore: (earlier) => {
      const at = keptOf(earlier, shown)?.at
      // Already there: setting it again would load it again.
      if (at === undefined || at === place.url || !webAddress(at)) return
      page?.setAttribute("src", at)
      place = { url: at, back: place.back, forward: place.forward }
      // Where it was scrolled, and its picture, were of where it was.
      if (!page) {
        scrolled = undefined
        if (!cover()) still.remove()
      }
      on?.navigate?.(place)
    },
    // A page has no lines to jump to that the viewer can know.
    jumpTo: () => undefined,
    focus: () => (page ?? still).focus({ preventScroll: true }),
    back: () => attached(() => page!.goBack()),
    forward: () => attached(() => page!.goForward()),
    // At rest, or before it's attached, its next load goes afresh.
    reload: () => {
      const reloading = attached(() => {
        page!.reload()
        return true
      })
      if (!reloading) stale = true
    },
    muted: (next) => {
      muted = next
      attached(() => page!.setAudioMuted(muted))
    },
    awake: (next) => {
      wanted = next
      if (next) wake()
      else rest()
    },
    pictured: () => picture !== undefined && !used,
    seen: () => {
      // Its own picture over it, or no page at all, is a rest; a page still loading or one
      // that failed isn't how the person would want it seen.
      if (!page || still.isConnected || load !== "ready" || !shownNow()) return undefined
      const id = attached(() => page!.getWebContentsId())
      if (id === undefined) return undefined
      const { width, height } = sizeNow()
      const framing = framingOf(size, width, height)
      return {
        page: id,
        url: attached(() => page!.getURL()) || place.url,
        title: titleNow,
        width: Math.round(framing?.width ?? width),
        height: Math.round(framing?.height ?? height),
      }
    },
    size: (next) => {
      if (next === size) return
      size = next
      frame()
      if (size === "phone") dress()
      else undress()
      becomeSize()
      // Its picture, and one under way, are of the other size, as is where it was scrolled:
      // it rests as one of this once one is taken. Over a page that's there, or on its way
      // as a press on the switch woke it, the picture goes at once.
      if (picture !== undefined) used = true
      snapping += 1
      scrolled = undefined
      if (page) {
        clearTimeout(fading)
        fading = undefined
        still.remove()
        delete still.dataset.fading
      }
      freshen(freshenMs)
    },
    destroy: () => {
      resizing?.disconnect()
      tilt.stop()
      win?.removeEventListener("message", requested)
      win?.removeEventListener("message", signIns)
      clearTimeout(fading)
      clearTimeout(freshening)
      resting = undefined
      if (page) for (const [type, listener] of listeners) page.removeEventListener(type, listener)
      // Gone: a picture or a read arriving late finds no page of its own.
      page = undefined
      root.remove()
    },
  }
}
