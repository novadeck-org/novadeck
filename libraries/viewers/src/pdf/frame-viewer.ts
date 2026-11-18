/* eslint-disable unicorn/consistent-function-scoping -- Its helpers stay inside it on purpose: it crosses into the frame as its source text, which names nothing outside it. */
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFWorker, RenderTask } from "pdfjs-dist"

// The PDF viewer as it runs inside its frame (see ../pdf.ts): pdf.js and this function come
// into the frame as text, from the app, and run there with an opaque origin, no network and
// no reach into the app's page. Everything it hears and says goes over `port`, whose other
// end the app holds.
//
// It draws the PDF page under page, each page on a canvas once it nears the view: fitted to
// the frame's width, never past its actual size, or zoomed. Ctrl/⌘+scroll and the keys zoom,
// a scroll moves through it, and a chip over it says which page is at its top and how far
// it's zoomed, and takes it back to fit. Only the pages are drawn: no annotation layer, so a
// link in it goes nowhere, no form is filled, and no script it carries runs.
//
// Self-contained: its source is sent into the frame and run there, so it names nothing
// outside itself but its argument and the frame's own globals. Types are erased.

/** What the frame hands the viewer: pdf.js, its worker script's address, and the port. */
export type PdfFrameEnvironment = {
  readonly pdfjs: typeof import("pdfjs-dist")
  readonly worker: string
  readonly port: MessagePort
}

export const pdfFrameViewer = ({ pdfjs, worker: workerUrl, port }: PdfFrameEnvironment): void => {
  type Zoom = "fit" | number
  type Place = { readonly page: number; readonly within: number; readonly zoom: Zoom }
  type Trouble = "password" | "unreadable"
  type Page = {
    readonly width: number
    readonly height: number
    readonly element: HTMLDivElement
    drawn: number | undefined
    sharp: number | undefined
    task: RenderTask | undefined
    drawing: number | undefined
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
  const troubleText: Record<Trouble, string> = {
    password: "This PDF is locked with a password, which Novadeck doesn't open.",
    unreadable: "This file couldn't be read as a PDF.",
  }
  const gestures = "Scroll with Ctrl or ⌘, or pinch, to zoom."

  const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), high)
  const isZoom = (zoom: unknown): zoom is Zoom =>
    zoom === "fit" || (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0)
  const isPlace = (place: unknown): place is Place => {
    const given = place as Partial<Place> | null
    return (
      Number.isInteger(given?.page) &&
      given!.page! >= 0 &&
      Number.isFinite(given?.within) &&
      isZoom(given?.zoom)
    )
  }
  const say = (message: Record<string, unknown>, transfer: Transferable[] = []): void =>
    port.postMessage(message, transfer)

  // The look, from the app's tokens (see `theme` below), with the same fallbacks pdf.css had.
  const style = document.createElement("style")
  style.textContent = `
    html, body { margin: 0; height: 100%; overflow: hidden; background: var(--pdf-ground, transparent); color-scheme: light dark; }
    body { display: flex; font: 13px system-ui, sans-serif; color: var(--pdf-notice-fg, CanvasText); }
    .pdf-viewer { position: relative; flex: 1; min-width: 0; min-height: 0; padding: var(--pdf-padding, 20px); overflow: auto; overscroll-behavior: contain; outline: none; }
    .pdf-pages { display: flex; flex-direction: column; align-items: center; gap: var(--pdf-gap, 12px); width: max-content; min-width: 100%; }
    .pdf-page { flex: none; overflow: hidden; background: var(--pdf-page-bg, white); box-shadow: var(--pdf-page-shadow, 0 1px 3px rgb(0 0 0 / 0.25)); }
    .pdf-page canvas { display: block; width: 100%; height: 100%; }
    .pdf-notice { position: absolute; inset: 0; display: grid; place-content: center; margin: 0; padding: 24px; text-align: center; }
    .pdf-notice[hidden], .pdf-chip[hidden] { display: none; }
    .pdf-chip { position: fixed; right: 18px; bottom: 10px; padding: 2px 8px; border: var(--pdf-chip-border, none); border-radius: var(--pdf-chip-radius, 6px); background: var(--pdf-chip-bg, rgb(0 0 0 / 0.6)); box-shadow: var(--pdf-chip-shadow, none); color: var(--pdf-chip-fg, white); font: var(--pdf-chip-font, inherit); font-variant-numeric: tabular-nums; cursor: pointer; }
    .pdf-chip:hover { background: var(--pdf-chip-hover-bg, var(--pdf-chip-bg, rgb(0 0 0 / 0.75))); }
  `
  document.head.append(style)
  const root = document.createElement("div")
  root.className = "pdf-viewer"
  root.tabIndex = 0
  root.setAttribute("role", "region")
  root.setAttribute("aria-busy", "true")
  root.setAttribute("aria-description", `${gestures} Plus and minus zoom, 0 fits.`)
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
  document.body.append(root, chip)

  // pdf.js's own files (CMaps, fonts, image decoders), asked of the app by name.
  let asked = 0
  const answers = new Map<number, (bytes: Uint8Array | undefined) => void>()
  const kinds: Record<string, string> = {
    cMapUrl: "cmap",
    standardFontDataUrl: "font",
    wasmUrl: "wasm",
  }
  class AppFiles {
    fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const asset = kinds[kind]
      if (!asset) return Promise.reject(new Error(`No ${kind}`))
      const id = (asked += 1)
      return new Promise((resolve, reject) => {
        answers.set(id, (bytes) => (bytes ? resolve(bytes) : reject(new Error(`No ${filename}`))))
        say({ type: "asset", id, kind: asset, name: filename })
      })
    }
  }
  const pdfWorker: PDFWorker = pdfjs.PDFWorker.create({ port: new Worker(workerUrl) })

  let current: PDFDocumentProxy | undefined
  let list: Page[] = []
  let zoom: Zoom = "fit"
  // Where to go once the pages are laid out: the place the app asked for, then the place kept
  // across a reload. While it's set, it is the viewer's place.
  let pending: Place | undefined
  let opened = 0
  let pass = 0
  // Where it was, while it has no size (its pane hidden), every offset reading 0.
  let held: Place | undefined
  let last: Place | undefined
  let told = ""
  const sized = (): boolean => root.clientWidth > 0 && root.clientHeight > 0
  const pixelRatio = (): number => window.devicePixelRatio || 1

  const scale = (): number => {
    if (zoom !== "fit") return zoom
    const widest = Math.max(1, ...list.map((page) => page.width))
    const padding = getComputedStyle(root)
    const across = parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight)
    return clamp((root.clientWidth - across) / (widest * pointPixels), least, 1)
  }

  const place = (): Place => {
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

  // Tells the app where it is, when that changed.
  const tell = (): void => {
    const now = place()
    const message = { type: "place", ...now, scale: scale(), pages: list.length }
    const text = JSON.stringify(message)
    if (text === told) return
    told = text
    say(message)
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
    tell()
  }

  // Lets go of a page's drawing, and of what pdf.js keeps to draw it again.
  const undraw = (page: Page, index: number): void => {
    page.task?.cancel()
    page.task = undefined
    page.drawing = undefined
    const drawn = page.drawn !== undefined
    page.drawn = page.sharp = undefined
    page.element.replaceChildren()
    if (drawn)
      void current?.getPage(index + 1).then(
        (proxy) => proxy.cleanup(),
        () => {},
      )
  }

  const settle = (): void => {
    cancelAnimationFrame(pass)
    pass = requestAnimationFrame(() => {
      showChip()
      drawAround()
    })
  }

  // Draws a page at the current scale and pixel density, unless it already is.
  const draw = async (index: number): Promise<void> => {
    const page = list[index]
    const shown = current
    const at = scale()
    const sharp = pixelRatio()
    const done = (): boolean => page?.drawn === at && page.sharp === sharp
    if (!page || !shown || done() || page.task) return
    const proxy = await shown.getPage(index + 1)
    if (shown !== current || page.task || done() || at !== scale()) return
    const viewport = proxy.getViewport({ scale: at * pointPixels })
    const ratio = Math.min(
      sharp,
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
    page.sharp = sharp
    page.element.replaceChildren(canvas)
    // Zoomed or resized as it drew: drawn again at the scale it's at now.
    if (at !== scale()) settle()
  }

  // Draws the pages in and around the view, and lets go of those far from it. Nothing while
  // it has no size: every page would read as in view.
  const drawAround = (): void => {
    if (list.length === 0 || pending || !sized()) return
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
  const layout = (keep: Place | undefined = place()): void => {
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

  const setZoom = (next: Zoom, keep?: Place): void => {
    const before = keep ?? place()
    zoom = next === "fit" ? "fit" : clamp(next, least, most)
    if (pending) {
      pending = { ...pending, zoom }
      return tell()
    }
    layout(before)
  }

  const trouble = (found: Trouble | null): void => {
    notice.textContent = found ? troubleText[found] : ""
    notice.hidden = found === null
    say({ type: "trouble", trouble: found })
  }

  const busy = (on: boolean): void => {
    root.setAttribute("aria-busy", String(on))
    say({ type: "busy", busy: on })
  }

  // Says why the PDF isn't drawn, in place of the last one's pages.
  const fail = (found: Trouble): void => {
    trouble(found)
    list.forEach(undraw)
    list = []
    pages.replaceChildren()
    void current?.loadingTask.destroy()
    current = undefined
    chip.hidden = true
    busy(false)
  }

  // Opens the PDF, laid out at its place: the one asked for, or where the last one was.
  const open = async (data: ArrayBuffer): Promise<void> => {
    const number = (opened += 1)
    busy(true)
    let loaded: PDFDocumentProxy
    let task: PDFDocumentLoadingTask | undefined
    try {
      task = pdfjs.getDocument({
        data: new Uint8Array(data),
        worker: pdfWorker,
        // Nothing the PDF names is fetched: fonts it doesn't hold are the system's, and pdf.js's
        // own files come from the app.
        useSystemFonts: true,
        enableXfa: false,
        stopAtErrors: false,
        useWorkerFetch: false,
        BinaryDataFactory: AppFiles,
      })
      loaded = await task.promise
    } catch (error) {
      // A document that didn't open still holds its bytes in the worker.
      void task?.destroy()
      if (number !== opened) return
      const name = (error as { readonly name?: unknown } | null)?.name
      return fail(name === "PasswordException" ? "password" : "unreadable")
    }
    if (number !== opened) return void loaded.loadingTask.destroy()
    const sizes = await Promise.all(
      Array.from({ length: loaded.numPages }, async (_, index) => {
        const viewport = (await loaded.getPage(index + 1)).getViewport({ scale: 1 })
        return { width: viewport.width, height: viewport.height }
      }),
    ).catch(() => undefined)
    if (number !== opened) return void loaded.loadingTask.destroy()
    if (!sizes) {
      void loaded.loadingTask.destroy()
      return fail("unreadable")
    }
    trouble(null)
    const keep = pending ?? (list.length > 0 ? place() : undefined)
    list.forEach(undraw)
    void current?.loadingTask.destroy()
    current = loaded
    list = sizes.map((size, index) => {
      const page = document.createElement("div")
      page.className = "pdf-page"
      page.setAttribute("aria-label", `Page ${index + 1}`)
      return {
        ...size,
        element: page,
        drawn: undefined,
        sharp: undefined,
        task: undefined,
        drawing: undefined,
      }
    })
    pages.replaceChildren(...list.map((page) => page.element))
    pending = undefined
    busy(false)
    layout(keep ?? { page: 0, within: 0, zoom })
  }

  root.addEventListener("scroll", settle, { passive: true })
  root.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      // A pinch comes as ctrl+wheel in pixels; a notch in lines or pages.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
      const delta = clamp(event.deltaY * unit, -wheelNotch, wheelNotch)
      if (delta) setZoom(scale() * Math.exp(-delta * wheelStep))
    },
    { passive: false },
  )
  // Its own keys zoom, and the page's own scroll it. The pane's keys it names to the app as
  // what the pane does for them: Escape hides it, Ctrl+PageDown and Ctrl+PageUp step its tabs.
  // No other key leaves the frame.
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return
    // Shift is left out: "+" takes it on most keyboards.
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey
    const control = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    const key = event.key
    if (plain && (key === "+" || key === "=")) setZoom(scale() * keyStep)
    else if (plain && (key === "-" || key === "_")) setZoom(scale() / keyStep)
    else if (plain && key === "0") setZoom("fit")
    else if (plain && !event.shiftKey && key === "Escape") say({ type: "action", action: "hide" })
    else if (control && key === "PageDown") say({ type: "action", action: "next-tab" })
    else if (control && key === "PageUp") say({ type: "action", action: "previous-tab" })
    else return
    event.preventDefault()
  })
  chip.addEventListener("click", () => setZoom("fit"))
  // A new width refits a fitted PDF, keeping its place; laid out in the next frame, so a
  // scrollbar that comes with it doesn't resize it again in the same frame.
  let width = 0
  let resizing = 0
  const onResize = (): void => {
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
  }
  new ResizeObserver(() => {
    cancelAnimationFrame(resizing)
    resizing = requestAnimationFrame(onResize)
  }).observe(root)
  // Moved to a screen of another pixel density: its pages are drawn again for it.
  let density: MediaQueryList | undefined
  const onDensity = (): void => {
    watchDensity()
    settle()
  }
  const watchDensity = (): void => {
    density?.removeEventListener("change", onDensity)
    density = matchMedia(`(resolution: ${pixelRatio()}dppx)`)
    density.addEventListener("change", onDensity)
  }
  watchDensity()

  // What the app says: a PDF's bytes, a place or zoom, its looks, focus, or a file pdf.js
  // asked for.
  port.addEventListener("message", ({ data }: MessageEvent) => {
    const message = data as Record<string, unknown> | null
    if (!message || typeof message.type !== "string") return
    if (message.type === "open" && message.bytes instanceof ArrayBuffer)
      return void open(message.bytes)
    if (message.type === "place" && isPlace(message.place)) {
      const wanted = message.place
      zoom = wanted.zoom
      if (pending || list.length === 0) {
        pending = wanted
        return tell()
      }
      if (!sized()) {
        held = wanted
        return tell()
      }
      return setZoom(wanted.zoom, wanted)
    }
    if (message.type === "zoom" && isZoom(message.zoom)) return setZoom(message.zoom)
    if (message.type === "focus") return root.focus({ preventScroll: true })
    if (message.type === "label" && typeof message.label === "string")
      return root.setAttribute("aria-label", message.label.slice(0, 256))
    // A scroll or pinch over the app's glass in front of the frame, while it hasn't the focus.
    if (
      message.type === "wheel" &&
      typeof message.x === "number" &&
      typeof message.y === "number" &&
      typeof message.mode === "number"
    ) {
      const unit = message.mode === 1 ? 16 : message.mode === 2 ? 400 : 1
      if (message.zoom !== true) return root.scrollBy(message.x * unit, message.y * unit)
      const delta = clamp(message.y * unit, -wheelNotch, wheelNotch)
      if (delta) setZoom(scale() * Math.exp(-delta * wheelStep))
      return
    }
    if (message.type === "theme" && message.tokens && typeof message.tokens === "object") {
      for (const [name, value] of Object.entries(message.tokens))
        if (name.startsWith("--pdf-") && typeof value === "string")
          document.documentElement.style.setProperty(name, value)
      if (message.scheme === "light" || message.scheme === "dark")
        document.documentElement.style.colorScheme = message.scheme
      return
    }
    if (message.type === "asset" && typeof message.id === "number") {
      const answer = answers.get(message.id)
      answers.delete(message.id)
      answer?.(message.bytes instanceof ArrayBuffer ? new Uint8Array(message.bytes) : undefined)
    }
  })
  port.start()
  say({ type: "ready" })
}
