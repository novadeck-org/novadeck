import { inputText } from "./input-text"
import { describe, expect, it } from "./test"

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
