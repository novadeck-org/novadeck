import {
  arrangeCanvas,
  canvasPlaces,
  growCanvas,
  type Arranged,
  type CanvasArrangement,
} from "@novadeck/core/layout/canvas-arrangement"
import type { XYPosition } from "@xyflow/react"

// One stay on Canvas: how its windows are arranged (core/layout/canvas-arrangement.ts), and
// where the person put the ones they dragged or dropped, which holds until the stay ends.
// A stay begins as Canvas opens and when the person reorders the sidebar. Nothing of it is
// saved.
export type CanvasStay = {
  readonly arrangement: CanvasArrangement
  readonly moved: Readonly<Record<string, XYPosition>>
}

type Room = { readonly width: number; readonly height: number }

export const beginStay = (tiles: readonly Arranged[], room: Room): CanvasStay => ({
  arrangement: arrangeCanvas(tiles, room),
  moved: {},
})

const samePoint = (a: XYPosition | undefined, b: XYPosition | undefined): boolean =>
  a?.x === b?.x && a?.y === b?.y

// The stay once the canvas's windows have changed: what grew is placed, and a window the
// person had moved is where they put it unless it is gone or the arrangement has moved it
// since. The same stay comes back when nothing changed.
export const continueStay = (stay: CanvasStay, tiles: readonly Arranged[]): CanvasStay => {
  const arrangement = growCanvas(stay.arrangement, tiles)
  const here = new Set(tiles.map((tile) => tile.id))
  const before = canvasPlaces(stay.arrangement)
  const after = arrangement === stay.arrangement ? before : canvasPlaces(arrangement)
  const kept = Object.entries(stay.moved).filter(
    ([id]) => here.has(id) && samePoint(before.get(id), after.get(id)),
  )
  return arrangement === stay.arrangement && kept.length === Object.keys(stay.moved).length
    ? stay
    : { arrangement, moved: Object.fromEntries(kept) }
}

// The person dragged a window, or dropped one, there.
export const moveInStay = (stay: CanvasStay, id: string, position: XYPosition): CanvasStay =>
  samePoint(stay.moved[id], position) ? stay : { ...stay, moved: { ...stay.moved, [id]: position } }

// Where every window of the stay is: where the person put it, or its arranged place.
export const stayPlaces = (stay: CanvasStay): ReadonlyMap<string, XYPosition> =>
  new Map([...canvasPlaces(stay.arrangement), ...Object.entries(stay.moved)])

// A session's stay as Canvas last had it. It is kept with the sidebar's order it was
// arranged for (the count of the person's reorders): a stay arranged for another order is
// not come back to.
export type HeldStay = {
  readonly kept: (reordered: number) => CanvasStay | undefined
  readonly keep: (stay: CanvasStay, reordered: number) => void
}

// Each session's stay, held by the stage, which outlives the views: going to Focus by a
// window's own button and coming back finds Canvas as it was left.
export type CanvasStays = { readonly of: (context: string) => HeldStay }

export const createCanvasStays = (): CanvasStays => {
  const stays = new Map<string, { readonly stay: CanvasStay; readonly reordered: number }>()
  return {
    of: (context) => ({
      kept: (reordered) => {
        const held = stays.get(context)
        return held?.reordered === reordered ? held.stay : undefined
      },
      keep: (stay, reordered) => void stays.set(context, { stay, reordered }),
    }),
  }
}
