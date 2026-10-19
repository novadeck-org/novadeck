import "./mounted-terminal.css"
import type {
  MountTerminal,
  TerminalKey,
  TerminalLock as Lock,
  TerminalMount,
  ViewState,
} from "@novadeck/core/port"
import { endingText, terminalEnding } from "@novadeck/core/terminal-ending"
import type { TerminalMetadata, ViewMode } from "@novadeck/core/types"
import { TerminalEndingBar, TerminalLock, TerminalNotice } from "@novadeck/toolkit/TerminalStatus"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

// Why typing is paused. A failed paste says why in the same notice.
const lockNotices: Record<Lock, string> = {
  starting: "Starting shell…",
  // A shell already running, whose screen is on its way.
  loading: "Loading output…",
  reconnecting: "Reconnecting…",
  offline: "Runner offline",
}
// A lock this short, such as while a screen arrives, stays out of sight: the dimming
// and the label fade in only after a moment.

// What the terminal shows until its mount exists: it takes input and has nothing to say.
const opening: ViewState = { live: false, resuming: false, waits: false, lock: null, notice: null }
const ignore = (): (() => void) => () => {}

// One terminal drawn by a backend's mount, with what lies over it. The backend draws the
// terminal into an element this keeps for the terminal's life, and tells its state; this
// draws the window around it and the lock, the notice of a failed paste and the ending bar
// from that state. The element moves into the slot of whichever content a different program
// body renders, so the terminal keeps its emulator, its output and its focus.
export const MountedTerminal = ({
  mountTerminal,
  terminalKey,
  terminal,
  view,
  focusInput,
  onInputFocused,
  onScreen,
  renderWindow,
}: {
  readonly mountTerminal: MountTerminal
  // Stable for the terminal's lifetime, so it is safe in effect dependencies.
  readonly terminalKey: TerminalKey
  readonly terminal: TerminalMetadata
  readonly view: ViewMode
  // True while keyboard navigation asks the terminal to focus its input.
  readonly focusInput: boolean
  // Stable across renders; called once the focus landed.
  readonly onInputFocused: () => void
  // Whether the window is where the person can see it.
  readonly onScreen: boolean
  readonly renderWindow: (content: ReactNode) => ReactNode
}): React.JSX.Element => {
  const [element] = useState(() => {
    const created = document.createElement("div")
    created.setAttribute("class", "terminal-screen flex min-h-0 flex-1 flex-col")
    return created
  })
  const [mount, setMount] = useState<TerminalMount | null>(null)
  const name = terminal.name
  const status = terminal.state
  const props = useMemo(() => ({ name, status, view, onScreen }), [name, status, view, onScreen])
  const latest = useRef(props)
  const ending = terminalEnding(terminal)
  const { lock, notice } = useSyncExternalStore(
    mount?.state.subscribe ?? ignore,
    () => mount?.state.getSnapshot() ?? opening,
  )
  const locked = lock !== null
  const ended = ending !== null
  const root = useRef<HTMLDivElement | null>(null)
  const held = useRef(false)

  // Room for the ending bar keeps the output clear of it, as far above it as the content's
  // own padding.
  useLayoutEffect(() => {
    element.classList.toggle("mb-7", ended)
  }, [element, ended])

  // Mounted before paint and let go while the element is still in the page, so the focus it
  // holds carries to the mount that shows this terminal next. Props follow in effects.
  useLayoutEffect(() => {
    latest.current = props
  })
  useLayoutEffect(() => {
    const created = mountTerminal(element, terminalKey, latest.current)
    setMount(created)
    return () => created.dispose()
  }, [mountTerminal, element, terminalKey])

  useEffect(() => mount?.update(props), [mount, props])

  // The request stands until the focus lands: a terminal that cannot take it answers false,
  // and the UI keeps asking each time the mount, the request or its callback changes. The
  // props above are applied first, so a terminal back on screen has its screen by now.
  useEffect(() => {
    if (!focusInput || !mount) return
    if (mount.focus()) onInputFocused()
  }, [mount, focusInput, onInputFocused])

  const onWheel = useCallback((event: WheelEvent): void => {
    // Intercept before XYFlow's native listener, but let zoom gestures reach it.
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
  }, [])
  const onRoot = useCallback(
    (content: HTMLDivElement | null): void => {
      root.current?.removeEventListener("wheel", onWheel)
      root.current = content
      content?.addEventListener("wheel", onWheel, { passive: true })
    },
    [onWheel],
  )
  // A different program body remounts the content: the element moves into the new slot,
  // and takes the focus it held in the old.
  const onSlot = useCallback(
    (slot: HTMLDivElement | null): void => {
      if (!slot) {
        held.current = element.contains(document.activeElement)
        return
      }
      if (element.parentElement !== slot) slot.replaceChildren(element)
      if (held.current) mount?.focus()
      held.current = false
    },
    [element, mount],
  )

  return (
    <>
      {renderWindow(
        <div
          ref={onRoot}
          data-terminal-content
          className="terminal-content terminal-mounted nodrag nopan relative flex min-h-0 flex-1 flex-col"
          data-locked={locked || undefined}
        >
          <div ref={onSlot} className="flex min-h-0 flex-1 flex-col" />
          <TerminalEndingBar
            ending={ending}
            paused={locked}
            onRestart={() => {
              mount?.restart()
              // The button leaves with the bar; typing goes on in the fresh shell.
              mount?.focus()
            }}
          />
          {notice && (
            <div
              aria-hidden
              data-paste-notice
              className="terminal-paste pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3"
            >
              <TerminalNotice notice={notice} />
            </div>
          )}
          {lock && <TerminalLock notice={lockNotices[lock]} />}
        </div>,
      )}
      {/* Announced from outside the window: the bar is inert while hidden, the content
          remounts when the program's body changes, as when an agent's shell ends, and
          a region that appears with its text already in place is not announced. Empty
          while no ending shows, so a repeat of the same ending is announced again. */}
      <span aria-live="polite" aria-atomic className="sr-only">
        {ending ? endingText(ending) : ""}
      </span>
      {/* A failed paste, announced the same way. */}
      <span aria-live="polite" aria-atomic className="sr-only">
        {notice ?? ""}
      </span>
    </>
  )
}
