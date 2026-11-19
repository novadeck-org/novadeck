import { desktopWidth } from "./framing.js"
import {
  levelAfterWheel,
  levelLabel,
  loupeIdle,
  loupeShown,
  loupeSize,
  loupeStep,
  pageLoupeMessage,
  parsePageLoupe,
  regionAround,
  shownLevel,
  type LoupeInput,
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

/** The least between one picture of a live page being asked for and the next, so a loupe costs little. */
export const loupeFrameMs = 33
/** How long it waits to ask again after a picture that didn't come. */
const loupeRetryMs = 200

// The level the person last left it at, kept for next time, as the page's real size; none
// yet, or one that storage can't give, is the most it magnifies.
const levelKey = "novadeck.page-loupe-level"
const keptLevel = (): number => {
  try {
    const level = Number(globalThis.localStorage?.getItem(levelKey))
    return level > 0 && Number.isFinite(level) ? level : Infinity
  } catch {
    return Infinity
  }
}
const keepLevel = (level: number): void => {
  try {
    globalThis.localStorage?.setItem(levelKey, String(level))
  } catch {
    // Not kept: it starts at the most next time.
  }
}

type Lens = {
  /** Shows it at `host` of the viewer, over `page` of the page. */
  readonly show: (page: Point, host: Point) => void
  readonly hide: () => void
  readonly wheel: (deltaY: number) => void
  readonly destroy: () => void
}

// The lens: a round window onto the latest frame, with its level at its foot. `drawn` and
// `bounds` say where the page is as drawn now; `frame`, where it can ask for pictures, takes
// the region to picture, and `still` gives the one picture a snapshot has.
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
  root.append(lens)

  // Where it's held: its level before it's kept within range, the pointer, and the latest frame.
  let held = keptLevel()
  let page: Point = { x: 0, y: 0 }
  let host: Point = { x: 0, y: 0 }
  let frame: LoupeFrame | undefined
  let showing = false
  // Frames of a live page: the show they were asked in, and whether one is on its way.
  let epoch = 0
  let waiting = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let drawnSrc = ""

  const level = (): number => shownLevel(held, options.drawn())
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
        const after = got ? Math.max(0, loupeFrameMs - (Date.now() - started)) : loupeRetryMs
        timer = setTimeout(ask, after)
      })
  }

  return {
    show: (nextPage, nextHost) => {
      page = nextPage
      host = nextHost
      if (!showing) {
        showing = true
        lens.hidden = false
        epoch += 1
        waiting = false
      }
      draw()
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
    wheel: (deltaY) => {
      held = levelAfterWheel(held, deltaY, options.drawn())
      keepLevel(held)
      draw()
    },
    destroy: () => {
      epoch += 1
      clearTimeout(timer)
      lens.remove()
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
    /** Turns the tool's loupe on or off, in the page's view's own watch. */
    readonly hold: (page: number, on: boolean) => Promise<boolean>
    /** Takes the wheel over the page for the loupe, or gives it back; how far it turned, in pixels, since. */
    readonly wheel: (on: boolean) => Promise<number>
  }
  /** A snapshot of the page: the element it scrolls in, and its picture. */
  readonly snapshot?: { readonly scroll: HTMLElement; readonly image: HTMLImageElement }
  /** Tells whether the tool's loupe is on, as it changes. */
  readonly on?: (toggled: boolean) => void
}

export type LoupeHandle = {
  /** The tool's: shows it, or not, until Esc or the pointer leaves. */
  readonly toggle: (on: boolean) => void
  /** Hides it and turns the tool off, as when the page it was over goes. */
  readonly hide: () => void
  readonly destroy: () => void
}

/**
 * The loupe over a live page or a snapshot in `root`: the lens, and what drives it. A live
 * page's pointer, wheel and keys reach the main process only, which tells the app's page
 * of them (`pageLoupeMessage`); a snapshot's are the page's own.
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
        // The wheel is the loupe's while it shows, and read as each picture is asked for.
        const turned = await live.wheel(true).catch(() => 0)
        if (turned !== 0) lens.wheel(turned)
        const rect = space.view(region)
        const src = await live.look(id, rect)
        return src === undefined ? undefined : { src, region: space.unview(rect) }
      },
    })
    let showing = false
    const heard = (event: MessageEvent): void => {
      const { data } = event
      if (event.source !== win || data?.type !== pageLoupeMessage) return
      const notice = parsePageLoupe(data)
      const space = live.space()
      if (!notice || !space || notice.contentsId !== live.contents()) return
      report(notice.toggled)
      if (!notice.shown) {
        if (showing) void live.wheel(false).catch(() => 0)
        showing = false
        return lens.hide()
      }
      showing = true
      const at = space.page({ x: notice.x, y: notice.y })
      lens.show(at, space.host(at))
    }
    win?.addEventListener("message", heard)
    return {
      toggle: (on) => {
        const id = live.contents()
        if (id === undefined) return report(false)
        void live
          .hold(id, on)
          .catch(() => false)
          .then((done) => {
            if (!done) report(false)
          })
      },
      hide: () => {
        lens.hide()
        report(false)
      },
      destroy: () => {
        win?.removeEventListener("message", heard)
        lens.destroy()
      },
    }
  }

  if (!snapshot)
    return { toggle: () => report(false), hide: () => report(false), destroy: () => undefined }

  // A snapshot: the page's own events, in the app's page.
  const { scroll, image } = snapshot
  let state = loupeIdle
  // The snapshot is of a page laid out as a desktop's, so its pixels are `desktopWidth` wide.
  const drawn = (): number => image.getBoundingClientRect().width / desktopWidth
  const bounds = (): { width: number; height: number } => ({
    width: desktopWidth,
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
  const step = (input: LoupeInput): boolean => {
    const before = state
    state = loupeStep(state, input)
    report(state.toggled)
    place()
    return loupeShown(before)
  }
  const moved = (event: PointerEvent): void => {
    last = { x: event.clientX, y: event.clientY }
    state = loupeStep(state, { kind: "enter" })
    step({ kind: "alt", down: event.altKey })
  }
  const left = (): void => {
    step({ kind: "leave" })
  }
  const wheeled = (event: WheelEvent): void => {
    if (!loupeShown(state)) return
    event.preventDefault()
    lens.wheel(event.deltaY)
  }
  const keyed = (event: KeyboardEvent): void => {
    if (event.key === "Alt") step({ kind: "alt", down: event.type === "keydown" })
    else if (event.key === "Escape" && event.type === "keydown" && step({ kind: "escape" })) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  scroll.addEventListener("pointermove", moved)
  scroll.addEventListener("pointerleave", left)
  scroll.addEventListener("wheel", wheeled, { passive: false })
  win?.addEventListener("keydown", keyed, true)
  win?.addEventListener("keyup", keyed, true)
  return {
    toggle: (on) => {
      step({ kind: "toggle", on })
    },
    hide: () => {
      state = loupeIdle
      lens.hide()
      report(false)
    },
    destroy: () => {
      scroll.removeEventListener("pointermove", moved)
      scroll.removeEventListener("pointerleave", left)
      scroll.removeEventListener("wheel", wheeled)
      win?.removeEventListener("keydown", keyed, true)
      win?.removeEventListener("keyup", keyed, true)
      lens.destroy()
    },
  }
}
