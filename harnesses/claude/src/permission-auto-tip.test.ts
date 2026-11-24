import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { describe, expect, it } from "vitest"

import { dialogs } from "./dialogs.js"
import { choice, need, pressed } from "./dialogs.test-support.js"

// 2.1.331, 2026-11-24, saved with "Save for debugging" at 74x17 (both read as raw before): a
// Bash dialog gets a `Tip: auto mode handles these prompts…` row under its label (two rows at
// this width, so the label is four rows above the command, with the dialog's top rule scrolled
// away: ` ↑ 1 more line`), a third option "Yes, and switch to auto mode", and an MCP tool's
// dialog scrolled so far that its `Tool use` label has gone (` ↑ 2 more lines`).
type Scenario = {
  tool: string
  input: unknown
  cwd: string | null
  screens: { [size: string]: ScreenText }
}
const { scenarios } = loadProbe(import.meta.dirname, "permission-2-1-331.probe.json") as {
  scenarios: { [name: string]: Scenario }
}
const rows = (name: string): string[] => [...scenarios[name]!.screens["74x17"]!.rows]
const facts = (name: string): RequestFacts => ({
  kind: "permission",
  tool: scenarios[name]!.tool,
  input: scenarios[name]!.input,
  cwd: scenarios[name]!.cwd,
})

describe("Claude Code 2.1.331's permission dialogs", () => {
  it("reads a Bash command under the auto mode tip, and answers by the screen's numbers", () => {
    const found = need(dialogs.read(rows("bash-tip"), facts("bash-tip")))
    expect(found.dialog).toMatchObject({
      type: "choices",
      title: "Do you want to proceed?",
      detail: "git -C /home/mzpk/Workspace/oss/novadeck log --oneline -3",
      options: [
        { id: "1", label: "Yes" },
        { id: "2", label: "Yes, and don’t ask again for: git *" },
        {
          id: "3",
          label: "Yes, and switch to auto mode · auto mode handles these prompts for you",
        },
        { id: "4", label: "No" },
        { id: "tell", label: "No, and tell Claude what to do", text: "prompt" },
      ],
    })
    expect(pressed(found.keys(choice("1")))).toEqual(["1"])
    expect(pressed(found.keys(choice("4")))).toEqual(["4"])
    // Only a person's own pick of the auto mode option presses its digit.
    expect(pressed(found.keys(choice("3")))).toEqual(["3"])
    // "No, and tell Claude" presses No, not the option above it.
    expect(found.keys(choice("tell", "x"))).toEqual([{ press: "4" }])
  })

  it("reads an MCP tool's dialog whose top, with its Tool use label, scrolled away", () => {
    const found = need(dialogs.read(rows("mcp-scrolled"), facts("mcp-scrolled")))
    expect(found.dialog).toMatchObject({
      type: "choices",
      options: expect.arrayContaining([
        expect.objectContaining({ id: "1", label: "Yes" }),
        expect.objectContaining({ id: "2", label: "No" }),
      ]),
      detail: expect.stringContaining('title: "Add --version flag to dev-web"'),
    })
  })

  it("still declines the MCP dialog when nothing says its top scrolled away", () => {
    const drawn = rows("mcp-scrolled").filter((row) => !row.startsWith(" ↑ "))
    expect(dialogs.read(drawn, facts("mcp-scrolled"))).toBeUndefined()
  })

  it("still declines a Bash dialog whose command is not the request's", () => {
    const other = { ...facts("bash-tip"), input: { command: "git status" } }
    expect(dialogs.read(rows("bash-tip"), other)).toBeUndefined()
  })

  it("still declines a Bash dialog whose top row is not the Bash label", () => {
    const drawn = rows("bash-tip").map((row) => row.replace("Bash command", "Fetch"))
    expect(dialogs.read(drawn, facts("bash-tip"))).toBeUndefined()
  })
})
