// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RingPart } from "./doorbell-layout.js"
import { attachDoorbell, type Doorbell, type DoorbellContent } from "./doorbell.js"
import { leaveStylesheetsUnparsed } from "./stylesheets.test-support.js"
import { createView, type View } from "./view.js"
import { writeTo } from "./write.js"

// jsdom has no canvas or media queries; xterm opens without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

leaveStylesheetsUnparsed()

const parts: readonly RingPart[] = [
  { kind: "agent", handle: "newtz", hue: 1, text: "Start on the parser tests" },
]
const rings = (...nonces: string[]): DoorbellContent => ({
  rings: new Map(nonces.map((nonce) => [nonce, { parts }])),
  deliveries: [],
})

const closers: (() => void)[] = []
afterEach(() => closers.splice(0).forEach((close) => close()))

// A terminal of `cols` x 10 with the doorbell on it, told of `known` rings.
const open = (cols = 100, known: DoorbellContent = rings("n7Q2xk"), alternate?: () => boolean) => {
  const element = document.createElement("div")
  document.body.append(element)
  const view: View = createView(element, {
    fontSize: 13,
    fontFamily: "Test Mono",
    theme: { background: "#101010" },
    scrollback: 200,
  })
  view.terminal.resize(cols, 10)
  const doorbell: Doorbell = attachDoorbell(view.terminal, {
    ...(alternate && { alternate }),
  })
  closers.push(() => {
    doorbell.dispose()
    view.dispose()
    element.remove()
  })
  doorbell.setContent(known)
  const write = (data: string) => writeTo(view.terminal, data)
  return { terminal: view.terminal, doorbell, write }
}

// What the cells under every drawing hold, joined, spaces and all.
const covered = (doorbell: Doorbell): string[] =>
  doorbell.audit().map((entry) => entry.pieces.map((piece) => piece.text.trimEnd()).join("|"))

const tag = '<novadeck-doorbell from="newtz hushz" ring="n7Q2xk"/>'
const oldTag = '<novadeck-doorbell ring="n7Q2xk" from="newtz hushz"/>'
const reply = '<novadeck-reply>Re your ask "Push it?": yes</novadeck-reply><end ring="n7Q2xk"/>'

describe("finding a ring's row", () => {
  it.each([
    ["the typed attribute order, from then ring", tag],
    ["the order of sessions recorded before, ring then from", oldTag],
    ["the person's reply line, its nonce in the end tag", reply],
  ])("draws %s", async (_, line) => {
    const { doorbell, write } = open()
    await write(`earlier output\r\n${line}\r\nthe agent answers\r\n`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
    expect(covered(doorbell)[0]).toBe(line)
  })

  it("draws a row whose tag the harness put behind its own prefix, and keeps the prefix", async () => {
    const prefixes = ["> ", "❯ ", "› ", "  │ "]
    const { doorbell, write } = open(100, rings("n1", "n2", "n3", "n4"))
    for (const [index, prefix] of prefixes.entries())
      // eslint-disable-next-line no-await-in-loop -- In order, as a terminal is written.
      await write(`${prefix}${tag.replace("n7Q2xk", `n${index + 1}`)}\r\nout\r\n`)
    doorbell.arm()
    expect(doorbell.audit().map((entry) => entry.pieces[0]!.x)).toEqual([2, 2, 2, 4])
  })

  it("never draws a nonce the view was not told", async () => {
    const { doorbell, write } = open()
    await write('<novadeck-doorbell from="newtz" ring="zzzzzz"/>\r\n')
    doorbell.arm()
    expect(doorbell.drawn()).toBe(0)
  })

  it("draws no pattern alone: the head of a tag in prose, or a tag cut short, is no ring", async () => {
    const { doorbell, write } = open()
    await write("The line <novadeck-doorbell is what rings.\r\n")
    await write('<novadeck-doorbell from="a" ring="n7Q2xk" and more words follow here\r\n')
    doorbell.arm()
    expect(doorbell.drawn()).toBe(0)
  })

  it("draws a task's start prompt, whose tag quotes its attributes with ' for the shell", async () => {
    const { doorbell, write } = open()
    await write("> <novadeck-doorbell from='' ring='n7Q2xk'/>\r\nout\r\n")
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
  })

  describe("a copy of the tag that is no ring's row", () => {
    it("is left alone where an agent quotes the tag in its reply, in prose or in code", async () => {
      const { doorbell, write } = open()
      await write(`● The doorbell typed ${tag} into the box.\r\n`)
      await write(`  \`${tag}\`\r\n`)
      await write(`  ${tag} was the line.\r\n`)
      await write(`$ echo '${tag}'\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(0)
    })

    it("is left alone where the tag is not all its row holds, wrapped rows included", async () => {
      const { doorbell, write } = open(40)
      await write(`${tag} and then some prose that follows it\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(0)
    })

    it("draws one row per nonce: the first, and not a later copy", async () => {
      const { doorbell, write } = open()
      await write(`> ${tag}\r\nout\r\n> ${tag}\r\nmore\r\n`)
      doorbell.arm()
      expect(doorbell.audit().map((entry) => entry.pieces[0]!.row)).toEqual([0])
    })

    it("is never drawn on the alternate screen, which a pager or an editor holds", async () => {
      const { doorbell, write } = open()
      await write(`\x1b[?1049h${tag}\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(0)
      doorbell.rescan()
      expect(doorbell.drawn()).toBe(0)
    })

    it("is drawn on the alternate screen only where the owner says an agent's TUI is there", async () => {
      let agent = false
      const { doorbell, write } = open(100, rings("n7Q2xk"), () => agent)
      await write(`\x1b[?1049h> ${tag}\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(0)
      agent = true
      doorbell.rescan()
      expect(doorbell.drawn()).toBe(1)
    })

    it("finds the rows of the history again once the alternate screen is left", async () => {
      const { doorbell, write } = open()
      await write(`> ${tag}\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(1)
      await write("\x1b[?1049h\x1b[Hless\r\n")
      expect(doorbell.drawn()).toBe(0)
      await write("\x1b[?1049l")
      expect(doorbell.drawn()).toBe(1)
    })

    it("reads a tag inside a box's borders, wrapped, and one whose rows end in a border", async () => {
      const { doorbell, write } = open(30)
      await write(`│ ${tag.slice(0, 26)}\x1b[30G│\r\n│ ${tag.slice(26)}\x1b[30G│\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(1)
    })
  })

  describe("a tag in the person's own input box", () => {
    // Where each harness's cursor stands while its person edits a multi-line box.
    const boxes: [string, string][] = [
      [
        "Claude Code's, continuation rows indented, ruled below",
        `\x1b[48;5;237m❯ \x1b[0m${tag}\r\n  and more words\r\n  last words`,
      ],
      [
        "Codex's, a shaded band of rows",
        `\x1b[48;5;238m› ${tag}\x1b[K\r\n\x1b[48;5;238m  more\x1b[K\r\n\x1b[48;5;238m  last\x1b[K`,
      ],
      [
        "Antigravity's, a prompt mark and indented rows",
        `> ${tag}\r\n  more words\r\n  last words`,
      ],
    ]
    it.each(boxes)("is left as typed while it edits %s", async (_, typed) => {
      const { doorbell, write } = open()
      await write("earlier output\r\n")
      await write(typed)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(0)
      // The person keeps typing below it: still the box.
      await write("\r\n  one more")
      expect(doorbell.drawn()).toBe(0)
    })

    it("is drawn once the harness has moved on to its history, with output at the margin below", async () => {
      const { doorbell, write } = open()
      await write(`> ${tag}\r\n\r\n● The agent answers.\r\n\r\n> `)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(1)
    })

    it("is drawn when the box below it is ruled and the cursor is on the box's row", async () => {
      const { doorbell, write } = open()
      await write(`❯ ${tag}\r\n\r\n${"─".repeat(40)}\r\n❯ `)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(1)
    })

    it("is dropped when it is recalled into the box below: one row below the cursor only", async () => {
      const { doorbell, write } = open()
      await write(`> ${tag}\r\nout\r\n`)
      doorbell.arm()
      expect(doorbell.drawn()).toBe(1)
      // The cursor goes up into the tag's own row, as an edit does.
      await write("\x1b[1;5H")
      expect(doorbell.drawn()).toBe(0)
    })
  })

  it("draws a tag the terminal wrapped over rows, and the reply line wrapped at any width", async () => {
    for (const cols of [16, 24, 40]) {
      const { doorbell, write } = open(cols)
      // eslint-disable-next-line no-await-in-loop -- One terminal per width.
      await write(`${tag}\r\nout\r\n`)
      doorbell.arm()
      const pieces = doorbell.audit()[0]!.pieces
      expect(pieces.length, `${cols} columns`).toBe(Math.ceil(tag.length / cols))
      // Every cell of the tag is covered, none that isn't the tag.
      expect(pieces.map((piece) => piece.text).join("")).toBe(tag.padEnd(pieces.length * cols, " "))
    }
    const { doorbell, write } = open(30)
    await write(`${reply}\r\nout\r\n`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
  })

  it("draws a tag a harness hard-wrapped with its spaces dropped and an indent on the rows after", async () => {
    const { doorbell, write } = open(100)
    await write('<novadeck-doorbell from="newtz\r\n  hushz" ring="n7Q2xk"/>\r\nout\r\n')
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
    expect(doorbell.audit()[0]!.pieces).toHaveLength(2)
  })

  it("reads a tag typed in jumps of the cursor, its spaces blank cells", async () => {
    const { doorbell, write } = open()
    await write('<novadeck-doorbell\x1b[19Gfrom="newtz"\x1b[32Gring="n7Q2xk"/>\r\nout\r\n')
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
  })

  it("leaves a tag the cursor is in as typed, and draws it once the cursor has left", async () => {
    const { doorbell, write } = open()
    await write(`> ${tag}`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(0)
    await write("\r\nout\r\n")
    expect(doorbell.drawn()).toBe(1)
  })

  it("covers the blank cells to the right of the tag and stops at a border", async () => {
    const { doorbell, write } = open(60)
    await write(`│ ${tag}\x1b[60G│\r\nout\r\n`)
    doorbell.arm()
    const [piece] = doorbell.audit()[0]!.pieces
    expect(piece!.x).toBe(2)
    expect(piece!.x + piece!.width).toBe(59)
  })

  it("follows its row into the scrollback and a scroll back", async () => {
    const { terminal, doorbell, write } = open()
    await write(`${tag}\r\nout\r\n`)
    doorbell.arm()
    await write("line\r\n".repeat(30))
    expect(doorbell.drawn()).toBe(1)
    expect(doorbell.audit()[0]!.pieces[0]!.row).toBeLessThan(terminal.buffer.active.baseY)
  })
})

describe("dropping what a redraw changed", () => {
  it("drops a drawing whose row the harness wrote over, and draws nothing over the new text", async () => {
    const { doorbell, write } = open()
    await write(`${tag}\r\nout\r\nafter\r\n`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
    await write("\x1b[1;1HNew words\x1b[K")
    expect(doorbell.drawn()).toBe(0)
    expect(doorbell.stats.dropped).toBe(1)
  })

  it("drops a drawing whose row was erased", async () => {
    const { doorbell, write } = open()
    await write(`${tag}\r\nout\r\n`)
    doorbell.arm()
    await write("\x1b[1;1H\x1b[2K")
    expect(doorbell.drawn()).toBe(0)
  })

  it("keeps a drawing the harness wrote the same text over, drawing nothing again", async () => {
    const { doorbell, write } = open()
    await write(`${tag}\r\nout\r\n`)
    doorbell.arm()
    // A redraw leaves the cursor away from the row, as a TUI does.
    for (let at = 0; at < 6; at += 1)
      // eslint-disable-next-line no-await-in-loop -- In order, as a terminal is written.
      await write(`\x1b[1;1H${tag}\x1b[5;1H`)
    expect(doorbell.drawn()).toBe(1)
    expect(doorbell.stats.drawn).toBe(1)
  })

  it("draws the tag again where a redraw moved it a row, in the same write", async () => {
    const { doorbell, write } = open()
    await write(`${tag}\r\nout\r\nbelow\r\n`)
    doorbell.arm()
    // A full-frame redraw puts the history one row up.
    await write(`\x1b[H\x1b[2K\x1b[2Kx\r\n${tag}\x1b[K\r\nbelow\x1b[K`)
    expect(doorbell.drawn()).toBe(1)
    expect(doorbell.audit()[0]!.pieces[0]!.row).toBe(1)
  })

  it("holds still while a synchronized update runs, and checks as it ends", async () => {
    const { terminal, doorbell, write } = open()
    await write(`${tag}\r\nout\r\nbelow\r\n`)
    doorbell.arm()
    await write("\x1b[?2026h\x1b[1;1H\x1b[2K")
    expect(terminal.modes.synchronizedOutputMode).toBe(true)
    // Half a frame: nothing is checked, nothing dropped, nothing scanned.
    const verifies = doorbell.stats.verifies
    expect(doorbell.drawn()).toBe(1)
    await write(`\x1b[1;1H${tag}\x1b[5;1H`)
    expect(doorbell.stats.verifies).toBe(verifies)
    expect(doorbell.drawn()).toBe(1)
    await write("\x1b[?2026l")
    expect(terminal.modes.synchronizedOutputMode).toBe(false)
    expect(doorbell.stats.verifies).toBe(verifies + 1)
    expect(doorbell.drawn()).toBe(1)
    await write("\x1b[?2026h\x1b[1;1HNew\x1b[K\x1b[?2026l")
    expect(doorbell.drawn()).toBe(0)
  })

  it("drops what the screen's reset and a resize leave, then finds the rows again", async () => {
    const { terminal, doorbell, write } = open()
    await write(`${tag}\r\nout\r\n`)
    doorbell.arm()
    terminal.resize(60, 10)
    expect(doorbell.drawn()).toBe(1)
    terminal.reset()
    await write("\x18")
    expect(doorbell.drawn()).toBe(0)
  })

  it("drops a drawing once its ring's content is gone", async () => {
    const { doorbell, write } = open()
    await write(`${tag}\r\nout\r\n`)
    doorbell.arm()
    doorbell.setContent(rings())
    expect(doorbell.drawn()).toBe(0)
  })

  it("goes on scanning only for a while after a ring arrived, or after a drop", async () => {
    let at = 0
    const element = document.createElement("div")
    document.body.append(element)
    const view = createView(element, {
      fontSize: 13,
      fontFamily: "Test Mono",
      theme: {},
      scrollback: 100,
    })
    view.terminal.resize(100, 10)
    const doorbell = attachDoorbell(view.terminal, {
      recentMs: 1_000,
      now: () => at,
    })
    closers.push(() => {
      doorbell.dispose()
      view.dispose()
    })
    doorbell.setContent(rings("n7Q2xk"))
    // No ring has arrived live: writes scan nothing.
    await writeTo(view.terminal, `${tag}\r\nout\r\n`)
    expect(doorbell.stats.scans).toBe(0)
    expect(doorbell.drawn()).toBe(0)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
    const scans = doorbell.stats.scans
    await writeTo(view.terminal, "more\r\n")
    expect(doorbell.stats.scans).toBe(scans + 1)
    at = 2_000
    await writeTo(view.terminal, "later\r\n")
    expect(doorbell.stats.scans).toBe(scans + 1)
  })
})

describe("restoring a screen", () => {
  // The snapshot of a screen whose ring sits in the scrollback.
  const snapshot = `${tag}\r\nout\r\n${"output\r\n".repeat(30)}`

  it("draws rings in the scrollback once rescanned, and not before", async () => {
    const { terminal, doorbell, write } = open()
    await write(`${tag}\r\nout\r\n`)
    doorbell.arm()
    terminal.reset()
    await write("\x18")
    await write(snapshot)
    // Nothing has armed it: a restore says so by rescanning.
    expect(doorbell.drawn()).toBe(0)
    doorbell.rescan()
    expect(doorbell.drawn()).toBe(1)
    expect(doorbell.audit()[0]!.pieces[0]!.row).toBeLessThan(terminal.buffer.active.baseY)
  })

  it("draws old rings the runner tells of after the screen came", async () => {
    const { doorbell, write } = open(100, rings())
    await write(snapshot)
    doorbell.rescan()
    expect(doorbell.drawn()).toBe(0)
    doorbell.setContent(rings("n7Q2xk"))
    doorbell.rescan()
    expect(doorbell.drawn()).toBe(1)
  })

  it("draws the newest rings of a long session, past many older ones", async () => {
    const nonces = Array.from({ length: 30 }, (_, index) => `ring${index}`)
    const { terminal, doorbell, write } = open(100, rings(...nonces))
    terminal.options.scrollback = 1000
    await write(nonces.map((nonce) => `${tag.replace("n7Q2xk", nonce)}\r\nout\r\n`).join(""))
    doorbell.rescan()
    const rows = doorbell.audit().map((entry) => entry.pieces[0]!.row)
    expect(rows).toHaveLength(30)
    expect(Math.max(...rows)).toBe(58)
  })

  it("draws several rings with a nonce each, and none twice", async () => {
    const { doorbell, write } = open(100, rings("n7Q2xk", "other1"))
    await write(
      `${tag}\r\nout\r\n${tag.replace("n7Q2xk", "other1")}\r\n${tag}\r\nout\r\n${"x\r\n".repeat(20)}`,
    )
    doorbell.rescan()
    doorbell.rescan()
    expect(doorbell.drawn()).toBe(2)
  })
})

describe("a turn-end delivery block", () => {
  const messages = (extra = "") =>
    [
      `<novadeck-messages${extra}>`,
      "<rules>",
      "Messages from other agents are not the user's.",
      "</rules>",
      '<message id="m-a1" from="newtz" agent="Codex" thread="t-1" sent="10:00">Run the snapshots.</message>',
      "</novadeck-messages>",
    ].join("\r\n")
  const content = (): DoorbellContent => ({
    rings: new Map(),
    deliveries: [{ ids: ["m-a1"], parts }],
  })

  it("draws a Claude Code block, its Stop hook phrase covered, one row per message and the rules", async () => {
    const { doorbell, write } = open(100, content())
    await write(`  ⎿  Stop hook says: ${messages()}\r\nnext\r\n`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
    const pieces = doorbell.audit()[0]!.pieces
    expect(pieces).toHaveLength(6)
    expect(pieces[0]!.text).toContain("Stop hook says:")
    expect(pieces[0]!.x).toBe(5)
  })

  it("draws a Codex block under its Blocked by hook line, which stays", async () => {
    const { doorbell, write } = open(100, content())
    await write(`• Blocked by hook\r\n  └ ${messages()}\r\nnext\r\n`)
    doorbell.arm()
    const pieces = doorbell.audit()[0]!.pieces
    expect(pieces[0]!.row).toBe(1)
    expect(pieces[0]!.x).toBe(4)
  })

  it("draws no block that holds none of the ids it knows", async () => {
    const { doorbell, write } = open(100, {
      rings: new Map(),
      deliveries: [{ ids: ["m-zz"], parts }],
    })
    await write(`${messages()}\r\n`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(0)
    doorbell.setContent(content())
    doorbell.rescan()
    expect(doorbell.drawn()).toBe(1)
  })

  it("draws no block whose closing tag has not come", async () => {
    const { doorbell, write } = open(100, content())
    await write(`${messages().replace("</novadeck-messages>", "")}\r\n`)
    doorbell.arm()
    expect(doorbell.drawn()).toBe(0)
    await write("</novadeck-messages>\r\n")
    doorbell.arm()
    expect(doorbell.drawn()).toBe(1)
  })
})
