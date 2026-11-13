import { MentionedText } from "@novadeck/toolkit/Mentioned"
import { mentionAt, type Mention } from "@novadeck/toolkit/mentions"
import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties } from "react"

import { timeOfDay } from "./facts"
import { Mark } from "./Mark"
import type { MarkPhase } from "./mark-phase"
import { oneLine, peekHeight, sentence } from "./turn-holds"

// The prompt that holds the top of the log: a one-line copy of it over the log (the log's rows
// never move for it), drawn as the log draws a prompt. Pointed at or focused, it shows when the
// prompt was sent; pressed, it unfolds in place into the whole prompt (the peek), which Esc, a
// click elsewhere, or going to the prompt closes.
export const Hold = ({
  text,
  at,
  offset,
  phase,
  open,
  onOpen,
  onClose,
  onGo,
  mention,
}: {
  readonly text: string
  // The hue of the agent a handle names, where the app knows it (the handle is drawn in it).
  readonly mention?: Mention | undefined
  readonly at: number | null
  // How far the next turn's start has pushed it up, in pixels, zero or less.
  readonly offset: number
  // The mark's phase: set only while this is the current turn's prompt.
  readonly phase: MarkPhase | undefined
  readonly open: boolean
  readonly onOpen: () => void
  readonly onClose: () => void
  readonly onGo: () => void
}): React.JSX.Element => {
  const root = useRef<HTMLDivElement>(null)
  const closed = useRef<HTMLButtonElement>(null)
  const whole = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const id = useId()
  // Opened, focus goes to the whole prompt, so Esc is heard inside the chat; closed, back to the
  // line, unless the person has moved it elsewhere.
  useLayoutEffect(() => {
    if (open) whole.current?.focus({ preventScroll: true })
    else if (wasOpen.current) {
      const active = document.activeElement
      if (!active || active === document.body) closed.current?.focus({ preventScroll: true })
    }
    wasOpen.current = open
  }, [open])
  // The peek's words take what the log area leaves (at most two fifths of the chat), so its footer
  // is always in view, and scroll inside past that; sized again as the area changes.
  useLayoutEffect(() => {
    const hold = root.current
    const main = hold?.parentElement
    const chat = hold?.closest<HTMLElement>(".chat")
    const words = whole.current
    if (!open || !hold || !main || !chat || !words) return
    const fit = (): void => {
      const line = parseFloat(getComputedStyle(words).lineHeight)
      hold.style.setProperty(
        "--_peek",
        `${peekHeight({
          chat: chat.clientHeight,
          main: main.clientHeight,
          chrome: hold.offsetHeight - words.offsetHeight,
          line: line > 0 ? line : 18,
        })}px`,
      )
    }
    fit()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(fit)
    observer.observe(main)
    return () => observer.disconnect()
  }, [open])
  // A press outside the peek closes it. The latest close is the one called, so the listener stays.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) close.current()
    }
    document.addEventListener("pointerdown", outside, true)
    return () => document.removeEventListener("pointerdown", outside, true)
  }, [open])
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
                id={id}
                role="region"
                aria-label="Your prompt, whole"
                tabIndex={-1}
              >
                <MentionedText text={text} mention={mentionAt(mention, at)} />
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
                aria-label="Close"
                aria-expanded
                aria-controls={id}
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
                <MentionedText text={oneLine(text)} mention={mentionAt(mention, at)} />
              </span>
            </button>
            <span className="chat-hold-end">
              {at !== null && <span className="chat-hold-time">{timeOfDay(at)}</span>}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
