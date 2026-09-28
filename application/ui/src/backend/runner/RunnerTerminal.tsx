import "@xterm/xterm/css/xterm.css"
import "./runner.css"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { endingText, terminalEnding, type TerminalEnding } from "../../model/terminal-ending"
import type { TerminalSurfaceProps } from "../port"
import { restartable } from "./activity"
import type { SurfaceRuntime } from "./backend"
import { followTerminal, type FollowedTerminal, type Screen } from "./follow"
import { silenceQueries } from "./queries"

// The sizes the runner accepts.
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)))
export const runnerSize = (size: {
  readonly cols: number
  readonly rows: number
}): { readonly cols: number; readonly rows: number } => ({
  cols: clamp(size.cols, 2, 500),
  rows: clamp(size.rows, 1, 200),
})

const token = (style: CSSStyleDeclaration, name: string): string | undefined =>
  style.getPropertyValue(name).trim() || undefined

// The app's colour tokens, read from the page so a theme change reaches the terminal.
const themeOf = (element: Element): ITheme => {
  const style = getComputedStyle(element)
  const background = token(style, "--color-paper")
  const foreground = token(style, "--color-ink")
  const selection = token(style, "--color-line-strong")
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { foreground, cursor: foreground } : {}),
    ...(background ? { cursorAccent: background } : {}),
    ...(selection ? { selectionBackground: selection } : {}),
  }
}

const monospace = (element: Element): string =>
  token(getComputedStyle(element), "--font-mono") ?? "monospace"

const darkScheme = "(prefers-color-scheme: dark)"
// Why typing is paused, set in capitals by CSS so assistive technology reads words.
const lockNotices = {
  connected: "Starting shell…",
  reconnecting: "Reconnecting…",
  unavailable: "Runner offline",
} as const
// A lock this short, such as while a screen arrives, stays out of sight: the dimming
// and the label fade in only after a moment.

const LockNotice = ({ notice }: { readonly notice: string }): React.JSX.Element => (
  <span className="rounded-control border border-line bg-paper px-3.5 py-2 text-[11px] font-bold tracking-wider text-ink uppercase shadow-floating">
    {notice}
  </span>
)

// Whole class strings, so Tailwind finds them: the footer's tints, a top border of the
// same hue, and a focus ring in it.
const endingTones: Record<TerminalEnding["tone"], string> = {
  danger: "border-danger-fg/20 bg-danger text-danger-fg [--ending-ring:var(--color-danger-fg)]",
  warning:
    "border-warning-fg/20 bg-warning text-warning-fg [--ending-ring:var(--color-warning-fg)]",
}

// How the shell ended, along the surface's bottom edge, with the restart Enter also
// asks for. In Canvas its right end follows the resize grip's scale so the button stays
// clear of it (runner.css). Restart waits while typing is paused, as a restart then
// could not reach the runner. It keeps the last ending on screen while it slides away;
// the surface announces it.
const EndingBar = ({
  ending,
  paused,
  onRestart,
}: {
  readonly ending: TerminalEnding | null
  readonly paused: boolean
  readonly onRestart: () => void
}): React.JSX.Element => {
  const [shown, setShown] = useState(ending)
  const text = shown ? endingText(shown) : ""
  // Each render derives a fresh ending; only a different one replaces the shown one.
  if (ending && (ending.tone !== shown?.tone || endingText(ending) !== text)) setShown(ending)
  return (
    <div
      className={`runner-ending absolute inset-x-0 bottom-0 flex h-7 items-center justify-between gap-3 border-t pr-6 pl-3 text-[10px] transition-[opacity,translate] duration-(--motion-state) ease-interface ${shown ? endingTones[shown.tone] : ""} ${ending ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0"}`}
      inert={!ending}
      data-terminal-ending={ending?.tone}
    >
      <span
        className="min-w-0 truncate font-bold tracking-wider uppercase"
        title={text || undefined}
      >
        {text}
      </span>
      {shown && (
        <button
          type="button"
          aria-disabled={paused || undefined}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-control px-1.5 py-0.5 font-bold tracking-wider uppercase underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--ending-ring) aria-disabled:cursor-default aria-disabled:no-underline aria-disabled:opacity-50"
          onClick={() => {
            if (!paused) onRestart()
          }}
        >
          Restart
          <span aria-hidden className="font-normal opacity-60">
            ↵
          </span>
        </button>
      )}
    </div>
  )
}

// One component per backend, so its identity stays stable while the backend lives.
export const createRunnerTerminal = (runtime: SurfaceRuntime) => {
  const RunnerTerminal = ({
    terminalKey,
    terminal,
    fontSize,
    minimized,
    clipContent,
    focusInput,
    onInputFocused,
    renderWindow,
  }: TerminalSurfaceProps): React.JSX.Element => {
    // React owns each surface's mount slot; the runner owns this one emulator host.
    // Moving the host preserves its textarea, screen, selection, and PTY attachment.
    const host = useMemo(() => document.createElement("div"), [])
    const root = useRef<HTMLDivElement | null>(null)
    const wasFocused = useRef(false)
    const refitFrame = useRef<number | null>(null)
    const view = useRef<{ xterm: Terminal; followed: FollowedTerminal | undefined }>(null)
    const initialFont = useRef(fontSize)
    const name = terminal.name
    const initialName = useRef(name)
    // An exited or failed terminal waits for Enter, or its bar's Restart. The stream
    // reports an exit in order with the output, sometimes before the status does; the
    // status covers a shell that never started, with no stream to tell.
    const waiting = restartable(terminal)
    const ending = terminalEnding(terminal)
    const restart = useRef({ status: waiting, stream: false, run: () => {} })
    const connection = useSyncExternalStore(
      runtime.connection.subscribe,
      runtime.connection.getSnapshot,
    )
    // Input is refused while the runner is away, and while a running or starting shell
    // has no stream to take it, as right after a reconnection or a restart.
    const [live, setLive] = useState(false)
    const [resuming, setResuming] = useState(false)
    // The stream can tell of an exit before the status does; Enter works from then on.
    const [streamWaits, setStreamWaits] = useState(false)
    const locked = connection !== "connected" || (!waiting && !streamWaits && !live)

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
    const onHostMount = useCallback(
      (element: HTMLDivElement | null): void => {
        if (!element) {
          if (host.contains(document.activeElement)) wasFocused.current = true
          return
        }
        element.append(host)
        view.current?.followed?.refit()
        if (refitFrame.current !== null) cancelAnimationFrame(refitFrame.current)
        refitFrame.current = requestAnimationFrame(() => {
          refitFrame.current = null
          if (host.isConnected) view.current?.followed?.refit()
        })
        if (wasFocused.current) {
          view.current?.xterm.focus()
          wasFocused.current = false
        }
      },
      [host],
    )

    useLayoutEffect(() => {
      host.setAttribute(
        "class",
        `min-h-0 flex-1 transition-[filter,margin-bottom] duration-(--motion-state) ease-interface ${locked ? "grayscale delay-200" : ""} ${ending ? "mb-7" : ""}`,
      )
    }, [host, locked, ending])

    useEffect(
      () => () => {
        if (refitFrame.current !== null) cancelAnimationFrame(refitFrame.current)
      },
      [],
    )

    useEffect(() => {
      const element = host
      const xterm = new Terminal({
        fontSize: initialFont.current,
        fontFamily: monospace(element),
        theme: themeOf(element),
        scrollback: 1000,
        allowTransparency: false,
      })
      const fit = new FitAddon()
      xterm.loadAddon(fit)
      xterm.open(element)
      const queries = silenceQueries(xterm)
      xterm.textarea?.setAttribute("data-terminal-input", "")
      xterm.textarea?.setAttribute("aria-label", `Input for ${initialName.current}`)
      const screen: Screen = {
        exited: () => {},
        live: () => {},
        write: (data) => new Promise((resolve) => xterm.write(data, resolve)),
        reset: () => xterm.reset(),
        resize: ({ cols, rows }) => {
          if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
        },
        fit: () => {
          if (!element.clientWidth || !element.clientHeight) return undefined
          const size = fit.proposeDimensions()
          return size && Number.isFinite(size.cols) && Number.isFinite(size.rows)
            ? runnerSize(size)
            : undefined
        },
      }
      const hint = restart.current
      hint.stream = false
      const followed = followTerminal(runtime, terminalKey, {
        ...screen,
        reset: () => {
          hint.stream = false
          setStreamWaits(false)
          screen.reset()
        },
        exited: (waits) => {
          hint.stream = waits
          setStreamWaits(waits)
        },
        live: (next, resumingNow = false) => {
          setLive(next)
          setResuming(resumingNow)
        },
      })
      hint.run = () => {
        // Locked until the fresh shell's screen arrives.
        hint.stream = false
        setStreamWaits(false)
        runtime.restart(terminalKey)
      }
      const send = (data: string): void => {
        // A shell that exited or failed to start only listens for Enter, to start again.
        if (!hint.status && !hint.stream) return followed.input(data)
        if (data.includes("\r")) hint.run()
      }
      const input = xterm.onData(send)
      // Some mouse reports arrive as binary; they go to the shell the same way.
      const binary = xterm.onBinary(send)
      const resizes = new ResizeObserver(() => followed.refit())
      resizes.observe(element)
      const scheme = window.matchMedia?.(darkScheme)
      const retheme = (): void => {
        xterm.options.theme = themeOf(element)
      }
      scheme?.addEventListener("change", retheme)
      view.current = { xterm, followed }
      runtime.screen(terminalKey, "mounted")
      return () => {
        runtime.screen(terminalKey, "gone")
        view.current = null
        scheme?.removeEventListener("change", retheme)
        resizes.disconnect()
        input.dispose()
        binary.dispose()
        queries.dispose()
        followed.stop()
        xterm.dispose()
      }
    }, [terminalKey, host])

    useEffect(() => {
      const hint = restart.current
      hint.status = waiting
      if (!waiting) hint.stream = false
    }, [waiting])

    // While the runner is away, keys are refused where the person can see it.
    useEffect(() => {
      const current = view.current
      if (!current) return
      current.xterm.options.disableStdin = locked
      current.xterm.textarea?.setAttribute("aria-disabled", String(locked))
    }, [locked])

    useEffect(() => {
      const current = view.current
      if (!current || current.xterm.options.fontSize === fontSize) return
      current.xterm.options.fontSize = fontSize
      current.followed?.refit()
    }, [fontSize])

    useEffect(() => {
      view.current?.xterm.textarea?.setAttribute("aria-label", `Input for ${name}`)
    }, [name])

    useEffect(() => {
      if (!focusInput || !view.current) return
      view.current.xterm.focus()
      onInputFocused()
    }, [focusInput, onInputFocused])

    // A different program body remounts this content; the host moves into the new slot.
    return (
      <>
        {renderWindow(
          <div
            ref={onRootMount}
            data-terminal-content
            className="terminal-content runner-terminal nodrag nopan relative flex min-h-0 flex-1 flex-col p-3"
            hidden={minimized && !clipContent}
            aria-hidden={minimized}
            inert={minimized}
            data-locked={locked || undefined}
          >
            <div ref={onHostMount} className="flex min-h-0 flex-1 flex-col" />
            {/* Room for the bar keeps the output clear of it, as far above it as the
                surface's own padding. */}
            <EndingBar
              ending={ending}
              paused={locked}
              onRestart={() => {
                restart.current.run()
                // The button leaves with the bar; typing goes on in the fresh shell.
                view.current?.xterm.focus()
              }}
            />
            {locked && (
              <div
                role="status"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-canvas/80 transition-opacity delay-200 duration-(--motion-state) ease-interface starting:opacity-0"
              >
                <LockNotice
                  notice={
                    lockNotices[
                      connection === "connected" && resuming ? "reconnecting" : connection
                    ]
                  }
                />
              </div>
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
      </>
    )
  }
  return RunnerTerminal
}
