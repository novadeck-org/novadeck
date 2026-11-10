import { configurator, Modifier, type DragDropManager, type DragOperation } from "@dnd-kit/abstract"

// A drag held to its list until the person pulls it out, as a game makes a thing resist before
// it gives: past the list's edge the dragged element stretches less and less the further the
// pointer goes, and once the pointer is far enough out it breaks free and follows it. Every
// list that lets something leave it drags with this, so the feel is the same everywhere and is
// tuned here.

type Point = { readonly x: number; readonly y: number }
type Box = {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

// How a pull feels: `give`, the most the element stretches past the edge, which it nears but
// never reaches; `breakAt`, how far past the edge the pointer must go to pull it free; `snapMs`,
// how long it takes, once free, to catch up with the pointer.
export type PullFeel = {
  readonly give: number
  readonly breakAt: number
  readonly snapMs?: number
}

export const defaultPull: PullFeel = { give: 24, breakAt: 72, snapMs: 160 }

// Where a pull stands: how taut it is, from 0 at the edge to 1 as it breaks; whether it broke
// free; and how far past the edge the element shows, along the pointer's way out.
export type Pull = {
  readonly tension: number
  readonly free: boolean
  readonly shown: Point
}

// How far a rubber band of `give` stretches when pulled `by`: half its give at `give`, and
// ever closer to all of it beyond.
export const stretch = (by: number, give: number): number => give * (1 - 1 / (1 + by / give))

// The pull of a pointer `past` the edge (how far beyond it, across and down; 0 within it).
export const pull = (past: Point, feel: PullFeel = defaultPull): Pull => {
  const distance = Math.hypot(past.x, past.y)
  if (distance >= feel.breakAt) return { tension: 1, free: true, shown: past }
  if (distance === 0) return { tension: 0, free: false, shown: { x: 0, y: 0 } }
  const scale = stretch(distance, feel.give) / distance
  return {
    tension: distance / feel.breakAt,
    free: false,
    shown: { x: past.x * scale, y: past.y * scale },
  }
}

// The feel along the pointer's way out when the pointer has only `room` left to go that way
// (to the edge of where the element may be, or the window): it breaks free no further out than
// most of that room, so wherever it was grabbed, a pull that way can free it.
export const pullWithin = (feel: PullFeel, room: number): PullFeel =>
  room * 0.85 < feel.breakAt ? { ...feel, breakAt: Math.max(room * 0.85, feel.give) } : feel

// How far the pointer at `at` can still go along `way` before it leaves `bounds`.
export const roomAlong = (at: Point, way: Point, bounds: Box): number =>
  Math.abs(way.x) >= Math.abs(way.y)
    ? way.x < 0
      ? at.x - bounds.left
      : bounds.right - at.x
    : way.y < 0
      ? at.y - bounds.top
      : bounds.bottom - at.y

// How far a box moved by `by` must move back to stay within `bounds`, across and down: 0
// along an axis where it stays inside.
export const overflow = (box: Box, by: Point, bounds: Box): Point => ({
  x: past(box.left + by.x, box.right + by.x, bounds.left, bounds.right),
  y: past(box.top + by.y, box.bottom + by.y, bounds.top, bounds.bottom),
})

// How far a span from `low` to `high` goes past `min` (negative) or `max` (positive).
const past = (low: number, high: number, min: number, max: number): number =>
  low < min ? low - min : high > max ? high - max : 0

// An element, or what finds it as a drag starts.
type Bound = Element | null | (() => Element | null)

export type PullOutOptions = {
  // The list the dragged element is held to.
  readonly element: Bound
  // Where it may go once free; anywhere without it.
  readonly within?: Bound
  readonly feel?: PullFeel
  // Told as the pull changes: its tension, and once it has broken free.
  readonly onPull?: (pull: Pick<Pull, "tension" | "free">) => void
}

const resolve = (bound: Bound | undefined): Element | null =>
  typeof bound === "function" ? bound() : (bound ?? null)

const boxOf = (element: Element): Box => element.getBoundingClientRect()

const windowBox = (): Box => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight })

// The pull as a dnd-kit modifier, for any list's `DragDropProvider`: the dragged element stays
// in `element` until it is pulled free, then stays in `within`. The element shows the pull
// itself for its CSS (drag-pull.css draws it): `data-pull` is "taut" while it resists,
// "snapping" as it catches up with the pointer once it gave (for `--pull-snap-duration`), then
// "free"; `--pull-tension` runs from 0 to 1, and `--pull-x` and `--pull-y` (each -1 to 1) are
// the way it is pulled. A drag from the keyboard steps through the list only, and
// never pulls out.
export class PullOut extends Modifier<DragDropManager<any, any>, PullOutOptions> {
  static configure = configurator(PullOut)

  constructor(manager: DragDropManager<any, any>, options?: PullOutOptions) {
    super(manager, options)
    // Each drag starts its own pull, and leaves nothing on its element once it ends.
    const stops = [
      manager.monitor.addEventListener("dragstart", () => {
        this.over = false
        this.end()
      }),
      manager.monitor.addEventListener("dragend", () => {
        this.over = true
        this.end()
      }),
    ]
    this.destroy = () => {
      for (const stop of stops) stop()
      this.end()
    }
  }

  // Where the dragged element started, the list and the space it goes free in: read as the
  // drag starts, and forgotten as it ends.
  private drag:
    | {
        readonly start: Box
        // Where the pointer took hold.
        readonly grab: Point
        readonly list: Box
        readonly within: Box | null
        readonly element: HTMLElement | null
        free: boolean
        tension: number
        // The end of its snap to the pointer, once it broke free.
        snapping?: ReturnType<typeof setTimeout>
      }
    | undefined

  // Whether the drag has ended: the drop still asks for a transform (as its element settles),
  // which must not start a pull again.
  private over = false

  override apply(operation: DragOperation): Point {
    const { transform, shape, status, source, activatorEvent, position } = operation
    const options = this.options
    if (!options || !shape || status.idle || this.over) return transform
    const drag =
      this.drag ?? this.begin(shape.initial.boundingRectangle, position.initial, source, options)
    if (!drag) return transform
    const back = overflow(drag.start, transform, drag.list)
    const inList = { x: transform.x - back.x, y: transform.y - back.y }
    if (activatorEvent instanceof KeyboardEvent) return inList
    if (!drag.free) {
      // As hard as the feel asks, or as there is room for that way: the window, or `within`.
      const room = roomAlong(drag.grab, back, drag.within ?? windowBox())
      const now = pull(back, pullWithin(options.feel ?? defaultPull, room))
      if (now.free) drag.free = true
      else {
        this.tell(drag, now.tension, false, options, back)
        return { x: inList.x + now.shown.x, y: inList.y + now.shown.y }
      }
      this.tell(drag, 1, true, options, back)
      this.snap(drag, options.feel?.snapMs ?? defaultPull.snapMs ?? 0)
      return this.loose(drag, transform)
    }
    return this.loose(drag, transform)
  }

  // It catches up with the pointer from where it was held rather than jumping there: for
  // `snapMs` it is "snapping", which the CSS eases its moves through, then plainly free.
  private snap(drag: NonNullable<PullOut["drag"]>, snapMs: number): void {
    const { element } = drag
    if (!element || snapMs <= 0) return
    element.dataset.pull = "snapping"
    element.style.setProperty("--pull-snap-duration", `${snapMs}ms`)
    drag.snapping = setTimeout(() => {
      if (this.drag === drag) element.dataset.pull = "free"
    }, snapMs)
  }

  // Where a free element goes: with the pointer, within `within`.
  private loose(drag: NonNullable<PullOut["drag"]>, transform: Point): Point {
    if (!drag.within) return transform
    const out = overflow(drag.start, transform, drag.within)
    return { x: transform.x - out.x, y: transform.y - out.y }
  }

  private begin(start: Box, grab: Point, source: unknown, options: PullOutOptions) {
    const list = resolve(options.element)
    if (!list) return undefined
    const within = resolve(options.within)
    const element = (source as { element?: Element } | null)?.element
    this.drag = {
      start,
      grab: { x: grab.x, y: grab.y },
      list: boxOf(list),
      within: within ? boxOf(within) : null,
      element: element instanceof HTMLElement ? element : null,
      free: false,
      tension: 0,
    }
    return this.drag
  }

  private tell(
    drag: NonNullable<PullOut["drag"]>,
    tension: number,
    free: boolean,
    options: PullOutOptions,
    way: Point,
  ): void {
    const changed = free !== drag.free || Math.abs(tension - drag.tension) >= 0.01
    drag.tension = tension
    if (drag.element) {
      drag.element.dataset.pull = free ? "free" : tension > 0 ? "taut" : ""
      const length = Math.hypot(way.x, way.y) || 1
      drag.element.style.setProperty("--pull-tension", tension.toFixed(2))
      drag.element.style.setProperty("--pull-x", (way.x / length).toFixed(2))
      drag.element.style.setProperty("--pull-y", (way.y / length).toFixed(2))
    }
    if (changed || free) options.onPull?.({ tension, free })
  }

  private end(): void {
    clearTimeout(this.drag?.snapping)
    const element = this.drag?.element
    if (element) {
      delete element.dataset.pull
      for (const name of ["--pull-tension", "--pull-x", "--pull-y", "--pull-snap-duration"])
        element.style.removeProperty(name)
    }
    this.drag = undefined
  }
}
