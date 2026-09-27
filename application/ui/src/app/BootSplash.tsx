import type { CSSProperties, ReactNode } from "react"

import { DeckMark, DeckWordmark, deckName } from "../ui-toolkit/DeckLogo"
import { fieldSlots } from "./boot-field"

import styles from "./BootSplash.module.css"

const slots = fieldSlots()

// The full-window boot splash: the Deck lockup over a field of terminal slots jacking
// in, a hairline that fills with real progress, and the current phase.
export const BootSplash = ({
  line,
  fill,
  leaving,
  failure,
  settled = false,
}: {
  readonly line: string
  // How full the hairline is, 0 to 1.
  readonly fill: number
  // Fading out into the workspace behind it.
  readonly leaving: boolean
  // What failed, shown in place of the phase line: the field fades and freezes and the
  // hairline turns to the danger tone, while the lockup stays as it is.
  readonly failure?: ReactNode
  // A failure was shown during this boot: the lockup stands finished from then on.
  readonly settled?: boolean
}): React.JSX.Element => (
  <div
    className={`${styles.splash} ${leaving ? styles.leaving : ""} ${failure ? styles.failed : ""} ${settled || failure ? styles.settled : ""}`}
    data-state={failure ? "failed" : settled ? "settled" : "booting"}
    aria-busy={!leaving && !failure}
  >
    <div className={styles.field} aria-hidden="true">
      {slots.map((slot) => (
        <div
          key={`${slot.left}-${slot.top}`}
          className={styles.slot}
          style={
            {
              left: `calc(${slot.left}% + 0.8cqmin)`,
              top: `calc(${slot.top}% + 0.8cqmin)`,
              width: `calc(${slot.width}% - 1.6cqmin)`,
              height: `calc(${slot.height}% - 1.6cqmin)`,
              "--order": slot.order,
            } as CSSProperties
          }
        >
          <div className={styles.terminal}>
            <div className={styles.head}>
              <i style={{ width: `${slot.title}%` }} />
            </div>
            {slot.lines.map((width, index) => (
              <i
                // The lines never reorder.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                className={`${styles.line} ${index === 0 ? styles.command : ""}`}
                style={{ width: `${width}%` }}
              />
            ))}
            {slot.cursor && <i className={styles.cursor} />}
            <i className={styles.flash} />
          </div>
        </div>
      ))}
    </div>
    <div className={styles.hero}>
      <div className={styles.lockup} role="img" aria-label={deckName}>
        <DeckMark size={94} animated />
        <span className={styles.text}>
          <DeckWordmark animated className={styles.word} />
          <span className={styles.tag}>Terminals, on deck.</span>
        </span>
      </div>
      <div className={styles.status}>
        <span className={styles.hairline} aria-hidden="true">
          <i style={{ transform: `scaleX(${fill})` }} />
        </span>
        <span className={styles.lines}>
          <span className={styles.phase} role="status" aria-hidden={Boolean(failure)}>
            {line}
          </span>
          <span className={styles.failure}>{failure}</span>
        </span>
      </div>
    </div>
  </div>
)
