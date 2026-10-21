import { webAddress } from "./address.js"
import type { Mount, Viewer, ViewerState } from "./index.js"

// A web page. Live, it loads in Electron's <webview>, which the host's lockdown
// (./browser-host.ts) keeps to http(s), in memory, with no Node and no permissions; the
// viewer reports where it is and how its load went, and goes back, forward or reloads
// when asked. Shown again, it loads afresh and brings the element the show names into
// view. A live page can rest, as its host says while the person isn't at it: it shows a
// picture of itself in its place, and its view goes, so drawing it costs nothing; woken,
// it loads again under the picture, where the person had scrolled, and the picture fades
// once it's there. Where live pages aren't available (a plain browser, a demo), it shows a
// snapshot of the page, or nothing, for the host to say why. Its looks are browser.css's.

/**
 * A page by its address, as its host shows it. `shown` counts the host's shows of it: a
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
  /** The pages' session, the one the host's lockdown names. */
  readonly partition: string
  /**
   * Takes a picture of what the live page shows now, by its view's web contents id, for
   * the viewer to show while the page rests; undefined when it can't. Without it, a live
   * page never rests.
   */
  readonly picture?: (page: number) => Promise<string | undefined>
  /** Whether a live page starts awake, as it does unless told; it rests only as a picture. */
  readonly awake?: boolean
  readonly on?: {
    readonly navigate?: (place: Place) => void
    readonly load?: (load: Load) => void
    readonly title?: (title: string) => void
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
}

// A page's scroll, as `[scrollX, scrollY]`.
type Scrolled = readonly [number, number]

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

const isScrolled = (value: unknown): value is Scrolled =>
  Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)

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

// The load errors that aren't failures: a navigation that replaced the one loading.
const aborted = -3

/** How long a show's scroll waits for its element to appear once the page has loaded. */
export const scrollWaitMs = 5_000

/**
 * A live page keeps a picture of itself ready, so it can rest at once, even where it can't
 * be pictured as it goes, as when its host hides it in the same moment: `freshenMs` after
 * a load or a move within it, `leftMs` after the pointer leaves it, and every `keepMs`
 * while it's awake, though never while the pointer is on it or it has focus, so taking one
 * never comes in the way of the person using it.
 */
export const freshenMs = 1_000
export const leftMs = 300
export const keepMs = 5_000

/**
 * How long a woken page's picture stays over it once it has loaded, for it to draw, and
 * then fades for; browser.css's fade matches.
 */
export const uncoverMs = 120
export const fadeMs = 150

// Run in the page: where it's scrolled.
const scrollRead = "[scrollX, scrollY]"
// Run in the page: back where it was scrolled.
const scrolling = ([x, y]: Scrolled): string => `scrollTo(${x}, ${y})`

// Run in the page: brings the first element matching `selector` into view, as an #anchor
// would, once one is there, waiting up to `ms` for a page that draws itself after loading.
// A selector the page can't read finds nothing.
const revealing = (selector: string, ms: number): string => `new Promise((done) => {
  const find = () => {
    try {
      return document.querySelector(${JSON.stringify(selector)})
    } catch {
      return null
    }
  }
  const reveal = (element) => {
    element.scrollIntoView({ block: "start" })
    done(true)
  }
  const found = find()
  if (found) return reveal(found)
  const watch = new MutationObserver(() => {
    const element = find()
    if (!element) return
    watch.disconnect()
    clearTimeout(timer)
    reveal(element)
  })
  const timer = setTimeout(() => {
    watch.disconnect()
    done(false)
  }, ${ms})
  watch.observe(document, { childList: true, subtree: true })
})`

export const mountBrowser: Mount<BrowserContent, BrowserOptions, BrowserViewer> = (
  element,
  { content, label, saved, live, snapshot, partition, picture: take, awake: startAwake, on },
) => {
  const document = element.ownerDocument
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
        ...(picture !== undefined && { picture }),
        ...(picture !== undefined && scrolled !== undefined && { scrolled }),
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
      destroy: () => root.remove(),
    }
  }

  // The picture, over where the page is, or in its place while it rests. Focusable, so
  // the person can reach it by keyboard, which wakes it where its host listens.
  const still = document.createElement("div")
  still.className = "browser-picture"
  still.tabIndex = 0
  const image = document.createElement("img")
  image.alt = label
  still.append(image)
  // Its fade, under way.
  let fading: ReturnType<typeof setTimeout> | undefined
  // Only a picture taken where it is: one of anywhere else would show the wrong page.
  const cover = (): boolean => {
    if (picture === undefined || picture.at !== place.url) return false
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
        still.remove()
        delete still.dataset.fading
      }, fadeMs)
    }, uncoverMs)
  }

  // Whether it's drawn: not inside an element kept out of sight, as with display: none.
  const shownNow = (): boolean => root.checkVisibility?.() !== false
  // The live page while there is one: none while it rests; and whether a wake opened it.
  let page: Webview | undefined
  let woken = false
  // A picture of the live page under way, after its load, to rest as.
  let freshening: ReturnType<typeof setTimeout> | undefined
  // Whether its host wants it live.
  let wanted = startAwake ?? true
  // A rest under way, waiting for its picture: a wake or a later rest drops it.
  let resting: object | undefined
  // Until its first load is done.
  let first = true
  // Moving to the shown fragment, whose scroll waits for the move.
  let moving = false

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
    run.catch(nothing).finally(uncover)
  }
  const stopped = (): void => {
    first = false
    moving = false
    if (load === "loading") report("ready")
    moved()
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
      // A wake's load isn't the show's: it goes again, afresh, once done.
      if (woken) stale = true
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
    if (errorCode !== aborted && isMainFrame !== false) report("failed")
  }
  const gone = (): void => {
    report("failed")
    uncover()
  }
  const titled = (event: Event): void => {
    const { title } = event as Event & { title?: string }
    if (typeof title === "string") on?.title?.(title)
  }
  const listeners: readonly (readonly [string, (event: Event) => void])[] = [
    ["dom-ready", moved],
    ["did-navigate", moved],
    ["did-navigate-in-page", movedInPage],
    ["did-start-loading", started],
    ["did-stop-loading", stopped],
    ["did-fail-load", failed],
    ["render-process-gone", gone],
    ["page-title-updated", titled],
  ]

  // Made here, not by a framework that may leave `allowpopups` off: Electron reads the
  // attributes once, as the view attaches. With it, a page's new windows reach the host's
  // lockdown, which opens one in the browser right after the person's click or key. The
  // lockdown gives it the pages' session whatever it asks; it's named to match.
  const open = (at: string, byWake: boolean): void => {
    woken = byWake
    const made = document.createElement("webview") as Webview
    made.setAttribute("partition", partition)
    made.setAttribute("allowpopups", "")
    made.setAttribute("src", at)
    page = made
    first = true
    moving = false
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
    if (!view || !take || load === "failed") return
    // Mid-load, it's pictured once loaded, unless a picture it has stands in meanwhile; a
    // load after its first, as a show's, then goes again, afresh, on waking. Out of sight, as
    // where its host keeps it hidden, it draws nothing to picture: the one it has stands in.
    const hidden = !shownNow()
    if (load === "loading" || hidden) {
      const standIn = (): void => {
        if (!cover()) return
        if (load === "loading" && !first) stale = true
        then = undefined
        close()
        report("ready")
      }
      if (picture === undefined || load === "loading") return standIn()
      // Out of sight, where it's scrolled can still be read, for it to wake there.
      const reading = attached(() => view.executeJavaScript(scrollRead))
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
      }
      // Nothing to rest as: live, until a later rest can take one.
      if (cover()) close()
    })
  }
  // A picture of the live page as it is now, and where it's scrolled; none where it can't.
  const snap = async (
    view: Webview,
  ): Promise<{ picture: Picture; scrolled: Scrolled | undefined } | undefined> => {
    const id = attached(() => view.getWebContentsId())
    if (id === undefined || !take) return undefined
    const at = place.url
    const reading = attached(() => view.executeJavaScript(scrollRead))?.catch(() => undefined)
    const [src, where] = await Promise.all([take(id).catch(() => undefined), reading])
    if (src === undefined) return undefined
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
      if (load !== "ready" || !shownNow() || using) return
      void snap(view).then((taken) => {
        if (!taken || page !== view || load !== "ready") return
        picture = taken.picture
        scrolled = taken.scrolled
        // Its host had it rest, but it had no picture to rest as until now.
        if (!wanted && cover()) close()
      })
    }, after)
  }
  // The pointer gone from it: a picture of it as the person left it.
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
  // Where it's going, as it may not be where its host showed it, until the page says.
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
      // At rest: it goes there, afresh, once woken.
      stale = true
      then = undefined
      scrolled = undefined
      place = { url: next.url, back: false, forward: false }
      on?.navigate?.(place)
    },
    state: () => state(place.url),
    restore: (earlier) => {
      const at = keptOf(earlier, shown)?.at
      // Already there: setting it again would load it again.
      if (at === undefined || at === place.url || !webAddress(at)) return
      page?.setAttribute("src", at)
      // Where it was scrolled was of where it was.
      if (!page) scrolled = undefined
      place = { url: at, back: place.back, forward: place.forward }
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
    pictured: () => picture !== undefined,
    destroy: () => {
      clearTimeout(fading)
      clearTimeout(freshening)
      resting = undefined
      if (page) for (const [type, listener] of listeners) page.removeEventListener(type, listener)
      root.remove()
    },
  }
}
