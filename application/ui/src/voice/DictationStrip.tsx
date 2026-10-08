import { Check, Loader, Mic, MicOff, TriangleAlert } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"

import type { Store } from "../model/store"
import type { TerminalKey } from "../model/types"
import { maxClipSeconds } from "../model/voice"
import { dictationKey, type DictationController } from "./dictation"

import "./dictation.css"

// The bars of the strip's waveform, oldest first, and how often a new one comes in.
const bars = 48
const barMilliseconds = 60
// The last seconds of a clip, which the strip counts down to its end.
const warnSeconds = 10

const clock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

// The microphone's loudness over the last few seconds, newest on the right. Each bar
// keeps the number it came in with, so the bars slide left rather than repaint.
const Waveform = ({ level }: { readonly level: Store<number> }): React.JSX.Element => {
  const [history, setHistory] = useState<
    readonly { readonly id: number; readonly value: number }[]
  >(() => Array.from({ length: bars }, (_, id) => ({ id, value: 0 })))
  useEffect(() => {
    let latest = level.getSnapshot()
    const unsubscribe = level.subscribe(() => {
      latest = level.getSnapshot()
    })
    const timer = setInterval(
      () => setHistory((past) => [...past.slice(1), { id: past.at(-1)!.id + 1, value: latest }]),
      barMilliseconds,
    )
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [level])
  return (
    <span className="dictation-wave" aria-hidden>
      {history.map(({ id, value }) => (
        // Speech sits low on the meter, so the square root lifts it into view.
        <i key={id} style={{ "--dictation-bar": Math.sqrt(value) } as React.CSSProperties} />
      ))}
    </span>
  )
}

// The seconds since `since`, kept current.
const useSeconds = (since: number): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.floor((now - since) / 1000))
}

const Keys = ({ keys }: { readonly keys: readonly string[] }): React.JSX.Element => (
  <>
    {keys.map((key) => (
      <kbd key={key}>{key}</kbd>
    ))}
  </>
)

const Recording = ({
  level,
  mode,
  startedAt,
  stopKeys,
}: {
  readonly level: Store<number>
  readonly mode: "hold" | "toggle" | null
  readonly startedAt: number
  readonly stopKeys: readonly string[]
}): React.JSX.Element => {
  const seconds = useSeconds(startedAt)
  const ending = seconds >= maxClipSeconds - warnSeconds
  return (
    <>
      <span className="sr-only">Listening.</span>
      <span className="dictation-dot" aria-hidden />
      <Waveform level={level} />
      <span className="dictation-hint">
        {ending ? (
          `Stops at ${clock(maxClipSeconds)}`
        ) : mode === "hold" ? (
          "Release to send"
        ) : (
          <>
            <Keys keys={stopKeys} /> send · <Keys keys={["Esc"]} /> discard
          </>
        )}
      </span>
      {/* Read once by its ending, not every second as it ticks. */}
      <span className="dictation-elapsed" data-ending={ending || undefined} aria-hidden>
        {clock(seconds)}
      </span>
    </>
  )
}

// Voice input's status in a terminal's window: a strip along the edge of its content while
// a clip for it records or transcribes, and for a moment after, saying what came of it.
// It takes no focus, so typing and the keys that end a clip stay where they were; only
// its Addons button takes the pointer. `edge` is where it docks: the foot of the
// terminal's screen, or the top of its chat, whose message box is at the foot.
export const DictationStrip = ({
  controller,
  terminalKey,
  edge,
  stopKeys,
  onSetup,
}: {
  readonly controller: DictationController
  readonly terminalKey: TerminalKey
  readonly edge: "top" | "bottom"
  // The keys that stop a hands-free clip.
  readonly stopKeys: readonly string[]
  // Opens Preferences → Addons, where voice input is set up.
  readonly onSetup: () => void
}): React.JSX.Element => {
  const { view, level, docks } = controller
  const key = dictationKey(terminalKey)
  // While it is on screen, this window shows what concerns its terminal.
  useEffect(() => {
    const count = (by: number): void => {
      docks.update((each) => {
        const next = new Map(each)
        const left = (next.get(key) ?? 0) + by
        if (left > 0) next.set(key, left)
        else next.delete(key)
        return next
      })
    }
    count(1)
    return () => count(-1)
  }, [docks, key])
  const { phase, target, mode, startedAt, notice } = useSyncExternalStore(
    view.subscribe,
    view.getSnapshot,
  )
  const clip = phase !== "idle" && target !== null && dictationKey(target) === key
  const told =
    !clip && notice !== null && notice.target !== null && dictationKey(notice.target) === key
  return (
    <div
      className="dictation-strip"
      role="status"
      aria-live="polite"
      data-edge={edge}
      data-phase={clip ? phase : "idle"}
      data-tone={told ? notice.tone : undefined}
      hidden={!clip && !told}
    >
      {clip && phase === "recording" ? (
        <Recording
          key={startedAt}
          level={level}
          mode={mode}
          startedAt={startedAt}
          stopKeys={stopKeys}
        />
      ) : clip ? (
        <>
          <Loader size={14} className="dictation-icon dictation-spin" aria-hidden />
          <span className="dictation-text dictation-shimmer">Transcribing…</span>
        </>
      ) : told ? (
        <>
          {notice.tone === "done" ? (
            <Check size={14} className="dictation-icon" aria-hidden />
          ) : notice.tone === "error" ? (
            <TriangleAlert size={14} className="dictation-icon" aria-hidden />
          ) : notice.setup ? (
            <Mic size={14} className="dictation-icon" aria-hidden />
          ) : (
            <MicOff size={14} className="dictation-icon" aria-hidden />
          )}
          <span className="dictation-text">{notice.text}</span>
          {notice.setup && (
            <button
              type="button"
              className="dictation-setup"
              // A click opens Addons without taking focus from where the person types.
              onMouseDown={(event) => event.preventDefault()}
              // Its own click, not its window's, which Canvas would also select.
              onClick={(event) => {
                event.stopPropagation()
                onSetup()
              }}
            >
              Open Addons
            </button>
          )}
        </>
      ) : null}
    </div>
  )
}
