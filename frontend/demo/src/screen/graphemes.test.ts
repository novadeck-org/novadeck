import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { graphemesOf } from "./graphemes"

const accented = "é"
const thumb = "👍🏽"

describe("a text's characters", () => {
  it("are what a person sees, a letter with its accent and an emoji with its skin tone", () => {
    expect(graphemesOf(`a${accented}${thumb}`)).toEqual([
      { segment: "a", index: 0 },
      { segment: accented, index: 1 },
      { segment: thumb, index: 3 },
    ])
  })

  context("in a browser without Intl.Segmenter, as Firefox before 125", () => {
    const segmenter = Intl.Segmenter
    afterEach(() => {
      Object.defineProperty(Intl, "Segmenter", {
        configurable: true,
        writable: true,
        value: segmenter,
      })
      vi.resetModules()
    })

    it("still load, and are its code points, never splitting a surrogate pair", async () => {
      Reflect.deleteProperty(Intl, "Segmenter")
      vi.resetModules()
      const vt = await import("./vt")
      const editor = await import("./line-editor")
      expect(vt.characters(`a${thumb}`)).toEqual(["a", "👍", "🏽"])
      // ← from the end steps back over the skin tone's whole surrogate pair.
      const line = { ...editor.emptyLine(), draft: `a${thumb}`, cursor: `a${thumb}`.length }
      expect(editor.editLine(line, "\x1b[D").line.cursor).toBe(3)
    })
  })
})
