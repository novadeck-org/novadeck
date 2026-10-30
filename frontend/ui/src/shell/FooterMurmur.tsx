import type { Refusal } from "@novadeck/core/addons/addon"
import { MURMUR_NAME, type Murmur, type MurmurState } from "@novadeck/core/addons/murmur"
import { Progress } from "@novadeck/toolkit/Progress"
import { ProgressRing } from "@novadeck/toolkit/ProgressRing"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import {
  doneForMs,
  footerPhase,
  footerText,
  installPercent,
  stepText,
  type FooterPhase,
} from "./murmur-footer"
import { KeepFocus, useOverlayOpen } from "./notice-focus"

export type FooterMurmurProps = {
  readonly state: MurmurState
  readonly actions: Pick<Murmur, "install" | "cancel">
  // A dialog, the switcher, a question or another notice in its place holds the sheet back
  // until it is answered or closed.
  readonly blocked: boolean
  // Puts typing focus back in the selected terminal, for a sheet that goes with focus in it.
  readonly returnFocus: () => void
  // Opens Preferences at Addons, where Murmur's own card is.
  readonly openAddons: () => void
}

// Murmur's install, as a small item in the footer's right end: a ring and "Murmur 42%" while it
// downloads and checks, however it was started (from the one-time offer or from Addons), then
// "Terminals name themselves now" for a moment. An engine update the app starts by itself shows
// nothing. It opens a sheet, a card of the portable install's shape above the footer's right
// end (it waits while the footer is hidden, a dialog, a menu or another notice in its place
// is open), with the step and Cancel. A failure that may pass turns the item to the danger
// tone and opens the sheet once, with Try again and Not now (which only hides it); a computer that can't run Murmur says so there, and the item leaves
// with it. Its words are announced in one live line that is there before it has words, and a
// failure is said once, never as a percentage that changes. The runner's word that an installed
// Murmur stopped (its engine failing again and again) turns the item to it from rest too, also
// when it stands as the app opens (terminals stop being named, and nothing else says so). Its
// sheet says the runner's words as they are now, with Open Addons and Not now, and no Try again:
// Murmur's jobs retry by themselves, and the word goes with the next that succeeds. The live line
// says the words it stopped with, once. Not now keeps it shut until that word clears, whatever it
// says in between.
export const FooterMurmur = ({
  murmur,
  hidden,
  onSheetChange,
}: {
  readonly murmur: FooterMurmurProps | undefined
  readonly hidden: boolean
  // Told as the sheet shows and goes, so what shares its place can stand aside.
  readonly onSheetChange?: (shown: boolean) => void
}): React.JSX.Element | null => {
  const state = murmur?.state
  const [phase, setPhase] = useState<FooterPhase>("idle")
  // The refusal of an install call the person last answered: another, in the same words, is a
  // new one. And why the item failed, kept as the refusal itself goes with the next snapshot.
  // A refusal still there as this mounts is not news: it was seen, or cannot be shown stale.
  const [handled, setHandled] = useState<Refusal | null>(() => murmur?.state.refused ?? null)
  const [why, setWhy] = useState("")
  // The refusal the item last said, and whether the runner's failure (not a refusal) made it.
  const [said, setSaid] = useState<Refusal | null>(null)
  const [fromRunner, setFromRunner] = useState(false)
  // Whether the person answered the runner's word that Murmur stopped, while it stands.
  const [seen, setSeen] = useState(false)
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  // Whether the person opened the sheet by pressing the item: it then takes focus, so Esc closes it.
  const asked = useRef(false)
  // Set as the sheet goes with focus inside it, as for a Cancel or a dialog that opens.
  const lost = useRef(false)
  const titleId = useId()
  const panelId = useId()
  // The verdict that stood as the install began.
  const [before, setBefore] = useState<string | null>(null)
  const next = state ? footerPhase(phase, state, handled, before, fromRunner, seen) : "idle"
  if (next === "installing" && phase !== "installing" && state)
    setBefore(state.unsupported?.reason ?? null)
  // A word that cleared is forgotten, so the next one is news.
  if (state?.stopped === null && seen) setSeen(false)
  if (next !== phase) {
    setPhase(next)
    if (next === "failed" && state) {
      setWhy(state.failure ?? state.refused?.message ?? "")
      setSaid(state.refused)
      setFromRunner(state.failure !== null)
    }
    // Said once as it stops; the sheet follows the words as they change.
    if (next === "stopped" && state) setWhy(state.stopped ?? "")
    // What went wrong, or can't be, is said once on its own; the rest opens when asked.
    setOpen(next === "failed" || next === "unavailable" || next === "stopped")
  }
  // Another refusal while it is failed (a Try again refused again) is said too, and opens the
  // sheet again.
  if (
    phase === "failed" &&
    next === "failed" &&
    state?.refused?.call === "install" &&
    state.refused !== said
  ) {
    setSaid(state.refused)
    setWhy(state.refused.message)
    setOpen(true)
  }
  useEffect(() => {
    if (phase !== "done") return undefined
    const timer = setTimeout(() => setPhase("idle"), doneForMs)
    return () => clearTimeout(timer)
  }, [phase])
  const wanted = open && !hidden && !murmur?.blocked
  const overlay = useOverlayOpen(wanted)
  const visibleSheet = wanted && !overlay
  const sheetShown = visibleSheet && phase !== "idle" && murmur !== undefined
  // Before paint, so the download's bar and the sheet never show together for a frame.
  useLayoutEffect(() => {
    onSheetChange?.(sheetShown)
  }, [sheetShown, onSheetChange])
  useEffect(() => {
    if (!visibleSheet || !asked.current) return undefined
    // A frame on, after the press that asked has been through the workspace's own click handling.
    const frame = requestAnimationFrame(() => {
      asked.current = false
      panel.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visibleSheet])
  const returnFocus = murmur?.returnFocus
  useEffect(() => {
    if (visibleSheet || !lost.current) return undefined
    lost.current = false
    // A frame on, once whatever took it has had it: if nothing holds it, the item (still there
    // for a sheet closed by Esc or a dialog) or else the terminal gets it.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body) return
      if (chip.current?.isConnected) chip.current.focus()
      else returnFocus?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [visibleSheet, returnFocus])
  if (!murmur || !state) return null
  const shown = phase !== "idle"
  const { actions } = murmur
  const text = shown ? footerText(phase, state, why) : undefined
  const percent = installPercent(state)
  const tone =
    phase === "failed" || phase === "stopped" ? "danger" : phase === "done" ? "success" : undefined
  const leave = (): void => {
    const inside = panel.current?.contains(document.activeElement) === true
    asked.current = false
    setOpen(false)
    if (phase === "unavailable" || phase === "failed") {
      setHandled(state.refused)
      setPhase("idle")
    }
    if (phase === "stopped") {
      setSeen(true)
      setPhase("idle")
    }
    if (inside) chip.current?.focus()
  }
  return (
    <>
      {/* There before it has words, so what fills it is announced; a failure is said here
          alone, not again by its sheet. */}
      <span
        role="status"
        aria-live={phase === "failed" || phase === "stopped" ? "assertive" : "polite"}
        className="sr-only"
      >
        {text?.summary}
      </span>
      {shown && text && !hidden && (
        <button
          ref={chip}
          type="button"
          className="footer-action footer-update footer-murmur cursor-pointer gap-1.5 font-bold"
          data-tone={tone}
          // Named by its visible words, so what is read is what is seen (the live line says
          // it once in full).
          aria-expanded={visibleSheet}
          aria-controls={visibleSheet ? panelId : undefined}
          onClick={() => {
            if (visibleSheet) return leave()
            // Held back by another notice, the sheet shows once that goes, but takes no focus
            // from whatever the person turned to by then.
            asked.current = !murmur.blocked
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.shiftKey || !visibleSheet) return
            event.preventDefault()
            event.stopPropagation()
            leave()
          }}
        >
          {phase === "installing" && <ProgressRing percent={percent} />}
          <span>{text.label}</span>
        </button>
      )}
      {shown && visibleSheet && (
        <section
          ref={panel}
          id={panelId}
          data-workspace-notice
          aria-labelledby={titleId}
          className="floating update-card footer-murmur-sheet"
          tabIndex={-1}
          // A click anywhere on it leaves focus where it was, in a terminal.
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.shiftKey) return
            event.preventDefault()
            event.stopPropagation()
            leave()
          }}
        >
          <KeepFocus lost={lost} selector=".footer-murmur-sheet" />
          {phase === "installing" && (
            <>
              <p className="update-progress-head">
                <span id={titleId} className="update-progress-title">
                  Setting up {MURMUR_NAME}
                </span>
                {percent !== null && <span className="update-progress-percent">{percent}%</span>}
              </p>
              <Progress label={`${MURMUR_NAME} setup`} value={percent} max={100} />
              <p className="update-progress-note">{stepText(state)}</p>
              <div className="update-card-foot">
                <button type="button" className="button min-h-7 px-3" onClick={actions.cancel}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {phase === "failed" && (
            <>
              <p className="update-progress-head">
                <span id={titleId} className="update-progress-title">
                  Couldn't turn on {MURMUR_NAME}
                </span>
              </p>
              <p className="update-progress-note update-card-error footer-murmur-error">{why}</p>
              <div className="update-card-foot">
                <button type="button" className="button min-h-7 px-3" onClick={leave}>
                  Not now
                </button>
                <button
                  type="button"
                  className="button primary min-h-7 px-3"
                  onClick={() => {
                    setOpen(false)
                    setHandled(state.refused)
                    void actions.install()
                  }}
                >
                  Try again
                </button>
              </div>
            </>
          )}
          {phase === "stopped" && (
            <>
              <p className="update-progress-head">
                <span id={titleId} className="update-progress-title">
                  {MURMUR_NAME} stopped
                </span>
              </p>
              <p className="update-progress-note update-card-error footer-murmur-error">
                {state.stopped}
              </p>
              <p className="update-progress-note">
                It keeps trying on its own, and this goes once it works again.
              </p>
              <div className="update-card-foot">
                <button type="button" className="button min-h-7 px-3" onClick={leave}>
                  Not now
                </button>
                <button
                  type="button"
                  className="button primary min-h-7 px-3"
                  onClick={() => {
                    leave()
                    murmur.openAddons()
                  }}
                >
                  Open Addons
                </button>
              </div>
            </>
          )}
          {phase === "unavailable" && (
            <>
              <p className="update-progress-head">
                <span id={titleId} className="update-progress-title">
                  Not available on this computer
                </span>
              </p>
              <details className="update-progress-note">
                <summary className="cursor-pointer select-none">Details</summary>
                <p className="m-0 mt-1 break-words">{state.unsupported?.reason}</p>
              </details>
              <div className="update-card-foot">
                <button type="button" className="button min-h-7 px-3" onClick={leave}>
                  Close
                </button>
              </div>
            </>
          )}
          {phase === "done" && (
            <p className="update-progress-head">
              <span id={titleId} className="update-progress-title">
                {text?.label}
              </span>
            </p>
          )}
        </section>
      )}
    </>
  )
}
