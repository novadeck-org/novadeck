import type { WhatsNew as Notes } from "@novadeck/core/update"
import { X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { KeepFocus } from "./notice-focus"

// What is new in the version the app updated to, as the card the footer raises.
export type WhatsNewProps = {
  readonly notes: Notes
  // Whether something else holds the corner or the person's attention: a dialog, the
  // sandbox notice, a portable copy's card. The card waits, and comes back when it ends.
  readonly blocked: boolean
  // The person dismissed it: it is gone for good, for this version.
  readonly onDismiss: () => void
  // Opens the release's page, leaving the card where it is.
  readonly onOpenPage: () => void
  // Puts typing focus back in the selected terminal; false when there is none.
  readonly returnFocus: () => boolean
}

// What assistive technology hears when the card comes up, once: the version and the
// highlights' titles, not their lines, which the card has for whoever goes to read it.
// The highlights with a key each, even when the host repeats one: the second of two equal
// highlights is told apart by how many came before it.
const keyed = (highlights: Notes["highlights"]): { key: string; title: string; line: string }[] => {
  const seen = new Map<string, number>()
  return highlights.map((highlight) => {
    const text = `${highlight.title}\n${highlight.line}`
    const count = seen.get(text) ?? 0
    seen.set(text, count + 1)
    return { ...highlight, key: `${text}\n${count}` }
  })
}

export const announcement = ({ version, highlights }: Notes): string =>
  `New in Novadeck ${version}: ${highlights.map(({ title }) => title).join(", ")}`

// The card that tells what is new after an update, in the corner the download's bar and
// the install notices use, as a `.floating` surface: a label, each highlight as a title
// with its line under it, and a link to the release notes, nothing else. It is a plain
// panel, not a dialog or a layer: it never takes focus or keys by itself, so typing in a
// terminal goes on, and every control on it is a button the Tab key reaches. The × dismisses
// it for good; the link opens the page and leaves it. Escape, from inside it, only gives
// focus back to the terminal. It shares the corner with the other notices by waiting
// (`blocked`, or Zen mode, `hidden`) while one is open, and for the download's bar, which
// has the corner from its start until it fades (WorkspaceFooter.tsx): the card can stay for
// weeks, a download must not be hidden by it. The text is the host's and is shown as text: no Markdown, no
// markup, no links.
export const WhatsNew = ({
  card,
  hidden,
}: {
  readonly card: WhatsNewProps | undefined
  readonly hidden: boolean
}): React.JSX.Element => {
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  // Whether the card has been up, so a return from Zen mode does not announce it again.
  const [told, setTold] = useState(false)
  const shown = card !== undefined && !card.blocked && !hidden
  if (shown && !told) setTold(true)
  if (!card && told) setTold(false)
  // Whether the card went away with focus inside it, as a download's bar taking the corner
  // does: focus would drop to the page, so it goes back to the terminal, unless whatever
  // took the card's place (a notice, a dialog) has taken it.
  const lost = useRef(false)
  const returnFocus = card?.returnFocus
  useEffect(() => {
    if (shown || !lost.current) return
    lost.current = false
    const active = document.activeElement
    if (!active || active === document.body) returnFocus?.()
  }, [shown, returnFocus])
  const inside = (): boolean => panel.current?.contains(document.activeElement) === true
  return (
    <>
      {/* Always mounted, so filling it announces the card once, as the footer's other notices do. */}
      <span role="status" aria-live="polite" className="sr-only">
        {card && told ? announcement(card.notes) : ""}
      </span>
      {card && shown && (
        <section
          ref={panel}
          data-workspace-notice
          aria-labelledby={titleId}
          className="floating update-card whats-new"
          tabIndex={-1}
          // A click anywhere on it leaves focus where it was, in a terminal.
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.shiftKey) return
            event.preventDefault()
            event.stopPropagation()
            card.returnFocus()
          }}
        >
          <KeepFocus lost={lost} selector=".whats-new" />
          <p className="update-progress-head">
            <span id={titleId} className="whats-new-label">
              New in Novadeck {card.notes.version}
            </span>
            <button
              type="button"
              className="icon-button small update-card-close"
              aria-label="Dismiss"
              onClick={() => {
                // Focus on the button would be lost with it: the terminal gets it back.
                const had = inside()
                card.onDismiss()
                if (had) card.returnFocus()
              }}
            >
              <X size={14} />
            </button>
          </p>
          <ul className="whats-new-list">
            {keyed(card.notes.highlights).map(({ key, title, line }) => (
              <li key={key}>
                <b className="whats-new-title">{title}</b>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div className="update-card-foot">
            <button
              type="button"
              className="button link whats-new-link text-control"
              onClick={card.onOpenPage}
            >
              Release notes ↗
            </button>
          </div>
        </section>
      )}
    </>
  )
}
