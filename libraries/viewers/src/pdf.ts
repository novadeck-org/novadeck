import type { Mount, Viewer, ViewerState } from "./index.js"
import { openPdfFrame, type FrameCode, type OpenFrame } from "./pdf/frame-host.js"
import { pdfFrameViewer } from "./pdf/frame-viewer.js"
import {
  frameMessage,
  type PdfAssetKind,
  type PdfFrameMessage,
  type PdfPaneAction,
  type PdfTrouble,
  type PdfZoom,
} from "./pdf/messages.js"

export type { PdfPaneAction, PdfTrouble, PdfZoom } from "./pdf/messages.js"

// A PDF, drawn by pdf.js in a frame of its own (pdf/frame-viewer.ts), never in the app's page:
// the frame is sandboxed with scripts only, so it has an opaque origin, and its page
// (pdf/frame.html, which the app serves) allows no network, no storage and no script but what
// this hands it. A PDF's bytes go in, transferred; out come only the small messages
// pdf/messages.ts checks: where it is, why it isn't drawn, whether it's busy, which of pdf.js's
// own files it needs, and the pane's actions for its keys. A script a PDF somehow ran in the
// frame reaches neither the app's page, its storage, nor its connection to the runner.
//
// In the frame, a PDF is drawn page under page, fitted to the frame's width, never past its
// actual size, or zoomed; a chip names the page at the top and the zoom. Its state, kept as
// the other viewers' is, is that page, how far down it the view starts, and the zoom, which the
// frame reports as it changes.

/** A PDF's bytes, read afresh for each time it is opened, since they go to the frame. */
export type PdfContent = { readonly bytes: Blob }

export type PdfViewer = Viewer<PdfContent> & {
  readonly zoom: (zoom: PdfZoom) => void
}

/**
 * One of pdf.js's own files, by its folder in pdfjs-dist (`cmap`: `cmaps/`, `font`:
 * `standard_fonts/`, `wasm`: `wasm/`) and its name there, as bytes.
 */
export type PdfAssets = (kind: PdfAssetKind, name: string) => Promise<Uint8Array>

/**
 * The frame, as the app serves it: its page's address (pdf/frame.html, as `pdf-frame.html`
 * beside the app's own), and pdf.js's two modules as text (pdfjs-dist's `build/pdf.min.mjs`
 * and `build/pdf.worker.min.mjs`), which it hands the frame. `viewer` is the source the frame
 * runs, pdf/frame-viewer.ts's own unless given, as a test of the frame's walls gives another.
 */
export type PdfFrame = {
  readonly url: string
  readonly code: FrameCode
  readonly viewer?: string
}

type Place = { readonly page: number; readonly within: number; readonly zoom: PdfZoom }
type PdfState = { readonly pdf: Place }

const isPlace = (place: unknown): place is Place => {
  const given = place as Partial<Place> | null
  return (
    Number.isInteger(given?.page) &&
    given!.page! >= 0 &&
    Number.isFinite(given?.within) &&
    (given?.zoom === "fit" || (typeof given?.zoom === "number" && given.zoom > 0))
  )
}
const isPdfState = (state: unknown): state is PdfState =>
  isPlace((state as Partial<PdfState> | null)?.pdf)

// The tokens the frame draws with, read from where the viewer mounts (see pdf.css).
const tokens = [
  "--pdf-ground",
  "--pdf-padding",
  "--pdf-gap",
  "--pdf-page-bg",
  "--pdf-page-shadow",
  "--pdf-notice-fg",
  "--pdf-chip-bg",
  "--pdf-chip-fg",
  "--pdf-chip-border",
  "--pdf-chip-radius",
  "--pdf-chip-shadow",
  "--pdf-chip-font",
  "--pdf-chip-hover-bg",
]

// The pane's actions the frame may ask for, and files: a burst past this is a frame
// misbehaving. How long a frame has to start, and what may wait for it meanwhile.
const actionsPerSecond = 5
const assetsPerSecond = 16
const startMs = 30_000
const queued = 16

// pdf.js's own files as handed over, read once for every frame: a frame asking again, or
// many at once, costs the app's page nothing more.
const read = new Map<string, Promise<Uint8Array | undefined>>()

/**
 * Mounts a PDF viewer in its frame. `onTrouble` hears why a PDF it was given isn't drawn;
 * `onAction` hears what the pane does for a key pressed in the PDF, only while the frame has
 * the focus.
 */
export const mountPdf: Mount<
  PdfContent,
  {
    readonly frame: PdfFrame
    readonly assets?: PdfAssets
    readonly onTrouble?: (trouble: PdfTrouble | null) => void
    readonly onAction?: (action: PdfPaneAction) => void
  },
  PdfViewer
> = (element, { content, label, saved, frame, assets, onTrouble, onAction }) => {
  const document = element.ownerDocument
  const win = document.defaultView ?? window
  const host = document.createElement("div")
  host.className = "pdf-host"
  host.setAttribute("aria-busy", "true")
  const iframe = document.createElement("iframe")
  // Scripts only: no same origin, so the frame's is opaque, and no popups, forms, top
  // navigation or downloads.
  iframe.setAttribute("sandbox", "allow-scripts")
  iframe.referrerPolicy = "no-referrer"
  iframe.title = label
  iframe.className = "pdf-frame"
  // Reached through the glass, never by Tab straight into the frame.
  iframe.tabIndex = -1
  // Over the frame while it hasn't the focus, so only the person gives it the focus: a press on
  // it, or Tab to it, lets the frame have it. A scroll or pinch over it goes to the frame.
  const glass = document.createElement("div")
  glass.className = "pdf-glass"
  glass.tabIndex = 0
  glass.setAttribute("role", "button")
  glass.setAttribute("aria-label", label)
  const notice = document.createElement("p")
  notice.className = "pdf-host-notice"
  notice.setAttribute("role", "alert")
  notice.hidden = true
  host.append(iframe, glass, notice)
  element.append(host)

  let place: Place | undefined = isPdfState(saved) ? saved.pdf : undefined
  let opened: OpenFrame | undefined
  let ready = false
  let destroyed = false
  // Let go of: nothing more goes to it.
  let stopped = false
  // What waits for the frame to be ready: of each kind but files, only the latest, so a
  // file rewritten again and again holds one copy of its bytes.
  let queue: { message: Record<string, unknown>; transfer: Transferable[] }[] = []
  const post = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    if (destroyed || stopped) return
    if (ready && opened) return opened.post(message, transfer)
    if (message.type !== "asset") queue = queue.filter((each) => each.message.type !== message.type)
    if (queue.length < queued) queue.push({ message, transfer })
  }

  const theme = (): void => {
    const style = win.getComputedStyle(host)
    const values: Record<string, string> = {}
    for (const token of tokens) {
      const value = style.getPropertyValue(token).trim()
      if (value) values[token] = value
    }
    const scheme = win.getComputedStyle(document.documentElement).colorScheme
    const dark = /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)
    const light = /\blight\b/.test(scheme) && !/\bdark\b/.test(scheme)
    const preferred = win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    post({ type: "theme", tokens: values, scheme: dark ? "dark" : light ? "light" : preferred })
  }

  // A file pdf.js asked for, from the app's own, or none; a frame asking past the rate gets none.
  let asked: number[] = []
  const answer = async (id: number, kind: PdfAssetKind, name: string): Promise<void> => {
    const now = win.performance.now()
    asked = asked.filter((at) => now - at < 1000)
    if (asked.length >= assetsPerSecond || !assets) return post({ type: "asset", id })
    asked.push(now)
    const key = `${kind}/${name}`
    // One that couldn't be read, as a chunk that didn't load, is read again next time.
    const known =
      read.get(key) ??
      assets(kind, name).catch(() => {
        read.delete(key)
        return undefined
      })
    read.set(key, known)
    const bytes = await known
    if (!bytes) return post({ type: "asset", id })
    const copy = bytes.slice().buffer
    post({ type: "asset", id, bytes: copy }, [copy])
  }

  let actions: number[] = []
  const act = (action: PdfPaneAction): void => {
    // Only for a key the person pressed in this PDF: its frame has the focus they gave it.
    if (!given || document.activeElement !== iframe || !onAction) return
    const now = win.performance.now()
    actions = actions.filter((at) => now - at < 1000)
    if (actions.length >= actionsPerSecond) return
    actions.push(now)
    onAction(action)
  }

  let trouble: PdfTrouble | null | undefined
  const hear = (message: PdfFrameMessage): void => {
    switch (message.type) {
      case "ready":
        if (ready) return
        ready = true
        win.clearTimeout(starting)
        opened?.post({ type: "label", label })
        theme()
        for (const { message: waiting, transfer } of queue.splice(0))
          opened?.post(waiting, transfer)
        return
      case "place":
        place = { page: message.page, within: message.within, zoom: message.zoom }
        return
      case "trouble":
        if (message.trouble === trouble) return
        trouble = message.trouble
        return onTrouble?.(message.trouble)
      case "busy":
        return host.setAttribute("aria-busy", String(message.busy))
      case "asset":
        return void answer(message.id, message.kind, message.name)
      case "action":
        return act(message.action)
    }
  }

  // The frame went somewhere else than its page, which only a script in it could do: it's
  // let go of, and says so.
  const stop = (): void => {
    stopped = true
    ready = false
    queue = []
    opened?.close()
    win.clearTimeout(starting)
    iframe.remove()
    notice.textContent = "The PDF viewer stopped."
    notice.hidden = false
    host.setAttribute("aria-busy", "false")
    onTrouble?.("unreadable")
  }

  opened = openPdfFrame({
    iframe,
    url: frame.url,
    code: frame.code,
    viewer: frame.viewer ?? pdfFrameViewer.toString(),
    hear: (data) => {
      const message = frameMessage(data)
      if (message) hear(message)
    },
    stopped: stop,
  })
  // A frame that never starts, as when pdf.js couldn't be read, is let go of too.
  const starting = win.setTimeout(() => {
    if (!ready && !destroyed) stop()
  }, startMs)

  // The frame takes the focus only when the person gives it: through the glass, or when the app
  // focuses the viewer. Taken any other way, by a script in the frame, it goes back to where it
  // was, so nothing typed for elsewhere reaches the frame.
  let given = false
  let before: Element | null = null
  const give = (): void => {
    given = true
    iframe.focus({ preventScroll: true })
    // A frame that couldn't take it, as one hidden, wasn't given it.
    given = document.activeElement === iframe
    if (given) post({ type: "focus" })
  }
  const remember = (event: FocusEvent): void => {
    if (event.target !== iframe) before = event.target as Element
  }
  // The frame has the focus it wasn't given: back where it was. A frame the person used may take
  // it with no event on the iframe here, so each focus that leaves something here is checked too.
  const putBack = (): void => {
    if (given || stopped || document.activeElement !== iframe) return
    const back = before as HTMLElement | null
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true })
    else iframe.blur()
  }
  let checking = 0
  const check = (): void => {
    win.clearTimeout(checking)
    checking = win.setTimeout(putBack, 0)
  }
  document.addEventListener("focusin", remember, true)
  document.addEventListener("focusout", check, true)
  iframe.addEventListener("focus", () => {
    if (given) return void (glass.hidden = true)
    putBack()
  })
  iframe.addEventListener("blur", () => {
    given = false
    glass.hidden = false
  })
  glass.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    give()
  })
  glass.addEventListener("focus", give)
  // A scroll or pinch over the glass scrolls or zooms the PDF, as over the frame.
  glass.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault()
      post({
        type: "wheel",
        x: event.deltaX,
        y: event.deltaY,
        mode: event.deltaMode,
        zoom: event.ctrlKey || event.metaKey,
      })
    },
    { passive: false },
  )

  const open = async (bytes: Blob): Promise<void> => {
    const data = await bytes.arrayBuffer()
    post({ type: "open", bytes: data }, [data])
  }

  // The app's light or dark, and its tokens, as they change.
  const scheme = win.matchMedia("(prefers-color-scheme: dark)")
  scheme.addEventListener("change", theme)
  const looks = new win.MutationObserver(theme)
  looks.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-scheme"],
  })

  if (place) post({ type: "place", place })
  void open(content.bytes)

  return {
    // A PDF written again opens where the last one was.
    update: (next) => void open(next.bytes),
    state: () => ({ pdf: place ?? { page: 0, within: 0, zoom: "fit" } }) as unknown as ViewerState,
    restore: (state) => {
      if (!isPdfState(state)) return
      place = state.pdf
      post({ type: "place", place: state.pdf })
    },
    jumpTo: () => {},
    focus: give,
    zoom: (next) => post({ type: "zoom", zoom: next }),
    destroy: () => {
      destroyed = true
      win.clearTimeout(starting)
      document.removeEventListener("focusin", remember, true)
      document.removeEventListener("focusout", check, true)
      win.clearTimeout(checking)
      opened?.close()
      scheme.removeEventListener("change", theme)
      looks.disconnect()
      host.remove()
    },
  }
}
