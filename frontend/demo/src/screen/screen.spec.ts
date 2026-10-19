import { createView, type Terminal } from "@novadeck/emulator/browser"
import { afterEach, describe, expect, it } from "vitest"

import {
  createDemoScreen,
  type Block,
  type DemoScreen,
  type ScreenSize,
  type TailOf,
} from "./screen"
import { box, span, widthOf, wrap, type Line } from "./vt"

// The bytes a demo screen writes, read back by the emulator the views draw with, in a real
// browser: every row, scrolled off or not, and the cursor.

const opened: (() => void)[] = []
afterEach(() => opened.splice(0).forEach((close) => close()))

const terminal = (size: ScreenSize): Terminal => {
  const element = document.createElement("div")
  document.body.append(element)
  const view = createView(element, {
    fontSize: 13,
    fontFamily: "monospace",
    theme: {},
    scrollback: 1000,
  })
  view.terminal.resize(size.cols, size.rows)
  opened.push(() => {
    view.dispose()
    element.remove()
  })
  return view.terminal
}
const feed = (screen: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => screen.write(data, resolve))
const contents = (screen: Terminal) => {
  const buffer = screen.buffer.active
  const lines: string[] = []
  for (let row = 0; row < buffer.length; row += 1)
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
  while (lines.length > 0 && lines.at(-1) === "") lines.pop()
  return {
    lines,
    cursor: { row: buffer.baseY + buffer.cursorY, column: buffer.cursorX },
  }
}

// What bytes print, their control sequences aside.
// oxlint-disable-next-line no-control-regex -- A control sequence starts with ESC.
const printed = (bytes: string): string => bytes.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")

const words =
  (text: string): Block =>
  (width) =>
    wrap([span(text)], width)
const prompt =
  (draft: string, above: readonly string[] = []): TailOf =>
  (width) => {
    const status = above.flatMap((line) => wrap([span(line, "muted")], width))
    const input = wrap([span("❯ "), span(draft)], width)
    const last = input.at(-1)!
    return {
      lines: [...status, ...input],
      cursor: {
        row: status.length + input.length - 1,
        column: widthOf(last),
      },
    }
  }

// The same screen drawn whole, as a terminal attaching to it would.
const whole = async (
  size: ScreenSize,
  transcript: readonly Block[],
  tail: TailOf,
): Promise<ReturnType<typeof contents>> => {
  const screen = terminal(size)
  await feed(screen, createDemoScreen(size, { transcript, tail }).snapshot())
  return contents(screen)
}

const widths = [12, 20, 37, 80]
const story = [
  "Plan a compact order summary for the checkout page.",
  "I’ll read the checkout layout before proposing changes.",
  "Read src/checkout/Checkout.tsx",
  "└ Read 128 lines",
]

describe("a demo screen's bytes", () => {
  it.each(widths)("draw the transcript and the tail under it, at %i columns", async (cols) => {
    const size = { cols, rows: 30 }
    const { lines, cursor } = await whole(size, story.map(words), prompt("hello"))
    const expected = [
      ...story.flatMap((text) => wrap([span(text)], cols)),
      ...wrap([span("❯ hello")], cols),
    ].map((line: Line) =>
      line
        .map((run) => run.text)
        .join("")
        .trimEnd(),
    )
    expect(lines).toEqual(expected)
    expect(lines.every((line) => [...line].length <= cols)).toBe(true)
    expect(cursor.row).toBe(expected.length - 1)
  })

  it.each(widths)(
    "redraw the tail in place, as tall or short as it gets, at %i columns",
    async (cols) => {
      const size = { cols, rows: 30 }
      const transcript = story.map(words)
      const demo = createDemoScreen(size, { transcript, tail: prompt("") })
      const screen = terminal(size)
      await feed(screen, demo.snapshot())
      const tails = [
        prompt("a draft long enough to wrap at most of these widths"),
        prompt("", ["✻ Working… (esc to interrupt)", "⏸ plan mode on"]),
        prompt("x"),
        prompt("", []),
        prompt("again", ["⏺ 2 subagents running"]),
      ]
      for (const tail of tails) {
        // eslint-disable-next-line no-await-in-loop -- Each redraw reads the one before.
        await feed(screen, demo.tail(tail))
        // eslint-disable-next-line no-await-in-loop -- Compared after each.
        expect(contents(screen)).toEqual(await whole(size, transcript, tail))
      }
    },
  )

  it.each(widths)(
    "append to the transcript above the tail, never over it, at %i columns",
    async (cols) => {
      const size = { cols, rows: 40 }
      const tail = prompt("draft", ["✻ Working… (esc to interrupt)"])
      const demo = createDemoScreen(size, { tail })
      const screen = terminal(size)
      await feed(screen, demo.snapshot())
      const written: Block[] = []
      for (const text of story) {
        written.push(words(text))
        // eslint-disable-next-line no-await-in-loop -- Each append reads the one before.
        await feed(screen, demo.append(words(text)))
        // eslint-disable-next-line no-await-in-loop -- Compared after each.
        expect(contents(screen)).toEqual(await whole(size, written, tail))
      }
    },
  )

  it("puts the cursor where the tail says, mid-draft", async () => {
    const size = { cols: 40, rows: 10 }
    const tail: TailOf = () => ({
      lines: [[span("✻ Working…")], [span("❯ fix the tests")], [span("? for shortcuts")]],
      cursor: { row: 1, column: 6 },
    })
    const demo = createDemoScreen(size, { transcript: [words("hello")], tail })
    const screen = terminal(size)
    await feed(screen, demo.snapshot())
    expect(contents(screen).cursor).toEqual({ row: 2, column: 6 })
    // A redraw from there finds the tail's first row again.
    await feed(screen, demo.tail(prompt("done")))
    expect(contents(screen)).toEqual(await whole(size, [words("hello")], prompt("done")))
  })

  it("writes the transcript alone where there is no tail, and a tail that comes later under it", async () => {
    const size = { cols: 30, rows: 10 }
    const none: TailOf = () => ({ lines: [], cursor: { row: 0, column: 0 } })
    const demo = createDemoScreen(size, { transcript: [words("pnpm dev")], tail: none })
    const screen = terminal(size)
    await feed(screen, demo.snapshot())
    await feed(screen, demo.append(words("ready in 184 ms")))
    expect(contents(screen).lines).toEqual(["pnpm dev", "ready in 184 ms"])
    await feed(screen, demo.tail(prompt("ls")))
    await feed(screen, demo.tail(none))
    await feed(screen, demo.append(words("hmr update")))
    expect(contents(screen)).toEqual(
      await whole(size, ["pnpm dev", "ready in 184 ms", "hmr update"].map(words), none),
    )
  })

  it("draws the whole screen again for a tail too tall to redraw in place", async () => {
    const size = { cols: 20, rows: 6 }
    const transcript = story.map(words)
    const demo = createDemoScreen(size, { transcript, tail: prompt("") })
    const screen = terminal(size)
    await feed(screen, demo.snapshot())
    const tall = prompt("", ["one", "two", "three", "four", "five", "six"])
    const bytes = demo.tail(tall)
    expect(bytes.startsWith("\x1b[0m\x1b[H\x1b[2J\x1b[3J")).toBe(true)
    await feed(screen, bytes)
    expect(contents(screen)).toEqual(await whole(size, transcript, tall))
    // And back to a short one, which the rows that scrolled off are not left holding.
    await feed(screen, demo.tail(prompt("ok")))
    expect(contents(screen)).toEqual(await whole(size, transcript, prompt("ok")))
  })

  it.each([
    [80, 20],
    [20, 80],
  ])("lays everything out again at the new width, from %i to %i columns", async (from, to) => {
    const transcript = story.map(words)
    const tail = prompt("a draft that wraps at twenty columns")
    const demo = createDemoScreen({ cols: from, rows: 30 }, { transcript, tail })
    const screen = terminal({ cols: from, rows: 30 })
    await feed(screen, demo.snapshot())
    screen.resize(to, 30)
    await feed(screen, demo.resize({ cols: to, rows: 30 }))
    expect(contents(screen)).toEqual(await whole({ cols: to, rows: 30 }, transcript, tail))
  })

  it("replaces the transcript, as a rerun clears the screen", async () => {
    const size = { cols: 30, rows: 10 }
    const demo = createDemoScreen(size, { transcript: story.map(words), tail: prompt("") })
    const screen = terminal(size)
    await feed(screen, demo.snapshot())
    await feed(screen, demo.replace(words("RERUN src/cart.test.ts x1")))
    expect(contents(screen)).toEqual(
      await whole(size, [words("RERUN src/cart.test.ts x1")], prompt("")),
    )
  })

  // Each step's bytes, written as they come, against the screen as it then is drawn whole,
  // into a terminal that attached at the start and into one that attached after each step:
  // a snapshot taken at any point, and what follows it, draw the same screen.
  const steps = async (
    size: ScreenSize,
    demo: DemoScreen,
    ops: readonly ((demo: DemoScreen) => string)[],
  ): Promise<void> => {
    const live = terminal(size)
    await feed(live, demo.snapshot())
    const late: Terminal[] = []
    for (const op of ops) {
      const attached = terminal(size)
      // eslint-disable-next-line no-await-in-loop -- Each attaches before the next step.
      await feed(attached, demo.snapshot())
      late.push(attached)
      const bytes = op(demo)
      for (const screen of [live, ...late]) {
        // eslint-disable-next-line no-await-in-loop -- Each terminal reads the step in turn.
        await feed(screen, bytes)
      }
      const fresh = terminal(size)
      // eslint-disable-next-line no-await-in-loop -- Compared after each step.
      await feed(fresh, demo.snapshot())
      for (const screen of [live, ...late]) expect(contents(screen)).toEqual(contents(fresh))
    }
  }
  const none: TailOf = () => ({ lines: [], cursor: { row: 0, column: 0 } })
  const blank: Block = () => [[]]

  it("leaves every terminal as a whole drawing would, a tail coming and going", async () => {
    const size = { cols: 30, rows: 10 }
    await expect(
      steps(size, createDemoScreen(size, { transcript: [words("pnpm dev")] }), [
        (demo) => demo.append(words("ready in 184 ms")),
        (demo) => demo.tail(prompt("ls")),
        (demo) => demo.tail(none),
        (demo) => demo.append(words("hmr update")),
        (demo) => demo.tail(prompt("", ["✻ Working…"])),
        (demo) => demo.append(blank, words("done")),
        (demo) => demo.tail(none),
        (demo) => demo.replace(),
        (demo) => demo.tail(prompt("again")),
      ]),
    ).resolves.toBeUndefined()
  })

  it("holds a transcript that opens with a blank row", async () => {
    const size = { cols: 20, rows: 10 }
    await expect(
      steps(size, createDemoScreen(size, { tail: prompt("x") }), [
        (demo) => demo.append(blank),
        (demo) => demo.append(words("hello")),
        (demo) => demo.tail(none),
        (demo) => demo.append(blank),
      ]),
    ).resolves.toBeUndefined()
  })

  it("lets a tail as tall as the screen go without leaving a blank row", async () => {
    const size = { cols: 20, rows: 3 }
    const full: TailOf = () => ({
      lines: [[span("one")], [span("two")], [span("❯ x")]],
      cursor: { row: 2, column: 3 },
    })
    await expect(
      steps(size, createDemoScreen(size, { transcript: [words("hello")], tail: full }), [
        (demo) => demo.tail(none),
        (demo) => demo.append(words("next")),
      ]),
    ).resolves.toBeUndefined()
  })

  it("keeps a block that draws nothing at this width, for a width it draws at", async () => {
    const wide: Block = (width) => (width >= 30 ? [[span("wide only")]] : [])
    const size = { cols: 20, rows: 10 }
    const demo = createDemoScreen(size, { transcript: [words("a")], tail: prompt("") })
    expect(demo.append(wide)).toBe("")
    const screen = terminal({ cols: 40, rows: 10 })
    await feed(screen, demo.resize({ cols: 40, rows: 10 }))
    expect(contents(screen).lines).toContain("wide only")
  })

  it("lays out wide characters by the columns they take", async () => {
    const size = { cols: 9, rows: 10 }
    await expect(
      steps(size, createDemoScreen(size, { tail: prompt("表表表表") }), [
        (demo) => demo.append(words("表 👍🏽 é family 👨‍👩‍👧 here")),
        (demo) => demo.tail(prompt("👨‍👩‍👧👍🏽表x")),
        (demo) => demo.append(words("表表表表表")),
      ]),
    ).resolves.toBeUndefined()
  })

  it.each([2, 3, 5, 8, 11])(
    "redraws in place at %i columns, a box clipped to fit",
    async (cols) => {
      const size = { cols, rows: 30 }
      const boxed: TailOf = (width) => {
        const lines = [...box(width, () => [[span("PERMISSION")]], "yellow"), [span("❯ ")]]
        return { lines, cursor: { row: lines.length - 1, column: 2 } }
      }
      await expect(
        steps(size, createDemoScreen(size, { transcript: story.map(words), tail: prompt("") }), [
          (demo) => demo.tail(boxed),
          (demo) => demo.append(words("more output")),
          (demo) => demo.tail(prompt("ok")),
        ]),
      ).resolves.toBeUndefined()
    },
  )

  it("writes only the rows of a tail that changed, as a key typed changes the prompt alone", async () => {
    const size = { cols: 30, rows: 12 }
    const demo = createDemoScreen(size, {
      transcript: story.map(words),
      tail: prompt("", ["✻ Working… (esc to interrupt)"]),
    })
    const bytes = demo.tail(prompt("l", ["✻ Working… (esc to interrupt)"]))
    expect(bytes).not.toContain("Working")
    expect(bytes).not.toContain("\x1b[J")
    // A key typed writes the key alone, and a key deleted writes no text at all.
    const typed = demo.tail(prompt("ls", ["✻ Working… (esc to interrupt)"]))
    expect(printed(typed)).toBe("s")
    const deleted = demo.tail(prompt("l", ["✻ Working… (esc to interrupt)"]))
    expect(printed(deleted)).toBe("")
    expect(deleted).toContain("\x1b[K")
    await expect(
      steps(size, createDemoScreen(size, { transcript: story.map(words), tail: prompt("") }), [
        (screen) => screen.tail(prompt("l", ["one"])),
        (screen) => screen.tail(prompt("ls", ["one"])),
        (screen) => screen.tail(prompt("ls", ["two"])),
        (screen) => screen.tail(prompt("a draft long enough to wrap the row", ["two"])),
        (screen) => screen.append(words("output")),
        (screen) => screen.tail(prompt("x", ["two"])),
      ]),
    ).resolves.toBeUndefined()
  })
})
