import type { BoxProfile, InputBox } from "../harnesses/box.js"
import { describe, expect, it } from "../test.js"
import { screen as screenOf } from "../testing/screens.js"
import { Interrupts, type InterruptHost } from "./interrupts.js"
import type { ScreenText } from "./screen.js"

const ESC = "\x1b"
const CLEAR = "<clear>"

/**
 * A terminal as interrupts see it: a one-box screen led by `> `, whose text the test sets
 * as each Escape comes (what the harness puts back), and the keys written to it.
 */
const terminal = (
  options: {
    /** The turn's prompt, as its hooks told it. */
    prompt?: string
    /** What the box holds before the Escape. */
    draft?: string
    working?: boolean
    /** Whether the screen shows messages queued behind the turn. */
    queued?: boolean
    /** Whether the harness has keys that clear its box; they empty it where it `clears`. */
    clear?: boolean
    clears?: boolean
    /** What the box holds once the nth Escape has come. */
    /** The most rows the box shows of a taller text, as its harness's `viewport` says. */
    viewport?: number
    after?: (escapes: number) => string | undefined
  } = {},
) => {
  let box = options.draft ?? ""
  const typed: string[] = []
  const written: string[] = []
  const profile: BoxProfile = {
    read: (screen: ScreenText): InputBox | undefined => {
      const first = screen.rows.findIndex((row) => row.startsWith("> "))
      if (first < 0) return undefined
      let last = first
      while (screen.rows[last + 1]?.startsWith("  ")) last += 1
      const lines = screen.rows.slice(first, last + 1).map((row) => row.slice(2))
      return { text: lines.join("\n").trimEnd(), mode: "prompt", first, last }
    },
    collapsed: ({ text }) => /^\[Pasted text #\d+ \+\d+ lines\]$/.test(text),
    ...(options.clear === false ? {} : { clear: () => CLEAR }),
    shell: { expands: true, footer: () => false },
    queued: () => options.queued === true,
    collapses: () => false,
    ...(options.viewport === undefined ? {} : { viewport: () => options.viewport! }),
    room: (rows) => rows - 3,
  }
  const host: InterruptHost = {
    admit: () => undefined,
    working: () => options.working !== false,
    alive: () => true,
    profile: () => profile,
    prompt: () => options.prompt,
    screen: () =>
      Promise.resolve(
        screenOf({
          rows: [
            "header",
            ...box.split("\n").map((line, index) => `${index === 0 ? ">" : " "} ${line}`),
            "footer",
          ],
        }),
      ),
    type: (_id, data) => {
      typed.push(data)
      const next = options.after?.(typed.length)
      if (next !== undefined) box = next
      return true
    },
    write: (_id, data) => {
      written.push(data)
      if (data === CLEAR && options.clears !== false) box = ""
      return true
    },
  }
  const interrupts = new Interrupts(host, { restoreMs: 600, restoreCalmMs: 100, settleMs: 0 })
  return { interrupt: () => interrupts.interrupt("terminal"), typed, written }
}

describe("interrupts", () => {
  it("presses nothing at a turn that is not working", async () => {
    const t = terminal({ working: false, prompt: "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: null })
    expect(t.typed).toEqual([])
    expect(t.written).toEqual([])
  })

  it("presses Escape over a draft and leaves the box alone, returning nothing", async () => {
    const t = terminal({ draft: "my draft", prompt: "Say hi", after: () => "my draft Say hi" })
    expect(await t.interrupt()).toEqual({ returned: null })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([])
  })

  it("clears the turn's own prompt that the harness put back, and returns nothing", async () => {
    const t = terminal({ prompt: "Say hi", after: () => "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: null })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([CLEAR])
  })

  it("leaves the box and says so where its harness has no keys to clear it", async () => {
    const t = terminal({ clear: false, prompt: "Say hi", after: () => "Say hi" })
    await expect(t.interrupt()).rejects.toMatchObject({ code: "BOX_NOT_CLEARED" })
    expect(t.written).toEqual([])
  })

  it("leaves a placeholder that is not for the turn's own prompt, and says so", async () => {
    const t = terminal({ prompt: "Say hi", after: () => "[Pasted text #1 +4 lines]" })
    await expect(t.interrupt()).rejects.toMatchObject({ code: "BOX_NOT_CLEARED" })
    expect(t.written).toEqual([])
  })

  it("leaves a placeholder for a long prompt, which no harness is known to put back", async () => {
    const t = terminal({ prompt: "Say hi\nthere", after: () => "[Pasted text #1 +4 lines]" })
    await expect(t.interrupt()).rejects.toMatchObject({ code: "BOX_NOT_CLEARED" })
    expect(t.written).toEqual([])
  })

  it("clears the tail of a prompt too tall for the box, which is the turn's own, and returns nothing", async () => {
    const prompt = ["Hold on", "two", "three", "four", "five"].join("\n")
    const t = terminal({ viewport: 3, prompt, after: () => "three\nfour\nfive" })
    expect(await t.interrupt()).toEqual({ returned: null })
    expect(t.written).toEqual([CLEAR])
  })

  it("returns the words of a box shorter than the harness's tallest, though they end the prompt", async () => {
    const prompt = ["Hold on", "two", "three", "four", "five"].join("\n")
    const t = terminal({ viewport: 3, prompt, after: () => "four\nfive" })
    expect(await t.interrupt()).toEqual({ returned: "four\nfive" })
    expect(t.written).toEqual([CLEAR])
  })

  it("takes no box for full on a screen too small to know its viewport, returning the words that end the prompt", async () => {
    const prompt = ["Hold on", "two", "three"].join("\n")
    for (const viewport of [-2, 0, 1]) {
      const t = terminal({ viewport, prompt, after: () => "three" })
      // eslint-disable-next-line no-await-in-loop -- One after the other.
      expect(await t.interrupt()).toEqual({ returned: "three" })
    }
  })

  it("returns the words of a tall box that do not end the prompt", async () => {
    const t = terminal({ viewport: 2, prompt: "Hold on\ntwo\nthree", after: () => "one\nthree" })
    expect(await t.interrupt()).toEqual({ returned: "one\nthree" })
  })

  it("says so when the clear keys leave the box holding text", async () => {
    const t = terminal({ clears: false, prompt: "Say hi", after: () => "Say hi" })
    await expect(t.interrupt()).rejects.toMatchObject({ code: "BOX_NOT_CLEARED" })
    expect(t.written).toEqual([CLEAR, CLEAR, CLEAR])
  })

  it("presses Escape again for queued messages and returns what came back, cleared", async () => {
    const t = terminal({
      queued: true,
      prompt: "Hold on",
      after: (escapes) => (escapes === 2 ? "Queued beta\nQueued gamma" : undefined),
    })
    expect(await t.interrupt()).toEqual({ returned: "Queued beta\nQueued gamma" })
    expect(t.typed).toEqual([ESC, ESC])
    expect(t.written).toEqual([CLEAR])
  })

  it("returns nothing where the first Escape alone leaves the box empty and nothing is queued", async () => {
    const t = terminal({ prompt: "Say hi" })
    expect(await t.interrupt()).toEqual({ returned: null })
    expect(t.typed).toEqual([ESC])
    expect(t.written).toEqual([])
  })
})
