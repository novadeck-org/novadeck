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
    className={`${styles.splash} fixed inset-0 z-60 @container-size overflow-hidden bg-paper select-none transition-opacity duration-400 ease-interface ${leaving ? "pointer-events-none opacity-0" : ""} ${failure ? styles.failed : ""} ${settled || failure ? styles.settled : ""}`}
    data-state={failure ? "failed" : settled ? "settled" : "booting"}
    aria-busy={!leaving && !failure}
  >
    <div
      className={`${styles.field} absolute inset-0 origin-center transition-opacity duration-600 ease-interface`}
      aria-hidden="true"
    >
      {slots.map((slot) => (
        <div
          key={`${slot.left}-${slot.top}`}
          className={`${styles.slot} absolute rounded-panel border border-dashed border-line-strong`}
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
          <div
            className={`${styles.terminal} absolute -inset-px flex flex-col gap-[1.1cqh] rounded-panel border border-line bg-paper px-[1.5cqmin] shadow-panel`}
          >
            <div className="-mx-[1.5cqmin] mb-[0.4cqh] flex h-[2.8cqh] items-center border-b border-line px-[1.5cqmin]">
              <i
                className="block h-[0.8cqh] rounded-[1px] bg-line-strong"
                style={{ width: `${slot.title}%` }}
              />
            </div>
            {slot.lines.map((width, index) => (
              <i
                // The lines never reorder.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                className={`block h-[0.8cqh] rounded-[1px] ${index === 0 ? "bg-line" : "bg-soft"}`}
                style={{ width: `${width}%` }}
              />
            ))}
            {slot.cursor && (
              <i className={`${styles.cursor} block h-[1.5cqh] w-[0.9cqh] bg-line-strong`} />
            )}
            <i
              className={`${styles.flash} absolute -inset-px rounded-panel border border-strong opacity-0`}
            />
          </div>
        </div>
      ))}
    </div>
    <div
      className={`${styles.hero} pointer-events-none absolute inset-0 z-4 flex flex-col items-center justify-center gap-14`}
    >
      <div className="flex items-center gap-[26px]" role="img" aria-label={deckName}>
        <DeckMark size={94} animated />
        <span className="flex flex-col gap-2.5">
          <DeckWordmark
            animated
            className="-mt-[0.08em] -mb-[0.12em] overflow-hidden pt-[0.08em] pb-[0.12em] text-[52px] leading-none tracking-[-0.045em]"
          />
          <span className={`${styles.tag} pl-[3px] text-[13px] leading-[18px] text-muted`}>
            Terminals, on deck.
          </span>
        </span>
      </div>
      <div className="flex flex-col items-center gap-3">
        <span
          className={`${styles.hairline} relative h-px w-32 overflow-hidden bg-line`}
          aria-hidden="true"
        >
          <i
            className="absolute inset-0 origin-left bg-strong transition-[transform,background-color] duration-300 ease-interface"
            style={{ transform: `scaleX(${fill})` }}
          />
        </span>
        <span className={`${styles.lines} relative flex h-[18px] w-full justify-center`}>
          <span
            className={`${styles.phase} text-[12px] leading-[18px] whitespace-nowrap text-muted tabular-nums transition-opacity duration-300 ease-interface`}
            role="status"
            aria-hidden={Boolean(failure)}
          >
            {line}
          </span>
          <span
            className={`${styles.failure} pointer-events-none absolute top-0 left-1/2 w-max max-w-[min(360px,calc(100vw-32px))] -translate-x-1/2 opacity-0 transition-opacity duration-300 ease-interface`}
          >
            {failure}
          </span>
        </span>
      </div>
    </div>
  </div>
)
