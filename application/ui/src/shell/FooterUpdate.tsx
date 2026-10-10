import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { blockingOverlayOpen } from "../interaction/dom"
import { updateKey, type UpdateOffer } from "../model/update"

// The release-note lines the notice shows; the release page has the rest.
export const shownNotes = 5

// What the notice says of an offer.
const headline = ({ kind, version }: UpdateOffer): string =>
  `Novadeck ${version} is ${kind === "ready" ? "ready" : "available"}`

export type FooterUpdateProps = {
  readonly offer: UpdateOffer
  // Whether the notice is raised: it shows only while the footer does, and while nothing
  // else asks for the person's attention (`blocked`).
  readonly open: boolean
  readonly blocked: boolean
  readonly onOpenChange: (open: boolean) => void
  // Called with the offer's `updateKey` when the notice comes up.
  readonly onShown: (key: string) => void
  // Restarts into a downloaded update.
  readonly onInstall: () => void
  // Opens the update's release page.
  readonly onOpenPage: () => void
  // Puts typing focus back in the selected terminal; false when there is none.
  readonly returnFocus: () => boolean
}

// Where focus goes when a notice closes with focus inside it.
type Return = "origin" | "terminal"

// Whether a dialog, menu or popover is open, looked at while `active`: they come and go
// in portals, so there is nothing to subscribe to. Looked at as `active` begins, so an
// offer that arrives with one open never shows, and then every 150 ms.
const useOverlayOpen = (active: boolean): boolean => {
  const [was, setWas] = useState(false)
  const [open, setOpen] = useState(false)
  if (active !== was) {
    setWas(active)
    setOpen(active && blockingOverlayOpen())
  }
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setOpen(blockingOverlayOpen()), 150)
    return () => clearInterval(timer)
  }, [active])
  return active && open
}

// Notes in `lost` that the notice went away while focus was inside it.
const KeepFocus = ({ lost }: { readonly lost: { current: boolean } }): null => {
  useLayoutEffect(
    () => () => {
      if (document.activeElement?.closest(".update-panel")) lost.current = true
    },
    [lost],
  )
  return null
}

// The notice's content: the headline, a few notes, and what the person can do.
const UpdateCard = ({
  offer,
  titleId,
  onClose,
  onRestart,
  onOpenPage,
}: {
  readonly offer: UpdateOffer
  readonly titleId: string
  readonly onClose: (to: Return) => void
  readonly onRestart: () => void
  readonly onOpenPage: () => void
}): React.JSX.Element => {
  const { kind, notes } = offer
  const more = notes.length - shownNotes
  return (
    <>
      <p id={titleId} className="update-title">
        {headline(offer)}
      </p>
      {notes.length > 0 && (
        <ul className="update-notes">
          {notes.slice(0, shownNotes).map((note, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Lines may repeat; the list never reorders.
            <li key={index} title={note}>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="update-more">and {more} more</p>}
      {kind === "ready" && (
        <button type="button" className="button link update-link" onClick={onOpenPage}>
          Release notes
        </button>
      )}
      <div className="update-actions">
        <button type="button" className="button min-h-8 px-3" onClick={() => onClose("origin")}>
          Later
        </button>
        <button
          type="button"
          className="button primary min-h-8 px-3"
          onClick={() => {
            onClose("terminal")
            if (kind === "ready") onRestart()
            else onOpenPage()
          }}
        >
          {kind === "ready" ? "Restart now" : "Download"}
        </button>
      </div>
    </>
  )
}

// An update waiting beside the footer's status: a chip, "Update ready" or "Update
// available", and the notice above it. The notice is a plain panel, not a dialog or a
// layer: nothing about it intercepts keys, focus or clicks elsewhere, so typing in a
// terminal goes on. Raised once per offer, it waits while the footer is hidden or any
// dialog, menu or popover is open, and never takes focus by itself. The chip opens it as
// the person's own request, with focus moving to the panel, so Escape there closes it and
// returns to the chip.
export const FooterUpdate = ({
  update,
  hidden,
}: {
  readonly update: FooterUpdateProps | undefined
  readonly hidden: boolean
}): React.JSX.Element => {
  // The offer the person pressed Restart for: any other offer, a newer version or the
  // same one turned to a download, is a new one, not pending.
  const [pressed, setPressed] = useState<string>()
  const panel = useRef<HTMLElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  // Whether the person opened the notice from the chip: focus moves into it once it
  // shows (`requested`), and closing it sends focus back to the chip (`opener`).
  const requested = useRef(false)
  const opener = useRef<"chip" | "auto">("auto")
  const titleId = useId()
  const panelId = useId()
  const offer = update?.offer
  const key = offer && updateKey(offer)
  if (pressed !== undefined && pressed !== key) setPressed(undefined)
  const installing = offer?.kind === "ready" && pressed === key
  const wanted = (update?.open ?? false) && !hidden && !update?.blocked
  const overlay = useOverlayOpen(wanted)
  const blocked = (update?.blocked ?? false) || overlay
  const visible = (update?.open ?? false) && !hidden && !blocked && !installing
  const onShown = update?.onShown
  useEffect(() => {
    if (visible && key !== undefined) onShown?.(key)
  }, [visible, key, onShown])
  useEffect(() => {
    if (!visible || !requested.current) return
    // A frame on, after the click that asked has been through the workspace's own click
    // handling, which would hand focus back to the terminal from a panel focused too soon.
    const frame = requestAnimationFrame(() => {
      requested.current = false
      panel.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  // Focus inside the notice when it went away unanswered, as for a dialog the person
  // opened from it: the dialog would return to a button that is gone, so focus goes to
  // the chip once nothing else has it.
  const lost = useRef(false)
  useEffect(() => {
    if (blocked || hidden || !lost.current) return undefined
    lost.current = false
    let frame = 0
    let tries = 0
    const check = (): void => {
      const active = document.activeElement
      if (active && active !== document.body) return
      tries += 1
      if (tries > 60) return
      if (tries > 2) chip.current?.focus()
      else frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
    return () => cancelAnimationFrame(frame)
  }, [blocked, hidden])
  const word = offer?.kind === "available" ? "Update available" : "Update ready"
  const finish = (to: Return): void => {
    if (!update) return
    const inside = panel.current?.contains(document.activeElement) === true
    const back = to === "origin" && opener.current === "chip"
    requested.current = false
    opener.current = "auto"
    update.onOpenChange(false)
    if (!inside) return
    if (back || !update.returnFocus()) chip.current?.focus()
  }
  return (
    <>
      {/* Always mounted, so filling it announces the arrival; out of the layout, and kept
          for assistive technology where the visible words are dropped to fit. */}
      <span role="status" aria-live="polite" className="sr-only">
        {offer ? (installing ? "Restarting to update" : word) : ""}
      </span>
      {update && offer && (
        <>
          <button
            ref={chip}
            type="button"
            className="footer-action footer-update cursor-pointer font-bold"
            aria-label={`${word}: Novadeck ${offer.version}`}
            aria-expanded={visible}
            aria-controls={visible ? panelId : undefined}
            disabled={installing}
            onClick={() => {
              if (visible) {
                finish("origin")
                return
              }
              requested.current = true
              opener.current = "chip"
              update.onOpenChange(true)
            }}
          >
            {installing ? (
              "Restarting…"
            ) : (
              <>
                <span className="max-[701px]:hidden">{word}</span>
                <span className="hidden max-[701px]:inline">Update</span>
              </>
            )}
          </button>
          {visible && (
            <section
              ref={panel}
              id={panelId}
              data-workspace-notice
              aria-labelledby={titleId}
              className="floating update-panel"
              tabIndex={-1}
              // A click anywhere on it leaves focus where it was, in a terminal.
              onMouseDown={(event) => event.preventDefault()}
              // Plain Escape closes it; with Shift it goes on to the workspace, which
              // starts navigating.
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.shiftKey) return
                event.preventDefault()
                event.stopPropagation()
                finish("origin")
              }}
            >
              <KeepFocus lost={lost} />
              <UpdateCard
                offer={offer}
                titleId={titleId}
                onClose={finish}
                onRestart={() => {
                  if (pressed === key) return
                  setPressed(key)
                  update.onInstall()
                }}
                onOpenPage={update.onOpenPage}
              />
            </section>
          )}
        </>
      )}
    </>
  )
}
