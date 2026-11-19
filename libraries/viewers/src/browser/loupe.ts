import type { Framing } from "./framing.js"

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

export type Point = { readonly x: number; readonly y: number }
export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The level the loupe shows for a page drawn at `drawn` of its real size, in the page's
 * real size (1 is a CSS pixel of the page for a CSS pixel of the viewer): `loupeReach` times
 * what's drawn, fixed.
 */
export const loupeLevel = (drawn: number): number => drawn * loupeReach

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
 * how the page is laid in the viewer, so a change to a phone's framing lands here.
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
 * The space of a live page in a viewer `viewer` big, laid by `framing` (undefined where the
 * page fills it), whose view's pixels are `perPage` to a page pixel: the page's zoom in its
 * view, the app's own included. A desktop's page is zoomed out to the size it's drawn at, a
 * phone's likewise, while it's zoomed or easing as at fit (see `framingOf`, `PhoneZoom`),
 * and the view is as big as it's drawn: a view drawn larger than it's shown, mid-ease,
 * is scaled by its framing, which is what `host` goes by.
 */
export const spaceOf = (
  framing: Framing | undefined,
  viewer: { readonly width: number; readonly height: number },
  perPage: number,
): LoupeSpace => {
  const per = perPage > 0 ? perPage : 1
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

/**
 * When the loupe shows: it's on by its tool, or Alt is held alone (`other` is whether Ctrl,
 * Meta or Shift is too, as Windows reports AltGr, which types letters), and the pointer is on
 * the page.
 */
export type LoupeState = {
  readonly toggled: boolean
  readonly alt: boolean
  readonly other: boolean
  readonly over: boolean
}

export type LoupeInput =
  | { readonly kind: "toggle"; readonly on: boolean }
  | { readonly kind: "keys"; readonly alt: boolean; readonly other: boolean }
  | { readonly kind: "escape" }
  | { readonly kind: "enter" }
  | { readonly kind: "leave" }
  | { readonly kind: "away" }

export const loupeIdle: LoupeState = { toggled: false, alt: false, other: false, over: false }

/**
 * The state after `input`: Esc, the pointer leaving the page, and the viewer going out of
 * sight (`away`, which no leave comes with), turn the tool's loupe off; `keys` is what the
 * keys and the pointer's own events say of Alt and the others now.
 */
export const loupeStep = (state: LoupeState, input: LoupeInput): LoupeState => {
  switch (input.kind) {
    case "toggle":
      return { ...state, toggled: input.on }
    case "keys":
      return { ...state, alt: input.alt, other: input.other }
    case "escape":
      return { ...state, toggled: false }
    case "enter":
      return { ...state, over: true }
    case "leave":
    case "away":
      return { ...state, over: false, toggled: false }
  }
}

export const loupeShown = (state: LoupeState): boolean =>
  state.over && (state.toggled || (state.alt && !state.other))

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

/** What a key or a pointer event says of the modifiers, as Electron gives them. */
export type Held = { readonly alt: boolean; readonly other: boolean }

/**
 * Follows what a page's view sees of the pointer and the keys, for the loupe over it, in
 * the main process: `tell` hears when it shows or hides, when its tool goes on or off, and
 * where the pointer moves while it shows. `guard` hears whether the window is to leave its
 * menu bar alone, which a bare Alt would show: while the pointer is over the page or Alt is
 * down. `escape` says whether the loupe took Esc, as it does while its tool is on, so the
 * page doesn't also.
 */
export const createLoupeWatch = (
  tell: (notice: Omit<PageLoupeNotice, "contentsId">) => void,
  guard: (on: boolean) => void = () => undefined,
) => {
  let state = loupeIdle
  let at: Point = { x: 0, y: 0 }
  let guarding = false
  const told = (): void =>
    tell({ shown: loupeShown(state), toggled: state.toggled, x: at.x, y: at.y })
  // Applies an input, and tells where it changed what's shown or whether the tool is on.
  const apply = (input: LoupeInput): LoupeState => {
    const before = state
    state = loupeStep(state, input)
    if (loupeShown(before) !== loupeShown(state) || before.toggled !== state.toggled) told()
    const guards = state.over || state.alt
    if (guards !== guarding) {
      guarding = guards
      guard(guards)
    }
    return before
  }
  return {
    state: (): LoupeState => state,
    /**
     * The pointer is at `x`, `y` of the page's view. Electron's mouse events carry no
     * modifiers, so Alt is the keys' to say.
     */
    pointer: (x: number, y: number): void => {
      at = { x, y }
      const was = loupeShown(state)
      apply({ kind: "enter" })
      if (was) told()
    },
    leave: (): void => {
      apply({ kind: "leave" })
    },
    /** The viewer is out of sight, or gone: no pointer is over it. */
    away: (): void => {
      apply({ kind: "away" })
    },
    /** A key says what's held now. */
    keys: (held: Held): void => {
      apply({ kind: "keys", ...held })
    },
    /** Whether Esc was the loupe's: it is while its tool is on. */
    escape: (): boolean => apply({ kind: "escape" }).toggled,
    toggle: (on: boolean): void => {
      apply({ kind: "toggle", on })
    },
  }
}

/**
 * What a key event, from Electron's `before-input-event`, says is held after it: Alt, and
 * Ctrl, Meta or Shift. The Alt key itself says by whether it went down; AltGr, which types
 * letters, is no Alt (Windows reports it as Ctrl and Alt: `other` catches that), and its
 * going up lets go of it; any other key says what it carries.
 */
export const heldAfter = (input: {
  readonly type: string
  readonly key: string
  readonly alt?: boolean
  readonly control?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}): Held => {
  const other = input.control === true || input.meta === true || input.shift === true
  if (input.key === "Alt") return { alt: input.type === "keyDown", other }
  if (input.key === "AltGraph") return { alt: false, other: false }
  return { alt: input.alt === true, other }
}
