import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  NativeImage,
  WebContents,
} from "electron"

import { webAddress } from "./address.js"
import { desktopWidth, type PageSize } from "./framing.js"
import { lockedPreferences } from "./lockdown.js"
import { phoneScreen, phoneStyle } from "./phone.js"
import {
  abortedLoad,
  clip,
  maxTroubles,
  originOf,
  type PageRequestFailure,
  type Trouble,
} from "./trouble.js"
import { wait, within } from "./wait.js"

// An agent's look at a page no pane shows live, in Electron's main process: the address
// loaded afresh in a window of its own, out of sight, in the pages' session so a sign-in
// carries over, laid out as the pane would lay it out, and pictured. The window has the
// pane's pages' lockdown (no Node or preload, a sandbox, http(s) only, no popups) and is
// never shown, focused or kept: whatever happens, it is destroyed before the answer goes.
// Only addresses the app allows (those on this machine) are looked at, and
// the page's navigations, redirects and frames are held to them, so no frame or page from
// elsewhere loads in the signed-in session. Its subresources (images, scripts, fetches) from
// other origins do load, as in the pane.

/**
 * The size a look loads at for each layout, in CSS pixels: the pane's own, a desktop's
 * window or a phone's screen, as the pane's switch has it (see `framingOf`).
 */
export const lookSizes: Readonly<
  Record<PageSize, { readonly width: number; readonly height: number }>
> = {
  desktop: { width: desktopWidth, height: 800 },
  phone: phoneScreen,
}

/** The widest a look's picture is, in device pixels. */
export const lookWidth = 1280
/** The most characters a look's picture may be, as `maxLookPicture` says. */
export const maxLookPicture = 4 * 1024 * 1024
/** How long a page may load, and how long it then settles, to draw what it fetched and ran. */
export const lookLoadMs = 6_000
export const lookSettleMs = 800
/** How long the picture itself may take; the whole look is over within a second or two of the sum. */
export const lookPictureMs = 1_500

/** The longest a look can take: its load, its settle and its picture, all at their limits. */
export const lookWorstMs = lookLoadMs + lookSettleMs + lookPictureMs

// The qualities a too large picture is tried at, then its widths.
const qualities = [85, 70, 55, 40] as const

/** How many looks wait for the one under way; one asked beyond them is refused. */
export const maxWaitingLooks = 4

/**
 * A look under way, or waiting its turn: one at a time, first come first served, as each
 * loads a whole page in a renderer of its own.
 */
export type Looker = {
  /** The picture of `url` loaded afresh as `layout`, else why there is none. */
  readonly look: (request: {
    readonly url: unknown
    readonly layout: unknown
    // When the caller stops waiting, in `Date.now()` milliseconds: a look not begun by then is dropped.
    readonly before?: unknown
  }) => Promise<LookResult>
  /**
   * Hands a failed request of the pages' session to the look it is for, by its view's web
   * contents id; false when no look has that view, so the request is another's.
   */
  readonly failed: (contentsId: number, failure: PageRequestFailure) => boolean
  /** Whether `window` is a look's, not one of the app's. */
  readonly is: (window: BrowserWindow) => boolean
}

export type LookResult =
  | {
      readonly picture: string
      readonly url: string
      readonly title: string
      readonly size: { readonly width: number; readonly height: number }
      readonly troubles: readonly Trouble[]
    }
  | { readonly reason: string }

/**
 * A JPEG `data:` address of `image` no wider than `lookWidth` and within `maxLookPicture`:
 * its quality lowered, then its width halved, until it fits. Undefined for no picture.
 */
export const lookPicture = (image: NativeImage): string | undefined => {
  if (image.isEmpty()) return undefined
  let drawn = image.getSize().width > lookWidth ? image.resize({ width: lookWidth }) : image
  for (let round = 0; round < 3; round += 1) {
    for (const quality of qualities) {
      const picture = `data:image/jpeg;base64,${drawn.toJPEG(quality).toString("base64")}`
      if (picture.length <= maxLookPicture) return picture
    }
    drawn = drawn.resize({ width: Math.max(1, Math.floor(drawn.getSize().width / 2)) })
  }
  return undefined
}

const busy = "Too many pictures of pages are waiting. Try again in a moment."

/**
 * Makes the desktop app's looker. `create` makes the window, and gets the options it must be
 * made with: the lockdown above, which a caller can't loosen; `partition` is the pages'
 * session (see `pagesSession`). `allow` says which addresses may be looked at, loaded or
 * framed (the app's: those on this machine); `forget` is told of each look's view once it
 * is gone, for whatever the app kept by its id.
 */
export const createLooker = ({
  partition,
  create,
  allow,
  forget,
  emulate,
}: {
  readonly partition: string
  readonly create: (options: BrowserWindowConstructorOptions) => BrowserWindow
  readonly allow: (address: string) => boolean
  readonly forget?: (contentsId: number) => void
  // Makes a look's view act as a phone's, as the pane's does; false when it can't.
  readonly emulate: (contents: WebContents) => Promise<boolean>
}): Looker => {
  let running = false
  // The looks waiting for their turn, which each is handed as the one before ends.
  const waiting: (() => void)[] = []
  const turn = async (): Promise<boolean> => {
    if (!running) {
      running = true
      return true
    }
    if (waiting.length >= maxWaitingLooks) return false
    await new Promise<void>((resolve) => waiting.push(resolve))
    return true
  }
  const next = (): void => {
    const following = waiting.shift()
    if (following) following()
    else running = false
  }
  const windows = new Set<BrowserWindow>()
  // The failures of the look under way's view, by its view's web contents id.
  const hearing = new Map<number, (failure: PageRequestFailure) => void>()
  const look: Looker["look"] = async ({ url, layout, before }) => {
    if (typeof url !== "string" || !webAddress(url) || !allow(url))
      return { reason: "Novadeck only looks at pages on this machine." }
    if (layout !== "desktop" && layout !== "phone") return { reason: "That layout is unknown." }
    if (!(await turn())) return { reason: busy }
    // Looks queue behind slower ones: one its caller has stopped waiting for is dropped
    // unbegun, so it doesn't hold up those after it.
    // Nor does one that couldn't end in time even at its slowest begin: the caller is gone by
    // then, and it would hold up all those behind it.
    if (typeof before === "number" && Date.now() + lookWorstMs > before) {
      next()
      return { reason: "Novadeck didn't get to this picture in time." }
    }
    const size = lookSizes[layout]
    let window: BrowserWindow | undefined
    // Read as it is made: a page that closes its own window leaves no view to ask after.
    let viewId: number | undefined
    try {
      window = create({
        width: size.width,
        height: size.height,
        useContentSize: true,
        // Never on screen, in the taskbar or in the way: it takes no focus and is no one's window.
        show: false,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        transparent: false,
        backgroundColor: "#ffffff",
        webPreferences: {
          partition,
          // Drawn to memory, so a window nobody sees still paints what a picture takes.
          offscreen: true,
          backgroundThrottling: false,
          ...lockedPreferences,
          // An alert or confirm would hold the look until it timed out.
          disableDialogs: true,
        },
      })
      viewId = window.webContents.id
      windows.add(window)
      return await loadAndPicture(window, url, layout, hearing, allow, emulate)
    } catch {
      return { reason: "The page could not be pictured." }
    } finally {
      if (window) {
        if (!window.isDestroyed()) window.destroy()
        windows.delete(window)
      }
      if (viewId !== undefined) forget?.(viewId)
      next()
    }
  }
  return {
    look,
    failed: (contentsId, failure) => {
      const hear = hearing.get(contentsId)
      hear?.(failure)
      return hear !== undefined
    },
    is: (window) => windows.has(window),
  }
}

const loadAndPicture = async (
  window: BrowserWindow,
  url: string,
  layout: PageSize,
  hearing: Map<number, (failure: PageRequestFailure) => void>,
  allow: (address: string) => boolean,
  emulate: (contents: WebContents) => Promise<boolean>,
): Promise<LookResult> => {
  const contents = window.webContents
  const id = contents.id
  const size = lookSizes[layout]
  contents.setAudioMuted(true)
  // No popup opens, and the page, its redirects and its frames stay on addresses the app
  // allows: the pane's guard, with no person to click, so every window it asks for is refused,
  // and a frame from elsewhere never loads in the signed-in session.
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  const refuse = (event: { preventDefault: () => void }, to: string): void => {
    if (!webAddress(to) || !allow(to)) event.preventDefault()
  }
  contents.on("will-navigate", refuse)
  contents.on("will-redirect", refuse)
  contents.on("will-frame-navigate", (details) => refuse(details, details.url))

  // What goes wrong while the page is at the origin it was asked at, as the pane counts it:
  // errors it logs, requests of that origin that fail, and a load that fails outright.
  const origin = originOf(url)
  const troubles: Trouble[] = []
  let failedLoad = false
  const atOrigin = (): boolean => originOf(contents.getURL()) === origin
  const tell = (trouble: Trouble): void => {
    if (troubles.length < maxTroubles) troubles.push(trouble)
  }
  contents.on("console-message", (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level !== "error" || originOf(sourceId) !== origin || !atOrigin()) return
    tell({
      kind: "error",
      text: clip(message, 1024),
      source: clip(sourceId, 2048),
      line: Number.isFinite(lineNumber) && lineNumber >= 0 ? Math.trunc(lineNumber) : 0,
    })
  })
  hearing.set(id, (failure) => {
    if (originOf(failure.url) !== origin) return
    if (failedLoad && failure.what === "page" && failure.status === 0) return
    tell({
      kind: "request",
      url: clip(failure.url, 2048),
      status: failure.status,
      what: clip(failure.what, 32),
    })
  })
  contents.on("did-fail-load", (_event, code, description, validated, main) => {
    if (!main || code === abortedLoad || originOf(validated) !== origin) return
    failedLoad = true
    tell({ kind: "load", text: clip(description || `Error ${code}`, 256) })
  })
  try {
    // A phone's screen, touch and user agent are set before the first document, as the pane's.
    // Its view has a document of its own first: emulation set on one with none crashes Chromium.
    if (layout === "phone") {
      await contents.loadURL("about:blank").catch(() => {})
      if (!(await emulate(contents)))
        return { reason: "The page could not be set up as a phone's." }
    }
    contents.on("did-finish-load", () => {
      if (layout === "phone") void contents.insertCSS(phoneStyle).catch(() => {})
    })
    const loaded = new Promise<true>((resolve) => {
      contents.once("did-stop-loading", () => resolve(true))
    })
    // A load that fails outright still leaves the browser's own page for it to picture.
    void contents.loadURL(url).catch(() => {})
    const stopped = await within(loaded, lookLoadMs)
    if (!stopped && !failedLoad)
      tell({ kind: "load", text: `Still loading after ${lookLoadMs / 1000} seconds.` })
    await wait(lookSettleMs)
    if (window.isDestroyed()) return { reason: "The page could not be pictured." }
    const image = await within(contents.capturePage(), lookPictureMs)
    const picture = image && lookPicture(image)
    if (!picture) return { reason: "The page drew nothing to take a picture of." }
    return {
      picture,
      url: clip(contents.getURL() || url, 2048),
      title: clip(contents.getTitle(), 1024),
      size,
      troubles,
    }
  } finally {
    hearing.delete(id)
  }
}
