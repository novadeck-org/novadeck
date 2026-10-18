import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import type { ThemeSource } from "../port"
import { terminalTheme } from "./theme"

// A theme whose tokens are what the test says, counting each read.
const sourceOf = (tokens: Record<string, string>) => {
  const listeners = new Set<() => void>()
  const source = {
    tokens: vi.fn<ThemeSource["tokens"]>(() => tokens),
    onChange: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  } satisfies ThemeSource
  return { source, apply: () => listeners.forEach((listener) => listener()) }
}

describe("a terminal's theme", () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it("takes the font without reading the colours", () => {
    const element = document.body.appendChild(document.createElement("div"))
    const { source } = sourceOf({})
    expect(terminalTheme(source).resolve(element).fontFamily).toBe("monospace")
    expect(source.tokens).not.toHaveBeenCalled()
  })

  it("takes the theme's monospace font where the terminal draws, as the theme sets it", () => {
    const root = document.documentElement
    const element = document.body.appendChild(document.createElement("div"))
    const { source } = sourceOf({})
    // One theme, read again after the page's font changes.
    const theme = terminalTheme(source)
    try {
      root.style.setProperty("--font-mono", "Old Mono")
      expect(theme.resolve(element).fontFamily).toBe("Old Mono")
      root.style.setProperty("--font-mono", "New Mono")
      expect(theme.resolve(element).fontFamily).toBe("New Mono")
    } finally {
      root.style.removeProperty("--font-mono")
    }
  })

  it("reads the colours where the terminal draws, when they're asked for", () => {
    const region = document.body.appendChild(document.createElement("section"))
    const element = region.appendChild(document.createElement("div"))
    const { source } = sourceOf({
      "--terminal-bg": "#101010",
      "--terminal-ansi-red-bright": "#f00",
    })
    const { theme } = terminalTheme(source).resolve(element)
    expect(theme).toEqual({ background: "#101010", cursorAccent: "#101010", brightRed: "#f00" })
    expect(source.tokens).toHaveBeenCalledOnce()
    expect(source.tokens.mock.calls[0]![0]).toBe(element)
  })

  it("reads the page's colours for a terminal with no place yet", () => {
    const { source } = sourceOf({})
    void terminalTheme(source).resolve(document.createElement("div")).theme
    expect(source.tokens.mock.calls[0]![0]).toBe(document.body)
  })

  it("tells of each theme applied, until stopped", () => {
    const { source, apply } = sourceOf({})
    const changed = vi.fn<() => void>()
    const stop = terminalTheme(source).changed(changed)
    apply()
    stop()
    apply()
    expect(changed).toHaveBeenCalledOnce()
  })
})
