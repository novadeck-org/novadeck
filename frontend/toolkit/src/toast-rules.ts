// What a toast stack decides, apart from the markup and Ark's machine.

// A click on a toast within this long of its landing does nothing: it was meant for what
// lay under the pointer before the toast came.
export const clickGraceMs = 400

export const ignoresClick = (landedAt: number, now: number): boolean =>
  now - landedAt < clickGraceMs

// How many toasts wait behind the ones the stack shows.
export const moreOf = (total: number, shown: number): number => Math.max(0, total - shown)

// Whether the pointer has moved onto the stack since a toast landed or the pointer left. A
// browser may send a mouse event for a pointer resting where a toast appears (Chrome does
// after a layout moves under it), and Zag takes every one for a hover; only a pointer that
// has travelled counts here.
export type Arrival = {
  // A toast landed, or the pointer left: the next hover must be a new move.
  readonly reset: () => void
  // A mouse event's movement.
  readonly moved: (movement: { readonly x: number; readonly y: number }) => void
  readonly arrived: () => boolean
}

// How far the pointer travels after a reset before it has gone somewhere, in px: more than
// the jitter of a hand at rest.
export const arrivalTravel = 3

export const createArrival = (): Arrival => {
  let travelled = 0
  return {
    reset: () => {
      travelled = 0
    },
    moved: (movement) => {
      travelled += Math.abs(movement.x) + Math.abs(movement.y)
    },
    arrived: () => travelled >= arrivalTravel,
  }
}
