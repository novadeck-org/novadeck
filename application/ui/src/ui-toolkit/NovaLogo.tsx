import { useId, type CSSProperties } from "react"

import { cn } from "../class-name"

// The Nova mark: four chevrons, < > ^ v, firing outward from a block cursor. It is a
// shape, not a style: the chevrons take the mark colour and the cursor the core colour,
// so each theme restyles it through tokens alone. The website's NovaMark.astro and the
// host's icons draw the same geometry; change them together. `size` is the whole square
// in pixels.
const chevrons = [
  { name: "right", points: "46,22 56,32 46,42" },
  { name: "left", points: "18,22 8,32 18,42" },
  { name: "up", points: "22,18 32,8 42,18" },
  { name: "down", points: "22,46 32,56 42,46" },
] as const

export const NovaMark = ({
  size = 28,
  animated = false,
  className,
}: {
  readonly size?: number
  // Assembles itself, as on the boot splash; still when motion is reduced.
  readonly animated?: boolean
  readonly className?: string | undefined
}): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="3 3 58 58"
    width={size}
    height={size}
    className={cn("nova-mark flex-none", animated && "animated", className)}
  >
    <g fill="none" strokeWidth="7">
      {chevrons.map(({ name, points }) => (
        <polyline key={name} className={`nova-chevron ${name}`} points={points} />
      ))}
    </g>
    <rect className="nova-cursor" x="28" y="23" width="8" height="18" />
  </svg>
)

// The wordmark: "Novadeck" in Archivo, bold and expanded (see nova-logo.css). Sized by
// the surrounding font size; `animated` raises it letter by letter.
export const Wordmark = ({
  animated = false,
  className,
}: {
  readonly animated?: boolean
  readonly className?: string | undefined
}): React.JSX.Element => {
  const letters = brandName.split("")
  return (
    <span
      className={cn(
        "wordmark inline-flex items-baseline *:inline-block",
        animated && "animated",
        className,
      )}
      aria-hidden="true"
    >
      {letters.map((letter, index) => (
        <span
          // The letters never reorder.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
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

// A quiet repeat of the Nova mark for branded backgrounds: thin chevrons around a small
// cursor, half-dropped so the marks tile into a diamond lattice, the whole field turned a
// little. It fades in from the right so foreground content keeps a clean reading surface.
export const NovaPattern = ({
  className,
}: {
  readonly className?: string | undefined
}): React.JSX.Element => {
  const id = useId().replaceAll(":", "")
  const mark = `nova-pattern-mark-${id}`
  const pattern = `nova-pattern-${id}`
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
        {/* The mark at half size, its strokes thinned so the field stays a texture. */}
        <g id={mark} transform="scale(0.5) translate(-32 -32)">
          <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="miter">
            <polyline points="46,22 56,32 46,42" />
            <polyline points="18,22 8,32 18,42" />
            <polyline points="22,18 32,8 42,18" />
            <polyline points="22,46 32,56 42,46" />
          </g>
          <rect x="29" y="25" width="6" height="14" fill="currentColor" fillOpacity="0.6" />
        </g>
        <pattern
          id={pattern}
          width="56"
          height="56"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-8)"
        >
          <use href={`#${mark}`} x="28" y="28" />
          <use href={`#${mark}`} x="0" y="0" />
          <use href={`#${mark}`} x="56" y="0" />
          <use href={`#${mark}`} x="0" y="56" />
          <use href={`#${mark}`} x="56" y="56" />
        </pattern>
      </defs>
      <rect width="640" height="240" fill={`url(#${pattern})`} />
    </svg>
  )
}

// The brand name for assistive technology, which the marks above leave out.
export const brandName = "Novadeck"
