import { Check, Loader, Mic, TriangleAlert } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"

import type { Store } from "../model/store"
import { dictationKey, type DictationView } from "./dictation"

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
// closed, or none chosen. It takes no focus and no pointer, so typing, and the
// keys that end a clip, stay where they were; it is a live region, not a dialog, so
// keyboard routing doesn't count it among the overlays that hold keys.
export const DictationOverlay = ({
  view,
  level,
  docks,
}: {
  readonly view: Store<DictationView>
  readonly level: Store<number>
  readonly docks: Store<ReadonlyMap<string, number>>
}): React.JSX.Element => {
  const { phase, target, mode, startedAt, notice } = useSyncExternalStore(
    view.subscribe,
    view.getSnapshot,
  )
  const docked = useSyncExternalStore(docks.subscribe, docks.getSnapshot)
  const about = phase !== "idle" ? target : notice?.target
  const shown =
    (phase !== "idle" || notice !== null) && !(about && (docked.get(dictationKey(about)) ?? 0) > 0)
  return (
    <div
      className="dictation-overlay"
      role="status"
      aria-live="polite"
      data-phase={phase}
      data-tone={phase === "idle" ? notice?.tone : undefined}
      hidden={!shown}
    >
      {phase === "recording" ? (
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
