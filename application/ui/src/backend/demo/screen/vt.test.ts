import { describe, expect, it } from "vitest"

import { box, clipLine, columns, encode, plain, rule, span, widthOf, wrap, type Line } from "./vt"

const text = (lines: readonly Line[]): string[] => lines.map(plain)

describe("a row's bytes", () => {
  it("style each run with its SGR and reset after it", () => {
    expect(
      encode([span("PASS", "reverse", "bold", "green"), span(" done"), span("x", "muted")]),
    ).toBe("\x1b[7;1;32mPASS\x1b[0m done\x1b[90mx\x1b[0m")
  })

  it("count columns as the emulator does, a wide character as two", () => {
    expect(widthOf([span("❯ ok"), span("✻")])).toBe(5)
    expect(widthOf([span("表")])).toBe(2)
  })
})

describe("wrapping a paragraph", () => {
  it("breaks between words, never past the width", () => {
    const rows = text(wrap([span("I’ll read the checkout layout before proposing changes.")], 20))
    expect(rows).toEqual(["I’ll read the", "checkout layout", "before proposing", "changes."])
  })

  it("keeps each run's style across the rows it lands on", () => {
    const rows = wrap([span("one two "), span("three four", "bold")], 9)
    expect(rows.map((row) => row.map((run) => [run.text, run.style.join()]))).toEqual([
      [
        ["one", ""],
        [" ", ""],
        ["two", ""],
      ],
      [["three", "bold"]],
      [["four", "bold"]],
    ])
  })

  it("breaks inside a word only when the word is wider than a row", () => {
    expect(text(wrap([span("see src/checkout/OrderSummary.tsx")], 12))).toEqual([
      "see",
      "src/checkout",
      "/OrderSummar",
      "y.tsx",
    ])
  })

  it("starts every row after the first at the hanging indent", () => {
    const rows = wrap([span("Read Checkout.tsx, OrderSummary.tsx")], 16, {
      first: [span("└ ")],
      rest: [span("  ")],
    })
    expect(text(rows)).toEqual(["└ Read", "  Checkout.tsx,", "  OrderSummary.t", "  sx"])
    expect(rows.every((row) => widthOf(row) <= 16)).toBe(true)
  })

  it("starts a row at each line break, keeping the spaces as written", () => {
    expect(text(wrap([span("a  b\n  indented")], 20))).toEqual(["a  b", "  indented"])
  })

  it("lays out an empty paragraph as one empty row", () => {
    expect(text(wrap([span("")], 10))).toEqual([""])
  })
})

describe("names in columns", () => {
  const names = [
    "application/",
    "package.json",
    "README.md",
    "node_modules/",
    "pnpm-lock.yaml",
    "tsconfig.json",
  ].map((name) => span(name))

  it("fill down then across, as ls does, as many as fit", () => {
    expect(text(columns(names, 100))).toEqual([
      "application/  package.json  README.md  node_modules/  pnpm-lock.yaml  tsconfig.json",
    ])
    expect(text(columns(names, 50))).toEqual([
      "application/  README.md      pnpm-lock.yaml",
      "package.json  node_modules/  tsconfig.json",
    ])
  })

  it("go one to a row where no two fit", () => {
    expect(text(columns(names, 20))).toHaveLength(6)
  })
})

describe("boxes and rules", () => {
  it("draw a rounded box at the width, clipping a row too long for it", () => {
    const rows = box(14, (inner) => [[span("PERMISSION")], [span("x".repeat(inner + 3))]], "yellow")
    expect(text(rows)).toEqual([
      "╭────────────╮",
      "│ PERMISSION │",
      "│ xxxxxxxxx… │",
      "╰────────────╯",
    ])
    expect(rows[0]![0]!.style).toEqual(["yellow"])
  })

  it("draw a rule across the width, with its label at the start", () => {
    expect(plain(rule(20, "Worked for 24s"))).toBe("─ Worked for 24s ───")
    expect(plain(rule(5))).toBe("─────")
    expect(plain(rule(10, "Worked for 24s"))).toBe("─ Worked …")
  })

  it("cut a row with an ellipsis where it lost something", () => {
    expect(plain(clipLine([span("abc"), span("defg")], 5))).toBe("abcd…")
    expect(plain(clipLine([span("abc")], 5))).toBe("abc")
  })
})

describe("text with characters a terminal treats apart", () => {
  it("keeps a letter with its mark, an emoji with its modifier and a family together", () => {
    const rows = text(wrap([span("ab👨‍👩‍👧cdefgh")], 5))
    expect(rows).toEqual(["ab👨‍👩‍👧c", "defgh"])
    expect(text(wrap([span("éééééé")], 4))).toEqual(["éééé", "éé"])
  })

  it("breaks a word only at a space, across runs styled apart", () => {
    expect(text(wrap([span("Read", "bold"), span("(src/a.ts) now")], 12))).toEqual([
      "Read(src/a.t",
      "s) now",
    ])
  })

  it("adds no row for a line break at the end, and keeps what fits of opening spaces", () => {
    expect(text(wrap([span("a\n")], 10))).toEqual(["a"])
    expect(text(wrap([span("     x")], 3))).toEqual(["   ", "x"])
  })

  it("never writes a control character but a line break", () => {
    expect(span("a\tb\x1b[2Jc\rd").text).toBe("a b[2Jcd")
  })
})
