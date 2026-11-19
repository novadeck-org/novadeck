import type { Framing, PageSize } from "./framing.js"

// A loupe over a page: a round magnifier that follows the pointer while the person holds
// Alt over the page, or has the loupe tool on. This is its arithmetic and its rules, with
// no view: how far it magnifies, where in the page and in the page's view a point is, and
// when it shows. `loupe-view.ts` draws it, and the desktop app's main process (see
// `createLoupeWatch`) follows the pointer over a live page, which the app's own page
// never hears.

/** Its diameter, in the viewer's CSS pixels. */
export const loupeSize = 190

/**
 * How far past what the page is drawn at the loupe magnifies, at most: a live page's
 * picture comes from the page as drawn on screen, so a loupe past twice that would show
 * a picture stretched past twice its pixels, and soft.
 */
export const loupeReach = 2

/** How much of the page beyond the loupe's own view is pictured with it, so small moves wait for nothing. */
export const loupeMargin = 1.5

// How near 100% a level snaps to it, and how far a wheel's pixel of travel changes it.
const snapWithin = 0.03
const perWheelPixel = 1 / 800

export type Point = { readonly x: number; readonly y: number }
export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The levels the loupe shows, in the page's real size (1 is a CSS pixel of the page for a
 * CSS pixel of the viewer), for a page drawn at `drawn` of its real size: no lower than
 * what's drawn, a 1:1 crop of it, and no higher than `loupeReach` times that.
 */
export const loupeRange = (drawn: number): { readonly min: number; readonly max: number } => ({
  min: drawn,
  max: drawn * loupeReach,
})

/** `level` held within the loupe's range for a page drawn at `drawn`, not yet snapped. */
export const withinRange = (level: number, drawn: number): number => {
  const { min, max } = loupeRange(drawn)
  return Math.min(max, Math.max(min, Number.isFinite(level) ? level : max))
}

/** The level the loupe shows for a held `level`: within range, and on 100% where that's near and in range. */
export const shownLevel = (level: number, drawn: number): number => {
  const within = withinRange(level, drawn)
  const { min, max } = loupeRange(drawn)
  return min <= 1 && 1 <= max && Math.abs(within - 1) <= snapWithin ? 1 : within
}

/** The level held after the wheel turns by `deltaY` pixels (up, negative, magnifies more). */
export const levelAfterWheel = (level: number, deltaY: number, drawn: number): number =>
  withinRange(withinRange(level, drawn) * Math.exp(-deltaY * perWheelPixel), drawn)

/** A level as the loupe's label says it, in the page's real size. */
export const levelLabel = (level: number): string => `${Math.round(level * 100)}%`

/** How many CSS pixels of the page the loupe's width takes in at `level`. */
export const sourceSide = (level: number): number => loupeSize / level

// Where a span `size` long, centred on `centre`, starts, held within `room`.
const placed = (centre: number, size: number, room: number): number =>
  Math.min(Math.max(centre - size / 2, 0), room - size)

/**
 * The part of the page to picture for a loupe at `level` centred on `at`, in the page's
 * CSS pixels: the loupe's own view with a margin around it, moved, not cut, to stay inside
 * `bounds`, the page's view, unless it's bigger than that.
 */
export const regionAround = (
  at: Point,
  level: number,
  bounds: { readonly width: number; readonly height: number },
): Rect => {
  const side = sourceSide(level) * loupeMargin
  const width = Math.min(side, bounds.width)
  const height = Math.min(side, bounds.height)
  return {
    x: placed(at.x, width, bounds.width),
    y: placed(at.y, height, bounds.height),
    width,
    height,
  }
}

/**
 * Where things are in a live page, the three spaces a loupe moves between: the page's own
 * CSS pixels, its view's device-independent pixels (what the desktop app's pointer events and
 * captures speak), and the viewer's CSS pixels. Made by `spaceOf`, the one place that knows
 * how a size lays its page in the viewer, so a change to a phone's framing lands here.
 */
export type LoupeSpace = {
  /** How far the page is drawn, in viewer pixels for a page pixel. */
  readonly drawn: number
  /** The page's view, in page pixels. */
  readonly bounds: { readonly width: number; readonly height: number }
  /** A point of the page's view, in its pixels, as a point of the page. */
  readonly page: (view: Point) => Point
  /** A point of the page, as a point of the viewer. */
  readonly host: (page: Point) => Point
  /** A part of the page, as the whole pixels of the page's view that cover it. */
  readonly view: (page: Rect) => Rect
  /** What `view` covered, as a part of the page. */
  readonly unview: (view: Rect) => Rect
}

/**
 * The space of a live page of `size` in a viewer `viewer` big, laid by `framing`
 * (undefined where the page fills it), whose view's pixels are `perPage` to a page pixel
 * where the page is zoomed (a desktop's; the viewer's own zoom included). A phone's page is
 * drawn at its own pixels in a view scaled whole by the framing, so one for one.
 */
export const spaceOf = (
  size: PageSize,
  framing: Framing | undefined,
  viewer: { readonly width: number; readonly height: number },
  perPage: number,
): LoupeSpace => {
  const per = size === "phone" ? 1 : perPage > 0 ? perPage : 1
  const scale = framing?.scale ?? 1
  const left = framing?.left ?? 0
  const top = framing?.top ?? 0
  return {
    drawn: scale,
    bounds: framing ? { width: framing.width, height: framing.height } : viewer,
    page: ({ x, y }) => ({ x: x / per, y: y / per }),
    host: ({ x, y }) => ({ x: left + x * scale, y: top + y * scale }),
    view: ({ x, y, width, height }) => {
      const x0 = Math.floor(x * per)
      const y0 = Math.floor(y * per)
      return {
        x: x0,
        y: y0,
        width: Math.max(1, Math.ceil((x + width) * per) - x0),
        height: Math.max(1, Math.ceil((y + height) * per) - y0),
      }
    },
    unview: ({ x, y, width, height }) => ({
      x: x / per,
      y: y / per,
      width: width / per,
      height: height / per,
    }),
  }
}

/** When the loupe shows: it's on by its tool, or Alt is held, and the pointer is on the page. */
export type LoupeState = {
  readonly toggled: boolean
  readonly alt: boolean
  readonly over: boolean
}

export type LoupeInput =
  | { readonly kind: "toggle"; readonly on: boolean }
  | { readonly kind: "alt"; readonly down: boolean }
  | { readonly kind: "escape" }
  | { readonly kind: "enter" }
  | { readonly kind: "leave" }

export const loupeIdle: LoupeState = { toggled: false, alt: false, over: false }

/**
 * The state after `input`: Esc, or the pointer leaving the page, turns the tool's loupe off;
 * Alt held shows it only while the pointer is over.
 */
export const loupeStep = (state: LoupeState, input: LoupeInput): LoupeState => {
  switch (input.kind) {
    case "toggle":
      return { ...state, toggled: input.on }
    case "alt":
      return { ...state, alt: input.down }
    case "escape":
      return { ...state, toggled: false }
    case "enter":
      return { ...state, over: true }
    case "leave":
      return { ...state, over: false, toggled: false }
  }
}

export const loupeShown = (state: LoupeState): boolean => state.over && (state.toggled || state.alt)

/**
 * What the app's page is told of the loupe over a live page, from the main process, which
 * sees the pointer and the keys the page's own view takes: whether it shows and whether its
 * tool is on, and where the pointer is in the view.
 */
export type PageLoupeNotice = {
  readonly contentsId: number
  readonly shown: boolean
  readonly toggled: boolean
  readonly x: number
  readonly y: number
}

/** The IPC channel on which the main process tells the app of a loupe. */
export const pageLoupeChannel = "novadeck:page-loupe"

/** The window message by which the app's preload hands that to the viewer of the page. */
export const pageLoupeMessage = "novadeck:page-loupe"

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

/** `value` as a notice if it is one: a view's id, two flags and a point. */
export const parsePageLoupe = (value: unknown): PageLoupeNotice | null => {
  if (typeof value !== "object" || value === null) return null
  const { contentsId, shown, toggled, x, y } = value as Record<string, unknown>
  if (
    typeof contentsId !== "number" ||
    !Number.isSafeInteger(contentsId) ||
    typeof shown !== "boolean" ||
    typeof toggled !== "boolean" ||
    !finite(x) ||
    !finite(y)
  )
    return null
  return { contentsId, shown, toggled, x, y }
}

/**
 * Follows what a page's view sees of the pointer and the keys, for the loupe over it, in
 * the main process: `tell` hears when it shows or hides, when its tool goes on or off, and
 * where the pointer moves while it shows. Esc says whether the loupe took it, so the page
 * doesn't also.
 */
export const createLoupeWatch = (tell: (notice: Omit<PageLoupeNotice, "contentsId">) => void) => {
  let state = loupeIdle
  let at: Point = { x: 0, y: 0 }
  const told = (): void =>
    tell({ shown: loupeShown(state), toggled: state.toggled, x: at.x, y: at.y })
  // Applies an input, and tells where it changed what's shown or whether the tool is on.
  const apply = (input: LoupeInput): boolean => {
    const before = state
    state = loupeStep(state, input)
    if (loupeShown(before) !== loupeShown(state) || before.toggled !== state.toggled) told()
    return loupeShown(before)
  }
  return {
    state: (): LoupeState => state,
    /**
     * The pointer is at `x`, `y` of the page's view. `alt` is whether the event itself says Alt
     * is held, which can only show it: an event that doesn't say so isn't saying it was let go
     * (some systems leave it out), which the key up says.
     */
    pointer: (x: number, y: number, alt: boolean): void => {
      at = { x, y }
      const was = loupeShown(state)
      state = loupeStep(state, { kind: "enter" })
      if (alt) state = loupeStep(state, { kind: "alt", down: true })
      if (was || loupeShown(state)) told()
    },
    leave: (): void => {
      apply({ kind: "leave" })
    },
    alt: (down: boolean): void => {
      apply({ kind: "alt", down })
    },
    /** Whether Esc was the loupe's. */
    escape: (): boolean => apply({ kind: "escape" }),
    toggle: (on: boolean): void => {
      apply({ kind: "toggle", on })
    },
  }
}

/**
 * A script for the live page: while the loupe shows (`on`), the wheel over the page is the
 * loupe's, not the page's, which a page's view gives the main process no word of to take. It
 * puts a listener in the page's document once, and answers how far the wheel turned, in pixels,
 * since the last call. Called again as long as the loupe shows, which also puts it in a
 * document that loaded meanwhile; called off, the page has its wheel back.
 */
export const loupeWheelScript = (on: boolean): string => `(() => {
  let state = window.__novadeckLoupe
  if (!state) {
    state = { on: false, turned: 0 }
    Object.defineProperty(window, "__novadeckLoupe", { value: state })
    addEventListener(
      "wheel",
      (event) => {
        if (!state.on) return
        event.preventDefault()
        event.stopImmediatePropagation()
        state.turned += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1)
      },
      { capture: true, passive: false },
    )
  }
  state.on = ${on}
  const turned = state.turned
  state.turned = 0
  return turned
})()`
