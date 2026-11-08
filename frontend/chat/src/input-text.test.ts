import type { ToolKind } from "@novadeck/core/conversation"

import { inputBeyondLine } from "./input-text"
import { describe, expect, it } from "./test"

const inputText = (input: string): string | null =>
  inputBeyondLine(input, { kind: "other", title: "Did", detail: "" })

describe("a tool call's input as text", () => {
  it("is the value of a call that holds one", () => {
    expect(inputText(JSON.stringify({ command: "ls" }))).toBe("ls")
  })

  it("lists several values, one to a line", () => {
    expect(inputText(JSON.stringify({ command: "ls", timeout: 2 }))).toBe("command: ls\ntimeout: 2")
  })

  it("keeps the quotes of a value that is a quoted string, as Claude Code's or Codex's", () => {
    expect(
      inputText(JSON.stringify({ command: '"/usr/bin/tool"', description: "Run the tool" })),
    ).toBe('command: "/usr/bin/tool"\ndescription: Run the tool')
    expect(inputText(JSON.stringify({ file_path: "/a.ts", content: '"use strict"' }))).toBe(
      'file_path: /a.ts\ncontent: "use strict"',
    )
  })

  it("keeps the quotes of a call's one value, a string all in quotes", () => {
    expect(inputText(JSON.stringify({ command: '"/usr/bin/tool"' }))).toBe('"/usr/bin/tool"')
  })

  it("is a patch as written", () => {
    expect(inputText("*** Begin Patch")).toBe("*** Begin Patch")
  })
})

describe("what a call's input says beyond its line", () => {
  const ran = (detail: string) => ({ kind: "run", title: "Ran", detail }) as const
  const other = (kind: ToolKind, detail: string) => ({ kind, title: "Did", detail })

  it("is nothing where the line shows a command, with what it says of itself", () => {
    const input = JSON.stringify({ command: "pnpm test", description: "Run the tests" })
    expect(inputBeyondLine(input, ran("pnpm test"))).toBeNull()
  })

  it("is the whole of a command the line holds only the first row of", () => {
    const input = JSON.stringify({ command: "pnpm test\npnpm lint", description: "Check" })
    expect(inputBeyondLine(input, ran("pnpm test"))).toBe("pnpm test\npnpm lint")
  })

  it("keeps what else a command was given", () => {
    const input = JSON.stringify({ cmd: "pnpm test", workdir: "/repo" })
    expect(inputBeyondLine(input, ran("pnpm test"))).toBe("workdir: /repo")
  })

  it("keeps a subagent's prompt behind the description the line shows", () => {
    const input = JSON.stringify({
      description: "Survey providers",
      prompt: "Compare three",
      subagent_type: "Explore",
    })
    expect(inputBeyondLine(input, other("agent", "Survey providers"))).toBe(
      "prompt: Compare three\nsubagent_type: Explore",
    )
  })

  it("keeps a search's flags behind the pattern the line shows", () => {
    const input = JSON.stringify({ pattern: "useCart", path: "src" })
    expect(inputBeyondLine(input, other("search", "useCart"))).toBe("path: src")
  })

  it("keeps a description that belongs to the tool", () => {
    const input = JSON.stringify({ title: "Bug", description: "Crashes" })
    expect(inputBeyondLine(input, other("other", "Bug"))).toBe("description: Crashes")
  })

  it("is all of it where the line shows none of it", () => {
    const input = JSON.stringify({ url: "a", prompt: "b" })
    expect(inputBeyondLine(input, other("web", ""))).toBe("url: a\nprompt: b")
    expect(inputBeyondLine(JSON.stringify({ file_path: "/a/b.ts" }), other("read", "…/b.ts"))).toBe(
      "/a/b.ts",
    )
  })

  it("is nothing for an empty input, or one that is the line", () => {
    expect(inputBeyondLine("{}", other("other", ""))).toBeNull()
    expect(inputBeyondLine("  ", ran("x"))).toBeNull()
    expect(inputBeyondLine("pnpm test", ran("pnpm test"))).toBeNull()
  })

  it("is written as it is where it isn't JSON", () => {
    expect(inputBeyondLine("*** Begin Patch", other("write", "total.ts"))).toBe("*** Begin Patch")
  })
})
