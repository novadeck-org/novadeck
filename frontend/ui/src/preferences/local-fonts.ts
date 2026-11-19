// The fonts installed on the person's computer, for the terminal font. Chromium lists them
// with `queryLocalFonts()`, which the desktop app's page may call (its session allows the
// "local-fonts" permission). A browser without it, one that refuses, and a page that has
// not been allowed, give the empty list: the terminal font then offers only the bundled one.

type LocalFont = { readonly family: string }
type Fonts = { readonly queryLocalFonts?: () => Promise<readonly LocalFont[]> }

export type InstalledFonts = {
  // Families whose letters all share one width, which suit a terminal's grid, by name.
  readonly monospace: readonly string[]
  // Every other family, by name.
  readonly other: readonly string[]
}

export const noFonts: InstalledFonts = { monospace: [], other: [] }

// Whether `measure` finds a family monospaced: a narrow, a wide and a middling letter, a space
// and a digit all one width. A proportional family differs by far more than the margin.
export const isMonospace = (measure: (text: string) => number): boolean => {
  const widths = ["iiiiiiiiii", "WWWWWWWWWW", "mmmmmmmmmm", "          ", "0000000000"].map(measure)
  return widths.every((width) => width > 0 && Math.abs(width - widths[0]!) < 0.5)
}

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: "base" })

let probe: CanvasRenderingContext2D | null | undefined
const canvasMeasure = (family: string): ((text: string) => number) | undefined => {
  probe ??= document.createElement("canvas").getContext("2d")
  const context = probe
  if (!context) return undefined
  context.font = `64px "${family.replaceAll(/["\\]/g, "")}"`
  return (text) => context.measureText(text).width
}

// How many families are measured before the page gets a turn: measuring loads each font, and
// a computer with a thousand families would otherwise hold the window for a moment.
const batch = 40

// Sorts families into monospaced and the rest by measuring each in a canvas; a browser with
// no canvas finds none monospaced.
export const sortFonts = async (
  families: readonly string[],
  measureOf: (family: string) => ((text: string) => number) | undefined = canvasMeasure,
): Promise<InstalledFonts> => {
  const monospace: string[] = []
  const other: string[] = []
  for (const [index, family] of families.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- The turns are given one batch at a time.
    if (index > 0 && index % batch === 0) await new Promise((resume) => setTimeout(resume, 0))
    const measure = measureOf(family)
    if (measure && isMonospace(measure)) monospace.push(family)
    else other.push(family)
  }
  return { monospace: monospace.toSorted(byName), other: other.toSorted(byName) }
}

// The families installed (styles of one family listed once), or none when the page can't ask.
export const installedFonts = async (page: Fonts = window as Fonts): Promise<InstalledFonts> => {
  if (typeof page.queryLocalFonts !== "function") return noFonts
  try {
    const fonts = await page.queryLocalFonts()
    return await sortFonts([...new Set(fonts.map((font) => font.family).filter(Boolean))])
  } catch {
    return noFonts
  }
}
