import type { ChatItem, ChatRequest } from "@novadeck/core/conversation"
import { describe, expect, it } from "vitest"

import { agentTail, askLines, inputLines, itemBlock, shellTail } from "./agent"
import { banner, openingBlocks } from "./openings"
import { commandBlock, sampleBlocks } from "./samples"
import type { Block } from "./screen"
import { plain, span, widthOf, type Line } from "./vt"

// What the demo's terminals show, laid out as rows: never wider than the screen, at every
// width a tile or a window gives them, and reading as the agents and programs they stand for.

const widths = [16, 24, 40, 80, 120]
const rows = (blocks: readonly Block[], width: number): Line[] =>
  blocks.flatMap((block) => block(width))
const read = (lines: readonly Line[]): string => lines.map(plain).join("\n")
const fits = (lines: readonly Line[], width: number): boolean =>
  lines.every((line) => widthOf(line) <= width)

const item = (fields: Partial<ChatItem>): ChatItem => ({
  id: "i",
  at: null,
  role: "assistant",
  kind: "text",
  text: "",
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  interrupted: false,
  ...fields,
})

const permission: ChatRequest = {
  id: "r1",
  kind: "permission",
  tool: "Bash",
  subject: "pnpm test",
  choices: [],
  subagent: false,
  answered: false,
  dialog: {
    type: "choices",
    id: "d1",
    title: null,
    detail: "pnpm test -- checkout",
    options: [
      { id: "yes", label: "Yes", text: null },
      { id: "always", label: "Yes, and don’t ask again", text: null },
      { id: "no", label: "No, and tell Claude what to do differently", text: "field" },
    ],
  },
} as ChatRequest

describe("the demo's sample output", () => {
  const samples = ["shell", "server", "tests", "git", "logs", "build"] as const

  it.each(widths)("fits %i columns, every program's", (width) => {
    for (const output of samples) {
      const lines = rows(
        sampleBlocks(output, {
          directory: "~/projects/novadeck",
          projectName: "novadeck",
          beats: 2,
        }),
        width,
      )
      expect(fits(lines, width), output).toBe(true)
    }
  })

  it("reads as each program prints it", () => {
    const at = { directory: "~/projects/novadeck", projectName: "novadeck" }
    expect(read(rows(sampleBlocks("shell", at), 80))).toContain("On branch main")
    expect(read(rows(sampleBlocks("server", at), 80))).toContain("VITE v7.3.6  ready in 184 ms")
    expect(read(rows(sampleBlocks("tests", at), 80))).toContain(" PASS  Waiting for file changes…")
    expect(read(rows(sampleBlocks("tests", { ...at, beats: 1 }), 80))).toContain(
      " RERUN  src/cart/CartSummary.test.ts x1",
    )
    expect(read(rows(sampleBlocks("git", at), 80))).toContain("e9a4c21 refine workspace layout")
    expect(read(rows(sampleBlocks("build", at), 80))).toContain("✓ built in 1.24s")
  })

  it("keeps the dev server's whole log, a beat adding the next hot update", () => {
    const at = { directory: "~", projectName: "novadeck" }
    const before = sampleBlocks("server", { ...at, beats: 1 })
    const after = sampleBlocks("server", { ...at, beats: 2 })
    expect(after.slice(0, before.length).map((block) => read(block(80)))).toEqual(
      before.map((block) => read(block(80))),
    )
    expect(read(after.at(-1)!(80))).toBe("09:42:46 [vite] hmr update /src/cart/CartSummary.tsx")
  })

  it("writes a typed command and its reply apart from what came before", () => {
    expect(read(commandBlock("pwd", "/home/visitor")(40))).toBe("\n❯ pwd\n/home/visitor")
  })
})

describe("an agent's opening", () => {
  it.each(widths)("fits %i columns, each agent's and each turn's", (width) => {
    for (const blocks of [
      openingBlocks("claude", "~/projects/shop"),
      openingBlocks("claude", "~/projects/shop", { planned: true, step: 2 }),
      openingBlocks("codex", "~/projects/shop"),
      openingBlocks("codex", "~/projects/shop", { reviewing: true }),
    ])
      expect(fits(rows(blocks, width), width)).toBe(true)
  })

  it("moves on by appending, reading's steps each starting with the one before", () => {
    const steps = ([0, 1, 2] as const).map((step) =>
      openingBlocks("claude", "~", { planned: true, step }).map((block) => read(block(60))),
    )
    expect(steps[1]!.slice(0, steps[0]!.length)).toEqual(steps[0])
    expect(steps[2]!.slice(0, steps[1]!.length)).toEqual(steps[1])
    expect(steps[0]!.join("\n")).not.toContain("Read src/checkout/Checkout.tsx")
    expect(steps[1]!.join("\n")).toContain("● Read src/checkout/Checkout.tsx")
    expect(steps[2]!.join("\n")).toContain("└ Read 128 lines")
  })

  it("names the agent and where it runs, Codex's in a box", () => {
    expect(read(openingBlocks("claude", "~/shop")[0]!(80))).toBe("✳ Claude Code  ~/shop\n")
    expect(read(openingBlocks("codex", "~/shop")[0]!(80))).toBe(
      "╭──────────╮\n│ >_ Codex │\n│ ~/shop   │\n╰──────────╯\n",
    )
  })
})

describe("Antigravity's screens", () => {
  it("pair its mark's rows with its name, sign-in, model and folder, as its probes show", () => {
    const rowsOf = read(banner("agy", "~/shop")(80)).split("\n")
    expect(rowsOf.slice(0, 5)).toEqual([
      "      ▄▀▀▄        Antigravity CLI 1.2.14",
      "     ▀▀▀▀▀▀       Gemini API key",
      "    ▀▀▀▀▀▀▀▀      Gemini 3.1 Pro (Low)",
      "   ▄▀▀    ▀▀▄     ~/shop",
      "  ▄▀▀      ▀▀▄",
    ])
  })

  it("show a person's turn behind `> `, a call as `● Tool(subject)` and a result behind `⎿`", () => {
    expect(read(itemBlock(item({ role: "user", text: "Fix it" }), "agy")(40))).toBe("\n> Fix it\n")
    // As the demo's Antigravity agents write it: its own `run_command` tool, with the command
    // in a JSON input.
    const call = item({
      kind: "tool-call",
      tool: "run_command",
      text: '{"CommandLine":"\\"pnpm test\\"","Cwd":"\\"/home/nyx\\""}',
      run: { kind: "run", title: "Ran", detail: "pnpm test" },
    })
    const result = item({ kind: "tool-result", role: "tool", text: "a\nb" })
    expect(read(itemBlock(call, "agy")(60))).toBe("\n● Bash(pnpm test) (ctrl+o to expand)")
    expect(read(itemBlock(item({ text: "All done." }), "agy")(40))).toBe("\n  All done.")
    expect(read(itemBlock(result, "agy")(40))).toBe("  ⎿  a\n     b")
  })
})

describe("an agent's conversation", () => {
  it("shows a tool call by what it was called on, and its result clipped", () => {
    const call = item({
      kind: "tool-call",
      tool: "Bash",
      text: '{"command":"pnpm test"}',
      run: { kind: "run", title: "Ran", detail: "pnpm test" },
    })
    const result = item({ kind: "tool-result", role: "tool", text: "a\nb\nc\nd" })
    expect(read(itemBlock(call, "claude")(40))).toBe("\n● Bash pnpm test")
    expect(read(itemBlock(result, "claude")(40))).toBe("  └ a\n    b\n    c…")
  })

  it("sets a person's request apart, and another agent's message by who sent it", () => {
    expect(read(itemBlock(item({ role: "user", text: "Fix it" }), "codex")(40))).toBe(
      "\n› Fix it\n",
    )
    expect(
      read(itemBlock(item({ role: "agent", author: "Codex", text: "Done" }), "claude")(40)),
    ).toBe("\n↳ Codex: Done")
  })
})

describe("an agent's live tail", () => {
  it.each(widths)("boxes the dialog that waits, within %i columns", (width) => {
    const lines = askLines(permission, "claude", 0, { at: 1, of: 2 }, width)
    expect(fits(lines, width)).toBe(true)
  })

  it("tells the dialog's kind, its place, its answers and how to give one", () => {
    const shown = read(askLines(permission, "claude", 0, { at: 1, of: 2 }, 80))
    expect(shown).toContain("Permission · 1 of 2")
    expect(shown).toContain("❯ 1. Yes")
    expect(shown).toContain("Type a number and press Enter; words after it go with it.")
  })

  it("says a dialog was answered while the agent catches up", () => {
    expect(read(askLines({ ...permission, answered: true }, "claude", 0, undefined, 60))).toContain(
      "✓ Answered. Waiting for the agent…",
    )
  })

  it("puts the prompt between rules under the status, and the cursor in the draft", () => {
    const tail = agentTail({
      agent: "claude",
      request: undefined,
      progress: 0,
      place: undefined,
      note: undefined,
      status: ["✻ Working… (esc to interrupt)"],
      draft: "fix it",
      cursor: 3,
    })(30)
    expect(tail.lines.map(plain)).toEqual([
      "",
      "✻ Working… (esc to interrupt)",
      "",
      "─".repeat(30),
      "❯ fix it",
      "─".repeat(30),
    ])
    expect(tail.cursor).toEqual({ row: 4, column: 5 })
  })

  it("shows nothing but the prompt while the draft is empty", () => {
    const tail = agentTail({
      agent: "codex",
      request: undefined,
      progress: 0,
      place: undefined,
      note: undefined,
      status: [],
      draft: "",
      cursor: 0,
    })(30)
    expect(plain(tail.lines.at(-2)!)).toBe("› ")
    expect(tail.cursor).toEqual({ row: tail.lines.length - 2, column: 2 })
  })

  it("shows a shell's prompt under where it is", () => {
    const tail = shellTail({ project: "novadeck", draft: "ls", cursor: 2 })(40)
    expect(tail.lines.map(plain)).toEqual(["", "novadeck ⎇ main", "❯ ls"])
    expect(tail.cursor).toEqual({ row: 2, column: 4 })
  })
})

describe("a line being typed", () => {
  it("wraps at the width, the cursor after the characters before it", () => {
    const laid = inputLines([span("❯ ")], "abcdefghij", 7, 6)
    expect(laid.lines.map(plain)).toEqual(["❯ abcd", "efghij"])
    expect(laid.cursor).toEqual({ row: 1, column: 3 })
  })

  it("puts a cursor at the end of a full row at the start of the next", () => {
    const laid = inputLines([span("❯ ")], "abcd", 4, 6)
    expect(laid.lines.map(plain)).toEqual(["❯ abcd", ""])
    expect(laid.cursor).toEqual({ row: 1, column: 0 })
  })

  it("counts a wide character as the two columns it takes", () => {
    const laid = inputLines([span("❯ ")], "表x", 1, 10)
    expect(laid.cursor).toEqual({ row: 0, column: 4 })
  })
})
