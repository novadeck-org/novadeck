import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react"

import { timeOfDay } from "./facts"
import { Mark } from "./Mark"
import type { MarkPhase } from "./mark-phase"
import { oneLine, sentence } from "./turn-holds"

// The prompt that holds the top of the log: a one-line copy of it over the log (the log's rows
// never move for it), drawn as the log draws a prompt. Pointed at or focused, it shows when the
// prompt was sent and steps to the prompt before and after; pressed, it unfolds in place into
// the whole prompt (the peek), which Esc, a click elsewhere, or going to the prompt closes.
export const Hold = ({
  text,
  at,
  offset,
  phase,
  open,
  before,
  after,
  onOpen,
  onClose,
  onStep,
  onGo,
}: {
  readonly text: string
  readonly at: number | null
  // How far the next turn's start has pushed it up, in pixels, zero or less.
  readonly offset: number
  // The mark's phase: set only while this is the current turn's prompt.
  readonly phase: MarkPhase | undefined
  readonly open: boolean
  // Whether there is a prompt of the person's before and after this one.
  readonly before: boolean
  readonly after: boolean
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onStep: (to: "before" | "after") => void
  readonly onGo: () => void
}): React.JSX.Element => {
  const root = useRef<HTMLDivElement>(null)
  const closed = useRef<HTMLButtonElement>(null)
  const whole = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  // Opened, focus goes to the whole prompt, so Esc is heard inside the chat; closed, back to the
  // line, unless the person has moved it elsewhere. The peek takes at most two fifths of the
  // chat's height, and scrolls inside past that.
  useLayoutEffect(() => {
    if (open) {
      const chat = root.current?.closest<HTMLElement>(".chat")
      if (chat) root.current?.style.setProperty("--_peek", `${chat.clientHeight * 0.4}px`)
      whole.current?.focus({ preventScroll: true })
    } else if (wasOpen.current) {
      const active = document.activeElement
      if (!active || active === document.body) closed.current?.focus({ preventScroll: true })
    }
    wasOpen.current = open
  }, [open])
  // A press outside the peek closes it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener("pointerdown", outside, true)
    return () => document.removeEventListener("pointerdown", outside, true)
  }, [open, onClose])
  return (
    <div
      ref={root}
      className="chat-hold"
      data-open={open || undefined}
      data-pushed={offset < 0 || undefined}
      style={offset < 0 ? ({ transform: `translateY(${offset}px)` } as CSSProperties) : undefined}
    >
      <div className="chat-hold-column">
        {open ? (
          <>
            <div className="chat-hold-line">
              <Mark phase={phase} />
              <div
                ref={whole}
                className="chat-hold-words nodrag nopan nowheel"
                role="region"
                aria-label="Your prompt, whole"
                tabIndex={-1}
              >
                {text}
              </div>
            </div>
            <p className="chat-hold-foot">
              {at !== null && <span>{timeOfDay(at)}</span>}
              <button type="button" className="chat-key chat-hold-go nodrag nopan" onClick={onGo}>
                go to it ↑
              </button>
              <button
                type="button"
                className="chat-key chat-hold-close nodrag nopan"
                onClick={onClose}
              >
                <kbd>esc</kbd>
                close
              </button>
            </p>
          </>
        ) : (
          <>
            <button
              ref={closed}
              type="button"
              className="chat-hold-line nodrag nopan"
              aria-expanded={false}
              aria-label={`Your prompt: ${sentence(oneLine(text))} Show it whole`}
              onClick={onOpen}
            >
              <Mark phase={phase} />
              <span className="chat-hold-words" aria-hidden>
                {oneLine(text)}
              </span>
            </button>
            <span className="chat-hold-end">
              {at !== null && <span className="chat-hold-time">{timeOfDay(at)}</span>}
              <button
                type="button"
                className="chat-key chat-hold-step nodrag nopan"
                aria-label="Previous prompt"
                disabled={!before}
                onClick={() => onStep("before")}
              >
                ‹
              </button>
              <button
                type="button"
                className="chat-key chat-hold-step nodrag nopan"
                aria-label="Next prompt"
                disabled={!after}
                onClick={() => onStep("after")}
              >
                ›
              </button>
            </span>
          </>
        )}
      </div>
    </div>
  )
}
