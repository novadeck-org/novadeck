import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { tokenColors } from "../../theme/probe"
import { terminalTheme } from "./theme"

vi.mock("../../theme/probe", async (original) => {
  const probe = await original<typeof import("../../theme/probe")>()
  return { ...probe, tokenColors: vi.fn<typeof probe.tokenColors>(probe.tokenColors) }
})

describe("a terminal's theme", () => {
  afterEach(() => {
    vi.mocked(tokenColors).mockClear()
    document.body.replaceChildren()
  })

  it("takes the font without probing the colours", () => {
    const element = document.body.appendChild(document.createElement("div"))
    const added: Node[] = []
    const observer = new MutationObserver((records) =>
      added.push(...records.flatMap((record) => [...record.addedNodes])),
    )
    observer.observe(document.body, { childList: true, subtree: true })

    expect(terminalTheme.resolve(element).fontFamily).toBe("monospace")

    observer.takeRecords().forEach((record) => added.push(...record.addedNodes))
    observer.disconnect()
    expect(added).toEqual([])
    expect(tokenColors).not.toHaveBeenCalled()
  })

  it("probes the colours when they're asked for", () => {
    const element = document.body.appendChild(document.createElement("div"))
    expect(terminalTheme.resolve(element).theme).toBeTypeOf("object")
    expect(tokenColors).toHaveBeenCalledOnce()
  })
})
