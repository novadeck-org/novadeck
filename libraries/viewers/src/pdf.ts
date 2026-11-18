import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker, RenderTask } from "pdfjs-dist"

import type { Mount, Viewer, ViewerState } from "./index.js"

// A PDF, drawn page under page with pdf.js, each page on a canvas once it nears the view:
// fitted to the viewer's width, never past its actual size, or zoomed. Ctrl/⌘+scroll and
// the keys zoom, a scroll moves through it, and a chip over it says which page is at its top
// and how far it's zoomed, and takes it back to fit. Its state is that page, how far down it
// the view starts, and the zoom, so a PDF shown again opens where it was, whatever the
// viewer's size, and a PDF written again keeps its place.
//
// Only the pages are drawn: no annotation layer, so a link in it goes nowhere, no form is
// filled, and no script it carries runs (pdf.js runs a PDF's scripts only through its own
// sandbox, which isn't loaded), and nothing it holds is fetched. Its looks are pdf.css's.
//
// pdf.js reads PDFs in a worker, whose script (pdfjs-dist's `build/pdf.worker.min.mjs`) the
// app serves and names in `worker`, as its bundler gives the file's address. What pdf.js reads
// besides, the app hands it through `assets`, never fetched by an address: the Adobe CMaps a
// PDF's fonts may name (`cmaps/`), the standard fonts (`standard_fonts/`), and the decoders
// of scanned images, JPEG 2000 and JBIG2 (`wasm/`). Without it those draw as blanks.

/** A PDF's bytes, read afresh for each time it is opened, since pdf.js takes them. */
export type PdfContent = { readonly bytes: Blob }

/** Fitted to the viewer's width, or a scale of the PDF's actual size (1 is 100%). */
export type PdfZoom = "fit" | number

export type PdfViewer = Viewer<PdfContent> & {
  readonly zoom: (zoom: PdfZoom) => void
}

/**
 * One of pdf.js's own files, by its folder in pdfjs-dist (`cmap`: `cmaps/`, `font`:
 * `standard_fonts/`, `wasm`: `wasm/`) and its name there, as bytes.
 */
export type PdfAssets = (kind: "cmap" | "font" | "wasm", name: string) => Promise<Uint8Array>

// How pdf.js names what it asks the app for.
const assetKinds = { cMapUrl: "cmap", standardFontDataUrl: "font", wasmUrl: "wasm" } as const

// pdf.js's factory for its files, answering from `assets`.
const factoryOf = (assets: PdfAssets) =>
  class {
    fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const asset = assetKinds[kind as keyof typeof assetKinds]
      if (!asset) return Promise.reject(new Error(`pdf.js asked for an unknown ${kind}`))
      return assets(asset, filename)
    }
  }

/** Why a PDF isn't drawn: it asks for a password, or isn't a PDF pdf.js can read. */
export type PdfTrouble = "password" | "unreadable"

type PdfState = {
  readonly pdf: {
    // The page at the view's top, from 0, and how far down it the view starts, as a fraction
    // of its height.
    readonly page: number
    readonly within: number
    readonly zoom: PdfZoom
  }
}

// The furthest out and in it zooms, and a key's step. A wheel's step: a notch zooms by about
// 15%, while a pinch's smaller steps zoom as far as the fingers moved.
const least = 0.25
const most = 8
const keyStep = 1.25
const wheelStep = 0.01
const wheelNotch = 15
// A PDF's unit, the point, in CSS pixels: what pdf.js draws at 100%.
const pointPixels = 96 / 72
// How far beyond the view pages are drawn, and kept drawn, in views.
const drawAhead = 1
const keepAhead = 3
// The most pixels a page's canvas holds; a larger page is drawn at a lower resolution.
const canvasPixels = 16_777_216

const isZoom = (zoom: unknown): zoom is PdfZoom =>
  zoom === "fit" || (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0)

const isPdfState = (state: unknown): state is PdfState => {
  const pdf = (state as Partial<PdfState> | null)?.pdf
  return (
    Number.isInteger(pdf?.page) &&
    pdf!.page >= 0 &&
    Number.isFinite(pdf?.within) &&
    isZoom(pdf?.zoom)
  )
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

// The one worker every PDF is read in, started with the first, from the script it names.
const pdfjs = () => import("pdfjs-dist")
const workers = new Map<string, Promise<PDFWorker>>()
const workerOf = (src: string): Promise<PDFWorker> => {
  const started =
    workers.get(src) ??
    pdfjs().then(({ GlobalWorkerOptions, PDFWorker }) => {
      GlobalWorkerOptions.workerSrc = src
      return new PDFWorker()
    })
  workers.set(src, started)
  return started
}

const troubleText: Record<PdfTrouble, string> = {
  password: "This PDF is locked with a password, which Novadeck doesn't open.",
  unreadable: "This file couldn't be read as a PDF.",
}

const gestures = "Scroll with Ctrl or ⌘, or pinch, to zoom."
const keyHelp = "Reached by Tab: plus and minus zoom, 0 fits, Page Up and Page Down move a view."

/**
 * Mounts a PDF viewer, reading PDFs in the worker script at `worker`, with pdf.js's own files
 * from `assets`; `onTrouble` hears why a PDF it was given isn't drawn.
 */
export const mountPdf: Mount<
  PdfContent,
  {
    readonly worker: string
    readonly assets?: PdfAssets
    readonly onTrouble?: (trouble: PdfTrouble | null) => void
  },
  PdfViewer
> = (element, { content, label, saved, worker: workerSrc, assets, onTrouble }) => {
  const document = element.ownerDocument
  const win = document.defaultView ?? window
  // The chip sits over the pages, which scroll under it.
  const frame = document.createElement("div")
  frame.className = "pdf-frame"
  const root = document.createElement("div")
  root.className = "pdf-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  root.setAttribute("aria-description", `${gestures} ${keyHelp}`)
  root.setAttribute("aria-busy", "true")
  root.tabIndex = 0
  const pages = document.createElement("div")
  pages.className = "pdf-pages"
  const chip = document.createElement("button")
  chip.type = "button"
  chip.className = "pdf-chip"
  chip.hidden = true
  chip.title = `${gestures} Click to fit.`
  const notice = document.createElement("p")
  notice.className = "pdf-notice"
  notice.setAttribute("role", "alert")
  notice.hidden = true
  root.append(pages, notice)
  frame.append(root, chip)
  element.append(frame)

  // Each page: its size at 100% in points, its element, and what is drawn on it.
  type Page = {
    readonly width: number
    readonly height: number
    readonly element: HTMLDivElement
    drawn: number | undefined
    // The drawing under way, and the scale it draws at.
    task: RenderTask | undefined
    drawing: number | undefined
  }
  let current: PDFDocumentProxy | undefined
  let list: Page[] = []
  let zoom: PdfZoom = "fit"
  // Where to go once the pages are laid out: the saved place, then the place kept across a
  // reload. While it's set, it is the viewer's place.
  let pending: PdfState["pdf"] | undefined = isPdfState(saved) ? saved.pdf : undefined
  if (pending) zoom = pending.zoom
  // Each opened document's number, so a later one's answers win.
  let opened = 0
  let destroyed = false
  let pass = 0
  // Where it was, while it has no size (hidden, as a parked Focus terminal is), every offset
  // reading 0: the place it last had, or one asked for since, to go to once it has a size.
  let held: PdfState["pdf"] | undefined
  // The place it had when last measured with a size.
  let last: PdfState["pdf"] | undefined
  const sized = (): boolean => root.clientWidth > 0 && root.clientHeight > 0

  // The scale pages are drawn at, as a share of 100%: fitted to the viewer's width, or zoomed.
  const scale = (): number => {
    if (zoom !== "fit") return zoom
    const widest = Math.max(1, ...list.map((page) => page.width))
    const style = win.getComputedStyle(root)
    const across = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    return clamp((root.clientWidth - across) / (widest * pointPixels), least, 1)
  }

  // The page at the view's top, and how far down it the view starts.
  const place = (): PdfState["pdf"] => {
    if (pending || list.length === 0) return pending ?? { page: 0, within: 0, zoom }
    if (held || !sized()) return { ...(held ?? last ?? { page: 0, within: 0 }), zoom }
    const top = root.scrollTop
    let index = 0
    while (index + 1 < list.length && list[index + 1]!.element.offsetTop <= top) index += 1
    const page = list[index]!.element
    const within = clamp((top - page.offsetTop) / Math.max(page.offsetHeight, 1), 0, 1)
    last = { page: index, within, zoom }
    return last
  }

  const goTo = ({ page, within }: { readonly page: number; readonly within: number }): void => {
    const target = list[clamp(page, 0, list.length - 1)]?.element
    if (!target) return
    root.scrollTop = target.offsetTop + clamp(within, 0, 1) * target.offsetHeight
  }

  const showChip = (): void => {
    if (list.length === 0) return void (chip.hidden = true)
    const { page } = place()
    const percent = `${Math.round(scale() * 100)}%`
    chip.textContent = `${page + 1} / ${list.length} · ${percent}`
    chip.setAttribute(
      "aria-label",
      `Page ${page + 1} of ${list.length}, at ${percent}${zoom === "fit" ? ", fitted" : ""}`,
    )
    chip.hidden = false
  }

  // Lets go of a page's drawing, and of what pdf.js keeps to draw it again.
  const undraw = (page: Page, index: number): void => {
    page.task?.cancel()
    page.task = undefined
    page.drawing = undefined
    const drawn = page.drawn !== undefined
    page.drawn = undefined
    page.element.replaceChildren()
    if (drawn)
      void current?.getPage(index + 1).then(
        (proxy) => proxy.cleanup(),
        () => {},
      )
  }

  // Draws a page at the current scale, unless it already is, in device pixels.
  const draw = async (index: number): Promise<void> => {
    const page = list[index]
    const shown = current
    const at = scale()
    if (!page || !shown || page.drawn === at || page.task) return
    const proxy = await shown.getPage(index + 1)
    if (destroyed || shown !== current || page.task || page.drawn === at || at !== scale()) return
    const viewport = proxy.getViewport({ scale: at * pointPixels })
    const ratio = Math.min(
      win.devicePixelRatio || 1,
      Math.sqrt(canvasPixels / Math.max(viewport.width * viewport.height, 1)),
    )
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = proxy.render({
      canvas,
      viewport,
      ...(ratio !== 1 && { transform: [ratio, 0, 0, ratio, 0, 0] }),
    })
    page.task = task
    page.drawing = at
    try {
      await task.promise
    } catch {
      // Cancelled for a new scale or a new file, or a page pdf.js couldn't draw: left blank.
      if (page.task === task) page.task = page.drawing = undefined
      return
    }
    if (page.task !== task) return
    page.task = page.drawing = undefined
    page.drawn = at
    page.element.replaceChildren(canvas)
    // Zoomed or resized as it drew: drawn again at the scale it's at now.
    if (at !== scale()) settle()
  }

  // Draws the pages in and around the view, and lets go of those far from it.
  const drawAround = (): void => {
    if (list.length === 0 || pending) return
    const view = root.clientHeight
    const top = root.scrollTop
    list.forEach((page, index) => {
      const start = page.element.offsetTop
      const end = start + page.element.offsetHeight
      if (end >= top - view * drawAhead && start <= top + view * (1 + drawAhead)) void draw(index)
      else if (end < top - view * keepAhead || start > top + view * (1 + keepAhead))
        undraw(page, index)
    })
  }

  // Sizes each page for the current scale, keeping the page at the view's top where it is.
  // Without a size it only holds the place, to lay out once it has one.
  const layout = (keep: PdfState["pdf"] | undefined = place()): void => {
    if (!sized()) {
      held = keep ?? held
      return
    }
    held = undefined
    const at = scale()
    for (const page of list) {
      page.element.style.width = `${page.width * pointPixels * at}px`
      page.element.style.height = `${page.height * pointPixels * at}px`
      // A drawing at another scale is dropped; what was drawn before stretches until the new
      // one is in.
      if (page.task && page.drawing !== at) {
        page.task.cancel()
        page.task = page.drawing = undefined
      }
    }
    if (keep) goTo(keep)
    showChip()
    drawAround()
  }

  const settle = (): void => {
    win.cancelAnimationFrame(pass)
    pass = win.requestAnimationFrame(() => {
      showChip()
      drawAround()
    })
  }

  const setZoom = (next: PdfZoom, keep?: PdfState["pdf"]): void => {
    const before = keep ?? place()
    zoom = next === "fit" ? "fit" : clamp(next, least, most)
    if (pending) return void (pending = { ...pending, zoom })
    layout(before)
  }

  const trouble = (found: PdfTrouble | null): void => {
    notice.textContent = found ? troubleText[found] : ""
    notice.hidden = found === null
    onTrouble?.(found)
  }

  // Opens the PDF, laid out at its place: the saved one, or where the last one was.
  const open = async (bytes: Blob): Promise<void> => {
    const number = (opened += 1)
    root.setAttribute("aria-busy", "true")
    let loaded: PDFDocumentProxy
    let task: PDFDocumentLoadingTask | undefined
    try {
      const [{ getDocument }, worker, data] = await Promise.all([
        pdfjs(),
        workerOf(workerSrc),
        bytes.arrayBuffer(),
      ])
      if (destroyed || number !== opened) return
      task = getDocument({
        data: new Uint8Array(data),
        worker,
        // Nothing the PDF names is fetched: fonts it doesn't hold are the system's, and pdf.js's
        // own files come from the app.
        useSystemFonts: true,
        enableXfa: false,
        stopAtErrors: false,
        ...(assets && { useWorkerFetch: false, BinaryDataFactory: factoryOf(assets) }),
      })
      loaded = await task.promise
    } catch (error) {
      // A document that didn't open still holds its bytes in the worker.
      void task?.destroy()
      if (destroyed || number !== opened) return
      const name = (error as { readonly name?: unknown } | null)?.name
      trouble(name === "PasswordException" ? "password" : "unreadable")
      list.forEach(undraw)
      list = []
      pages.replaceChildren()
      void current?.loadingTask.destroy()
      current = undefined
      chip.hidden = true
      root.setAttribute("aria-busy", "false")
      return
    }
    if (destroyed || number !== opened) return void loaded.loadingTask.destroy()
    const sizes = await Promise.all(
      Array.from({ length: loaded.numPages }, async (_, index) => {
        const viewport = (await loaded.getPage(index + 1)).getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height }
      }),
    ).catch(() => undefined)
    if (destroyed || number !== opened) return void loaded.loadingTask.destroy()
    if (!sizes) {
      void loaded.loadingTask.destroy()
      root.setAttribute("aria-busy", "false")
      return trouble("unreadable")
    }
    trouble(null)
    // Where it was as it opened: a place asked for since, or the last PDF's.
    const keep = pending ?? (list.length > 0 ? place() : undefined)
    list.forEach(undraw)
    void current?.loadingTask.destroy()
    current = loaded
    list = sizes.map((size, index) => {
      const page = document.createElement("div")
      page.className = "pdf-page"
      page.dataset.page = String(index + 1)
      page.setAttribute("aria-label", `Page ${index + 1}`)
      return { ...size, element: page, drawn: undefined, task: undefined, drawing: undefined }
    })
    pages.replaceChildren(...list.map((page) => page.element))
    pending = undefined
    root.setAttribute("aria-busy", "false")
    layout(keep ?? { page: 0, within: 0, zoom })
  }

  const onScroll = (): void => settle()

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    // A pinch comes as ctrl+wheel in pixels; a notch in lines or pages.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
    const delta = clamp(event.deltaY * unit, -wheelNotch, wheelNotch)
    if (delta) setZoom(scale() * Math.exp(-delta * wheelStep))
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== root || event.defaultPrevented || event.isComposing) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const key = event.key
    if (key === "+" || key === "=") setZoom(scale() * keyStep)
    else if (key === "-" || key === "_") setZoom(scale() / keyStep)
    else if (key === "0") setZoom("fit")
    else return
    event.preventDefault()
  }

  chip.addEventListener("click", () => setZoom("fit"))
  root.addEventListener("scroll", onScroll, { passive: true })
  root.addEventListener("wheel", onWheel, { passive: false })
  root.addEventListener("keydown", onKeyDown)
  // A new width refits a fitted PDF, keeping its place.
  let width = 0
  const observer = new win.ResizeObserver(() => {
    // Hidden: it holds where it was. Shown again: back to it.
    if (!sized()) {
      held ??= last
      return
    }
    if (held) {
      width = root.clientWidth
      return layout(held)
    }
    if (root.clientWidth === width) return settle()
    width = root.clientWidth
    if (zoom === "fit" && list.length > 0) layout()
    else settle()
  })
  observer.observe(root)
  void open(content.bytes)

  return {
    // A PDF written again opens where the last one was.
    update: (next) => void open(next.bytes),
    state: () => ({ pdf: place() }) as unknown as ViewerState,
    restore: (state) => {
      if (!isPdfState(state)) return
      if (pending || list.length === 0) {
        pending = state.pdf
        zoom = state.pdf.zoom
        return
      }
      if (!sized()) {
        held = state.pdf
        zoom = state.pdf.zoom
        return
      }
      setZoom(state.pdf.zoom, state.pdf)
    },
    jumpTo: () => {},
    focus: () => root.focus({ preventScroll: true }),
    zoom: (next) => setZoom(next),
    destroy: () => {
      destroyed = true
      win.cancelAnimationFrame(pass)
      observer.disconnect()
      for (const page of list) page.task?.cancel()
      void current?.loadingTask.destroy()
      frame.remove()
    },
  }
}
