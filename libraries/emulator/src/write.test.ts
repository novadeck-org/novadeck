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
// skips the chunk, hands its callback the error and throws the first of a run of writes again
// on its own, as xterm does for an async handler's, then keeps to xterm's time slice. The
// runner's headless screens take the patch too, without throwing it again (in Node that is an
// uncaught exception, which would end the runner and every shell in it), and end the sequence
// the parser was left in, as nothing draws them afresh.
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
    // The loop, async branch included, up to where it queues what is left.
    const body = source.slice(
      start,
      source.indexOf("this._writeBuffer.length>this._bufferOffset?", start),
    )
    expect(body).toMatch(
      name === "@xterm/headless"
        ? /try\{\w+=this\._action\(\w+,\w+\)\}catch\((\w+)\)\{this\._failed=void 0;try\{this\._action\("\\x18"\)\}catch\{\}(const|let) \w+=this\._callbacks/
        : /try\{\w+=this\._action\(\w+,\w+\)\}catch\((\w+)\)\{thrown\|\|\(thrown=!0,queueMicrotask/,
    )
    // A broken screen's backlog still yields to the page every slice.
    expect(body).toMatch(
      /if\(\w+&&\w+\(\w+\),this\._bufferOffset\+\+,this\._pendingData-=\w+\.length,performance\.now\(\)-\w+>=\w+\)break;continue\}/,
    )
    if (name !== "@xterm/headless") return
    // An async handler's rejection goes to its chunk's callback, kept until the chunk is done.
    expect(body).toMatch(
      /\.catch\(\(?\w+=>\((void 0===this\._failed|this\._failed===void 0)&&\(this\._failed=\w+\),!1\)/,
    )
    expect(body).not.toContain("throw")
    // Nor does the check on a slow async handler throw its rejection again, unhandled.
    const slow = source.indexOf("_logSlowResolvingAsync(e){")
    expect(source.slice(slow, source.indexOf("}_", slow))).not.toContain("throw")
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
    // Queued together, they are parsed in one run, which throws its first error alone again.
    const again = await Promise.allSettled([
      writeTo(terminal, "\x1b[z"),
      writeTo(terminal, "\x1b[z"),
      writeTo(terminal, "\x1b[z"),
    ])
    expect(again.map((one) => one.status)).toEqual(["rejected", "rejected", "rejected"])
    expect(thrown).toEqual([broken, broken])
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
    // The CSI that threw is over: "a" is printed, not taken for its next byte.
    expect(await written("after")).toBeUndefined()
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("after")
    expect(thrown).toEqual([])
    terminal.dispose()
  })

  it("hands a headless terminal's async handler's rejection to the chunk, not to the process", async () => {
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
    // Headless's types allow no async handler, which xterm's parser takes all the same.
    const rejecting = (): Promise<boolean> => Promise.reject(broken)
    terminal.parser.registerCsiHandler({ final: "z" }, rejecting as unknown as () => boolean)
    const written = (data: string) =>
      new Promise<unknown>((resolve) =>
        terminal.write(data, ((error?: unknown) => resolve(error)) as () => void),
      )
    expect(await written("a\x1b[zb")).toBe(broken)
    expect(await written("c")).toBeUndefined()
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("abc")
    expect(thrown).toEqual([])
    terminal.dispose()
  })
})
