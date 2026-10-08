// @vitest-environment node

// The contrast targets in docs/theming.md, computed from the literal token values in each
// theme file, for every theme and every scheme it defines (WCAG 2 contrast ratio):
//
// - Text: `--color-ink` and `--color-muted` reach 4.5:1 on each ground (`--color-canvas`,
//   `--color-shell`, `--color-paper`, `--color-soft`).
// - Edges: `--color-line-strong` reaches 3:1 on each ground.
// - State pairs, where the theme sets them: `--item-highlighted-fg` on
//   `--item-highlighted-bg`, `--segmented-active-fg` on `--segmented-active-bg`, and
//   `--color-on-strong` on `--color-strong`, each 4.5:1.
//
// A token is read from the theme's own block, then its shared block, then (for a scheme
// other than the first) laid over the first scheme's, as the cascade does. A `var()` alias
// resolves in that same set, and Graphite's grounds, `oklch(from var(--color-paper)
// calc(l - n) c h)`, are computed. A failure names the theme, scheme, pair and ratio.
// `exceptions` lists the pairs a theme misses on purpose, each with its measured ratio and
// reason. A pair under one may pass on its own, so a token can improve ground by ground;
// once every pair under an exception passes, the test fails until the exception goes.

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "../test"
import { themes, type ThemeEntry } from "./themes"

type Declarations = Map<string, string>
type Rgb = readonly [number, number, number]

const read = (file: string): string => readFileSync(join(process.cwd(), "src", file), "utf8")
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim()

// The declarations of each top-level rule, by its selector. At-rules are skipped.
const rulesOf = (file: string): Map<string, Declarations> => {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "")
  const rules = new Map<string, Declarations>()
  let depth = 0
  let start = 0
  let selector = ""
  for (let index = 0; index < css.length; index++) {
    if (css[index] === "{") {
      if (depth === 0) {
        selector = normalize(css.slice(start, index))
        start = index + 1
      }
      depth++
    } else if (css[index] === "}") {
      depth--
      if (depth === 0) {
        if (!selector.startsWith("@")) {
          const declarations = rules.get(selector) ?? new Map<string, string>()
          for (const match of css.slice(start, index).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
            declarations.set(match[1]!, normalize(match[2]!))
          }
          rules.set(selector, declarations)
        }
        start = index + 1
      }
    } else if (css[index] === ";" && depth === 0) {
      start = index + 1
    }
  }
  return rules
}

const fileOf = (theme: ThemeEntry): string => `theme/${theme.file ?? theme.id}.css`
const scopeOf = (theme: ThemeEntry): string =>
  theme.id === themes[0].id
    ? ':root:where(:not([data-theme]), [data-theme="graphite"])'
    : `:root[data-theme="${theme.id}"]`
const sharedScopeOf = (theme: ThemeEntry): string | undefined => {
  const together = themes.filter((other) => fileOf(other) === fileOf(theme))
  return together.length < 2
    ? undefined
    : `:root:is(${together.map((other) => `[data-theme="${other.id}"]`).join(", ")})`
}

// Every token a theme sets for a scheme: the first scheme's, under the scheme's own.
const tokensOf = (theme: ThemeEntry, scheme: string): Declarations => {
  const rules = rulesOf(fileOf(theme))
  const tokens = new Map<string, string>()
  const first = theme.schemes[0]
  for (const layer of scheme === first ? [first] : [first, scheme]) {
    const suffix = layer === first ? "" : `[data-scheme="${layer}"]`
    const scopes = [sharedScopeOf(theme), scopeOf(theme)].filter((scope) => scope !== undefined)
    for (const scope of scopes) {
      for (const [name, value] of rules.get(`${scope}${suffix}`) ?? []) tokens.set(name, value)
    }
  }
  return tokens
}

// Colour maths: sRGB, Oklab and the contrast ratio.
const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const fromLinear = (channel: number): number =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
const clamp = (value: number): number => Math.min(1, Math.max(0, value))

const toOklch = ([r, g, b]: Rgb): [number, number, number] => {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [lightness, Math.hypot(a, bb), Math.atan2(bb, a)]
}
const fromOklch = (lightness: number, chroma: number, hue: number): Rgb => {
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return linear.map((channel) => clamp(fromLinear(clamp(channel)))) as unknown as Rgb
}

const colourOf = (tokens: Declarations, name: string, seen: string[] = []): Rgb => {
  if (seen.includes(name)) throw new Error(`${name}: alias cycle ${[...seen, name].join(" > ")}`)
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`${name} is not set`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias) return colourOf(tokens, alias[1]!, [...seen, name])
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  const relative = /^oklch\(from (var\(--[\w-]+\)) calc\(l ([+-]) ([\d.]+)\) c h\)$/.exec(value)
  if (relative) {
    const base = colourOf(tokens, /--[\w-]+/.exec(relative[1]!)![0], [...seen, name])
    const [l, c, h] = toOklch(base)
    return fromOklch(l + (relative[2] === "-" ? -1 : 1) * Number(relative[3]), c, h)
  }
  throw new Error(
    `${name}: cannot read "${value}"; use a hex colour, a var() alias or oklch(from …)`,
  )
}

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
const contrast = (a: Rgb, b: Rgb): number => {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x)
  return (high! + 0.05) / (low! + 0.05)
}

// Pairs a theme misses on purpose, by "<theme> <scheme> <foreground>" (on every ground the
// pair is measured on), with the measured ratios and why.
const exceptions: Record<string, string> = {}
const exceptionOf = (key: string): string | undefined =>
  exceptions[key.split(" ").slice(0, 3).join(" ")]

const grounds = ["--color-canvas", "--color-shell", "--color-paper", "--color-soft"]
const targets: { foreground: string; backgrounds: string[]; minimum: number; optional?: true }[] = [
  { foreground: "--color-ink", backgrounds: grounds, minimum: 4.5 },
  { foreground: "--color-muted", backgrounds: grounds, minimum: 4.5 },
  { foreground: "--color-line-strong", backgrounds: grounds, minimum: 3 },
  { foreground: "--color-on-strong", backgrounds: ["--color-strong"], minimum: 4.5 },
  {
    foreground: "--item-highlighted-fg",
    backgrounds: ["--item-highlighted-bg"],
    minimum: 4.5,
    optional: true,
  },
  {
    foreground: "--segmented-active-fg",
    backgrounds: ["--segmented-active-bg"],
    minimum: 4.5,
    optional: true,
  },
]

const measured: { key: string; ratio: number; minimum: number }[] = []
for (const theme of themes) {
  for (const scheme of theme.schemes) {
    const tokens = tokensOf(theme, scheme)
    for (const { foreground, backgrounds, minimum, optional } of targets) {
      for (const background of backgrounds) {
        if (optional && !(tokens.has(foreground) && tokens.has(background))) continue
        const ratio = contrast(colourOf(tokens, foreground), colourOf(tokens, background))
        measured.push({
          key: `${theme.id} ${scheme} ${foreground} on ${background}`,
          ratio,
          minimum,
        })
      }
    }
  }
}

describe("contrast targets", () => {
  it("measures a pair for every theme and scheme", () => {
    for (const theme of themes) {
      for (const scheme of theme.schemes) {
        expect(
          measured.filter(({ key }) => key.startsWith(`${theme.id} ${scheme} `)).length,
          `${theme.id} ${scheme}`,
        ).toBeGreaterThanOrEqual(11)
      }
    }
  })

  it.each(measured)("$key reaches $minimum:1", ({ key, ratio, minimum }) => {
    if (exceptionOf(key) === undefined) {
      expect(
        ratio,
        `${key} is ${ratio.toFixed(2)}:1, under ${minimum}:1; raise it in ${key.split(" ")[0]}'s theme file`,
      ).toBeGreaterThanOrEqual(minimum)
    }
  })

  it.each(Object.entries(exceptions))("still needs the exception for %s", (id, reason) => {
    const under = measured.filter(({ key }) => key.startsWith(`${id} `))
    expect(
      under.some(({ ratio, minimum }) => ratio < minimum),
      `every pair under ${id} now passes; drop its exception: ${reason}`,
    ).toBe(true)
  })

  it("lists only exceptions for pairs that exist", () => {
    expect(
      Object.keys(exceptions).filter(
        (id) => !measured.some(({ key }) => exceptionOf(key) && key.startsWith(`${id} `)),
      ),
    ).toEqual([])
  })
})
