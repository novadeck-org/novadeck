import { useEffect, useId, useRef, useState } from "react"

import { blockingOverlayOpen } from "../interaction/dom"
import type { InstallResult } from "../model/portable"
import { updateKey, type UpdateOffer } from "../model/update"
import { KeepFocus, useRecoverFocus } from "./notice-focus"

// The release-note lines the notice shows; the release page has the rest.
export const shownNotes = 5

// What the notice says of an offer.
const headline = ({ kind, version }: UpdateOffer): string =>
  `Novadeck ${version} is ${kind === "ready" ? "ready" : "available"}`

// A portable copy, which never updates itself and is the way to install the app that does.
export type FooterPortable = {
  // Whether the app runs without its security sandbox: installing puts it where the sandbox
  // can be turned on, which the panel says.
  readonly unsandboxed: boolean
  // Installs the app, keeping the workspace.
  readonly onInstall: () => Promise<InstallResult>
  // Restarts into the installed copy that is newer than this one.
  readonly onOpenInstalled: () => void
}

// Where installing from a portable copy stands. `running` and `installing` are the wait
// for the host's answer and for the restart it announced.
type Install =
  | { readonly phase: "idle" | "running" | "installing" }
  | { readonly phase: "newer"; readonly version: string }
  | { readonly phase: "failed"; readonly reason: string }

export type FooterUpdateProps = {
  // The update waiting; absent while a portable copy has none, when only the quiet
  // "Install Novadeck" chip shows.
  readonly offer?: UpdateOffer | undefined
  // Set for a portable copy: its notice installs the app rather than download the update.
  readonly portable?: FooterPortable | undefined
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
export const useOverlayOpen = (active: boolean): boolean => {
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

// The release's notes, as many as fit, and how many more there are.
const UpdateNotes = ({ notes }: { readonly notes: readonly string[] }): React.JSX.Element => {
  const more = notes.length - shownNotes
  return (
    <>
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
    </>
  )
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
  return (
    <>
      <p id={titleId} className="update-title">
        {headline(offer)}
      </p>
      <UpdateNotes notes={notes} />
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

// What the notice of a portable copy says and offers: to install Novadeck, which is also
// how it gets the update waiting, or, once the host found one installed that is newer, to
// open that. A failed install says why above the same actions, to try again.
const PortableCard = ({
  offer,
  install,
  unsandboxed,
  titleId,
  onClose,
  onInstall,
  onOpenInstalled,
  onOpenPage,
}: {
  readonly offer: UpdateOffer | undefined
  readonly install: Install
  readonly unsandboxed: boolean
  readonly titleId: string
  readonly onClose: (to: Return) => void
  readonly onInstall: () => void
  readonly onOpenInstalled: () => void
  readonly onOpenPage: () => void
}): React.JSX.Element => {
  if (install.phase === "newer") {
    return (
      <>
        <p id={titleId} className="update-title">
          Novadeck {install.version} is already installed
        </p>
        <p className="update-text">
          It is newer than this copy. Open it to carry on where you left off.
        </p>
        <div className="update-actions">
          <button type="button" className="button min-h-8 px-3" onClick={() => onClose("origin")}>
            Later
          </button>
          <button
            type="button"
            className="button primary min-h-8 px-3"
            onClick={() => {
              onClose("terminal")
              onOpenInstalled()
            }}
          >
            Open Novadeck
          </button>
        </div>
      </>
    )
  }
  return (
    <>
      <p id={titleId} className="update-title">
        {offer ? headline(offer) : "Install Novadeck"}
      </p>
      <p className="update-text">
        {offer
          ? "This copy can't update itself. Installing keeps your workspace."
          : "This copy runs without installing and can't update itself. Installing keeps your workspace."}
      </p>
      {unsandboxed && (
        <p className="update-text">It also lets you turn on the sandbox this copy runs without.</p>
      )}
      {offer && <UpdateNotes notes={offer.notes} />}
      {offer && (
        <button type="button" className="button link update-link" onClick={onOpenPage}>
          Release notes
        </button>
      )}
      {install.phase === "failed" && (
        <p role="alert" className="update-text update-error">
          Could not install Novadeck: {install.reason}
        </p>
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
            onInstall()
          }}
        >
          Install Novadeck
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
  // Where installing from a portable copy stands.
  const [install, setInstall] = useState<Install>({ phase: "idle" })
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
  const portable = update?.portable
  const waiting = install.phase === "running" || install.phase === "installing"
  const installing = (offer?.kind === "ready" && pressed === key) || waiting
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
  const lost = useRecoverFocus(blocked || hidden, chip)
  const word = !offer
    ? "Install Novadeck"
    : offer.kind === "available"
      ? "Update available"
      : "Update ready"
  const narrow = offer ? "Update" : "Install"
  const startInstall = (): void => {
    if (!portable || !update || waiting) return
    setInstall({ phase: "running" })
    void portable.onInstall().then((result) => {
      if (result.kind === "installing") return setInstall({ phase: "installing" })
      // The panel comes back with the answer, without taking focus from where the person is.
      setInstall(
        result.kind === "newer"
          ? { phase: "newer", version: result.version }
          : { phase: "failed", reason: result.reason },
      )
      update.onOpenChange(true)
    })
  }
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
        {waiting
          ? "Installing Novadeck"
          : install.phase === "newer"
            ? `Novadeck ${install.version} is already installed`
            : offer
              ? installing
                ? "Restarting to update"
                : word
              : ""}
      </span>
      {update && (offer || portable) && (
        <>
          <button
            ref={chip}
            type="button"
            className={`footer-action footer-update font-bold ${installing ? "" : "cursor-pointer"}`}
            aria-label={
              waiting
                ? "Installing…"
                : installing
                  ? "Restarting…"
                  : offer
                    ? `${word}: Novadeck ${offer.version}`
                    : word
            }
            aria-expanded={visible}
            aria-controls={visible ? panelId : undefined}
            // Not `disabled`, which would drop the focus a press left on the chip.
            aria-disabled={installing || undefined}
            onClick={() => {
              if (installing) return
              if (visible) {
                finish("origin")
                return
              }
              requested.current = true
              opener.current = "chip"
              // Opened again by the person, the panel starts over without the last failure.
              if (install.phase === "failed") setInstall({ phase: "idle" })
              update.onOpenChange(true)
            }}
          >
            {waiting ? (
              "Installing…"
            ) : installing ? (
              "Restarting…"
            ) : (
              <>
                <span className="max-[701px]:hidden">{word}</span>
                <span className="hidden max-[701px]:inline">{narrow}</span>
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
              <KeepFocus lost={lost} selector=".update-panel" />
              {portable ? (
                <PortableCard
                  offer={offer}
                  install={install}
                  unsandboxed={portable.unsandboxed}
                  titleId={titleId}
                  onClose={finish}
                  onInstall={startInstall}
                  onOpenInstalled={portable.onOpenInstalled}
                  onOpenPage={update.onOpenPage}
                />
              ) : (
                offer && (
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
                )
              )}
            </section>
          )}
        </>
      )}
    </>
  )
}
