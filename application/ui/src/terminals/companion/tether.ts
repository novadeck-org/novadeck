import { RestrictToElement } from "@dnd-kit/dom/modifiers"

// What stays on its terminal's bar, the messages: dragged off the bar, its icon stretches
// toward the pointer, giving less the further it's pulled, and springs back when let go.
// Nothing beyond the bar takes it.

// How far past an edge the icon goes at most, however far the pointer pulls.
const reach = 40

// Pulled `over` past an edge, how far the icon goes: at first nearly as far, then less and
// less, never `reach`.
export const give = (over: number): number =>
  Math.sign(over) * reach * (1 - 1 / ((Math.abs(over) * 0.55) / reach + 1))

type Bounds = {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

const pull = (value: number, min: number, max: number): number =>
  value < min ? min - give(min - value) : value > max ? max + give(value - max) : value

// Where an icon held to `bounds` goes for the pointer at `x`, `y`.
export const tetherPoint = (
  x: number,
  y: number,
  bounds: Bounds,
): { readonly x: number; readonly y: number } => ({
  x: pull(x, bounds.left, bounds.right),
  y: pull(y, bounds.top, bounds.bottom),
})

// Whether the point is past the bounds' edge.
export const beyond = (x: number, y: number, bounds: Bounds): boolean =>
  x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom

// Says, by the pointer, that a drop here can't happen, or no longer.
export const refuseDrop = (refused: boolean): void => {
  if (refused) document.documentElement.dataset.dragRefused = ""
  else delete document.documentElement.dataset.dragRefused
}

// The bar's drag, held to an element: inside, as dragged; past its edge, stretching.
class Tether extends RestrictToElement {
  override apply(operation: Parameters<RestrictToElement["apply"]>[0]): { x: number; y: number } {
    const free = operation.transform
    const held = super.apply(operation)
    return { x: held.x + give(free.x - held.x), y: held.y + give(free.y - held.y) }
  }
}

// A sortable's modifier holding its drag to the element `within` finds.
export const tether = (
  within: (operation: RestrictToElement["manager"]["dragOperation"]) => Element | null,
): ReturnType<typeof RestrictToElement.configure> =>
  ({ plugin: Tether, options: { element: within } }) as unknown as ReturnType<
    typeof RestrictToElement.configure
  >
