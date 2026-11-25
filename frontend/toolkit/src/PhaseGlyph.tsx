import type { CSSProperties } from "react"

// What a phase glyph draws (phase-glyph.css): a terminal's phase is one of these, and any other
// row names its own states by the look each should take.
export type GlyphPhase =
  | "idle"
  | "running"
  | "starting"
  | "waking"
  | "sleeping"
  | "unheard"
  | "paused"
  | "waiting"
  | "done"
  | "ended"

// What a waiting glyph waits on: a job it left running (a drip), or a wake-up, its mark filling a
// quarter at a time from 0 to 3 as it nears.
export type GlyphWait =
  | { readonly kind: "job" }
  | { readonly kind: "wake"; readonly fill?: number | undefined }

// Glyphs side by side start their spinners at frames of their own, so they don't tick as one.
export const glyphDelay = (index: number): CSSProperties => ({
  animationDelay: `-${((index + 1) * 260) % 800}ms`,
})

// One glyph's slot, saying what something in a row does (phase-glyph.css). Drawn only: the row
// says it in words for assistive technology.
export const PhaseGlyph = ({
  phase,
  failed = false,
  wait,
  className = "",
  style,
}: {
  readonly phase: GlyphPhase
  // Done, but on a failure: a red cross for the green check.
  readonly failed?: boolean
  readonly wait?: GlyphWait | undefined
  readonly className?: string
  readonly style?: CSSProperties | undefined
}): React.JSX.Element => (
  <span
    aria-hidden
    className={`phase-glyph ${className}`.trimEnd()}
    data-phase={phase}
    {...(phase === "done" && failed ? { "data-failed": true } : {})}
    {...(wait ? { "data-wait": wait.kind } : {})}
    {...(wait?.kind === "wake" && wait.fill !== undefined ? { "data-wake-fill": wait.fill } : {})}
    {...(style ? { style } : {})}
  />
)
