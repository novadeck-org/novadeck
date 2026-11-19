// The fonts installed on the person's computer, for the terminal font. Chromium lists them
// with `queryLocalFonts()`, which the desktop app's page may call (its session grants the
// "local-fonts" permission). A browser without it, one that refuses, and a page that has
// not been granted it, give the empty list: the terminal font then offers only the default.

type LocalFont = { readonly family: string }
type Page = {
  readonly queryLocalFonts?: () => Promise<readonly LocalFont[]>
  readonly navigator?: {
    readonly permissions?: {
      readonly query: (descriptor: { readonly name: string }) => Promise<{ readonly state: string }>
    }
  }
}

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

// How long the page is held while families are measured, before it gets a turn: measuring
// loads each font (a few ms a family), and a computer with a thousand families would otherwise
// hold the window in many long tasks.
const sliceMs = 8

// Sorts families into monospaced and the rest by measuring each in a canvas; a browser with
// no canvas finds none monospaced. The page gets a turn each `sliceMs` of measuring.
export const sortFonts = async (
  families: readonly string[],
  measureOf: (family: string) => ((text: string) => number) | undefined = canvasMeasure,
  now: () => number = () => performance.now(),
): Promise<InstalledFonts> => {
  const monospace: string[] = []
  const other: string[] = []
  let sliceStart = now()
  for (const family of families) {
    if (now() - sliceStart >= sliceMs) {
      // oxlint-disable-next-line no-await-in-loop -- The turns are given one slice at a time.
      await new Promise((resume) => setTimeout(resume, 0))
      sliceStart = now()
    }
    const measure = measureOf(family)
    if (measure && isMonospace(measure)) monospace.push(family)
    else other.push(family)
  }
  return { monospace: monospace.toSorted(byName), other: other.toSorted(byName) }
}

// Whether the page may list the fonts without asking: Chromium shows its own prompt to a page
// that calls `queryLocalFonts()` unallowed (a browser tab, as the demo), so the page asks the
// permission's state first and only calls when it is granted, as the desktop app's is.
const mayList = async (page: Page): Promise<boolean> => {
  try {
    const status = await page.navigator?.permissions?.query({ name: "local-fonts" })
    return status?.state === "granted"
  } catch {
    return false
  }
}

// The families installed (styles of one family listed once), or none when the page can't ask or
// has not been allowed to.
export const installedFonts = async (page: Page = window as Page): Promise<InstalledFonts> => {
  if (typeof page.queryLocalFonts !== "function" || !(await mayList(page))) return noFonts
  try {
    const fonts = await page.queryLocalFonts()
    return await sortFonts([...new Set(fonts.map((font) => font.family).filter(Boolean))])
  } catch {
    return noFonts
  }
}
