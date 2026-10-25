import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

// The Canvas view scales a terminal with a CSS transform. xterm maps a pointer in client pixels
// against unscaled cell sizes, so the patch divides by the screen's scale (`offsetWidth`
// against the bounding box). The behaviour is pinned in a real browser by terminal-views'
// zoom.spec.ts; this guards that each bundle still carries the patch, and fails first when an
// upgrade drops it.
const lib = dirname(createRequire(import.meta.url).resolve("@xterm/xterm"))

describe("xterm's pointer mapping", () => {
  it.each(["xterm.js", "xterm.mjs"])("divides by the element's scale in %s", (bundle) => {
    const source = readFileSync(join(lib, bundle), "utf8")
    // getCoordsRelativeToElement: the client position less the box's origin, over the scale,
    // less the padding.
    expect(source).toMatch(
      /\(\w+\.clientX-\w+\.left\)\/\w+-\w+,\(\w+\.clientY-\w+\.top\)\/\w+-\w+\]/,
    )
    // moveTextAreaUnderMouseCursor: the same for the right-click textarea's left and top.
    expect(source).toMatch(
      /\(\w+\.clientX-\w+\.left\)\/\w+-10,\w+=\(\w+\.clientY-\w+\.top\)\/\w+-10/,
    )
    expect(source).toMatch(/\.offsetWidth\?\w+\.width\/\w+\.offsetWidth:1/)
  })
})
