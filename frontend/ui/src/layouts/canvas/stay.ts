import {
  arrangeCanvas,
  canvasPlaces,
  growCanvas,
  type Arranged,
  type CanvasArrangement,
} from "@novadeck/core/layout/canvas-arrangement"
import { isWindow } from "@novadeck/core/roster"
import type { TerminalMetadata, Tile } from "@novadeck/core/types"
import type { Viewport, XYPosition } from "@xyflow/react"

// One stay on Canvas: how its windows are arranged (core/layout/canvas-arrangement.ts), and
// where the person put the ones they dragged or dropped, which holds until the stay ends.
// A stay begins as Canvas opens and when the person reorders the sidebar. Nothing of it is
// saved.
export type CanvasStay = {
  readonly arrangement: CanvasArrangement
  readonly moved: Readonly<Record<string, XYPosition>>
}

type Room = { readonly width: number; readonly height: number }

// The handle of the terminal that leads this one: the one its backend named, whether or
// not that agent runs yet, as the sidebar lists it under that lead (core/state.ts). Until
// the backend has described it (it has no handle yet), the one that opened it, which the
// sidebar lists it under at once. So an agent its lead opens lands in that lead's team
// from the first, not in the block with a slot left empty behind it; and a canvas
// arranged while its leads still start has its teams, and a lead that ends or restarts
// moves nothing.
const leadHandle = (tile: TerminalMetadata): string | undefined =>
  tile.ledBy ?? (tile.handle === undefined ? (tile.openedBy ?? undefined) : undefined)

// The windows the canvas arranges, in the order given but for those left out, each with
// the window that leads it.
export const arrangedTiles = (
  tiles: readonly Tile[],
  omit: (tile: Tile) => boolean,
): readonly Arranged[] => {
  const byHandle = new Map<string, string>()
  for (const tile of tiles)
    if (!isWindow(tile) && tile.handle !== undefined && !byHandle.has(tile.handle))
      byHandle.set(tile.handle, tile.id)
  return tiles
    .filter((tile) => !omit(tile))
    .map((tile) => {
      const lead = isWindow(tile) ? undefined : leadHandle(tile)
      return { id: tile.id, lead: lead === undefined ? undefined : byHandle.get(lead) }
    })
}

export const beginStay = (tiles: readonly Arranged[], room: Room): CanvasStay => ({
  arrangement: arrangeCanvas(tiles, room),
  moved: {},
})

export const samePoint = (a: XYPosition | undefined, b: XYPosition | undefined): boolean =>
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

// A stay as Canvas left it, with the camera it left with.
export type KeptStay = { readonly stay: CanvasStay; readonly camera: Viewport }

// A session's stay as Canvas last had it. It is kept with the sidebar's order it was
// arranged for (the count of the person's reorders): a stay arranged for another order is
// not come back to.
export type HeldStay = {
  readonly kept: (reordered: number) => KeptStay | undefined
  readonly keep: (stay: CanvasStay, reordered: number, camera: Viewport) => void
}

// Each session's stay, held by the stage, which outlives the views: going to Focus by a
// window's own button and coming back finds Canvas as it was left.
export type CanvasStays = { readonly of: (context: string) => HeldStay }

export const createCanvasStays = (): CanvasStays => {
  const stays = new Map<string, KeptStay & { readonly reordered: number }>()
  return {
    of: (context) => ({
      kept: (reordered) => {
        const held = stays.get(context)
        return held?.reordered === reordered ? { stay: held.stay, camera: held.camera } : undefined
      },
      keep: (stay, reordered, camera) => void stays.set(context, { stay, reordered, camera }),
    }),
  }
}
