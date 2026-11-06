import type { ChatSlice, ChatSliceRun } from "@novadeck/core/conversation"

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

const styleOf = (run: ChatSliceRun): React.CSSProperties => {
  const fg = colour(run.fg)
  const bg = colour(run.bg)
  return {
    color: run.inverse ? (bg ?? "var(--chat-raw-bg, var(--color-paper))") : fg,
    backgroundColor: run.inverse ? (fg ?? "currentColor") : bg,
    fontWeight: run.bold ? 700 : undefined,
    opacity: run.dim ? 0.6 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: run.underline ? "underline" : undefined,
  }
}

// The terminal's own rows, live, as they are drawn: as wide as its columns, so a narrower
// chat scrolls them. Plain for now; the look comes with the chat's redesign.
export const Slice = ({ slice }: { readonly slice: ChatSlice }): React.JSX.Element => (
  <pre
    className="chat-raw chat-slice nodrag nopan nowheel"
    tabIndex={0}
    aria-label="The terminal's own rows"
    style={{ width: `${slice.columns}ch`, maxWidth: "100%" }}
  >
    {slice.rows.map((row, at) => (
      // A row has no identity but its place on the screen.
      // eslint-disable-next-line react/no-array-index-key
      <div key={at}>
        {row.length === 0
          ? " "
          : row.map((run, part) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={part} style={styleOf(run)}>
                {run.text}
              </span>
            ))}
      </div>
    ))}
  </pre>
)
