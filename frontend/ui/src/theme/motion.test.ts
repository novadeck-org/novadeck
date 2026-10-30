// An animation that never ends keeps running for as long as its element is on screen, so
// it must be one the compositor can run alone: its keyframes change only `transform`,
// `translate`, `rotate`, `scale`, `opacity` or `filter`. Anything else, as `content` or
// `background-position`, repaints on the main thread every frame. The check sees only a
// literal `infinite`; a count held in a variable escapes it.

import { describe, expect, it } from "../test"
import { read as readSource, sources } from "./sources.test-support"

const stylesheets = sources.filter((file) => file.endsWith(".css"))
const read = (file: string): string => readSource(file).replace(/\/\*[\s\S]*?\*\//g, "")

const compositable = new Set(["transform", "translate", "rotate", "scale", "opacity", "filter"])

// The text between the brace that opens at `open` and the one that closes it.
const blockAt = (css: string, open: number): string => {
  let depth = 0
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") depth++
    else if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index)
  }
  return css.slice(open + 1)
}

// Every `@keyframes` in the stylesheets, with the properties its frames set.
const definitions = stylesheets.flatMap((file) => {
  const css = read(file)
  return [...css.matchAll(/@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/gi)].map((match) => {
    const body = blockAt(css, match.index + match[0].length - 1)
    const properties = new Set(
      [...body.matchAll(/([\w-]+)\s*:[^;{}]*[;}]/g)]
        // A prefixed property is the property: `-webkit-transform` is a transform.
        .map((declaration) => declaration[1]!.toLowerCase().replace(/^-webkit-/, ""))
        .filter((property) => property !== "animation-timing-function"),
    )
    return { name: match[1]!, file, properties }
  })
})
const keyframes = new Map(definitions.map((definition) => [definition.name, definition]))

// What isn't an animation's name in its shorthand: keywords, times and counts.
const keywords = new Set(
  "infinite normal reverse alternate alternate-reverse none forwards backwards both running paused linear ease ease-in ease-out ease-in-out step-start step-end".split(
    " ",
  ),
)
// A layer's name, or where none is written out, the variable that holds it; a variable
// among the times and easings is no name.
const nameOf = (tokens: readonly string[]): string | undefined => {
  const words = tokens.filter(
    (token) => !keywords.has(token.toLowerCase()) && !/^-?[\d.]/.test(token),
  )
  return (
    words.find((token) => !token.includes("(")) ??
    words.find((token) => token.toLowerCase().startsWith("var("))
  )
}

// The layers of a shorthand, split at the commas outside any function.
const layers = (value: string): string[] => {
  const found: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "(") depth++
    else if (value[index] === ")") depth--
    else if (value[index] === "," && depth === 0) {
      found.push(value.slice(start, index))
      start = index + 1
    }
  }
  return [...found, value.slice(start)]
}

// The keyframes each `animation` layer that repeats forever runs, with where it is set, its
// `-webkit-` form included. Keywords are read in any case, names as written, as CSS does.
// Functions but `var()` are dropped before the layer is split into tokens, so `steps(1)` is
// no name, while a name kept in a variable shows as one no keyframes define.
const infinite = stylesheets.flatMap((file) =>
  [...read(file).matchAll(/(?:^|[\s;{])(?:-webkit-)?animation\s*:([^;{}]+)/gi)].flatMap((match) =>
    layers(match[1]!).flatMap((layer) => {
      const tokens = layer
        .replace(/!\s*important/gi, " ")
        .replace(/(?<![\w-])(?!var\()[\w-]*\([^()]*(?:\([^()]*\)[^()]*)*\)/gi, " ")
        .trim()
        .split(/\s+/)
      const repeats = tokens.some((token) => token.toLowerCase() === "infinite")
      const name = repeats ? nameOf(tokens) : undefined
      return name ? [{ file, name }] : []
    }),
  ),
)

describe("animations that never end", () => {
  it("are looked for in every folder's stylesheets, the debug panel's among them", () => {
    expect(stylesheets).toEqual(
      expect.arrayContaining([
        "styles.css",
        "theme/base.css",
        "@novadeck/terminal-views/terminal-xterm.css",
        "@novadeck/demo-debug/debug-panel.css",
      ]),
    )
  })

  it("are found in the stylesheets", () => {
    expect(infinite.length).toBeGreaterThan(0)
  })

  it("are set with the `animation` shorthand, which this check reads", () => {
    const longhands = stylesheets.flatMap((file) =>
      [
        ...read(file).matchAll(
          /(?:^|[\s;{])((?:-webkit-)?animation-(?:name|iteration-count))\s*:/gi,
        ),
      ].map((match) => `${file}: ${match[1]}`),
    )
    expect(longhands).toEqual([])
  })

  it("run keyframes the stylesheets define, each once", () => {
    const repeated = definitions.filter(
      (definition) => keyframes.get(definition.name) !== definition,
    )
    expect(repeated.map(({ file, name }) => `${file}: @keyframes ${name}`)).toEqual([])
    const unknown = infinite.filter(({ name }) => !keyframes.has(name))
    expect(unknown.map(({ file, name }) => `${file}: ${name}`)).toEqual([])
  })

  it("change only what the compositor runs alone: transform, translate, rotate, scale, opacity or filter", () => {
    const offenders = [...new Set(infinite.map(({ name }) => name))].flatMap((name) => {
      const frames = keyframes.get(name)
      const painted = [...(frames?.properties ?? [])].filter(
        (property) => !compositable.has(property),
      )
      return frames && painted.length
        ? [`${frames.file}: @keyframes ${name} sets ${painted.join(", ")}`]
        : []
    })
    expect(offenders).toEqual([])
  })
})
