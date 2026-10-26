// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { Terminal as Headless } from "@xterm/headless"
import { Terminal } from "@xterm/xterm"
import { afterEach, describe, expect, it, vi } from "vitest"

import { writeTo } from "./write.js"

// A chunk whose parsing throws used to leave xterm's write queue stalled: its callback never
// ran and no later write was parsed, so a screen waiting on it never drew again. The patch
// skips the chunk, hands its callback the error and throws it again on its own, as xterm does
// for an async handler's. The runner's headless screens take the patch too, without throwing it
// again: in Node that is an uncaught exception, which would end the runner and every shell in it.
const require = createRequire(import.meta.url)
const bundles = [
  ["@xterm/xterm", "xterm.js"],
  ["@xterm/xterm", "xterm.mjs"],
  ["@xterm/headless", "xterm-headless.js"],
  ["@xterm/headless", "xterm-headless.mjs"],
] as const

describe("a write whose parsing throws", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each(bundles)("is skipped in %s's %s", (name, bundle) => {
    const source = readFileSync(join(dirname(require.resolve(name)), bundle), "utf8")
    const start = source.indexOf("_innerWrite(e=0,")
    const body = source.slice(start, source.indexOf("setTimeout", start))
    expect(body).toMatch(
      name === "@xterm/headless"
        ? /try\{\w+=this\._action\(\w+,\w+\)\}catch\((\w+)\)\{(const|let) \w+=this\._callbacks/
        : /try\{\w+=this\._action\(\w+,\w+\)\}catch\((\w+)\)\{queueMicrotask/,
    )
    expect(body).toMatch(
      /\w+&&\w+\(\w+\),this\._bufferOffset\+\+,this\._pendingData-=\w+\.length;continue\}/,
    )
  })

  // The parser may be left mid-sequence, so a screen draws afresh after one: reset, then
  // its whole screen again.
  it("rejects, and the writes after it are parsed", async () => {
    const thrown: unknown[] = []
    vi.stubGlobal("queueMicrotask", (task: () => void) => {
      try {
        task()
      } catch (error) {
        thrown.push(error)
      }
    })
    const terminal = new Terminal({ cols: 20, rows: 2 })
    const broken = new Error("no such row")
    terminal.parser.registerCsiHandler({ final: "z" }, () => {
      throw broken
    })
    await expect(writeTo(terminal, "before\x1b[z")).rejects.toBe(broken)
    expect(thrown).toEqual([broken])
    await writeTo(terminal, "\r\nnext")
    terminal.reset()
    await writeTo(terminal, "after")
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("after")
    terminal.dispose()
  })

  it("is skipped by a headless terminal, which goes on with the next and throws nothing", async () => {
    const thrown: unknown[] = []
    vi.stubGlobal("queueMicrotask", (task: () => void) => {
      try {
        task()
      } catch (error) {
        thrown.push(error)
      }
    })
    const terminal = new Headless({ cols: 20, rows: 2, allowProposedApi: true })
    const broken = new Error("no such row")
    terminal.parser.registerCsiHandler({ final: "z" }, () => {
      throw broken
    })
    const written = (data: string) =>
      new Promise<unknown>((resolve) =>
        terminal.write(data, ((error?: unknown) => resolve(error)) as () => void),
      )
    expect(await written("\x1b[z")).toBe(broken)
    expect(await written("\x18after")).toBeUndefined()
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("after")
    expect(thrown).toEqual([])
    terminal.dispose()
  })
})
