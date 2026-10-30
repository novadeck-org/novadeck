import { hashOf } from "./hash.js"
import type { Mount, Viewer, ViewerState } from "./index.js"

// An image on a canvas: fitted whole and centred, never larger than its own size, or
// zoomed from half its fit up and moved about. Pinch or Ctrl/⌘+scroll zooms around the
// pointer, a drag moves it at any zoom and a scroll once it's zoomed or moved, a
// double-click zooms in there and back to fit, and keys do each once the viewer is reached
// by Tab. Once it's moved or zoomed, a chip over it says how far, and takes it back to fit.
// The zoom is part of its state, with the point of the image at the viewer's centre, so an
// image shown again keeps its view whatever the viewer's size. Its looks are image.css's.

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

// The furthest out it zooms, as a share of its fit, and the furthest in; and from where its
// pixels show square rather than smoothed.
const least = 0.5
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
    Number.isFinite(image.x) &&
    Number.isFinite(image.y)
  )
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

// Where the image goes on one axis: with the point at the centre where asked, but never so
// far that the viewer's centre is off the image.
const placeOn = (view: number, size: number, centre: number): number =>
  view / 2 - clamp(centre, 0, 1) * size

const gestures = "Pinch, or scroll with Ctrl or ⌘, to zoom; double-click to zoom in; drag to move."
const keyHelp = "Reached by Tab: plus and minus zoom, 0 fits, 1 shows 100%, the arrows move."

export const mountImage: Mount<ImageContent, Record<never, never>, ImageViewer> = (
  element,
  { content, label, saved },
) => {
  const document = element.ownerDocument
  // The window it's drawn in: its styles and its resizes.
  const win = document.defaultView ?? window
  const root = document.createElement("div")
  root.className = "image-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  // Focusable, so its keys reach it, which it names with its gestures.
  root.tabIndex = 0
  root.setAttribute("aria-description", `${gestures} ${keyHelp}`)
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
    const style = win.getComputedStyle(root)
    const across = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const down = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const fit = Math.min(
      1,
      Math.max(clientWidth - across, 1) / naturalWidth,
      Math.max(clientHeight - down, 1) / naturalHeight,
    )
    return { naturalWidth, naturalHeight, clientWidth, clientHeight, fit }
  }

  // Its focus goes back to the viewer as it hides, so its keys still reach it.
  const hideChip = (): void => {
    if (chip.hidden) return
    // Focus moves first: a hidden chip would let it go to nothing.
    if (document.activeElement === chip) root.focus({ preventScroll: true })
    chip.hidden = true
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
      root.removeAttribute("data-pixelated")
      hideChip()
      return
    }
    // Fitted, it's centred, and follows the viewer's size.
    if (zoom === "fit") centre = { x: 0.5, y: 0.5 }
    const scale = zoom === "fit" ? view.fit : clamp(zoom, view.fit * least, most)
    const width = view.naturalWidth * scale
    const height = view.naturalHeight * scale
    const x = placeOn(view.clientWidth, width, centre.x)
    const y = placeOn(view.clientHeight, height, centre.y)
    centre = { x: (view.clientWidth / 2 - x) / width, y: (view.clientHeight / 2 - y) / height }
    drawn = { x, y, width, height, fit: view.fit }
    image.style.width = `${width}px`
    image.style.height = `${height}px`
    image.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    root.toggleAttribute("data-pixelated", scale >= pixelated)
    if (zoom === "fit") hideChip()
    else chip.hidden = false
    const percent = `${Math.round(scale * 100)}%`
    chip.textContent = percent
    chip.setAttribute("aria-label", `Zoomed to ${percent}. Back to fit`)
  }

  // Zooms to a scale, or to fit, keeping the image's point under `at` (a point in the
  // viewer, its centre unless given) where it is.
  const zoomTo = (next: ImageZoom, at?: { readonly x: number; readonly y: number }): void => {
    if (!isZoom(next)) return
    if (!drawn) {
      zoom = next === "fit" ? next : Math.min(next, most)
      return draw()
    }
    const point = at ?? { x: root.clientWidth / 2, y: root.clientHeight / 2 }
    const scale = next === "fit" ? drawn.fit : clamp(next, drawn.fit * least, most)
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
  const scaleNow = (): number => (drawn ? drawn.width / image.naturalWidth : 1)

  // Moves the view across the image by a distance, as a scroll would, at any zoom: a fitted
  // image moved is no longer fitted. Whether it moved, as one held at its limit doesn't, so a
  // wheel there can scroll what's around it instead.
  const pan = (dx: number, dy: number): boolean => {
    if (!drawn || (!dx && !dy)) return false
    const before = drawn
    const fitted = zoom === "fit"
    if (fitted) zoom = drawn.fit
    centre = { x: centre.x + dx / drawn.width, y: centre.y + dy / drawn.height }
    draw()
    const moved =
      Math.abs((drawn?.x ?? before.x) - before.x) > 0.01 ||
      Math.abs((drawn?.y ?? before.y) - before.y) > 0.01
    if (!moved && fitted) {
      zoom = "fit"
      draw()
    }
    return moved
  }

  // How far the page scales the viewer, as Canvas does at its zoom: a pointer's distances
  // on screen are this many of the viewer's own pixels.
  const scaleOnScreen = (): { x: number; y: number } => {
    const box = root.getBoundingClientRect()
    return { x: box.width / root.offsetWidth || 1, y: box.height / root.offsetHeight || 1 }
  }

  const pointIn = (event: MouseEvent): { x: number; y: number } => {
    const box = root.getBoundingClientRect()
    const scale = scaleOnScreen()
    return {
      x: (event.clientX - box.left) / scale.x - root.clientLeft,
      y: (event.clientY - box.top) / scale.y - root.clientTop,
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
      // Zoom gestures are the image's, never the page's, though there's nothing to zoom
      // until it's drawn.
      event.preventDefault()
      if (!drawn) return
      const delta = clamp(event.deltaY * unit, -wheelNotch, wheelNotch)
      if (delta) zoomTo(scaleNow() * Math.exp(-delta * wheelStep), pointIn(event))
      return
    }
    // A page across is the viewer's width.
    let dx =
      event.deltaX * (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? root.clientWidth : unit)
    let dy = event.deltaY * unit
    // A wheel turned with Shift moves it sideways, where the system doesn't already.
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0]
    // A fitted image leaves the wheel to what's around it, as Grid scrolling past it: a drag
    // or the arrows move it.
    if (zoom !== "fit" && pan(dx, dy)) event.preventDefault()
  }

  let dragging:
    | {
        id: number
        x: number
        y: number
        scale: { x: number; y: number }
        from: { x: number; y: number }
      }
    | undefined
  // Whether its keys are the person's for the image: only once they reached it by Tab. A
  // press on it leaves their typing to what's around it, as a terminal the app sends it to,
  // where a digit may be an answer to an agent.
  let keyed = false
  // Whether a Tab is moving focus now, so focus arriving with it came by keyboard.
  let tabbing = false
  // Whether the last press went far enough to move the image: a click's jitter doesn't, and
  // a drag's clicks aren't a double-click.
  let dragged = false
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || chip.contains(event.target as Node)) return
    root.focus({ preventScroll: true })
    dragged = false
    if (!drawn) return
    const from = { x: event.clientX, y: event.clientY }
    dragging = { id: event.pointerId, ...from, scale: scaleOnScreen(), from }
    root.setAttribute("data-panning", "")
    try {
      root.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the browser doesn't know, as a made-up event's: moves still come while
      // it's over the viewer.
    }
  }
  const endDrag = (event: PointerEvent): void => {
    if (event.pointerId !== dragging?.id) return
    dragging = undefined
    root.removeAttribute("data-panning")
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== dragging?.id) return
    // A press that ended out of its sight, as its capture was lost.
    if (!(event.buttons & 1)) return endDrag(event)
    const { x, y, scale, from } = dragging
    dragged ||= Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4
    if (!dragged) return
    pan((x - event.clientX) / scale.x, (y - event.clientY) / scale.y)
    dragging = { ...dragging, x: event.clientX, y: event.clientY }
  }

  // A double-click zooms in there, to the image's actual size where it's fitted at half that
  // or less, else to twice its fit, and goes back to fit from any zoom.
  const onDoubleClick = (event: MouseEvent): void => {
    if (chip.contains(event.target as Node) || !drawn || dragged) return
    if (zoom !== "fit") return zoomTo("fit")
    zoomTo(drawn.fit <= 0.5 ? 1 : drawn.fit * 2, pointIn(event))
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      !keyed ||
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
    // Nothing to zoom until it's drawn.
    if (!key || !drawn) return
    event.preventDefault()
    key()
  }

  const onChip = (): void => {
    zoomTo("fit")
    root.focus({ preventScroll: true })
  }
  // Focus moves as a Tab's own action, before the next task; any other key, or a press,
  // ends its moment sooner, as input can come before that task.
  const onTab = (event: KeyboardEvent): void => {
    tabbing = event.key === "Tab"
    if (tabbing) setTimeout(() => (tabbing = false))
  }
  // Any press on it, of any button and on the chip too, takes its keys back; any press in
  // the page ends a Tab's moment.
  const onPress = (): void => {
    keyed = false
  }
  const onPagePress = (): void => {
    tabbing = false
  }
  // Reached by Tab, its keys are the person's; from elsewhere in the page, they aren't; back
  // from another window, or moving within itself, they stay as they were.
  const onFocusIn = (event: FocusEvent): void => {
    const from = event.relatedTarget as Node | null
    if (tabbing) keyed = true
    else if (from && !root.contains(from)) keyed = false
  }
  // Focus leaving it while the window keeps it, as for a blank spot or the page's next
  // control, ends them; a trip to another window doesn't.
  const onFocusOut = (event: FocusEvent): void => {
    if (!root.contains(event.relatedTarget as Node | null) && document.hasFocus()) keyed = false
  }

  const observer = new win.ResizeObserver(draw)
  observer.observe(root)
  image.addEventListener("load", draw)
  image.addEventListener("error", draw)
  root.addEventListener("wheel", onWheel, { passive: false })
  root.addEventListener("pointerdown", onPress, { capture: true })
  root.addEventListener("pointerdown", onPointerDown)
  root.addEventListener("pointermove", onPointerMove)
  root.addEventListener("pointerup", endDrag)
  root.addEventListener("pointercancel", endDrag)
  root.addEventListener("lostpointercapture", endDrag)
  root.addEventListener("dblclick", onDoubleClick)
  root.addEventListener("keydown", onKeyDown)
  root.addEventListener("focusin", onFocusIn)
  root.addEventListener("focusout", onFocusOut)
  document.addEventListener("keydown", onTab, { capture: true })
  document.addEventListener("pointerdown", onPagePress, { capture: true })
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
    zoom = state.image.zoom === "fit" ? "fit" : Math.min(state.image.zoom, most)
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
      document.removeEventListener("keydown", onTab, { capture: true })
      document.removeEventListener("pointerdown", onPagePress, { capture: true })
      image.removeEventListener("load", draw)
      image.removeEventListener("error", draw)
      root.remove()
    },
  }
}
