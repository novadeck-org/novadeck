import type { ChatSliceRun } from "../conversation"

// The sixteen colours a terminal's theme picks; the look's build takes them from the theme.
const named = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
]

const hex = (value: number): string => value.toString(16).padStart(2, "0")

// A step of the 6x6x6 cube as its colour's level.
const level = (step: number): string => hex(step === 0 ? 0 : 55 + step * 40)

// A palette index as CSS: the sixteen named, the 6x6x6 cube, then the grey ramp.
export const paletteColour = (index: number): string => {
  if (index < 16) return named[index]!
  if (index >= 232) {
    const grey = hex(8 + (index - 232) * 10)
    return `#${grey}${grey}${grey}`
  }
  const cube = index - 16
  return `#${level(Math.floor(cube / 36))}${level(Math.floor(cube / 6) % 6)}${level(cube % 6)}`
}

const colour = (value: number | string | null): string | undefined =>
  value === null ? undefined : typeof value === "string" ? value : paletteColour(value)

// The defaults an inverse run swaps: `currentColor` would be its own text's.
const paper = "var(--chat-raw-bg, var(--color-paper))"
const ink = "var(--chat-raw-fg, var(--color-ink))"

// A run's style as CSS properties.
export const sliceRunStyle = (run: ChatSliceRun) => {
  const fg = colour(run.fg)
  const bg = colour(run.bg)
  return {
    color: run.inverse ? (bg ?? paper) : fg,
    backgroundColor: run.inverse ? (fg ?? ink) : bg,
    fontWeight: run.bold ? 700 : undefined,
    opacity: run.dim ? 0.6 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecorationLine: run.underline ? "underline" : undefined,
  }
}
