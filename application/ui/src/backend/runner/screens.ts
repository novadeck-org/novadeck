import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"

import { createStore, type Store } from "../../model/store"
import { themeChangeEvent } from "../../theme/apply"
import { tokenColors } from "../../theme/probe"
import type { TerminalKey } from "../port"
import type { SurfaceRuntime } from "./backend"
import { followTerminal, type FollowedTerminal, type Screen } from "./follow"
import { linkTerminal } from "./links"
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

const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const
type AnsiName = (typeof ansi)[number]
const ansiKey = (name: AnsiName, bright: boolean): keyof ITheme =>
  bright ? (`bright${name[0]!.toUpperCase()}${name.slice(1)}` as keyof ITheme) : name
const terminalTokens = [
  "--terminal-bg",
  "--terminal-fg",
  "--terminal-cursor",
  "--terminal-selection",
  ...ansi.flatMap((name) => [`--terminal-ansi-${name}`, `--terminal-ansi-${name}-bright`]),
  // The scrollbar matches the app's own: a line-grey thumb that darkens when used.
  "--color-line",
  "--color-line-strong",
  "--color-muted",
]

// Where a terminal's tokens resolve: where it draws, so a theme that restyles a region
// reaches it, or the page's body while it has no place yet.
const scopeOf = (element: Element): Element =>
  element.isConnected ? element : element.ownerDocument.body

// The theme's terminal tokens as the emulator's colours.
const themeOf = (element: Element): ITheme => {
  const colors: Partial<Record<string, string>> = tokenColors(scopeOf(element), terminalTokens)
  const entries: [keyof ITheme, string | undefined][] = [
    ["background", colors["--terminal-bg"]],
    ["foreground", colors["--terminal-fg"]],
    ["cursor", colors["--terminal-cursor"]],
    ["cursorAccent", colors["--terminal-bg"]],
    ["selectionBackground", colors["--terminal-selection"]],
    ...ansi.flatMap((name): [keyof ITheme, string | undefined][] => [
      [ansiKey(name, false), colors[`--terminal-ansi-${name}`]],
      [ansiKey(name, true), colors[`--terminal-ansi-${name}-bright`]],
    ]),
    ["scrollbarSliderBackground", colors["--color-line"]],
    ["scrollbarSliderHoverBackground", colors["--color-line-strong"]],
    ["scrollbarSliderActiveBackground", colors["--color-muted"]],
  ]
  return Object.fromEntries(entries.filter(([, color]) => color !== undefined))
}

// The theme's monospace font.
const monospace = (element: Element): string =>
  getComputedStyle(scopeOf(element)).getPropertyValue("--font-mono").trim() || "monospace"

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
    linkTerminal(xterm)
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
    // A theme sets the colours and the font; a new font changes the cell size, so the
    // terminal fits again.
    const retheme = (): void => {
      xterm.options.theme = themeOf(element)
      const font = monospace(element)
      if (xterm.options.fontFamily === font) return
      xterm.options.fontFamily = font
      followed.refit()
    }
    // A host opened before it had a slot took the page's colours and font; once in one,
    // it takes its region's.
    let placed = element.isConnected
    const resizes = new ResizeObserver(() => {
      if (!placed && element.isConnected) {
        placed = true
        retheme()
      }
      clearTimeout(settling)
      settling = setTimeout(() => followed.refit(), resizeSettleMs)
    })
    resizes.observe(element)
    window.addEventListener(themeChangeEvent, retheme)
    runtime.screen(key, "mounted")
    entry.dispose = () => {
      runtime.screen(key, "gone")
      window.removeEventListener(themeChangeEvent, retheme)
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
