// Measuring the Source panel's texts in the fonts the page sets them in, so the tree can tell how
// many chips a row has room for.

// A text's width in a font. A canvas measures the text in that font (the family as loaded
// so far: the caller measures again once the web fonts finish loading); where there is no canvas
// (jsdom) or no font is known, `estimate` stands in. Widths are kept by font, and
// forgotten when the fonts change.
let canvas: HTMLCanvasElement | undefined
const widths = new Map<string, number>()
export const forgetWidths = (): void => widths.clear()
export const textWidth = (text: string, font: string | undefined, estimate: number): number => {
  if (!font || typeof document === "undefined") return estimate
  const key = `${font}\n${text}`
  const known = widths.get(key)
  if (known !== undefined) return known
  canvas ??= document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) return estimate
  context.font = font
  const width = Math.ceil(context.measureText(text).width)
  widths.set(key, width)
  return width
}

// The fonts the row's texts are set in: the name, a handle chip and the `+N`.
export type Fonts = {
  readonly name: string | undefined
  readonly chip: string | undefined
  readonly more: string | undefined
}

export const noFonts: Fonts = { name: undefined, chip: undefined, more: undefined }

// Read from the tree's rows as they are drawn; a font whose element is not on screen is unknown.
// The `+N` is set like a chip when no row shows one.
export const fontsOf = (tree: Element): Fonts => {
  const font = (selector: string): string | undefined => {
    const element = tree.querySelector(selector)
    return element ? fontOf(element) : undefined
  }
  const chip = font(".source-chip .handle-chip")
  return { name: font(".source-name"), chip, more: font(".source-more") ?? chip }
}

export const sameFonts = (a: Fonts, b: Fonts): boolean =>
  a.name === b.name && a.chip === b.chip && a.more === b.more

// The canvas font of an element, from its computed longhands: the `font` shorthand reads empty
// in Chromium when the page sets font-feature-settings or font-variant-numeric on a parent.
const fontOf = (element: Element): string | undefined => {
  const { fontStyle, fontWeight, fontSize, fontFamily } = getComputedStyle(element)
  return fontSize && fontFamily
    ? [fontStyle, fontWeight, fontSize, fontFamily].filter(Boolean).join(" ")
    : undefined
}
