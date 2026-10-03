// Code that paints outside CSS, such as the xterm theme or the desktop host's window,
// needs concrete colours. A token may hold `color-mix()` or a colour that reads another
// token, so each one is resolved by the browser: set as a hidden probe element's
// `color` and read back with getComputedStyle. See docs/theming.md.

const channel = (value: number): string =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0")

const alphaOf = (text: string | undefined): number => {
  if (text === undefined) return 1
  const value = text.endsWith("%") ? parseFloat(text) / 100 : parseFloat(text)
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}

// `#rrggbb`, or `#rrggbbaa` when the colour is not opaque.
const hex = (red: number, green: number, blue: number, alpha: number): string =>
  `#${channel(red)}${channel(green)}${channel(blue)}${alpha < 1 ? channel(alpha * 255) : ""}`

const number = String.raw`(-?[\d.]+(?:e-?\d+)?)`
const legacy = new RegExp(
  String.raw`^rgba?\(\s*${number}[\s,]+${number}[\s,]+${number}(?:\s*[,/]\s*([\d.]+%?))?\s*\)$`,
)
const srgb = new RegExp(
  String.raw`^color\(srgb\s+${number}\s+${number}\s+${number}(?:\s*/\s*([\d.]+%?))?\s*\)$`,
)

// Any other colour function the browser keeps as written (`oklch()`, `lab()`) is
// converted by drawing it. A `var()` left as written means the document resolves no
// styles (as in jsdom): it stays unresolved.
const drawn = (document: Document, color: string): string | undefined => {
  if (!/^[a-z-]+\(/.test(color) || color.startsWith("var(")) return undefined
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!context) return undefined
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data
  return hex(red, green, blue, alpha / 255)
}

// A computed colour as `#rrggbb` or `#rrggbbaa`, or nothing when it is not one.
export const hexColor = (document: Document, color: string): string | undefined => {
  const value = color.trim()
  const rgb = legacy.exec(value)
  if (rgb) return hex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alphaOf(rgb[4]))
  const fraction = srgb.exec(value)
  if (fraction)
    return hex(
      Number(fraction[1]) * 255,
      Number(fraction[2]) * 255,
      Number(fraction[3]) * 255,
      alphaOf(fraction[4]),
    )
  return drawn(document, value)
}

// Resolves each colour token as an element inside `scope` would see it, so a theme that
// restyles a region reaches what is drawn there. A token that is unset or not a colour
// is left out.
export const tokenColors = <Token extends string>(
  scope: Element,
  tokens: readonly Token[],
): Partial<Record<Token, string>> => {
  const document = scope.ownerDocument
  const view = document.defaultView
  if (!view) return {}
  const probe = document.createElement("div")
  probe.setAttribute("aria-hidden", "true")
  probe.style.display = "none"
  const probes = tokens.map((token) => {
    const element = document.createElement("span")
    element.style.color = `var(${token})`
    probe.append(element)
    return element
  })
  scope.append(probe)
  try {
    return Object.fromEntries(
      tokens.flatMap((token, index) => {
        const color = hexColor(document, view.getComputedStyle(probes[index]!).color)
        // An unset token leaves `color` inherited from the scope, not the token's own.
        return color && view.getComputedStyle(probes[index]!).getPropertyValue(token).trim()
          ? [[token, color]]
          : []
      }),
    ) as Partial<Record<Token, string>>
  } finally {
    probe.remove()
  }
}
