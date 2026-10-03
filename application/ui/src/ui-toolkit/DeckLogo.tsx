import { useId, type CSSProperties } from "react"

import { cn } from "../class-name"

// The Deck mark: the brand tile's ">_" square with two terminal cards fanned behind it,
// up and to the right (the deck-logo recipe). `size` is the whole footprint in pixels,
// cards included.
export const DeckMark = ({
  size = 28,
  animated = false,
  className,
}: {
  readonly size?: number
  // Assembles itself, as on the boot splash; still when motion is reduced.
  readonly animated?: boolean
  readonly className?: string | undefined
}): React.JSX.Element => {
  // The prototype's proportions: an 80px face in a 94px footprint, cards 7px apart.
  const face = (size * 80) / 94
  const style = {
    width: size,
    height: size,
    "--_face": `${face}px`,
    "--_k1": `${(size * 7) / 94}px`,
    "--_k2": `${(size * 14) / 94}px`,
    "--_radius": `${Math.max(2, (face * 6) / 80)}px`,
  } as CSSProperties
  return (
    <span
      aria-hidden="true"
      className={cn(
        "deck-mark relative inline-block flex-none",
        animated && "animated",
        size >= 64 && "large",
        className,
      )}
      style={style}
    >
      <span className="deck-card far" />
      <span className="deck-card near" />
      <span className="deck-face">
        <svg
          className="deck-glyph relative z-1 size-[64%] overflow-visible"
          viewBox="0 0 24 24"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path className="deck-chevron" pathLength={1} d="m5 16.5 5.5-5.5-5.5-5.5" />
          <path className="deck-cursor" pathLength={1} d="M12.5 18.5h6.5" />
        </svg>
        {animated && <i className="deck-scan" />}
      </span>
    </span>
  )
}

// The wordmark: "nova" regular, "deck" semibold and a muted full stop. Sized by the
// surrounding font size; `animated` raises it letter by letter.
export const DeckWordmark = ({
  animated = false,
  className,
}: {
  readonly animated?: boolean
  readonly className?: string | undefined
}): React.JSX.Element => {
  const letters = [
    ..."nova".split("").map((letter) => ({ letter, className: "font-normal" })),
    ..."deck".split("").map((letter) => ({ letter, className: undefined })),
    { letter: ".", className: "deck-word-stop" },
  ]
  return (
    <span
      className={cn(
        "deck-word inline-flex items-baseline font-semibold *:inline-block",
        animated && "animated",
        className,
      )}
      aria-hidden="true"
    >
      {letters.map(({ letter, className: letterClass }, index) => (
        <span
          // The letters never reorder.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={letterClass}
          style={{ "--_i": index } as CSSProperties}
        >
          {letter}
        </span>
      ))}
    </span>
  )
}

const patternMask =
  "linear-gradient(to right, transparent 10%, black 78%), radial-gradient(ellipse at 100% 0%, black 10%, transparent 72%)"

// A quiet repeat of the layered terminal mark for branded backgrounds. It fades in
// from the right so foreground content can keep a clean reading surface.
export const DeckPattern = ({
  className,
}: {
  readonly className?: string | undefined
}): React.JSX.Element => {
  const id = useId().replaceAll(":", "")
  const pattern = `deck-pattern-${id}`
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 640 240"
      preserveAspectRatio="xMidYMid slice"
      style={{
        // Fades toward the left and away from the top-right corner, where the two
        // gradients overlap, so the pattern has no hard edge beside the copy.
        maskImage: patternMask,
        WebkitMaskImage: patternMask,
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
      }}
    >
      <defs>
        <pattern id={pattern} width="112" height="92" patternUnits="userSpaceOnUse">
          <g transform="rotate(-5 56 46)">
            <rect
              x="29"
              y="10"
              width="62"
              height="48"
              rx="3"
              fill="var(--color-paper)"
              fillOpacity="0.22"
              stroke="currentColor"
            />
            <rect
              x="22"
              y="17"
              width="62"
              height="48"
              rx="3"
              fill="var(--color-paper)"
              fillOpacity="0.34"
              stroke="currentColor"
            />
            <rect
              x="15"
              y="24"
              width="62"
              height="48"
              rx="3"
              fill="var(--color-paper)"
              fillOpacity="0.58"
              stroke="currentColor"
            />
            <path d="M15 36h62" stroke="currentColor" />
            <path
              d="m27 46 5 5-5 5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M39 57h9" fill="none" stroke="currentColor" strokeLinecap="round" />
          </g>
        </pattern>
      </defs>
      <rect width="640" height="240" fill={`url(#${pattern})`} />
    </svg>
  )
}

// The brand name for assistive technology, which the marks above leave out.
export const deckName = "novadeck."
