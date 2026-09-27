import type { CSSProperties } from "react"

import { cn } from "../class-name"

import styles from "./DeckLogo.module.css"

// The Deck mark: the charcoal ">_" square with two terminal cards fanned behind it, up
// and to the right. `size` is the whole footprint in pixels, cards included.
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
    "--face": `${face}px`,
    "--k1": `${(size * 7) / 94}px`,
    "--k2": `${(size * 14) / 94}px`,
    "--radius": `${Math.max(2, (face * 6) / 80)}px`,
  } as CSSProperties
  return (
    <span
      aria-hidden="true"
      className={cn(
        styles.mark,
        animated && styles.animated,
        size >= 64 && styles.large,
        className,
      )}
      style={style}
    >
      <span className={cn(styles.card, styles.k2)} />
      <span className={cn(styles.card, styles.k1)} />
      <span className={styles.face}>
        <svg className={styles.glyph} viewBox="0 0 24 24">
          <path className={styles.chevron} pathLength={1} d="m5 16.5 5.5-5.5-5.5-5.5" />
          <path className={styles.cursor} pathLength={1} d="M12.5 18.5h6.5" />
        </svg>
        {animated && <i className={styles.scan} />}
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
    ..."nova".split("").map((letter) => ({ letter, className: styles.nova })),
    ..."deck".split("").map((letter) => ({ letter, className: undefined })),
    { letter: ".", className: styles.dot },
  ]
  return (
    <span className={cn(styles.word, animated && styles.animated, className)} aria-hidden="true">
      {letters.map(({ letter, className: letterClass }, index) => (
        <span
          // The letters never reorder.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={letterClass}
          style={{ "--i": index } as CSSProperties}
        >
          {letter}
        </span>
      ))}
    </span>
  )
}

// The brand name for assistive technology, which the marks above leave out.
export const deckName = "novadeck."
