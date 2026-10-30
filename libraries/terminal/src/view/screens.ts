import {
  writeTo,
  type ITheme,
  type Terminal,
  type View,
  type ViewRenderer,
} from "@novadeck/emulator/browser"

import { sizeBounds } from "../size.js"
import { followTerminal, type FollowedTerminal, type FollowOptions, type Screen } from "./follow.js"
import {
  clipboardAccess,
  takeClipboardKeys,
  takeFilePastes,
  type PasteFailure,
  type PasteTarget,
} from "./paste.js"
import { silenceQueries } from "./queries.js"
import {
  createStore,
  nextViewState,
  openingState,
  type MutableStore,
  type Store,
  type ViewChange,
  type ViewPhase,
  type ViewState,
} from "./view-state.js"

const clamp = (value: number, bounds: { readonly min: number; readonly max: number }): number =>
  Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)))
// The size, held to the sizes a terminal takes.
export const clampSize = (size: {
  readonly cols: number
  readonly rows: number
}): { readonly cols: number; readonly rows: number } => ({
  cols: clamp(size.cols, sizeBounds.cols),
  rows: clamp(size.rows, sizeBounds.rows),
})

// How long a terminal's size stays still before it refits after a resize. Each refit
// forces a layout and may tell the host, so a zoom or a drag refits once it pauses,
// not on every frame across dozens of terminals.
const resizeSettleMs = 120
// How long a notice of a failed paste stays.
export const pasteNoticeMs = 4_000

// What the screens are built from: the owner's emulator, theme, stream and policies. The
// screens know no app, wire or protocol; whatever is the owner's comes in here.
export type TerminalScreensOptions<K> = FollowOptions<K> & {
  // The key as a string, which names its screen.
  readonly keyOf: (key: K) => string
  // Opens an emulator in `container`. The screens subscribe to its renderer changes themselves.
  readonly emulator: (
    container: HTMLElement,
    open: { readonly fontSize: number; readonly fontFamily: string; readonly theme: ITheme },
  ) => View
  readonly theme: {
    // The theme where `element` draws, or where the page is while it has no place. The
    // parts are read when asked for: a font is taken without a resolve of the colours.
    readonly resolve: (element: Element) => { readonly theme: ITheme; readonly fontFamily: string }
    // Calls `listener` whenever the theme changes, until the returned stop.
    readonly changed: (listener: () => void) => () => void
  }
  // Makes the store of each screen's state; the owner's own, so what it observes of stores
  // reaches the screens' too. Default: a plain store.
  readonly store?: <S>(initial: S) => MutableStore<S>
  readonly markup?: {
    // Attributes of the emulator's input field, set before its accessible name.
    readonly input?: Readonly<Record<string, string>>
    // The class of the element a screen draws in.
    readonly containerClass?: string
  }
  // Called with the terminal's restart, as Enter asks for it in an ended shell.
  readonly restart: (key: K) => void
  // How long a screen nobody shows follows its terminal before it parks, and how many parked
  // screens stay before the one parked longest closes. Defaults: `parkMs`, `parkedCap`.
  readonly park?: { readonly afterMs: number; readonly keep: number }
  // The owner's rule for how long a screen nobody shows stays: `shown` says whether the
  // terminal is wanted on screen, which keeps it indefinitely; otherwise it goes after
  // `afterMs` of the clock's time.
  readonly retain: { readonly afterMs: number; readonly shown: (key: K) => boolean }
  readonly paste: {
    // Saves a file on the host's machine and resolves with its path there.
    readonly upload: (
      key: K,
      file: { readonly name: string; readonly data: Uint8Array },
    ) => Promise<string>
    // A file's own path on the host's machine, or "" for one that has none there.
    readonly pathOf?: ((file: File) => string) | undefined
    // The most a file may be to upload.
    readonly maxBytes: number
    // Whether Ctrl+V may read the clipboard without asking.
    readonly trustedClipboard: boolean
    // What Ctrl+V does where it may not read: by default the program gets the key, as a
    // shell's programs take Ctrl+V; "browser" leaves the key to the browser, which pastes the
    // clipboard's text.
    readonly ctrlV?: "program" | "browser"
    // The wording of a failed paste's notice.
    readonly notice: (failure: PasteFailure) => string
  }
}

// One terminal's emulator and its attachment to its host, outliving the mounts that
// show it: switching views moves its container into the next mount's element instead of opening
// a new emulator and attaching again.
type OpenScreen = {
  // The element the emulator draws in; a mount moves it into its own element.
  readonly container: HTMLDivElement
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
export type Hold = {
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
  readonly container: HTMLDivElement
  screen?: OpenScreen
  dispose?: () => void
  users: number
  // The connection's changes reach the screen while it has users.
  unwatch?: (() => void) | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
  parking?: ReturnType<typeof setTimeout> | undefined
}

// One owner's screens of its terminals, from `createTerminalScreens`.
export type TerminalScreens<K> = {
  // The terminal's screen for a mount that shows it, opened on first use. Each acquire has
  // the one release its handle makes.
  readonly acquire: (key: K, options: ShowOptions) => Hold
  // Sets the terminal font from Preferences: new screens open in it and the open ones
  // whose size differs change to it and fit again.
  readonly setFont: (font: TerminalFont) => void
  // Pastes text into the terminal's screen as the person's own paste: bracketed when its
  // program asked for that, and never followed by Enter. Dictation targets a terminal the
  // person is looking at, so a terminal with no open screen, or one whose stream isn't
  // drawing it (parked out of sight, reconnecting, or taking up again), or whose shell
  // exited, has nothing to type into and gets nothing: opening a second attachment to write
  // behind a screen that is not there, for a paste with no brackets, would run the text as
  // typed commands. Says whether it pasted. Line breaks and other control characters become
  // spaces first: outside bracketed paste xterm turns a newline into Enter, which would
  // submit what was said.
  readonly typeInto: (key: K, text: string) => boolean
}

// The terminal font the owner asks for.
export type TerminalFont = { readonly size: number }

// The size screens open in until the owner says: Preferences' own default.
const defaultFontSize = 13

// How often a screen nobody shows checks whether to go: often enough for the next view
// to take it, or for a view whose code is loading to arrive, to find it ready.
const releaseCheckMs = 1000
// How long a screen nobody shows keeps following its terminal's output before it parks:
// long enough for the next view to take it as it is, short enough that a dozen busy agents
// out of sight cost nothing to draw. Shown again, it takes the host's screen as it is then.
export const parkMs = 5_000
// How many parked screens stay before the one parked longest closes. Each holds its emulator's
// buffer, so without a count a long session's grows without bound. With 16, a Grid of up to 16
// terminals finds every screen still parked, not closed, after a trip to another session or
// view; a bigger one loses those parked first. Fewer would close some of a common Grid's, and
// a closed screen costs a full snapshot resync when it is shown again.
export const parkedCap = 16

// Names the screen's input, writing only when the name changes.
const writeLabel = (screen: OpenScreen, label: string): void => {
  if (screen.label === label) return
  screen.label = label
  screen.xterm.textarea?.setAttribute("aria-label", label)
}

// The screens of one host's terminals. A mount acquires its terminal's screen
// while it shows it and releases it after. A released screen stays while its terminal
// exists, so the other views, and later the other sessions and projects, find it ready; it
// closes once its terminal does, its session has stayed off screen for `retain.afterMs`, or more than
// `park.keep` screens are parked and it was parked longest.
export const createTerminalScreens = <K>(o: TerminalScreensOptions<K>): TerminalScreens<K> => {
  const id = o.keyOf
  const parkAfterMs = o.park?.afterMs ?? parkMs
  const cap = o.park?.keep ?? parkedCap
  const entries = new Map<string, Entry>()
  // The parked screens, the one parked longest first: a map keeps the order its keys were
  // added in, so a screen shown again leaves it and parking it again puts it last.
  const parked = new Map<string, { key: K; entry: Entry }>()
  // Whether Ctrl+V may read the clipboard, the same for every terminal.
  const readable = clipboardAccess(o.paste.trustedClipboard)
  // The font the owner last asked for, which a screen opens in and is brought to.
  let font: TerminalFont = { size: defaultFontSize }
  const entryOf = (key: K): Entry => {
    const known = entries.get(id(key))
    if (known) return known
    const container = document.createElement("div")
    if (o.markup?.containerClass !== undefined)
      container.setAttribute("class", o.markup.containerClass)
    const created: Entry = { container, users: 0 }
    entries.set(id(key), created)
    return created
  }

  const open = (key: K, entry: Entry, { label, phase }: Omit<ShowOptions, "webgl">): OpenScreen => {
    const { container } = entry
    const resolved = o.theme.resolve(container)
    const view = o.emulator(container, {
      fontSize: font.size,
      fontFamily: resolved.fontFamily,
      theme: resolved.theme,
    })
    const xterm = view.terminal
    const queries = silenceQueries(xterm)
    for (const [name, value] of Object.entries(o.markup?.input ?? {}))
      xterm.textarea?.setAttribute(name, value)
    xterm.textarea?.setAttribute("aria-label", label)
    const drawn: Screen = {
      exited: () => {},
      live: () => {},
      write: (data) => writeTo(xterm, data),
      // xterm's reset leaves its parser as it was, which a stream cut short or a write that
      // failed may have left inside a sequence: a CAN ends any, before the screen that follows.
      reset: () => {
        xterm.reset()
        xterm.write("\x18")
      },
      resize: ({ cols, rows }) => {
        if (xterm.cols !== cols || xterm.rows !== rows) xterm.resize(cols, rows)
      },
      fit: () => {
        const size = view.fit()
        return size && clampSize(size)
      },
    }
    // The state a person sees, with the lock recomputed in the same step as the change that
    // brings it, so each change notifies once. The emulator's input follows the lock.
    let stage = phase
    const facts = () => ({ link: o.connection.getSnapshot(), phase: stage })
    const state = (o.store ?? createStore)<ViewState>(openingState(facts()))
    let locked: boolean | undefined
    const refresh = (change: ViewChange = {}): void => {
      const { lock } = state.update((current) => nextViewState(current, change, facts()))
      if (locked === (lock !== null)) return
      locked = lock !== null
      xterm.options.disableStdin = locked
      xterm.textarea?.setAttribute("aria-disabled", String(locked))
    }
    const followed = followTerminal(o, key, {
      ...drawn,
      reset: () => {
        refresh({ waits: false })
        drawn.reset()
      },
      exited: (waits) => refresh({ waits }),
      live: (live, resuming = false) => refresh({ live, resuming }),
    })
    // The renderers measure a cell alike, width and height (the emulator patches xterm's DOM one to WebGL's whole
    // device pixels), so this changes nothing unless a font or ratio differs; it fits again anyway.
    view.onRendererChange(() => {
      // Counted when the fit sent the pty another size.
      if (followed.refit()) view.renderer.resized()
    })
    const screen: OpenScreen = {
      container,
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
        o.restart(key)
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
    // Pasted files go in as their paths on the host's machine, as a bracketed paste. An
    // upload that ends after the screen is gone pastes and tells nothing.
    let noticed: ReturnType<typeof setTimeout> | undefined
    let gone = false
    const target: PasteTarget = {
      upload: (file) => o.paste.upload(key, file),
      pathOf: o.paste.pathOf,
      maxBytes: o.paste.maxBytes,
      notice: o.paste.notice,
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
    const pastes = takeFilePastes(container, target)
    // Ctrl+C copies a selection on Windows, where Ctrl+V pastes; on Linux Ctrl+V pastes a
    // clipboard of images too, and what is typed while it looks waits behind it.
    takeClipboardKeys(
      xterm,
      {
        ...target,
        copy: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
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
      { readable, ...(o.paste.ctrlV && { unreadable: o.paste.ctrlV }) },
    )
    let settling: ReturnType<typeof setTimeout> | undefined
    // The theme's font, once it has loaded: a bundled font still on its way arrives later,
    // and the terminal keeps the font it has until then. A new font changes the cell size,
    // so the terminal fits again.
    const takeFont = (theme = o.theme.resolve(container)): void => {
      void view.setFont(theme.fontFamily).then((measured) => {
        if (measured && !gone) followed.refit()
      })
    }
    // A theme sets the colours and the font.
    const retheme = (): void => {
      const theme = o.theme.resolve(container)
      view.setTheme(theme.theme)
      takeFont(theme)
    }
    // A container opened before it had a slot took the page's colours and font; once in one,
    // it takes its region's.
    let placed = container.isConnected
    // Out of sight, as a view keeps a terminal it isn't showing, it has no size. Shown
    // again, it takes the size it has now at once, not after a pause.
    let sized = Boolean(container.clientWidth && container.clientHeight)
    const resizes = new ResizeObserver(() => {
      if (!placed && container.isConnected) {
        placed = true
        retheme()
      }
      const was = sized
      sized = Boolean(container.clientWidth && container.clientHeight)
      clearTimeout(settling)
      if (sized && !was) followed.refit()
      else settling = setTimeout(() => followed.refit(), resizeSettleMs)
    })
    resizes.observe(container)
    const unthemed = o.theme.changed(retheme)
    // The terminal opened in its font whether it had loaded or not; one still on its way
    // is measured again once it arrives.
    takeFont()
    o.on?.stage?.(key, "mounted")
    entry.dispose = () => {
      o.on?.stage?.(key, "gone")
      unthemed()
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
      container.remove()
    }
    return screen
  }

  const close = (key: K, entry: Entry): void => {
    entries.delete(id(key))
    parked.delete(id(key))
    clearTimeout(entry.timer)
    clearTimeout(entry.parking)
    entry.unwatch?.()
    entry.dispose?.()
  }
  // A screen that parks joins the parked; one more than the cap closes the one parked longest,
  // through the same path as retention. A screen shown or not yet parked never closes here.
  const keep = (key: K, entry: Entry): void => {
    parked.set(id(key), { key, entry })
    for (const [, oldest] of parked) {
      if (parked.size <= cap) break
      close(oldest.key, oldest.entry)
    }
  }
  // A screen nobody shows goes once its terminal closes, or once its session has been off
  // screen for `retain.afterMs` of the clock's time, which timers falling behind in a hidden
  // window or a sleeping machine do not stretch; until then it waits, checking now and then.
  const settle = (key: K, entry: Entry, offSince?: number): void => {
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.users > 0) return
      const terminal = o.lifecycle(key)
      if (!terminal || terminal.closed) return close(key, entry)
      if (o.retain.shown(key)) return settle(key, entry)
      const since = offSince ?? Date.now()
      if (Date.now() - since >= o.retain.afterMs) close(key, entry)
      else settle(key, entry, since)
    }, releaseCheckMs)
  }

  // Takes one more hold on the terminal's screen, opening it on first use.
  const take = (key: K, { webgl, ...options }: ShowOptions): OpenScreen => {
    const entry = entryOf(key)
    const known = entry.screen
    // The hold counts once the screen is open: one that fails to open leaves nothing held.
    let screen: OpenScreen
    if (known) screen = known
    else {
      try {
        screen = entry.screen = open(key, entry, options)
      } catch (error) {
        entries.delete(id(key))
        throw error
      }
    }
    entry.users += 1
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    clearTimeout(entry.parking)
    entry.parking = undefined
    parked.delete(id(key))
    // The connection reaches the screen while a mount holds it; what changed while none did
    // is read now.
    if (entry.users === 1) {
      entry.unwatch = o.connection.subscribe(() => screen.refresh())
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
  const letGo = (key: K): void => {
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
    }, parkAfterMs)
  }

  return {
    acquire: (key, options) => {
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
          // The element holds the container alone: one a screen opened again replaces the one
          // before.
          if (screen.container.parentElement !== element) element.replaceChildren(screen.container)
          screen.followed.refit()
          cancelFrame()
          frame = requestAnimationFrame(() => {
            frame = undefined
            if (screen.container.isConnected) screen.followed.refit()
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
          return screen.container.contains(document.activeElement)
        },
        restart: screen.restart,
        release: ({ unmount = false } = {}) => {
          if (released) return
          released = true
          cancelFrame()
          if (unmount && screen.container.contains(document.activeElement)) screen.refocus = true
          letGo(key)
        },
      }
    },
    setFont: (next) => {
      font = next
      for (const { screen } of entries.values()) {
        if (!screen || screen.xterm.options.fontSize === next.size) continue
        screen.xterm.options.fontSize = next.size
        screen.followed.refit()
      }
    },
    typeInto: (key, text) => {
      const screen = entries.get(id(key))?.screen
      const state = screen?.state.getSnapshot()
      if (!screen || !state?.live || o.connection.getSnapshot() !== "connected") return false
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
