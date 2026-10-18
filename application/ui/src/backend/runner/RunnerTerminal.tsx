import "./runner.css"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { endingText, terminalEnding } from "#core/terminal-ending"
import type { TerminalStatus } from "#core/types"

import { TerminalEndingBar, TerminalLock, TerminalNotice } from "../../ui-toolkit/TerminalStatus"
import type { TerminalSurfaceProps } from "../port"
import { restartable } from "./activity"
import type { SurfaceRuntime } from "./backend"
import { wantsWebgl } from "./renderers"
import { createScreens, type ScreenHandle, type Screens } from "./screens"
import type { ViewLock, ViewPhase, ViewState } from "./view-state"

// Why typing is paused. A failed paste says why in the same notice.
const lockNotices: Record<ViewLock, string> = {
  starting: "Starting shell…",
  // A shell already running, whose screen is on its way.
  loading: "Loading output…",
  reconnecting: "Reconnecting…",
  offline: "Runner offline",
}
// A lock this short, such as while a screen arrives, stays out of sight: the dimming
// and the label fade in only after a moment.

const opening: ViewState = { live: false, resuming: false, waits: false, lock: null, notice: null }
const ignore = (): (() => void) => () => {}

const phaseOf = (status: TerminalStatus): ViewPhase =>
  restartable(status) ? "ended" : status.state === "starting" ? "starting" : "running"

// One component per backend, so its identity stays stable while the backend lives. Its
// screens outlive the surfaces: a view switch unmounts one surface and mounts the next,
// which takes the same emulator and attachment instead of opening them again.
export const createRunnerTerminal = (
  runtime: SurfaceRuntime,
  screens: Screens = createScreens(runtime),
) => {
  const RunnerTerminal = ({
    terminalKey,
    terminal,
    view,
    fontSize,
    focusInput,
    onInputFocused,
    onScreen = true,
    renderWindow,
  }: TerminalSurfaceProps): React.JSX.Element => {
    // React owns each surface's mount slot; the screen owns the one emulator host.
    // Moving the host preserves its textarea, screen, selection, and PTY attachment.
    const [handle, setHandle] = useState<ScreenHandle | null>(null)
    const root = useRef<HTMLDivElement | null>(null)
    const slot = useRef<HTMLDivElement | null>(null)
    const refocus = useRef(false)
    const first = useRef({ name: terminal.name, phase: phaseOf(terminal), view })
    const name = terminal.name
    // An exited or failed terminal waits for Enter, or its bar's Restart.
    const phase = phaseOf(terminal)
    const ending = terminalEnding(terminal)
    // Input is refused while the runner is away, and while a running or starting shell
    // has no stream to take it, as right after a reconnection or a restart; a failed paste
    // says why for a moment at the surface's top.
    const { lock, notice } = useSyncExternalStore(
      handle?.state.subscribe ?? ignore,
      () => handle?.state.getSnapshot() ?? opening,
    )
    const locked = lock !== null

    const onWheel = useCallback((event: WheelEvent): void => {
      // Intercept before XYFlow's native listener, but let zoom gestures reach it.
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation()
    }, [])
    const onRootMount = useCallback(
      (element: HTMLDivElement | null): void => {
        root.current?.removeEventListener("wheel", onWheel)
        root.current = element
        element?.addEventListener("wheel", onWheel, { passive: true })
      },
      [onWheel],
    )
    // A different program body remounts the slot: the screen moves into the new one, and
    // takes the focus it held in the old.
    const onSlot = useCallback(
      (element: HTMLDivElement | null): void => {
        if (!element) {
          refocus.current = Boolean(slot.current?.contains(document.activeElement))
          slot.current = null
          return
        }
        slot.current = element
        if (!handle) return
        handle.place(element)
        if (refocus.current) handle.focus()
        refocus.current = false
      },
      [handle],
    )

    // Whether this surface is mounted, for the cleanup below to tell an unmount from a
    // release; React cleans effects up in the order they are declared.
    const mounted = useRef(false)
    useLayoutEffect(() => {
      mounted.current = true
      return () => {
        mounted.current = false
      }
    }, [])

    // Takes the terminal's screen while this surface shows it: the first surface opens
    // it, later ones find it as the last one left it. A surface out of the person's sight
    // lets it go, staying mounted with the host's last drawing, and takes it again when it
    // is back; each acquire has the one release its cleanup makes. The release comes while
    // the slot is still in the page, so an unmounting surface leaves its focus for the next.
    useLayoutEffect(() => {
      if (!onScreen) return
      const acquired = screens.acquire(terminalKey, {
        label: `Input for ${first.current.name}`,
        phase: first.current.phase,
        webgl: wantsWebgl(first.current.view),
      })
      setHandle(acquired)
      return () => acquired.release({ unmount: !mounted.current })
      // The screen follows the terminal, not its changing metadata.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [terminalKey, onScreen])

    useEffect(() => handle?.update({ phase }), [handle, phase])

    // A view that changes under a mounted surface changes how its screen draws.
    useEffect(() => handle?.update({ webgl: wantsWebgl(view) }), [handle, view])

    useEffect(() => screens.setFont({ size: fontSize }), [fontSize])

    useEffect(() => handle?.update({ label: `Input for ${name}` }), [handle, name])

    // The request stands until the focus lands: a screen the parked-screen cap closed while
    // the surface was away is focused in vain, and its fresh one arrives a render later.
    useEffect(() => {
      if (!focusInput || !handle) return
      if (handle.focus()) onInputFocused()
    }, [handle, focusInput, onInputFocused])

    // A different program body remounts this content; the host moves into the new slot.
    return (
      <>
        {renderWindow(
          <div
            ref={onRootMount}
            data-terminal-content
            className="terminal-content runner-terminal nodrag nopan relative flex min-h-0 flex-1 flex-col"
            data-locked={locked || undefined}
          >
            <div
              ref={onSlot}
              className={`runner-slot flex min-h-0 flex-1 flex-col ${ending ? "mb-7" : ""}`}
            />
            {/* Room for the bar keeps the output clear of it, as far above it as the
                surface's own padding. */}
            <TerminalEndingBar
              ending={ending}
              paused={locked}
              onRestart={() => {
                handle?.restart()
                // The button leaves with the bar; typing goes on in the fresh shell.
                handle?.focus()
              }}
            />
            {notice && (
              <div
                aria-hidden
                data-paste-notice
                className="runner-paste pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3"
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
  return RunnerTerminal
}
