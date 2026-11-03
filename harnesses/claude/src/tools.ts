import { commandFolder } from "@novadeck/harness-core/decode"
import type { ToolKind } from "@novadeck/harness-core/events"
import { isFields, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  count,
  novadeckTool,
  oneLine,
  otherRun,
  shortPath,
  sleepOnly,
  textField,
} from "@novadeck/harness-core/tools"
import type { ToolRun } from "@novadeck/protocol"

// Claude Code's own name for Novadeck's MCP server, as its plugin spells the tools:
// `mcp__plugin_novadeck_novadeck__send`.
const novadeck = /^mcp__plugin_novadeck_novadeck__(.+)$/

// Claude Code's own tools, by their names in lower case. Each reads every field spelling the
// harnesses' shared table read before #351 (Antigravity's `AbsolutePath`, Codex's `cmd`), as
// chat-contract's parity test holds each harness to that table.
const known = (name: string, fields: Fields | undefined): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "bash":
    case "powershell":
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
    // Keys as real transcripts give them: SendMessage {to, message, summary}, TaskStop
    // {task_id}, ScheduleWakeup {delaySeconds, prompt, reason}, CronCreate {cron, prompt},
    // CronDelete {id}, Skill {skill, args}, Monitor {command, description}, ToolSearch {query},
    // EnterWorktree {path}, ExitWorktree {action}.
    case "sendmessage": {
      const to = oneLine(textField(fields, "to", "recipient"))
      return {
        kind: "agent",
        title: to ? `Messaged ${to}` : "Messaged",
        detail: oneLine(textField(fields, "message", "summary", "content")),
      }
    }
    case "listagents":
      return { kind: "agent", title: "Listed subagents", detail: "" }
    case "taskstop":
      return { kind: "run", title: "Stopped a task", detail: "" }
    case "schedulewakeup":
      return {
        kind: "run",
        title: "Scheduled a wake-up",
        detail: oneLine(textField(fields, "reason", "prompt")),
      }
    case "croncreate":
      return {
        kind: "run",
        title: "Scheduled",
        detail: oneLine(textField(fields, "prompt", "cron")),
      }
    case "crondelete":
      return { kind: "run", title: "Unscheduled", detail: "" }
    case "cronlist":
      return { kind: "run", title: "Listed schedules", detail: "" }
    case "skill":
      return { kind: "other", title: "Used a skill", detail: oneLine(textField(fields, "skill")) }
    case "monitor":
      return {
        kind: "run",
        title: "Monitored",
        detail: oneLine(textField(fields, "description", "command")),
      }
    case "toolsearch":
      return {
        kind: "search",
        title: "Searched tools",
        detail: oneLine(textField(fields, "query")),
      }
    case "enterplanmode":
      return { kind: "plan", title: "Entered plan mode", detail: "" }
    case "enterworktree":
      return { kind: "run", title: "Entered a worktree", detail: path("path", "name") }
    case "exitworktree":
      return { kind: "run", title: "Left a worktree", detail: oneLine(textField(fields, "action")) }
    case "todowrite":
      return { kind: "plan", title: "Updated todos", detail: count(fields?.todos, "item") }
    case "exitplanmode":
      return { kind: "plan", title: "Proposed a plan", detail: "" }
    case "askuserquestion": {
      const first = Array.isArray(fields?.questions) ? (fields!.questions[0] as Fields) : undefined
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

/**
 * The folder a call ran in, for its shell tool alone: a leading `cd` in its command, else
 * the directory its hook ran in, which follows the `cd`s Claude Code keeps between calls.
 */
export const folderOf = (tool: string, input: unknown, cwd: unknown): string | undefined => {
  if (tool !== "Bash" && tool !== "PowerShell") return undefined
  const command = isFields(input) && typeof input.command === "string" ? input.command : undefined
  return commandFolder(command, cwd)
}

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
