import type { PortableInstall as InstallState } from "@novadeck/core/portable"
import type { UpdateOffer, WhatsNew as Notes } from "@novadeck/core/update"
import { Progress } from "@novadeck/toolkit/Progress"
import { ExternalLink, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { currentPlatform, type Platform } from "../interaction/shortcuts"
import { useLinger } from "./linger"
import { KeepFocus, useOverlayOpen, useRecoverFocus } from "./notice-focus"
import { Highlights, useOverflow } from "./WhatsNew"

// A portable copy, which never updates itself and is the way to install the app that does.
export type FooterPortable = {
  // Whether the app runs without its security sandbox: installing puts it where the sandbox
  // can be turned on, which the panel says.
  readonly unsandboxed: boolean
  // Asks the host to install the app, keeping the workspace; it answers nothing.
  readonly onInstall: () => void
  // Where installing stands in this run: the host owns it, so a window opened again, or
  // another window's install, shows as it is.
  readonly install: InstallState
  // Where the workspace is kept, as the person finds it in their file manager; absent when
  // the host can't say.
  readonly dataFolder?: string | undefined
  // Opens the page to download the newest portable in the browser; absent where the host
  // can't.
  readonly onDownload?: (() => void) | undefined
  // Shows the workspace's folder in the file manager; absent where the host can't.
  readonly onShowFolder?: (() => void) | undefined
}

// A portable copy's install entry. A copy that updates itself has none: its downloads show
// as a floating bar (UpdateProgress.tsx).
export type PortableInstallProps = {
  // The release this copy is missing; absent while there is none, when the chip only
  // offers to install.
  readonly offer?: UpdateOffer | undefined
  // What is new in that release, when the host tells: the card then lists the highlights.
  readonly news?: Notes | undefined
  // Whether the first answer about the notes is in, or none is coming. The automatic raise
  // waits for it, so the card comes up in its final look; the chip opens it at once.
  readonly newsSettled?: boolean | undefined
  readonly portable: FooterPortable
  // Whether the card is raised: it shows only while the footer does, and while nothing
  // else asks for the person's attention (`blocked`).
  readonly open: boolean
  readonly blocked: boolean
  readonly onOpenChange: (open: boolean) => void
  // Called when the card comes up.
  readonly onShown: () => void
  // Puts typing focus back in the selected terminal; false when there is none.
  readonly returnFocus: () => boolean
  // Where the app runs, for how a new copy takes effect; the page's own by default.
  readonly platform?: Platform | undefined
}

// What the card says of where installing stands, as its title and its one line.
const cardWords = (
  offer: UpdateOffer | undefined,
  install: InstallState,
  platform: Platform,
): { readonly title: string; readonly line: string } => {
  // Closing the window doesn't quit the app on macOS, so a restart there is a quit and a reopen.
  const takesEffect =
    platform === "mac"
      ? "Takes effect after you quit and reopen Novadeck"
      : "Takes effect after you restart Novadeck"
  switch (install.phase) {
    case "downloading":
      return { title: "Installing Novadeck", line: "Downloading…" }
    case "installing":
      return { title: "Installing Novadeck", line: "Keeps your workspace" }
    case "installed":
      return {
        title: "Novadeck installed",
        line: takesEffect,
      }
    case "newer":
      return {
        title: `Novadeck ${install.version} is already installed`,
        line: takesEffect,
      }
    case "failed":
      return { title: "Couldn't install", line: install.reason }
    case "idle":
      return offer
        ? {
            title: `Novadeck ${offer.version} is out`,
            line: "This copy can't update itself.",
          }
        : {
            title: "Portable copy",
            line: "Updates need an installed Novadeck.",
          }
  }
}

// A portable copy's install entry beside the footer's status: a chip, "Install Novadeck"
// or, with a release this copy is missing, "Update available", and the card above it, the
// same size and place as the update bar but with buttons. The card is a plain panel, not a
// dialog or a layer: nothing about it intercepts keys, focus or clicks elsewhere, so typing
// in a terminal goes on. It is raised once per launch, which the host of the app sees to;
// it waits while the footer is hidden or any dialog, menu or popover is open, and never
// takes focus by itself. The chip opens it as the person's own request, with focus moving
// to the card, so Escape there folds it back into the chip and returns to it.
// A finished install says so for a few seconds, as the update bar does, then fades and
// leaves "Installed" on the chip. Novadeck never restarts itself.
export const PortableInstall = ({
  portable: card,
  hidden,
}: {
  readonly portable: PortableInstallProps | undefined
  readonly hidden: boolean
}): React.JSX.Element => {
  // Whether the card is saying an install is done, for a few seconds, before it fades away.
  const [lingering, setLingering] = useState<"finished" | "fading" | null>(null)
  const panel = useRef<HTMLElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  // Whether the person opened the card from the chip: focus moves into it once it
  // shows (`requested`), and closing it sends focus back to the chip (`opener`).
  const requested = useRef(false)
  const opener = useRef<"chip" | "auto">("auto")
  const titleId = useId()
  const panelId = useId()
  const offer = card?.offer
  const portable = card?.portable
  // Where installing stands is the host's to say, and a window opened again finds it so.
  const hosted: InstallState = portable?.install ?? { phase: "idle" }
  // Whether the person dismissed the card on a failure: the page then shows the idle card
  // for it, until the host's phase changes again.
  const [forgotten, setForgotten] = useState(false)
  const install: InstallState = forgotten && hosted.phase === "failed" ? { phase: "idle" } : hosted
  const running = install.phase === "downloading" || install.phase === "installing"
  // Whether the person opened the card from the chip, which brings it up without waiting for
  // the notes.
  const [personOpened, setPersonOpened] = useState(false)
  const holding = !(card?.newsSettled ?? true) && !personOpened && install.phase === "idle"
  const wanted = (card?.open ?? false) && !hidden && !card?.blocked && !holding
  const overlay = useOverlayOpen(wanted)
  const blocked = (card?.blocked ?? false) || overlay
  const visible = (card?.open ?? false) && !hidden && !blocked && !holding
  // The notes the card came up with, for as long as it shows: an answer arriving later does
  // not swap its look under the person.
  const [frozen, setFrozen] = useState<{ readonly news: Notes | undefined } | null>(null)
  if (visible && frozen === null) setFrozen({ news: card?.news })
  if (!visible && frozen !== null) setFrozen(null)
  const [setList, scrolls] = useOverflow()
  const downloadId = useId()
  const onShown = card?.onShown
  useEffect(() => {
    if (visible) onShown?.()
  }, [visible, onShown])
  useEffect(() => {
    if (!visible || !requested.current) return
    // A frame on, after the click that asked has been through the workspace's own click
    // handling, which would hand focus back to the terminal from a card focused too soon.
    const frame = requestAnimationFrame(() => {
      requested.current = false
      panel.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible])
  const lost = useRecoverFocus(blocked || hidden, chip)
  const finish = (): void => {
    if (!card) return
    const inside = panel.current?.contains(document.activeElement) === true
    const back = opener.current === "chip"
    requested.current = false
    opener.current = "auto"
    setPersonOpened(false)
    setLingering(null)
    if (hosted.phase === "failed") setForgotten(true)
    card.onOpenChange(false)
    if (!inside) return
    if (back || !card.returnFocus()) chip.current?.focus()
  }
  useLinger(lingering, visible, (to) => (to === "fading" ? setLingering("fading") : finish()))
  const word = offer ? "Update available" : "Install Novadeck"
  const narrow = offer ? "Update" : "Install"
  const installed = install.phase === "installed"
  // Nothing is left to install: the chip says so, for a newer copy found as for ours.
  const done = installed || install.phase === "newer"
  const startInstall = (): void => {
    if (!portable || !card || running) return
    // The button pressed goes with the card's words; focus stays in the card.
    if (panel.current?.contains(document.activeElement)) panel.current.focus()
    setForgotten(false)
    setAsked(true)
    askedNow.current = true
    portable.onInstall()
  }
  // An install this window asked for ends: a finished one lingers as the update bar does, and
  // the card comes back with the outcome, without taking focus from where the person is.
  const phase = hosted.phase
  const [seen, setSeen] = useState(phase)
  // Whether the host has said yet; a failure it says first happened before this page loaded,
  // so it counts as dismissed. One this page watches happen shows.
  const [known, setKnown] = useState(false)
  // Whether the person pressed Install in this window: every window shows an install under
  // way, but only the one that asked has the card come back with its end. `askedNow` is the
  // same for the effect below.
  const [asked, setAsked] = useState(false)
  const askedNow = useRef(false)
  // Whether the card was open, to see a failed one closed. Hiding or blocking it is not that.
  const [wasOpen, setWasOpen] = useState(false)
  if (!known && portable) {
    setKnown(true)
    setSeen(phase)
    if (phase === "failed") setForgotten(true)
  } else if (seen !== phase) {
    setSeen(phase)
    setForgotten(false)
    if (seen === "downloading" || seen === "installing") {
      if (phase === "installed" && asked) setLingering("finished")
      // A failure another window's person met is not this window's to show.
      if (phase === "failed" && !asked) setForgotten(true)
      if (phase === "installed" || phase === "newer" || phase === "failed") setAsked(false)
    }
  }
  const open = card?.open ?? false
  if (wasOpen !== open) {
    setWasOpen(open)
    // Only a failure already showing is dismissed by the close; one arriving with it is not.
    if (!open && seen === "failed" && phase === "failed") setForgotten(true)
  }
  const was = useRef(phase)
  const onOpenChange = card?.onOpenChange
  useEffect(() => {
    const before = was.current
    was.current = phase
    if (before !== "downloading" && before !== "installing") return
    if (phase !== "installed" && phase !== "newer" && phase !== "failed") return
    const raise = askedNow.current
    askedNow.current = false
    if (raise) onOpenChange?.(true)
  }, [phase, onOpenChange, askedNow])
  const { title, line } = cardWords(offer, install, card?.platform ?? currentPlatform())
  // The release's highlights, up to four, stand in for the title and line while there is
  // nothing under way or to report: the changelog.
  const heard = frozen ? frozen.news : card?.news
  const news =
    offer && heard && heard.version === offer.version && install.phase === "idle"
      ? { ...heard, highlights: heard.highlights.slice(0, 4) }
      : undefined
  const chipText = running ? "Installing…" : done ? "Installed" : word
  // Where the workspace is, said in the phases where the person weighs installing or
  // installing; the others have their own words about it.
  const dataLine =
    portable?.dataFolder !== undefined && (install.phase === "idle" || install.phase === "failed")
      ? portable.dataFolder
      : undefined
  return (
    <>
      {/* Always mounted, so filling it announces the arrival; out of the layout, and kept
          for assistive technology where the visible words are dropped to fit. */}
      <span role="status" aria-live="polite" className="sr-only">
        {running
          ? "Installing Novadeck"
          : installed
            ? `Novadeck installed. ${line}`
            : install.phase === "newer"
              ? `${title}. ${line}`
              : offer
                ? word
                : ""}
      </span>
      {card && portable && (
        <>
          <button
            ref={chip}
            type="button"
            className="footer-action footer-update font-bold cursor-pointer"
            aria-label={
              running
                ? "Installing…"
                : done
                  ? `Installed: ${line}`
                  : offer
                    ? `${word}: Novadeck ${offer.version}`
                    : word
            }
            aria-expanded={visible}
            aria-controls={visible ? panelId : undefined}
            onClick={() => {
              if (visible) {
                finish()
                return
              }
              requested.current = true
              opener.current = "chip"
              setPersonOpened(true)
              card.onOpenChange(true)
            }}
          >
            {offer && install.phase === "idle" && (
              <span className="footer-update-dot" aria-hidden="true" />
            )}
            {running || done ? (
              chipText
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
              className={`floating update-card portable-card ${news ? "whats-new" : ""}`}
              data-state={lingering === "fading" ? "closed" : "open"}
              tabIndex={-1}
              // A click anywhere on it leaves focus where it was, in a terminal.
              onMouseDown={(event) => event.preventDefault()}
              // Plain Escape folds it into the chip, an install under way too; with
              // Shift it goes on to the workspace, which starts navigating.
              onKeyDown={(event) => {
                if (event.key !== "Escape" || event.shiftKey) return
                event.preventDefault()
                event.stopPropagation()
                finish()
              }}
            >
              <KeepFocus lost={lost} selector=".portable-card" />
              {news ? (
                <p className="whats-new-head">
                  {/* The tape shows "New in" and the version; a screen reader hears the app's name too. */}
                  <span id={titleId} className="whats-new-tape">
                    New in <span className="sr-only">Novadeck </span>
                    {news.version}
                  </span>
                  {news.from !== undefined && (
                    <span className="whats-new-from">From {news.from}</span>
                  )}
                  <button
                    type="button"
                    className="icon-button small update-card-close"
                    aria-label="Dismiss"
                    onClick={finish}
                  >
                    <X size={14} />
                  </button>
                </p>
              ) : (
                <p className="update-progress-head">
                  <span id={titleId} className="update-progress-title">
                    {title}
                  </span>
                  {install.phase === "downloading" && (
                    <span className="update-progress-percent">{install.percent}%</span>
                  )}
                  <button
                    type="button"
                    className="icon-button small update-card-close"
                    aria-label="Dismiss"
                    onClick={finish}
                  >
                    <X size={14} />
                  </button>
                </p>
              )}
              {(running || installed) && (
                <Progress
                  label={title}
                  value={installed ? 100 : install.phase === "downloading" ? install.percent : null}
                  max={100}
                />
              )}
              {news ? (
                <ul
                  ref={setList}
                  className="whats-new-list"
                  tabIndex={scrolls ? 0 : undefined}
                  aria-labelledby={scrolls ? titleId : undefined}
                >
                  <Highlights highlights={news.highlights} />
                </ul>
              ) : (
                <p
                  role={install.phase === "failed" ? "alert" : undefined}
                  className={`update-progress-note ${install.phase === "failed" ? "update-card-error" : ""}`}
                >
                  {line}
                </p>
              )}
              {dataLine !== undefined && (
                <p className="update-progress-note portable-data">
                  <span>
                    Your workspace stays in <code className="portable-path">{dataLine}</code>.
                  </span>
                  {portable.onShowFolder && (
                    <button
                      type="button"
                      className="button link shrink-0 text-control"
                      onClick={portable.onShowFolder}
                    >
                      Show folder
                    </button>
                  )}
                </p>
              )}
              {portable.unsandboxed && install.phase === "idle" && (
                <p className="update-progress-note">
                  Installing also lets you turn on the sandbox.
                </p>
              )}
              {(install.phase === "idle" || install.phase === "failed") && (
                <div className="update-card-foot">
                  {install.phase === "idle" && dataLine === undefined && (
                    <span>Keeps your workspace</span>
                  )}
                  {(install.phase === "idle" || install.phase === "failed") &&
                    offer &&
                    portable.onDownload && (
                      <>
                        <button
                          type="button"
                          className="button quiet min-h-7 gap-1.5 px-2"
                          aria-describedby={downloadId}
                          onClick={portable.onDownload}
                        >
                          Get new portable
                          <ExternalLink size={12} aria-hidden="true" />
                        </button>
                        <span id={downloadId} className="sr-only">
                          Opens novadeck.dev in your browser
                        </span>
                      </>
                    )}
                  <button
                    type="button"
                    className="button primary min-h-7 px-3"
                    onClick={startInstall}
                  >
                    {install.phase === "failed" ? "Try again" : "Install Novadeck"}
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </>
  )
}
