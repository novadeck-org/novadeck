import type { Sprite } from "./critters"

// A critter's LED screen, laid on whole device pixels: each of its 8×8 cells a whole number
// of them and, once a cell has three or more, a gap of one, the grid centred with what's
// left over as bezel. Fractional cells would smear the gaps to blur on a 1× screen; below
// three pixels a cell, the cells are solid.

export const screenCells = 8

export type LedGrid = {
  // The screen's side, in device pixels, which the drawing's view box spans.
  readonly device: number
  readonly cell: number
  readonly gap: number
  readonly offset: number
}

// The grid of a screen `size` CSS pixels across, at `scale` device pixels to one.
export const ledGrid = (size: number, scale: number): LedGrid => {
  const device = size * scale
  const cell = Math.max(1, Math.floor(device / screenCells))
  return {
    device,
    cell,
    gap: cell >= 3 ? 1 : 0,
    offset: Math.floor((device - cell * screenCells) / 2),
  }
}

export type Cell = readonly [x: number, y: number]

// The cells as one path, each a square of the grid, so neighbours never seam.
export const cellsPath = (grid: LedGrid, cells: readonly Cell[]): string => {
  const side = grid.cell - grid.gap
  return cells
    .map(
      ([x, y]) =>
        `M${grid.offset + x * grid.cell} ${grid.offset + y * grid.cell}h${side}v${side}h-${side}z`,
    )
    .join("")
}

// Every cell of the screen, lit or not.
export const allCells: readonly Cell[] = Array.from(
  { length: screenCells * screenCells },
  (_, at) => [at % screenCells, Math.floor(at / screenCells)] as const,
)

// A sprite's cells by what they show, in `drawn.ts`'s legend.
export type Tones = Readonly<Record<"#" | "+" | "o" | "x" | "e" | "g", readonly Cell[]>>

export const tonesOf = (sprite: Sprite): Tones => {
  const tones: Record<keyof Tones, Cell[]> = { "#": [], "+": [], o: [], x: [], e: [], g: [] }
  sprite.forEach((row, y) =>
    [...row].forEach((char, x) => {
      if (char in tones) tones[char as keyof Tones].push([x, y])
    }),
  )
  return tones
}

const blank = (row: string | undefined): boolean => !row || /^\.*$/.test(row)

// The other frame of a hop: a row up where the top row is clear, else a row down where the
// bottom one is, else a row up with the top row past the screen's edge.
export const hopped = (sprite: Sprite): Sprite => {
  const empty = ".".repeat(screenCells)
  if (!blank(sprite[0]) && blank(sprite.at(-1))) return [empty, ...sprite.slice(0, -1)]
  return [...sprite.slice(1), empty]
}
