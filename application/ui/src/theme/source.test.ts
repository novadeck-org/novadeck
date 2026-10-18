import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { themeChangeEvent } from "./apply"
import { tokenColors } from "./probe"
import { pageTheme } from "./source"

vi.mock("./probe", async (original) => {
  const probe = await original<typeof import("./probe")>()
  // A colour the test names, as jsdom resolves none.
  const resolved = <Token extends string>(_scope: Element, tokens: readonly Token[]) =>
    Object.fromEntries(tokens.map((token) => [token, "#102030"])) as Partial<Record<Token, string>>
  return { ...probe, tokenColors: vi.fn<typeof probe.tokenColors>(resolved) }
})

describe("the page's theme, as a backend reads it", () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it("resolves the tokens the backend names, where the element draws", () => {
    const element = document.body.appendChild(document.createElement("div"))
    expect(pageTheme.tokens(element, ["--terminal-bg"])).toEqual({ "--terminal-bg": "#102030" })
    expect(tokenColors).toHaveBeenCalledWith(element, ["--terminal-bg"])
  })

  it("tells of each theme applied, until stopped", () => {
    const changed = vi.fn<() => void>()
    const stop = pageTheme.onChange(changed)
    window.dispatchEvent(new CustomEvent(themeChangeEvent))
    stop()
    window.dispatchEvent(new CustomEvent(themeChangeEvent))
    expect(changed).toHaveBeenCalledOnce()
  })
})
