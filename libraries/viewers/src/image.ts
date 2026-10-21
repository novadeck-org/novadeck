import { hashOf } from "./hash.js"
import type { Mount, Viewer, ViewerState } from "./index.js"

// An image, fitted whole to its viewer, never larger than its own size, or zoomed in and
// moved about: pinch or Ctrl+scroll zooms around the pointer, a scroll or a drag moves a
// zoomed image, a double-click goes to its actual size and back, and keys do each while the
// viewer has focus. While it's zoomed, a chip over it says how far, and takes it back to
// fit. The zoom is part of its state, with the point of the image at the viewer's centre,
// so an image shown again keeps its view whatever the viewer's size. Its looks are
// image.css's.

export type ImageContent = { readonly src: string; readonly alt: string }

/** Fitted whole, or a scale of the image's own size (1 is its actual size). */
export type ImageZoom = "fit" | number

export type ImageViewer = Viewer<ImageContent> & {
  readonly zoom: (zoom: ImageZoom) => void
}

type ImageState = {
  readonly image: {
    // A hash of the image's address, which may be a whole image as a data URL.
    readonly src: string
    readonly zoom: ImageZoom
    // The point of the image at the viewer's centre, as fractions of its width and height.
    readonly x: number
    readonly y: number
  }
}

// The furthest in it zooms, and from where its pixels show square rather than smoothed.
const most = 32
const pixelated = 4
// A wheel's step: a notch zooms by about 15%, while a pinch's smaller steps zoom as far as
// the fingers moved. A key's step, and how far an arrow moves it.
const wheelStep = 0.01
const wheelNotch = 15
const keyStep = 1.25
const arrowStep = 40

// What names an image's address in its state: its length and a hash.
const keyOf = (src: string): string => `${src.length}:${hashOf(src)}`

const isZoom = (zoom: unknown): zoom is ImageZoom =>
  zoom === "fit" || (typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0)

const isImageState = (state: unknown): state is ImageState => {
  const image = (state as Partial<ImageState> | null)?.image
  return (
    typeof image?.src === "string" &&
    isZoom(image.zoom) &&
    typeof image.x === "number" &&
    typeof image.y === "number"
  )
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

// Where the image goes on one axis: centred while it fits, else with the point at the
// centre where asked, but never so far that ground shows past an edge.
const placeOn = (view: number, size: number, centre: number): number =>
  size <= view ? (view - size) / 2 : clamp(view / 2 - centre * size, view - size, 0)

const gestures = "Pinch or Ctrl+scroll to zoom, double-click for 100%, drag to move."

export const mountImage: Mount<ImageContent, Record<never, never>, ImageViewer> = (
  element,
  { content, label, saved },
) => {
  const document = element.ownerDocument
  const root = document.createElement("div")
  root.className = "image-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  // Focusable, so its keys reach it.
  root.tabIndex = 0
  const image = document.createElement("img")
  // A drag moves the image, rather than starting the browser's own.
  image.draggable = false
  const chip = document.createElement("button")
  chip.type = "button"
  chip.className = "image-zoom"
  chip.hidden = true
  chip.title = `${gestures} Click to fit.`
  root.append(image, chip)
  element.append(root)

  let shown = content
  let zoom: ImageZoom = "fit"
  let centre = { x: 0.5, y: 0.5 }
  // Where it last drew the image, in the viewer, while both have sizes.
  let drawn: { x: number; y: number; width: number; height: number; fit: number } | undefined

  // The image's size and the viewer's, and the scale that fits it whole inside the
  // viewer's padding without enlarging it; nothing while either has no size yet.
  const measure = () => {
    const { naturalWidth, naturalHeight } = image
    const { clientWidth, clientHeight } = root
    if (!naturalWidth || !naturalHeight || !clientWidth || !clientHeight) return undefined
    const style = getComputedStyle(root)
    const across = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const down = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const fit = Math.min(
      1,
      Math.max(clientWidth - across, 1) / naturalWidth,
      Math.max(clientHeight - down, 1) / naturalHeight,
    )
    return { naturalWidth, naturalHeight, clientWidth, clientHeight, fit }
  }

  const draw = (): void => {
    const view = measure()
    root.toggleAttribute("data-sized", Boolean(view))
    if (!view) {
      // Until then it sits in the viewer as any image would: a broken one shows its alt.
      drawn = undefined
      image.style.removeProperty("width")
      image.style.removeProperty("height")
      image.style.removeProperty("transform")
      root.removeAttribute("data-pannable")
      root.removeAttribute("data-pixelated")
      chip.hidden = true
      return
    }
    // A zoom that reaches fit, as the viewer grows, is fit again, and follows its size.
    if (zoom !== "fit" && zoom <= view.fit * 1.0001) zoom = "fit"
    const scale = zoom === "fit" ? view.fit : zoom
    const width = view.naturalWidth * scale
    const height = view.naturalHeight * scale
    const x = placeOn(view.clientWidth, width, centre.x)
    const y = placeOn(view.clientHeight, height, centre.y)
    centre = { x: (view.clientWidth / 2 - x) / width, y: (view.clientHeight / 2 - y) / height }
    drawn = { x, y, width, height, fit: view.fit }
    image.style.width = `${width}px`
    image.style.height = `${height}px`
    image.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    root.toggleAttribute(
      "data-pannable",
      width > view.clientWidth + 0.5 || height > view.clientHeight + 0.5,
    )
    root.toggleAttribute("data-pixelated", scale >= pixelated)
    chip.hidden = zoom === "fit"
    const percent = `${Math.round(scale * 100)}%`
    chip.textContent = percent
    chip.setAttribute("aria-label", `Zoomed to ${percent}. Back to fit`)
  }

  // Zooms to a scale, or to fit, keeping the image's point under `at` (a point in the
  // viewer, its centre unless given) where it is.
  const zoomTo = (next: ImageZoom, at?: { readonly x: number; readonly y: number }): void => {
    if (!drawn) {
      zoom = next
      return draw()
    }
    const point = at ?? { x: root.clientWidth / 2, y: root.clientHeight / 2 }
    const scale = next === "fit" ? drawn.fit : clamp(next, drawn.fit, most)
    const under = { x: (point.x - drawn.x) / drawn.width, y: (point.y - drawn.y) / drawn.height }
    const width = image.naturalWidth * scale
    const height = image.naturalHeight * scale
    zoom = next === "fit" ? "fit" : scale
    centre = {
      x: (root.clientWidth / 2 - (point.x - under.x * width)) / width,
      y: (root.clientHeight / 2 - (point.y - under.y * height)) / height,
    }
    draw()
  }
  const scaleNow = (): number => (zoom === "fit" ? (drawn?.fit ?? 1) : zoom)

  // Moves the view across the image by a distance, as a scroll would; whether it could.
  const pan = (dx: number, dy: number): boolean => {
    if (!drawn || !root.hasAttribute("data-pannable")) return false
    centre = { x: centre.x + dx / drawn.width, y: centre.y + dy / drawn.height }
    draw()
    return true
  }

  const pointIn = (event: MouseEvent): { x: number; y: number } => {
    const box = root.getBoundingClientRect()
    return {
      x: event.clientX - box.left - root.clientLeft,
      y: event.clientY - box.top - root.clientTop,
    }
  }

  const onWheel = (event: WheelEvent): void => {
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 40
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? root.clientHeight
          : 1
    if (event.ctrlKey || event.metaKey) {
      // Zoom gestures are the image's, never the page's.
      event.preventDefault()
      const delta = clamp(event.deltaY * unit, -wheelNotch, wheelNotch)
      if (delta) zoomTo(scaleNow() * Math.exp(-delta * wheelStep), pointIn(event))
      return
    }
    let dx = event.deltaX * unit
    let dy = event.deltaY * unit
    // A wheel turned with Shift moves it sideways, where the system doesn't already.
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0]
    if (pan(dx, dy)) event.preventDefault()
  }

  let dragging: { id: number; x: number; y: number } | undefined
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || chip.contains(event.target as Node)) return
    root.focus({ preventScroll: true })
    if (!root.hasAttribute("data-pannable")) return
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY }
    root.setAttribute("data-panning", "")
    try {
      root.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser doesn't know, as a made-up event's: moves still come while
      // it's over the viewer.
    }
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== dragging?.id) return
    pan(dragging.x - event.clientX, dragging.y - event.clientY)
    dragging = { ...dragging, x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== dragging?.id) return
    dragging = undefined
    root.removeAttribute("data-panning")
  }

  // A double-click goes to the image's actual size there, or twice it for one that fits at
  // its own size, and back to fit from any zoom.
  const onDoubleClick = (event: MouseEvent): void => {
    if (chip.contains(event.target as Node) || !drawn) return
    if (zoom !== "fit") return zoomTo("fit")
    zoomTo(drawn.fit < 1 ? 1 : 2, pointIn(event))
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return
    const arrows: Record<string, readonly [number, number]> = {
      ArrowLeft: [-arrowStep, 0],
      ArrowRight: [arrowStep, 0],
      ArrowUp: [0, -arrowStep],
      ArrowDown: [0, arrowStep],
    }
    const arrow = arrows[event.key]
    if (arrow) {
      if (pan(...arrow)) event.preventDefault()
      return
    }
    const keys: Record<string, () => void> = {
      "+": () => zoomTo(scaleNow() * keyStep),
      "=": () => zoomTo(scaleNow() * keyStep),
      "-": () => zoomTo(scaleNow() / keyStep),
      "0": () => zoomTo("fit"),
      "1": () => zoomTo(1),
    }
    const key = keys[event.key]
    if (!key) return
    event.preventDefault()
    key()
  }

  const onChip = (): void => {
    zoomTo("fit")
    root.focus({ preventScroll: true })
  }

  const observer = new (document.defaultView?.ResizeObserver ?? ResizeObserver)(draw)
  observer.observe(root)
  image.addEventListener("load", draw)
  image.addEventListener("error", draw)
  root.addEventListener("wheel", onWheel, { passive: false })
  root.addEventListener("pointerdown", onPointerDown)
  root.addEventListener("pointermove", onPointerMove)
  root.addEventListener("pointerup", onPointerUp)
  root.addEventListener("pointercancel", onPointerUp)
  root.addEventListener("dblclick", onDoubleClick)
  root.addEventListener("keydown", onKeyDown)
  chip.addEventListener("click", onChip)

  // Its address's key, kept while it shows: a data URL can be megabytes to hash.
  let key = ""
  const show = (): void => {
    key = keyOf(shown.src)
    image.src = shown.src
    image.alt = shown.alt
  }

  // A view of this image.
  const isPlace = (state: ViewerState | undefined): state is ImageState & ViewerState =>
    isImageState(state) && state.image.src === key

  const restore = (state: ViewerState): void => {
    if (!isPlace(state)) return
    zoom = state.image.zoom
    centre = { x: state.image.x, y: state.image.y }
    draw()
  }

  show()
  if (isPlace(saved)) restore(saved)
  else draw()

  return {
    // A new image keeps the view, as the next of a series would.
    update: (next) => {
      const previous = shown
      shown = next
      if (previous.src === next.src) {
        image.alt = next.alt
        return
      }
      show()
      draw()
    },
    state: () =>
      ({
        image: { src: key, zoom, x: centre.x, y: centre.y },
      }) satisfies ImageState as unknown as ViewerState,
    restore,
    // An image has no lines or text to jump to.
    jumpTo: () => undefined,
    focus: () => root.focus({ preventScroll: true }),
    zoom: (next) => zoomTo(next),
    destroy: () => {
      observer.disconnect()
      image.removeEventListener("load", draw)
      image.removeEventListener("error", draw)
      root.remove()
    },
  }
}
