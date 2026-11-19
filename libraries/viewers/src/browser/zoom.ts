import {
  between,
  easeOf,
  framingOf,
  liftAbout,
  liftAtRail,
  onPhone,
  phoneAt,
  phoneTravel,
  phoneZoomOf,
  railEnd,
  railInset,
  railOf,
  railWidth,
  type Framing,
  type PageSize,
} from "./framing.js"

// A phone zooms from fit to one level on a double-click around it, easing about the pointer,
// and back on another, or on Esc, which the pane asks of the viewer (`unzoom`) before it hides.
// Zoomed, it's taller than the viewer: a rail in the viewer's
// right margin shows which part is in view, and moves it, as Shift+scroll over the stage does. The viewer
// sets --browser-view-scale and the rest of its framing from `framing` and `viewScale` (see
// browser.css), and data-zoom on itself for the cursor: "in" where a double-click would
// zoom, "out" where it would zoom back.

/** How long the zoom eases, in milliseconds. */
export const zoomMs = 300
/** How long the hint to zoom stays up, and how long it takes to go. */
export const hintMs = 4_000
export const hintFadeMs = 200
/** A press and release this far apart, in pixels, is a drag, not a click. */
const dragPx = 4
/** How far an arrow key moves the phone, of its travel. */
const arrowLift = 0.1

/** Where a zoomed phone was left, kept with the page. */
export type KeptZoom = { readonly lift: number }

export const isKeptZoom = (value: unknown): value is KeptZoom => {
  const lift = (value as Partial<KeptZoom> | null)?.lift
  return typeof lift === "number" && lift >= 0 && lift <= 1
}

export type ZoomOptions = {
  /** What the page lays out as: only a phone's zooms. */
  readonly size: () => PageSize
  /** The viewer's size, in CSS pixels. */
  readonly stage: () => { readonly width: number; readonly height: number }
  /** Where the phone is drawn now, for a press on the stage around it, not on it. */
  readonly phone: () => Framing | undefined
  /** The framing changed: the viewer frames its page again. */
  readonly changed: () => void
  /** Whether the viewer is shown: on screen, not hidden. */
  readonly shown: () => boolean
  /** Where the phone was left when the page was last shown. */
  readonly kept?: KeptZoom
  /** The one-time line about zooming: whether the person has seen it, and that they now have. */
  readonly hint?: { readonly seen: () => boolean; readonly see: () => void }
  /** Whether motion is off, as the person asked: the zoom goes at once. */
  readonly calm: () => boolean
}

export type PhoneZoom = {
  /** Where the phone is drawn while zoomed or easing, else undefined: fit, as `framingOf` says. */
  readonly framing: () => Framing | undefined
  /** The scale its view and page are drawn at while zoomed or easing, else undefined. */
  readonly viewScale: () => number | undefined
  /** Whether it's zoomed, or on its way, or asked to, though the viewer is too narrow now. */
  readonly zoomed: () => boolean
  /** What the page keeps of it. */
  readonly kept: () => KeptZoom | undefined
  /**
   * Esc: back to fit, true where it eased there. False, and nothing done, where the phone
   * isn't drawn zoomed: the key is the pane's then.
   */
  readonly out: () => boolean
  /** Moves the phone up or down by `by` of its travel, as Shift+scroll over the stage does. */
  readonly lift: (by: number) => void
  /** Brings the cursor, the rail and the hint up to date with the viewer's size and layout. */
  readonly sync: () => void
  readonly destroy: () => void
}

export const createPhoneZoom = (root: HTMLElement, options: ZoomOptions): PhoneZoom => {
  const { size, stage, phone, changed, shown, calm } = options
  const win = root.ownerDocument.defaultView
  // Where it rests: zoomed or at fit, and how far up or down it's lifted.
  let resting = options.kept !== undefined
  let lifted = options.kept?.lift ?? 0
  // An ease under way: from where the phone was drawn, how far along it is, and where to.
  let easing: { from: Framing; toZoomed: boolean; progress: number } | undefined
  let frame: number | undefined

  const level = (): number | undefined => {
    if (size() !== "phone") return undefined
    const { width, height } = stage()
    return phoneZoomOf(width, height)
  }
  const fit = (): Framing | undefined => {
    const { width, height } = stage()
    return framingOf("phone", width, height)
  }
  // Where it ends up, were it to rest zoomed or at fit.
  const target = (toZoomed: boolean): Framing | undefined => {
    const zoom = level()
    const { width, height } = stage()
    return toZoomed && zoom !== undefined ? phoneAt(width, height, zoom, lifted) : fit()
  }
  // Zoomed, or heading there.
  const wants = (): boolean => (easing ? easing.toZoomed : resting)
  const framing = (): Framing | undefined => {
    if (size() !== "phone") return undefined
    if (easing) {
      const to = target(easing.toZoomed)
      return to && between(easing.from, to, easeOf(easing.progress))
    }
    return resting && level() !== undefined ? target(true) : undefined
  }
  const viewScale = (): number | undefined => {
    if (size() !== "phone") return undefined
    if (easing) {
      const to = target(easing.toZoomed)
      return to && Math.max(easing.from.scale, to.scale)
    }
    return resting ? level() : undefined
  }

  const stopEasing = (): void => {
    if (frame !== undefined) win?.cancelAnimationFrame(frame)
    frame = undefined
  }
  const ease = (toZoomed: boolean, about?: { readonly y: number }): void => {
    const from = framing() ?? fit()
    const zoom = level()
    if (!from || (toZoomed && zoom === undefined)) return
    stopEasing()
    if (toZoomed && about) lifted = liftAbout(from, zoom!, about.y, stage().height)
    if (calm() || !win) {
      easing = undefined
      resting = toZoomed
      changed()
      return
    }
    easing = { from, toZoomed, progress: 0 }
    const started = win.performance.now()
    const step = (now: number): void => {
      const run = easing
      if (!run) return
      run.progress = Math.min(1, (now - started) / zoomMs)
      if (run.progress >= 1) {
        easing = undefined
        frame = undefined
        resting = run.toZoomed
      } else frame = win.requestAnimationFrame(step)
      changed()
    }
    frame = win.requestAnimationFrame(step)
    changed()
  }

  // The hint to zoom, at the stage's foot, until it's been up a while or the person zooms.
  let hint: HTMLElement | undefined
  let hinting: ReturnType<typeof setTimeout> | undefined
  let fading: ReturnType<typeof setTimeout> | undefined
  const hide = (): void => {
    clearTimeout(hinting)
    const line = hint
    hint = undefined
    if (!line) return
    delete line.dataset.shown
    // Quicker than it fades where motion is off.
    fading = setTimeout(() => line.remove(), calm() ? 0 : hintFadeMs)
  }
  // Up once a session at most, as storage that can't keep it would have it up again.
  let hinted = false
  const remind = (): void => {
    const { hint: once } = options
    if (hinted || !once || !shown() || once.seen()) return
    hinted = true
    const line = root.ownerDocument.createElement("div")
    line.className = "browser-hint"
    line.setAttribute("role", "status")
    line.textContent = "Double-click around the phone to zoom"
    root.append(line)
    hint = line
    once.see()
    // Shown on the next frame, for its fade in to run, unless it has gone by then.
    const reveal = (): void => {
      if (hint === line) line.dataset.shown = ""
    }
    if (win?.requestAnimationFrame) win.requestAnimationFrame(reveal)
    else reveal()
    hinting = setTimeout(hide, hintMs)
  }

  // The rail, in the viewer's right margin while zoomed and taller than the viewer.
  const track = root.ownerDocument.createElement("div")
  track.className = "browser-rail"
  track.setAttribute("role", "scrollbar")
  track.setAttribute("aria-label", "Move the phone up and down")
  track.setAttribute("aria-orientation", "vertical")
  track.tabIndex = 0
  const thumb = root.ownerDocument.createElement("div")
  thumb.className = "browser-rail-thumb"
  track.append(thumb)
  const rail = (): { length: number; thumb: number; at: number } | undefined => {
    const { height } = stage()
    const zoom = level()
    return zoom === undefined || !resting || easing ? undefined : railOf(height, zoom, lifted)
  }
  const place = (): void => {
    const shape = rail()
    if (!shape) return track.remove()
    if (!track.isConnected) root.append(track)
    track.style.cssText = `top:${railEnd}px;right:${railInset}px;width:${railWidth}px;height:${shape.length}px`
    thumb.style.cssText = `top:${shape.at}px;height:${shape.thumb}px`
    track.setAttribute("aria-valuenow", `${Math.round(lifted * 100)}`)
    track.setAttribute("aria-valuemin", "0")
    track.setAttribute("aria-valuemax", "100")
  }
  const move = (to: number): void => {
    lifted = Math.min(1, Math.max(0, to))
    changed()
  }
  track.addEventListener("pointerdown", (press) => {
    const shape = rail()
    if (press.button !== 0 || !shape) return
    press.preventDefault()
    // Pointer and rect are in the screen's pixels, the rail's own in the page's: a viewer
    // inside a zoomed canvas is drawn smaller or larger than it lays out.
    const box = track.getBoundingClientRect()
    const scale = track.offsetHeight > 0 ? box.height / track.offsetHeight : 1
    const local = (y: number): number => (y - box.top) / scale
    // On the thumb, it's held where it was grabbed; elsewhere on the track it jumps there.
    const onThumb = thumb.contains(press.target as Node)
    const held = onThumb ? local(press.clientY) - shape.at - shape.thumb / 2 : 0
    const to = (y: number): number => liftAtRail(local(y) - held, 0, shape.length, shape.thumb)
    try {
      track.setPointerCapture(press.pointerId)
    } catch {
      // A pointer the browser doesn't know, as one a test makes: it drags all the same.
    }
    move(to(press.clientY))
    const drag = (event: PointerEvent): void => {
      if (event.pointerId === press.pointerId) move(to(event.clientY))
    }
    const release = (event: PointerEvent): void => {
      if (event.pointerId !== press.pointerId) return
      track.removeEventListener("pointermove", drag)
      track.removeEventListener("pointerup", release)
      track.removeEventListener("pointercancel", release)
    }
    track.addEventListener("pointermove", drag)
    track.addEventListener("pointerup", release)
    track.addEventListener("pointercancel", release)
  })
  track.addEventListener("keydown", (event) => {
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(lifted - arrowLift),
      ArrowDown: () => move(lifted + arrowLift),
      Home: () => move(0),
      End: () => move(1),
    }
    const act = keys[event.key]
    if (!act) return
    event.preventDefault()
    act()
  })

  const lift = (by: number): void => {
    if (!resting || easing) return
    const zoom = level()
    if (zoom === undefined) return
    const travel = phoneTravel(stage().height, zoom)
    if (travel > 0) move(lifted + by / travel)
  }

  // A double-click on the stage around the phone eases it, about the pointer; a drag across
  // it is the tilt's (./tilt.ts), not a click.
  let dragged = false
  let pressed: { readonly x: number; readonly y: number } | undefined
  const pressing = (event: PointerEvent): void => {
    if (event.target !== root) return
    pressed = { x: event.clientX, y: event.clientY }
    dragged = false
  }
  const dragging = (event: PointerEvent): void => {
    if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > dragPx)
      dragged = true
  }
  const doubled = (event: MouseEvent): void => {
    if (event.target !== root || dragged || size() !== "phone") return
    const where = phone()
    if (where && onPhone(where, event.offsetX, event.offsetY)) return
    if (wants()) ease(false, { y: event.offsetY })
    else if (level() !== undefined) ease(true, { y: event.offsetY })
    else return
    hide()
    // For Esc to find the pane, as the viewer has no focus of its own to take it.
    root.focus({ preventScroll: true })
  }
  const wheeled = (event: WheelEvent): void => {
    if (!event.shiftKey || !resting || easing || level() === undefined) return
    event.preventDefault()
    lift(event.deltaY || event.deltaX)
  }
  root.tabIndex = -1
  root.addEventListener("pointerdown", pressing)
  root.addEventListener("pointermove", dragging)
  root.addEventListener("dblclick", doubled)
  root.addEventListener("wheel", wheeled, { passive: false })

  return {
    framing,
    viewScale,
    zoomed: wants,
    kept: () => (resting || easing?.toZoomed ? { lift: lifted } : undefined),
    out: () => {
      // Only a phone drawn zoomed, or on its way: one the viewer is too narrow to zoom now
      // isn't, and the key goes on.
      if (!wants() || size() !== "phone" || level() === undefined) return false
      ease(false)
      return true
    },
    lift,
    sync: () => {
      const can = size() === "phone" && level() !== undefined
      const mark = !can ? undefined : wants() ? "out" : "in"
      if (mark) root.dataset.zoom = mark
      else delete root.dataset.zoom
      place()
      if (can) remind()
    },
    destroy: () => {
      stopEasing()
      clearTimeout(hinting)
      clearTimeout(fading)
      hint?.remove()
      track.remove()
      root.removeEventListener("pointerdown", pressing)
      root.removeEventListener("pointermove", dragging)
      root.removeEventListener("dblclick", doubled)
      root.removeEventListener("wheel", wheeled)
    },
  }
}
