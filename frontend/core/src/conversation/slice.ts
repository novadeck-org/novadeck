import type { ChatSliceRun } from "../conversation"

// The sixteen colours of a terminal's palette, in its order, as the theme picks them.
const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
const named = [
  ...ansi.map((colour) => `var(--terminal-ansi-${colour})`),
  ...ansi.map((colour) => `var(--terminal-ansi-${colour}-bright)`),
]

const hex = (value: number): string => value.toString(16).padStart(2, "0")

// A step of the 6x6x6 cube as its colour's level.
const level = (step: number): string => hex(step === 0 ? 0 : 55 + step * 40)

// A palette index as CSS: the theme's sixteen, then the 6x6x6 cube and the grey ramp, which
// are fixed colours on every terminal, as on the one this draws.
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
const paper = "var(--terminal-bg)"
const ink = "var(--terminal-fg)"

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
