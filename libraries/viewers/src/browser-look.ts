import type { BrowserWindow, BrowserWindowConstructorOptions, NativeImage } from "electron"

import { webAddress } from "./address.js"
import {
  clip,
  maxTroubles,
  originOf,
  type PageRequestFailure,
  type Trouble,
} from "./browser-trouble.js"

// An agent's look at a page no pane shows live, in Electron's main process: the address
// loaded afresh in a window of its own, out of sight, in the pages' session so a sign-in
// carries over, laid out as the pane would lay it out, and pictured. The window has the
// pane's pages' lockdown (no Node or preload, a sandbox, http(s) only, no popups) and is
// never shown, focused or kept: whatever happens, it is destroyed before the answer goes.

/** What a look lays out as: a desktop's window or a phone's screen, as the pane's switch has it. */
export type LookLayout = "desktop" | "phone"

/** The size each layout loads at, in CSS pixels: the pane's own (see the browser viewer). */
export const lookSizes: Readonly<
  Record<LookLayout, { readonly width: number; readonly height: number }>
> = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
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

// The qualities a too large picture is tried at, then its widths.
const qualities = [85, 70, 55, 40] as const

/**
 * A look under way, or a refusal: one at a time, as each loads a whole page in a renderer
 * of its own.
 */
export type Looker = {
  /** The picture of `url` loaded afresh as `layout`, else why there is none. */
  readonly look: (request: {
    readonly url: unknown
    readonly layout: unknown
  }) => Promise<LookResult>
  /**
   * Hands a failed request of the pages' session to the look it is for, by its view's web
   * contents id; false when no look has that view, so the request is another's.
   */
  readonly failed: (contentsId: number, failure: PageRequestFailure) => boolean
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

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    const done = (value: T | undefined): void => {
      clearTimeout(timer)
      resolve(value)
    }
    promise.then(done, () => done(undefined))
  })

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

// A phone's page has no scrollbar taking room, as in the pane.
const phoneLook = "html { scrollbar-width: none !important; }"

const busy = "Another picture of a page is being taken. Try again in a moment."

/**
 * Makes the looker of a host. `create` makes the window, and gets the options it must be
 * made with: the lockdown above, which a caller can't loosen; `partition` is the pages'
 * session (see `pagesSession`).
 */
export const createLooker = ({
  partition,
  create,
}: {
  readonly partition: string
  readonly create: (options: BrowserWindowConstructorOptions) => BrowserWindow
}): Looker => {
  let looking = false
  // The failures of the look under way's view, by its view's web contents id.
  const hearing = new Map<number, (failure: PageRequestFailure) => void>()
  const look: Looker["look"] = async ({ url, layout }) => {
    if (typeof url !== "string" || !webAddress(url))
      return { reason: "Novadeck only looks at http(s) pages." }
    if (layout !== "desktop" && layout !== "phone") return { reason: "That layout is unknown." }
    if (looking) return { reason: busy }
    looking = true
    const size = lookSizes[layout]
    let window: BrowserWindow | undefined
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
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          // Nothing it plays is heard.
          audio: false,
        },
      } as BrowserWindowConstructorOptions)
      return await loadAndPicture(window, url, layout, hearing)
    } catch {
      return { reason: "The page could not be pictured." }
    } finally {
      looking = false
      if (window && !window.isDestroyed()) window.destroy()
    }
  }
  return {
    look,
    failed: (contentsId, failure) => {
      const hear = hearing.get(contentsId)
      hear?.(failure)
      return hear !== undefined
    },
  }
}

const refuse = (event: { preventDefault: () => void }, to: string): void => {
  if (!webAddress(to)) event.preventDefault()
}

const loadAndPicture = async (
  window: BrowserWindow,
  url: string,
  layout: LookLayout,
  hearing: Map<number, (failure: PageRequestFailure) => void>,
): Promise<LookResult> => {
  const contents = window.webContents
  const id = contents.id
  const size = lookSizes[layout]
  contents.setAudioMuted(true)
  // No popup opens, and the page stays on http(s): the pane's guard, with no person to
  // click, so every window it asks for is refused.
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.on("will-navigate", refuse)
  contents.on("will-redirect", refuse)

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
    // A navigation that replaced the one loading isn't a failure.
    if (!main || code === -3 || originOf(validated) !== origin) return
    failedLoad = true
    tell({ kind: "load", text: clip(description || `Error ${code}`, 256) })
  })
  try {
    contents.on("did-finish-load", () => {
      if (layout === "phone") void contents.insertCSS(phoneLook).catch(() => {})
    })
    const loaded = new Promise<true>((resolve) => {
      contents.once("did-stop-loading", () => resolve(true))
    })
    // A load that fails outright still leaves the browser's own page for it to picture.
    void contents.loadURL(url).catch(() => {})
    const stopped = await within(loaded, lookLoadMs)
    if (!stopped && !failedLoad)
      tell({ kind: "load", text: `Still loading after ${lookLoadMs / 1000} seconds.` })
    await pause(lookSettleMs)
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
