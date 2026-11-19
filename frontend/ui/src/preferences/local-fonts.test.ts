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

  it("gives the page a turn each 8 ms of measuring, not each batch of families", async () => {
    // A clock that a measure advances by 3 ms: 8 ms comes after three families.
    let clock = 0
    const turns: number[] = []
    const families = Array.from({ length: 10 }, (_, index) => `F${index}`)
    const measureOf = (): ((text: string) => number) => {
      clock += 3
      return mono
    }
    const timer = globalThis.setTimeout
    globalThis.setTimeout = ((resume: () => void) => {
      turns.push(clock)
      return timer(resume, 0)
    }) as typeof setTimeout

    try {
      await sortFonts(families, measureOf, () => clock)
    } finally {
      globalThis.setTimeout = timer
    }

    expect(turns).toEqual([9, 18, 27])
  })

  it("finds none monospaced where nothing can measure", async () => {
    expect(await sortFonts(["A", "B"], () => undefined)).toEqual({
      monospace: [],
      other: ["A", "B"],
    })
  })
})

describe("installedFonts", () => {
  const allowed = (state: string) => ({
    navigator: { permissions: { query: () => Promise.resolve({ state }) } },
  })

  it("never asks a page the permission has not been granted to, so no prompt shows", async () => {
    for (const state of ["prompt", "denied"]) {
      let asked = false
      const page = {
        ...allowed(state),
        queryLocalFonts: () => {
          asked = true
          return Promise.resolve([{ family: "Menlo" }])
        },
      }

      // oxlint-disable-next-line no-await-in-loop -- One state at a time.
      expect(await installedFonts(page)).toEqual(noFonts)
      expect(asked).toBe(false)
    }
  })

  it("lists nothing where the permission can't be queried", async () => {
    const page = { queryLocalFonts: () => Promise.resolve([{ family: "Menlo" }]) }

    expect(await installedFonts(page)).toEqual(noFonts)
  })

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
      ...allowed("granted"),
      queryLocalFonts: () =>
        Promise.resolve([{ family: "Menlo" }, { family: "Menlo" }, { family: "Menlo" }]),
    }

    const fonts = await installedFonts(page)

    expect([...fonts.monospace, ...fonts.other]).toEqual(["Menlo"])
  })
})
