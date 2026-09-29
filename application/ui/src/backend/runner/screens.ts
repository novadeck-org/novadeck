import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"

import { createStore, type Store } from "../../model/store"
import type { TerminalKey } from "../port"
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
  const selection = token(style, "--color-selection")
  // The scrollbar matches the app's own: a line-grey thumb that darkens when used.
  const slider = token(style, "--color-line")
  const sliderHover = token(style, "--color-line-strong")
  const sliderActive = token(style, "--color-muted")
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { foreground, cursor: foreground } : {}),
    ...(background ? { cursorAccent: background } : {}),
    ...(selection ? { selectionBackground: selection } : {}),
    ...(slider ? { scrollbarSliderBackground: slider } : {}),
    ...(sliderHover ? { scrollbarSliderHoverBackground: sliderHover } : {}),
    ...(sliderActive ? { scrollbarSliderActiveBackground: sliderActive } : {}),
  }
}

const monospace = (element: Element): string =>
  token(getComputedStyle(element), "--font-mono") ?? "monospace"

const darkScheme = "(prefers-color-scheme: dark)"

// How long a terminal's size stays still before it refits after a resize. Each refit
// forces a layout and may tell the runner, so a zoom or a drag refits once it pauses,
// not on every frame across dozens of terminals.
const resizeSettleMs = 120

// Whether a stream draws the terminal now, and whether its shell waits for Enter.
export type ScreenStream = {
  // A stream draws the current shell; input goes nowhere until one does.
  readonly live: boolean
  // The stream is taking up again after a reconnection.
  readonly resuming: boolean
  // The stream told of an exit before the status did; Enter restarts from then on.
  readonly waits: boolean
}

// One terminal's emulator and its attachment to the runner, outliving the surfaces that
// show it: switching views moves its host into the next surface instead of opening a
// new emulator and attaching again.
export type RunnerScreen = {
  // The element the emulator draws in; a surface moves it into its own slot.
  readonly host: HTMLDivElement
  readonly xterm: Terminal
  readonly followed: FollowedTerminal
  readonly stream: Store<ScreenStream>
  // Whether the terminal's status waits for Enter, as the surface last rendered it.
  waiting: boolean
  // Starts a fresh shell, as Enter or the Restart button asks.
  readonly restart: () => void
  // Set when the host leaves a slot while focused, so the next slot focuses it again.
  refocus: boolean
}

type OpenOptions = { fontSize: number; name: string; waiting: boolean }

type Entry = {
  readonly host: HTMLDivElement
  screen?: RunnerScreen
  dispose?: () => void
  users: number
  timer?: ReturnType<typeof setTimeout> | undefined
}

// How long a screen nobody shows waits before it checks whether to go: long enough
// for the next view to take it, or for a view whose code is loading to arrive.
const releaseDelayMs = 1000

const id = ({ projectId, workspaceSessionId, terminalId }: TerminalKey): string =>
  `${projectId}\u0000${workspaceSessionId}\u0000${terminalId}`

// The screens of one backend's terminals. A surface acquires its terminal's screen
// while it shows it and releases it after. A released screen stays while its session is
// on screen and the terminal exists, so the other views find it ready; otherwise it
// closes once nobody took it back.
export const createScreens = (runtime: SurfaceRuntime) => {
  const entries = new Map<string, Entry>()
  const entryOf = (key: TerminalKey): Entry => {
    const known = entries.get(id(key))
    if (known) return known
    const created: Entry = { host: document.createElement("div"), users: 0 }
    entries.set(id(key), created)
    return created
  }

  const open = (
    key: TerminalKey,
    entry: Entry,
    { fontSize, name, waiting }: OpenOptions,
  ): RunnerScreen => {
    const element = entry.host
    const xterm = new Terminal({
      fontSize,
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
    xterm.textarea?.setAttribute("aria-label", `Input for ${name}`)
    const stream = createStore<ScreenStream>({ live: false, resuming: false, waits: false })
    const drawn: Screen = {
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
    const followed = followTerminal(runtime, key, {
      ...drawn,
      reset: () => {
        stream.update((state) => ({ ...state, waits: false }))
        drawn.reset()
      },
      exited: (waits) => stream.update((state) => ({ ...state, waits })),
      live: (live, resuming = false) => stream.update((state) => ({ ...state, live, resuming })),
    })
    const screen: RunnerScreen = {
      host: element,
      xterm,
      followed,
      stream,
      waiting,
      restart: () => {
        // Locked until the fresh shell's screen arrives.
        stream.update((state) => ({ ...state, waits: false }))
        runtime.restart(key)
      },
      refocus: false,
    }
    const send = (data: string): void => {
      // A shell that exited or failed to start only listens for Enter, to start again.
      if (!screen.waiting && !stream.getSnapshot().waits) return followed.input(data)
      if (data.includes("\r")) screen.restart()
    }
    const input = xterm.onData(send)
    // Some mouse reports arrive as binary; they go to the shell the same way.
    const binary = xterm.onBinary(send)
    let settling: ReturnType<typeof setTimeout> | undefined
    const resizes = new ResizeObserver(() => {
      clearTimeout(settling)
      settling = setTimeout(() => followed.refit(), resizeSettleMs)
    })
    resizes.observe(element)
    const scheme = window.matchMedia?.(darkScheme)
    const retheme = (): void => {
      xterm.options.theme = themeOf(element)
    }
    scheme?.addEventListener("change", retheme)
    runtime.screen(key, "mounted")
    entry.dispose = () => {
      runtime.screen(key, "gone")
      scheme?.removeEventListener("change", retheme)
      clearTimeout(settling)
      resizes.disconnect()
      input.dispose()
      binary.dispose()
      queries.dispose()
      followed.stop()
      xterm.dispose()
      element.remove()
    }
    return screen
  }

  const close = (key: TerminalKey, entry: Entry): void => {
    entries.delete(id(key))
    entry.dispose?.()
  }
  // A screen nobody shows goes once its session leaves the screen or the terminal
  // closes; until then it waits, checking again now and then.
  const settle = (key: TerminalKey, entry: Entry): void => {
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.users > 0) return
      if (runtime.shown(key)) settle(key, entry)
      else close(key, entry)
    }, releaseDelayMs)
  }

  return {
    // The host a surface places in its slot, the same element for the terminal's life.
    host: (key: TerminalKey): HTMLDivElement => entryOf(key).host,
    // The terminal's screen for a surface that shows it, opened on first use.
    acquire: (key: TerminalKey, options: OpenOptions): RunnerScreen => {
      const entry = entryOf(key)
      entry.users += 1
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.timer = undefined
      entry.screen ??= open(key, entry, options)
      return entry.screen
    },
    release: (key: TerminalKey): void => {
      const entry = entries.get(id(key))
      if (!entry) return
      entry.users -= 1
      if (entry.users === 0 && entry.timer === undefined) settle(key, entry)
    },
  }
}

export type Screens = ReturnType<typeof createScreens>
