import type { CSSProperties, ReactNode } from "react"

import { DeckMark, DeckWordmark, deckName } from "../ui-toolkit/DeckLogo"
import { fieldSlots } from "./boot-field"

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
}): React.JSX.Element => {
  // Once a failure has shown, the lockup stands finished and never replays its entrance.
  const finished = settled || Boolean(failure)
  return (
    <div
      className={`boot-splash fixed inset-0 z-60 @container-size overflow-hidden select-none ${leaving ? "pointer-events-none opacity-0" : ""}`}
      data-state={failure ? "failed" : settled ? "settled" : "booting"}
      aria-busy={!leaving && !failure}
    >
      <div className="boot-splash-field absolute inset-0 origin-center" aria-hidden="true">
        {slots.map((slot) => (
          <div
            key={`${slot.left}-${slot.top}`}
            className="boot-splash-slot absolute"
            style={
              {
                left: `calc(${slot.left}% + 0.8cqmin)`,
                top: `calc(${slot.top}% + 0.8cqmin)`,
                width: `calc(${slot.width}% - 1.6cqmin)`,
                height: `calc(${slot.height}% - 1.6cqmin)`,
                "--_order": slot.order,
              } as CSSProperties
            }
          >
            <div className="boot-splash-terminal panel absolute -inset-px flex flex-col gap-[1.1cqh] px-[1.5cqmin]">
              <div className="boot-splash-titlebar -mx-[1.5cqmin] mb-[0.4cqh] flex h-[2.8cqh] items-center px-[1.5cqmin]">
                <i
                  className="boot-splash-bar title block h-[0.8cqh]"
                  style={{ width: `${slot.title}%` }}
                />
              </div>
              {slot.lines.map((width, index) => (
                <i
                  // The lines never reorder.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={index}
                  className={`boot-splash-bar block h-[0.8cqh] ${index === 0 ? "lead" : ""}`}
                  style={{ width: `${width}%` }}
                />
              ))}
              {slot.cursor && <i className="boot-splash-cursor block h-[1.5cqh] w-[0.9cqh]" />}
              <i className="boot-splash-flash absolute -inset-px" />
            </div>
          </div>
        ))}
      </div>
      <div className="boot-splash-hero pointer-events-none absolute inset-0 z-4 flex flex-col items-center justify-center gap-14">
        <div className="flex items-center gap-[26px]" role="img" aria-label={deckName}>
          <DeckMark size={94} animated={!finished} />
          <span className="flex flex-col gap-2.5">
            <DeckWordmark
              animated={!finished}
              className="boot-splash-word -mt-[0.08em] -mb-[0.12em] overflow-hidden pt-[0.08em] pb-[0.12em] text-[52px] leading-none"
            />
            <span className="boot-splash-tag pl-[3px] text-[13px] leading-[18px]">
              Terminals, on deck.
            </span>
          </span>
        </div>
        <div className="flex flex-col items-center gap-3">
          <span
            className="boot-splash-hairline relative h-px w-32 overflow-hidden"
            aria-hidden="true"
          >
            <i
              className="absolute inset-0 origin-left"
              style={{ "--_fill": fill } as CSSProperties}
            />
          </span>
          <span className="boot-splash-lines relative flex h-[18px] w-full justify-center">
            <span
              className="boot-splash-phase text-[12px] leading-[18px] whitespace-nowrap tabular-nums"
              role="status"
              aria-hidden={Boolean(failure)}
            >
              {line}
            </span>
            <span className="boot-splash-failure absolute top-0 left-1/2 w-max max-w-[min(360px,calc(100vw-32px))] -translate-x-1/2">
              {failure}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}
