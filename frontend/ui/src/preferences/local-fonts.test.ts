import { describe, expect, it } from "../test"
import { installedFonts, isMonospace, noFonts, sortFonts } from "./local-fonts"

// Widths as a font draws them: a letter's width per family, a monospaced family's all one.
const widthsOf =
  (letters: Readonly<Record<string, number>>) =>
  (text: string): number =>
    [...text].reduce((total, letter) => total + (letters[letter] ?? 6), 0)

const mono = widthsOf({})
const proportional = widthsOf({ i: 3, W: 10, m: 9 })

describe("isMonospace", () => {
  it("accepts a family whose letters share one width and refuses a proportional one", () => {
    expect(isMonospace(mono)).toBe(true)
    expect(isMonospace(proportional)).toBe(false)
  })

  it("refuses a family that measures nothing", () => {
    expect(isMonospace(() => 0)).toBe(false)
  })
})

describe("sortFonts", () => {
  it("sorts the monospaced families apart from the rest, each by name", async () => {
    const measures: Record<string, (text: string) => number> = {
      Zed: mono,
      Arial: proportional,
      "fira Code": mono,
      Baskerville: proportional,
    }

    const sorted = await sortFonts(Object.keys(measures), (family) => measures[family])

    expect(sorted).toEqual({ monospace: ["fira Code", "Zed"], other: ["Arial", "Baskerville"] })
  })

  it("finds none monospaced where nothing can measure", async () => {
    expect(await sortFonts(["A", "B"], () => undefined)).toEqual({
      monospace: [],
      other: ["A", "B"],
    })
  })
})

describe("installedFonts", () => {
  it("lists nothing, without an error, where the page has no font list", async () => {
    expect(await installedFonts({})).toEqual(noFonts)
  })

  it("lists nothing where the list is refused", async () => {
    const refused = {
      queryLocalFonts: () => Promise.reject(new DOMException("no", "SecurityError")),
    }

    expect(await installedFonts(refused)).toEqual(noFonts)
  })

  it("lists each family once, however many styles it has", async () => {
    const page = {
      queryLocalFonts: () =>
        Promise.resolve([{ family: "Menlo" }, { family: "Menlo" }, { family: "Menlo" }]),
    }

    const fonts = await installedFonts(page)

    expect([...fonts.monospace, ...fonts.other]).toEqual(["Menlo"])
  })
})
