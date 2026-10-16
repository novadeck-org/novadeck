import { X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import type { InstallProgress, InstallResult } from "../model/portable"
import type { UpdateOffer } from "../model/update"
import { Progress } from "../ui-toolkit/Progress"
import { useLinger } from "./linger"
import { KeepFocus, useOverlayOpen, useRecoverFocus } from "./notice-focus"

// A portable copy, which never updates itself and is the way to install the app that does.
export type FooterPortable = {
  // Whether the app runs without its security sandbox: installing puts it where the sandbox
  // can be turned on, which the panel says.
  readonly unsandboxed: boolean
  // Installs the app, keeping the workspace.
  readonly onInstall: () => Promise<InstallResult>
  // Whether this run installed the app already, as when a window is opened again.
  readonly installed: boolean
  // Hears how far an install under way has got, where the host reports it.
  readonly onProgress?: (listener: (progress: InstallProgress) => void) => () => void
}

// Where installing from a portable copy stands. `running` is the wait for the host's answer.
// `installed` is the answer that the installed copy is in place; this copy keeps running.
type Install =
  | { readonly phase: "idle" | "running" | "installed" }
  | { readonly phase: "newer"; readonly version: string }
  | { readonly phase: "failed"; readonly reason: string }

// A portable copy's install entry. A copy that updates itself has none: its downloads show
// as a floating bar (UpdateProgress.tsx).
export type PortableInstallProps = {
  // The release this copy is missing; absent while there is none, when the chip only
  // offers to install.
  readonly offer?: UpdateOffer | undefined
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
}

// What the card says of where installing stands, as its title and its one line.
const cardWords = (
  offer: UpdateOffer | undefined,
  install: Install,
  progress: InstallProgress | null,
): { readonly title: string; readonly line: string } => {
  switch (install.phase) {
    case "running":
      return {
        title: "Installing Novadeck",
        line: progress?.phase === "downloading" ? "Downloading…" : "Keeps your workspace",
      }
    case "installed":
      return { title: "Novadeck installed", line: "Takes effect after you restart Novadeck" }
    case "newer":
      return {
        title: `Novadeck ${install.version} is already installed`,
        line: "Takes effect after you restart Novadeck",
      }
    case "failed":
      return { title: "Couldn't install", line: install.reason }
    case "idle":
      return offer
        ? { title: `Novadeck ${offer.version} is out`, line: "This copy can't update itself." }
        : { title: "Portable copy", line: "Updates need an installed Novadeck." }
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
  // Where installing from a portable copy stands.
  const [started, setStarted] = useState<Install | null>(null)
  // How far the install has got, as far as the host tells.
  const [progress, setProgress] = useState<InstallProgress | null>(null)
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
  // A window opened again in a run that installed the app finds it done.
  const install: Install = started ?? { phase: portable?.installed ? "installed" : "idle" }
  const running = install.phase === "running"
  const wanted = (card?.open ?? false) && !hidden && !card?.blocked
  const overlay = useOverlayOpen(wanted)
  const blocked = (card?.blocked ?? false) || overlay
  const visible = (card?.open ?? false) && !hidden && !blocked
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
    setLingering(null)
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
    setStarted({ phase: "running" })
    setProgress(null)
    const stop = portable.onProgress?.(setProgress)
    void portable.onInstall().then((result: InstallResult) => {
      stop?.()
      // The card comes back with the answer, without taking focus from where the person is.
      setStarted(
        result.kind === "installed"
          ? { phase: "installed" }
          : result.kind === "newer"
            ? { phase: "newer", version: result.version }
            : { phase: "failed", reason: result.reason },
      )
      if (result.kind === "installed") setLingering("finished")
      card.onOpenChange(true)
    })
  }
  const { title, line } = cardWords(offer, install, progress)
  const chipText = running ? "Installing…" : done ? "Installed" : word
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
              // Opened again by the person, the card starts over without the last failure.
              if (install.phase === "failed") setStarted({ phase: "idle" })
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
              className="floating update-card"
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
              <KeepFocus lost={lost} selector=".update-card" />
              <p className="update-progress-head">
                <span id={titleId} className="update-progress-title">
                  {title}
                </span>
                {progress?.phase === "downloading" && running && (
                  <span className="update-progress-percent">{progress.percent}%</span>
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
              {(running || installed) && (
                <Progress
                  label={title}
                  value={
                    installed ? 100 : progress?.phase === "downloading" ? progress.percent : null
                  }
                  max={100}
                />
              )}
              <p
                role={install.phase === "failed" ? "alert" : undefined}
                className={`update-progress-note ${install.phase === "failed" ? "update-card-error" : ""}`}
              >
                {line}
              </p>
              {portable.unsandboxed && install.phase === "idle" && (
                <p className="update-progress-note">
                  Installing also lets you turn on the sandbox.
                </p>
              )}
              {(install.phase === "idle" || install.phase === "failed") && (
                <div className="update-card-foot">
                  {install.phase === "idle" && <span>Keeps your workspace</span>}
                  <button
                    type="button"
                    className="button primary min-h-7 px-3"
                    onClick={startInstall}
                  >
                    {install.phase === "failed" ? "Try again" : "Install"}
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
