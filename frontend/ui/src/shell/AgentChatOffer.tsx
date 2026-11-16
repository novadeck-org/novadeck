import { X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { KeepFocus } from "./notice-focus"

export type AgentChatOfferProps = {
  // Whether something else holds the corner or the person's attention: a dialog, a question,
  // the sandbox notice, a portable copy's card. The offer waits, and comes back when it ends.
  readonly blocked: boolean
  // Turn on: the chat view is on, and the offer is answered.
  readonly onTurnOn: () => void
  // No thanks, the ×, and Escape from inside the card: the offer is answered.
  readonly onDecline: () => void
  // Puts typing focus back in the selected terminal; false when there is none.
  readonly returnFocus: () => boolean
}

// The words are the Preferences row's (Preferences.tsx), so the offer and the switch it points
// to say the same.
export const chatOfferText = {
  title: "Agent Chat",
  line: "Read and reply to agents in a chat instead of their terminal.",
  quiet: "You can change this any time in Preferences → General → Agents.",
  accept: "Turn on",
  decline: "No thanks",
} as const

const announcement = `${chatOfferText.title}: ${chatOfferText.line}`

// The one-time offer of Agent Chat, for people who updated past the welcome dialog: a card in
// the corner the download's bar and the update notices use, as a `.floating` surface in
// What's new's look (WhatsNew.tsx), whose tape names the feature. It comes up on an agent's
// terminal (the footer decides, in every view), and is answered once, by Turn on or No thanks
// (the ×, which reads Dismiss, and Escape from inside the card are No thanks); it is never made again. As What's
// new's card does, it never takes focus or keys by itself, so typing in a terminal goes on;
// every control is a button the Tab key reaches, and a live region says it once as it comes up.
// It takes turns with the other corner notices by waiting (`blocked`, or Zen mode, `hidden`).
export const AgentChatOffer = ({
  offer,
  hidden,
}: {
  readonly offer: AgentChatOfferProps | undefined
  readonly hidden: boolean
}): React.JSX.Element => {
  const [said, setSaid] = useState("")
  return (
    <>
      {/* Always mounted, so filling it announces the card once: a live region that arrives
          filled is often not read. */}
      <span role="status" aria-live="polite" className="sr-only">
        {said}
      </span>
      <ChatOfferCard offer={offer} hidden={hidden} onSay={setSaid} />
    </>
  )
}

const ChatOfferCard = ({
  offer,
  hidden,
  onSay,
}: {
  readonly offer: AgentChatOfferProps | undefined
  readonly hidden: boolean
  // Gives the words to announce, or none, to the live region that outlasts this card.
  readonly onSay: (words: string) => void
}): React.JSX.Element => {
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const shown = offer !== undefined && !offer.blocked && !hidden
  // Said while the card is up for the first time, and not again when it returns from waiting
  // or from not being due (a shell selected between two agents): it is said once, as an
  // answered offer never returns, so nothing resets it.
  const [told, setTold] = useState<"not yet" | "telling" | "told">("not yet")
  if (shown && told === "not yet") setTold("telling")
  if (!shown && told === "telling") setTold("told")
  const words = told === "telling" ? announcement : ""
  useEffect(() => onSay(words), [words, onSay])
  // Whether the card went away with focus inside it, as a download's bar taking the corner
  // does: focus would drop to the page, so it goes back to the terminal, unless whatever took
  // the card's place has taken it.
  const lost = useRef(false)
  const latestReturn = useRef(offer?.returnFocus)
  useEffect(() => {
    latestReturn.current = offer?.returnFocus
  })
  useEffect(() => {
    if (shown) {
      lost.current = false
      return undefined
    }
    if (!lost.current) return undefined
    const frame = requestAnimationFrame(() => {
      lost.current = false
      const active = document.activeElement
      if (!active || active === document.body) latestReturn.current?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [shown])
  // The button pressed goes with its card, and its focus with it: the terminal gets it back.
  const answer = (choose: () => void): void => {
    if (!offer) return
    const had = panel.current?.contains(document.activeElement) === true
    choose()
    if (had) offer.returnFocus()
  }
  if (!offer || !shown) return <></>
  return (
    <section
      ref={panel}
      data-workspace-notice
      aria-labelledby={titleId}
      className="floating update-card whats-new chat-offer"
      tabIndex={-1}
      // A click anywhere on it leaves focus where it was, in a terminal.
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.shiftKey) return
        event.preventDefault()
        event.stopPropagation()
        answer(offer.onDecline)
      }}
    >
      <KeepFocus lost={lost} selector=".chat-offer" />
      <p className="whats-new-head">
        <span id={titleId} className="whats-new-tape">
          {chatOfferText.title}
        </span>
        <button
          type="button"
          className="icon-button small update-card-close"
          aria-label="Dismiss"
          onClick={() => answer(offer.onDecline)}
        >
          <X size={14} />
        </button>
      </p>
      <p className="chat-offer-line">{chatOfferText.line}</p>
      <p className="chat-offer-quiet">{chatOfferText.quiet}</p>
      <div className="update-card-foot">
        <button
          type="button"
          className="button min-h-7 px-3"
          onClick={() => answer(offer.onDecline)}
        >
          {chatOfferText.decline}
        </button>
        <button
          type="button"
          className="button primary min-h-7 px-3"
          onClick={() => answer(offer.onTurnOn)}
        >
          {chatOfferText.accept}
        </button>
      </div>
    </section>
  )
}
