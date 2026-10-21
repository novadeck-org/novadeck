import { webAddress } from "./address.js"
import type { Mount, Viewer, ViewerState } from "./index.js"

// A web page. Live, it loads in Electron's <webview>, which the host's lockdown
// (./browser-host.ts) keeps to http(s), in memory, with no Node and no permissions; the
// viewer reports where it is and how its load went, and goes back, forward or reloads
// when asked. Shown again, it loads afresh and brings the element the show names into
// view. Where live pages aren't available (a plain browser, a demo), it shows a
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
}

// Electron's <webview>: its methods work once it's attached, and throw until then.
type Webview = HTMLElement & {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  getURL(): string
  setAudioMuted(muted: boolean): void
}

// Where the person had taken the page, from the address it was shown at, and the show
// it had carried out.
type BrowserState = {
  readonly browser: { readonly url: string; readonly at: string; readonly shown: number }
}

const isBrowserState = (state: unknown): state is BrowserState => {
  const browser = (state as Partial<BrowserState> | null)?.browser
  return (
    typeof browser?.url === "string" &&
    typeof browser.at === "string" &&
    typeof browser.shown === "number"
  )
}

const showOf = (content: BrowserContent): number => content.shown ?? 0

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
  { content, label, saved, live, snapshot, partition, on },
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
  // The element a show brings into view once the load under way is done; one a viewer of
  // the same show carried out already is done.
  let scrollTo = kept ? undefined : content.scroll
  const state = (at: string): ViewerState =>
    ({
      browser: { url: shown.url, at, shown: showOf(shown) },
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
        shown = next
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
      destroy: () => root.remove(),
    }
  }

  // Made here, not by a framework that may leave `allowpopups` off: Electron reads the
  // attributes once, as the view attaches. With it, a page's new windows reach the host's
  // lockdown, which opens one in the browser right after the person's click or key. The
  // lockdown gives it the pages' session whatever it asks; it's named to match.
  const page = document.createElement("webview") as Webview
  page.setAttribute("partition", partition)
  page.setAttribute("allowpopups", "")
  page.setAttribute("src", resumed)
  root.dataset.load = load
  on?.load?.(load)
  // Where it's going, as it may not be where its host showed it, until the page says.
  if (resumed !== content.url) on?.navigate?.(place)

  const moved = (): void => {
    attached(() => {
      page.setAudioMuted(muted)
      place = { url: page.getURL(), back: page.canGoBack(), forward: page.canGoForward() }
      on?.navigate?.(place)
    })
  }
  const started = (): void => report("loading")
  const reveal = (): void => {
    const selector = scrollTo
    scrollTo = undefined
    if (selector !== undefined)
      attached(() => void page.executeJavaScript(revealing(selector, scrollWaitMs)).catch(nothing))
  }
  const stopped = (): void => {
    if (load === "loading") report("ready")
    moved()
    if (load === "ready") reveal()
    else scrollTo = undefined
  }
  // Shown again: back at its address if the person went elsewhere, else reloaded, unless
  // it's loading that address already, as its first load.
  const refresh = (): void => {
    if (place.url !== shown.url) {
      // Attached, it loads the address even where its attribute already names it.
      const loading = attached(() => {
        void page.loadURL(shown.url).catch(nothing)
        return true
      })
      if (!loading) page.setAttribute("src", shown.url)
      place = { url: shown.url, back: place.back, forward: place.forward }
      on?.navigate?.(place)
      report("loading")
      return
    }
    if (load === "loading") return
    const reloading = attached(() => {
      page.reload()
      return true
    })
    if (reloading) report("loading")
  }
  const failed = (event: Event): void => {
    const { errorCode, isMainFrame } = event as Event & {
      errorCode?: number
      isMainFrame?: boolean
    }
    if (errorCode !== aborted && isMainFrame !== false) report("failed")
  }
  const gone = (): void => report("failed")
  const titled = (event: Event): void => {
    const { title } = event as Event & { title?: string }
    if (typeof title === "string") on?.title?.(title)
  }
  const listeners: readonly (readonly [string, (event: Event) => void])[] = [
    ["dom-ready", moved],
    ["did-navigate", moved],
    ["did-navigate-in-page", moved],
    ["did-start-loading", started],
    ["did-stop-loading", stopped],
    ["did-fail-load", failed],
    ["render-process-gone", gone],
    ["page-title-updated", titled],
  ]
  for (const [type, listener] of listeners) page.addEventListener(type, listener)
  root.append(page)

  return {
    update: (next) => {
      const previous = shown
      shown = next
      // Loaded after it attached, past the lockdown's check of its first address.
      if (!webAddress(next.url)) return
      const again = showOf(next) > showOf(previous)
      if (again) scrollTo = next.scroll
      if (previous.url === next.url) {
        if (!again) return
        refresh()
        if (load === "ready") reveal()
        return
      }
      page.setAttribute("src", next.url)
      // Where it's going, until the page says where it went.
      place = { url: next.url, back: place.back, forward: place.forward }
      on?.navigate?.(place)
    },
    state: () => state(place.url),
    restore: (earlier) => {
      const at = keptOf(earlier, shown)?.at
      // Already there: setting it again would load it again.
      if (at === undefined || at === place.url || !webAddress(at)) return
      page.setAttribute("src", at)
      place = { url: at, back: place.back, forward: place.forward }
      on?.navigate?.(place)
    },
    // A page has no lines to jump to that the viewer can know.
    jumpTo: () => undefined,
    focus: () => page.focus({ preventScroll: true }),
    back: () => attached(() => page.goBack()),
    forward: () => attached(() => page.goForward()),
    reload: () => attached(() => page.reload()),
    muted: (next) => {
      muted = next
      attached(() => page.setAudioMuted(muted))
    },
    destroy: () => {
      for (const [type, listener] of listeners) page.removeEventListener(type, listener)
      root.remove()
    },
  }
}
