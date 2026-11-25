import "@fontsource-variable/jetbrains-mono"
import "@novadeck/emulator/browser.css"
import {
  attachDoorbell,
  createView,
  loadWebgl,
  writeTo,
  type Doorbell,
  type DoorbellContent,
  type RingPart,
  type View,
} from "@novadeck/emulator/browser"
import { afterEach } from "vitest"
import { userEvent } from "vitest/browser"

import { describe, expect, it } from "./test"
import { hasWebgl, requireWebglOnCi } from "./webgl"

// The doorbell's overlay over the real screens of the three harnesses: each recording's output
// is replayed chunk by chunk into a terminal of the recorded size, in each renderer, and after
// every write and every frame an oracle checks what the overlay covers. It must cover only the
// ring's tag (or a delivery's block), never a cell the harness drew something else in, and its
// drawings must agree with the elements on screen.

type Chunk = { readonly t: number; readonly d: string }

const files = import.meta.glob("./doorbell-recordings/*/*/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>

const chunksOf = (harness: string, cols: string, name: string): Chunk[] =>
  (files[`./doorbell-recordings/${harness}/${cols}/${name}.pty.jsonl`] ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Chunk)

const idsOf = (harness: string, cols: string): string[] =>
  JSON.parse(
    files[`./doorbell-recordings/${harness}/${cols}/turn-end.ids.json`] ?? "[]",
  ) as string[]

const task = "Fix the parser tests in tests/parse, keep the fixtures as they are and report back."
const agent = (handle: string, text: string, hue: number): RingPart => ({
  kind: "agent",
  handle,
  hue,
  text,
})
const parts: readonly RingPart[] = [agent("moth", task, 1)]
const handlesOf = (harness: string, cols: string): string[] =>
  JSON.parse(
    files[`./doorbell-recordings/${harness}/${cols}/ring2.handles.json`] ?? "[]",
  ) as string[]

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const strip = (text: string): string => text.replace(/\s+/g, "")

// What is wrong with what the overlay covers now, as text; none when all is right.
const violations = (view: View, doorbell: Doorbell, ids: readonly string[]): string[] => {
  // A frame held back (synchronized output) is not painted, so what it half-draws is never seen.
  if (view.terminal.modes.synchronizedOutputMode) return []
  const bad: string[] = []
  const buf = view.terminal.buffer.active
  for (const entry of doorbell.audit()) {
    const joined = entry.pieces.map((piece) => strip(piece.text)).join("")
    if (entry.key.startsWith("ring:")) {
      const nonce = entry.key.split(":")[1]!
      const q = `["']`
      const tag = new RegExp(
        `^(?:<novadeck-doorbellfrom=${q}[^"']*${q}ring=${q}(\\w+)${q}\\/>|<novadeck-doorbellring=${q}(\\w+)${q}from=${q}[^"']*${q}\\/>|<novadeck-reply>[^<]*<\\/novadeck-reply><endring=${q}(\\w+)${q}\\/>)$`,
      )
      const found = tag.exec(joined)
      if (!found || (found[1] ?? found[2] ?? found[3]) !== nonce)
        bad.push(`${entry.key} covers "${joined.slice(0, 80)}"`)
    } else {
      // Exactly the block: its own words before it on its first row, then through its closing
      // tag, holding exactly the messages the delivery had.
      const block =
        /^(?:Stophook(?:says|feedback):)?<novadeck-messages[^>]*>.*<\/novadeck-messages>$/s
      if (!block.test(joined))
        bad.push(`${entry.key} covers "${joined.slice(0, 60)}…${joined.slice(-30)}"`)
      else {
        const shown = [...joined.matchAll(/<messageid="([^"]*)"/g)].map((found) => found[1])
        if (JSON.stringify(shown) !== JSON.stringify(ids))
          bad.push(`${entry.key} covers messages ${shown.join(",")}, not ${ids.join(",")}`)
        if (
          joined.split("<novadeck-messages").length !== 2 ||
          joined.split("</novadeck-messages>").length !== 2
        )
          bad.push(`${entry.key} covers more than one block`)
      }
    }
    for (const piece of entry.pieces) {
      if (piece.text !== piece.sig) bad.push(`${entry.key} row ${piece.row} changed under it`)
      // Where the person types, a tag stays as typed.
      if (
        piece.row === buf.baseY + buf.cursorY &&
        buf.cursorX >= piece.x &&
        buf.cursorX < piece.x + piece.width
      )
        bad.push(`${entry.key} covers the cursor at ${buf.cursorX}`)
    }
  }
  return bad
}

const opened: (() => void)[] = []
afterEach(() => opened.splice(0).forEach((close) => close()))

const replay = async (options: {
  readonly harness: string
  readonly cols: string
  readonly name: "ring" | "recall" | "turn-end" | "ring2" | "start" | "reply"
  readonly renderer: "dom" | "webgl"
  // What the ring or delivery says instead of the recording's own message.
  readonly told?: readonly RingPart[]
}) => {
  const { harness, cols, name, renderer } = options
  const chunks = chunksOf(harness, cols, name)
  const element = document.createElement("div")
  document.body.append(element)
  const view = createView(element, {
    fontSize: 13,
    fontFamily: '"JetBrains Mono Variable", monospace',
    theme: { background: "#1d1f23", foreground: "#e8e9ed" },
    scrollback: 1000,
  })
  const drawing = renderer === "webgl" ? loadWebgl(view.terminal) : undefined
  view.terminal.resize(Number(cols), 40)
  const doorbell = attachDoorbell(view.terminal, { alternate: () => true })
  opened.push(() => {
    doorbell.dispose()
    drawing?.dispose()
    view.dispose()
    element.remove()
  })
  const nonce = /ring=\\?["'](\w+)/.exec(JSON.stringify(chunks))?.[1]
  const ids = name === "turn-end" ? idsOf(harness, cols) : []
  const told: RingPart[] =
    name === "ring2"
      ? [
          agent(handlesOf(harness, cols)[0]!, "What is your colour?", 1),
          agent(handlesOf(harness, cols)[2]!, "Hello from the third one.", 4),
        ]
      : name === "reply"
        ? [{ kind: "person", text: "Picked Push: Yes, push it & then tidy <b>up</b> [soon] @x $y" }]
        : [...(options.told ?? parts)]
  const content: DoorbellContent = {
    rings: new Map(name !== "turn-end" && nonce ? [[nonce, { parts: told }]] : []),
    deliveries: name === "turn-end" ? [{ ids, parts: options.told ?? parts }] : [],
  }
  doorbell.setContent(content)
  // A ring's content is told as the runner types it: the whole recording is "recent".
  doorbell.arm()
  const bad: string[] = []
  let mismatched = 0
  let most = 0
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop -- Each chunk is drawn before the next, as in a terminal.
    await writeTo(view.terminal, chunk.d)
    bad.push(...violations(view, doorbell, ids))
    // eslint-disable-next-line no-await-in-loop -- And painted before it is checked.
    await frame()
    bad.push(...violations(view, doorbell, ids))
    // The drawings and what is on the screen agree once a frame has been painted: each piece on the
    // screen has an element shown, none hidden (xterm shows no decoration over the alternate
    // screen) and none without a piece.
    if (!view.terminal.modes.synchronizedOutputMode) {
      const buf = view.terminal.buffer.active
      const onScreen = doorbell
        .audit()
        .flatMap((entry) => entry.pieces)
        .filter(
          (piece) => piece.row >= buf.viewportY && piece.row < buf.viewportY + view.terminal.rows,
        ).length
      const shown = [...element.querySelectorAll<HTMLElement>("[data-novadeck-doorbell]")].filter(
        (each) =>
          getComputedStyle(each).display !== "none" && each.getBoundingClientRect().height > 0,
      ).length
      if (onScreen !== shown) mismatched += 1
    }
    most = Math.max(most, doorbell.drawn())
  }
  return {
    bad,
    mismatched,
    most,
    finalDrawn: doorbell.drawn(),
    chunks: chunks.length,
    view,
    doorbell,
    element,
  }
}

requireWebglOnCi()

// The channels of a computed `rgb(r, g, b)`.
const channelsOf = (colour: string): [number, number, number] => {
  const found = /(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/.exec(colour)
  return [Number(found?.[1]), Number(found?.[2]), Number(found?.[3])]
}
const luminance = ([r, g, b]: [number, number, number]): number => {
  const linear = (c: number): number =>
    c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}
const contrastOf = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [Math.max(luminance(a), luminance(b)), Math.min(luminance(a), luminance(b))]
  return (hi + 0.05) / (lo + 0.05)
}

// Novadeck's light scheme over the dark band Claude Code and Codex shade a history prompt with:
// what the overlay draws on the band must read on it, in every hue and dimmed.
describe.each(["dom", "webgl"] as const)(
  "the overlay's colours on a harness's dark band, %s",
  (renderer) => {
    it.skipIf(renderer === "webgl" && !hasWebgl)(
      "reads on the band in the light scheme: the tag's own ink, hues and dim text",
      async () => {
        const element = document.createElement("div")
        document.body.append(element)
        const light = {
          background: "#f5f3ee",
          foreground: "#181816",
          magenta: "#8a3596",
          red: "#b02a22",
          yellow: "#7a5700",
          blue: "#1f5ba8",
        }
        const view = createView(element, {
          fontSize: 13,
          fontFamily: '"JetBrains Mono Variable", monospace',
          theme: light,
          scrollback: 100,
        })
        const drawing = renderer === "webgl" ? loadWebgl(view.terminal) : undefined
        view.terminal.resize(100, 12)
        const doorbell = attachDoorbell(view.terminal, {
          hueColour: (hue) => (hue === 1 ? "#7a45b8" : undefined),
        })
        opened.push(() => {
          doorbell.dispose()
          drawing?.dispose()
          view.dispose()
          element.remove()
        })
        doorbell.setContent({
          rings: new Map([
            [
              "n7Q2xk",
              {
                parts: [
                  agent("newtz", "Start on the parser tests", 1),
                  { kind: "notice", text: "You notice news about the team." },
                  { kind: "notice", text: "You notice shared resources are busy." },
                ],
              },
            ],
          ]),
          deliveries: [],
        })
        // Claude Code's history row: white text on #3a3a3a (palette 237).
        await writeTo(
          view.terminal,
          `\x1b[48;5;237m\x1b[38;5;231m❯ <novadeck-doorbell from="newtz hushz pikez egretz" ring="n7Q2xk"/>\x1b[K\x1b[0m\r\nout\r\n`,
        )
        doorbell.arm()
        await frame()
        await frame()
        const row = element.querySelector<HTMLElement>("[data-novadeck-doorbell]")!
        expect(row).not.toBeNull()
        const ground = channelsOf(getComputedStyle(row).backgroundColor)
        // The band, not the scheme's page.
        expect(luminance(ground)).toBeLessThan(0.1)
        const spans = [...row.querySelectorAll<HTMLElement>("span")].filter((span) =>
          span.textContent?.trim(),
        )
        expect(spans.length).toBeGreaterThan(20)
        for (const span of spans)
          expect(
            contrastOf(channelsOf(getComputedStyle(span).color), ground),
            `${span.textContent} on the band`,
          ).toBeGreaterThanOrEqual(2.9)
        // The badge is a tint of the ink over the band, and the notices' lines lean.
        const badge = [...row.querySelectorAll<HTMLElement>("span")].filter(
          (span) => getComputedStyle(span).backgroundColor !== "rgba(0, 0, 0, 0)",
        )
        expect(badge.map((span) => span.textContent).join("")).toBe(" novadeck ")
        expect(
          badge.every(
            (span) =>
              luminance(channelsOf(getComputedStyle(span).backgroundColor)) > luminance(ground),
          ),
        ).toBe(true)
        const leaning = [...row.querySelectorAll<HTMLElement>("span")].filter(
          (span) => getComputedStyle(span).fontStyle === "italic",
        )
        expect(leaning.map((span) => span.textContent).join("")).toContain(
          "You notice news about the team.",
        )
        // The words are the tag's own white, not the scheme's dark ink.
        const words = spans.find((span) => span.textContent === "S")!
        expect(
          contrastOf(channelsOf(getComputedStyle(words).color), ground),
        ).toBeGreaterThanOrEqual(4.5)
        // Selected, the badge keeps the selection's colour over its tint, as the rest of the row does.
        view.terminal.options.theme = {
          ...view.terminal.options.theme,
          selectionBackground: "#3a5f9a",
        }
        view.terminal.selectAll()
        await frame()
        await frame()
        const chosen = element.querySelector<HTMLElement>("[data-novadeck-doorbell]")!
        expect(chosen.style.backgroundImage).toContain("linear-gradient")
        const chosenBadge = [...chosen.querySelectorAll<HTMLElement>("span")].filter(
          (span) => getComputedStyle(span).backgroundColor !== "rgba(0, 0, 0, 0)",
        )
        expect(chosenBadge.length).toBe(10)
        for (const span of chosenBadge)
          expect(span.style.backgroundImage).toContain("linear-gradient")
        view.terminal.clearSelection()
        await frame()
      },
    )
  },
)

const harnesses = ["claude", "codex", "agy"] as const
const widths = ["80", "120", "200"] as const
const renderers = [
  ["dom", true],
  ["webgl", hasWebgl],
] as const

for (const [renderer, available] of renderers)
  describe.skipIf(!available)(
    `the doorbell overlay on real harness screens, ${renderer} renderer`,
    () => {
      for (const harness of harnesses)
        for (const cols of widths) {
          it(`draws the ring and covers nothing else: ${harness} at ${cols} columns`, async () => {
            const result = await replay({ harness, cols, name: "ring", renderer })
            expect(result.chunks).toBeGreaterThan(5)
            expect(result.bad).toEqual([])
            expect(result.mismatched).toBe(0)
            // Drawn once the Enter that sent it moved the cursor off the tag.
            expect(result.most).toBeGreaterThanOrEqual(1)
          })

          it(`leaves a tag recalled into the box as typed: ${harness} at ${cols} columns`, async () => {
            const result = await replay({ harness, cols, name: "recall", renderer })
            expect(result.bad).toEqual([])
            expect(result.mismatched).toBe(0)
            // The warm-up's ring in the history above is drawn; the copy recalled into the box,
            // under the cursor until it is cleared, never is (`violations` checks the cursor).
            expect(result.most).toBeLessThanOrEqual(1)
            expect(result.finalDrawn).toBeLessThanOrEqual(1)
          })

          it(`draws the turn-end block where the harness prints one: ${harness} at ${cols} columns`, async () => {
            const result = await replay({ harness, cols, name: "turn-end", renderer })
            expect(result.bad).toEqual([])
            expect(result.mismatched).toBe(0)
            // Antigravity prints no block: the model gets the delivery, the screen shows its reply.
            if (harness === "agy") expect(result.finalDrawn).toBe(0)
            else expect(result.finalDrawn).toBe(1)
            expect(result.most).toBe(result.finalDrawn)
          })
        }

      // Novadeck's own notices: a badge and the family lines, alone and beside an agent's message.
      const lines: readonly RingPart[] = [
        { kind: "notice", text: "You notice news about the team." },
        { kind: "notice", text: "You notice news about a worktree." },
      ]
      for (const harness of harnesses) {
        it(`draws a ring of notices alone: ${harness} at 120 columns`, async () => {
          const result = await replay({ harness, cols: "120", name: "ring", renderer, told: lines })
          expect(result.bad).toEqual([])
          expect(result.mismatched).toBe(0)
          expect(result.most).toBeGreaterThanOrEqual(1)
        })

        it(`draws a ring of a message and notices: ${harness} at 80 columns`, async () => {
          const told = [agent("moth", task, 1), ...lines]
          const result = await replay({ harness, cols: "80", name: "ring", renderer, told })
          expect(result.bad).toEqual([])
          expect(result.mismatched).toBe(0)
          expect(result.most).toBeGreaterThanOrEqual(1)
        })

        it(`draws a notice in the turn-end block: ${harness} at 120 columns`, async () => {
          const result = await replay({
            harness,
            cols: "120",
            name: "turn-end",
            renderer,
            told: lines,
          })
          expect(result.bad).toEqual([])
          expect(result.mismatched).toBe(0)
        })
      }

      // The task's start prompt (a command-line prompt, its tag quoted with '; Antigravity takes
      // its task as a ring instead) and the person's Inbox reply, as the harnesses draw them.
      for (const harness of harnesses) {
        it(`draws a task's start prompt: ${harness} at 120 columns`, async () => {
          const result = await replay({ harness, cols: "120", name: "start", renderer })
          expect(result.bad).toEqual([])
          expect(result.mismatched).toBe(0)
          expect(result.finalDrawn).toBe(1)
        })

        it(`draws the person's reply line: ${harness} at 120 columns`, async () => {
          const result = await replay({ harness, cols: "120", name: "reply", renderer })
          expect(result.bad).toEqual([])
          expect(result.mismatched).toBe(0)
          expect(result.finalDrawn).toBe(1)
        })
      }
    },
  )

// A ring row that cuts its words opens to them in full on a click, over the rows below it, and
// a click on it closes it, on each harness's real screen.
describe("opening a ring row in full on a click", () => {
  const told: readonly RingPart[] = [
    agent(
      "moth",
      `${task} Then rebase onto main, run the whole suite twice and tell me which tests flaked.`,
      1,
    ),
    agent("newtz", "Done with the lexer; the fixtures are as they were.", 4),
  ]
  // The real screen replayed, and where a click on its ring row lands.
  const ringed = async (harness: string) => {
    const played = await replay({ harness, cols: "80", name: "ring", renderer: "dom", told })
    const { view, doorbell, element } = played
    const entry = doorbell.audit().find((each) => each.key.startsWith("ring:"))!
    const piece = entry.pieces[0]!
    const screen = element.querySelector<HTMLElement>(".xterm-screen")!
    const box = screen.getBoundingClientRect()
    const cell = { w: box.width / view.terminal.cols, h: box.height / view.terminal.rows }
    view.terminal.scrollToLine(Math.max(0, piece.row - 10))
    await frame()
    const position = {
      x: (piece.x + 4) * cell.w,
      y: (piece.row - view.terminal.buffer.active.viewportY + 0.5) * cell.h,
    }
    return { ...played, entry, screen, cell, position }
  }

  for (const harness of harnesses)
    it(`opens and closes over ${harness}'s screen at 80 columns`, async () => {
      const { view, doorbell, element, bad } = await replay({
        harness,
        cols: "80",
        name: "ring",
        renderer: "dom",
        told,
      })
      expect(bad).toEqual([])
      const entry = doorbell.audit().find((each) => each.key.startsWith("ring:"))!
      expect(entry.opens).toBe(true)
      const piece = entry.pieces[0]!
      const screen = element.querySelector<HTMLElement>(".xterm-screen")!
      const box = screen.getBoundingClientRect()
      const cell = { w: box.width / view.terminal.cols, h: box.height / view.terminal.rows }
      view.terminal.scrollToLine(Math.max(0, piece.row - 10))
      await frame()
      const position = {
        x: (piece.x + 4) * cell.w,
        y: (piece.row - view.terminal.buffer.active.viewportY + 0.5) * cell.h,
      }
      await userEvent.hover(screen, { position })
      expect(screen.style.cursor).toBe("pointer")
      await userEvent.click(screen, { position })
      await expect.poll(() => doorbell.opened()).toBeDefined()
      const panel = element.querySelector<HTMLElement>("[data-novadeck-doorbell-open]")!
      expect(panel).not.toBeNull()
      const said = doorbell.opened()!.join(" ").replace(/\s+/g, " ")
      expect(said).toContain("tell me which tests flaked.")
      expect(said).toContain("@newtz: Done with the lexer; the fixtures are as they were.")
      expect(panel.getBoundingClientRect().height).toBeCloseTo(
        doorbell.opened()!.length * cell.h,
        0,
      )
      expect(view.terminal.hasSelection()).toBe(false)
      await userEvent.click(panel)
      expect(doorbell.opened()).toBeUndefined()
      expect(element.querySelector("[data-novadeck-doorbell-open]")).toBeNull()
    })

  it("leaves a double click the terminal's: both presses reach it, nothing opens", async () => {
    const { view, doorbell, screen, position } = await ringed("claude")
    // What xterm's own listener on its element hears (a double click's second press selects a word).
    const heard: number[] = []
    const hear = (event: MouseEvent): void => void heard.push(event.detail)
    view.terminal.element!.addEventListener("mousedown", hear)
    await userEvent.dblClick(screen, { position })
    // Past the wait a single click opens after.
    await new Promise((resolve) => setTimeout(resolve, 500))
    view.terminal.element!.removeEventListener("mousedown", hear)
    expect(heard).toContain(2)
    expect(doorbell.opened()).toBeUndefined()
  })

  it("keeps the presses that open and close it from a program that has the mouse", async () => {
    const { view, doorbell, element, screen, position } = await ringed("claude")
    const sent: string[] = []
    const listening = view.terminal.onData((data) => sent.push(data))
    // The program asks for presses (X10 and SGR reports).
    await writeTo(view.terminal, "\x1b[?1000h\x1b[?1006h")
    await userEvent.click(screen, { position })
    expect(doorbell.opened()).toBeDefined()
    await userEvent.click(element.querySelector<HTMLElement>("[data-novadeck-doorbell-open]")!)
    expect(doorbell.opened()).toBeUndefined()
    expect(sent.filter((data) => data.startsWith("\x1b[<") || data.startsWith("\x1b[M"))).toEqual(
      [],
    )
    // A press off the drawings is the program's, as before.
    await userEvent.click(screen, { position: { x: 4, y: 4 } })
    expect(sent.some((data) => data.startsWith("\x1b[<"))).toBe(true)
    listening.dispose()
  })
})

// Claude Code's fullscreen mode redraws its whole screen as it scrolls, which moves a delivery
// block's rows: each redraw drops the drawing and finds it again a few rows on. The rows it drew
// keep their elements, already drawn, rather than being built again a span per character.
describe("a fullscreen TUI scrolling a delivery block", () => {
  const ids = ["m-1abc", "m-2abc", "m-3abc"]
  const words =
    "Acknowledged: merged, nothing running or uncommitted on my side. Starting nothing new."
  const told = ids.map((_, index) => agent(["quill", "basalt", "owl"][index]!, words, index + 1))
  const raw =
    "<novadeck-messages><rules>Answer each message; rules for the agent.</rules>" +
    ids.map((id) => `<message id="${id}" from="quill">${words}</message>`).join("") +
    "</novadeck-messages>"
  const block = Array.from({ length: Math.ceil(raw.length / 90) }, (_, index) =>
    index === 0
      ? `  ⎿  Stop hook says: ${raw.slice(0, 90)}`
      : `     ${raw.slice(index * 90, index * 90 + 90)}`,
  )
  const history = [
    ...Array.from({ length: 20 }, (_, index) => `  earlier ${index}`),
    "● Ran 3 stop hooks",
    ...block,
    ...Array.from({ length: 40 }, (_, index) => `  later ${index}`),
  ]

  it.each(renderers.filter(([, available]) => available).map(([renderer]) => renderer))(
    "draws its rows once and lays them where each redraw puts them, %s renderer",
    async (renderer) => {
      const element = document.createElement("div")
      document.body.append(element)
      const view = createView(element, {
        fontSize: 13,
        fontFamily: '"JetBrains Mono Variable", monospace',
        theme: { background: "#1d1f23", foreground: "#e8e9ed" },
        scrollback: 100,
      })
      const drawing = renderer === "webgl" ? loadWebgl(view.terminal) : undefined
      view.terminal.resize(120, 30)
      const doorbell = attachDoorbell(view.terminal, { alternate: () => true })
      opened.push(() => {
        doorbell.dispose()
        drawing?.dispose()
        view.dispose()
        element.remove()
      })
      doorbell.setContent({ rings: new Map(), deliveries: [{ ids, parts: told }] })
      const show = (top: number) =>
        writeTo(
          view.terminal,
          `\x1b[?1049h\x1b[?2026h\x1b[H\x1b[2J${history.slice(top, top + 30).join("\r\n")}\x1b[?2026l`,
        )
      await show(0)
      doorbell.rescan()
      await frame()
      expect(doorbell.drawn()).toBe(1)
      const paints = doorbell.stats.paints
      expect(paints).toBe(block.length)
      const screen = element.querySelector<HTMLElement>(".xterm-screen")!
      const cell = screen.getBoundingClientRect().height / view.terminal.rows
      // Each read of the screen's size after a row was placed lays the page out again.
      let reads = 0
      const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!
      Object.defineProperty(screen, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
          reads += 1
          return width.call(this) as number
        },
      })
      for (let top = 1; top <= 18; top += 1) {
        // eslint-disable-next-line no-await-in-loop -- Each redraw is laid out before the next.
        await show(top)
        // eslint-disable-next-line no-await-in-loop -- And painted, after which the pass is over.
        await frame()
        expect(doorbell.drawn()).toBe(1)
        const rows = doorbell.audit()[0]!.pieces.map((piece) => piece.row)
        expect(rows[0]).toBe(21 - top)
        const shown = [...element.querySelectorAll<HTMLElement>("[data-novadeck-doorbell]")]
        // No element left behind from the rows before: one for each row, each over its row.
        expect(shown.length).toBe(block.length)
        expect(
          shown
            .map((each) => Math.round(Number.parseFloat(each.style.top) / cell))
            .toSorted((a, b) => a - b),
        ).toEqual(rows)
        expect(shown.every((each) => each.style.display !== "none")).toBe(true)
      }
      // Moved eighteen times, never drawn again.
      expect(doorbell.stats.paints).toBe(paints)
      // And the size read a few times a redraw (a write's pass and a render's), never once a row.
      expect(reads).toBeLessThanOrEqual(18 * 6)
    },
  )
})
