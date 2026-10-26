// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { Terminal as Headless } from "@xterm/headless"
import { Terminal } from "@xterm/xterm"
import { describe, expect, it } from "vitest"

// xterm 6.0.0 lowers a buffer's line limit on a resize only while the buffer holds lines, and
// the alternate one holds none until a program switches to it. Shrunk before that, as a reset
// and the snapshot's size are, it kept the taller limit: it scrolled into scrollback it must not
// have, and a taller size after dropped rows the cursor and renderer still read, which threw.
// The patch sets the limit whenever an empty buffer fills its rows, in both packages.
const require = createRequire(import.meta.url)
const bundles = [
  ["@xterm/xterm", "xterm.js"],
  ["@xterm/xterm", "xterm.mjs"],
  ["@xterm/headless", "xterm-headless.js"],
  ["@xterm/headless", "xterm-headless.mjs"],
] as const

const lines = (count: number): string => "row\r\n".repeat(count)

describe("the alternate screen, after a shrink while it was not in use", () => {
  it.each(bundles)("takes the line limit of its size in %s's %s", (name, bundle) => {
    const source = readFileSync(join(dirname(require.resolve(name)), bundle), "utf8")
    expect(source).toMatch(
      /fillViewportRows\(\w+\)\{if\((0===this\.lines\.length|this\.lines\.length===0)\)\{this\.lines\.maxLength=this\._getCorrectBufferLength\(this\._rows\);/,
    )
  })

  it.each([
    ["the browser's", () => new Terminal({ cols: 40, rows: 24, scrollback: 1000 })],
    [
      "the headless",
      () => new Headless({ cols: 40, rows: 24, scrollback: 1000, allowProposedApi: true }),
    ],
  ] as const)("keeps no scrollback, and every row, in %s terminal", async (_name, open) => {
    const terminal = open()
    const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))
    terminal.reset()
    terminal.resize(40, 10)
    // A program that scrolls a region at the top, as a full-screen agent's does.
    await write(`\x1b[?1049h\x1b[1;5r${lines(30)}`)
    const buffer = terminal.buffer.active
    expect(buffer.type).toBe("alternate")
    expect(buffer.baseY).toBe(0)
    terminal.resize(40, 20)
    await write(lines(5))
    terminal.resize(40, 40)
    const missing = Array.from({ length: terminal.rows }, (_, row) => row).filter(
      (row) => !terminal.buffer.active.getLine(terminal.buffer.active.baseY + row),
    )
    expect(missing).toEqual([])
    terminal.dispose()
  })
})
