import type { ToolKind } from "@novadeck/harness-core/events"
import {
  count,
  isFields,
  novadeckTool,
  oneLine,
  otherRun,
  parseFields,
  shortPath,
  sleepOnly,
  textField,
  type Fields,
  type ToolRun,
} from "@novadeck/harness-core/tools"

// Claude Code's own name for Novadeck's MCP server, as its plugin spells the tools:
// `mcp__plugin_novadeck_novadeck__send`.
const novadeck = /^mcp__plugin_novadeck_novadeck__(.+)$/

const known = (name: string, fields: Fields | null): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "bash":
      return {
        kind: "run",
        title: "Ran",
        detail: oneLine(textField(fields, "cmd", "command", "CommandLine")),
      }
    case "read":
      return {
        kind: "read",
        title: "Read",
        detail: path("file_path", "AbsolutePath", "path", "notebook_path"),
      }
    case "ls":
      return { kind: "read", title: "Listed", detail: path("DirectoryPath", "path") }
    case "write":
      return { kind: "write", title: "Wrote", detail: path("file_path", "TargetFile") }
    case "edit":
    case "multiedit":
    case "notebookedit":
      return {
        kind: "write",
        title: "Edited",
        detail: path("file_path", "TargetFile", "notebook_path"),
      }
    case "grep":
      return {
        kind: "search",
        title: "Searched",
        detail: oneLine(textField(fields, "pattern", "Query", "query")),
      }
    case "glob":
      return {
        kind: "search",
        title: "Found files",
        detail: oneLine(textField(fields, "pattern", "Pattern")),
      }
    case "webfetch":
      return { kind: "web", title: "Fetched", detail: textField(fields, "url", "Url") }
    case "websearch":
      return { kind: "web", title: "Searched the web", detail: textField(fields, "query") }
    case "task":
    case "agent":
      return {
        kind: "agent",
        title: "Subagent",
        detail: oneLine(textField(fields, "description", "subagent_type", "prompt")),
      }
    case "todowrite":
      return { kind: "plan", title: "Updated todos", detail: count(fields?.todos, "item") }
    case "exitplanmode":
      return { kind: "plan", title: "Proposed a plan", detail: "" }
    case "askuserquestion": {
      const first = Array.isArray(fields?.questions) ? (fields!.questions[0] as Fields) : null
      return {
        kind: "plan",
        title: "Asked",
        detail: oneLine(textField(first, "question")),
      }
    }
    default:
      return undefined
  }
}

/**
 * What a Claude Code tool call was, from its name and its input as text (JSON). Names match
 * without regard to case; one it doesn't know shows its name and the first thing its input
 * says.
 */
export const describe = (tool: string, input: string): ToolRun => {
  const fields = parseFields(input)
  const mcp = novadeck.exec(tool)?.[1]
  return (
    (mcp === undefined ? undefined : novadeckTool(mcp, fields)) ??
    known(tool.toLowerCase(), fields) ??
    otherRun(tool, fields, input)
  )
}

// Claude Code's own tools that only load or track.
const bookkeeping: ReadonlySet<string> = new Set([
  "ToolSearch",
  "Skill",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
])

/** What a tool call counts as to the messaging loop guard: see `ToolKind`. */
export const kindOf = (tool: string, input: unknown): ToolKind => {
  if (novadeck.test(tool)) return "novadeck"
  if (bookkeeping.has(tool)) return "bookkeeping"
  if (tool === "ScheduleWakeup") return "waiting"
  if (tool === "Bash") {
    const command = isFields(input) ? input.command : undefined
    return typeof command === "string" && sleepOnly(command) ? "waiting" : "work"
  }
  return "work"
}
