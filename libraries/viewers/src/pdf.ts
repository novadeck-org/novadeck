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

// The pane's actions the frame may ask for: a burst past this is a frame misbehaving.
const actionsPerSecond = 5

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
  const notice = document.createElement("p")
  notice.className = "pdf-host-notice"
  notice.setAttribute("role", "alert")
  notice.hidden = true
  host.append(iframe, notice)
  element.append(host)

  let place: Place | undefined = isPdfState(saved) ? saved.pdf : undefined
  let opened: OpenFrame | undefined
  let ready = false
  let destroyed = false
  // What waits for the frame to be ready.
  const queue: { message: Record<string, unknown>; transfer: Transferable[] }[] = []
  const post = (message: Record<string, unknown>, transfer: Transferable[] = []): void => {
    if (destroyed) return
    if (!ready || !opened) return void queue.push({ message, transfer })
    opened.post(message, transfer)
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

  // A file pdf.js asked for, from the app's own, or none.
  const answer = async (id: number, kind: PdfAssetKind, name: string): Promise<void> => {
    const bytes = await assets?.(kind, name).catch(() => undefined)
    if (!bytes) return post({ type: "asset", id })
    const copy = bytes.slice().buffer
    post({ type: "asset", id, bytes: copy }, [copy])
  }

  let actions: number[] = []
  const act = (action: PdfPaneAction): void => {
    // Only for a key the person pressed in this PDF: its frame has the focus.
    if (document.activeElement !== iframe || !onAction) return
    const now = win.performance.now()
    actions = actions.filter((at) => now - at < 1000)
    if (actions.length >= actionsPerSecond) return
    actions.push(now)
    onAction(action)
  }

  const hear = (message: PdfFrameMessage): void => {
    switch (message.type) {
      case "ready":
        ready = true
        theme()
        for (const { message: queued, transfer } of queue.splice(0)) opened?.post(queued, transfer)
        return
      case "place":
        place = { page: message.page, within: message.within, zoom: message.zoom }
        return
      case "trouble":
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
    ready = false
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
    attributeFilter: ["class", "style", "data-theme"],
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
    focus: () => {
      iframe.focus({ preventScroll: true })
      post({ type: "focus" })
    },
    zoom: (next) => post({ type: "zoom", zoom: next }),
    destroy: () => {
      destroyed = true
      opened?.close()
      scheme.removeEventListener("change", theme)
      looks.disconnect()
      host.remove()
    },
  }
}
