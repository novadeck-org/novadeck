import type { Mount, Viewer, ViewerState } from "./index.js"

// A web page. Live, it loads in Electron's <webview>, which the host's lockdown
// (./browser-host.ts) keeps to http(s), in memory, with no Node and no permissions; the
// viewer reports where it is and how its load went, and goes back, forward or reloads
// when asked. Where live pages aren't available (a plain browser, a demo), it shows a
// snapshot of the page, or nothing, for the host to say why. Its looks are browser.css's.

export type BrowserContent = { readonly url: string }

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
  getURL(): string
  setAudioMuted(muted: boolean): void
}

// Where the person had taken the page, from the address it was shown at.
type BrowserState = { readonly browser: { readonly url: string; readonly at: string } }

const isBrowserState = (state: unknown): state is BrowserState => {
  const browser = (state as Partial<BrowserState> | null)?.browser
  return typeof browser?.url === "string" && typeof browser.at === "string"
}

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
  const resumed =
    isBrowserState(saved) && saved.browser.url === content.url ? saved.browser.at : content.url
  let place: Place = { url: resumed, back: false, forward: false }
  let load: Load = "loading"
  let muted = false

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
      state: () =>
        ({
          browser: { url: shown.url, at: shown.url },
        }) satisfies BrowserState as unknown as ViewerState,
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

  const moved = (): void => {
    attached(() => {
      page.setAudioMuted(muted)
      place = { url: page.getURL(), back: page.canGoBack(), forward: page.canGoForward() }
      on?.navigate?.(place)
    })
  }
  const started = (): void => report("loading")
  const stopped = (): void => {
    if (load === "loading") report("ready")
    moved()
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
      if (previous.url !== next.url) page.setAttribute("src", next.url)
    },
    state: () =>
      ({
        browser: { url: shown.url, at: place.url },
      }) satisfies BrowserState as unknown as ViewerState,
    restore: (state) => {
      if (isBrowserState(state) && state.browser.url === shown.url)
        page.setAttribute("src", state.browser.at)
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
