import {
  levelLabel,
  loupeIdle,
  loupeLevel,
  loupeShown,
  loupeSize,
  loupeStep,
  pageLoupeMessage,
  parsePageLoupe,
  regionAround,
  type LoupeSpace,
  type Point,
  type Rect,
} from "./loupe.js"

// The loupe's look and its frames: a round lens over the viewer showing a picture of the
// page under the pointer, magnified. Its rules and arithmetic are `loupe.ts`'s. A live
// page's pictures are taken of a region around the pointer, one after another while it
// shows, each asked for as the last lands, and the lens moves under the pointer on the
// latest meanwhile; a snapshot's is the snapshot itself.

/** A picture of part of the page, and the part of it, in the page's CSS pixels. */
export type LoupeFrame = { readonly src: string; readonly region: Rect }

/** The least between one picture of a live page being asked for and the next while the pointer moves. */
export const loupeFrameMs = 33
/**
 * And while it rests, which a page that changes under it still wants pictures at, but few:
 * once the pointer has been still for `loupeStillMs`.
 */
export const loupeRestMs = 200
export const loupeStillMs = 300
/** How long it waits to ask again after a picture that didn't come. */
const loupeRetryMs = 200

type Lens = {
  /** Shows it at `host` of the viewer, over `page` of the page. */
  readonly show: (page: Point, host: Point) => void
  readonly hide: () => void
  readonly destroy: () => void
}

// The lens: a round window onto the latest frame, with its level at its foot, kept inside the
// viewer's box, not over the pane's own chrome around it. `drawn` and `bounds` say where the
// page is as drawn now; `frame`, where it can ask for pictures, takes the region to picture,
// and `still` gives the one picture a snapshot has.
const createLens = (
  root: HTMLElement,
  options: {
    readonly drawn: () => number
    readonly bounds: () => { readonly width: number; readonly height: number }
    readonly frame?: (region: Rect) => Promise<LoupeFrame | undefined>
    readonly still?: () => LoupeFrame | undefined
  },
): Lens => {
  const document = root.ownerDocument
  const clip = document.createElement("div")
  clip.className = "browser-loupe-clip"
  const lens = document.createElement("div")
  lens.className = "browser-loupe"
  lens.hidden = true
  lens.setAttribute("aria-hidden", "true")
  const glass = document.createElement("div")
  glass.className = "browser-loupe-glass"
  const image = document.createElement("img")
  image.alt = ""
  image.draggable = false
  glass.append(image)
  const label = document.createElement("span")
  label.className = "browser-loupe-level"
  lens.append(glass, label)
  clip.append(lens)
  root.append(clip)

  // Where it is: the pointer, when it last moved, and the latest frame.
  let page: Point = { x: 0, y: 0 }
  let host: Point = { x: 0, y: 0 }
  let movedAt = 0
  let frame: LoupeFrame | undefined
  let showing = false
  // Frames of a live page: the show they were asked in, and whether one is on its way.
  let epoch = 0
  let waiting = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let drawnSrc = ""

  const level = (): number => loupeLevel(options.drawn())
  const draw = (): void => {
    const now = level()
    lens.style.transform = `translate(${host.x - loupeSize / 2}px, ${host.y - loupeSize / 2}px)`
    label.textContent = levelLabel(now)
    const seen = frame ?? options.still?.()
    if (!seen) return
    if (seen.src !== drawnSrc) {
      drawnSrc = seen.src
      image.src = seen.src
    }
    const { region } = seen
    image.style.width = `${region.width * now}px`
    image.style.height = `${region.height * now}px`
    image.style.transform = `translate(${loupeSize / 2 - (page.x - region.x) * now}px, ${loupeSize / 2 - (page.y - region.y) * now}px)`
  }

  // Asks for the next frame of a live page, and again as it lands, while shown.
  const ask = (): void => {
    const take = options.frame
    timer = undefined
    if (!take || !showing || waiting) return
    waiting = true
    const mine = epoch
    const started = Date.now()
    void take(regionAround(page, level(), options.bounds()))
      .catch(() => undefined)
      .then((got) => {
        if (mine !== epoch) return
        waiting = false
        if (got) {
          frame = got
          draw()
        }
        // As often as the pointer moves, less as it rests.
        const every = Date.now() - movedAt < loupeStillMs ? loupeFrameMs : loupeRestMs
        const after = got ? Math.max(0, every - (Date.now() - started)) : loupeRetryMs
        timer = setTimeout(ask, after)
      })
  }

  return {
    show: (nextPage, nextHost) => {
      if (nextPage.x !== page.x || nextPage.y !== page.y) movedAt = Date.now()
      page = nextPage
      host = nextHost
      if (!showing) {
        showing = true
        movedAt = Date.now()
        lens.hidden = false
        epoch += 1
        waiting = false
      }
      draw()
      // A move picks the pace up where the loupe was resting.
      if (timer !== undefined && Date.now() - movedAt < loupeStillMs) {
        clearTimeout(timer)
        timer = undefined
      }
      // Not before the next one is due, which a landed picture has set a timer for.
      if (timer === undefined) ask()
    },
    hide: () => {
      if (!showing) return
      showing = false
      lens.hidden = true
      epoch += 1
      waiting = false
      clearTimeout(timer)
      timer = undefined
      // A frame of a page that has moved since isn't shown at the next show.
      frame = undefined
    },
    destroy: () => {
      epoch += 1
      clearTimeout(timer)
      clip.remove()
    },
  }
}

export type LoupeOptions = {
  /** The live page's space as laid now, and its view's web contents id; none while it rests. */
  readonly live?: {
    readonly space: () => LoupeSpace | undefined
    readonly contents: () => number | undefined
    /** A picture of a part of the page's view, in its pixels, as a data address. */
    readonly look: (page: number, rect: Rect) => Promise<string | undefined>
    /**
     * Turns the tool's loupe on or off in the page's view's own watch, or, `away`, says the
     * viewer is out of sight, with no pointer over it.
     */
    readonly hold: (page: number, on: boolean, away?: boolean) => Promise<boolean>
  }
  /** A snapshot of the page: the element it scrolls in, and its picture. */
  readonly snapshot?: { readonly scroll: HTMLElement; readonly image: HTMLImageElement }
  /** Tells whether the tool's loupe is on, as it changes. */
  readonly on?: (toggled: boolean) => void
}

export type LoupeHandle = {
  /**
   * The tool's: shows it, or not, until Esc or the pointer leaves. Where the live page isn't
   * there yet, as one waking, it goes on as the page is ready (`ready`).
   */
  readonly toggle: (on: boolean) => void
  /** The live page's view is ready: a toggle that came before it goes through. */
  readonly ready: () => void
  /** Hides it and turns the tool off, as when the viewer goes out of sight, or the page does. */
  readonly hide: () => void
  readonly destroy: () => void
}

/**
 * The loupe over a live page or a snapshot in `root`: the lens, and what drives it. A live
 * page's pointer and keys reach the main process only, which tells the app's page of them
 * (`pageLoupeMessage`); a snapshot's are the page's own.
 */
export const attachLoupe = (root: HTMLElement, options: LoupeOptions): LoupeHandle => {
  const win = root.ownerDocument.defaultView
  const { live, snapshot } = options
  let toggled = false
  const report = (next: boolean): void => {
    if (next === toggled) return
    toggled = next
    options.on?.(toggled)
  }

  if (live) {
    const lens = createLens(root, {
      drawn: () => live.space()?.drawn ?? 1,
      bounds: () => live.space()?.bounds ?? { width: root.clientWidth, height: root.clientHeight },
      frame: async (region) => {
        const space = live.space()
        const id = live.contents()
        if (!space || id === undefined) return undefined
        const rect = space.view(region)
        const src = await live.look(id, rect)
        return src === undefined ? undefined : { src, region: space.unview(rect) }
      },
    })
    // The tool pressed before the page's view was there, to go through once it is.
    let pending = false
    const heard = (event: MessageEvent): void => {
      const { data } = event
      if (event.source !== win || data?.type !== pageLoupeMessage) return
      const notice = parsePageLoupe(data)
      const space = live.space()
      if (!notice || !space || notice.contentsId !== live.contents()) return
      report(notice.toggled)
      if (!notice.shown) return lens.hide()
      const at = space.page({ x: notice.x, y: notice.y })
      lens.show(at, space.host(at))
    }
    win?.addEventListener("message", heard)
    const hold = (id: number, on: boolean, away = false): void => {
      void live
        .hold(id, on, away)
        .catch(() => false)
        .then((done) => {
          if (!done && !away) report(false)
        })
    }
    const away = (): void => {
      pending = false
      lens.hide()
      const id = live.contents()
      if (id !== undefined) hold(id, false, true)
      report(false)
    }
    return {
      toggle: (on) => {
        const id = live.contents()
        if (id === undefined) {
          pending = on
          return report(on)
        }
        hold(id, on)
      },
      ready: () => {
        const id = live.contents()
        if (!pending || id === undefined) return
        pending = false
        hold(id, true)
      },
      hide: away,
      destroy: () => {
        win?.removeEventListener("message", heard)
        away()
        lens.destroy()
      },
    }
  }

  if (!snapshot)
    return {
      toggle: () => report(false),
      ready: () => undefined,
      hide: () => report(false),
      destroy: () => undefined,
    }

  // A snapshot: the page's own events, in the app's page.
  const { scroll, image } = snapshot
  let state = loupeIdle
  // The snapshot is a picture of a page as wide as the picture is, so its pixels are the page's.
  const wide = (): number => image.naturalWidth
  const drawn = (): number => (wide() > 0 ? image.getBoundingClientRect().width / wide() : 0)
  const bounds = (): { width: number; height: number } => ({
    width: wide(),
    height: drawn() > 0 ? image.getBoundingClientRect().height / drawn() : 0,
  })
  const lens = createLens(root, {
    drawn,
    bounds,
    still: () => ({ src: image.src, region: { x: 0, y: 0, ...bounds() } }),
  })
  let last: { x: number; y: number } | undefined
  const place = (): void => {
    if (!last || !loupeShown(state) || drawn() <= 0) return lens.hide()
    const box = image.getBoundingClientRect()
    const rootBox = root.getBoundingClientRect()
    lens.show(
      { x: (last.x - box.left) / drawn(), y: (last.y - box.top) / drawn() },
      { x: last.x - rootBox.left, y: last.y - rootBox.top },
    )
  }
  // Applies an input; says whether the tool's loupe was on before it.
  const step = (input: Parameters<typeof loupeStep>[1]): boolean => {
    const before = state
    state = loupeStep(state, input)
    report(state.toggled)
    place()
    return before.toggled
  }
  const moved = (event: PointerEvent): void => {
    last = { x: event.clientX, y: event.clientY }
    state = loupeStep(state, { kind: "enter" })
    step({
      kind: "keys",
      alt: event.altKey,
      other: event.ctrlKey || event.metaKey || event.shiftKey,
    })
  }
  const left = (): void => {
    step({ kind: "leave" })
  }
  const keyed = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (event.type === "keydown" && step({ kind: "escape" })) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    // Over the snapshot, a bare Alt is the loupe's, not the window's: on Windows and Linux it
    // would toggle the menu bar, which moves the page under the pointer.
    if (event.key === "Alt" && state.over) event.preventDefault()
    const down = event.type === "keydown"
    step({
      kind: "keys",
      alt: event.key === "Alt" ? down : event.key === "AltGraph" ? false : event.altKey,
      other: event.key === "AltGraph" ? false : event.ctrlKey || event.metaKey || event.shiftKey,
    })
  }
  scroll.addEventListener("pointermove", moved)
  scroll.addEventListener("pointerleave", left)
  win?.addEventListener("keydown", keyed, true)
  win?.addEventListener("keyup", keyed, true)
  // Another window has the keys now: no Alt is held here, nor the pointer over this.
  const blurred = (): void => {
    step({ kind: "keys", alt: false, other: false })
    step({ kind: "leave" })
  }
  win?.addEventListener("blur", blurred)
  return {
    toggle: (on) => {
      step({ kind: "toggle", on })
    },
    ready: () => undefined,
    hide: () => {
      state = loupeIdle
      lens.hide()
      report(false)
    },
    destroy: () => {
      scroll.removeEventListener("pointermove", moved)
      scroll.removeEventListener("pointerleave", left)
      win?.removeEventListener("keydown", keyed, true)
      win?.removeEventListener("keyup", keyed, true)
      win?.removeEventListener("blur", blurred)
      lens.destroy()
    },
  }
}
