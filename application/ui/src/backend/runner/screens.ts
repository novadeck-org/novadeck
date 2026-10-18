import {
  createView,
  type ITheme,
  type Renderers,
  type ViewRenderer,
  type Terminal,
} from "@novadeck/emulator/browser"

import { createStore, type MutableStore, type Store } from "#core/store"

import { themeChangeEvent } from "../../theme/apply"
import { tokenColors } from "../../theme/probe"
import type { TerminalFont, TerminalKey } from "../port"
import type { SurfaceRuntime } from "./backend"
import { desktopHost } from "./desktop-host"
import { followTerminal, type FollowedTerminal, type Screen } from "./follow"
import { linkOptions } from "./links"
import { clipboardAccess, takeCtrlV, takeFilePastes, type PasteTarget } from "./paste"
import { silenceQueries } from "./queries"
import { pageRenderers } from "./renderers"
import {
  nextViewState,
  openingState,
  type ViewChange,
  type ViewPhase,
  type ViewState,
} from "./view-state"

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

// One terminal's emulator and its attachment to the runner, outliving the mounts that
// show it: switching views moves its host into the next mount's element instead of opening
// a new emulator and attaching again.
type RunnerScreen = {
  // The element the emulator draws in; a mount moves it into its own element.
  readonly host: HTMLDivElement
  readonly xterm: Terminal
  readonly followed: FollowedTerminal
  // Which renderer draws it: WebGL while shown where its view wants it and a context is
  // free, else the DOM one.
  readonly renderer: ViewRenderer
  // What the person is told of it, and why typing is refused.
  readonly state: MutableStore<ViewState>
  // Applies a change to the state, and the lock it brings to the emulator's input.
  readonly refresh: (change?: ViewChange) => void
  // The input's accessible name, as last written.
  label: string
  // The shell's stage, as the mount last said.
  phase: ViewPhase
  // Starts a fresh shell, as Enter or the Restart button asks.
  readonly restart: () => void
  // Set when a mount goes while focused, so the next to show this screen focuses it again.
  refocus: boolean
}

// What a mount opens a screen with: the input's accessible name and the shell's stage, and
// whether its view wants WebGL.
export type ShowOptions = {
  readonly label: string
  readonly phase: ViewPhase
  readonly webgl: boolean
}

// A mount's hold on a terminal's screen, from `acquire` to `release`.
export type ScreenHandle = {
  // This screen's state; it is the same store for as long as the screen stays open.
  readonly state: Store<ViewState>
  // Puts the screen in `element`, which holds nothing else, and fits it there now and on
  // the next frame. Focuses it again when a mount before this one left it focused.
  readonly place: (element: HTMLElement) => void
  // Changes what differs; equal values write nothing.
  readonly update: (change: {
    readonly label?: string
    readonly phase?: ViewPhase
    readonly webgl?: boolean
  }) => void
  // Focuses the input, and says whether the focus landed in the screen.
  readonly focus: () => boolean
  // Starts a fresh shell in an ended terminal.
  readonly restart: () => void
  // Lets the screen go, once. With `unmount`, focus the screen holds is left for the next
  // mount to restore; without it (out of sight, staying mounted) none is.
  readonly release: (options?: { readonly unmount?: boolean }) => void
}

type Entry = {
  readonly host: HTMLDivElement
  screen?: RunnerScreen
  dispose?: () => void
  users: number
  // The connection's changes reach the screen while it has users.
  unwatch?: (() => void) | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
  parking?: ReturnType<typeof setTimeout> | undefined
}

// The size screens open in until the app says: Preferences' own default.
const defaultFontSize = 13

// How often a screen nobody shows checks whether to go: often enough for the next view
// to take it, or for a view whose code is loading to arrive, to find it ready.
const releaseCheckMs = 1000
// How long a screen stays once its session leaves the screen, so going back to a session or
// a project within a working break finds its output in place instead of a screen to reopen.
export const retainMs = 30 * 60 * 1000
// How long a screen nobody shows keeps following its terminal's output before it parks:
// long enough for the next view to take it as it is, short enough that a dozen busy agents
// out of sight cost nothing to draw. Shown again, it takes the runner's screen as it is then.
export const parkMs = 5_000
// How many parked screens stay before the one parked longest closes. Each holds its emulator's
// buffer, so without a count a long session's grows without bound. With 16, a Grid of up to 16
// terminals finds every screen still parked, not closed, after a trip to another session or
// view; a bigger one loses those parked first. Fewer would close some of a common Grid's, and
// a closed screen costs a full snapshot resync when it is shown again.
export const parkedCap = 16

// Names the screen's input, writing only when the name changes.
const writeLabel = (screen: RunnerScreen, label: string): void => {
  if (screen.label === label) return
  screen.label = label
  screen.xterm.textarea?.setAttribute("aria-label", label)
}

const id = ({ projectId, workspaceSessionId, terminalId }: TerminalKey): string =>
  `${projectId}\u0000${workspaceSessionId}\u0000${terminalId}`

// The screens of one backend's terminals. A surface acquires its terminal's screen
// while it shows it and releases it after. A released screen stays while its terminal
// exists, so the other views, and later the other sessions and projects, find it ready; it
// closes once its terminal does, its session has stayed off screen for `retainMs`, or more than
// `cap` screens are parked and it was parked longest.
export const createScreens = (
  runtime: SurfaceRuntime,
  renderers: Renderers = pageRenderers(),
  cap = parkedCap,
) => {
  const entries = new Map<string, Entry>()
  // The parked screens, the one parked longest first: a map keeps the order its keys were
  // added in, so a screen shown again leaves it and parking it again puts it last.
  const parked = new Map<string, { key: TerminalKey; entry: Entry }>()
  // Whether Ctrl+V may read the clipboard, the same for every terminal.
  const readable = clipboardAccess(desktopHost() !== undefined)
  // The font the app last asked for, which a screen opens in and is brought to.
  let font: TerminalFont = { size: defaultFontSize }
  const entryOf = (key: TerminalKey): Entry => {
    const known = entries.get(id(key))
    if (known) return known
    const host = document.createElement("div")
    host.setAttribute("class", "runner-screen min-h-0 flex-1")
    const created: Entry = { host, users: 0 }
    entries.set(id(key), created)
    return created
  }

  const open = (
    key: TerminalKey,
    entry: Entry,
    { label, phase }: Omit<ShowOptions, "webgl">,
  ): RunnerScreen => {
    const element = entry.host
    const view = createView(element, {
      fontSize: font.size,
      fontFamily: monospace(element),
      theme: themeOf(element),
      // Programs and agents pick their own colours, often greys meant for another ground;
      // xterm darkens or lightens any that would read under 4.5:1 against the background.
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      links: linkOptions(),
      renderers,
    })
    const xterm = view.terminal
    const queries = silenceQueries(xterm)
    xterm.textarea?.setAttribute("data-terminal-input", "")
    xterm.textarea?.setAttribute("aria-label", label)
    const drawn: Screen = {
      exited: () => {},
      live: () => {},
      write: (data) => new Promise((resolve) => xterm.write(data, resolve)),
      reset: () => xterm.reset(),
      resize: ({ cols, rows }) => {
        if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
      },
      fit: () => {
        const size = view.fit()
        return size && runnerSize(size)
      },
    }
    // The state a person sees, with the lock recomputed in the same step as the change that
    // brings it, so each change notifies once. The emulator's input follows the lock.
    let stage = phase
    const facts = () => ({ link: runtime.connection.getSnapshot(), phase: stage })
    const state = createStore<ViewState>(openingState(facts()))
    let locked: boolean | undefined
    const refresh = (change: ViewChange = {}): void => {
      const { lock } = state.update((current) => nextViewState(current, change, facts()))
      if (locked === (lock !== null)) return
      locked = lock !== null
      xterm.options.disableStdin = locked
      xterm.textarea?.setAttribute("aria-disabled", String(locked))
    }
    const followed = followTerminal(runtime, key, {
      ...drawn,
      reset: () => {
        refresh({ waits: false })
        drawn.reset()
      },
      exited: (waits) => refresh({ waits }),
      live: (live, resuming = false) => refresh({ live, resuming }),
    })
    // The two renderers measure a cell apart (WebGL to whole device pixels), so a screen
    // that changes renderer fits its slot again.
    view.onRendererChange(() => followed.refit())
    const screen: RunnerScreen = {
      host: element,
      xterm,
      followed,
      renderer: view.renderer,
      state,
      refresh,
      label,
      get phase() {
        return stage
      },
      set phase(next) {
        stage = next
      },
      restart: () => {
        // Locked until the fresh shell's screen arrives.
        refresh({ waits: false })
        runtime.restart(key)
      },
      refocus: false,
    }
    refresh()
    // Whether the shell takes input; one that exited or failed to start only listens for
    // Enter, to start again.
    const taking = (): boolean => screen.phase !== "ended" && !state.getSnapshot().waits
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
        refresh({ notice: text })
        clearTimeout(noticed)
        noticed = setTimeout(() => refresh({ notice: null }), pasteNoticeMs)
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
    // The theme's font, once it has loaded: a bundled font still on its way arrives later,
    // and the terminal keeps the font it has until then. A new font changes the cell size,
    // so the terminal fits again.
    const takeFont = (): void => {
      void view.setFont(monospace(element)).then((measured) => {
        if (measured && !gone) followed.refit()
      })
    }
    // A theme sets the colours and the font.
    const retheme = (): void => {
      view.setTheme(themeOf(element))
      takeFont()
    }
    // A host opened before it had a slot took the page's colours and font; once in one,
    // it takes its region's.
    let placed = element.isConnected
    // Out of sight, as a view keeps a terminal it isn't showing, it has no size. Shown
    // again, it takes the size it has now at once, not after a pause.
    let sized = Boolean(element.clientWidth && element.clientHeight)
    const resizes = new ResizeObserver(() => {
      if (!placed && element.isConnected) {
        placed = true
        retheme()
      }
      const was = sized
      sized = Boolean(element.clientWidth && element.clientHeight)
      clearTimeout(settling)
      if (sized && !was) followed.refit()
      else settling = setTimeout(() => followed.refit(), resizeSettleMs)
    })
    resizes.observe(element)
    window.addEventListener(themeChangeEvent, retheme)
    // The terminal opened in its font whether it had loaded or not; one still on its way
    // is measured again once it arrives.
    takeFont()
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
      view.dispose()
      element.remove()
    }
    return screen
  }

  const close = (key: TerminalKey, entry: Entry): void => {
    entries.delete(id(key))
    parked.delete(id(key))
    clearTimeout(entry.timer)
    clearTimeout(entry.parking)
    entry.unwatch?.()
    entry.dispose?.()
  }
  // A screen that parks joins the parked; one more than the cap closes the one parked longest,
  // through the same path as retention. A screen shown or not yet parked never closes here.
  const keep = (key: TerminalKey, entry: Entry): void => {
    parked.set(id(key), { key, entry })
    for (const [, oldest] of parked) {
      if (parked.size <= cap) break
      close(oldest.key, oldest.entry)
    }
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

  // Takes one more hold on the terminal's screen, opening it on first use.
  const take = (key: TerminalKey, { webgl, ...options }: ShowOptions): RunnerScreen => {
    const entry = entryOf(key)
    entry.users += 1
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    clearTimeout(entry.parking)
    entry.parking = undefined
    parked.delete(id(key))
    const known = entry.screen
    const screen = (entry.screen ??= open(key, entry, options))
    // The connection reaches the screen while a mount holds it; what changed while none did
    // is read now.
    if (entry.users === 1) {
      entry.unwatch = runtime.connection.subscribe(() => screen.refresh())
    }
    if (known) {
      screen.phase = options.phase
      writeLabel(screen, options.label)
      screen.refresh()
    }
    screen.followed.unpark()
    screen.renderer.take(webgl)
    return screen
  }
  const letGo = (key: TerminalKey): void => {
    const entry = entries.get(id(key))
    if (!entry) return
    entry.users -= 1
    if (entry.users > 0) return
    entry.unwatch?.()
    entry.unwatch = undefined
    if (entry.timer === undefined) settle(key, entry)
    // Until it parks it keeps its context, which a shown screen may take meanwhile.
    entry.screen?.renderer.idle()
    clearTimeout(entry.parking)
    entry.parking = setTimeout(() => {
      entry.parking = undefined
      if (entry.users !== 0) return
      if (!entry.screen) return
      entry.screen.followed.park()
      entry.screen.renderer.release()
      keep(key, entry)
    }, parkMs)
  }

  return {
    // The terminal's screen for a mount that shows it, opened on first use. Each acquire has
    // the one release its handle makes.
    acquire: (key: TerminalKey, options: ShowOptions): ScreenHandle => {
      const screen = take(key, options)
      let released = false
      let wantsWebgl = options.webgl
      let frame: number | undefined
      const cancelFrame = (): void => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
      }
      return {
        state: screen.state,
        place: (element) => {
          // The element holds the host alone: one a screen opened again replaces the one before.
          if (screen.host.parentElement !== element) element.replaceChildren(screen.host)
          screen.followed.refit()
          cancelFrame()
          frame = requestAnimationFrame(() => {
            frame = undefined
            if (screen.host.isConnected) screen.followed.refit()
          })
          if (screen.refocus) {
            screen.xterm.focus()
            screen.refocus = false
          }
        },
        update: ({ label, phase, webgl }) => {
          if (released) return
          if (label !== undefined) writeLabel(screen, label)
          if (phase !== undefined && phase !== screen.phase) {
            screen.phase = phase
            screen.refresh()
          }
          if (webgl !== undefined && webgl !== wantsWebgl) {
            wantsWebgl = webgl
            screen.renderer.take(webgl)
          }
        },
        focus: () => {
          screen.xterm.focus()
          return screen.host.contains(document.activeElement)
        },
        restart: screen.restart,
        release: ({ unmount = false } = {}) => {
          if (released) return
          released = true
          cancelFrame()
          if (unmount && screen.host.contains(document.activeElement)) screen.refocus = true
          letGo(key)
        },
      }
    },
    // Sets the terminal font from Preferences: new screens open in it and the open ones
    // whose size differs change to it and fit again.
    setFont: (next: TerminalFont): void => {
      font = next
      for (const { screen } of entries.values()) {
        if (!screen || screen.xterm.options.fontSize === next.size) continue
        screen.xterm.options.fontSize = next.size
        screen.followed.refit()
      }
    },
    // Pastes text into the terminal's screen as the person's own paste: bracketed when its
    // program asked for that, and never followed by Enter. Dictation targets a terminal the
    // person is looking at, so a terminal with no open screen, or one whose stream isn't
    // drawing it (parked out of sight, reconnecting, or taking up again), or whose shell
    // exited, has nothing to type into and gets nothing: opening a second attachment to write behind a screen that
    // is not there, for a paste with no brackets, would run the text as typed commands. Says
    // whether it pasted. Line breaks and other control characters become spaces first:
    // outside bracketed paste xterm turns a newline into Enter, which would submit what was
    // said.
    typeInto: (key: TerminalKey, text: string): boolean => {
      const screen = entries.get(id(key))?.screen
      const state = screen?.state.getSnapshot()
      if (!screen || !state?.live || runtime.connection.getSnapshot() !== "connected") return false
      // A shell that exited takes only Enter, to start again.
      if (screen.phase === "ended" || state.waits) return false
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
