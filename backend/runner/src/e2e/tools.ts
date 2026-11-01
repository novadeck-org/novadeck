import type { AgentName } from "@novadeck/protocol"

// Every tool each harness offers its model on a plain first turn, as the end-to-end suite
// recorded them (tools.e2e.ts), classified by whether the tool asks the person something.
//
// `asking` tools put a question or a request to the person in the harness's own UI, where
// Novadeck must show it in the Inbox (its adapter reads it: harnesses/<harness>/src/dialogs.ts
// and decode.ts). `other` tools never ask the person.
//
// A tool no list names fails the check: that is how a new question tool, like Codex's
// request_user_input_async, can't slip past Novadeck again. Novadeck's own MCP tools are
// left out by name.

type Classes = { readonly asking: readonly string[]; readonly other: readonly string[] }

const lists: { readonly [agent in AgentName]: Classes } = {
  // Recorded from Claude Code 2.1.304 and the latest of 2026-10-29 (Monitor), and checked on
  // 2.1.316 (the pin, 2026-10-31); on Windows it offers Glob and Grep too (seen in CI,
  // 2026-10-29).
  // EnterPlanMode and EnterWorktree ask the person to approve them, through its ordinary permission prompt, which Novadeck reads for
  // every tool; they are not questions of their own.
  claude: {
    asking: ["AskUserQuestion", "ExitPlanMode"],
    other: [
      "Agent",
      "Bash",
      "CronCreate",
      "CronDelete",
      "CronList",
      "DeferredToolPlaceholder",
      "Edit",
      "EnterPlanMode",
      "EnterWorktree",
      "ExitWorktree",
      "Glob",
      "Grep",
      "ListAgents",
      "Monitor",
      "NotebookEdit",
      "Read",
      "ReportFindings",
      "ScheduleWakeup",
      "SendMessage",
      "Skill",
      "TaskStop",
      "ToolSearch",
      "WebFetch",
      "WebSearch",
      "Workflow",
      "Write",
    ],
  },
  // Recorded from Codex 0.163.0, and checked on 0.166.0 (the pin, 2026-10-31), with the fake
  // model's catalog entry as OpenAI's gives its models (agents/codex.ts).
  // request_permissions is Codex's, offered only to a model that supports it; Novadeck
  // handles it all the same.
  codex: {
    asking: ["request_user_input", "request_user_input_async", "request_permissions"],
    other: [
      "clock.curr_time",
      "clock.sleep",
      "create_goal",
      "exec_command",
      "get_goal",
      "list_mcp_resource_templates",
      "list_mcp_resources",
      "mcp__codex_worktrees.create_worktree",
      "mcp__codex_worktrees.get_worktree_creation_status",
      "mcp__codex_worktrees.list_worktrees",
      "multi_agent_v1.close_agent",
      "multi_agent_v1.resume_agent",
      "multi_agent_v1.send_input",
      "multi_agent_v1.spawn_agent",
      "multi_agent_v1.wait_agent",
      "read_mcp_resource",
      "update_goal",
      "view_image",
      "web_search",
      "write_stdin",
    ],
  },
  // Recorded from Antigravity 1.4.3, and checked on 1.4.12 (the pin, 2026-10-31).
  agy: {
    asking: ["ask_question"],
    other: [
      "call_mcp_tool",
      "define_subagent",
      "edit_file",
      "invoke_subagent",
      "list_resources",
      "manage_subagents",
      "manage_task",
      "read_file",
      "read_resource",
      "run_command",
      "schedule",
      "search_web",
      "send_message",
      "write_file",
    ],
  },
}

// How each harness names a tool of Novadeck's own MCP server (`send`, `ask`, ...).
const novadeck: { readonly [agent in AgentName]: RegExp } = {
  claude: /^mcp__plugin_novadeck_novadeck__/,
  codex: /^mcp__(?:plugin_)?novadeck/,
  agy: /^mcp_novadeck_novadeck_/,
}

/** The tools classified for a harness, asking or not. */
export const classified = (agent: AgentName): readonly string[] => [
  ...lists[agent].asking,
  ...lists[agent].other,
]

/** The offered tools that are neither Novadeck's own nor classified. */
export const unclassified = (agent: AgentName, offered: readonly string[]): string[] =>
  offered.filter((name) => !novadeck[agent].test(name) && !classified(agent).includes(name))
