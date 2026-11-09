import { canvasWindowSize as size } from "./terminal-size"

// Where Canvas puts its windows. Nobody arranges them: the place of each follows from the
// sidebar's order and from who leads whom. Windows on no team sit in one compact block, in
// that order, filled from its end: its last row is full and its first row is the short
// one, against the right. A new terminal, which the sidebar lists first, so takes the next
// place at the start and moves no other window, then or on the next visit. Each team is an island that reads left to right: its lead, then its team in
// the next column, a teammate that leads one step further right with its own team.
//
// An arrangement lasts for one visit to Canvas. While it lasts, what grows moves at once
// and only as far as it must, and what shrinks moves nothing: a window that closes leaves
// its place empty, and a lead whose team has ended stays where it is. The next visit, or a
// reorder of the sidebar, arranges everything afresh.

// A window to arrange: a terminal or an undocked window, and the window that leads it, if
// one does and is on the canvas too.
export type Arranged = { readonly id: string; readonly lead?: string | undefined }

type Point = { readonly x: number; readonly y: number }
type Room = { readonly width: number; readonly height: number }

// A place in the block or in a team: the window that holds it (there or gone), or null
// where one left for another place.
type Cell = string | null

export type CanvasArrangement = {
  // The block's slots in reading order, placed from the last: the last slot is the bottom
  // right corner.
  readonly block: readonly Cell[]
  // The islands' leads, in the islands' order.
  readonly islands: readonly string[]
  // Each lead's team as it was placed, in order.
  readonly teams: Readonly<Record<string, readonly Cell[]>>
  // How it is packed: the block's width in windows, the islands beside the block or below
  // it, and how far they run before they wrap to another column or row: as far as the
  // block or the largest island ran when it was arranged afresh, or without end. Set then
  // and kept, so that what grows later never undoes a wrap.
  readonly columns: number
  // How many rows the block had when it was arranged afresh, which the islands are packed
  // beside or below. Rows that grow at the block's start later go above them, so that
  // nothing placed moves.
  readonly rows: number
  readonly beside: boolean
  readonly limit: number
}

// Between windows, as Canvas has always kept them.
const gap = 60
const pitch = { x: size.width + gap, y: size.height + gap }
// Between a lead and its team, where the wire's trunk runs; and between islands.
const level = 144
const apart = 240
// A team with no team inside it stacks this deep before it takes another column.
const deep = 3

const held = (cell: Cell): cell is string => cell !== null

// Who leads whom among the windows given. A loop of leads, which nothing forbids, is cut at
// its first window in order: that one leads the rest.
const leadsAmong = (tiles: readonly Arranged[]): ReadonlyMap<string, string> => {
  const ids = new Set(tiles.map((tile) => tile.id))
  const leads = new Map<string, string>()
  for (const { id, lead } of tiles)
    if (lead !== undefined && lead !== id && ids.has(lead)) leads.set(id, lead)
  for (const { id } of tiles) {
    const seen = new Set([id])
    for (let up = leads.get(id); up !== undefined && !seen.has(up); up = leads.get(up)) {
      seen.add(up)
      if (leads.get(up) === id) leads.delete(id)
    }
  }
  return leads
}

type Spot = readonly [id: string, x: number, y: number]
type Box = { readonly w: number; readonly h: number; readonly at: readonly Spot[] }

// A team as an island: the lead, then its team in the next column. Teammates that lead no
// one come first, filled down `deep` to a column and then across, so that one joining
// moves none placed before it; one that leads comes below them, its own island starting
// where it stands.
const island = (teams: CanvasArrangement["teams"], lead: string): Box => {
  const members = teams[lead] ?? []
  const own: Spot = [lead, 0, 0]
  if (!members.length) return { w: size.width, h: size.height, at: [own] }
  const leadsNow = (cell: Cell): cell is string => held(cell) && Boolean(teams[cell]?.length)
  const plain = members.filter((cell) => !leadsNow(cell))
  const nested = members.filter(leadsNow).map((cell) => island(teams, cell))
  const left = size.width + level
  const at: Spot[] = [own]
  plain.forEach((cell, n) => {
    if (held(cell)) at.push([cell, left + Math.floor(n / deep) * pitch.x, (n % deep) * pitch.y])
  })
  let y = Math.min(plain.length, deep) * pitch.y
  let width = plain.length ? Math.ceil(plain.length / deep) * pitch.x - gap : 0
  for (const each of nested) {
    for (const [id, x, top] of each.at) at.push([id, left + x, y + top])
    y += each.h + gap
    width = Math.max(width, each.w)
  }
  return { w: left + width, h: Math.max(size.height, y - gap), at }
}

// The block's box: its slots, `columns` across, `rows` down.
const blockBox = (
  slots: number,
  columns: number,
  rows = Math.ceil(slots / columns),
): { w: number; h: number } | undefined =>
  slots && rows
    ? {
        w: Math.min(columns, slots) * pitch.x - gap,
        h: rows * pitch.y - gap,
      }
    : undefined

const along = (box: { w: number; h: number }, beside: boolean): number => (beside ? box.h : box.w)

// How far the islands may run: as far as the block or the largest island does.
const reach = (
  block: { w: number; h: number } | undefined,
  islands: readonly Box[],
  beside: boolean,
): number =>
  Math.max(block ? along(block, beside) : 0, ...islands.map((each) => along(each, beside)))

// Where each island goes: down beside the block, or across below it, starting a new column
// or row where the next would pass `limit`.
const pack = (
  block: { w: number; h: number } | undefined,
  islands: readonly Box[],
  beside: boolean,
  limit: number,
): { readonly places: readonly Point[]; readonly w: number; readonly h: number } => {
  const across = (box: { w: number; h: number }): number => (beside ? box.w : box.h)
  const places: Point[] = []
  let run = 0
  let offset = block ? across(block) + apart : 0
  let thick = 0
  for (const each of islands) {
    if (run > 0 && run + along(each, beside) > limit + 1) {
      run = 0
      offset += thick + apart
      thick = 0
    }
    places.push(beside ? { x: offset, y: run } : { x: run, y: offset })
    run += along(each, beside) + apart
    thick = Math.max(thick, across(each))
  }
  return {
    places,
    w: Math.max(block?.w ?? 0, ...islands.map((each, n) => places[n]!.x + each.w)),
    h: Math.max(block?.h ?? 0, ...islands.map((each, n) => places[n]!.y + each.h)),
  }
}

type Packing = Pick<CanvasArrangement, "columns" | "rows" | "beside" | "limit">

const packed = (
  arrangement: Pick<CanvasArrangement, "block" | "islands" | "teams"> & Packing,
): { readonly boxes: readonly Box[] } & ReturnType<typeof pack> => {
  const boxes = arrangement.islands.map((lead) => island(arrangement.teams, lead))
  return {
    boxes,
    ...pack(
      blockBox(arrangement.block.length, arrangement.columns, arrangement.rows),
      boxes,
      arrangement.beside,
      arrangement.limit,
    ),
  }
}

// The most columns the block is tried at.
const widest = 8

// Arranges every window afresh for a canvas with this much room: the block in the order
// given, an island for each lead in that order, and the packing that shows them all
// largest. Of packings that show them about as large, the narrower block and the islands
// beside it win.
export const arrangeCanvas = (tiles: readonly Arranged[], room: Room): CanvasArrangement => {
  const leads = leadsAmong(tiles)
  const teams: Record<string, string[]> = {}
  for (const { id } of tiles) {
    const lead = leads.get(id)
    if (lead !== undefined) (teams[lead] ??= []).push(id)
  }
  const roots = tiles.filter((tile) => !leads.has(tile.id)).map((tile) => tile.id)
  const placed = {
    block: roots.filter((id) => !teams[id]),
    islands: roots.filter((id) => teams[id]),
    teams,
  }
  let best: { readonly zoom: number; readonly packing: Packing } | undefined
  for (let columns = 1; columns <= Math.max(1, Math.min(placed.block.length, widest)); columns++)
    for (const beside of [true, false])
      for (const wrap of [true, false]) {
        const boxes = placed.islands.map((lead) => island(placed.teams, lead))
        const limit = wrap ? reach(blockBox(placed.block.length, columns), boxes, beside) : Infinity
        const rows = Math.ceil(placed.block.length / columns)
        const packing = { columns, rows, beside, limit }
        const { w, h } = packed({ ...placed, ...packing })
        const zoom = Math.min(room.width / Math.max(w, 1), room.height / Math.max(h, 1))
        if (!best || zoom > best.zoom * 1.03) best = { zoom, packing }
      }
  return { ...placed, ...best!.packing }
}

// The arrangement once the windows have changed during a visit. A window new to the canvas
// goes first in the block, where the sidebar lists a new terminal, or last in its lead's
// team. One that starts to lead leaves the
// block for a new island after the others, and one that gets a lead joins that lead's
// team; each leaves its slot empty. Nothing else moves: a window that is gone keeps its
// place, empty, and one whose lead is gone or leads no more stays where it was. The same
// arrangement comes back when nothing has to move.
export const growCanvas = (
  arrangement: CanvasArrangement,
  tiles: readonly Arranged[],
): CanvasArrangement => {
  // Moving one window can unsettle one placed before it, as when a lead starts an island
  // out of the team of a window it now leads: placed again until nothing moves, so that the
  // same windows never move a second time on their own.
  let grown = arrangement
  for (let pass = 0; pass <= tiles.length; pass++) {
    const next = settled(grown, tiles)
    if (next === grown) break
    grown = next
  }
  return grown
}

const settled = (arrangement: CanvasArrangement, tiles: readonly Arranged[]): CanvasArrangement => {
  const leads = leadsAmong(tiles)
  const leading = new Set(leads.values())
  const block = [...arrangement.block]
  let islands = [...arrangement.islands]
  const teams: Record<string, Cell[]> = Object.fromEntries(
    Object.entries(arrangement.teams).map(([lead, cells]) => [lead, [...cells]]),
  )
  // The lead each placed teammate sits under.
  const under = new Map<string, string>()
  for (const [lead, cells] of Object.entries(teams))
    for (const cell of cells) if (held(cell)) under.set(cell, lead)
  const has = (id: string): boolean =>
    block.includes(id) || arrived.includes(id) || islands.includes(id) || under.has(id)
  let moved = false
  // Windows new to the block, in order, which go before the rest.
  const arrived: string[] = []
  const leave = (id: string): void => {
    const slot = block.indexOf(id)
    const lead = under.get(id)
    if (slot >= 0) block[slot] = null
    else if (lead !== undefined) {
      teams[lead] = teams[lead]!.map((cell) => (cell === id ? null : cell))
      under.delete(id)
    } else islands = islands.filter((each) => each !== id)
    moved = true
  }
  const startIsland = (id: string): void => {
    leave(id)
    islands.push(id)
  }
  // Whether `id` is placed somewhere below `lead`.
  const below = (id: string, lead: string): boolean => {
    for (let up = under.get(id); up !== undefined; up = under.get(up)) if (up === lead) return true
    return false
  }
  const settle = (id: string): void => {
    const lead = leads.get(id)
    if (lead === undefined) {
      if (!has(id)) {
        if (leading.has(id)) islands.push(id)
        else arrived.push(id)
        moved = true
      } else if (block.includes(id) && leading.has(id)) startIsland(id)
      return
    }
    settle(lead)
    if (under.get(id) === lead) return
    // Its new lead still sits in its own old team: that one starts an island first.
    if (below(lead, id)) startIsland(lead)
    if (has(id)) leave(id)
    teams[lead] = [...(teams[lead] ?? []), id]
    under.set(id, lead)
    moved = true
  }
  for (const { id } of tiles) settle(id)
  return moved ? { ...arrangement, block: [...arrived, ...block], islands, teams } : arrangement
}

// Where each window's top left corner is, by id. A window that is gone has its place too,
// as its place is kept.
export const canvasPlaces = (arrangement: CanvasArrangement): ReadonlyMap<string, Point> => {
  const { boxes, places } = packed(arrangement)
  const at = new Map<string, Point>()
  const { block, columns, rows } = arrangement
  block.forEach((cell, n) => {
    // Counted from the last slot, which sits in the bottom row's right corner.
    const back = block.length - 1 - n
    if (held(cell))
      at.set(cell, {
        x: (columns - 1 - (back % columns)) * pitch.x,
        y: (rows - 1 - Math.floor(back / columns)) * pitch.y,
      })
  })
  boxes.forEach((box, n) => {
    for (const [id, x, y] of box.at) at.set(id, { x: places[n]!.x + x, y: places[n]!.y + y })
  })
  return at
}
