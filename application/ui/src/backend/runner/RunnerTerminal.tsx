import "./runner.css"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { endingText, terminalEnding } from "../../model/terminal-ending"
import { TerminalEndingBar, TerminalLock, TerminalNotice } from "../../ui-toolkit/TerminalStatus"
import type { TerminalSurfaceProps } from "../port"
import { restartable } from "./activity"
import type { SurfaceRuntime } from "./backend"
import { wantsWebgl } from "./renderers"
import { createScreens, type RunnerScreen, type Screens, type ScreenStream } from "./screens"

// Why typing is paused. A failed paste says why in the same notice.
const lockNotices = {
  connected: "Starting shell…",
  // A shell already running, whose screen is on its way.
  attaching: "Loading output…",
  reconnecting: "Reconnecting…",
  unavailable: "Runner offline",
} as const
// A lock this short, such as while a screen arrives, stays out of sight: the dimming
// and the label fade in only after a moment.

const quiet: ScreenStream = { live: false, resuming: false, waits: false }
const silent = (): null => null
const ignore = (): (() => void) => () => {}

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
    const [host, setHost] = useState(() => screens.host(terminalKey))
    const [screen, setScreen] = useState<RunnerScreen | null>(null)
    const root = useRef<HTMLDivElement | null>(null)
    const refitFrame = useRef<number | null>(null)
    const opening = useRef({ fontSize, name: terminal.name, view })
    const name = terminal.name
    // An exited or failed terminal waits for Enter, or its bar's Restart. The stream
    // reports an exit in order with the output, sometimes before the status does; the
    // status covers a shell that never started, with no stream to tell.
    const waiting = restartable(terminal)
    const ending = terminalEnding(terminal)
    const connection = useSyncExternalStore(
      runtime.connection.subscribe,
      runtime.connection.getSnapshot,
    )
    // Input is refused while the runner is away, and while a running or starting shell
    // has no stream to take it, as right after a reconnection or a restart.
    const { live, resuming, waits } = useSyncExternalStore(
      screen?.stream.subscribe ?? ignore,
      () => screen?.stream.getSnapshot() ?? quiet,
    )
    const locked = connection !== "connected" || (!waiting && !waits && !live)
    // Why a paste just failed, shown for a moment at the surface's top.
    const notice = useSyncExternalStore(
      screen?.notice.subscribe ?? ignore,
      screen?.notice.getSnapshot ?? silent,
    )

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
    // Places the host in this surface's slot, refitting it there and focusing it again
    // when it left its previous slot focused.
    const place = useCallback(
      (target: HTMLDivElement, current: RunnerScreen | null): void => {
        // The slot holds the host alone: one a screen opened again replaces the one before.
        if (host.parentElement !== target) target.replaceChildren(host)
        current?.followed.refit()
        if (refitFrame.current !== null) cancelAnimationFrame(refitFrame.current)
        refitFrame.current = requestAnimationFrame(() => {
          refitFrame.current = null
          if (host.isConnected) current?.followed.refit()
        })
        if (current?.refocus) {
          current.xterm.focus()
          current.refocus = false
        }
      },
      [host],
    )
    const onHostMount = useCallback(
      (element: HTMLDivElement | null): void => {
        if (!element) {
          if (screen && host.contains(document.activeElement)) screen.refocus = true
          return
        }
        place(element, screen)
      },
      [host, place, screen],
    )

    useLayoutEffect(() => {
      host.setAttribute("class", `runner-screen min-h-0 flex-1 ${ending ? "mb-7" : ""}`)
    }, [host, ending])

    useEffect(
      () => () => {
        if (refitFrame.current !== null) cancelAnimationFrame(refitFrame.current)
      },
      [],
    )

    // Whether this surface is mounted, for the cleanup below to tell an unmount from a
    // release; React cleans effects up in the order they are declared.
    const mounted = useRef(false)
    useEffect(() => {
      mounted.current = true
      return () => {
        mounted.current = false
      }
    }, [])

    // Takes the terminal's screen while this surface shows it: the first surface opens
    // it, later ones find it as the last one left it. A surface out of the person's sight
    // lets it go, staying mounted with the host's last drawing, and takes it again when it
    // is back; each acquire has the one release its cleanup makes.
    useEffect(() => {
      if (!onScreen) return
      const acquired = screens.acquire(terminalKey, {
        fontSize: opening.current.fontSize,
        name: opening.current.name,
        waiting: restartable(terminal),
        webgl: wantsWebgl(opening.current.view),
      })
      setScreen(acquired)
      // A screen closed between this surface's render and now, as the parked-screen cap can,
      // opened again in a host of its own: the surface places that one.
      setHost(acquired.host)
      return () => {
        // Focus the next surface to show this screen restores is the unmount's to leave: a
        // surface that stays mounted and lets go of its screen out of sight keeps its host,
        // and takes the screen again in the same slot.
        if (!mounted.current && acquired.host.contains(document.activeElement))
          acquired.refocus = true
        screens.release(terminalKey)
      }
      // The screen follows the terminal, not its changing metadata.
      // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [terminalKey, onScreen])

    useEffect(() => {
      if (screen) screen.waiting = waiting
    }, [screen, waiting])

    // A view that changes under a mounted surface changes how its screen draws.
    useEffect(() => {
      screen?.renderer.take(wantsWebgl(view))
    }, [screen, view])

    // While the runner is away, keys are refused where the person can see it.
    useEffect(() => {
      if (!screen) return
      screen.xterm.options.disableStdin = locked
      screen.xterm.textarea?.setAttribute("aria-disabled", String(locked))
    }, [screen, locked])

    useEffect(() => {
      if (!screen || screen.xterm.options.fontSize === fontSize) return
      screen.xterm.options.fontSize = fontSize
      screen.followed.refit()
    }, [screen, fontSize])

    useEffect(() => {
      screen?.xterm.textarea?.setAttribute("aria-label", `Input for ${name}`)
    }, [screen, name])

    useEffect(() => {
      if (!focusInput || !screen) return
      screen.xterm.focus()
      onInputFocused()
    }, [screen, focusInput, onInputFocused])

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
            <div ref={onHostMount} className="flex min-h-0 flex-1 flex-col" />
            {/* Room for the bar keeps the output clear of it, as far above it as the
                surface's own padding. */}
            <TerminalEndingBar
              ending={ending}
              paused={locked}
              onRestart={() => {
                screen?.restart()
                // The button leaves with the bar; typing goes on in the fresh shell.
                screen?.xterm.focus()
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
            {locked && (
              <TerminalLock
                notice={
                  lockNotices[
                    connection === "connected" && resuming
                      ? "reconnecting"
                      : connection === "connected" && terminal.state !== "starting"
                        ? "attaching"
                        : connection
                  ]
                }
              />
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
        {/* A failed paste, announced the same way. */}
        <span aria-live="polite" aria-atomic className="sr-only">
          {notice ?? ""}
        </span>
      </>
    )
  }
  return RunnerTerminal
}
