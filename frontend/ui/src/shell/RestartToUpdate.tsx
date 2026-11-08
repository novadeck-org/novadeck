import type { UpdateOffer } from "@novadeck/core/desktop/update"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { ArrowRight, CircleHelp, CircleStop, RotateCw, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { blockingOverlayOpen } from "../interaction/dom"
import { KeepFocus, useOverlayOpen, useRecoverFocus } from "./notice-focus"
import type { RestartCheck, Risk } from "./restart-check"
import { readFoldedRestart, writeFoldedRestart } from "./shell-storage"

// An update downloaded and waiting for the next quit, offered as a restart now.
export type RestartUpdateProps = {
  // The downloaded release, as the app last said it: an offer sent again is a new object.
  readonly offer: UpdateOffer
  // The version running now, when the desktop app says.
  readonly from?: string | undefined
  // What a restart would do to the workspace's terminals, and where the runner's own word on
  // work held in shells stands: `pending` until it comes (the card then claims nothing), and
  // `unavailable` where it can't be had.
  readonly check: RestartCheck
  readonly answer: "pending" | "known" | "unavailable"
  // Asks the runner once more as Restart now is pressed: whether to go on, which it is not
  // where it found work the card did not show (the card then shows it). Absent, it goes on.
  readonly recheck?: (() => Promise<boolean>) | undefined
  // Told when the card shows or goes: the runner is asked about shells only while it shows.
  readonly onShownChange?: ((shown: boolean) => void) | undefined
  // Quits and installs, then opens again: the person's own choice, never done by itself.
  readonly onRestart: () => void
  // Brings a terminal into view and puts typing focus in it; the card stays open.
  readonly onGoTo: (terminalId: string) => void
  // Whether another notice holds the corner: a dialog, the sandbox notice, a download's bar
  // or the what's-new card. The card waits, and comes back when it ends.
  readonly blocked: boolean
}

// Most terminals the well names; the rest are counted.
const listed = 2

// How long "Restarting…" waits for the app to quit before it lets the person press again, as
// when the app refused or the restart came to nothing.
export const restartingMs = 20_000

// The count line in the stamp's mono: "2 resume · 8 reopen", without a part that is zero.
export const countLine = ({ resume, reopen }: RestartCheck): string =>
  [resume > 0 && `${resume} resume`, reopen > 0 && `${reopen} reopen`].filter(Boolean).join(" · ")

// What a risk says, as its bold part and the line under it.
const words = (risk: Risk): { readonly main: React.ReactNode; readonly where: string } => {
  switch (risk.kind) {
    case "stops":
      return {
        main: (
          <>
            <code>{risk.command}</code> stops
          </>
        ),
        where: `${risk.title} · start it again after`,
      }
    case "agent":
      return {
        main:
          risk.command === undefined ? (
            risk.what
          ) : (
            <>
              <code>{risk.command}</code> stops
            </>
          ),
        where: `${risk.title} · its agent waits on it`,
      }
    case "unknown":
      return { main: "Can't see what runs", where: `${risk.title} · it may stop` }
  }
}

// A downloaded update's footer chip, "Restart to update", and the card above it that checks
// what a restart would do (the C2 "Verdict" card): "Everything comes back", or "Almost" when
// a program in a plain shell, work an agent waits on, or a job the runner sees in a shell
// would stop, with a count of what resumes and reopens, and a well naming up to two
// terminals at risk, each with an arrow to go there. While the runner's word on shells is
// pending the card says it is checking, and where it can't be had it says so: it never
// claims nothing stops without knowing. Restart now is the person's to press; it quits and
// installs, then opens Novadeck again, and the button stays "Restarting…" until the offer is
// sent again or changes, or a while passes with no quit; the runner is asked once more first,
// and work it finds that the card did not show stops the restart so the person sees it. The card is a plain panel on the
// portable card's recipe (PortableInstall.tsx): nothing about it intercepts keys, focus or
// clicks elsewhere, a click on it leaves terminal focus where it was, and it never opens by
// itself, only from the chip, and never moves focus when something else held it up. Plain
// Escape or the × folds it back into the chip, which then shows only its icon (and dot) for
// this release; a newer release brings the word back. It waits while the footer is hidden
// (Zen) or another notice, dialog, menu or popover is open.
export const RestartToUpdate = ({
  restart,
  hidden,
}: {
  readonly restart: RestartUpdateProps | undefined
  readonly hidden: boolean
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  // Whether the person opened the card from the chip: focus moves into it once it shows.
  const requested = useRef(false)
  const titleId = useId()
  const panelId = useId()
  const wanted = open && restart !== undefined && !hidden && !restart.blocked
  const overlay = useOverlayOpen(wanted)
  const blocked = (restart?.blocked ?? false) || overlay
  const visible = open && restart !== undefined && !hidden && !blocked
  const onShownChange = restart?.onShownChange
  useEffect(() => {
    onShownChange?.(visible)
    return () => onShownChange?.(false)
  }, [visible, onShownChange])
  useEffect(() => {
    if (!visible) {
      // An open that came to nothing, as when something held it back, never takes focus later.
      requested.current = false
      return undefined
    }
    if (!requested.current) return undefined
    // A frame on, after the click that asked has been through the workspace's own click
    // handling, which would hand focus back to the terminal from a card focused too soon.
    const frame = requestAnimationFrame(() => {
      requested.current = false
      panel.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  const lost = useRecoverFocus(blocked || hidden, chip)
  const [folded, setFolded] = useState(readFoldedRestart)
  // The offer this window asked to restart into: the same one sent again, or another, is new.
  const [asked, setAsked] = useState<UpdateOffer>()
  const restarting = asked !== undefined && asked === restart?.offer
  useEffect(() => {
    if (asked === undefined) return undefined
    const timer = setTimeout(() => setAsked(undefined), restartingMs)
    return () => clearTimeout(timer)
  }, [asked])
  if (!restart && open) setOpen(false)
  const fold = (): void => {
    if (!restart) return
    setFolded(restart.offer.version)
    writeFoldedRestart(restart.offer.version)
    const inside = panel.current?.contains(document.activeElement) === true
    requested.current = false
    setOpen(false)
    if (!inside) return
    // Back to the chip, which the person opened the card from.
    chip.current?.focus()
  }
  const press = async (): Promise<void> => {
    if (!restart || restarting) return
    // The button pressed goes disabled with its card: focus stays in the card.
    if (panel.current?.contains(document.activeElement)) panel.current.focus()
    setAsked(restart.offer)
    // Work started since the card looked is shown first, and the person presses again.
    if (restart.recheck && !(await restart.recheck())) {
      setAsked(undefined)
      return
    }
    restart.onRestart()
  }
  const check = restart?.check
  const answer = restart?.answer ?? "known"
  const risks = check?.risks ?? []
  const shown = risks.slice(0, listed)
  const version = restart?.offer.version
  const iconOnly = version !== undefined && folded === version
  const count = check ? countLine(check) : ""
  const careful = risks.length > 0 || answer === "unavailable"
  const headline = careful
    ? "Almost everything comes back"
    : answer === "pending"
      ? "Checking what a restart keeps…"
      : "Everything comes back"
  return (
    <>
      {/* Always mounted, so filling it announces the arrival. */}
      <span role="status" aria-live="polite" className="sr-only">
        {restarting ? "Restarting Novadeck" : restart ? "Restart to update" : ""}
      </span>
      {restart && check && (
        <>
          <button
            ref={chip}
            type="button"
            className="footer-update footer-chip cursor-pointer"
            aria-label={`Restart to update: Novadeck ${version}`}
            title={iconOnly ? "Restart to update" : undefined}
            aria-expanded={visible}
            aria-controls={visible ? panelId : undefined}
            onClick={() => {
              if (visible) {
                fold()
                return
              }
              // Another notice or an open dialog, menu or popover holds the corner: the click
              // opens nothing, now or later.
              if (restart.blocked || blockingOverlayOpen()) {
                requested.current = false
                return
              }
              requested.current = true
              setOpen(true)
            }}
          >
            <span className="footer-chip-icon" aria-hidden="true">
              <RotateCw size={12} strokeWidth={1.75} />
              <span className="attention-dot footer-chip-dot" />
            </span>
            <span className={`footer-chip-text ${iconOnly ? "hidden" : "max-[701px]:hidden"}`}>
              Restart to update
            </span>
          </button>
          {visible && (
            <section
              ref={panel}
              id={panelId}
              data-workspace-notice
              aria-labelledby={titleId}
              className="floating update-card whats-new restart-card"
              tabIndex={-1}
              // A click anywhere on it leaves focus where it was, in a terminal.
              onMouseDown={(event) => event.preventDefault()}
              // Plain Escape folds it into the chip; with Shift it goes on to the workspace,
              // which starts navigating.
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.shiftKey) return
                event.preventDefault()
                event.stopPropagation()
                fold()
              }}
            >
              <KeepFocus lost={lost} selector=".restart-card" />
              <p className="whats-new-head">
                <span id={titleId} className="whats-new-tape">
                  Restart · {version}
                </span>
                {restart.from !== undefined && (
                  <span className="whats-new-from">From {restart.from}</span>
                )}
                <button
                  type="button"
                  className="icon-button small update-card-close"
                  aria-label="Dismiss"
                  onClick={fold}
                >
                  <X size={14} />
                </button>
              </p>
              <p className="restart-verdict">{headline}</p>
              <p className="restart-line">
                {count !== "" && <span className="restart-count">{count}</span>}
                Agents carry on where they were, terminals reopen in their folders.
              </p>
              {(risks.length > 0 || answer === "unavailable") && (
                <div className="restart-well">
                  {shown.map((risk) => {
                    const { main, where } = words(risk)
                    return (
                      <div key={`${risk.kind}:${risk.id}`} className="restart-item">
                        <span className="restart-item-icon" aria-hidden="true">
                          {risk.kind === "unknown" ? (
                            <CircleHelp size={14} strokeWidth={1.8} />
                          ) : (
                            <CircleStop size={14} strokeWidth={1.8} />
                          )}
                        </span>
                        <span className="restart-item-words">
                          <span>{main}</span>
                          <span className="restart-item-where">{where}</span>
                        </span>
                        <Tooltip content={`Go to ${risk.title}`}>
                          <button
                            type="button"
                            className="icon-button small restart-item-go"
                            aria-label={`Go to ${risk.title}`}
                            onClick={() => restart.onGoTo(risk.id)}
                          >
                            <ArrowRight size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    )
                  })}
                  {risks.length > listed && (
                    <p className="restart-more">and {risks.length - listed} more</p>
                  )}
                  {answer === "unavailable" && (
                    <div className="restart-item">
                      <span className="restart-item-icon" aria-hidden="true">
                        <CircleHelp size={14} strokeWidth={1.8} />
                      </span>
                      <span className="restart-item-words">
                        <span>Couldn't check what runs in shells</span>
                        <span className="restart-item-where">Programs in them may stop</span>
                      </span>
                    </div>
                  )}
                </div>
              )}
              <div className="update-card-foot">
                <button
                  type="button"
                  className="button primary min-h-7 px-3"
                  disabled={restarting}
                  onClick={() => void press()}
                >
                  {restarting ? "Restarting…" : "Restart now"}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </>
  )
}
