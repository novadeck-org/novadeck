import { describe as agyDescribe } from "@novadeck/harness-agy/tools"
import { describe as claudeDescribe } from "@novadeck/harness-claude/tools"
import { describe as codexDescribe } from "@novadeck/harness-codex/tools"
import type { ToolRun } from "@novadeck/protocol"
import type { AgentName } from "@novadeck/protocol/harnesses"

import { describe, expect, it } from "../test.js"
import { classified } from "./tools.js"

// Every tool a harness offers its model (tools.ts) either has a row of its own in the chat,
// its harness's `describe` giving it a kind or a title that isn't its raw name, or sits here,
// meant to show generically, with the reason. A tool that deserves a row gets an entry in
// its harness's tools.ts, not a line here.

const describes: {
  readonly [agent in AgentName]: (tool: string, input: string) => ToolRun
} = {
  claude: claudeDescribe,
  codex: codexDescribe,
  agy: agyDescribe,
}

const generic: { readonly [agent in AgentName]: { readonly [tool: string]: string } } = {
  claude: {
    DeferredToolPlaceholder: "a stand-in for a tool not loaded yet, never called",
    ReportFindings: "no argument shape recorded; reports into the harness's own review UI",
    Workflow: "no argument shape recorded; runs a script the harness shows in its own UI",
  },
  codex: {},
  agy: {
    call_mcp_tool: "its row is the MCP tool it calls (lazyRun); with no arguments it has none",
  },
}

describe("every tool a harness offers has a row of its own or is meant to show generically", () => {
  for (const agent of ["claude", "codex", "agy"] as const) {
    it(`covers ${agent}'s tools`, () => {
      const bare = classified(agent).filter((tool) => {
        const run = describes[agent](tool, "{}")
        return run.kind === "other" && run.title === tool
      })
      expect(bare.toSorted()).toEqual(Object.keys(generic[agent]).toSorted())
    })
  }
})
