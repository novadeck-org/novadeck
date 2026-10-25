import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

// xterm's DOM and WebGL renderers must give a terminal the same grid, or every renderer swap
// refits it to other columns and resizes its pty. The patch makes the DOM renderer measure a
// cell as WebGL does (whole device pixels, the CSS cell their share of the ratio). The behaviour
// is pinned in a real browser by terminal-views' grid.spec.ts; this guards that each bundle
// still carries the patch, and fails first when an upgrade drops it.
const lib = dirname(createRequire(import.meta.url).resolve("@xterm/xterm"))

describe("xterm's DOM renderer cell", () => {
  it.each(["xterm.js", "xterm.mjs"])("is whole device pixels wide in %s", (bundle) => {
    const source = readFileSync(join(lib, bundle), "utf8")
    const start = source.indexOf("_updateDimensions(){")
    const body = source.slice(start, source.indexOf("_dimensionsStyleElement", start))
    expect(body).toMatch(
      /dimensions\.device\.char\.width=Math\.floor\(this\._charSizeService\.width\*(\w+)\)/,
    )
    expect(body).toMatch(/dimensions\.css\.cell\.width=this\.dimensions\.device\.cell\.width\/\w+,/)
  })
})
