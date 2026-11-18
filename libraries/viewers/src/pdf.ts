import type { FrameCode } from "./frame/host.js"
import { mountFrame } from "./frame/mount.js"
import type { Mount, Viewer, ViewerState } from "./index.js"
import { asClassic } from "./pdf/classic.js"
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
// (frame/frame.html, which the app serves) allows no network, no storage and no script but what
// this hands it (frame/mount.ts). A PDF's bytes go in, transferred; out come only the small
// messages pdf/messages.ts checks: where it is, why it isn't drawn, whether it's busy, which of pdf.js's
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

/** pdf.js's two modules as text: pdfjs-dist's `build/pdf.min.mjs` and its worker's. */
export type PdfCode = () => Promise<{ readonly library: string; readonly worker: string }>

/**
 * The frame, as the app serves it: its page's address (frame/frame.html, as `viewer-frame.html`
 * beside the app's own), and pdf.js, which it hands the frame. `viewer` is the source the frame
 * runs, pdf/frame-viewer.ts's own unless given, as a test of the frame's walls gives another.
 */
export type PdfFrame = {
  readonly url: string
  readonly code: PdfCode
  readonly viewer?: string
}

// pdf.js as the frame runs it, as classic scripts, converted once for every frame.
const converted = new WeakMap<PdfCode, FrameCode>()
export const pdfFrameCode = (code: PdfCode): FrameCode => {
  const known =
    converted.get(code) ??
    (async () => {
      const { library, worker } = await code()
      return {
        scripts: [asClassic(library, "pdfjsLib")],
        worker: asClassic(worker, "pdfjsWorker"),
      }
    })
  converted.set(code, known)
  return known
}

/** The frame's entry for a PDF viewer's source, which takes pdf.js, its worker and the port. */
export const pdfViewerSource = (viewer: string = pdfFrameViewer.toString()): string =>
  `function (frame) { (${viewer})({ pdfjs: self.pdfjsLib, worker: frame.worker, port: frame.port }) }`

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

// The files the frame may ask for: a burst past this is a frame misbehaving.
const assetsPerSecond = 16

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
  const win = element.ownerDocument.defaultView ?? window
  let place: Place | undefined = isPdfState(saved) ? saved.pdf : undefined

  // A file pdf.js asked for, from the app's own, or none; a frame asking past the rate gets none.
  let asked: number[] = []
  const answer = async (id: number, kind: PdfAssetKind, name: string): Promise<void> => {
    const now = win.performance.now()
    asked = asked.filter((at) => now - at < 1000)
    if (asked.length >= assetsPerSecond || !assets) return mounted.post({ type: "asset", id })
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
    if (!bytes) return mounted.post({ type: "asset", id })
    const copy = bytes.slice().buffer
    mounted.post({ type: "asset", id, bytes: copy }, [copy])
  }

  let trouble: PdfTrouble | null | undefined
  const mounted = mountFrame<Exclude<PdfFrameMessage, { type: "ready" | "busy" | "action" }>>(
    element,
    {
      name: "pdf",
      label,
      url: frame.url,
      code: pdfFrameCode(frame.code),
      viewer: pdfViewerSource(frame.viewer),
      tokens,
      stoppedText: "The PDF viewer stopped.",
      check: frameMessage,
      many: ["asset"],
      onStopped: () => onTrouble?.("unreadable"),
      onAction,
      hear: (message) => {
        switch (message.type) {
          case "place":
            place = { page: message.page, within: message.within, zoom: message.zoom }
            return
          case "trouble":
            if (message.trouble === trouble) return
            trouble = message.trouble
            return onTrouble?.(message.trouble)
          case "asset":
            return void answer(message.id, message.kind, message.name)
        }
      },
    },
  )

  const open = async (bytes: Blob): Promise<void> => {
    const data = await bytes.arrayBuffer()
    mounted.post({ type: "open", bytes: data }, [data])
  }

  if (place) mounted.post({ type: "place", place })
  void open(content.bytes)

  return {
    // A PDF written again opens where the last one was.
    update: (next) => void open(next.bytes),
    state: () => ({ pdf: place ?? { page: 0, within: 0, zoom: "fit" } }) as unknown as ViewerState,
    restore: (state) => {
      if (!isPdfState(state)) return
      place = state.pdf
      mounted.post({ type: "place", place: state.pdf })
    },
    jumpTo: () => {},
    focus: mounted.focus,
    zoom: (next) => mounted.post({ type: "zoom", zoom: next }),
    destroy: mounted.destroy,
  }
}
