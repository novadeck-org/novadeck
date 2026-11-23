import { commandFolder } from "@novadeck/harness-core/decode"
import type { ToolKind } from "@novadeck/harness-core/events"
import { fieldsOf, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  novadeckTool,
  oneLine,
  otherRun,
  shortPath,
  sleepOnly,
  textField,
} from "@novadeck/harness-core/tools"
import type { ToolRun } from "@novadeck/protocol"

/**
 * opencode's tools, by the names its model calls them (offered to the fake model, probed
 * 2026-11-22, 1.19.6): bash, edit, glob, grep, question, read, skill, task, todowrite,
 * webfetch and write, with apply_patch, list, multiedit, todoread and websearch in some of
 * its agents and versions. An MCP server's tool goes by `<server>_<tool>`, any character
 * but letters, digits, `_` and `-` made `_` (mcp/index.ts), so Novadeck's are
 * `novadeck_send` and so on.
 */
const novadeck = /^novadeck_(.+)$/

// Its tools that only load or track.
const bookkeeping: ReadonlySet<string> = new Set(["skill", "todowrite", "todoread"])

/** The tools that write a file, by its `filePath`. */
export const writers: ReadonlySet<string> = new Set(["edit", "write", "multiedit"])

const known = (name: string, fields: Fields | undefined): ToolRun | undefined => {
  const path = (...keys: string[]): string => shortPath(textField(fields, ...keys))
  switch (name) {
    case "bash":
      return { kind: "run", title: "Ran", detail: oneLine(textField(fields, "command")) }
    case "read":
      return { kind: "read", title: "Read", detail: path("filePath", "path") }
    case "list":
      return { kind: "read", title: "Listed", detail: path("path") }
    case "write":
      return { kind: "write", title: "Wrote", detail: path("filePath") }
    case "edit":
    case "multiedit":
      return { kind: "write", title: "Edited", detail: path("filePath") }
    case "apply_patch":
      return { kind: "write", title: "Patched", detail: "" }
    case "grep":
      return { kind: "search", title: "Searched", detail: oneLine(textField(fields, "pattern")) }
    case "glob":
      return { kind: "search", title: "Found files", detail: oneLine(textField(fields, "pattern")) }
    case "webfetch":
      return { kind: "web", title: "Fetched", detail: textField(fields, "url") }
    case "websearch":
      return { kind: "web", title: "Searched the web", detail: textField(fields, "query") }
    // question takes `questions[{question, header, options[{label, description}], multiple}]`
    // (probed 2026-11-22, 1.19.6).
    case "question": {
      const first = Array.isArray(fields?.questions) ? fieldsOf(fields.questions[0]) : undefined
      return { kind: "plan", title: "Asked", detail: oneLine(textField(first, "question")) }
    }
    // task takes `description`, `prompt` and `subagent_type` (probed 2026-11-22, 1.19.6).
    case "task":
      return {
        kind: "agent",
        title: "Subagent",
        detail: oneLine(textField(fields, "description", "prompt", "subagent_type")),
        subagent: true,
      }
    case "todowrite":
      return { kind: "plan", title: "Updated the plan", detail: "" }
    // Its read of that list, which takes no arguments.
    case "todoread":
      return { kind: "read", title: "Read the plan", detail: "" }
    // A call of a tool it wasn't offered: opencode records it as `invalid`, with the tool the
    // model named and why it couldn't run (probed 2026-11-22, 1.19.6).
    case "invalid":
      return {
        kind: "other",
        title: textField(fields, "tool") || "Unknown tool",
        detail: oneLine(textField(fields, "error")),
      }
    case "skill":
      return { kind: "read", title: "Loaded a skill", detail: oneLine(textField(fields, "name")) }
    default:
      return undefined
  }
}

/**
 * What an opencode tool call was, from its name and its input as text (JSON). Names match
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

/**
 * The folder a call ran in, for bash alone: its `workdir` where it gives one, else a leading
 * `cd` in its command, else the session's folder. opencode keeps no `cd` between calls: each
 * bash runs in the session's folder unless told otherwise (tool/bash.ts).
 */
export const folderOf = (tool: string, input: unknown, cwd: unknown): string | undefined => {
  if (tool !== "bash") return undefined
  const fields = fieldsOf(input)
  const command = typeof fields?.command === "string" ? fields.command : undefined
  const workdir = typeof fields?.workdir === "string" ? fields.workdir : undefined
  return commandFolder(command, cwd, workdir)
}

/** What a tool call counts as to the messaging loop guard: see `ToolKind`. */
export const kindOf = (tool: string, input: unknown): ToolKind => {
  if (novadeck.test(tool)) return "novadeck"
  if (bookkeeping.has(tool)) return "bookkeeping"
  if (tool === "bash") {
    const command = fieldsOf(input)?.command
    return typeof command === "string" && sleepOnly(command) ? "waiting" : "work"
  }
  return "work"
}
