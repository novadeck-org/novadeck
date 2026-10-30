import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal, type IDisposable, type ILinkHandler, type ITheme } from "@xterm/xterm"

import { hasLigatureTable, ligatureRuns, runLimit } from "./ligatures.js"
import type { RendererPool, ScreenRenderer } from "./renderer.js"
import { applyWidths } from "./width.js"

/** What opening a link does, and what hovering one shows; the app decides which links open. */
export type ViewLinks = {
  /** A link was activated: an address in the text, or a hyperlink a program printed (OSC 8). */
  readonly open: (uri: string, event: MouseEvent) => void
  /** The element's tooltip while a link is hovered. */
  readonly title?: (uri: string) => string
}

export type ViewOptions = {
  readonly fontSize: number
  readonly fontFamily: string
  readonly theme: ITheme
  readonly scrollback: number
  /** xterm darkens or lightens any colour that would read under this ratio on its ground. */
  readonly minimumContrastRatio?: number
  readonly links?: ViewLinks
  /** The page's pool of WebGL contexts. Without it the view stays on the DOM renderer. */
  readonly pool?: RendererPool
}

/** The view's place in the page's pool: whoever shows it says when it is shown and when not. */
export type ViewRenderer = Pick<ScreenRenderer, "take" | "idle" | "release" | "resized">

export type View = {
  /** xterm's own API for everything the view doesn't wrap. */
  readonly terminal: Terminal
  /** The size the element holds, or undefined while it has none. Not clamped. */
  readonly fit: () => { cols: number; rows: number } | undefined
  readonly setTheme: (theme: ITheme) => void
  /**
   * Draws in the family once it has loaded, one that fails to load taken all the same.
   * Resolves true when xterm measured its cells afresh, so the size may have changed, and
   * false when nothing changed or a later call took over.
   */
  readonly setFont: (family: string) => Promise<boolean>
  /**
   * Draws the font's ligatures (`=>`, `!=`, `<!--`) joined, or each glyph alone. The DOM
   * renderer draws them from its text, so only a CSS rule keeps them on (the page's);
   * WebGL draws a glyph per cell, so while it draws the view, runs of cells the font
   * joins are handed to it as one glyph each, fitted to their cells.
   */
  readonly setLigatures: (on: boolean) => void
  /** Which renderer draws the view. */
  readonly renderer: ViewRenderer
  /**
   * Tells `listener` each time the view changes renderer, which may measure a cell
   * differently, so whoever fits it fits it again.
   */
  readonly onRendererChange: (listener: () => void) => IDisposable
  /** Closes the terminal and gives its context back; the element stays the caller's. */
  readonly dispose: () => void
}

const noRenderer: ScreenRenderer = {
  take: () => {},
  idle: () => {},
  release: () => {},
  refresh: () => {},
  resized: () => {},
  drawn: () => false,
  dispose: () => {},
}

/** An xterm terminal opened in `element`, with the width rule, links and fitting set up. */
export const createView = (element: HTMLElement, options: ViewOptions): View => {
  const { fontSize, fontFamily, theme, scrollback, minimumContrastRatio, links } = options
  const terminal = new Terminal({
    fontSize,
    fontFamily,
    theme,
    scrollback,
    ...(minimumContrastRatio !== undefined && { minimumContrastRatio }),
    allowTransparency: false,
    allowProposedApi: true,
  })
  const fitting = new FitAddon()
  terminal.loadAddon(fitting)
  // Widths as every other emulator here counts them, emoji sequences and CJK included, so a
  // screen a headless one gives back replays on the same rows.
  applyWidths(terminal)
  if (links) {
    const activate = (event: MouseEvent, uri: string): void => links.open(uri, event)
    const { title } = links
    const hint = title && {
      hover: (_event: MouseEvent, uri: string) =>
        terminal.element?.setAttribute("title", title(uri)),
      leave: () => terminal.element?.removeAttribute("title"),
    }
    const handler: ILinkHandler = { activate, ...hint }
    terminal.options.linkHandler = handler
    terminal.loadAddon(new WebLinksAddon(activate, hint))
  }
  terminal.open(element)
  const listeners = new Set<() => void>()
  // Ligature runs go to the character joiner only while WebGL draws the view: the DOM renderer
  // draws ligatures from its text, and a joiner would only make it build a span per run.
  let ligatures = false
  let joiner: number | undefined
  const syncJoiner = (): void => {
    // The table is JetBrains Mono's: another face's glyphs would be squeezed into runs for nothing.
    const wanted =
      ligatures && renderer.drawn() && hasLigatureTable(terminal.options.fontFamily ?? "")
    if (wanted === (joiner !== undefined)) return
    if (wanted)
      joiner = terminal.registerCharacterJoiner((text) =>
        // A cell is about 0.6 em wide in the table's font.
        ligatureRuns(
          text,
          runLimit(0.6 * (terminal.options.fontSize ?? fontSize) * window.devicePixelRatio),
        ),
      )
    else if (joiner !== undefined) {
      terminal.deregisterCharacterJoiner(joiner)
      joiner = undefined
    }
    // What is on screen was drawn the other way.
    terminal.refresh(0, terminal.rows - 1)
  }
  const renderer =
    options.pool?.screen(terminal, () => {
      syncJoiner()
      listeners.forEach((listener) => listener())
    }) ?? noRenderer
  let disposed = false

  // xterm measures its cells when its font changes, with whatever has loaded by then.
  // It is told another family first when the family stays, since only a change makes it
  // measure again.
  const measure = (family: string): void => {
    if (terminal.options.fontFamily === family) terminal.options.fontFamily = "monospace"
    terminal.options.fontFamily = family
    syncJoiner()
    // Glyphs the WebGL atlas drew in the family's fallback stay cached under its name.
    renderer.refresh()
  }
  // The family a font still loading is awaited for; a later call for another one takes over.
  let awaited: string | undefined
  const setFont = async (family: string): Promise<boolean> => {
    if (disposed) return false
    const fonts = element.ownerDocument.fonts as FontFaceSet | undefined
    const font = `${terminal.options.fontSize}px ${family}`
    if (!fonts || fonts.check(font)) {
      awaited = undefined
      if (terminal.options.fontFamily === family) return false
      measure(family)
      return true
    }
    if (awaited === family) return false
    awaited = family
    await fonts.load(font).catch(() => {})
    if (disposed || awaited !== family) return false
    awaited = undefined
    measure(family)
    return true
  }

  return {
    terminal,
    fit: () => {
      if (!element.clientWidth || !element.clientHeight) return undefined
      const size = fitting.proposeDimensions()
      return size && Number.isFinite(size.cols) && Number.isFinite(size.rows)
        ? { cols: size.cols, rows: size.rows }
        : undefined
    },
    setTheme: (next) => {
      terminal.options.theme = next
    },
    setFont,
    setLigatures: (on) => {
      ligatures = on
      syncJoiner()
    },
    renderer: {
      take: renderer.take,
      idle: renderer.idle,
      release: renderer.release,
      resized: renderer.resized,
    },
    onRendererChange: (listener) => {
      listeners.add(listener)
      return { dispose: () => void listeners.delete(listener) }
    },
    dispose: () => {
      disposed = true
      renderer.dispose()
      listeners.clear()
      terminal.dispose()
    },
  }
}
