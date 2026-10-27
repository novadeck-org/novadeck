import { drawnCritters } from "./drawn"

// Each handle's critter: the sprite drawn for its word, its hue by the word's rank, and the
// clocks it blinks and hops by. Only the Messages pane draws them.

// A sprite's cells, top row first, each row eight characters in `drawn.ts`'s legend.
export type Sprite = readonly string[]

const drawn = new Map(drawnCritters.map(([word, rows]) => [word, rows.split("/")]))
const ranks = new Map(drawnCritters.map(([word], rank) => [word, rank]))

// A handle's word, and the number an older session's later round gave it: `mothz` and
// `mothzy` are `moth`, and `moth2` is `moth`, 2. Today's rounds add letters, which carry no
// badge, so a handle that isn't a word is the longest word it starts with.
export const handleParts = (
  handle: string,
): { readonly word: string; readonly numeral: string } => {
  const unnumbered = handle.replace(/\d+$/, "")
  const numeral = handle.slice(unnumbered.length)
  for (let end = unnumbered.length; end >= unnumbered.length - 2 && end > 0; end--)
    if (drawn.has(unnumbered.slice(0, end))) return { word: unnumbered.slice(0, end), numeral }
  return { word: unnumbered, numeral }
}

// A word's seed: FNV-1a, so a word always draws the same.
const seedOf = (word: string): number => {
  let hash = 2166136261
  for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

// mulberry32: numbers in [0, 1) from a seed, the same run for the same seed.
const random = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One of eight hues, going round in the words' rank, so a session's first eight differ. A
// word the runner gave after these were drawn takes one by its seed.
export const hueOf = (handle: string): number => {
  const { word } = handleParts(handle)
  return ((ranks.get(word) ?? seedOf(word)) % 8) + 1
}

// For a word with no drawing: a critter of one of the generated kinds, its left half
// mirrored, with dark or bright eyes at its kind's place.
const kinds: readonly { readonly rows: Sprite; readonly eye: readonly [number, number] }[] = [
  { rows: ["....", "....", "....", "..##", ".###", "####", "####", "####"], eye: [2, 5] },
  { rows: ["....", "#...", "##..", "####", "####", "####", ".###", ".#.."], eye: [2, 4] },
  { rows: [".#..", ".#..", ".##.", "####", "####", "####", ".###", ".#.."], eye: [2, 4] },
  { rows: ["#...", ".#..", "..##", ".###", "####", ".###", "####", "#.#."], eye: [2, 3] },
  { rows: ["....", "#...", "####", "####", "####", "####", ".###", "..#."], eye: [1, 3] },
  { rows: ["....", "..##", ".###", "####", "####", "####", "####", "#.#."], eye: [2, 3] },
  { rows: ["#...", "#...", ".###", "####", "####", "####", ".###", ".#.."], eye: [2, 3] },
  { rows: ["....", "....", "##..", "####", "####", "####", "####", "##.."], eye: [1, 2] },
  { rows: ["....", "..##", ".###", "####", "####", "#.#.", "#.#.", ".#.#"], eye: [2, 3] },
  { rows: ["....", "..#.", "#.##", "####", "####", ".###", "..##", "...."], eye: [2, 3] },
  { rows: ["...#", "..##", ".###", "####", "####", "..#.", ".#.#", "#.#."], eye: [2, 3] },
]

const mirrored = (rows: Sprite): string[] => rows.map((row) => row + [...row].toReversed().join(""))

const generated = (word: string): Sprite => {
  const seed = seedOf(word)
  const kind = kinds[seed % kinds.length]!
  const eye = (seed >>> 8) % 2 ? "e" : "x"
  const [x, y] = kind.eye
  return mirrored(kind.rows).map((row, at) =>
    at === y ? `${row.slice(0, x)}${eye}${row.slice(x + 1, 7 - x)}${eye}${row.slice(8 - x)}` : row,
  )
}

export const spriteOf = (handle: string): Sprite => {
  const { word } = handleParts(handle)
  return drawn.get(word) ?? generated(word)
}

// The person: the backlit imp, a dark silhouette with little horns against a lit screen,
// its eyes (`g`) glowing.
export const imp: Sprite = mirrored([
  "#...",
  ".#..",
  ".###",
  ".###",
  ".#g#",
  ".###",
  "..##",
  ".#..",
])

// When a critter blinks and hops, in seconds: a blink every 6 to 11, and a hop of 1.6 to 2.2
// while its agent works, each started at a point of its own from its word, so a pane of
// critters never moves in step.
export type Clocks = {
  readonly blink: number
  readonly blinkAt: number
  readonly hop: number
  readonly hopAt: number
}

const round = (value: number): number => Math.round(value * 100) / 100

export const clocksOf = (handle: string): Clocks => {
  const next = random(seedOf(handleParts(handle).word) ^ 0x9e37)
  return {
    blink: round(6 + next() * 5),
    blinkAt: round(-next() * 11),
    hop: round(1.6 + next() * 0.6),
    hopAt: round(-next() * 2),
  }
}

export const impClocks: Clocks = { blink: 8.4, blinkAt: -5, hop: 0, hopAt: 0 }
