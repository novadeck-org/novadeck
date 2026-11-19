import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

// In screen-reader mode xterm's AccessibilityManager measured every row it rendered with its own
// forced layout, and rendered every row of the dirty range again whether it changed or not. The
// patch skips a row whose text, column map, position and cell width are as last aligned, and
// writes the rest before one read of all their widths. The behaviour is pinned in a real browser by
// terminal-views' a11y-rows.spec.ts; this guards that each bundle carries the patch.
const lib = dirname(createRequire(import.meta.url).resolve("@xterm/xterm"))

describe("xterm's accessibility rows", () => {
  it.each(["xterm.js", "xterm.mjs"])(
    "align in one pass, and only changed ones, in %s",
    (bundle) => {
      const source = readFileSync(join(lib, bundle), "utf8")
      expect(source).not.toContain("_alignRowWidth")
      expect(source).toMatch(/_rowAligned=new WeakMap/)
      // One read of every width, after the writes that clear each transform.
      expect(source).toMatch(
        /_alignRows\((\w)\)\{if\(0===\1\.length\)return;.*?for\(const \w of \1\)\w\.style\.transform="";const (\w)=\1\.map\(\w=>\w\.getBoundingClientRect\(\)\.width\)/,
      )
      expect(source).toMatch(/this\._rowAligned\.set\(\w,\{text:/)
      expect(source).toMatch(/this\._alignRows\(\w\)[,;]\s*this\._announceCharacters\(\)/)
    },
  )
})
