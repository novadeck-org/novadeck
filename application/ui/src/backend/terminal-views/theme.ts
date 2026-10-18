import type { ITheme } from "@novadeck/emulator/browser"

import type { ThemeSource } from "#core/port"

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
const themeOf = (source: ThemeSource, element: Element): ITheme => {
  const colors = source.tokens(scopeOf(element), terminalTokens)
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

// The terminal theme the page is in: what the emulator draws with where `element` is. Each
// part is read when asked for, as resolving the colours adds a probe to the page, which a
// caller that needs only the font should not pay for.
export const terminalTheme = (source: ThemeSource) => ({
  resolve: (element: Element) => ({
    get theme(): ITheme {
      return themeOf(source, element)
    },
    get fontFamily(): string {
      return monospace(element)
    },
  }),
  // Calls `listener` whenever a theme is applied, until the returned stop.
  changed: source.onChange,
})

// No theme: the emulator's own colours, for a backend that is handed none, as in tests.
export const noTheme: ThemeSource = { tokens: () => ({}), onChange: () => () => {} }
