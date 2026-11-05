import { EditorState, Text } from "@codemirror/state"
import { describe as context, describe, expect, it } from "vitest"

import v1 from "./fixtures/plan-v1.md?raw"
import v2 from "./fixtures/plan-v2.md?raw"
import { distance, lineChanges, merge } from "./sync.js"

const text = (value: string): Text => Text.of(value.split("\n"))
const withNote = v1.replace(
  "warm ivory background.\n",
  "warm ivory background.\n<!-- Use a grotesk. -->\n",
)

describe("markdown sync", () => {
  context("when the file loads", () => {
    it("keeps the text byte for byte", () => {
      expect(EditorState.create({ doc: withNote }).doc.toString()).toBe(withNote)
    })
  })

  context("when the text is rewritten", () => {
    it("turns one revision into the next", () => {
      expect(lineChanges(v1, v2).apply(text(v1)).toString()).toBe(v2)
    })

    it("changes only the lines it rewrote", () => {
      const untouched = v1.indexOf("## Scope")
      expect(lineChanges(v1, v2).touchesRange(untouched, untouched + 8)).toBe(false)
    })
  })

  context("when the text was edited before it was rewritten", () => {
    const ours = withNote.replace("and deployment.", "and deployment. Also no blog.")
    const merged = merge(v1, ours, v2)

    it("keeps the edits made meanwhile", () => {
      expect(merged.text).toContain("Also no blog.")
      expect(merged.text).toContain("<!-- Use a grotesk. -->")
    })

    it("applies the rewrite", () => {
      expect(merged.text).toContain("a confident grotesk for headlines")
      expect(merged.text).toContain("Add a Journal page")
    })

    it("reports what the rewrite wrote", () => {
      const written = merged.changed
        .map((range) => merged.text.slice(range.from, range.to))
        .join("")
      expect(written).toContain("confident grotesk")
      expect(written).not.toContain("Also no blog.")
    })
  })

  context("when the file doesn't end with a line break", () => {
    it("keeps a line added after the last one on its own line", () => {
      expect(merge("a\nb", "a\nb user", "a\nb\nc").text).toBe("a\nb user\nc")
      expect(merge("a\nb", "a\nb\nuser", "a\nb\nagent").text).toBe("a\nb\nuser\nagent")
    })

    it("ends as the agent left it when it changed that, else as the person did", () => {
      expect(merge("a\nb", "a\nb", "a\nb\n").text).toBe("a\nb\n")
      expect(merge("a\nb\n", "a\nb", "a\nc\n").text).toBe("a\nc")
    })
  })

  context("when the text is long", () => {
    const lines = (count: number, name: string): string =>
      Array.from({ length: count }, (_, n) => `${name} line ${n}\n`).join("")
    // The quickest of three runs counts, so one slow moment on a busy machine doesn't fail it.
    const quickest = (run: () => void): number =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const started = performance.now()
          run()
          return performance.now() - started
        }),
      )

    it("changes only the line that changed, in a moment", () => {
      const before = lines(10_000, "plan")
      const after = before.replace("plan line 5000\n", "plan line 5000, ticked\n")
      const changes: number[][] = []
      lineChanges(before, after).iterChanges((fromA, toA, fromB, toB) =>
        changes.push([fromA, toA, fromB, toB]),
      )
      const from = before.indexOf("plan line 5000\n")
      expect(changes).toEqual([
        [from, from + "plan line 5000\n".length, from, from + "plan line 5000, ticked\n".length],
      ])
      // A table of every line against every other took seconds here, and hundreds of MB.
      expect(quickest(() => lineChanges(before, after))).toBeLessThan(100)
    })

    it("still finds the lines kept between scattered changes", () => {
      const before = lines(4_000, "plan")
      const after = before
        .replace("plan line 1000\n", "")
        .replace("plan line 3000\n", "plan line 3000\nadded\n")
      expect(lineChanges(before, after).apply(text(before)).toString()).toBe(after)
      expect(distance(before, after)).toBe("plan line 1000\n".length + "added\n".length)
      expect(quickest(() => lineChanges(before, after))).toBeLessThan(100)
    })

    it("replaces a middle too different to compare line by line whole, in a moment", () => {
      const before = lines(5_000, "old")
      const after = lines(5_000, "new")
      expect(lineChanges(before, after).apply(text(before)).toString()).toBe(after)
      expect(quickest(() => lineChanges(before, after))).toBeLessThan(100)
    })
  })

  it("turns any text into any other, keeping as many lines as can be kept", () => {
    // Lines from a small alphabet, so texts share many lines in many orders.
    let seed = 1
    const random = (below: number): number => {
      seed = (seed * 48_271) % 2_147_483_647
      return seed % below
    }
    const textOf = (): string[] => Array.from({ length: random(12) }, () => `${"abc"[random(3)]}\n`)
    const mostKept = (a: readonly string[], b: readonly string[]): number => {
      const table = a.map(() => b.map(() => 0))
      const at = (i: number, j: number): number => (i < 0 || j < 0 ? 0 : table[i]![j]!)
      a.forEach((line, i) =>
        b.forEach((other, j) => {
          table[i]![j] =
            line === other ? at(i - 1, j - 1) + 1 : Math.max(at(i - 1, j), at(i, j - 1))
        }),
      )
      return at(a.length - 1, b.length - 1)
    }
    for (let run = 0; run < 500; run++) {
      const [a, b] = [textOf(), textOf()]
      const [before, after] = [a.join(""), b.join("")]
      expect(lineChanges(before, after).apply(text(before)).toString()).toBe(after)
      // Each line is two characters, so the distance counts the lines removed and added.
      expect(distance(before, after) / 2).toBe(a.length + b.length - 2 * mostKept(a, b))
    }
  })

  it("measures how far apart two texts are by the lines that differ", () => {
    expect(distance("a\nb\n", "a\nb\n")).toBe(0)
    expect(distance("a\nb\n", "a\nB\n")).toBeLessThan(distance("a\nb\n", "A\nB\n"))
  })
})
