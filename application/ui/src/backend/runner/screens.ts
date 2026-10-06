import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"

import { createStore, type Store } from "../../model/store"
import { themeChangeEvent } from "../../theme/apply"
import { tokenColors } from "../../theme/probe"
import type { TerminalKey } from "../port"
import type { SurfaceRuntime } from "./backend"
import { desktopHost } from "./desktop-host"
import { followTerminal, type FollowedTerminal, type Screen } from "./follow"
import { linkTerminal } from "./links"
import { clipboardAccess, takeCtrlV, takeFilePastes, type PasteTarget } from "./paste"
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
// How long a notice of a failed paste stays.
export const pasteNoticeMs = 4_000

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
  // Why the last paste failed, for a few seconds after it did.
  readonly notice: Store<string | null>
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

// How often a screen nobody shows checks whether to go: often enough for the next view
// to take it, or for a view whose code is loading to arrive, to find it ready.
const releaseCheckMs = 1000
// How long a screen stays once its session leaves the screen, so going back to a session or
// a project within a working break finds its output in place instead of a screen to reopen.
const retainMs = 30 * 60 * 1000

const id = ({ projectId, workspaceSessionId, terminalId }: TerminalKey): string =>
  `${projectId}\u0000${workspaceSessionId}\u0000${terminalId}`

// The screens of one backend's terminals. A surface acquires its terminal's screen
// while it shows it and releases it after. A released screen stays while its terminal
// exists, so the other views, and later the other sessions and projects, find it ready; it
// closes once its terminal does, or its session has stayed off screen for `retainMs`.
export const createScreens = (runtime: SurfaceRuntime) => {
  const entries = new Map<string, Entry>()
  // Whether Ctrl+V may read the clipboard, the same for every terminal.
  const readable = clipboardAccess(desktopHost() !== undefined)
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
    const notice = createStore<string | null>(null)
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
      notice,
      waiting,
      restart: () => {
        // Locked until the fresh shell's screen arrives.
        stream.update((state) => ({ ...state, waits: false }))
        runtime.restart(key)
      },
      refocus: false,
    }
    // Whether the shell takes input; one that exited or failed to start only listens for
    // Enter, to start again.
    const taking = (): boolean => !screen.waiting && !stream.getSnapshot().waits
    const deliver = (data: string): void => {
      if (taking()) return followed.input(data)
      if (data.includes("\r")) screen.restart()
    }
    // Input held while Ctrl+V reads the clipboard, and whether a paste goes ahead of it.
    let held: string[] | undefined
    let ahead = false
    const send = (data: string): void => {
      if (held && !ahead) held.push(data)
      else deliver(data)
    }
    const input = xterm.onData(send)
    // Some mouse reports arrive as binary; they go to the shell the same way.
    const binary = xterm.onBinary(send)
    // Pasted files go in as their paths on the runner's machine, as a bracketed paste. An
    // upload that ends after the screen is gone pastes and tells nothing.
    let noticed: ReturnType<typeof setTimeout> | undefined
    let gone = false
    const target: PasteTarget = {
      upload: (file) => runtime.upload(key.terminalId, file),
      // The desktop app's runner is on this machine, so a copied file's own path names it.
      pathOf: desktopHost()?.pathForFile,
      paste: (text) => {
        if (!gone) xterm.paste(text)
      },
      failed: (text) => {
        if (gone) return
        notice.update(() => text)
        clearTimeout(noticed)
        noticed = setTimeout(() => notice.update(() => null), pasteNoticeMs)
      },
    }
    const pastes = takeFilePastes(element, target)
    // Ctrl+V on Linux and Windows pastes a clipboard of images too; what is typed while it
    // looks waits behind it.
    takeCtrlV(
      xterm,
      {
        ...target,
        paste: (text) => {
          ahead = true
          try {
            target.paste(text)
          } finally {
            ahead = false
          }
        },
        active: () => taking() && !xterm.options.disableStdin,
        hold: () => {
          held = []
          return (controlV) => {
            const queued = held ?? []
            held = undefined
            if (gone) return
            // As typed, so it scrolls to the prompt, and is dropped while typing is locked.
            if (controlV) xterm.input("\u0016", true)
            queued.forEach(deliver)
          }
        },
      },
      { readable },
    )
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
      gone = true
      pastes()
      clearTimeout(noticed)
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
  // A screen nobody shows goes once its terminal closes, or once its session has been off
  // screen for `retainMs` of the clock's time, which timers falling behind in a hidden
  // window or a sleeping machine do not stretch; until then it waits, checking now and then.
  const settle = (key: TerminalKey, entry: Entry, offSince?: number): void => {
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.users > 0) return
      const terminal = runtime.entry(key)
      if (!terminal || terminal.closed) return close(key, entry)
      if (runtime.shown(key)) return settle(key, entry)
      const since = offSince ?? Date.now()
      if (Date.now() - since >= retainMs) close(key, entry)
      else settle(key, entry, since)
    }, releaseCheckMs)
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
    // Pastes text into the terminal's screen as the person's own paste: bracketed when its
    // program asked for that, and never followed by Enter. Dictation targets a terminal the
    // person is looking at, so a terminal with no open screen has nothing to type into and
    // gets nothing: opening a second attachment to write behind a screen that is not there,
    // for a paste with no brackets, would run the text as typed commands. Says whether it
    // pasted. Line breaks and other control characters become spaces first: outside
    // bracketed paste xterm turns a newline into Enter, which would submit what was said.
    typeInto: (key: TerminalKey, text: string): boolean => {
      const screen = entries.get(id(key))?.screen
      if (!screen) return false
      // oxlint-disable-next-line no-control-regex -- Control characters are what this removes.
      const plain = text.replaceAll(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim()
      if (!plain) return false
      // Dictating twice in a row, or after typing a word, would run the words together.
      const buffer = screen.xterm.buffer.active
      const before = buffer
        .getLine(buffer.baseY + buffer.cursorY)
        ?.getCell(buffer.cursorX - 1)
        ?.getChars()
      screen.xterm.paste(before && before.trim() ? ` ${plain}` : plain)
      return true
    },
  }
}

export type Screens = ReturnType<typeof createScreens>
