import { readFileSync } from "node:fs"
import { join } from "node:path"

import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { fixtures } from "./fixtures"
import { harnessSources } from "./harnesses.test-support"
import { transcriptsOf } from "./pipeline"
import { describe, expect, it } from "./test"

// The vocabulary README says which tools the conversations name: every tool each harness's
// `describe` knows, but for the few below that no recording shows, and every Novadeck tool
// core's `novadeckTool` knows in each harness's direct spelling. This holds the README to that, so a tool added to a
// `describe` without a conversation, or a conversation added for a tool still listed here,
// fails until both say the same.

// The names no recording in the repo or on the machine they were written on shows, so no
// conversation names them (checked 2026-11-05). A conversation for one needs a real record
// of it first.
const unrecorded: Readonly<Record<AgentName, readonly string[]>> = {
  // Its Windows shell tool, and Workflow, whose row comes from its schema alone.
  claude: ["powershell", "workflow"],
  codex: [
    "clock.curr_time",
    "codex_tui.create_thread",
    "codex_tui.create_worktree",
    "codex_tui.fork_thread",
    "codex_tui.get_worktree_creation_status",
    "codex_tui.list_archived_threads",
    "codex_tui.list_threads",
    "codex_tui.list_worktrees",
    "codex_tui.read_thread",
    "codex_tui.send_message_to_thread",
    "codex_tui.set_thread_archived",
    "codex_tui.set_thread_title",
    "codex_tui.wait_threads",
    "image_generation",
    "list_dir",
    "list_mcp_resource_templates",
    "list_mcp_resources",
    "read_file",
    "read_mcp_resource",
    "update_goal",
  ],
  // run_workflow (1.5.9) has its row from its schema alone.
  agy: ["list_resources", "read_resource", "run_workflow"],
  // `list` and `multiedit` are in its tools' table, but 1.19.6 offered neither to the fake model in
  // any agent or model it was probed with (build and plan, an Anthropic-named and a GPT-named
  // model, with OPENCODE_EXPERIMENTAL and OPENCODE_ENABLE_EXA set), so no record of them
  // exists (checked 2026-11-22). Nor does one of `todoread`, which no recorded turn called: it
  // has a row as its `todowrite` does.
  opencode: ["list", "multiedit", "todoread"],
  // Its Windows shell tool, which it offers on Windows alone.
  pi: ["powershell"],
}

const source = (harness: AgentName | "core", path: string): string =>
  readFileSync(join(harnessSources(harness), path), "utf8")

const casesOf = (code: string): string[] =>
  [...code.matchAll(/\bcase ["']([^"']+)["']:/g)].map(([, name]) => name!)

// The names each harness's `describe` knows, from its own switch.
const known = (harness: AgentName): string[] => casesOf(source(harness, "tools.ts"))

// Novadeck's old tool names, which `novadeckTool` keeps only so sessions recorded before
// the rename keep their label: no conversation calls them any more.
const retired: ReadonlySet<string> = new Set(["summarize"])

// Novadeck's own tools, from core's `novadeckTool`, less the retired names.
const novadeckTools = ((): string[] => {
  const code = source("core", "tools.ts")
  const from = code.indexOf("export const novadeckTool")
  return casesOf(code.slice(from, code.indexOf("\n}\n", from))).filter((tool) => !retired.has(tool))
})()

// A recorded name as its `describe` looks it up: a Novadeck tool as `novadeck:<tool>`, and
// Codex's namespaced tools joined as its `describe` joins them. Antigravity's lazy
// `call_mcp_tool` keys as itself, so its rows count toward no Novadeck tool.
const keyOf: Readonly<Record<AgentName, (tool: string) => string>> = {
  claude: (tool) => tool.replace(/^mcp__plugin_novadeck_novadeck__/, "novadeck:").toLowerCase(),
  codex: (tool) =>
    tool
      .replace(/^mcp__novadeck(?:__|\.)/, "novadeck:")
      .toLowerCase()
      .replace(
        /^(?:multi_agent_v\d+|collaboration)(?:\.|__)?(?=(?:spawn_agent|send_message|send_input|followup_task|list_agents|wait_agent|close_agent|resume_agent)$)/,
        "",
      )
      .replace(/^clock__/, "clock.")
      .replace(/^mcp__codex_tui(?:__|\.)/, "codex_tui.")
      .replace(
        /^mcp__codex_worktrees(?:__|\.)(?=(?:create_worktree|get_worktree_creation_status|list_worktrees)$)/,
        "codex_tui.",
      ),
  agy: (tool) => tool.replace(/^mcp_novadeck_novadeck_/, "novadeck:").toLowerCase(),
  // An MCP server's tool goes by `<server>_<tool>`.
  opencode: (tool) => tool.replace(/^novadeck_/, "novadeck:").toLowerCase(),
  // Novadeck's extension gives pi its tools as `novadeck_<tool>`.
  pi: (tool) => tool.replace(/^novadeck_/, "novadeck:").toLowerCase(),
}

// The names each harness's recorded fixtures and vocabulary conversations call.
const named = (harness: AgentName): Set<string> => {
  const names = new Set<string>()
  for (const fixture of fixtures.filter((each) => each.harness === harness))
    for (const { lines } of fixture.extract().conversations)
      for (const line of lines)
        for (const entry of transcriptsOf[harness].items(line))
          if (entry.kind === "tool-call" && entry.tool) names.add(keyOf[harness](entry.tool))
  return names
}

describe("the tools the conversations name", () => {
  it("reads every case of each describe and of novadeckTool", () => {
    // opencode and pi have fewer tools than the others have names.
    const fewest: Partial<Record<AgentName, number>> = { opencode: 10, pi: 8 }
    for (const harness of agentNames)
      expect(known(harness).length, harness).toBeGreaterThan(fewest[harness] ?? 20)
    expect(novadeckTools).toEqual(expect.arrayContaining(["send", "done", "feedback", "look"]))
  })

  for (const harness of agentNames)
    it(`name each tool ${harness}'s describe knows, but for the unrecorded`, () => {
      const names = named(harness)
      const missing = known(harness).filter((name) => !names.has(name))
      expect(missing.toSorted()).toEqual(unrecorded[harness].toSorted())
    })

  for (const harness of agentNames)
    it(`name every Novadeck tool in ${harness}'s spelling`, () => {
      const names = named(harness)
      expect(novadeckTools.filter((tool) => !names.has(`novadeck:${tool}`))).toEqual([])
    })
})
