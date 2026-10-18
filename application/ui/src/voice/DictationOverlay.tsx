import { Check, Loader, Mic, TriangleAlert } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"

import type { Store } from "#core/store"
import type { TerminalKey } from "#core/types"

import { dictationKey, type DictationController } from "./dictation"
import { VoiceSetupContent } from "./VoiceSetup"

import "./dictation.css"

const clock = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

const Elapsed = ({ since }: { readonly since: number }): React.JSX.Element => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="dictation-elapsed" aria-hidden>
      {clock(now - since)}
    </span>
  )
}

const Meter = ({ level }: { readonly level: Store<number> }): React.JSX.Element => {
  const value = useSyncExternalStore(level.subscribe, level.getSnapshot)
  return (
    <span
      className="dictation-meter"
      aria-hidden
      style={{ "--dictation-level": value } as React.CSSProperties}
    >
      <i />
    </span>
  )
}

// A small status line at the app's foot while a clip records or transcribes, and for a
// moment after, for what no terminal's window shows itself (`docks`): a terminal that
// closed, or none chosen, and for voice input's setup, whose buttons take the pointer. It
// takes no focus, so typing, and the keys that end a clip, stay where they were; it is a live region, not a dialog, so
// keyboard routing doesn't count it among the overlays that hold keys.
export const DictationOverlay = ({
  controller,
  keys,
}: {
  readonly controller: DictationController
  // The dictation shortcut's keys.
  readonly keys: readonly string[]
}): React.JSX.Element => {
  const { view, level, docks } = controller
  const setup = useSyncExternalStore(controller.setup.subscribe, controller.setup.getSnapshot)
  const { phase, target, mode, startedAt, notice } = useSyncExternalStore(
    view.subscribe,
    view.getSnapshot,
  )
  const docked = useSyncExternalStore(docks.subscribe, docks.getSnapshot)
  const about = phase !== "idle" ? target : notice?.target
  const docksAt = (key: TerminalKey | null | undefined): boolean =>
    key !== null && key !== undefined && (docked.get(dictationKey(key)) ?? 0) > 0
  // Voice input's setup stands in here where its terminal is not on screen, or none is chosen.
  const setupHere = phase === "idle" && setup !== null && !docksAt(setup.target)
  const shown = setupHere || ((phase !== "idle" || notice !== null) && !docksAt(about))
  return (
    <div
      className="dictation-overlay"
      role="status"
      aria-live="polite"
      data-phase={setupHere ? "setup" : phase}
      data-setup={setupHere ? setup.kind : undefined}
      data-tone={phase === "idle" && !setupHere ? notice?.tone : undefined}
      hidden={!shown}
    >
      {setupHere ? (
        <VoiceSetupContent controller={controller} setup={setup} keys={keys} />
      ) : phase === "recording" ? (
        <>
          <Mic size={14} className="dictation-icon" aria-hidden />
          <span>
            Listening
            <span className="dictation-hint">
              {mode === "hold" ? ". Release to send." : ". Press again to stop, Esc to cancel."}
            </span>
          </span>
          <Meter level={level} />
          <Elapsed since={startedAt} />
        </>
      ) : phase === "transcribing" ? (
        <>
          <Loader size={14} className="dictation-icon dictation-spin" aria-hidden />
          <span>Transcribing…</span>
        </>
      ) : notice ? (
        <>
          {notice.tone === "error" ? (
            <TriangleAlert size={14} className="dictation-icon" aria-hidden />
          ) : notice.tone === "done" ? (
            <Check size={14} className="dictation-icon" aria-hidden />
          ) : (
            <Mic size={14} className="dictation-icon" aria-hidden />
          )}
          <span>{notice.text}</span>
        </>
      ) : null}
    </div>
  )
}
