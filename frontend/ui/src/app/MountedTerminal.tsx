import "./mounted-terminal.css"
import type {
  MountTerminal,
  TerminalKey,
  TerminalLock as Lock,
  TerminalMount,
  ViewState,
} from "@novadeck/core/port"
import { endingText, terminalEnding, terminalPhase } from "@novadeck/core/terminals/ending"
import type { TerminalMetadata, ViewMode } from "@novadeck/core/types"
import { useShown } from "@novadeck/toolkit/shown"
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

import { useInSight, usePageVisible } from "../layouts/useSeen"

// Why typing is paused. A failed paste says why, and a copy that it copied, in the same notice.
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

// The agent a sleeping or waking terminal resumes.
const agentOf = (terminal: TerminalMetadata): string | undefined =>
  terminal.state === "sleeping" ? terminal.agent : terminal.restoredProcess

// The rows xterm draws, once it has opened; the screen holding them before then.
const measured = (host: HTMLElement): Element | null =>
  host.querySelector(".xterm-rows") ?? host.querySelector(".xterm-screen")

// Where the first terminal row starts inside the screen's slot, so the words stand where the
// agent will draw. Falls back to the stylesheet's padding while there is no emulator to measure.
const alignWithRows = (screen: HTMLElement): void => {
  const host = screen.parentElement
  const rows = host && measured(host)
  if (!host || !rows) return
  const outer = host.getBoundingClientRect()
  const inner = rows.getBoundingClientRect()
  if (inner.width === 0 || inner.height === 0) return
  // A canvas node scales its content: measure in the node's own pixels.
  const scale = outer.width / host.offsetWidth || 1
  screen.style.setProperty(
    "--wake-pad",
    `${(inner.top - outer.top) / scale}px 0 0 ${(inner.left - outer.left) / scale}px`,
  )
}

// A blink of its own per terminal, so a grid of waking tiles does not blink as one.
const blinkDelay = (id: string): string => {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 1060
  return `${-hash}ms`
}

// What stands where the agent will draw: while it sleeps a bare `z`, nothing of its last screen
// (replaying that would write into the emulator the resuming agent draws in); while it wakes,
// the words and a blinking cursor, in place of "Starting shell…". The terminal stays locked and
// its keys are dropped either way.
// The words are hidden from assistive technology: 170 sleepers would be 170 live regions.
// The tab and the window say it in words.
const SleepingScreen = ({
  phase,
  agent,
  legible,
  id,
}: {
  readonly phase: "sleeping" | "waking"
  readonly agent: string | undefined
  readonly legible: boolean
  readonly id: string
}): React.JSX.Element => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const screen = ref.current
    if (!screen) return
    alignWithRows(screen)
    if (typeof ResizeObserver === "undefined" || !screen.parentElement) return
    const host = screen.parentElement
    const observer = new ResizeObserver(() => alignWithRows(screen))
    // What is measured is observed too, and again when xterm opens after the first measure.
    let watched: Element | null = null
    const watch = (): void => {
      const rows = measured(host)
      if (rows === watched) return
      if (watched) observer.unobserve(watched)
      watched = rows
      if (rows) observer.observe(rows)
      alignWithRows(screen)
    }
    observer.observe(host)
    watch()
    const appearing = new MutationObserver(watch)
    appearing.observe(host, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      appearing.disconnect()
    }
  }, [])
  return (
    <div
      ref={ref}
      aria-hidden
      className="wake-screen"
      data-phase={phase}
      data-legible={legible}
      style={{ "--wake-delay": blinkDelay(id) } as React.CSSProperties}
    >
      {phase === "sleeping" ? (
        <span className="wake-z">z</span>
      ) : (
        <span>
          {`waking ${agent ?? "agent"}… `}
          <span className="wake-cursor">█</span>
        </span>
      )}
    </div>
  )
}

// One terminal drawn by a backend's mount, with what lies over it. The backend draws the
// terminal into an element this keeps for the terminal's life, and tells its state; this
// draws the window around it and the lock, the notice of a failed paste or a copy and the ending bar
// from that state. The element moves into the slot of whichever content renders it, so the
// terminal keeps its emulator, its output and its focus.
export const MountedTerminal = ({
  mountTerminal,
  terminalKey,
  terminal,
  view,
  focusInput,
  onInputFocused,
  onScreen,
  legible = true,
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
  // False in Canvas while zoomed out too far to read a node.
  readonly legible?: boolean
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
  // A sleeping agent wakes once it is seen: in Focus, the one displayed (a parked one is not),
  // in Grid and Canvas, a tile a quarter of which is in sight and legible. Minimized or
  // hidden does not count; unfocused but visible does. Only a sleeper asks, so a running
  // terminal costs no observer.
  const asleep = terminal.state === "sleeping"
  const shown = useShown()
  const pageVisible = usePageVisible()
  const inSight = useInSight(element, asleep && view !== "focus")
  const seen = asleep && pageVisible && onScreen && (view === "focus" ? shown : inSight && legible)
  const props = useMemo(
    () => ({ name, status, view, onScreen, ...(seen ? { seen } : {}) }),
    [name, status, view, onScreen, seen],
  )
  const latest = useRef(props)
  const ending = terminalEnding(terminal)
  const { lock, notice } = useSyncExternalStore(
    mount?.state.subscribe ?? ignore,
    () => mount?.state.getSnapshot() ?? opening,
  )
  const locked = lock !== null
  // Its agent has no screen to draw yet: a bare one stands in, the lock's notice does not.
  const phase = terminalPhase(terminal)
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
  // Where the content remounts, the element moves into the new slot, and takes the focus it
  // held in the old.
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
          {phase === "sleeping" || phase === "waking" ? (
            <SleepingScreen
              phase={phase}
              agent={agentOf(terminal)}
              legible={legible}
              id={terminal.id}
            />
          ) : (
            lock && <TerminalLock notice={lockNotices[lock]} />
          )}
        </div>,
      )}
      {/* Announced from outside the window: the bar is inert while hidden, the content
          remounts when the program's body changes, as when an agent's shell ends, and
          a region that appears with its text already in place is not announced. Empty
          while no ending shows, so a repeat of the same ending is announced again. */}
      <span aria-live="polite" aria-atomic className="sr-only">
        {ending ? endingText(ending) : ""}
      </span>
      {/* A failed paste or a copy, announced the same way. */}
      <span aria-live="polite" aria-atomic className="sr-only">
        {notice ?? ""}
      </span>
    </>
  )
}
